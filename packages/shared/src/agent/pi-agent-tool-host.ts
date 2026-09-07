// input: Pi transport requests, product permissions, session tools, and rewind callbacks
// output: Host-approved tool execution and correlated runtime control responses
// pos: Pi-specific Host capability bridge between transport and chat lifecycle

import type {
  BackendRuntimeUpdate,
  ConversationRewindRequest,
  ConversationRewindResult,
} from './backend/types.ts';

// Session-scoped tool callbacks (for SubmitPlan, source auth, etc.)
import {
  getSessionScopedToolCallbacks,
} from './session-scoped-tool-callback-registry.ts';
import { attachSessionSelfManagementBindings } from './session-self-management-bindings.ts';

// Session tool proxy definitions (for registering with subprocess)
import { SESSION_TOOL_NAMES } from './backend/pi/session-tool-defs.ts';

// Session tool registry (for executing proxy tool calls)
import {
  SESSION_TOOL_REGISTRY,
  type ToolResult as SessionToolResult,
} from '@craft-agent/session-tools-core';
import { createSessionToolContext, type SessionToolContext } from './session-tool-context.ts';
import { getPermissionModeDiagnostics } from './mode-manager.ts';

// Session storage (plans folder path)
import { getSessionDataPath, getSessionPath, getSessionPlansPath } from '../sessions/storage.ts';

// Centralized PreToolUse pipeline
import { runPreToolUseChecks } from './core/pre-tool-use.ts';
import type { ActiveSourcePermissionRef } from './permissions-config.ts';
import { executeBrowserToolCommand } from './browser-tool-runtime.ts';
import { saveBinaryResponse } from '../utils/binary-detection.ts';
import {
  isFreeConversationWorkspaceId,
  resolveRuntimeWorkspaceById,
} from '../workspaces/application-context.ts';
import { isLocalMcpEnabled } from '../workspaces/storage.ts';

// ============================================================
// PiAgent Implementation
// ============================================================

import { PiAgentTransport } from './pi-agent-transport.ts';

export abstract class PiAgentToolHost extends PiAgentTransport {
  private getActiveSourcePermissionRefs(): ActiveSourcePermissionRef[] {
    const activeSlugs = this.sourceManager.getActiveSlugs();
    return this.sourceManager.getAllSources()
      .filter(source => activeSlugs.has(source.config.slug))
      .map(source => ({
        slug: source.config.slug,
        ownerRootPath: source.workspaceRootPath,
        grantAuthority: source.origin === 'workspace' ? 'project' : 'host',
      }));
  }

  /**
   * Handle a pre_tool_use_request from the subprocess.
   * Runs the centralized permission pipeline and sends the decision back.
   */
  protected async handlePreToolUseRequest(req: {
    requestId: string;
    toolName: string;
    toolCallId?: string;
    input: Record<string, unknown>;
  }): Promise<void> {
    const { requestId, toolName, input } = req;
    const debugSessionId = this.config.session?.id || this._sessionId;
    this.debug(`PreToolUse request from subprocess: ${toolName} (${requestId}, sessionId=${debugSessionId})`);

    // Fire PreToolUse automation event — await so automations run before tool executes
    await this.emitAutomationEvent('PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: input,
    });

    const rootPath = this.config.workspace.rootPath ?? this.workingDirectory;
    const sessionId = this.config.session?.id || this._sessionId;
    const plansFolderPath = sessionId
      ? getSessionPlansPath(rootPath, sessionId)
      : undefined;
    const dataFolderPath = sessionId
      ? getSessionDataPath(rootPath, sessionId)
      : undefined;

