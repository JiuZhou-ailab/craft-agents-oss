// input: Pi runtime, Product Host capabilities, and session-scoped state
// output: Public Storyflow agent API
// pos: Root agent package barrel

// Pi is Storyflow's only production agent runtime.
export type { AgentEvent } from '@craft-agent/core/types';
export * from './conversation-summary.ts';
export * from './system-prompt-preset.ts';

// Export PiAgent for direct use
export { PiAgent, PiBackend } from './pi-agent.ts';
export * from './errors.ts';

// Export runtime-neutral session callback and plan state.
export {
  registerSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
  mergeSessionScopedToolCallbacks,
  type SessionScopedToolCallbacks,
} from './session-scoped-tool-callback-registry.ts';
export type { BrowserPaneFns } from './browser-tools.ts';
export type {
  AuthRequest,
  AuthRequestType,
  AuthResult,
  CredentialAuthRequest,
  McpOAuthAuthRequest,
  GoogleOAuthAuthRequest,
  SlackOAuthAuthRequest,
  MicrosoftOAuthAuthRequest,
  CredentialInputMode,
} from '@craft-agent/session-tools-core';

// Export mode-manager - Centralized mode management
export {
  // Permission Mode API (primary)
  getPermissionMode,
  setPermissionMode,
  cyclePermissionMode,
  subscribeModeChanges,
  PERMISSION_MODE_ORDER,
  PERMISSION_MODE_CONFIG,
  type PermissionMode,
  getModeState,
  hydratePreviousPermissionMode,
  getPermissionModeDiagnostics,
  initializeModeState,
  cleanupModeState,
  // Tool blocking (centralized)
  shouldAllowToolInMode,
  blockWithReason,
  // Session state (lightweight per-message injection)
  getSessionState,
  formatSessionState,
  // Mode manager singleton (for advanced use cases)
  modeManager,
  // Default Explore mode patterns (for UI display)
  SAFE_MODE_CONFIG,
  // Types
  type ModeState,
  type ModeCallbacks,
  type ModeConfig,
  type PermissionModeChangedBy,
} from './mode-manager.ts';

// Export thinking-levels - extended reasoning configuration
export {
  type ThinkingLevel,
  type ThinkingLevelDefinition,
  THINKING_LEVELS,
  DEFAULT_THINKING_LEVEL,
  getThinkingTokens,
  getThinkingLevelNameKey,
  isValidThinkingLevel,
} from './thinking-levels.ts';

// Export permissions-config - customizable permissions per workspace/source (permissions.json)
export {
  // Parser and validation
  parsePermissionsJson,
  validatePermissionsConfig,
  PermissionsConfigSchema,
  // API endpoint checking
  isApiEndpointAllowed,
  // Storage functions
  loadWorkspacePermissionsConfig,
  loadSourcePermissionsConfig,
  getWorkspacePermissionsPath,
  getSourcePermissionsPath,
  // Raw load/save (for CLI CRUD)
  loadRawWorkspacePermissions,
  loadRawSourcePermissions,
  saveWorkspacePermissions,
  saveSourcePermissions,
  // App-level default permissions (at ~/.craft-agent/permissions/)
  getAppPermissionsDir,
  ensureDefaultPermissions,
  loadDefaultPermissions,
  // Cache singleton
  permissionsConfigCache,
  // Types
  type ApiEndpointRule,
  type CompiledApiEndpointRule,
  type PermissionsCustomConfig,
  type PermissionsConfigFile,
  type MergedPermissionsConfig,
  type PermissionsContext,
  type ActiveSourcePermissionRef,
} from './permissions-config.ts';

// Export the Storyflow Product Host layer used by PiAgent
export {
  PiAgentHost,
} from './pi-agent-host.ts';

export {
  type MiniAgentConfig,
  MINI_AGENT_TOOLS,
  MINI_AGENT_MCP_KEYS,
  type SpawnSessionRequest,
  type SpawnSessionResult,
  type SpawnSessionHelpResult,
} from './pi-agent-host-types.ts';

// Export the Pi host boundary while Pi provider adapters handle model switching.
export {
  // Types
  type AgentProvider,
  type BackendConfig,
  type PermissionCallback,
  type PlanCallback,
  type AuthCallback,
  type SourceActivationCallback,
  type ChatOptions,
  type RecoveryMessage,
  type SdkMcpServerConfig as BackendMcpServerConfig,
  // Enums
  AbortReason,
  AbortReason as BackendAbortReason,
} from './backend/index.ts';

// Export core utilities for shared agent logic
export * from './core/index.ts';

// Export browser tool name normalization helpers
export {
  LEGACY_BROWSER_TOOL_ALIASES,
  normalizeCanonicalBrowserToolName,
  normalizeBrowserToolName,
  isCanonicalBrowserToolName,
  isBrowserToolNameOrAlias,
} from './browser-tool-names.ts';

// Export PowerShell validator root setter (for Electron startup on Windows)
export { setPowerShellValidatorRoot } from './powershell-validator.ts';
