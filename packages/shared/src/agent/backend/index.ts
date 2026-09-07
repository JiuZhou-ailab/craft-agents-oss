// input: Storyflow connection, authentication, and host runtime configuration
// output: Public Pi backend configuration boundary
// pos: Backend-facing agent API barrel

/**
 * Pi Runtime Configuration Boundary
 *
 * Pi owns agent execution while this module resolves Storyflow connection,
 * authentication, and host configuration into Pi inputs.
 *
 * Naming convention:
 * - PiAgent: the production unified agent runtime
 * - resolvePiAgentConfig: pure connection-to-Pi configuration resolution
 *
 * Usage:
 * ```typescript
 * import { PiAgent } from '@craft-agent/shared/agent';
 * import { resolvePiAgentConfig } from '@craft-agent/shared/agent/backend';
 * const agent = new PiAgent(resolvePiAgentConfig({ context, coreConfig, hostRuntime }));
 * ```
 */

// Core types
export type {
  AgentProvider,
  CoreBackendConfig,
  BackendConfig,
  BackendHostRuntimeContext,
  PermissionCallback,
  PlanCallback,
  AuthCallback,
  SourceActivationCallback,
  ChatOptions,
  RecoveryMessage,
  SdkMcpServerConfig,
  LlmAuthType,
  LlmProviderType,
  PostInitResult,
} from './types.ts';

// Enums need to be exported as values, not just types
export { AbortReason } from './types.ts';

// Connection and Pi runtime configuration
export {
  // LLM Connection support
  connectionAuthTypeToBackendAuthType,
  resolveSessionConnection,
  resolveBackendContext,
  resolveRequiredBackendContext,
  resolveSetupTestConnectionHint,
  resolvePiAgentConfig,
  resolveBackendHostTooling,
  fetchBackendModels,
  validateStoredBackendConnection,
  // Utilities
  resolveModelForConnection,
  cleanupSourceRuntimeArtifacts,
  testBackendConnection,
  // Connection validation
} from './connection-runtime.ts';

// Shared infrastructure
export { EventQueue } from './event-queue.ts';

// Provider-specific event adapter
export { PiEventAdapter } from './pi/event-adapter.ts';

// Pi is Storyflow's only production agent runtime.
