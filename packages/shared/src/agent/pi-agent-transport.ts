// input: Resolved runtime config, credentials, and typed Pi JSONL process messages
// output: Subprocess lifecycle, correlated protocol results, and Pi event delivery
// pos: Policy-free Boundary Protocol beneath the Product Host projection

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
 * Credentials are supplied by the Product Host; Pi owns provider use and
 * returns OAuth rotations for persistence.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { getProxyEnvVars } from '../config/proxy-env.ts';
import { readJsonLines } from '../utils/jsonl.ts';
import { perf } from '../utils/perf.ts';

import type {
  BackendConfig,
  ConversationRewindRequest,
} from './backend/types.ts';
import { AbortReason } from './backend/types.ts';
import { getBackendRuntime } from './backend/internal/driver-types.ts';

// Import models from centralized registry
import { getModelById } from '../config/models.ts';

// Storyflow Product Host behavior projected into Pi
import { PiAgentHost } from './pi-agent-host.ts';
import { getExtendedPromptCache } from '../config/storage.ts';

// Event adapter
import { PiEventAdapter } from './backend/pi/event-adapter.ts';
import type { PiInboundMessage, PiOutboundMessage } from './backend/pi/protocol.ts';
import { EventQueue } from './backend/event-queue.ts';

// Credential manager for token storage
import { getCredentialManager } from '../credentials/manager.ts';

// Session tool proxy definitions (for registering with subprocess)
import { getSessionToolProxyDefs } from './backend/pi/session-tool-defs.ts';

// Session tool registry (for executing proxy tool calls)
import {
  SESSION_BACKEND_TOOL_NAMES,
} from '@craft-agent/session-tools-core';
import type { SessionToolContext } from './session-tool-context.ts';

// McpClientPool for source tool proxying (centralized pool from main process)
import type { McpClientPoolLike } from '../mcp/types.ts';

// Path utilities
import { join } from 'path';
import { homedir } from 'os';

// Session storage (plans folder path)
import { getSessionPath, getSessionPlansPath } from '../sessions/storage.ts';

// Error typing
import type { AgentError } from './errors.ts';

// LLM tool types
import type { LLMQueryResult } from './llm-tool.ts';

// ============================================================
// PiAgent Implementation
// ============================================================

/** Backend-executed session tools currently supported by PiAgent. */
export const PI_BACKEND_SESSION_TOOL_NAMES = new Set<string>([
  'call_llm',
  'spawn_session',
  'browser_tool',
]);

/**
 * Backend implementation using the Pi coding agent SDK via subprocess.
 *
 * Spawns a pi-agent-server subprocess and communicates via JSONL protocol.
 * Extends PiAgentHost for product-owned behavior (permission mode, source management,
 * planning heuristics, config watching, usage tracking).
 */
export abstract class PiAgentTransport extends PiAgentHost {
  protected backendName = 'Storyflow';

  // ============================================================
  // Subprocess State
  // ============================================================

  // Subprocess process handle
  protected subprocess: ChildProcess | null = null;
  protected stopReadingStdout: (() => void) | null = null;
  protected subprocessReady: Promise<void> | null = null;
  protected subprocessReadyResolve: (() => void) | null = null;

  // Pi session ID (managed by subprocess, reported back)
  protected piSessionId: string | null = null;

  // State
  protected _isProcessing: boolean = false;
  protected abortReason?: AbortReason;
  protected activePromptId: string | null = null;
  /** Host may reconsider eviction after a cancelled native turn finally settles. */
  onNativeTurnSettled?: () => void;

  // Event adapter
  protected adapter: PiEventAdapter;

  // Event queue for streaming (AsyncGenerator pattern -- shared with CodexAgent/CopilotAgent)
  protected eventQueue = new EventQueue();

  // Error deduplication — suppress identical consecutive errors after a threshold
  // to prevent a broken subprocess from flooding the user's session.
  protected lastSubprocessError: string | null = null;
  protected subprocessErrorRepeatCount = 0;
  protected static readonly MAX_IDENTICAL_SUBPROCESS_ERRORS = 3;

  protected resetSubprocessErrorDedup(): void {
    this.lastSubprocessError = null;
    this.subprocessErrorRepeatCount = 0;
  }

