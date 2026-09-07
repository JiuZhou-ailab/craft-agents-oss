// input: Session registry lookups, persistence/flush pipeline, event sink adapter, watcher/metadata-guard hooks
// output: Session metadata mutations — flag/pin/archive/status/connection/rename/model/labels/thinking-level/working-dir/permission-mode/read-unread/viewing-session
// pos: Largest CRUD subdomain under the SessionManager facade; createSession/deleteSession stay in the Facade

import type { SessionEvent } from '@craft-agent/shared/protocol'
import {
  setPermissionMode,
  hydratePreviousPermissionMode,
  getPermissionModeDiagnostics,
  type PermissionMode,
} from '@craft-agent/shared/agent'
import { resolveBackendContext } from '@craft-agent/shared/agent/backend'
import type { ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import { updateSessionMetadata, type SessionStatus } from '@craft-agent/shared/sessions'
import {
  grantWorkspaceWorkingDirectory,
  isFreeConversationWorkspaceId,
  loadWorkspaceConfig,
  resolveWorkspaceWorkingDirectory,
} from '@craft-agent/shared/workspaces'
import { invalidateSkillsCache } from '@craft-agent/shared/skills'
import { invalidateContextFileCache } from '@craft-agent/shared/prompts/system'
import { canSwitchSessionModelConnection } from '@craft-agent/server-core/domain'
import { isValidWorkingDirectory } from '../utils/path-validation'
import { resolveSupportsBranching, type ManagedSession } from './managed-session'
import { getLastFinalOutputMessageId, getSessionLog } from './session-runtime'

export interface SessionCrudMetadataDeps {
  /** Registry lookup — identity-checked by callers via the shared sessions map. */
  getSession: (sessionId: string) => ManagedSession | undefined
  /** Iterate every live managed session across workspaces. */
  allSessions: () => Iterable<ManagedSession>
  persistSession: (managed: ManagedSession) => void
  flushSession: (sessionId: string) => Promise<void>
  sendEvent: (event: SessionEvent, workspaceId?: string) => void
  emitUnreadSummaryChanged: () => void
  /** Suppress fs.watch metadata-revert events around our own atomic write. */
  setMetadataWriteGuard: (managed: ManagedSession) => void
  /** Bun Linux recursive-watch workaround: nudge the workspace watcher directly. */
  notifyFileChange: (workspaceRootPath: string, relativePath: string) => void
}

export class SessionCrudMetadata {
  // Workspace -> session the user is actively viewing; gates unread marking.
  private activeViewingSession: Map<string, string> = new Map()

  constructor(private deps: SessionCrudMetadataDeps) {}

  async flagSession(sessionId: string): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      managed.isFlagged = true
      // Persist in-memory state directly to avoid race with pending queue writes
      this.deps.persistSession(managed)
      await this.deps.flushSession(managed.id)
      // Notify all windows for this workspace
      this.deps.sendEvent({ type: 'session_flagged', sessionId }, managed.workspace.id)
      // Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
      // directories created after the watcher started.
      // https://github.com/oven-sh/bun/issues/15939
      this.deps.notifyFileChange(managed.workspace.rootPath, `sessions/${sessionId}/session.jsonl`)
    }
  }

  async unflagSession(sessionId: string): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      managed.isFlagged = false
      // Persist in-memory state directly to avoid race with pending queue writes
      this.deps.persistSession(managed)
      await this.deps.flushSession(managed.id)
      // Notify all windows for this workspace
      this.deps.sendEvent({ type: 'session_unflagged', sessionId }, managed.workspace.id)
      // Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
      // directories created after the watcher started.
      // https://github.com/oven-sh/bun/issues/15939
      this.deps.notifyFileChange(managed.workspace.rootPath, `sessions/${sessionId}/session.jsonl`)
    }
  }

  async pinSession(sessionId: string): Promise<void> {
    await this.setPinned(sessionId, true)
  }

  async unpinSession(sessionId: string): Promise<void> {
    await this.setPinned(sessionId, false)
  }

  private async setPinned(sessionId: string, isPinned: boolean): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      const previous = managed.isPinned
      managed.isPinned = isPinned
      this.deps.persistSession(managed)
      try {
        await this.deps.flushSession(managed.id)
      } catch (error) {
        managed.isPinned = previous
        this.deps.persistSession(managed)
        throw error
      }
      this.deps.sendEvent({ type: isPinned ? 'session_pinned' : 'session_unpinned', sessionId }, managed.workspace.id)
      this.deps.notifyFileChange(managed.workspace.rootPath, `sessions/${sessionId}/session.jsonl`)
    }
  }

  async archiveSession(sessionId: string): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      managed.isArchived = true
      managed.archivedAt = Date.now()
      // Persist in-memory state directly to avoid race with pending queue writes
      this.deps.persistSession(managed)
      await this.deps.flushSession(managed.id)
      // Notify all windows for this workspace
      this.deps.sendEvent({ type: 'session_archived', sessionId }, managed.workspace.id)
      this.deps.emitUnreadSummaryChanged()
    }
  }

  async unarchiveSession(sessionId: string): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      managed.isArchived = false
      managed.archivedAt = undefined
      // Persist in-memory state directly to avoid race with pending queue writes
      this.deps.persistSession(managed)
      await this.deps.flushSession(managed.id)
      // Notify all windows for this workspace
      this.deps.sendEvent({ type: 'session_unarchived', sessionId }, managed.workspace.id)
      this.deps.emitUnreadSummaryChanged()
    }
  }

  async setSessionStatus(sessionId: string, sessionStatus: SessionStatus): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      managed.sessionStatus = sessionStatus
      this.deps.setMetadataWriteGuard(managed)
      // Persist in-memory state directly to avoid race with pending queue writes
      this.deps.persistSession(managed)
      await this.deps.flushSession(managed.id)
      // Notify all windows for this workspace
      this.deps.sendEvent({ type: 'session_status_changed', sessionId, sessionStatus }, managed.workspace.id)
      // Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
      // directories created after the watcher started.
      // https://github.com/oven-sh/bun/issues/15939
      this.deps.notifyFileChange(managed.workspace.rootPath, `sessions/${sessionId}/session.jsonl`)
    }
  }

  /**
   * Set the LLM connection for a session.
   * Can only be changed before the first message is sent (connection is locked after).
   * This determines which LLM provider/backend will be used for this session.
   */
  async setSessionConnection(sessionId: string, connectionSlug: string): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (!managed) {
      getSessionLog().warn(`setSessionConnection: session ${sessionId} not found`)
      throw new Error(`Session ${sessionId} not found`)
    }

    // Only allow changing connection before first message (session hasn't started)
    if (managed.messages && managed.messages.length > 0) {
      getSessionLog().warn(`setSessionConnection: cannot change connection after session has started (${sessionId})`)
      throw new Error('Cannot change connection after session has started')
    }

    // Validate connection exists
    const { getLlmConnection } = await import('@craft-agent/shared/config/storage')
    const connection = getLlmConnection(connectionSlug)
    if (!connection) {
      getSessionLog().warn(`setSessionConnection: connection "${connectionSlug}" not found`)
      throw new Error(`LLM connection "${connectionSlug}" not found`)
    }

    managed.llmConnection = connectionSlug
    // Persist in-memory state directly to avoid race with pending queue writes
    this.deps.persistSession(managed)
    await this.deps.flushSession(managed.id)
    getSessionLog().info(`Set LLM connection for session ${sessionId} to ${connectionSlug}`)

    // Notify UI that connection changed (triggers capabilities refresh)
    this.deps.sendEvent({
      type: 'connection_changed',
      sessionId,
      connectionSlug,
      supportsBranching: resolveSupportsBranching(managed),
    }, managed.workspace.id)
  }

  /**
   * Set which session the user is actively viewing.
   * Called when user navigates to a session. Used to determine whether to mark
   * new messages as unread - if user is viewing, don't mark unread.
   */
  setActiveViewingSession(sessionId: string | null, workspaceId: string): void {
    if (sessionId) {
      this.activeViewingSession.set(workspaceId, sessionId)
      // When user starts viewing a session that's not processing, clear unread
      const managed = this.deps.getSession(sessionId)
      if (managed && !managed.isProcessing && managed.hasUnread) {
        this.markSessionRead(sessionId)
      }
    } else {
      this.activeViewingSession.delete(workspaceId)
    }
  }

  /**
   * Clear active viewing session for a workspace.
   * Called when all windows leave a workspace to ensure read/unread state is correct.
   */
  clearActiveViewingSession(workspaceId: string): void {
    this.activeViewingSession.delete(workspaceId)
  }

  /**
   * Check if a session is currently being viewed by the user
   */
  isSessionBeingViewed(sessionId: string, workspaceId: string): boolean {
    return this.activeViewingSession.get(workspaceId) === sessionId
  }

  /**
   * Mark a session as read by setting lastReadMessageId and clearing hasUnread.
   * Called when user navigates to a session (and it's not processing).
   */
  async markSessionRead(sessionId: string): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (!managed) return

    // Only mark as read if not currently processing
    // (user is viewing but we want to wait for processing to complete)
    if (managed.isProcessing) return

    let needsPersist = false

    // Update lastReadMessageId for legacy/manual unread functionality
    if (managed.messages.length > 0) {
      const lastFinalId = getLastFinalOutputMessageId(managed.messages)
      if (lastFinalId && managed.lastReadMessageId !== lastFinalId) {
        managed.lastReadMessageId = lastFinalId
        needsPersist = true
      }
    }

    // Clear hasUnread flag (primary source of truth for NEW badge)
    if (managed.hasUnread) {
      managed.hasUnread = false
      needsPersist = true
    }

    // Persist changes
    if (needsPersist) {
      this.deps.persistSession(managed)
      this.deps.emitUnreadSummaryChanged()
    }
  }

  /**
   * Mark a session as unread by setting hasUnread flag.
   * Called when user manually marks a session as unread via context menu.
   */
  async markSessionUnread(sessionId: string): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      managed.hasUnread = true
      managed.lastReadMessageId = undefined
      this.deps.persistSession(managed)
      this.deps.emitUnreadSummaryChanged()
    }
  }

  /**
   * Mark all non-hidden, non-archived sessions in a workspace as read.
   * Called from "Mark All Read" context menu on "All Sessions".
   */
  async markAllSessionsRead(workspaceId: string): Promise<void> {
    let changed = false
    for (const managed of this.deps.allSessions()) {
      if (managed.workspace.id !== workspaceId) continue
      if (managed.hidden || managed.isArchived) continue
      if (managed.isProcessing) continue
      if (!managed.hasUnread) continue
      managed.hasUnread = false
      this.deps.persistSession(managed)
      changed = true
    }
    if (changed) {
      this.deps.emitUnreadSummaryChanged()
    }
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      managed.name = name
      this.deps.persistSession(managed)
      // Notify renderer of the name change
      this.deps.sendEvent({ type: 'title_generated', sessionId, title: name }, managed.workspace.id)
      // Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
      // directories created after the watcher started.
      // https://github.com/oven-sh/bun/issues/15939
      this.deps.notifyFileChange(managed.workspace.rootPath, `sessions/${sessionId}/session.jsonl`)
    }
  }

  /**
   * Update the working directory for a session.
   * Pi binds cwd when AgentSession is created, so changing it after the
   * conversation starts would split tool execution from rendered file links.
   */
  updateWorkingDirectory(sessionId: string, path: string): void {
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      if (isFreeConversationWorkspaceId(managed.workspace.id)) {
        getSessionLog().warn(`Session ${sessionId}: rejected working directory change in Free Conversations`)
        this.deps.sendEvent({
          type: 'working_directory_error',
          sessionId,
          error: 'Free Conversations use a private session directory',
        }, managed.workspace.id)
        return
      }

      const runCwdBound = managed.messages.length > 0 || !!managed.sdkSessionId || !!managed.agent
      if (runCwdBound) {
        getSessionLog().warn(`Session ${sessionId}: rejected working directory change after Pi cwd was bound`)
        this.deps.sendEvent({
          type: 'working_directory_error',
          sessionId,
          error: 'This conversation has already started. Create a new conversation to use a different working directory.',
        }, managed.workspace.id)
        return
      }

      let workingDirectory: string
      try {
        const validation = isValidWorkingDirectory(path)
        if (!validation.valid) throw new Error(validation.reason!)
        try {
          workingDirectory = resolveWorkspaceWorkingDirectory(managed.workspace, path)
        } catch {
          const granted = grantWorkspaceWorkingDirectory(managed.workspace.id, path)
          managed.workspace = granted.workspace
          workingDirectory = granted.workingDirectory
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        getSessionLog().warn(`Session ${sessionId}: rejected working directory "${path}" — ${reason}`)
        this.deps.sendEvent({
          type: 'working_directory_error',
          sessionId,
          error: reason,
        }, managed.workspace.id)
        return
      }
      managed.workingDirectory = workingDirectory

      // Invalidate filesystem caches that depend on working directory
      invalidateContextFileCache(workingDirectory)
      invalidateSkillsCache()

      this.deps.persistSession(managed)
      // Notify renderer of the working directory change
      this.deps.sendEvent({ type: 'working_directory_changed', sessionId, workingDirectory }, managed.workspace.id)
    }
  }

  /**
   * Update the model for a session
   * Pass null to clear the session-specific model (will use global config)
   * @param connection - Optional LLM connection slug. Started sessions must
   * keep the effective connection that owns their history.
   */
  async updateSessionModel(sessionId: string, workspaceId: string, model: string | null, connection?: string): Promise<void> {
    getSessionLog().info(`[updateSessionModel] sessionId=${sessionId}, model=${model}, connection=${connection}`)
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      if (connection) {
        const { getLlmConnection } = await import('@craft-agent/shared/config/storage')
        if (!getLlmConnection(connection)) {
          throw new Error(`LLM connection "${connection}" not found`)
        }
      }

      const wsConfig = loadWorkspaceConfig(managed.workspace.rootPath)
      const workspaceDefaultConnectionSlug = wsConfig?.defaults?.defaultLlmConnection
      const currentContext = resolveBackendContext({
        sessionConnectionSlug: managed.llmConnection,
        workspaceDefaultConnectionSlug,
        managedModel: managed.model,
      })
      const targetContext = resolveBackendContext({
        sessionConnectionSlug: connection ?? managed.llmConnection,
        workspaceDefaultConnectionSlug,
        managedModel: model ?? wsConfig?.defaults?.model,
      })
      const currentConnection = currentContext.connection?.slug
      const targetConnection = targetContext.connection?.slug
      const connectionLocked = !!managed.connectionLocked
        || managed.messages.length > 0
        || (managed.messageCount ?? 0) > 0
        || !!managed.sdkSessionId

      if (targetConnection && !canSwitchSessionModelConnection(
        connectionLocked,
        currentConnection,
        targetConnection,
      )) {
        getSessionLog().warn('[updateSessionModel] Cannot switch effective connection after session has started', {
          sessionId,
          currentConnection,
          targetConnection,
        })
        throw new Error('Cannot switch model connection after session has started')
      }

      const connectionChanged = !!targetConnection && targetConnection !== currentConnection
      const shouldUpdateConnection = !!targetConnection && targetConnection !== managed.llmConnection
      managed.model = model ?? undefined
      if (shouldUpdateConnection) {
        managed.llmConnection = targetConnection
      }
      const updates: { model?: string; llmConnection?: string } = { model: model ?? undefined }
      if (shouldUpdateConnection) {
        updates.llmConnection = targetConnection
      }
      await updateSessionMetadata(managed.workspace.rootPath, sessionId, updates)
      // A connection change is refreshed by getOrCreateAgent after auth is
      // reinitialized. Do not transiently apply the new model to the old runtime.
      if (managed.agent && !connectionChanged) {
        const effectiveModel = targetContext.resolvedModel
        getSessionLog().info(`[updateSessionModel] Calling agent.setModel(${effectiveModel}) [agent exists=${!!managed.agent}, connectionLocked=${managed.connectionLocked}]`)
        managed.agent.setModel(effectiveModel)
      } else {
        getSessionLog().info(`[updateSessionModel] Model and connection will apply on next agent resolution`)
      }
      // Notify renderer of the model change
      this.deps.sendEvent({ type: 'session_model_changed', sessionId, model }, managed.workspace.id)
      if (connectionChanged && targetConnection) {
        this.deps.sendEvent({
          type: 'connection_changed',
          sessionId,
          connectionSlug: targetConnection,
          supportsBranching: resolveSupportsBranching(managed),
        }, managed.workspace.id)
      }
      getSessionLog().info(`Session ${sessionId} model updated to: ${model ?? '(global config)'}`)
    }
  }

  /**
   * Set the permission mode for a session ('safe', 'ask', 'allow-all')
   */
  setSessionPermissionMode(sessionId: string, mode: PermissionMode): void {
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      const previousManagedMode = managed.permissionMode ?? 'ask'
      const diagnosticsBefore = getPermissionModeDiagnostics(sessionId)
      const previousEffectiveMode = diagnosticsBefore.permissionMode

      // No-op only when BOTH managed state and mode-manager state already match.
      // If managed state matches but diagnostics drifted, heal authoritative mode state.
      if (previousManagedMode === mode && previousEffectiveMode === mode) {
        return
      }

      if (previousManagedMode === mode && previousEffectiveMode !== mode) {
        getSessionLog().warn('Permission mode drift detected on same-mode update; reconciling authoritative mode state', {
          sessionId,
          managedMode: previousManagedMode,
          diagnosticsMode: previousEffectiveMode,
          targetMode: mode,
          modeVersion: diagnosticsBefore.modeVersion,
          changedBy: diagnosticsBefore.lastChangedBy,
        })
      }

      // Update in-memory managed mode first
      managed.permissionMode = mode

      // Reconcile mode-manager state for this specific session.
      if (previousEffectiveMode !== mode) {
        const changedBy = previousManagedMode === mode ? 'restore' : 'user'
        setPermissionMode(sessionId, mode, { changedBy })
      }

      const diagnostics = getPermissionModeDiagnostics(sessionId)
      managed.previousPermissionMode = diagnostics.previousPermissionMode
      getSessionLog().info('Permission mode changed', {
        sessionId,
        permissionMode: mode,
        modeVersion: diagnostics.modeVersion,
        changedBy: diagnostics.lastChangedBy,
        changedAt: diagnostics.lastChangedAt,
      })

      // Forward to the agent instance so backends can propagate mode changes downstream.
      if (managed.agent) {
        managed.agent.setPermissionMode(mode)
      }

      this.deps.sendEvent({
        type: 'permission_mode_changed',
        sessionId: managed.id,
        permissionMode: mode,
        modeVersion: diagnostics.modeVersion,
        changedBy: diagnostics.lastChangedBy,
        changedAt: diagnostics.lastChangedAt,
        previousPermissionMode: diagnostics.previousPermissionMode,
        transitionDisplay: diagnostics.transitionDisplay,
      }, managed.workspace.id)
      // Persist to disk
      this.deps.persistSession(managed)
    }
  }

  /**
   * Get authoritative permission mode diagnostics for a session.
   * Used by renderer to reconcile optimistic/stale mode state.
   */
  getSessionPermissionModeState(sessionId: string): {
    permissionMode: PermissionMode
    previousPermissionMode?: PermissionMode
    transitionDisplay?: string
    modeVersion: number
    changedAt: string
    changedBy: 'user' | 'system' | 'restore' | 'automation' | 'unknown'
  } | null {
    const managed = this.deps.getSession(sessionId)
    if (!managed) return null

    let diagnostics = getPermissionModeDiagnostics(sessionId)

    // Hydrate persisted transition context when mode-manager has been reset (e.g. app restart).
    if (managed.previousPermissionMode && !diagnostics.previousPermissionMode) {
      hydratePreviousPermissionMode(sessionId, managed.previousPermissionMode)
      diagnostics = getPermissionModeDiagnostics(sessionId)
    }

    // Heal restore races where mode-manager still has default state while
    // session metadata already has a persisted non-default mode.
    if (managed.permissionMode && diagnostics.permissionMode !== managed.permissionMode) {
      getSessionLog().warn('Permission mode diagnostics mismatch, reconciling to managed session mode', {
        sessionId,
        managedMode: managed.permissionMode,
        diagnosticsMode: diagnostics.permissionMode,
        modeVersion: diagnostics.modeVersion,
        changedBy: diagnostics.lastChangedBy,
      })
      setPermissionMode(sessionId, managed.permissionMode, { changedBy: 'restore' })
      if (managed.previousPermissionMode) {
        hydratePreviousPermissionMode(sessionId, managed.previousPermissionMode)
      }
      diagnostics = getPermissionModeDiagnostics(sessionId)
    }

    managed.previousPermissionMode = diagnostics.previousPermissionMode

    return {
      permissionMode: diagnostics.permissionMode,
      previousPermissionMode: diagnostics.previousPermissionMode,
      transitionDisplay: diagnostics.transitionDisplay,
      modeVersion: diagnostics.modeVersion,
      changedAt: diagnostics.lastChangedAt,
      changedBy: diagnostics.lastChangedBy,
    }
  }

  /**
   * Set labels for a session (additive tags, many-per-session).
   * Labels are IDs referencing workspace labels/config.json.
   */
  async setSessionLabels(sessionId: string, labels: string[]): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      managed.labels = labels
      this.deps.setMetadataWriteGuard(managed)

      this.deps.sendEvent({
        type: 'labels_changed',
        sessionId: managed.id,
        labels: managed.labels,
      }, managed.workspace.id)
      // Persist in-memory state directly to avoid race with pending queue writes
      this.deps.persistSession(managed)
      await this.deps.flushSession(managed.id)
      // Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
      // directories created after the watcher started.
      // https://github.com/oven-sh/bun/issues/15939
      this.deps.notifyFileChange(managed.workspace.rootPath, `sessions/${sessionId}/session.jsonl`)
    }
  }

  /**
   * Set the thinking level for a session. See {@link ThinkingLevel} for valid values.
   * This is sticky and persisted across messages.
   */
  setSessionThinkingLevel(sessionId: string, level: ThinkingLevel): void {
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      // Update thinking level in managed session
      managed.thinkingLevel = level

      // Update the agent's thinking level if it exists
      if (managed.agent) {
        managed.agent.setThinkingLevel(level)
      }

      getSessionLog().info(`Session ${sessionId}: thinking level set to ${level}`)
      // Persist to disk
      this.deps.persistSession(managed)
    }
  }
}
