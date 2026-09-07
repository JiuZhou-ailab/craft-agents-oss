// input: Persisted session fields plus live Pi, source, queue, auth, and UI runtime state
// output: The server-owned in-memory session aggregate, including the credential snapshot held by its Pi runtime
// pos: Explicit session state model separated from lifecycle orchestration

import type { PiAgent, AgentEvent, AuthRequest, PermissionMode } from '@craft-agent/shared/agent';
import { resolveBackendContext } from '@craft-agent/shared/agent/backend';
import type { ConversationRewindBoundary } from '@craft-agent/shared/agent/backend/types';
import { normalizeLlmConnectionSlug, type Workspace } from '@craft-agent/shared/config';
import type { McpClientPool } from '../mcp';
import type { FileAttachment, SendMessageOptions, Session } from '@craft-agent/shared/protocol';
import {
  getSessionPath as getSessionStoragePath,
  pickSessionFields,
  type LegacyAgentRuntime,
  type SessionHeader,
  type SessionTokenUsage,
} from '@craft-agent/shared/sessions';
import { getSourceCredentialManager, TokenRefreshManager } from '@craft-agent/shared/sources';
import type { Message, StoredAttachment, TurnMetrics } from '@craft-agent/core/types';
import { normalizeThinkingLevel, type ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels';
import {
  isFreeConversationWorkspaceId,
  loadWorkspaceConfig,
} from '@craft-agent/shared/workspaces';
import { isSourceHostGranted, resolveHostGrantedSourceSlugs, type LoadedSource } from '@craft-agent/shared/sources';
import { needsPiRuntimeMigrationSeed } from './runtime-config';
import { getSessionLog } from './session-runtime';

export type AgentInstance = PiAgent;

const PERMISSION_MODE_RANK: Record<PermissionMode, number> = {
  safe: 0,
  ask: 1,
  'allow-all': 2,
};

export function capPermissionMode(
  requested: PermissionMode | undefined,
  maximum: PermissionMode | undefined,
  fallback: PermissionMode,
): PermissionMode {
  const allowed = maximum ?? 'ask';
  const candidate = requested ?? fallback;
  return PERMISSION_MODE_RANK[candidate] <= PERMISSION_MODE_RANK[allowed]
    ? candidate
    : allowed;
}

export function resolveWorkspaceDefaultPermissionMode(
  workspace: Pick<Workspace, 'id' | 'defaultPermissionMode'>,
  globalDefault: PermissionMode,
): PermissionMode {
  return isFreeConversationWorkspaceId(workspace.id)
    ? workspace.defaultPermissionMode ?? globalDefault
    : workspace.defaultPermissionMode ?? 'ask';
}

export function intersectSourceSlugs(
  requested: readonly string[],
  allowed: readonly string[] | undefined,
): string[] {
  const allowedSet = new Set(allowed ?? []);
  return requested.filter(slug => allowedSet.has(slug));
}

export function canAutoEnableSource(
  workspace: Pick<Workspace, 'id' | 'defaultEnabledSourceRefs'>,
  currentlyEnabled: readonly string[],
  source: LoadedSource,
): boolean {
  return currentlyEnabled.includes(source.config.slug)
    || isFreeConversationWorkspaceId(workspace.id)
    || isSourceHostGranted(workspace.defaultEnabledSourceRefs, source);
}

export function filterRestoredSourceSlugs(
  workspace: Pick<Workspace, 'id' | 'defaultEnabledSourceRefs'>,
  storedSlugs: readonly string[] | undefined,
  sources: readonly LoadedSource[],
): string[] | undefined {
  if (!storedSlugs || isFreeConversationWorkspaceId(workspace.id)) return storedSlugs ? [...storedSlugs] : undefined;
  return intersectSourceSlugs(
    storedSlugs,
    resolveHostGrantedSourceSlugs(workspace.defaultEnabledSourceRefs, sources),
  );
}

export interface ManagedSession {
  id: string;
  workspace: Workspace;
  agent: AgentInstance | null;
  messages: Message[];
  isProcessing: boolean;
  /** Source files changed while the active turn held the Pi runtime lease. */
  pendingSourceReload?: boolean;
  pendingConversationRewind?: {
    token: string;
    boundary: ConversationRewindBoundary;
    revision: string;
    expiresAt: number;
  };
  rewindCommitInProgress?: boolean;
  stopRequested?: boolean;
  lastMessageAt: number;
  streamingText: string;
  processingGeneration: number;
  name?: string;
  isFlagged: boolean;
  isPinned: boolean;
  isArchived?: boolean;
  archivedAt?: number;
  permissionMode?: PermissionMode;
  previousPermissionMode?: PermissionMode;
  mcpPool?: McpClientPool;
  sdkSessionId?: string;
  needsPiMigrationSeed: boolean;
  tokenUsage?: SessionTokenUsage;
  sessionStatus?: string;
  lastReadMessageId?: string;
  hasUnread?: boolean;
  enabledSourceSlugs?: string[];
  labels?: string[];
  workingDirectory: string;
  sdkCwd?: string;
  sharedUrl?: string;
  sharedId?: string;
  model?: string;
  llmConnection?: string;
  connectionLocked?: boolean;
  thinkingLevel?: ThinkingLevel;
  systemPromptPreset?: 'default' | 'mini' | string;
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error';
  lastFinalMessageId?: string;
  turnStartFinalMessageId?: string;
  turnStartedAt?: number;
  pendingTurnMetrics?: Map<string, TurnMetrics>;
  pendingExternalMetadata?: SessionHeader;
  _metadataWriteGuardUntil?: number;
  isAsyncOperationOngoing?: boolean;
  preview?: string;
  createdAt?: number;
  messageCount?: number;
  messageQueue: Array<{
    message: string;
    attachments?: FileAttachment[];
    storedAttachments?: StoredAttachment[];
    options?: SendMessageOptions;
    messageId?: string;
    optimisticMessageId?: string;
  }>;
  backgroundShellCommands: Map<string, string>;
  backgroundTaskOutputs: Map<string, {
    outputFile: string;
    summary: string;
    status: string;
    completedAt: number;
  }>;
  messagesLoaded: boolean;
  pendingAuthRequestId?: string;
  pendingAuthRequest?: AuthRequest;
  hidden?: boolean;
  branchFromMessageId?: string;
  branchContextStrategy?: 'sdk-fork' | 'seeded-fresh-session';
  branchFromSdkSessionId?: string;
  branchFromSessionPath?: string;
  branchFromSdkCwd?: string;
  branchFromSdkTurnId?: string;
  branchSeedApplied?: boolean;
  transferredSessionSummary?: string;
  transferredSessionSummaryApplied?: boolean;
  tokenRefreshManager: TokenRefreshManager;
  triggeredBy?: { automationName?: string; event?: string; timestamp?: number };
  agentReady?: Promise<void>;
  agentReadyResolve?: () => void;
  envOverrides?: Record<string, string>;
  backendRuntimeSignature?: string;
  backendRestartSignature?: string;
  managedModelAccessToken?: string;
  credentialRestartRequired?: boolean;
  runtimeEpoch?: number;
  runtimeState?: 'invalidating' | 'deleting';
  wasInterrupted?: boolean;
}

type SdkForkState = Pick<
  ManagedSession,
  | 'branchContextStrategy'
  | 'branchFromSdkSessionId'
  | 'branchFromSessionPath'
  | 'branchFromSdkCwd'
  | 'branchFromSdkTurnId'
>;

export function consumePendingSdkFork(state: SdkForkState): boolean {
  if (state.branchContextStrategy !== 'sdk-fork') return false;
  clearSdkForkFields(state);
  return true;
}

export function clearSdkForkFields(state: SdkForkState): void {
  state.branchFromSdkSessionId = undefined;
  state.branchFromSessionPath = undefined;
  state.branchFromSdkCwd = undefined;
  state.branchFromSdkTurnId = undefined;
}

export function createManagedSessionState(
  source: {
    id: string;
    agentRuntime?: LegacyAgentRuntime;
    legacyAgentRuntime?: LegacyAgentRuntime;
  } & Partial<ManagedSession>,
  workspace: Workspace,
  overrides: Partial<ManagedSession> | undefined,
  log: (message: string) => void,
): ManagedSession {
  const raw = source as Record<string, unknown>;
  const sourceFields = Object.fromEntries(
    Object.entries(raw).filter(([, value]) => value !== undefined),
  ) as Partial<ManagedSession>;
  const legacyAgentRuntime = raw.legacyAgentRuntime ?? raw.agentRuntime;
  delete (sourceFields as Record<string, unknown>).agentRuntime;
  delete (sourceFields as Record<string, unknown>).legacyAgentRuntime;

  if ('thinkingLevel' in sourceFields) {
    const normalized = normalizeThinkingLevel(sourceFields.thinkingLevel);
    if (normalized) sourceFields.thinkingLevel = normalized;
    else delete sourceFields.thinkingLevel;
  }
  if (sourceFields.llmConnection) {
    sourceFields.llmConnection = normalizeLlmConnectionSlug(sourceFields.llmConnection);
  }

  const managed = {
    ...sourceFields,
    workspace,
    agent: null,
    messages: [],
    isProcessing: false,
    lastMessageAt: (raw.lastMessageAt ?? raw.lastUsedAt ?? Date.now()) as number,
    streamingText: '',
    processingGeneration: 0,
    isFlagged: (raw.isFlagged ?? false) as boolean,
    isPinned: (raw.isPinned ?? false) as boolean,
    messageQueue: [],
    backgroundShellCommands: new Map(),
    backgroundTaskOutputs: new Map(),
    messagesLoaded: false,
    needsPiMigrationSeed: needsPiRuntimeMigrationSeed({
      legacyAgentRuntime: legacyAgentRuntime as LegacyAgentRuntime | undefined,
      hasPiTranscript: false,
      sdkSessionId: raw.sdkSessionId as string | undefined,
      messageCount: Array.isArray(raw.messages)
        ? raw.messages.length
        : (raw.messageCount as number | undefined) ?? 0,
    }),
    tokenRefreshManager: new TokenRefreshManager(getSourceCredentialManager(), { log }),
    ...overrides,
  } as ManagedSession;

  if (
    !isFreeConversationWorkspaceId(workspace.id)
    && managed.permissionMode === 'allow-all'
    && workspace.defaultPermissionMode !== 'allow-all'
    && overrides?.permissionMode !== 'allow-all'
  ) {
    // ponytail: execute consent is process-scoped until durable per-Session
    // capability grants have a Host-owned persistence contract.
    managed.permissionMode = 'ask';
    managed.previousPermissionMode = undefined;
  }

  if (!managed.workingDirectory) {
    managed.workingDirectory = isFreeConversationWorkspaceId(workspace.id)
      ? getSessionStoragePath(workspace.rootPath, managed.id)
      : workspace.rootPath;
  }
  if (managed.branchFromMessageId && !managed.branchContextStrategy) {
    managed.branchContextStrategy = managed.branchFromSdkSessionId
      ? 'sdk-fork'
      : 'seeded-fresh-session';
  }
  if (managed.branchContextStrategy === 'seeded-fresh-session' && managed.branchSeedApplied === undefined) {
    managed.branchSeedApplied = !!managed.sdkSessionId;
  }
  return managed;
}

/**
 * Create a managed session with the standard scoped logger wired in.
 * Convenience wrapper over {@link createManagedSessionState}.
 */
export function createManagedSession(
  source: { id: string; agentRuntime?: LegacyAgentRuntime; legacyAgentRuntime?: LegacyAgentRuntime } & Partial<ManagedSession>,
  workspace: Workspace,
  overrides?: Partial<ManagedSession>,
): ManagedSession {
  return createManagedSessionState(source, workspace, overrides, message => getSessionLog().debug(message));
}

export function resolveSupportsBranching(managed: ManagedSession): boolean {
  return managed.agent?.supportsBranching ?? true;
}

export function resolveManagedConnectionSlug(managed: ManagedSession): string | undefined {
  const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath);
  return resolveBackendContext({
    sessionConnectionSlug: managed.llmConnection,
    workspaceDefaultConnectionSlug: workspaceConfig?.defaults?.defaultLlmConnection,
    managedModel: managed.model,
  }).connection?.slug
    ?? (managed.llmConnection ? normalizeLlmConnectionSlug(managed.llmConnection) : undefined);
}

