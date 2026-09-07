// input: Handler-facing session lifecycle, auth, transport, and workspace contracts
// output: Provider-independent session and bound-automation execution interface consumed by RPC handlers
// pos: Dependency inversion boundary between server handlers and session orchestration

/**
 * ISessionManager — abstract interface for the session lifecycle engine.
 *
 * Handler code in server-core programs against this interface;
 * concrete implementations (Electron SessionManager, headless, etc.)
 * satisfy it at runtime.
 */

import type { Workspace, WorkspaceInfo, ActiveSessionInfo, RemoteServerConnectionInput } from '@craft-agent/core/types'
import type { StoredAttachment, AnnotationV1 } from '@craft-agent/core/types'
import type { PermissionMode } from '@craft-agent/shared/agent/mode-types'
import type { ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import type { AuthResult } from '@craft-agent/shared/agent'
import type { ManagedModelAccess } from '@craft-agent/shared/agent/backend/types'
import type {
  Session,
  SessionStatus,
  CreateSessionOptions,
  FileAttachment,
  SendMessageOptions,
  OneShotLlmRequest,
  OneShotLlmResult,
  NovelSelectionRewriteRequest,
  NovelSelectionRewriteResult,
  PermissionResponseOptions,
  CredentialResponse,
  UserQuestionResponse,
  PermissionModeState,
  UnreadSummary,
  ShareResult,
} from '@craft-agent/shared/protocol'
import type { SessionBundle, DispatchMode } from '@craft-agent/shared/sessions'
import type { EventSink } from '../transport'

export interface ISessionManager {
  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Pass a workspace id to wait only for that workspace's sessions (ADR 0013). */
  waitForInit(scopeWorkspaceId?: string | null): Promise<void>
  initialize(): Promise<void>
  cleanup(): void
  setEventSink(sink: EventSink): void
  flushAllSessions(): Promise<void>

  // ---------------------------------------------------------------------------
  // Session CRUD
  // ---------------------------------------------------------------------------

  getSessions(workspaceId?: string): Session[]
  getSession(sessionId: string): Promise<Session | null>
  /** Drop idle in-memory transcripts (renderer working-set dual). */
  releaseIdleSessionMessages(sessionId: string): Promise<boolean>
  createSession(workspaceId: string, options?: CreateSessionOptions): Promise<Session>
  deleteSession(sessionId: string): Promise<void>
  /** Atomic, non-destructive cleanup: false when content or in-flight work exists. */
  deleteEmptySession(sessionId: string): Promise<boolean>
  rewindUserMessage(
    sessionId: string,
    userMessageId: string,
  ): Promise<{ draftText: string }>

  // ---------------------------------------------------------------------------
  // Session state
  // ---------------------------------------------------------------------------

  flagSession(sessionId: string): Promise<void>
  unflagSession(sessionId: string): Promise<void>
  pinSession(sessionId: string): Promise<void>
  unpinSession(sessionId: string): Promise<void>
  archiveSession(sessionId: string): Promise<void>
  unarchiveSession(sessionId: string): Promise<void>
  renameSession(sessionId: string, name: string): Promise<void>
  setSessionStatus(sessionId: string, status: SessionStatus): Promise<void>
  markSessionRead(sessionId: string): Promise<void>
  markSessionUnread(sessionId: string): Promise<void>
  markAllSessionsRead(workspaceId: string): Promise<void>
  setActiveViewingSession(sessionId: string | null, workspaceId: string): Promise<void>
  clearActiveViewingSession(workspaceId: string): void

  // ---------------------------------------------------------------------------
  // Session configuration
  // ---------------------------------------------------------------------------

  setSessionPermissionMode(sessionId: string, mode: PermissionMode): Promise<void>
  setSessionThinkingLevel(sessionId: string, level: ThinkingLevel): Promise<void>
  updateWorkingDirectory(sessionId: string, path: string): Promise<void>
  setSessionSources(sessionId: string, sourceSlugs: string[]): Promise<void>
  setSessionLabels(sessionId: string, labels: string[]): Promise<void>
  setSessionConnection(sessionId: string, connectionSlug: string): Promise<void>
  updateSessionModel(sessionId: string, workspaceId: string, model: string | null, connection?: string): Promise<void>

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  sendMessage(
    sessionId: string,
    message: string,
    attachments?: FileAttachment[],
    storedAttachments?: StoredAttachment[],
    options?: SendMessageOptions,
    existingMessageId?: string | null,
    onAck?: (messageId: string) => void,
  ): Promise<void>
  queryOnce(sessionId: string, request: OneShotLlmRequest): Promise<OneShotLlmResult>
  rewriteNovelSelection(sessionId: string, request: NovelSelectionRewriteRequest): Promise<NovelSelectionRewriteResult>
  cancelProcessing(sessionId: string, silent?: boolean): Promise<void>
  sendQueuedMessageNow(sessionId: string, messageId: string): Promise<void>
  removeQueuedMessage(sessionId: string, messageId: string): Promise<void>
  killShell(sessionId: string, shellId: string): Promise<{ success: boolean; error?: string }>
  getTaskOutput(taskId: string): Promise<string | null>
  addMessageAnnotation(sessionId: string, messageId: string, annotation: AnnotationV1): Promise<void>
  removeMessageAnnotation(sessionId: string, messageId: string, annotationId: string): Promise<void>
  updateMessageAnnotation(
    sessionId: string,
    messageId: string,
    annotationId: string,
    patch: Partial<AnnotationV1>,
  ): Promise<void>

  // ---------------------------------------------------------------------------
  // Permissions & credentials
  // ---------------------------------------------------------------------------

  respondToPermission(
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: PermissionResponseOptions,
  ): boolean
  respondToUserQuestion(sessionId: string, requestId: string, response: UserQuestionResponse): boolean
  respondToCredential(sessionId: string, requestId: string, response: CredentialResponse): Promise<boolean>
  getSessionPermissionModeState(sessionId: string): PermissionModeState | null

  // ---------------------------------------------------------------------------
  // Plans
  // ---------------------------------------------------------------------------

  setPendingPlanExecution(sessionId: string, planPath: string, draftInputSnapshot?: string): Promise<void>
  markPendingPlanExecutionDispatched(sessionId: string): Promise<void>
  clearPendingPlanExecution(sessionId: string): Promise<void>
  getPendingPlanExecution(sessionId: string): { planPath: string; draftInputSnapshot?: string; awaitingCompaction: boolean; executionDispatched: boolean } | null
  markCompactionComplete(sessionId: string): Promise<void>

  /**
   * Send the plan-approval "I approve this plan, please execute it" message
   * to the session as if the user had clicked "Accept plan" in the desktop UI.
   * If the session is in Explore (safe) mode, also switches it to allow-all
   * so the plan can actually run without per-tool prompts.
   *
   * Used by the messaging gateway so Telegram/WhatsApp accept buttons produce
   * the same server-side effect as the desktop accept button.
   */
  acceptPlan(sessionId: string, planPath?: string): Promise<void>

  // ---------------------------------------------------------------------------
  // Sharing
  // ---------------------------------------------------------------------------

  shareToViewer(sessionId: string): Promise<ShareResult>
  updateShare(sessionId: string): Promise<ShareResult>
  revokeShare(sessionId: string): Promise<ShareResult>

  // ---------------------------------------------------------------------------
  // Export / Import
  // ---------------------------------------------------------------------------

  /**
   * Export a session as a portable bundle.
   * Flushes pending writes, serializes session data + files.
   * Session must be stopped before export.
   */
  exportSession(sessionId: string, workspaceId: string): Promise<SessionBundle | null>

  /**
   * Export a session as a summary-based payload for cross-server transfer.
   * Generates a mini-model summary instead of shipping the full transcript.
   */
  exportRemoteSessionTransfer(
    sessionId: string,
    workspaceId: string,
  ): Promise<import('@craft-agent/shared/protocol').RemoteSessionTransferPayload | null>

  /**
   * Import a session bundle into a target workspace.
   * Creates session directory, writes JSONL + files, registers in memory.
   * Returns the new session ID and any compatibility warnings.
   */
  importSession(
    workspaceId: string,
    bundle: SessionBundle,
    mode: DispatchMode,
  ): Promise<{ sessionId: string; warnings?: string[] }>

  /**
   * Import a summary-based remote transfer payload into a target workspace.
   */
  importRemoteSessionTransfer(
    workspaceId: string,
    payload: import('@craft-agent/shared/protocol').RemoteSessionTransferPayload,
  ): Promise<{ sessionId: string }>

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  getSessionPath(sessionId: string): string | null
  withSessionPathOperation<T>(
    sessionId: string,
    work: (sessionPath: string) => Promise<T>,
  ): Promise<T>
  reloadSessions(workspaceId?: string): Promise<void>
  refreshTitle(sessionId: string): Promise<{ success: boolean; title?: string; error?: string }>
  refreshBadge(): void
  getUnreadSummary(): UnreadSummary

  // ---------------------------------------------------------------------------
  // Workspace
  // ---------------------------------------------------------------------------

  getWorkspaces(): Workspace[]
  /** Return client-safe workspace list (no rootPath) for remote clients. */
  getWorkspacesInfo(): WorkspaceInfo[]
  /** Register, index, observe, and activate one Project under its lifecycle lock. */
  registerProject(
    name: string,
    rootPath: string,
    remoteServer?: RemoteServerConnectionInput,
  ): Promise<Workspace>
  /** Resolve and start local observers atomically with Project removal/relink. */
  activateProject(projectId: string): Promise<Workspace>
  /** Reconnect an existing remote Project without racing Host lifecycle commits. */
  updateRemoteProject(projectId: string, remoteServer: RemoteServerConnectionInput): Promise<void>
  /** Dispose runtime state, then remove only the Host registration and private cache. */
  removeWorkspace(projectId: string): Promise<boolean>
  /** Stage idle Sessions at a validated target, then atomically commit the Host locator. */
  rebindWorkspaceRoot(projectId: string, currentRoot: string): Promise<Workspace>
  /** Serialize Host-owned executable settings with Project remove/relink/create. */
  updateProjectHostSetting(
    projectId: string,
    key: 'permissionMode' | 'enabledSourceSlugs' | 'localMcpEnabled' | 'automationsEnabled',
    value: unknown,
  ): Promise<void>
  /** Run a Project-root mutation against the current locator under the shared lifecycle lock. Callback must not re-enter Project lifecycle methods. */
  withProjectLifecycle<T>(
    projectId: string,
    work: (workspace: Workspace) => Promise<T>,
  ): Promise<T>
  /** Retain the current Project locator for lock-free work; lifecycle transitions drain accepted operations before commit. */
  withProjectOperation<T>(
    projectId: string,
    work: (workspace: Workspace) => Promise<T>,
  ): Promise<T>
  /** Block new Project operations, drain accepted work, then run lock-free exclusive work. Callback must not re-enter Project lifecycle methods. */
  withProjectExclusiveOperation<T>(
    projectId: string,
    work: (workspace: Workspace) => Promise<T>,
  ): Promise<T>
  /** Re-apply persisted Host Source grants to cached Sessions and live runtimes. */
  reconcileProjectSourceGrants(projectId: string): Promise<void>
  setupConfigWatcher(workspaceRootPath: string, workspaceId: string): void
  /**
   * Manually notify the ConfigWatcher of a file change.
   * Workaround for Bun's fs.watch on Linux not detecting atomic renames.
   */
  notifyConfigFileChange(workspaceRootPath: string, relativePath: string): void

  // ---------------------------------------------------------------------------
  // Server-level observability
  // ---------------------------------------------------------------------------

  /** Count of sessions with active backend processes. Pass workspaceId to scope. */
  getActiveSessionCount(workspaceId?: string): number
  /** Automation summary for a workspace (count of configured automations + scheduler state). */
  getWorkspaceAutomationSummary(workspaceId: string): { automationCount: number; schedulerRunning: boolean }
  /** Active sessions across all workspaces (sessions with running backend processes). */
  getActiveSessionsInfo(): ActiveSessionInfo[]

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  reinitializeAuth(connectionSlug?: string): Promise<void>
  /**
   * Push runtime updates (e.g. capability toggles) to every active session
   * that uses the given connection. Backstopped by the lazy refresh path in
   * `getOrCreateAgent`.
   */
  refreshConnectionRuntime(connectionSlug: string): Promise<void>
  reloadConnectionCredentials(
    connectionSlug: string,
    managedModelAccess?: ManagedModelAccess,
  ): Promise<void>
  completeAuthRequest(sessionId: string, result: AuthResult): Promise<void>
  executePromptAutomation(input: ExecutePromptAutomationInput): Promise<{ sessionId: string }>

  /**
   * Install a callback invoked from `executePromptAutomation` after a session
   * is created when the matcher declared `telegramTopic`. Wired by the
   * messaging-gateway bootstrap so the SessionManager doesn't need to import
   * the messaging package (avoids a circular package-level import).
   *
   * The callback should be best-effort: failures must not block the session.
   */
  setAutomationBinder?(
    fn: (input: { workspaceId: string; sessionId: string; topicName: string }) => Promise<void>,
  ): void
}

/**
 * Input for executePromptAutomation. Options-object form replaces the
 * previous positional-args signature once the param list grew past
 * readability — new optional fields (thinkingLevel, future cwd/permissions
 * overrides) can be added without churn at every call site.
 */
export interface ExecutePromptAutomationInput {
  /** Reuse this conversation; missing/archived/foreign targets fail without creating a replacement. */
  sessionId?: string
  workspaceId: string
  workspaceRootPath: string
  prompt: string
  labels?: string[]
  permissionMode?: PermissionMode
  mentions?: string[]
  llmConnection?: string
  model?: string
  /** Override the workspace default thinking level for the spawned session. */
  thinkingLevel?: ThinkingLevel
  automationName?: string
  /**
   * Optional Telegram forum-topic name. When set and the workspace has a
   * paired supergroup, the new session is bound to a topic of this name
   * (created on first use). Silently ignored when prerequisites aren't met.
   */
  telegramTopic?: string
}
