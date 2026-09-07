// input: Storyflow session context and typed Pi subprocess protocol events
// output: Product session projection backed by one Pi AgentSession
// pos: Product Host adapter above the single Pi Agent Kernel

/**
 * Pi Backend (Subprocess RPC Client)
 *
 * Thin subprocess client for the Pi coding agent. Spawns a pi-agent-server
 * subprocess and communicates via JSONL over stdin/stdout.
 *
 * The subprocess runs the Pi SDK (@earendil-works/pi-coding-agent) in-process,
 * handles tool wrapping, permission enforcement, and LLM queries.
 * This file manages subprocess lifecycle, JSONL protocol, event forwarding,
 * and proxy tool routing for MCP/API sources.
 *
 * Auth is API key based. Keys are retrieved from the credential manager
 * and passed to the subprocess during initialization.
 */

import type { AgentEvent, TurnUsage } from '@craft-agent/core/types';
import { formatAttachmentContextForModel, type FileAttachment } from '../utils/files.ts';

import type {
  BackendRuntimeUpdate,
  ChatOptions,
  ManagedModelAccess,
  SdkMcpServerConfig,
} from './backend/types.ts';
import { AbortReason } from './backend/types.ts';
import { getBackendRuntime } from './backend/internal/driver-types.ts';

import type { ThinkingLevel } from './thinking-levels.ts';
import type { Workspace } from '../config/storage.ts';

// Product prompt inputs supplied to Pi's native prompt assembly
import { getSystemPrompt } from '../prompts/system.ts';
import { getCoAuthorPreference } from '../config/preferences.ts';

// Session-scoped tool callbacks (for SubmitPlan, source auth, etc.)
import {
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} from './session-scoped-tool-callback-registry.ts';
import { getPermissionModeDiagnostics } from './mode-manager.ts';

// Session storage (plans folder path)
import { getSessionPlansPath } from '../sessions/storage.ts';

// Error typing
import { parseError, type AgentError } from './errors.ts';

// LLM tool types
import { LLM_QUERY_TIMEOUT_MS, type LLMQueryRequest, type LLMQueryResult } from './llm-tool.ts';

// ============================================================
// PiAgent Implementation
// ============================================================

import { PiAgentToolHost } from './pi-agent-tool-host.ts';
export { PI_BACKEND_SESSION_TOOL_NAMES } from './pi-agent-transport.ts';

/** Storyflow Product Host projection over the single Pi AgentSession runtime. */
export class PiAgent extends PiAgentToolHost {
  getCurrentTurnUsage(): TurnUsage | undefined {
    return this.adapter.getTurnUsageSnapshot();
  }

  // ============================================================
  // Chat (AsyncGenerator with event queue -- mirrors CopilotAgent)
  // ============================================================

