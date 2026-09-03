// input: Shared backend providers, source configs, session context, and workspace state
// output: Type contracts for agent backend implementations and runtime updates
// pos: Provider-agnostic backend boundary for shared agent orchestration

/**
 * Backend Abstraction Types
 *
 * Defines the core interface implemented by the Pi agent runtime. Provider
 * switching happens inside Pi while CraftAgent keeps one stable API surface.
 *
 * Key design decisions:
 * - Provider-agnostic events: All backends emit the same AgentEvent types
 * - Capabilities-driven UI: Model/thinking selectors read from capabilities()
 * - Callback pattern: Facade sets callbacks after creating backend
 * - AsyncGenerator for streaming: Consistent with existing CraftAgent API
 */

import type { ThinkingLevel } from '../thinking-levels.ts';
import type { LoadedSource } from '../../sources/types.ts';
import type { AuthRequest } from '@craft-agent/session-tools-core';
import type { McpClientPoolLike } from '../../mcp/types.ts';
import type { Workspace } from '../../config/storage.ts';
import type { SessionConfig as Session } from '../../sessions/storage.ts';
import type { SystemPromptPreset } from '../../prompts/system.ts';

import type { RecoveryMessage } from '../core/types.ts';
export type { RecoveryMessage };

/** Why Product Host control interrupted the active Pi turn. */
export enum AbortReason {
  UserStop = 'user_stop',
  PlanSubmitted = 'plan_submitted',
  AuthRequest = 'auth_request',
  Redirect = 'redirect',
  Timeout = 'timeout',
  InternalError = 'internal_error',
}

import type { ModelProvider, ModelThinkingLevelMap } from '../../config/models.ts';

// Import LLM connection types for auth
import type { CustomEndpointConfig, LlmAuthType, LlmProviderType } from '../../config/llm-connections.ts';
export type { LlmAuthType, LlmProviderType } from '../../config/llm-connections.ts';

export interface BackendRuntimeUpdate {
  model: string;
  providerType?: LlmProviderType;
  authType?: LlmAuthType;
  runtime?: {
    baseUrl?: string;
    piAuthProvider?: string;
    customEndpoint?: CustomEndpointConfig;
    customModels?: Array<string | {
      id: string;
      contextWindow?: number;
      supportsImages?: boolean;
      supportsThinking?: boolean;
      thinkingLevelMap?: ModelThinkingLevelMap;
    }>;
    [key: string]: unknown;
  };
}

export type ConversationRewindBoundary = {
  retainThroughMessageId: string | null;
  draftText?: string;
};

export type ConversationRewindRequest =
  | { phase: 'prepare'; boundary: ConversationRewindBoundary }
  | { phase: 'commit'; token: string; expectedRevision: string }
  | { phase: 'abort'; token: string };

export type ConversationRewindResult =
  | { phase: 'prepared'; token: string; revision: string }
  | { phase: 'committed' | 'aborted' };

/** Ephemeral Storyflow-managed model capability supplied by the host. */
export interface ManagedModelAccess {
  token: string;
}
import type { AutomationSystem } from '../../automations/index.ts';

/**
 * Provider identifier for AI backends.
 * @deprecated Use ModelProvider from config/models.ts instead
 */
export type AgentProvider = ModelProvider;


// ============================================================
// Callback Types
// ============================================================

/**
 * Permission prompt types for different tool categories.
 */
export type PermissionRequestType = 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval';

/**
 * Permission request callback signature.
 * Called when a tool requires user permission before execution.
 */
export type PermissionCallback = (request: {
  requestId: string;
  toolName: string;
  command?: string;
  description: string;
  type?: PermissionRequestType;
  appName?: string;
  reason?: string;
  impact?: string;
  requiresSystemPrompt?: boolean;
  rememberForMinutes?: number;
  commandHash?: string;
  approvalTtlSeconds?: number;
}) => void;

/**
 * Plan submission callback signature.
 * Called when agent submits a plan for user review.
 */
export type PlanCallback = (planPath: string) => void | Promise<void>;

/**
 * Auth request callback signature.
 * Called when a source requires authentication.
 */
export type AuthCallback = (request: AuthRequest) => void;

/**
 * Source activation request callback.
 * Returns true if source was successfully activated.
 */
export type SourceActivationCallback = (sourceSlug: string) => Promise<boolean>;

// ============================================================
// Lifecycle Types
// ============================================================