export function resolveLiveAssistantBranchability(
  managed: ManagedSession,
  event: Extract<AgentEvent, { type: 'text_complete' }>,
): boolean {
  return !event.isIntermediate
    && !!event.turnId
    && resolveSupportsBranching(managed)
    && !!event.sdkTurnAnchor;
}

export function hasPersistedAssistantBranchability(messages: Message[]): boolean {
  return messages.every(message => (
    message.role !== 'assistant'
    || !!message.isIntermediate
    || typeof message.canBranch === 'boolean'
  ));
}

export const DEFAULT_TOKEN_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  contextTokens: 0,
  costUsd: 0,
};

export function managedToSession(
  managed: ManagedSession,
  overrides?: Partial<Session>,
): Session {
  return {
    ...pickSessionFields(managed),
    preview: managed.preview,
    lastMessageRole: managed.lastMessageRole,
    tokenUsage: managed.tokenUsage,
    messageCount: managed.messageCount,
    lastFinalMessageId: managed.lastFinalMessageId,
    workspaceId: managed.workspace.id,
    workspaceName: managed.workspace.name,
    messages: [],
    isProcessing: managed.isProcessing,
    sessionFolderPath: getSessionStoragePath(managed.workspace.rootPath, managed.id),
    supportsBranching: resolveSupportsBranching(managed),
    ...overrides,
  } as Session;
}
