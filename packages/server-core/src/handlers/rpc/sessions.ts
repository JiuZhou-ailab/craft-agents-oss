// input: Session RPC requests, session manager state, filesystem session folders, and transport clients
// output: Registered session lifecycle, message, file tree, notes, and watcher RPC handlers
// pos: Server-side session RPC boundary shared by Electron and server runtimes

import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { RPC_CHANNELS, type FileAttachment, type NovelSelectionRewriteRequest, type SendMessageOptions, type SessionEvent, type SessionFile, type SessionRewindResult } from '@craft-agent/shared/protocol'
import type { StoredAttachment } from '@craft-agent/core/types'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { perf } from '@craft-agent/shared/utils'
import { isValidThinkingLevel, THINKING_LEVEL_IDS } from '@craft-agent/shared/agent/thinking-levels'

const VALID_THINKING_LEVELS_LIST = THINKING_LEVEL_IDS.map(id => `'${id}'`).join(', ')
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { setTransferableHandler } from './transfer'

interface ClientSessionWatchState {
  watcher: import('fs').FSWatcher
  sessionId: string
  debounceTimer: ReturnType<typeof setTimeout> | null
}

// Per-client session file watcher state (supports concurrent windows/clients safely)
const clientSessionWatches = new Map<string, ClientSessionWatchState>()

const SESSION_GET_LOG_ID_LIMIT = 25
const SESSION_FILE_TREE_MAX_ENTRIES = 500
const SESSION_FILE_WATCH_DEBOUNCE_MS = 500

function summarizeIds(ids: Iterable<string>, limit = SESSION_GET_LOG_ID_LIMIT) {
  const all = Array.from(ids)
  return {
    count: all.length,
    ids: all.slice(0, limit),
    truncated: all.length > limit,
  }
}

function sessionWorkspaceDistribution(sessions: Array<{ workspaceId?: string }>): Record<string, number> {
  const distribution: Record<string, number> = {}
  for (const session of sessions) {
    const key = session.workspaceId || '(missing)'
    distribution[key] = (distribution[key] ?? 0) + 1
  }
  return distribution
}

/**
 * Clean up session file watcher for a client.
 * Called from main process disconnect hooks to prevent watcher leaks.
 */
export function cleanupSessionFileWatchForClient(clientId: string): void {
  const state = clientSessionWatches.get(clientId)
  if (!state) return

  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer)
    state.debounceTimer = null
  }

  state.watcher.close()
  clientSessionWatches.delete(clientId)
}

// Recursive directory scanner for session files.
// ponytail: capped eager tree; switch to lazy child loading if users need huge session trees.
async function scanSessionDirectory(
  dirPath: string,
  budget = { remaining: SESSION_FILE_TREE_MAX_ENTRIES },
): Promise<SessionFile[]> {
  const { readdir, stat } = await import('fs/promises')
  const entries = await readdir(dirPath, { withFileTypes: true })
  const files: SessionFile[] = []

  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  for (const entry of entries) {
    // Skip internal and hidden files
    if (entry.name === 'session.jsonl' || entry.name.startsWith('.')) continue
    if (budget.remaining <= 0) break

    const fullPath = join(dirPath, entry.name)
    budget.remaining -= 1

    if (entry.isDirectory()) {
      // Recursively scan subdirectory
      const children = await scanSessionDirectory(fullPath, budget)
      // Only include non-empty directories
      if (children.length > 0) {
        files.push({
          name: entry.name,
          path: fullPath,
          type: 'directory',
          children,
        })
      }
    } else {
      const stats = await stat(fullPath)
      files.push({
        name: entry.name,
        path: fullPath,
        type: 'file',
        size: stats.size,
      })
    }
  }

  // Sort: directories first, then alphabetically
  return files.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.sessions.GET,
  RPC_CHANNELS.sessions.LIST_BY_WORKSPACE,
  RPC_CHANNELS.sessions.GET_UNREAD_SUMMARY,
  RPC_CHANNELS.sessions.MARK_ALL_READ,
  RPC_CHANNELS.sessions.CREATE,
  RPC_CHANNELS.sessions.DELETE,
  RPC_CHANNELS.sessions.REWIND,
  RPC_CHANNELS.sessions.GET_MESSAGES,
  RPC_CHANNELS.sessions.RELEASE_MESSAGES,
  RPC_CHANNELS.sessions.SEND_MESSAGE,
  RPC_CHANNELS.sessions.REWRITE_NOVEL_SELECTION,
  RPC_CHANNELS.sessions.CANCEL,
  RPC_CHANNELS.sessions.KILL_SHELL,
  RPC_CHANNELS.tasks.GET_OUTPUT,
  RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION,
  RPC_CHANNELS.sessions.RESPOND_TO_USER_QUESTION,
  RPC_CHANNELS.sessions.RESPOND_TO_CREDENTIAL,
  RPC_CHANNELS.sessions.COMMAND,
  RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION,
  RPC_CHANNELS.sessions.GET_PERMISSION_MODE_STATE,
  RPC_CHANNELS.sessions.SEARCH_CONTENT,
  RPC_CHANNELS.sessions.GET_FILES,
  RPC_CHANNELS.sessions.GET_NOTES,
  RPC_CHANNELS.sessions.SET_NOTES,
  RPC_CHANNELS.sessions.WATCH_FILES,
  RPC_CHANNELS.sessions.UNWATCH_FILES,
  RPC_CHANNELS.sessions.EXPORT,
  RPC_CHANNELS.sessions.IMPORT,
  RPC_CHANNELS.sessions.EXPORT_REMOTE_TRANSFER,
  RPC_CHANNELS.sessions.IMPORT_REMOTE_TRANSFER,
] as const