/**
 * Result of backend post-initialization (auth injection, config setup).
 * Returned by postInit() so the session layer can surface warnings.
 */
export interface PostInitResult {
  /** Whether auth credentials were successfully injected */
  authInjected: boolean;
  /** Optional warning message to surface in UI */
  authWarning?: string;
  /** Severity level for the warning */
  authWarningLevel?: 'error' | 'warning' | 'info';
}

/**
 * Context for applying source runtime updates mid-session.
 * Used when sources change, tokens refresh, or auth completes.
 */
export interface BridgeUpdateContext {
  /** Path to the session folder */
  sessionPath: string;
  /** Currently enabled sources */
  enabledSources: LoadedSource[];
  /** Pre-built MCP server configs */
  mcpServers: Record<string, SdkMcpServerConfig>;
  /** Session ID */
  sessionId: string;
  /** Workspace root path */
  workspaceRootPath: string;
  /** Descriptive context for logging (e.g., 'token refresh', 'source enable') */
  context: string;
}

/**
 * Host runtime context passed from the application shell (Electron/CLI/etc.).
 * This is intentionally provider-agnostic metadata; backend drivers resolve
 * provider-specific paths from this context internally.
 */
export interface BackendHostRuntimeContext {
  /** App root path (packaged app path or repository root in development) */
  appRootPath: string;
  /** Optional resources path (needed for packaged Windows runtime resolution) */
  resourcesPath?: string;
  /** Whether the host app is running as a packaged build */
  isPackaged: boolean;
  /** Optional runtime override for Node/Bun executable */
  nodeRuntimePath?: string;
}

/**
 * Provider-agnostic backend configuration used by the session layer.
 * Provider-specific runtime details are resolved by backend drivers internally.
 */
export interface CoreBackendConfig {
  /** Workspace configuration */
  workspace: Workspace;

  /** Project resource overlay root. Absent for application-owned runtimes. */
  projectRoot?: string;

  /**
   * Optional filesystem boundary for application-owned runtimes.
   * Project runtimes retain their existing permission behavior.
   */
  fileAccessBoundary?: {
    readRoots: readonly string[];
    writeRoots: readonly string[];
    blockBash?: boolean;
  };

  /** Session configuration (for resume) */
  session?: Session;

  /** Host-owned final cwd authorization, invoked immediately before Pi subprocess spawn. */
  validateWorkingDirectory?: (path: string) => string;

  /** Initial model ID */
  model?: string;

  /** Mini/utility model for summarization/title generation/mini-completions */
  miniModel?: string;

  /** Initial thinking level */
  thinkingLevel?: ThinkingLevel;

  /** Host-owned managed model access. It is process memory, never provider credential storage. */
  managedModelAccess?: ManagedModelAccess;

  /** Headless mode flag (disables interactive tools) */
  isHeadless?: boolean;

  /** Debug mode configuration */
  debugMode?: {
    enabled: boolean;
    logFilePath?: string;
  };

  /** System prompt preset ('default' | 'mini' | 'novel' | custom string) */
  systemPromptPreset?: SystemPromptPreset | string;

  /** Workspace-level automation system for user-defined automations (automations.json) */
  automationSystem?: AutomationSystem;

  /**
   * Per-session environment variable overrides for the agent subprocess.
   * Spread after process.env in backend-specific option builders.
   */
  envOverrides?: Record<string, string>;

  /**
   * Centralized MCP client pool for source tool execution.
   * Owns all MCP source connections in the main process.
   */
  mcpPool?: McpClientPoolLike;

  /** Callback when SDK session ID is captured/updated */
  onSdkSessionIdUpdate?: (sdkSessionId: string) => void;

  /** Callback when SDK session ID is cleared (e.g., after failed resume) */
  onSdkSessionIdCleared?: () => void;

  /** Reserve, commit, or abort one Pi-owned rewind against the product transcript. */
  onConversationRewind?: (
    request: ConversationRewindRequest,
  ) => Promise<ConversationRewindResult>;

  /** Fan out a Pi-rotated credential after the product store accepts it. */
  onCredentialRotated?: () => Promise<void>;

  /**
   * Called when the agent decides the persisted branch-fork metadata
   * (branchFromSdkSessionId / branchFromSdkCwd / branchFromSdkTurnId) is
   * unrecoverable on this machine — typically because the parent's sdk cwd
   * doesn't exist locally (cross-machine session import) or the SDK fork
   * spawn failed before establishing a child session.
   *
   * Implementations MUST clear all four fields (including sdkSessionId)
   * atomically and persist. `onSdkSessionIdCleared` is insufficient because
   * it only clears sdkSessionId — branch fields would reload from disk
   * on next launch and re-trigger the failure.
   */
  onBranchForkInvalidated?: () => void;

