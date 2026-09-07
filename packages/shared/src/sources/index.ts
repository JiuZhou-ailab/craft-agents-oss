/**
 * Sources Module
 *
 * input: Source storage, credential, server-builder, and built-in source modules
 * output: Public source management exports for app, server, and agent packages
 * pos: Shared package entry point for external data/tool source features
 *
 * Public exports for source management.
 */

// Types
export type {
  SourceType,
  SourceMcpAuthType,
  ApiAuthType,
  ApiOperationMethod,
  ApiOperationParameterType,
  ApiOperationParameter,
  ApiSourceOperation,
  KnownProvider,
  ApiOAuthProvider,
  ApiOAuthConfig,
  McpSourceConfig,
  ApiSourceConfig,
  LocalSourceConfig,
  SourceConnectionStatus,
  FolderSourceConfig,
  SourceGuide,
  SourceDefinitionOrigin,
  LoadedSource,
  CreateSourceInput,
  ApiRenewEndpoint,
} from './types.ts';

export {
  STORYFLOW_MODEL_ACCESS_BROKER_URL_ENV,
  STORYFLOW_MODEL_ACCESS_BROKER_TOKEN_ENV,
  resolveStoryflowManagedAccess,
  createStoryflowManagedTokenGetter,
} from './managed-access.ts';
export type { StoryflowManagedAccessOptions } from './managed-access.ts';
export { getTrustedManagedSourcePolicy } from './managed-source-policy.ts';
export type { TrustedManagedSourcePolicy } from './managed-source-policy.ts';

// Constants and helpers
export {
  API_OAUTH_PROVIDERS,
  isApiOAuthProvider,
  isGenericOAuthSource,
  hasRenewEndpoint,
  isRefreshableSource,
} from './types.ts';

// Storage functions
export {
  // Directory utilities
  GLOBAL_AGENT_ROOT_DIR,
  GLOBAL_AGENT_SOURCES_DIR,
  assertSafeSourceSlug,
  ensureSourcesDir,
  getSourcePath,
  getSourceDefinitionIdentity,
  // Config operations
  loadSourceConfig,
  saveSourceConfig,
  markSourceAuthenticated,
  updateSourceConnectionState,
  // Guide operations
  loadSourceGuide,
  saveSourceGuide,
  // Icon operations
  findSourceIcon,
  downloadSourceIcon,
  sourceNeedsIconDownload,
  isIconUrl,
  // Load operations
  loadSource,
  loadWorkspaceSources,
  loadAllSources,
  getEnabledSources,
  isSourceUsable,
  getSourcesBySlugs,
  // Create/Delete operations
  generateSourceSlug,
  createSource,
  deleteSource,
  sourceExists,
  // Parsing utilities
  parseGuideMarkdown,
} from './storage.ts';

// Credential Manager (unified credential operations)
export {
  SourceCredentialManager,
  getSourceCredentialManager,
  getSourcesNeedingAuth,
} from './credential-manager.ts';
export type {
  AuthResult,
  ApiCredential,
  BasicAuthCredential,
} from './credential-manager.ts';

// Server Builder (builds MCP/API servers from sources)
export {
  SourceServerBuilder,
  getSourceServerBuilder,
  isProjectStdioExecutionAllowed,
  normalizeMcpUrl,
  SERVER_BUILD_ERRORS,
} from './server-builder.ts';
export type {
  McpServerConfig,
  SourceWithCredential,
  BuiltServers,
} from './server-builder.ts';
export {
  createSourceGrantRefs,
  getSourceGrantRef,
  isSourceHostGranted,
  resolveHostGrantedSourceSlugs,
} from './grants.ts';

// API Tools (types)
export type { SummarizeCallback } from './api-tools.ts';
export { createApiServer } from './api-tools.ts';

export {
  DEFAULT_MCP_REGISTRY_ORIGIN,
  getMcpRegistryExternalUrl,
  getMcpRegistryInstallDecision,
  parseMcpRegistryListResponse,
  parseMcpRegistryServerResponse,
} from './marketplace.ts';
export type {
  McpRegistryInstallDecision,
  McpRegistryListResponse,
  McpRegistryRemote,
  McpRegistryServer,
  McpRegistryServerResponse,
  McpRegistryStatus,
} from './marketplace.ts';
export { canonicalizeApiPath, materializeApiOperationRequest } from './api-path.ts';

// Token Refresh Manager (handles OAuth token refresh with rate limiting)
export {
  TokenRefreshManager,
  createTokenGetter,
} from './token-refresh-manager.ts';
export type {
  TokenRefreshResult,
  RefreshManagerOptions,
} from './token-refresh-manager.ts';