  protected async *chatImpl(
    messageParam: string,
    attachments?: FileAttachment[],
    options?: ChatOptions
  ): AsyncGenerator<AgentEvent> {
    let message = messageParam;
    // Reset state for new turn
    this._isProcessing = true;
    this.abortReason = undefined;
    this.eventQueue.reset();
    this.adapter.startTurn();

    // Fire UserPromptSubmit hook event (fire-and-forget)
    this.emitAutomationEvent('UserPromptSubmit', {
      hook_event_name: 'UserPromptSubmit',
      prompt: message,
    });

    // Refresh session-scoped tool callbacks (for SubmitPlan, source auth, etc.)
    // IMPORTANT: merge (don't replace) so SessionManager-provided browserPaneFns
    // survives across turns.
    const sessionId = this.config.session?.id;
    if (sessionId) {
      mergeSessionScopedToolCallbacks(sessionId, {
        onPlanSubmitted: async (planPath) => {
          await this.onPlanSubmitted?.(planPath);
        },
        onAuthRequest: (request) => this.onAuthRequest?.(request),
        queryFn: (request) => this.queryLlm(request),
      });
    }

    try {
      if (this.needsFreshSessionRecoverySeed) {
        this.needsFreshSessionRecoverySeed = false;
        const recoveryContext = this.buildRecoveryContext();
        if (recoveryContext) {
          message = recoveryContext + message;
          this.debug('Seeded fresh Pi transcript from persisted runtime-migration context');
        }
      }

      // Ensure subprocess is spawned and ready
      try {
        await this.ensureSubprocess();
      } catch (subprocessError) {
        const errorMsg = subprocessError instanceof Error ? subprocessError.message : String(subprocessError);
        this.debug(`Failed to spawn Pi subprocess: ${errorMsg}`);

        // If resume failed, clear and try fresh
        if (this.piSessionId && !options?.isRetry) {
          this.piSessionId = null;
          this.killSubprocess();
          this.clearSessionForRecovery();

          const recoveryContext = this.buildRecoveryContext();
          if (recoveryContext) {
            message = recoveryContext + message;
            this.debug('Injected recovery context into message');
          }

          await this.ensureSubprocess();
        } else {
          throw subprocessError;
        }
      }

      const trimmedMessage = message.trim();
      const compactMatch = trimmedMessage.match(/^\/compact(?:\s+([\s\S]+))?$/i);
      if (compactMatch) {
        const customInstructions = compactMatch[1]?.trim() || undefined;
        const compactResult = await this.requestCompact(customInstructions);
        if (compactResult) {
          yield {
            type: 'info',
            message: `Compacted context to fit within limits (from ~${compactResult.tokensBefore.toLocaleString()} tokens)`,
            statusType: 'compaction_complete',
          };
        } else {
          yield {
            type: 'info',
            message: 'Compacted context to fit within limits',
            statusType: 'compaction_complete',
          };
        }
        yield { type: 'complete' };
        return;
      }

      // Build system prompt
      const systemPrompt = getSystemPrompt(
        undefined, // pinnedPreferencesPrompt
        this.config.debugMode,
        this.config.workspace.rootPath,
        this.config.session?.workingDirectory,
        this.config.systemPromptPreset,
        undefined, // deprecated backendName compatibility slot
        getCoAuthorPreference() // respect user's includeCoAuthoredBy preference (#576)
      );

      // Build context from sources
      const sourceContext = this.sourceManager.formatSourceState();

      const promptModeDiagnostics = getPermissionModeDiagnostics(this._sessionId)
      this.debug(
        `[ModeSnapshot] sessionId=${this._sessionId} chatPrompt mode=${promptModeDiagnostics.permissionMode} ` +
        `modeVersion=${promptModeDiagnostics.modeVersion} changedBy=${promptModeDiagnostics.lastChangedBy} changedAt=${promptModeDiagnostics.lastChangedAt}`
      )

      // Build context parts using centralized PromptBuilder
      const turnProjection = this.promptBuilder.buildTurnContext(
        {
          plansFolderPath: getSessionPlansPath(this.config.workspace.rootPath, this._sessionId),
          userIteration: this.getCurrentUserIteration(),
        },
        sourceContext
      );

      // Process attachments
      const attachmentParts: string[] = [];
      const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
      for (const att of attachments || []) {
        if (att.mimeType?.startsWith('image/') && att.base64) {
          images.push({
            type: 'image',
            data: att.base64,
            mimeType: att.mimeType,
          });
        } else {
          attachmentParts.push(formatAttachmentContextForModel(att));
        }
      }

      const requestContext = options?.oneTimeContext?.trim();
      const turnPolicy = [
        ...turnProjection.system,
        options?.turnPolicy?.trim(),
      ].filter(Boolean).join('\n\n');
      const turnContext = [
        ...turnProjection.data,
        requestContext
          ? `<request_context scope="turn">\n${requestContext}\n</request_context>`
          : undefined,
      ].filter(Boolean).join('\n\n');

      // User message: attachments + the actual message
      // (PiAgentHost.chat() already prepends the Skill command)
      const userParts = [
        ...attachmentParts,
        message,
      ].filter(Boolean);
      const userMessage = userParts.join('\n\n');

      // Send prompt to subprocess
      const turnId = `turn-${++this.rpcIdCounter}`;
      this.activePromptId = turnId;
      this.send({
        type: 'prompt',
        id: turnId,
        message: userMessage,
        systemPrompt,
        turnPolicy,
        turnContext,
        images: images.length > 0 ? images : undefined,
        rewindBoundary: options?.rewindBoundary,
      });

      // Yield the Pi-owned turn until its native settlement event closes the queue.
      for await (const event of this.eventQueue.drain()) {
        yield event;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('abort')) {
        if (this.abortReason === AbortReason.PlanSubmitted) {
          return;
        }
        if (this.abortReason === AbortReason.AuthRequest) {
          return;
        }
        return;
      }

      const errorObj = error instanceof Error ? error : new Error(String(error));
      const typedError = this.parsePiError(errorObj);

      if (typedError.code !== 'unknown_error') {
        yield { type: 'typed_error', error: typedError };
      } else {
        yield { type: 'error', message: errorObj.message };
      }

      yield { type: 'complete' };
    } finally {
      this._isProcessing = false;
    }
  }