  /** Callback to get recent messages for recovery context */
  getRecoveryMessages?: () => RecoveryMessage[];

  /** Seed one fresh Pi transcript from recent persisted messages during runtime migration. */
  seedFreshSessionFromRecovery?: boolean;

  /**
   * Get ALL parent messages for branch fork fallback (not limited to 6).
   * Called when SDK-level branch fork fails and we need to summarize
   * the parent conversation for context injection via mini completion.
   * Returns empty array for non-branched sessions.
   */
  getBranchFallbackMessages?: () => RecoveryMessage[];

  /**
   * Callback to get branch seed messages (up to branch cutoff) for first turn in seeded branch mode.
   * When provided and non-empty, PiAgentHost injects a hidden context block before the first user turn.
   */
  getBranchSeedMessages?: () => RecoveryMessage[];

  /** Callback invoked after branch seed context has been injected. */
  markBranchSeedApplied?: () => void;

  /** One-shot hidden summary to inject on the first turn of a transferred session. */
  getTransferredSessionSummary?: () => string | null;

  /** Callback invoked after transferred session summary has been injected. */
  markTransferredSessionSummaryApplied?: () => void;

  /**
   * Optional callback to resize an oversized image for API compatibility.
   * Called from PreToolUse when Read targets an image exceeding the base64 size limit.
   * Returns path to the resized temp file, or null if resize not possible.
   * Provided by the host app (Electron uses nativeImage, server could use sharp, etc.).
   */
  onImageResize?: (filePath: string, maxSizeBytes: number) => Promise<string | null>;

  /** Enable 1M context window for Opus 4.7. Default: true. Set false to use 200K and conserve usage limits. */
  enable1MContext?: boolean;

  /**
   * Pre-computed source configurations for initial setup.
   * Passed at construction so backends can set up sources in postInit().
   */
  initialSources?: {
    enabledSources: LoadedSource[];
    mcpServers: Record<string, SdkMcpServerConfig>;
    apiServers: Record<string, unknown>;
    enabledSlugs: string[];
  };
}

// ============================================================
// Backend Interface
// ============================================================

/**
 * Options for the chat method.
 */
export interface ChatOptions {
  /** Retry flag (internal use for session recovery) */
  isRetry?: boolean;
  /** 1-based count of user messages in the session, including the current user message */
  userIteration?: number;
  /** Override thinking level for this message only */
  thinkingOverride?: ThinkingLevel;
  /** Runtime context for this turn only. Backends must not persist it in conversation history. */
  oneTimeContext?: string;
  /** Host-owned policy for this turn only. Backends must apply it as system context. */
  turnPolicy?: string;
  /** Product transcript boundary paired with the Pi user entry for safe tree rewind. */
  rewindBoundary?: {
    visibleUserMessageId?: string;
    retainThroughMessageId: string | null;
    draftText?: string;
  };
}

/**
 * SDK-compatible MCP server configuration.
 * Defined in the mcp subdomain (single source of truth); re-exported here
 * for the backend contract surface.
 */
import type { SdkMcpServerConfig } from '../../mcp/types.ts';
export type { SdkMcpServerConfig };

/**
 * Configuration for creating a backend.
 */
export interface BackendConfig extends CoreBackendConfig {
  /**
   * Full provider type from LLM connection.
   * Includes compat variants and cloud providers.
   * Used for routing validation, credential lookup, etc.
   */
  providerType?: LlmProviderType;

  /**
   * Authentication mechanism from LLM connection.
   * Determines how credentials are retrieved and passed to the backend.
   */
  authType?: LlmAuthType;

  /** MCP token override (for testing) */
  mcpToken?: string;

  /**
   * Connection slug for credential routing.
   * Set by factory when creating from a connection.
   * Used to read/write credentials under the correct key.
   */
  connectionSlug?: string;

  /** Workspace-level automation system for user-defined SDK hooks (automations.json) */
  automationSystem?: AutomationSystem;

  /**
   * Opaque runtime payload resolved by backend drivers.
   * This keeps provider-specific runtime details out of the public config surface.
   */
  runtime?: Record<string, unknown>;
}