export function registerSessionsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { sessionManager, platform } = deps
  const log = platform.logger

  // Get all sessions for the calling window's workspace
  // Waits for initialization to complete so sessions are never returned empty during startup
  server.handle(RPC_CHANNELS.sessions.GET, async (ctx) => {
    const windowWorkspaceId = ctx.webContentsId != null
      ? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId)
      : undefined
    const workspaceId = windowWorkspaceId ?? ctx.workspaceId
    // Scoped failures are surfaced instead of presenting partial history as empty.
    await sessionManager.waitForInit(workspaceId)
    const end = perf.start('rpc.getSessions')
    const sessions = sessionManager.getSessions(workspaceId ?? undefined)
    end()

    log.debug('[sessions:get] result', {
      ctxWorkspaceId: ctx.workspaceId,
      webContentsId: ctx.webContentsId,
      windowWorkspaceId,
      resolvedWorkspaceId: workspaceId,
      returnedCount: sessions.length,
      returnedWorkspaceIds: sessionWorkspaceDistribution(sessions),
      returnedIds: summarizeIds(sessions.map(s => s.id)),
    })

    return sessions
  })

  // Session lists are always scoped to one runtime workspace (ADR 0006).
  // Unlike GET, which infers the workspace from the calling window, this takes
  // the workspace explicitly so a surface can render a workspace it is not
  // currently running — e.g. the rail listing Free Conversations while a
  // project is open. It still cannot ask for more than one workspace at a time.
  server.handle(RPC_CHANNELS.sessions.LIST_BY_WORKSPACE, async (_ctx, workspaceId: string) => {
    if (!workspaceId) {
      throw new Error('sessions:listByWorkspace requires a workspaceId')
    }
    await sessionManager.waitForInit(workspaceId)
    return sessionManager.getSessions(workspaceId)
  })

  // Get unread summary across all workspaces
  server.handle(RPC_CHANNELS.sessions.GET_UNREAD_SUMMARY, async () => {
    // Cross-workspace aggregate waits for discovery; failed Projects are logged
    // individually while healthy Project shards remain available.
    await sessionManager.waitForInit()
    return sessionManager.getUnreadSummary()
  })

  server.handle(RPC_CHANNELS.sessions.MARK_ALL_READ, async (_ctx, workspaceId: string) => {
    return sessionManager.markAllSessionsRead(workspaceId)
  })

  // Get a single session with messages (for lazy loading)
  server.handle(RPC_CHANNELS.sessions.GET_MESSAGES, async (_ctx, sessionId: string) => {
    const end = perf.start('rpc.getSessionMessages')
    const session = await sessionManager.getSession(sessionId)
    end()
    return session
  })

  // Drop idle in-memory transcripts so main heap matches renderer working set.
  server.handle(RPC_CHANNELS.sessions.RELEASE_MESSAGES, async (_ctx, sessionId: string) => {
    const end = perf.start('rpc.releaseSessionMessages')
    try {
      return await sessionManager.releaseIdleSessionMessages(sessionId)
    } finally {
      end()
    }
  })

  // Create a new session
  server.handle(RPC_CHANNELS.sessions.CREATE, async (_ctx, workspaceId: string, options?: import('@craft-agent/shared/protocol').CreateSessionOptions) => {
    const end = perf.start('rpc.createSession', { workspaceId })
    const session = await sessionManager.createSession(workspaceId, options)
    end()
    return session
  })

  // Delete a session
  server.handle(RPC_CHANNELS.sessions.DELETE, async (_ctx, sessionId: string) => {
    return sessionManager.deleteSession(sessionId)
  })

  // In-place rewind: truncate transcript at a user message via Pi navigateTree
  server.handle(
    RPC_CHANNELS.sessions.REWIND,
    async (
      _ctx,
      sessionId: string,
      userMessageId: string,
    ): Promise<SessionRewindResult> => {
      const end = perf.start('rpc.rewindSession', { sessionId })
      try {
        return { success: true, ...await sessionManager.rewindUserMessage(sessionId, userMessageId) }
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'REWIND_UNAVAILABLE_LEGACY') {
          return { success: false, errorCode: error.code, errorMessage: error.message }
        }
        throw error
      } finally {
        end()
      }
    },
  )

  // Send a message to a session (with optional file attachments).
  //
  // Behavior:
  //   - Awaits until the user message is persisted to disk, then returns
  //     `{ accepted: true, messageId }`. This guarantees the message survives
  //     a mid-stream crash (#616).
  //   - The actual model-streaming work continues in the background; results
  //     flow back via SESSION_EVENT as before.
  //   - Pre-persist errors (session not found, etc.) reject the RPC so the
  //     caller can show a synchronous error.
  //   - Post-persist errors (model API failures, etc.) are routed via the
  //     event stream as today.
  // attachments: FileAttachment[] for Claude (has content), storedAttachments: StoredAttachment[] for persistence (has thumbnailBase64)
  server.handle(RPC_CHANNELS.sessions.SEND_MESSAGE, async (ctx, sessionId: string, message: string, attachments?: FileAttachment[], storedAttachments?: StoredAttachment[], options?: SendMessageOptions) => {
    // Capture the caller's clientId for error routing
    const callerClientId = ctx.clientId

    return await new Promise<{ accepted: true; messageId: string }>((resolve, reject) => {
      let acked = false
      const onAck = (messageId: string) => {
        if (!acked) {
          acked = true
          resolve({ accepted: true, messageId })
        }
      }

      sessionManager
        .sendMessage(sessionId, message, attachments, storedAttachments, options, undefined, onAck)
        .then(() => {
          // sendMessage finished without firing onAck — should not happen in
          // practice (every code path that creates a user message acks).
          // Treat as a defensive failure rather than silently dropping.
          if (!acked) {
            acked = true
            reject(new Error('sendMessage completed without persisting a user message'))
          }
        })
        .catch(err => {
          log.error('Error in sendMessage:', err)
          if (!acked) {
            // Pre-persist error — surface synchronously to the caller.
            acked = true
            reject(err)
            return
          }
          // Post-persist error — route via the event stream as today.
          pushTyped(server, RPC_CHANNELS.sessions.EVENT, { to: 'client', clientId: callerClientId }, {
            type: 'error',
            sessionId,
            error: err instanceof Error ? err.message : 'Unknown error'
          } as SessionEvent)
          pushTyped(server, RPC_CHANNELS.sessions.EVENT, { to: 'client', clientId: callerClientId }, {
            type: 'complete',
            sessionId
          } as SessionEvent)
        })
    })
  })

  server.handle(RPC_CHANNELS.sessions.REWRITE_NOVEL_SELECTION, async (_ctx, sessionId: string, request: NovelSelectionRewriteRequest) => {
    return sessionManager.rewriteNovelSelection(sessionId, request)
  })

  // Cancel processing
  server.handle(RPC_CHANNELS.sessions.CANCEL, async (_ctx, sessionId: string, silent?: boolean) => {
    return sessionManager.cancelProcessing(sessionId, silent)
  })

  // Kill background shell
  server.handle(RPC_CHANNELS.sessions.KILL_SHELL, async (_ctx, sessionId: string, shellId: string) => {
    return sessionManager.killShell(sessionId, shellId)
  })

  // Get background task output
  server.handle(RPC_CHANNELS.tasks.GET_OUTPUT, async (_ctx, taskId: string) => {
    try {
      const output = await sessionManager.getTaskOutput(taskId)
      return output
    } catch (err) {
      log.error('Failed to get task output:', err)
      throw err
    }
  })

  // Respond to a permission request (bash command approval)
  // Returns true if the response was delivered, false if agent/session is gone
  server.handle(RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION, async (_ctx, sessionId: string, requestId: string, allowed: boolean, alwaysAllow: boolean) => {
    return sessionManager.respondToPermission(sessionId, requestId, allowed, alwaysAllow)
  })

  server.handle(RPC_CHANNELS.sessions.RESPOND_TO_USER_QUESTION, async (_ctx, sessionId: string, requestId: string, response: import('@craft-agent/shared/protocol').UserQuestionResponse) => {
    return sessionManager.respondToUserQuestion(sessionId, requestId, response)
  })

  // Respond to a credential request (secure auth input)
  // Returns true if the response was delivered, false if agent/session is gone
  server.handle(RPC_CHANNELS.sessions.RESPOND_TO_CREDENTIAL, async (_ctx, sessionId: string, requestId: string, response: import('@craft-agent/shared/protocol').CredentialResponse) => {
    return sessionManager.respondToCredential(sessionId, requestId, response)
  })

  // ==========================================================================
  // Consolidated Command Handlers
  // ==========================================================================

  // Session commands - consolidated handler for session operations
  server.handle(RPC_CHANNELS.sessions.COMMAND, async (
    _ctx,
    sessionId: string,
    command: import('@craft-agent/shared/protocol').SessionCommand
  ) => {
    switch (command.type) {
      case 'flag':
        return sessionManager.flagSession(sessionId)
      case 'unflag':
        return sessionManager.unflagSession(sessionId)
      case 'archive':
        return sessionManager.archiveSession(sessionId)
      case 'unarchive':
        return sessionManager.unarchiveSession(sessionId)
      case 'rename':
        return sessionManager.renameSession(sessionId, command.name)
      case 'setSessionStatus':
        return sessionManager.setSessionStatus(sessionId, command.state)
      case 'markRead':
        return sessionManager.markSessionRead(sessionId)
      case 'markUnread':
        return sessionManager.markSessionUnread(sessionId)
      case 'setActiveViewing':
        // Track which session user is actively viewing (for unread state machine)
        return sessionManager.setActiveViewingSession(sessionId, command.workspaceId)
      case 'setPermissionMode':
        return sessionManager.setSessionPermissionMode(sessionId, command.mode)
      case 'setThinkingLevel':
        // Validate thinking level before passing to session manager
        if (!isValidThinkingLevel(command.level)) {
          throw new Error(`Invalid thinking level: ${command.level}. Valid values: ${VALID_THINKING_LEVELS_LIST}`)
        }
        return sessionManager.setSessionThinkingLevel(sessionId, command.level)
      case 'updateWorkingDirectory':
        return sessionManager.updateWorkingDirectory(sessionId, command.dir)
      case 'setSources':
        return sessionManager.setSessionSources(sessionId, command.sourceSlugs)
      case 'setLabels':
        return sessionManager.setSessionLabels(sessionId, command.labels)
      case 'showInFinder': {
        const sessionPath = sessionManager.getSessionPath(sessionId)
        if (sessionPath) {
          deps.platform.showItemInFolder?.(sessionPath)
        }
        return
      }
      case 'copyPath': {
        // Return the session folder path for copying to clipboard
        const sessionPath = sessionManager.getSessionPath(sessionId)
        return sessionPath ? { success: true, path: sessionPath } : { success: false }
      }
      case 'shareToViewer':
        return sessionManager.shareToViewer(sessionId)
      case 'updateShare':
        return sessionManager.updateShare(sessionId)
      case 'revokeShare':
        return sessionManager.revokeShare(sessionId)
      case 'refreshTitle':
        log.info(`IPC: refreshTitle received for session ${sessionId}`)
        return sessionManager.refreshTitle(sessionId)
      // Connection selection (locked after first message)
      case 'setConnection':
        log.info(`IPC: setConnection received for session ${sessionId}, connection: ${command.connectionSlug}`)
        return sessionManager.setSessionConnection(sessionId, command.connectionSlug)
      // Pending plan execution (Accept & Compact flow)
      case 'setPendingPlanExecution':
        return sessionManager.setPendingPlanExecution(sessionId, command.planPath, command.draftInputSnapshot)
      case 'markCompactionComplete':
        return sessionManager.markCompactionComplete(sessionId)
      case 'markPendingPlanExecutionDispatched':
        return sessionManager.markPendingPlanExecutionDispatched(sessionId)
      case 'clearPendingPlanExecution':
        return sessionManager.clearPendingPlanExecution(sessionId)
      case 'sendQueuedMessageNow':
        return sessionManager.sendQueuedMessageNow(sessionId, command.messageId)
      case 'removeQueuedMessage':
        return sessionManager.removeQueuedMessage(sessionId, command.messageId)
      case 'rewriteNovelSelection':
        return sessionManager.rewriteNovelSelection(sessionId, command.request)
      case 'addAnnotation':
        return sessionManager.addMessageAnnotation(sessionId, command.messageId, command.annotation)
      case 'removeAnnotation':
        return sessionManager.removeMessageAnnotation(sessionId, command.messageId, command.annotationId)
      case 'updateAnnotation':
        return sessionManager.updateMessageAnnotation(sessionId, command.messageId, command.annotationId, command.patch)
      default: {
        void (command satisfies never)
        throw new Error(`Unknown session command: ${JSON.stringify(command)}`)
      }
    }
  })

  // Get pending plan execution state (for reload recovery)
  server.handle(RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION, async (
    _ctx,
    sessionId: string
  ) => {
    return sessionManager.getPendingPlanExecution(sessionId)
  })

  // Get authoritative permission mode diagnostics for renderer reconciliation
  server.handle(RPC_CHANNELS.sessions.GET_PERMISSION_MODE_STATE, async (
    _ctx,
    sessionId: string
  ) => {
    return sessionManager.getSessionPermissionModeState(sessionId)
  })

  // ============================================================
  // Session Content Search
  // ============================================================

  // Search session content using ripgrep
  server.handle(RPC_CHANNELS.sessions.SEARCH_CONTENT, async (_ctx, workspaceId: string, query: string, searchId?: string) => {
    const id = searchId || Date.now().toString(36)
    log.info('[search]','ipc:request', { searchId: id, queryLength: query.length })

    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      log.warn('SEARCH_SESSIONS: Workspace not found:', workspaceId)
      return []
    }

    const { searchSessions } = await import('@craft-agent/server-core/services')
    const { getWorkspaceSessionsPath } = await import('@craft-agent/shared/workspaces')

    const sessionsDir = getWorkspaceSessionsPath(workspace.rootPath)
    log.debug(`SEARCH_SESSIONS: Searching ${query.length} characters in ${sessionsDir}`)

    const results = await searchSessions(query, sessionsDir, {
      timeout: 5000,
      maxMatchesPerSession: 3,
      maxSessions: 50,
      searchId: id,
    })

    // Filter out hidden sessions (e.g., mini edit sessions)
    const allSessions = await sessionManager.getSessions(workspace.id)
    const hiddenSessionIds = new Set(
      allSessions.filter(s => s.hidden).map(s => s.id)
    )
    const filteredResults = results.filter(r => !hiddenSessionIds.has(r.sessionId))

    log.info('[search]','ipc:response', { searchId: id, resultCount: filteredResults.length, totalFound: results.length })
    return filteredResults
  })

  // ============================================================
  // Session Info Panel (files, notes, file watching)
  // ============================================================

  // Get files in session directory (recursive tree structure)
  server.handle(RPC_CHANNELS.sessions.GET_FILES, async (_ctx, sessionId: string) => {
    try {
      return await sessionManager.withSessionPathOperation(
        sessionId,
        sessionPath => scanSessionDirectory(sessionPath),
      )
    } catch (error) {
      log.error('Failed to get session files:', error)
      return []
    }
  })

  // Start watching a session directory for file changes (per client)
  server.handle(RPC_CHANNELS.sessions.WATCH_FILES, async (ctx, sessionId: string) => {
    const clientId = ctx.clientId
    cleanupSessionFileWatchForClient(clientId)

    const sessionPath = sessionManager.getSessionPath(sessionId)
    if (!sessionPath) return

    try {
      const { watch } = await import('fs')

      const state: ClientSessionWatchState = {
        watcher: null as unknown as import('fs').FSWatcher,
        sessionId,
        debounceTimer: null,
      }

      state.watcher = watch(sessionPath, { recursive: true }, (_eventType, filename) => {
        // Ignore internal files and hidden files
        if (filename && (filename.includes('session.jsonl') || filename.startsWith('.'))) {
          return
        }

        // Debounce before notifying to batch rapid changes in large output folders.
        if (state.debounceTimer) {
          clearTimeout(state.debounceTimer)
        }

        state.debounceTimer = setTimeout(() => {
          pushTyped(server, RPC_CHANNELS.sessions.FILES_CHANGED, { to: 'client', clientId }, state.sessionId)
        }, SESSION_FILE_WATCH_DEBOUNCE_MS)
      })

      clientSessionWatches.set(clientId, state)
    } catch (error) {
      log.error('Failed to start session file watcher:', error)
    }
  })

  // Stop watching session files for the calling client
  server.handle(RPC_CHANNELS.sessions.UNWATCH_FILES, async (ctx) => {
    cleanupSessionFileWatchForClient(ctx.clientId)
  })

  // Get session notes (reads notes.md from session directory)
  server.handle(RPC_CHANNELS.sessions.GET_NOTES, async (_ctx, sessionId: string) => {
    try {
      return await sessionManager.withSessionPathOperation(sessionId, async sessionPath => {
        const notesPath = join(sessionPath, 'notes.md')
        return readFile(notesPath, 'utf-8')
      })
    } catch {
      // File doesn't exist yet - return empty string
      return ''
    }
  })

  // Set session notes (writes to notes.md in session directory)
  server.handle(RPC_CHANNELS.sessions.SET_NOTES, async (_ctx, sessionId: string, content: string) => {
    try {
      await sessionManager.withSessionPathOperation(sessionId, async sessionPath => {
        const notesPath = join(sessionPath, 'notes.md')
        await writeFile(notesPath, content, 'utf-8')
      })
    } catch (error) {
      log.error('Failed to save session notes:', error)
      throw error
    }
  })

  // ============================================
  // Export / Import / Dispatch
  // ============================================

  // Export a session as a portable bundle
  server.handle(RPC_CHANNELS.sessions.EXPORT, async (ctx, sessionId: string) => {
    await sessionManager.waitForInit()
    const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
    if (!workspaceId) throw new Error('No workspace context')

    const bundle = await sessionManager.exportSession(sessionId, workspaceId)
    if (!bundle) throw new Error(`Failed to export session ${sessionId}`)
    return bundle
  })

  // Import a session bundle into a target workspace
  // targetWorkspaceId is passed explicitly (not from context) so the renderer
  // can import into any workspace the server manages, not just the active one.
  const importHandler = async (_ctx: any, targetWorkspaceId: string, bundle: unknown, mode: string) => {
    if (!targetWorkspaceId || typeof targetWorkspaceId !== 'string') throw new Error('targetWorkspaceId is required')
    if (mode !== 'move' && mode !== 'fork') throw new Error(`Invalid dispatch mode: ${mode}`)
    await sessionManager.waitForInit(targetWorkspaceId)

    return sessionManager.importSession(targetWorkspaceId, bundle as import('@craft-agent/shared/sessions').SessionBundle, mode)
  }
  server.handle(RPC_CHANNELS.sessions.IMPORT, importHandler)
  // Also register as transferable so chunked transfer can invoke it on commit
  setTransferableHandler(RPC_CHANNELS.sessions.IMPORT, importHandler)

  // Export a session as a summarized remote-transfer payload.
  server.handle(RPC_CHANNELS.sessions.EXPORT_REMOTE_TRANSFER, async (ctx, sessionId: string) => {
    await sessionManager.waitForInit()
    const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
    if (!workspaceId) throw new Error('No workspace context')

    const payload = await sessionManager.exportRemoteSessionTransfer(sessionId, workspaceId)
    if (!payload) throw new Error(`Failed to export remote transfer for session ${sessionId}`)
    return payload
  })

  // Import a summarized remote-transfer payload into a target workspace.
  server.handle(RPC_CHANNELS.sessions.IMPORT_REMOTE_TRANSFER, async (_ctx, targetWorkspaceId: string, payload: import('@craft-agent/shared/protocol').RemoteSessionTransferPayload) => {
    if (!targetWorkspaceId || typeof targetWorkspaceId !== 'string') throw new Error('targetWorkspaceId is required')
    await sessionManager.waitForInit(targetWorkspaceId)
    return sessionManager.importRemoteSessionTransfer(targetWorkspaceId, payload)
  })
}