    const checkResult = runPreToolUseChecks({
      toolName,
      input,
      apiOperation: this.mcpPool?.getProxyToolPermission(toolName, input),
      sessionId,
      permissionMode: this.permissionManager.getPermissionMode(),
      workspaceRootPath: rootPath,
      allowProjectGrants: isFreeConversationWorkspaceId(this.config.workspace.id),
      plansFolderPath,
      dataFolderPath,
      workingDirectory: this.config.session?.workingDirectory,
      fileAccessBoundary: this.config.fileAccessBoundary,
      activeSourceSlugs: Array.from(this.sourceManager.getActiveSlugs()),
      activeSources: this.getActiveSourcePermissionRefs(),
      allSourceSlugs: this.sourceManager.getAllSources().map(s => s.config.slug),
      hasSourceActivation: !!this.onSourceActivationRequest,
      permissionManager: this.permissionManager,
      prerequisiteManager: this.prerequisiteManager,
      onDebug: (msg) => this.debug(`PreToolUse(sessionId=${sessionId}): ${msg}`),
    });

    switch (checkResult.type) {
      case 'allow':
        this.send({ type: 'pre_tool_use_response', requestId, action: 'allow' });
        return;

      case 'modify':
        this.send({ type: 'pre_tool_use_response', requestId, action: 'modify', input: checkResult.input });
        return;

      case 'block': {
        const diagnostics = getPermissionModeDiagnostics(sessionId);
        this.debug(`__PERMISSION_BLOCK__${JSON.stringify({
          sessionId,
          toolName,
          effectiveMode: diagnostics.permissionMode,
          modeVersion: diagnostics.modeVersion,
          changedBy: diagnostics.lastChangedBy,
          changedAt: diagnostics.lastChangedAt,
          reason: checkResult.reason,
        })}`);
        this.send({ type: 'pre_tool_use_response', requestId, action: 'block', reason: checkResult.reason });
        return;
      }

      case 'source_activation_needed': {
        const { sourceSlug, sourceExists } = checkResult;
        this.debug(`PreToolUse(sessionId=${sessionId}): Source "${sourceSlug}" not active, attempting activation...`);

        if (this.onSourceActivationRequest) {
          try {
            const activated = await this.onSourceActivationRequest(sourceSlug);
            if (!activated) {
              const reason = sourceExists
                ? `Source "${sourceSlug}" is not active. Activate it by @mentioning it in your message or via the source icon at the bottom of the input field.`
                : `Source "${sourceSlug}" is not available yet. It needs to be created and configured first.`;
              this.send({ type: 'pre_tool_use_response', requestId, action: 'block', reason });
              return;
            }
            this.debug(`PreToolUse(sessionId=${sessionId}): Source "${sourceSlug}" activated successfully`);
          } catch (err) {
            const reason = sourceExists
              ? `Source "${sourceSlug}" could not be activated: ${err}`
              : `Source "${sourceSlug}" is not available yet. It needs to be created and configured first.`;
            this.send({ type: 'pre_tool_use_response', requestId, action: 'block', reason });
            return;
          }
        }

        // Re-run pipeline after activation
        const postResult = runPreToolUseChecks({
          toolName,
          input,
          apiOperation: this.mcpPool?.getProxyToolPermission(toolName, input),
          sessionId,
          permissionMode: this.permissionManager.getPermissionMode(),
          workspaceRootPath: rootPath,
          allowProjectGrants: isFreeConversationWorkspaceId(this.config.workspace.id),
          plansFolderPath,
          dataFolderPath,
          workingDirectory: this.config.session?.workingDirectory,
          fileAccessBoundary: this.config.fileAccessBoundary,
          activeSourceSlugs: Array.from(this.sourceManager.getActiveSlugs()),
          activeSources: this.getActiveSourcePermissionRefs(),
          allSourceSlugs: this.sourceManager.getAllSources().map(s => s.config.slug),
          hasSourceActivation: !!this.onSourceActivationRequest,
          permissionManager: this.permissionManager,
          prerequisiteManager: this.prerequisiteManager,
          onDebug: (msg) => this.debug(`PreToolUse(sessionId=${sessionId}): ${msg}`),
        });

        if (postResult.type === 'modify') {
          this.send({ type: 'pre_tool_use_response', requestId, action: 'modify', input: postResult.input });
        } else if (postResult.type === 'block') {
          this.send({ type: 'pre_tool_use_response', requestId, action: 'block', reason: postResult.reason });
        } else {
          this.send({ type: 'pre_tool_use_response', requestId, action: 'allow' });
        }
        return;
      }

      case 'call_llm_intercept':
      case 'spawn_session_intercept':
        // These tools are proxy tools handled via tool_execute_request — just allow
        this.send({ type: 'pre_tool_use_response', requestId, action: 'allow' });
        return;

      case 'prompt': {
        if (!this.onPermissionRequest) {
          // No permission handler — allow
          if (checkResult.modifiedInput) {
            this.send({ type: 'pre_tool_use_response', requestId, action: 'modify', input: checkResult.modifiedInput });
          } else {
            this.send({ type: 'pre_tool_use_response', requestId, action: 'allow' });
          }
          return;
        }

        const permRequestId = `pi-perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.debug(`PreToolUse(sessionId=${sessionId}): Prompting user for ${toolName} - ${checkResult.description}`);

        // Wait for user response via pendingPermissions
        const permissionPromise = new Promise<boolean>((resolve) => {
          this.pendingPermissions.set(permRequestId, {
            resolve,
            toolName,
          });
        });

        this.onPermissionRequest({
          requestId: permRequestId,
          toolName,
          command: checkResult.command,
          description: checkResult.description,
          type: checkResult.promptType,
          appName: checkResult.appName,
          reason: checkResult.reason,
          impact: checkResult.impact,
          requiresSystemPrompt: checkResult.requiresSystemPrompt,
          rememberForMinutes: checkResult.rememberForMinutes,
          commandHash: checkResult.commandHash,
          approvalTtlSeconds: checkResult.approvalTtlSeconds,
        });

        const allowed = await permissionPromise;
        this.pendingPermissions.delete(permRequestId);

        if (!allowed) {
          this.send({ type: 'pre_tool_use_response', requestId, action: 'block', reason: 'Permission denied by user.' });
          return;
        }

        if (checkResult.modifiedInput) {
          this.send({ type: 'pre_tool_use_response', requestId, action: 'modify', input: checkResult.modifiedInput });
        } else {
          this.send({ type: 'pre_tool_use_response', requestId, action: 'allow' });
        }
        return;
      }
    }
  }

  /**
   * Handle a tool_execute_request from the subprocess.
   * Routes proxy tool calls (MCP, API, session) to the appropriate handler.
   *
   * The subprocess expects responses in the format:
   *   { content: string; isError: boolean }
   */
  protected async handleToolExecuteRequest(request: {
    requestId: string;
    toolName: string;
    args: Record<string, unknown>;
  }): Promise<void> {
    // Prerequisite check: block source tools until guide.md is read
    const prereqResult = this.prerequisiteManager.checkPrerequisites(request.toolName);
    if (!prereqResult.allowed) {
      this.send({
        type: 'tool_execute_response',
        requestId: request.requestId,
        result: { content: prereqResult.blockReason!, isError: true },
      });
      return;
    }

    try {
      const result = await this.routeToolCall(request.toolName, request.args);
      this.send({
        type: 'tool_execute_response',
        requestId: request.requestId,
        result,
      });
    } catch (error) {
      this.send({
        type: 'tool_execute_response',
        requestId: request.requestId,
        result: {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        },
      });
    }
  }

  /**
   * Route a proxy tool call to the appropriate handler based on tool name.
   *
   * - Session tools (SubmitPlan, config_validate, etc.) -> session-tools-core handlers
   * - call_llm -> preExecuteCallLlm (PiAgentHost)
   * - mcp__* tools -> MCP server proxy (TODO)
   * - api_* tools -> API source proxy (TODO)
   *
   * Returns { content: string; isError: boolean } matching subprocess protocol.
   */
  protected async routeToolCall(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: string; isError: boolean }> {
    // Session-scoped tools — strip mcp__session__ prefix added by the Pi SDK
    // registration (tools are registered as mcp__session__SubmitPlan, etc.)
    const strippedName = toolName.startsWith('mcp__session__')
      ? toolName.slice('mcp__session__'.length)
      : toolName;

    if (SESSION_TOOL_NAMES.has(strippedName)) {
      return this.executeSessionTool(strippedName, args);
    }

    // MCP source tools — route through centralized pool
    const mcpPool = this.mcpPool;
    const proxyCapability = mcpPool?.getProxyToolCapability(toolName);
    if (mcpPool && proxyCapability) {
      const { sourceSlug, capabilityRef } = proxyCapability;
      const context = this.getSessionToolContext();
      if (
        context.isStdioMcpExecutionAllowed?.(sourceSlug, capabilityRef) !== true
      ) {
        return {
          content: `Source "${sourceSlug}" is disabled by Host settings.`,
          isError: true,
        };
      }
      return mcpPool.callTool(toolName, args);
    }

    // Unknown tool
    return {
      content: `Unknown proxy tool: ${toolName}`,
      isError: true,
    };
  }

  /**
   * Get or create a SessionToolContext for executing session-scoped tools.
   * Cached per agent instance since the workspace/session don't change.
   */
  protected getSessionToolContext(): SessionToolContext {
    if (this._sessionToolContext) return this._sessionToolContext;

    const sessionId = this.config.session?.id || '';
    const workspacePath = this.config.workspace.rootPath;
    const workspaceId = this.config.workspace.id;

    this._sessionToolContext = createSessionToolContext({
      sessionId,
      workspacePath,
      workspaceId,
      getHostGrantedSourceRefs: () => isFreeConversationWorkspaceId(workspaceId)
        ? null
        : resolveRuntimeWorkspaceById(workspaceId)?.defaultEnabledSourceRefs ?? [],
      getHostAllowsProjectStdio: () => isLocalMcpEnabled(
        workspacePath,
        resolveRuntimeWorkspaceById(workspaceId)?.localMcpEnabled,
      ),
      onPlanSubmitted: async (planPath: string) => {
        await this.onPlanSubmitted?.(planPath);
      },
      onAuthRequest: (request: unknown) => {
        this.onAuthRequest?.(request as any);
      },
      onAskUserQuestion: async (request) => {
        const callback = getSessionScopedToolCallbacks(sessionId)?.askUserQuestionFn;
        if (!callback) throw new Error('Interactive questions are not supported by this host.');
        return callback(request);
      },
    });

    // Attach session self-management bindings (lazy getters from callback registry)
    attachSessionSelfManagementBindings(this._sessionToolContext, sessionId);

    return this._sessionToolContext;
  }

  /**
   * Execute a session-scoped tool by name.
   * Uses the canonical registry from @craft-agent/session-tools-core.
   */
  protected async executeSessionTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; isError: boolean }> {
    try {
      // call_llm uses the product-host pre-execution pipeline
      if (toolName === 'call_llm') {
        try {
          const result = await this.preExecuteCallLlm(args);
          return { content: result.text || '(Model returned empty response)', isError: false };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `call_llm failed: ${msg}`, isError: true };
        }
      }

      // spawn_session uses the product-host pre-execution pipeline
      if (toolName === 'spawn_session') {
        try {
          const result = await this.preExecuteSpawnSession(args);
          return { content: JSON.stringify(result, null, 2), isError: false };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `spawn_session failed: ${msg}`, isError: true };
        }
      }

      // browser_tool — single CLI-like tool for all browser actions
      if (toolName === 'browser_tool') {
        const callbacks = getSessionScopedToolCallbacks(this._sessionId);
        const browserFns = callbacks?.browserPaneFns;
        if (!browserFns) {
          return { content: 'Browser window controls are not available. This tool requires the desktop app.', isError: true };
        }

        try {
          const result = await executeBrowserToolCommand({
            command: (args.command as string | string[]) ?? '',
            fns: browserFns,
            sessionId: this._sessionId,
          });

          let content = result.output;
          if (result.image) {
            const sessionPath = getSessionPath(this.config.workspace.rootPath, this._sessionId);
            const imageBuffer = Buffer.from(result.image.data, 'base64');
            const ext = result.image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
            const saved = saveBinaryResponse(sessionPath, `browser-screenshot.${ext}`, imageBuffer, result.image.mimeType);

            if (saved.type === 'file_download') {
              content += [
                '',
                `Saved screenshot: ${saved.path}`,
                '',
                '```image-preview',
                JSON.stringify({
                  src: saved.path,
                  title: 'Browser Screenshot',
                }, null, 2),
                '```',
              ].join('\n');
            } else {
              content += `\n\n[Screenshot captured (${Math.round(result.image.sizeBytes / 1024)}KB ${result.image.mimeType}) but failed to save: ${saved.error}]`;
            }
          }

          return { content, isError: false };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: msg, isError: true };
        }
      }

      const def = SESSION_TOOL_REGISTRY.get(toolName);
      if (!def) {
        return { content: `Unknown session tool: ${toolName}`, isError: true };
      }
      if (!def.handler) {
        return {
          content: `Session tool '${toolName}' is backend-executed (${def.executionMode}) but has no PiAgent adapter implementation.`,
          isError: true,
        };
      }

      const ctx = this.getSessionToolContext();
      const result: SessionToolResult = await def.handler(ctx, args);

      // Convert ToolResult to subprocess response format
      const text = result.content.map(c => c.text).join('\n');
      return { content: text, isError: !!result.isError };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.debug(`Session tool ${toolName} failed: ${msg}`);
      return { content: `Session tool error: ${msg}`, isError: true };
    }
  }



  /**
   * Handle ensure_session_ready_result from subprocess.
   */
  protected handleEnsureSessionReadyResult(msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const sessionId = (msg.sessionId as string | null) ?? null;
    const pending = this.pendingEnsureSessionReady.get(id);
    if (!pending) return;

    this.pendingEnsureSessionReady.delete(id);
    if (sessionId && this.piSessionId !== sessionId) {
      this.piSessionId = sessionId;
      this.config.onSdkSessionIdUpdate?.(sessionId);
    }
    pending.resolve(sessionId);
  }

  /**
   * Handle compact_result from subprocess.
   */
  protected handleCompactResult(msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const success = Boolean(msg.success);
    const pending = this.pendingCompactions.get(id);
    if (!pending) return;

    this.pendingCompactions.delete(id);
    if (!success) {
      pending.reject(new Error(String(msg.errorMessage || 'Compaction failed')));
      return;
    }

    const raw = msg.result as Record<string, unknown> | undefined;
    if (!raw) {
      pending.resolve(null);
      return;
    }

    pending.resolve({
      summary: String(raw.summary || ''),
      firstKeptEntryId: String(raw.firstKeptEntryId || ''),
      tokensBefore: Number(raw.tokensBefore || 0),
    });
  }

  protected handleRewindUserMessageResult(msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const pending = this.pendingRewindUserMessages.get(id);
    if (!pending) return;

    this.pendingRewindUserMessages.delete(id);
    if (!msg.success) {
      const error = Object.assign(
        new Error(String(msg.errorMessage || 'In-place rewind failed')),
        typeof msg.errorCode === 'string' ? { code: msg.errorCode } : {},
      );
      pending.reject(error);
      return;
    }

    pending.resolve({
      editorText: typeof msg.editorText === 'string' ? msg.editorText : undefined,
    });
  }

  protected async handleConversationRewindRequest(msg: {
    requestId: string;
    request: ConversationRewindRequest;
  }): Promise<void> {
    try {
      const project = this.config.onConversationRewind;
      if (!project) throw new Error('Product transcript rewind is unavailable');
      const result: ConversationRewindResult = await project(msg.request);
      this.send({
        type: 'conversation_rewind_response',
        requestId: msg.requestId,
        success: true,
        result,
      });
    } catch (error) {
      this.send({
        type: 'conversation_rewind_response',
        requestId: msg.requestId,
        success: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle update_runtime_config_result from subprocess.
   */
  protected handleRuntimeConfigUpdateResult(msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const success = Boolean(msg.success);
    const pending = this.pendingRuntimeConfigUpdates.get(id);
    if (!pending) return;

    this.pendingRuntimeConfigUpdates.delete(id);
    if (!success) {
      pending.reject(new Error(String(msg.errorMessage || 'Runtime config update failed')));
      return;
    }

    pending.resolve(Boolean(msg.updated ?? true));
  }

  protected handleCredentialUpdateResult(msg: Record<string, unknown>): void {
    const id = String(msg.id || '');
    const pending = this.pendingCredentialUpdates.get(id);
    if (!pending) return;
    this.pendingCredentialUpdates.delete(id);
    if (msg.success) pending.resolve();
    else pending.reject(new Error(String(msg.errorMessage || 'Credential update failed')));
  }

  /**
   * Handle subprocess exit.
   */
  protected handleSubprocessExit(code: number | null, signal: string | null): void {
    this.debug(`Pi subprocess exited: code=${code}, signal=${signal}`);

    this.subprocess = null;
    this.stopReadingStdout?.();
    this.stopReadingStdout = null;
    this.resetSubprocessErrorDedup();
    this.subprocessReady = null;
    this.subprocessReadyResolve = null;

    // If we were processing, emit error + complete
    if (this._isProcessing) {
      const exitReason = signal ? `signal ${signal}` : `code ${code}`;
      this.eventQueue.enqueue({
        type: 'error',
        message: `Pi subprocess exited unexpectedly (${exitReason})`,
      });
      this.eventQueue.complete();
    }

    const exitReason = signal ? `signal ${signal}` : `code ${code}`;
    // Reject pending llm_query calls (call_llm in-flight during subprocess crash)
    for (const [, pending] of this.pendingLlmQueries) {
      pending.reject(new Error(`Pi subprocess exited unexpectedly (${exitReason})`));
    }
    this.pendingLlmQueries.clear();

    // Reject pending ensure_session_ready requests
    for (const [, pending] of this.pendingEnsureSessionReady) {
      pending.reject(new Error(`Pi subprocess exited unexpectedly (${exitReason})`));
    }
    this.pendingEnsureSessionReady.clear();

    // Reject pending compact requests
    for (const [, pending] of this.pendingCompactions) {
      pending.reject(new Error(`Pi subprocess exited unexpectedly (${exitReason})`));
    }
    this.pendingCompactions.clear();

    for (const [, pending] of this.pendingRewindUserMessages) {
      pending.reject(new Error(`Pi subprocess exited unexpectedly (${exitReason})`));
    }
    this.pendingRewindUserMessages.clear();

    for (const [, pending] of this.pendingRuntimeConfigUpdates) {
      pending.reject(new Error(`Pi subprocess exited unexpectedly (${exitReason})`));
    }
    this.pendingRuntimeConfigUpdates.clear();

    for (const [, pending] of this.pendingCredentialUpdates) {
      pending.reject(new Error(`Pi subprocess exited unexpectedly (${exitReason})`));
    }
    this.pendingCredentialUpdates.clear();

  }

  /**
   * Ask subprocess to create/verify the primary session (without sending a prompt)
   * and return the active Pi session ID.
   */
  protected async requestEnsureSessionReady(): Promise<string | null> {
    await this.ensureSubprocess();

    const id = `ensure-ready-${++this.rpcIdCounter}`;
    const timeoutMs = 15_000;

    return new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingEnsureSessionReady.delete(id);
        reject(new Error(`ensure_session_ready timed out after ${Math.floor(timeoutMs / 1000)}s`));
      }, timeoutMs);

      this.pendingEnsureSessionReady.set(id, {
        resolve: (sessionId) => {
          clearTimeout(timer);
          resolve(sessionId);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.send({ type: 'ensure_session_ready', id });
    });
  }

  /**
   * Ask subprocess to compact the active session context.
   */
  protected async requestCompact(customInstructions?: string): Promise<{ summary: string; firstKeptEntryId: string; tokensBefore: number } | null> {
    await this.ensureSubprocess();

    const id = `compact-${++this.rpcIdCounter}`;
    // GPT-backed Pi compactions on large conversations can legitimately take 60-120s
    // (single blocking OpenAI summary call, no progress stream). 5 min covers realistic
    // cases; truly hung subprocesses are caught by the stdio death watchdog.
    const timeoutMs = 300_000;

    return new Promise<{ summary: string; firstKeptEntryId: string; tokensBefore: number } | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCompactions.delete(id);
        reject(new Error(`compact timed out after ${Math.floor(timeoutMs / 1000)}s`));
      }, timeoutMs);

      this.pendingCompactions.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.send({ type: 'compact', id, customInstructions });
    });
  }

  /**
   * Ask subprocess to refresh runtime-affecting custom endpoint config in-place.
   */
  protected async requestRuntimeConfigUpdate(update: BackendRuntimeUpdate): Promise<boolean> {
    if (!this.subprocess) return true;

    const id = `runtime-config-${++this.rpcIdCounter}`;
    const timeoutMs = 15_000;
    const runtime = update.runtime ?? {};

    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRuntimeConfigUpdates.delete(id);
        reject(new Error(`update_runtime_config timed out after ${Math.floor(timeoutMs / 1000)}s`));
      }, timeoutMs);

      this.pendingRuntimeConfigUpdates.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.send({
        type: 'update_runtime_config',
        id,
        model: update.model,
        providerType: update.providerType,
        authType: update.authType,
        baseUrl: runtime.baseUrl,
        customEndpoint: runtime.customEndpoint,
        customModels: runtime.customModels,
      });
    });
  }

  protected async requestCredentialUpdate(piAuth: Awaited<ReturnType<PiAgentTransport['getPiAuth']>>): Promise<void> {
    if (!this.subprocess || !piAuth) return;
    const id = `credential-update-${++this.rpcIdCounter}`;
    const timeoutMs = 15_000;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCredentialUpdates.delete(id);
        reject(new Error(`token_update timed out after ${Math.floor(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pendingCredentialUpdates.set(id, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ type: 'token_update', id, piAuth });
    });
  }

  /**
   * Ensure branched Pi sessions are backend-ready before first user message.
   * Called by SessionManager during branch creation to avoid creating
   * transcript-only branches without real Pi session context.
   */
  override async ensureBranchReady(): Promise<void> {
    const isBranchedSession = !!this.config.session?.branchFromMessageId;
    if (!isBranchedSession) return;

    // Branched sessions must include parent session path metadata for Pi forking.
    if (!this.config.session?.branchFromSessionPath) {
      throw new Error('Pi branch preflight failed: missing branchFromSessionPath metadata');
    }

    const sessionId = await this.requestEnsureSessionReady();
    if (!sessionId) {
      throw new Error('Pi branch preflight failed: subprocess did not provide a session ID');
    }

    if (this.piSessionId !== sessionId) {
      this.piSessionId = sessionId;
      this.config.onSdkSessionIdUpdate?.(sessionId);
    }
  }

  /**
   * In-place rewind via Pi navigateTree (same session file, new leaf).
   */
  override async rewindUserMessage(
    visibleUserMessageId: string,
  ): Promise<{ editorText?: string }> {
    await this.requestEnsureSessionReady();
    await this.ensureSubprocess();

    const id = `rewind-user-${++this.rpcIdCounter}`;
    const timeoutMs = 30_000;

    return new Promise<{ editorText?: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRewindUserMessages.delete(id);
        reject(new Error(`rewind_user_message timed out after ${Math.floor(timeoutMs / 1000)}s`));
      }, timeoutMs);

      this.pendingRewindUserMessages.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.send({
        type: 'rewind_user_message',
        id,
        visibleUserMessageId,
      });
    });
  }

}