  // Ring buffer of recent subprocess stderr. Always on (independent of CRAFT_DEBUG)
  // so that connection-test and other failures can surface what the subprocess
  // actually said, instead of a bare "timed out" with no context.
  protected stderrBuffer: string[] = [];
  protected stderrBufferBytes = 0;
  protected static readonly STDERR_BUFFER_MAX_BYTES = 8 * 1024;

  protected recordStderr(chunk: string): void {
    if (!chunk) return;
    // If a single chunk is larger than the cap, keep only its tail so the
    // buffer always holds the most-recent output even in pathological cases.
    const effective = chunk.length > PiAgentTransport.STDERR_BUFFER_MAX_BYTES
      ? chunk.slice(chunk.length - PiAgentTransport.STDERR_BUFFER_MAX_BYTES)
      : chunk;
    this.stderrBuffer.push(effective);
    this.stderrBufferBytes += effective.length;
    // Drop oldest chunks until we're back under the cap, but always keep at
    // least one entry so a single-chunk tail survives.
    while (this.stderrBufferBytes > PiAgentTransport.STDERR_BUFFER_MAX_BYTES && this.stderrBuffer.length > 1) {
      const dropped = this.stderrBuffer.shift()!;
      this.stderrBufferBytes -= dropped.length;
    }
  }

  /** Returns the most recent subprocess stderr output (up to ~8KB). Empty string if nothing captured. */
  getRecentStderr(): string {
    return this.stderrBuffer.join('');
  }

  // Pending permission requests (used by handlePreToolUseRequest for ask-mode prompting)
  protected pendingPermissions: Map<string, {
    resolve: (allowed: boolean) => void;
    toolName: string;
  }> = new Map();

  // Pending llm_query calls (correlation map for subprocess llm_query_result).
  protected pendingLlmQueries: Map<string, {
    resolve: (result: LLMQueryResult) => void;
    reject: (error: Error) => void;
  }> = new Map();

  // Pending ensure_session_ready requests (branch preflight handshake)
  protected pendingEnsureSessionReady: Map<string, {
    resolve: (sessionId: string | null) => void;
    reject: (error: Error) => void;
  }> = new Map();

  // Pending compact requests (manual compaction RPC)
  protected pendingCompactions: Map<string, {
    resolve: (result: { summary: string; firstKeptEntryId: string; tokensBefore: number } | null) => void;
    reject: (error: Error) => void;
  }> = new Map();

  // Pending in-place rewind requests (Pi navigateTree)
  protected pendingRewindUserMessages: Map<string, {
    resolve: (result: { editorText?: string }) => void;
    reject: (error: Error) => void;
  }> = new Map();

  // Pending runtime config updates (custom endpoint model capability refresh)
  protected pendingRuntimeConfigUpdates: Map<string, {
    resolve: (updated: boolean) => void;
    reject: (error: Error) => void;
  }> = new Map();
  protected pendingCredentialUpdates: Map<string, {
    resolve: () => void;
    reject: (error: Error) => void;
  }> = new Map();

  // Pool reference for convenience (from this.config.mcpPool)
  protected get mcpPool(): McpClientPoolLike | undefined { return this.config.mcpPool; }

  // Cached session tool context (lazy-created on first session tool call)
  protected _sessionToolContext: SessionToolContext | null = null;

  // RPC request counter for unique IDs
  protected rpcIdCounter: number = 0;

  protected needsFreshSessionRecoverySeed: boolean;

  // ============================================================
  // Constructor
  // ============================================================

  constructor(config: BackendConfig) {
    const resolvedModel = config.model || '';
    const modelDef = getModelById(resolvedModel);
    super(config, resolvedModel);

    this._supportsBranching = true;

    this.piSessionId = config.session?.sdkSessionId || null;
    this.needsFreshSessionRecoverySeed = config.seedFreshSessionFromRecovery === true;
    this.adapter = new PiEventAdapter();
    if (modelDef?.contextWindow) {
      this.adapter.setContextWindow(modelDef.contextWindow);
    }
    if (config.miniModel) {
      this.adapter.setMiniModel(config.miniModel);
    }

  }