  // ============================================================
  // Permission Handling
  // ============================================================

  /** True only while Pi is still waiting for this tool approval. */
  hasPendingPermission(requestId: string): boolean {
    return this.pendingPermissions.has(requestId);
  }

  /**
   * Respond to a pending permission request.
   * Permission checking now happens in the main process, so this resolves locally.
   */
  respondToPermission(requestId: string, allowed: boolean, _alwaysAllow?: boolean): void {
    const pending = this.pendingPermissions.get(requestId);
    if (pending) {
      this.pendingPermissions.delete(requestId);
      pending.resolve(allowed);
    }
  }

  // ============================================================
  // Model Forwarding
  // ============================================================

  async updateRuntimeConfig(update: BackendRuntimeUpdate): Promise<boolean> {
    const previousModel = this.getModel();
    const previousRuntime = getBackendRuntime(this.config);

    this.config = {
      ...this.config,
      providerType: update.providerType ?? this.config.providerType,
      authType: update.authType ?? this.config.authType,
      model: update.model,
      runtime: {
        ...previousRuntime,
        ...(update.runtime ?? {}),
      },
    };
    this._model = update.model;

    if (!this.subprocess) {
      this.debug(`Runtime config updated locally (no subprocess): ${previousModel} → ${update.model}`);
      return true;
    }

    const updated = await this.requestRuntimeConfigUpdate({
      ...update,
      providerType: this.config.providerType,
      authType: this.config.authType,
      runtime: getBackendRuntime(this.config),
    });
    this.debug(`Runtime config refreshed in subprocess: ${previousModel} → ${update.model}`);
    return updated;
  }

  async reloadCredentials(managedModelAccess?: ManagedModelAccess): Promise<boolean> {
    if (managedModelAccess) {
      this.config.managedModelAccess = managedModelAccess;
    }
    const piAuth = await this.getPiAuth();
    if (!piAuth || piAuth.credential.type === 'iam') return false;
    if (this.subprocess) {
      await this.requestCredentialUpdate(piAuth);
      this.debug(`Pushed refreshed credential for Pi provider: ${piAuth.provider}`);
    }
    return true;
  }

  override setModel(model: string): void {
    const previousModel = this.getModel();
    super.setModel(model);
    // Forward to subprocess so it uses the new model on next turn
    if (this.subprocess) {
      this.debug(`Forwarding model change to subprocess: ${previousModel} → ${model}`);
      this.send({ type: 'set_model', model });
    } else {
      this.debug(`Model updated but no subprocess to forward to: ${previousModel} → ${model}`);
    }
  }

  override setThinkingLevel(level: ThinkingLevel): void {
    const previousLevel = this.getThinkingLevel();
    super.setThinkingLevel(level);
    // Forward to subprocess so it uses the new thinking level on next turn
    if (this.subprocess) {
      this.debug(`Forwarding thinking level change to subprocess: ${previousLevel} → ${level}`);
      this.send({ type: 'set_thinking_level', level });
    } else {
      this.debug(`Thinking level updated but no subprocess to forward to: ${previousLevel} → ${level}`);
    }
  }

  // ============================================================
  // Source / MCP Integration
  // ============================================================