  /**
   * Guardrail: ensure every backend-mode session tool from core is implemented here.
   * This fails fast in development/CI instead of surfacing as runtime "Unknown session tool".
   */
  protected assertBackendSessionToolParity(): void {
    const missing = [...SESSION_BACKEND_TOOL_NAMES].filter(
      (name) => !PI_BACKEND_SESSION_TOOL_NAMES.has(name),
    );

    if (missing.length > 0) {
      throw new Error(
        `PiAgent missing backend session tool implementations: ${missing.join(', ')}`,
      );
    }
  }

  // ============================================================
  // Subprocess Management
  // ============================================================

  /**
   * Ensure the subprocess is spawned and ready.
   * Lazy initialization -- spawns on first use.
   */
  protected async ensureSubprocess(): Promise<void> {
    if (this.subprocess && this.subprocessReady) {
      await this.subprocessReady;
      return;
    }

    await this.spawnSubprocess();
  }

  /**
   * Spawn the pi-agent-server subprocess and set up JSONL communication.
   */
  protected async spawnSubprocess(): Promise<void> {
    const runtime = getBackendRuntime(this.config);
    const piServerPath = runtime.paths?.piServer;
    if (!piServerPath) {
      throw new Error('piServerPath not configured. Cannot spawn Pi subprocess.');
    }

    const nodePath = runtime.paths?.node || process.execPath;
    const piServerIsScript = /\.(?:[cm]?js|ts)$/.test(piServerPath);
    const executablePath = piServerIsScript ? nodePath : piServerPath;

    this.debug(
      `Spawning Pi subprocess: ${executablePath}${piServerIsScript ? ` ${piServerPath}` : ''}`,
    );
    this.resetSubprocessErrorDedup();

    // Set up ready promise before spawning
    this.subprocessReady = new Promise<void>((resolve) => {
      this.subprocessReadyResolve = resolve;
    });

    // Build session ID and session dir path upfront (used for spawn env + init command)
    const sessionId = this.config.session?.id || `agent-${Date.now()}`;
    const endSubprocessReady = perf.start('pi.subprocess.ready', { sessionId });
    const sessionDir = this.config.session
      ? getSessionPath(this.config.workspace.rootPath, sessionId)
      : undefined;

    // Pi owns provider protocol handling; no fetch interceptor is preloaded.
    const args = piServerIsScript ? [piServerPath] : [];

    // Resolve credentials before spawning so we can derive AWS env vars
    // from the same fetch that produces piAuth (single source of truth).

    // Retrieve auth credentials for the subprocess.
    // Custom endpoint mode must NOT fall back to global API keys — keyless local endpoints
    // are valid, and non-local endpoints should fail explicitly instead of using unrelated creds.
    const piAuth = await this.getPiAuth();
    const isCustomEndpointMode = !!runtime.customEndpoint;
    const legacyApiKey = (!piAuth && !isCustomEndpointMode) ? await this.getApiKey() : undefined;
    if (isCustomEndpointMode && !piAuth) {
      this.debug('Custom endpoint mode: no provider credential configured, sending empty API key');
    }

    // Derive AWS env vars from the piAuth credential (single fetch, no race).
    const awsEnv = this.buildAwsEnv(piAuth, runtime);

    // Revalidate at the spawn sink, after credential awaits, so a replaced cwd
    // cannot redirect the subprocess through a stale symlink target.
    const requestedCwd = this.resolvedCwd();
    const cwd = this.config.validateWorkingDirectory?.(requestedCwd) ?? requestedCwd;
    if (cwd !== requestedCwd) this.updateWorkingDirectory(cwd);

    // Spawn the subprocess
    const child = spawn(executablePath, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...getProxyEnvVars(),
        ...this.config.envOverrides,
        ...awsEnv,
        // Pi natively maps this setting to provider-specific cache controls.
        PI_CACHE_RETENTION: getExtendedPromptCache() ? 'long' : 'short',
        // Provider hooks persist status-only diagnostics per session.
        ...(sessionDir ? { CRAFT_SESSION_DIR: sessionDir } : {}),
        // Propagate debug mode
        CRAFT_DEBUG: (process.argv.includes('--debug') || process.env.CRAFT_DEBUG === '1') ? '1' : '0',
      },
    });

    this.subprocess = child;

    this.stopReadingStdout = readJsonLines(child.stdout!, (line) => this.handleLine(line));

    // Always capture stderr into a bounded ring buffer so callers (e.g. the
    // connection-test timeout path) can surface it on failure.
    // Keep the CRAFT_DEBUG-gated log for interactive dev work.
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      this.recordStderr(text);
      const trimmed = text.trim();
      if (trimmed) {
        this.debug(`[subprocess stderr] ${trimmed}`);
      }
    });

    // Handle subprocess exit
    child.on('exit', (code, signal) => {
      this.handleSubprocessExit(code, signal);
    });

    child.on('error', (error) => {
      this.debug(`Subprocess error: ${error.message}`);
      this.resetSubprocessErrorDedup();
      this.eventQueue.enqueue({ type: 'error', message: `Pi subprocess error: ${error.message}` });
      this.eventQueue.complete();
    });

    const sessionPath = this.config.session
      ? getSessionPath(this.config.workspace.rootPath, sessionId)
      : '';
    const plansFolderPath = getSessionPlansPath(this.config.workspace.rootPath, sessionId);
    const workingDirectory = cwd;

    // Send init command (flat structure matching subprocess InboundMessage type)
    this.send({
      type: 'init',
      apiKey: legacyApiKey || '',
      model: this._model,
      cwd,
      thinkingLevel: this._thinkingLevel,
      workspaceRootPath: this.config.workspace.rootPath,
      projectRoot: this.config.projectRoot,
      sessionId,
      sessionPath,
      workingDirectory,
      plansFolderPath,
      miniModel: this.config.miniModel,
      providerType: this.config.providerType,
      authType: this.config.authType,
      workspaceId: this.config.workspace.id,
      ...(piAuth ? { piAuth } : {}),
      baseUrl: runtime.baseUrl,
      customEndpoint: runtime.customEndpoint,
      customModels: runtime.customModels,
      enable1MContext: this.config.enable1MContext,
      // Branch params for Pi SDK session fork
      branchFromSdkSessionId: this.config.session?.branchFromSdkSessionId,
      branchFromSessionPath: this.config.session?.branchFromSessionPath,
      branchFromSdkTurnId: this.config.session?.branchFromSdkTurnId,
    });

    // Wait for subprocess to report ready
    await this.subprocessReady;
    endSubprocessReady();
    this.debug('Pi subprocess is ready');
    // Register session-scoped tools with the subprocess. Host-owned tools run
    // in the main process; call_llm stays inside the Pi runtime. Register before
    // any command that creates the Pi session so cold start builds it only once.
    this.assertBackendSessionToolParity();
    const sessionToolDefs = getSessionToolProxyDefs();

    // Patch call_llm description with provider-specific model hint
    if (this.config.miniModel) {
      const callLlmDef = sessionToolDefs.find(d => d.name === 'mcp__session__call_llm');
      if (callLlmDef) {
        callLlmDef.description += `\n\nDefault fast model for this session: ${this.config.miniModel}. Omit the model parameter to use it automatically.`;
      }
    }

    this.send({
      type: 'register_tools',
      tools: sessionToolDefs,
    });
    this.debug(`Registered ${sessionToolDefs.length} session tools with subprocess`);

    // If pool has source tools, register them with the subprocess.
    this.registerPoolToolsWithSubprocess();

  }

  /**
   * Send pool's proxy tool defs to subprocess for model visibility.
   */
  protected registerPoolToolsWithSubprocess(): void {
    if (!this.mcpPool) return;
    const proxyDefs = this.mcpPool.getProxyToolDefs();
    if (proxyDefs.length > 0) {
      this.send({
        type: 'register_tools',
        tools: proxyDefs,
      });
      this.debug(`Registered ${proxyDefs.length} MCP source tools from pool with subprocess`);
    }
  }

  /**
   * Build structured Pi auth from connection config.
   * Returns a provider-aware credential object for the subprocess,
   * or null if no piAuthProvider is configured (falls back to legacy getApiKey).
   *
   * OAuth credentials stay structured so Pi can select the provider-specific
   * bearer behavior and refresh implementation. Flattening them to api_key loses
   * refresh metadata and breaks Anthropic/OpenAI OAuth semantics.
   */
  protected async getPiAuth(): Promise<{
    provider: string;
    credential:
      | { type: 'api_key'; key: string }
      | { type: 'oauth'; access: string; refresh: string; expires: number }
      | { type: 'iam'; accessKeyId: string; secretAccessKey: string; region?: string; sessionToken?: string }
  } | null> {
    const piAuthProvider = getBackendRuntime(this.config).piAuthProvider;
    if (!piAuthProvider) return null;

    if (this.config.managedModelAccess) {
      return {
        provider: piAuthProvider,
        credential: { type: 'api_key', key: this.config.managedModelAccess.token },
      };
    }

    try {
      const credentialManager = getCredentialManager();
      const slug = this.config.connectionSlug || 'pi';

      if (this.config.authType === 'oauth') {
        const oauth = await credentialManager.getLlmOAuth(slug);
        if (oauth?.accessToken) {
          if (oauth.refreshToken) {
            this.debug(`Retrieved OAuth credential for Pi provider: ${piAuthProvider}`);
            return {
              provider: piAuthProvider,
              credential: {
                type: 'oauth',
                access: oauth.accessToken,
                refresh: oauth.refreshToken,
                expires: oauth.expiresAt ?? 0,
              },
            };
          }
          this.debug(`OAuth credential for ${piAuthProvider} has no refresh token`);
        }
      } else if (this.config.authType === 'iam_credentials') {
        // AWS IAM credentials — pass structured fields so the subprocess can
        // identify the credential type. Actual AWS env var injection happens
        // at spawn time (see spawnSubprocess) for proper process isolation.
        const iam = await credentialManager.getLlmIamCredentials(slug);
        if (iam) {
          this.debug(`Retrieved IAM credentials for Pi provider: ${piAuthProvider}`);
          return {
            provider: piAuthProvider,
            credential: {
              type: 'iam',
              accessKeyId: iam.accessKeyId,
              secretAccessKey: iam.secretAccessKey,
              region: iam.region,
              sessionToken: iam.sessionToken,
            },
          };
        }
      } else {
        // API key-based connections.
        // NOTE: authType === 'environment' (e.g. Bedrock with ~/.aws/credentials)
        // intentionally falls through here, finds no API key, and returns null.
        // The subprocess inherits process.env which contains the AWS credential chain.
        const apiKey = await credentialManager.getLlmApiKey(slug);
        if (apiKey) {
          this.debug(`Retrieved API key credential for Pi provider: ${piAuthProvider}`);
          return {
            provider: piAuthProvider,
            credential: { type: 'api_key', key: apiKey },
          };
        }
      }

      this.debug(`No credentials found for Pi provider: ${piAuthProvider}`);
      return null;
    } catch (error) {
      this.debug(`Failed to retrieve Pi auth: ${error}`);
      return null;
    }
  }

  /**
   * Build AWS environment variables from piAuth credentials for the subprocess.
   *
   * The Pi SDK's Bedrock provider reads from the AWS default credential chain
   * (env vars), not from Pi CredentialStore. We inject at spawn time so credentials
   * are scoped to the subprocess and don't leak to the main process.
   *
   * NOTE: IAM credentials (especially STS session tokens) are immutable after
   * spawn — they cannot be refreshed in a running subprocess. Long sessions
   * with temporary credentials (~1h STS tokens) will fail on expiry.
   */
  protected buildAwsEnv(
    piAuth: Awaited<ReturnType<PiAgentTransport['getPiAuth']>>,
    runtime: { piAuthProvider?: string },
  ): Record<string, string> {
    if (runtime.piAuthProvider !== 'amazon-bedrock') return {};

    const env: Record<string, string> = {};

    if (piAuth?.credential.type === 'iam') {
      env.AWS_ACCESS_KEY_ID = piAuth.credential.accessKeyId;
      env.AWS_SECRET_ACCESS_KEY = piAuth.credential.secretAccessKey;
      if (piAuth.credential.region) env.AWS_REGION = piAuth.credential.region;
      if (piAuth.credential.sessionToken) env.AWS_SESSION_TOKEN = piAuth.credential.sessionToken;
      this.debug('Injecting IAM credentials into subprocess env for AWS SDK');
    }

    // Defensive: force HTTP/1.1 for Bedrock. AWS SDK v3 defaults to HTTP/2
    // (NodeHttp2Handler) which can be incompatible with Bun/Electron runtimes.
    if (!process.env.AWS_BEDROCK_FORCE_HTTP1) {
      env.AWS_BEDROCK_FORCE_HTTP1 = '1';
    }

    return env;
  }

  /** Persist a credential rotated by Pi's ModelRuntime. */
  protected async persistOAuthCredential(
    provider: string,
    credential: { type: 'oauth'; access: string; refresh: string; expires: number },
  ): Promise<void> {
    if (this.config.authType !== 'oauth') return;

    const expectedProvider = getBackendRuntime(this.config).piAuthProvider;
    if (expectedProvider && provider !== expectedProvider) {
      this.debug(`Ignoring OAuth credential update for unexpected provider: ${provider}`);
      return;
    }

    await getCredentialManager().setLlmOAuth(this.config.connectionSlug || 'pi', {
      accessToken: credential.access,
      refreshToken: credential.refresh,
      expiresAt: credential.expires,
    });
    await this.config.onCredentialRotated?.();
    this.debug(`Persisted OAuth credential refreshed by Pi for ${provider}`);
  }

  /**
   * Retrieve API key from the credential manager for subprocess injection.
   * Legacy fallback when piAuthProvider is not set.
   * The subprocess expects a single API key string (passed via init.apiKey).
   */
  protected async getApiKey(): Promise<string | null> {
    try {
      const credentialManager = getCredentialManager();
      const slug = this.config.connectionSlug || 'pi';

      // Try LLM OAuth first (for OAuth-based connections)
      const oauth = await credentialManager.getLlmOAuth(slug);
      if (oauth?.accessToken) {
        this.debug('Retrieved API key from LLM OAuth');
        return oauth.accessToken;
      }

      // Try Anthropic API key
      const apiKey = await credentialManager.getApiKey();
      if (apiKey) {
        this.debug('Retrieved Anthropic API key');
        return apiKey;
      }

      this.debug('No API keys found for Pi agent');
      return null;
    } catch (error) {
      this.debug(`Failed to retrieve API key: ${error}`);
      return null;
    }
  }

  /**
   * Send a JSONL command to the subprocess stdin.
   */
  protected send(cmd: PiInboundMessage): void {
    if (!this.subprocess?.stdin?.writable) {
      this.debug('Cannot send to subprocess: stdin not writable');
      return;
    }
    const line = JSON.stringify(cmd);
    this.subprocess.stdin.write(line + '\n');
  }

  /**
   * Parse a JSONL line from subprocess stdout and dispatch by type.
   */
  protected handleLine(line: string): void {
    if (!line.trim()) return;

    let msg: PiOutboundMessage;
    try {
      msg = JSON.parse(line) as PiOutboundMessage;
    } catch {
      this.debug(`Invalid JSONL from subprocess: ${line.slice(0, 200)}`);
      return;
    }

    const type = msg.type;

    if (type !== 'error') {
      this.resetSubprocessErrorDedup();
    }

    switch (type) {
      case 'ready':
        if (msg.sessionId) {
          this.piSessionId = msg.sessionId as string;
          this.config.onSdkSessionIdUpdate?.(this.piSessionId!);
        }
        this.subprocessReadyResolve?.();
        break;

      case 'event':
        // Pi SDK event -- forward through PiEventAdapter
        this.handleSubprocessEvent(msg.event as Record<string, unknown>);
        break;

      case 'prompt_result':
        if (msg.id === this.activePromptId) {
          this.activePromptId = null;
          this.eventQueue.complete();
          this.onNativeTurnSettled?.();
        }
        break;

      case 'credential_update': {
        const provider = typeof msg.provider === 'string' ? msg.provider : '';
        const credential = msg.credential as {
          type?: string;
          access?: string;
          refresh?: string;
          expires?: number;
        } | undefined;
        if (
          provider
          && credential?.type === 'oauth'
          && typeof credential.access === 'string'
          && typeof credential.refresh === 'string'
          && typeof credential.expires === 'number'
        ) {
          void this.persistOAuthCredential(provider, credential as {
            type: 'oauth'; access: string; refresh: string; expires: number;
          }).catch(error => {
            this.debug(`Failed to persist Pi OAuth credential: ${error instanceof Error ? error.message : String(error)}`);
          });
        } else {
          this.debug('Ignoring malformed credential_update from subprocess');
        }
        break;
      }

      case 'pre_tool_use_request':
        // Subprocess needs permission check + transforms before tool execution
        this.handlePreToolUseRequest(msg as {
          requestId: string;
          toolName: string;
          toolCallId?: string;
          input: Record<string, unknown>;
        });
        break;

      case 'tool_execute_request':
        // Subprocess wants main process to execute a proxy tool (MCP/API/session)
        this.handleToolExecuteRequest(msg as {
          requestId: string;
          toolName: string;
          args: Record<string, unknown>;
        });
        break;

      case 'llm_query_result': {
        // Response to an llm_query request
        const id = msg.id as string;
        const pending = this.pendingLlmQueries.get(id);
        if (pending) {
          this.pendingLlmQueries.delete(id);
          const result = msg.result as LLMQueryResult | null;
          if (result) {
            pending.resolve(result);
          } else {
            const errorMessage = typeof msg.errorMessage === 'string' ? msg.errorMessage : 'llm_query failed';
            pending.reject(new Error(errorMessage));
          }
        }
        break;
      }

      case 'ensure_session_ready_result':
        // Response to an ensure_session_ready request
        this.handleEnsureSessionReadyResult(msg);
        break;

      case 'compact_result':
        // Response to a compact request
        this.handleCompactResult(msg);
        break;

      case 'rewind_user_message_result':
        this.handleRewindUserMessageResult(msg);
        break;

      case 'update_runtime_config_result':
        // Response to a runtime config refresh request
        this.handleRuntimeConfigUpdateResult(msg);
        break;

      case 'token_update_result':
        this.handleCredentialUpdateResult(msg);
        break;

      case 'session_id_update':
        // Pi session ID changed
        if (msg.sessionId) {
          this.piSessionId = msg.sessionId as string;
          this.config.onSdkSessionIdUpdate?.(this.piSessionId!);
        }
        break;

      case 'extension_notification':
        this.eventQueue.enqueue({
          type: 'info',
          message: String(msg.message || 'Extension notification'),
          level: msg.level === 'warning' || msg.level === 'error' ? msg.level : 'info',
        });
        break;

      case 'conversation_rewind_request':
        void this.handleConversationRewindRequest(msg as {
          requestId: string;
          request: ConversationRewindRequest;
        });
        break;

      case 'error': {
        const errorCode = typeof msg.code === 'string' ? msg.code : undefined;
        const rawMessage = String(msg.message || 'Unknown subprocess error');

        this.debug(`Subprocess error${errorCode ? ` (${errorCode})` : ''}: ${rawMessage}`);
        // A targeted llm_query_result follows llm_query_error and rejects only
        // that request. Other subprocess errors invalidate every pending query.
        if (errorCode !== 'llm_query_error') {
          for (const [id, pending] of this.pendingLlmQueries) {
            pending.reject(new Error(rawMessage));
            this.pendingLlmQueries.delete(id);
          }
        }

        if (errorCode === 'llm_query_error') {
          this.debug(`Ignoring ${errorCode} subprocess error in chat stream`);
          break;
        }

        // Reject pending ensure_session_ready requests (used by branch preflight)
        for (const [id, pending] of this.pendingEnsureSessionReady) {
          pending.reject(new Error(rawMessage));
          this.pendingEnsureSessionReady.delete(id);
        }

        // Reject pending compact requests
        for (const [id, pending] of this.pendingCompactions) {
          pending.reject(new Error(rawMessage));
          this.pendingCompactions.delete(id);
        }
        for (const [id, pending] of this.pendingRuntimeConfigUpdates) {
          pending.reject(new Error(rawMessage));
          this.pendingRuntimeConfigUpdates.delete(id);
        }
        for (const [id, pending] of this.pendingCredentialUpdates) {
          pending.reject(new Error(rawMessage));
          this.pendingCredentialUpdates.delete(id);
        }

        // Suppress repeated identical errors to prevent a broken subprocess
        // from flooding the user's session (e.g. EFAULT loop).
        if (rawMessage === this.lastSubprocessError) {
          this.subprocessErrorRepeatCount++;
          if (this.subprocessErrorRepeatCount > PiAgentTransport.MAX_IDENTICAL_SUBPROCESS_ERRORS) {
            this.debug(`Suppressing repeated subprocess error (${this.subprocessErrorRepeatCount}x): ${rawMessage}`);
            break;
          }
        } else {
          this.lastSubprocessError = rawMessage;
          this.subprocessErrorRepeatCount = 1;
        }

        const parsed = this.parsePiError(new Error(rawMessage));
        if (parsed.code !== 'unknown_error') {
          this.eventQueue.enqueue({ type: 'typed_error', error: parsed });
        } else {
          this.eventQueue.enqueue({
            type: 'error',
            message: `Pi subprocess error: ${rawMessage}`,
          });
        }

        // A correlated prompt_result closes failures that never started a Pi run.
        // Native runs close only on Pi's agent_settled event.
        break;
      }

      default:
        this.debug(`Unknown subprocess message type: ${type}`);
    }
  }

  /**
   * Forward a Pi SDK event from the subprocess through the event adapter.
   */
  protected handleSubprocessEvent(event: Record<string, unknown>): void {
    // The subprocess sends Pi SDK AgentSessionEvent objects serialized as JSON.
    // Feed them through PiEventAdapter to derive Product Host events.
    const eventType = event.type as string;

    // Adapt the Pi fact to renderer-visible product events.
    // The event adapter expects typed PiAgentEvent/AgentSessionEvent objects,
    // but since we're receiving plain JSON, we cast through unknown.
    for (const agentEvent of this.adapter.adaptEvent(event as any)) {
      // Track Read tool calls for prerequisite checking
      if (agentEvent.type === 'tool_start' && agentEvent.toolName === 'Read') {
        this.prerequisiteManager.trackReadTool(agentEvent.input as Record<string, unknown>);
      }
      // Reset prerequisite state on compaction (LLM loses guide content)
      if (
        agentEvent.type === 'info' &&
        (agentEvent.statusType === 'compaction_complete' || agentEvent.message.startsWith('Compacted'))
      ) {
        this.resetPrerequisiteState();
      }

      // Fire PostToolUse / PostToolUseFailure hook events (fire-and-forget)
      if (agentEvent.type === 'tool_result') {
        const hookEvent = agentEvent.isError ? 'PostToolUseFailure' : 'PostToolUse';
        this.emitAutomationEvent(hookEvent, {
          hook_event_name: hookEvent,
          tool_name: agentEvent.toolName ?? (event.toolName as string) ?? 'unknown',
          tool_input: agentEvent.input,
          ...(agentEvent.isError
            ? { error: typeof agentEvent.result === 'string' ? agentEvent.result : undefined }
            : { tool_response: typeof agentEvent.result === 'string' ? agentEvent.result : undefined }),
        });
      }

      this.eventQueue.enqueue(agentEvent);
    }

    // Pi emits agent_settled only after retries, compaction and queued
    // continuations have drained. It is the sole stream completion signal.
    if (eventType === 'agent_settled') {
      this.activePromptId = null;
      this.eventQueue.complete();
      this.onNativeTurnSettled?.();
    }
  }


  protected abstract handlePreToolUseRequest(request: {
    requestId: string;
    toolName: string;
    toolCallId?: string;
    input: Record<string, unknown>;
  }): Promise<void>;
  protected abstract handleToolExecuteRequest(request: {
    requestId: string;
    toolName: string;
    args: Record<string, unknown>;
  }): Promise<void>;
  protected abstract handleEnsureSessionReadyResult(message: Record<string, unknown>): void;
  protected abstract handleCompactResult(message: Record<string, unknown>): void;
  protected abstract handleRewindUserMessageResult(message: Record<string, unknown>): void;
  protected abstract handleConversationRewindRequest(message: {
    requestId: string;
    request: ConversationRewindRequest;
  }): Promise<void>;
  protected abstract handleRuntimeConfigUpdateResult(message: Record<string, unknown>): void;
  protected abstract handleCredentialUpdateResult(message: Record<string, unknown>): void;
  protected abstract handleSubprocessExit(code: number | null, signal: string | null): void;
  protected abstract parsePiError(error: Error): AgentError;

  protected resolvedCwd(): string {
    const workingDirectory = this.workingDirectory;
    if (workingDirectory.startsWith('~/')) return join(homedir(), workingDirectory.slice(2));
    if (workingDirectory === '~') return homedir();
    return workingDirectory;
  }
}