  override async setSourceServers(
    mcpServers: Record<string, SdkMcpServerConfig>,
    apiServers: Record<string, unknown>,
    intendedSlugs?: string[]
  ): Promise<void> {
    // PiAgentHost.setSourceServers() handles:
    //   1. SourceManager state tracking (active slugs)
    //   2. McpClientPool sync (connecting/disconnecting MCP + API sources)
    await super.setSourceServers(mcpServers, apiServers, intendedSlugs);

    // Register pool's proxy tool defs with subprocess so the model can call them.
    this.registerPoolToolsWithSubprocess();
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  isProcessing(): boolean {
    return this._isProcessing;
  }

  async abort(reason?: string): Promise<void> {
    // Fire Stop hook event (fire-and-forget)
    this.emitAutomationEvent('Stop', { hook_event_name: 'Stop' });

    // Deny all pending permissions
    for (const [, pending] of this.pendingPermissions) {
      pending.resolve(false);
    }
    this.pendingPermissions.clear();

    // Send abort to subprocess
    this.send({ type: 'abort' });
    this.eventQueue.complete();

  }

  forceAbort(reason: AbortReason): void {
    // Fire Stop hook event (fire-and-forget)
    this.emitAutomationEvent('Stop', { hook_event_name: 'Stop' });

    this.abortReason = reason;
    this._isProcessing = false;

    // Reject all pending permissions
    for (const [, pending] of this.pendingPermissions) {
      pending.resolve(false);
    }
    this.pendingPermissions.clear();

    // Signal turn complete to wake up any waiting consumers
    this.eventQueue.complete();

    // For PlanSubmitted and AuthRequest, just interrupt the turn
    if (reason === AbortReason.PlanSubmitted || reason === AbortReason.AuthRequest) {
      return;
    }

    // For other reasons, send abort to subprocess
    this.send({ type: 'abort' });
  }

  /**
   * Redirect mid-stream via Pi SDK's steer().
   * Delivers the message after the current tool finishes, skips remaining
   * queued tools, and continues with full context intact.
   * Events flow through the existing generator — no abort needed.
   */
  override redirect(message: string): boolean {
    if (!this._isProcessing || !this.subprocess) {
      // Not streaming or no subprocess — fall back to abort
      this.forceAbort(AbortReason.Redirect);
      return false;
    }
    this.debug(`Steering mid-stream: "${message.slice(0, 100)}"`);
    this.send({ type: 'steer', message });
    return true;
  }

  // ============================================================
  // Session ID overrides (match CopilotAgent pattern)
  // ============================================================

  override getSessionId(): string | null {
    return this.piSessionId;
  }

  override setSessionId(sessionId: string | null): void {
    this.piSessionId = sessionId;
  }

  override setWorkspace(workspace: Workspace): void {
    super.setWorkspace(workspace);
    this.piSessionId = null;
    this._sessionToolContext = null;
    this.killSubprocess();
  }

  override clearHistory(): void {
    this.piSessionId = null;
    this.killSubprocess();
    super.clearHistory();
    this.debug('History cleared - next chat will start new subprocess');
  }

  async compactContext(customInstructions?: string): Promise<{ summary?: string; tokensBefore?: number } | null> {
    if (!this.piSessionId) return null;

    const result = await this.requestCompact(customInstructions);
    if (!result) return null;

    this.resetPrerequisiteState();
    return {
      summary: result.summary,
      tokensBefore: result.tokensBefore,
    };
  }

  destroy(): void {
    // Unregister session-scoped tool callbacks
    if (this.config.session?.id) {
      unregisterSessionScopedToolCallbacks(this.config.session.id);
    }

    this._sessionToolContext = null;
    // Pool clients are owned by the main process — don't close them here.
    this.killSubprocess();
    this.debug('PiAgent destroyed');
  }

  async disposeForRestart(): Promise<void> {
    if (this.config.session?.id) {
      unregisterSessionScopedToolCallbacks(this.config.session.id);
    }

    this._sessionToolContext = null;
    await this.killSubprocessGracefully();
    this.debug('PiAgent disposed for restart');
  }

  /**
   * Reconnect by killing subprocess -- next chat() will spawn fresh.
   */
  async reconnect(): Promise<void> {
    this.killSubprocess();
    this.debug('PiAgent reconnected (subprocess will be respawned on next chat)');
  }

  /**
   * Gracefully stop the subprocess and wait briefly for the child to exit.
   * Used before an idle runtime restart so we don't leave transient children behind.
   */
  private async killSubprocessGracefully(timeoutMs = 2_000): Promise<void> {
    const child = this.subprocess;
    if (!child) {
      this.killSubprocess();
      return;
    }

    const pid = child.pid;
    const waitForExit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      if (child.exitCode !== null || child.signalCode) {
        resolve({ code: child.exitCode, signal: child.signalCode });
        return;
      }
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });

    try {
      this.send({ type: 'shutdown' });
    } catch {
      // stdin may already be closed
    }

    child.kill('SIGTERM');
    let result = await Promise.race([
      waitForExit,
      new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs)),
    ]);

    if (!result && this.subprocess === child) {
      this.debug(`Pi subprocess ${pid ?? '(unknown pid)'} did not exit after ${timeoutMs}ms; sending SIGKILL`);
      child.kill('SIGKILL');
      result = await Promise.race([
        waitForExit,
        new Promise<null>(resolve => setTimeout(() => resolve(null), 1_000)),
      ]);
    }

    this.stopReadingStdout?.();
    this.stopReadingStdout = null;
    if (this.subprocess === child) {
      this.subprocess = null;
    }
    this.subprocessReady = null;
    this.subprocessReadyResolve = null;
    if (result) {
      this.debug(`Pi subprocess ${pid ?? '(unknown pid)'} stopped for restart: code=${result.code}, signal=${result.signal}`);
    } else {
      this.debug(`Pi subprocess ${pid ?? '(unknown pid)'} stop timed out after SIGKILL`);
    }
  }

  /**
   * Kill the subprocess and clean up resources.
   */
  private killSubprocess(): void {
    this.stopReadingStdout?.();
    this.stopReadingStdout = null;

    if (this.subprocess) {
      // Try graceful shutdown first
      try {
        this.send({ type: 'shutdown' });
      } catch {
        // stdin may already be closed
      }
      this.subprocess.kill('SIGTERM');
      this.subprocess = null;
    }

    this.subprocessReady = null;
    this.subprocessReadyResolve = null;
  }

  // ============================================================
  // Mini Completion (for title generation + summarization)
  // ============================================================

  /**
   * Run a simple text completion through the canonical llm_query RPC.
   */
  async runMiniCompletion(prompt: string): Promise<string | null> {
    try {
      const result = await this.queryLlm({ prompt });
      const text = result.text || null;
      this.debug(`[runMiniCompletion] Result: ${text ? `"${text.slice(0, 200)}"` : 'null'}`);
      return text;
    } catch (error) {
      this.debug(`[runMiniCompletion] Failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Execute an LLM query via the subprocess.
   * Used by session-scoped tool callbacks (call_llm).
   *
   * Sends the full LLMQueryRequest over the `llm_query` RPC so the subprocess's
   * model-aware queryLlm() can honor `request.model`, `request.systemPrompt`,
   * and (transitively via buildCallLlmRequest) `request.outputSchema`.
   * See packages/shared/CLAUDE.md → "queryLlm backend contract" and
   * packages/pi-agent-server/src/index.ts → handleLlmQuery for the invariant.
   */
  async queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult> {
    this.debug('[PiAgent.queryLlm] Starting');

    await this.ensureSubprocess();

    const id = `llm-${++this.rpcIdCounter}`;
    const resultPromise = new Promise<LLMQueryResult>((resolve, reject) => {
      this.pendingLlmQueries.set(id, { resolve, reject });
    });

    this.send({ type: 'llm_query', id, request });

    // Keep this aligned with the subprocess-side queryLlm timeout.
    const timeout = new Promise<LLMQueryResult>((_, reject) => {
      setTimeout(() => {
        if (this.pendingLlmQueries.has(id)) {
          this.pendingLlmQueries.delete(id);
          reject(new Error(`queryLlm timed out after ${LLM_QUERY_TIMEOUT_MS / 1000}s`));
        }
      }, LLM_QUERY_TIMEOUT_MS);
    });

    return Promise.race([resultPromise, timeout]);
  }

  // ============================================================
  // Error Parsing
  // ============================================================

  /**
   * Parse a Pi error into a typed AgentError.
   */
  protected override parsePiError(error: Error): AgentError {
    return parseError(error);
  }

  // ============================================================
  // Debug
  // ============================================================

  protected override debug(message: string): void {
    this.onDebug?.(`[pi] ${message}`);
  }
}

export { PiAgent as PiBackend };
