// input: Session payloads, transcript messages, and renderer-side mutations
// output: Per-session atoms, metadata actions, and isolated transcript working sets
// pos: Renderer session state boundary that keeps chat updates isolated by session

/**
 * Per-Session State Management with Jotai
 *
 * Uses atomFamily to create isolated atoms per session.
 * Updates to one session don't trigger re-renders in other sessions.
 *
 * This solves the performance issue where streaming in Session A
 * caused re-renders and focus loss in Session B.
 */

import { atom } from 'jotai'
import { selectAtom } from 'jotai/utils'
import type { Getter, Setter } from 'jotai/vanilla'
import { atomFamily } from 'jotai-family'
import type { Session, Message, Workspace } from '../../shared/types'
import { restoreUserQuestionsAtom } from './pending-requests'

/**
 * Session metadata for list display (lightweight, no messages)
 * Used by SessionList to avoid re-rendering on message changes
 */
export interface SessionMeta {
  id: string
  name?: string
  /** Preview of first user message (for title fallback) */
  preview?: string
  workspaceId: string
  lastMessageAt?: number
  isProcessing?: boolean
  isFlagged?: boolean
  isPinned?: boolean
  lastReadMessageId?: string
  workingDirectory?: string
  enabledSourceSlugs?: string[]
  /** Shared viewer URL (if shared via viewer) */
  sharedUrl?: string
  /** Shared session ID in viewer (for revoke) */
  sharedId?: string
  /** ID of the last final (non-intermediate) assistant message - for unread detection */
  lastFinalMessageId?: string
  /**
   * Explicit unread flag - single source of truth for NEW badge.
   * Set to true when assistant message completes while user is NOT viewing.
   * Set to false when user views the session (and not processing).
   */
  hasUnread?: boolean
  /** Labels for filtering (additive tags, many-per-session) */
  labels?: string[]
  /** Permission mode ('safe', 'ask', 'allow-all') — used by view expressions */
  permissionMode?: string
  /** Session status for filtering */
  sessionStatus?: string
  /** Role/type of the last message (for badge display without loading messages) */
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error'
  /** Whether an async operation is ongoing (sharing, updating share, revoking, title regeneration) */
  isAsyncOperationOngoing?: boolean
  /** Model override for this session */
  model?: string
  /** LLM connection slug for this session */
  llmConnection?: string
  /** Token usage stats (from JSONL header, available without loading messages) */
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    costUsd: number
    contextTokens: number
  }
  /** When the session was created (ms timestamp) */
  createdAt?: number
  /** Total number of messages in this session */
  messageCount?: number
  /** When true, session is hidden from session list (e.g., mini edit sessions) */
  hidden?: boolean
  /** Whether this session is archived */
  isArchived?: boolean
  /** Timestamp when session was archived (for retention policy) */
  archivedAt?: number
}

/**
 * Find the last final (non-intermediate) assistant or plan message ID
 */
function findLastFinalMessageId(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    // Include plan messages as final responses (they're AI-generated content)
    if ((msg.role === 'assistant' || msg.role === 'plan') && !msg.isIntermediate) {
      return msg.id
    }
  }
  return undefined
}

/**
 * Extract metadata from a full session object
 */
export function extractSessionMeta(session: Session): SessionMeta {
  const messages = session.messages || []

  // Destructure fields that don't exist on SessionMeta or need overrides
  const {
    messages: _msgs, sessionFolderPath: _sf, supportsBranching: _sb, pendingUserQuestions: _pq, userQuestionRevision: _qr,
    workspaceName: _wn, thinkingLevel: _tl, currentStatus: _cs,
    isAsyncOperationOngoing,
    messageCount, lastFinalMessageId: sessionLastFinal,
    ...sessionFields
  } = session

  return {
    ...sessionFields,
    lastFinalMessageId: sessionLastFinal ?? findLastFinalMessageId(messages),
    messageCount: messageCount ?? messages.length ?? 0,
    isAsyncOperationOngoing,
  } as SessionMeta
}

/**
 * Atom family for individual session state
 * Each session gets its own atom - updates are isolated
 */
export const sessionAtomFamily = atomFamily(
  (_sessionId: string) => atom<Session | null>(null),
  (a, b) => a === b
)

/**
 * Atom for session metadata map (for list display)
 * Only contains lightweight data needed for SessionList
 */
export const sessionMetaMapAtom = atom<Map<string, SessionMeta>>(new Map())

/**
 * Whether the current runtime workspace has finished loading its session metadata.
 * Consumers with their own workspace-scoped projection can keep rendering it while
 * the runtime map is intentionally empty during a workspace switch.
 */
export const sessionMetadataReadyAtom = atom(false)

export const sessionMetaAtomFamily = atomFamily(
  (sessionId: string) => atom((get) => get(sessionMetaMapAtom).get(sessionId)),
  (a, b) => a === b
)

/**
 * Derived atom: ordered list of session IDs (for list ordering)
 */
export const sessionIdsAtom = atom<string[]>([])

/**
 * Track which sessions have had their messages loaded (for lazy loading)
 * Sessions are loaded with empty messages initially, messages are fetched on-demand
 */
export const loadedSessionsAtom = atom<Set<string>>(new Set<string>())

export const sessionMessagesLoadedAtomFamily = atomFamily(
  (sessionId: string) => atom((get) => get(loadedSessionsAtom).has(sessionId)),
  (a, b) => a === b
)

/**
 * Promise cache for deduplicating concurrent session load requests.
 * Prevents race condition where multiple calls (e.g., from React re-renders)
 * start loading before the first completes and marks the session as loaded.
 * Module-level map since it tracks in-flight promises, not React state.
 */
const sessionLoadingPromises = new Map<string, Promise<Session | null>>()

// NOTE: sessionsAtom REMOVED to fix memory leak
// The sessions array with messages was being retained by Jotai's internal state.
// Instead, we now use:
// - sessionMetaMapAtom for listing (lightweight metadata, no messages)
// - sessionAtomFamily(id) for individual session data
// - initializeSessionsAtom for bulk initialization
// - addSessionAtom, removeSessionAtom for individual operations

/**
 * Action atom: update a single session
 * Only triggers re-render in components subscribed to this specific session
 */
export const updateSessionAtom = atom(
  null,
  (get, set, sessionId: string, updater: (prev: Session | null) => Session | null) => {
    const sessionAtom = sessionAtomFamily(sessionId)
    const currentSession = get(sessionAtom)
    const newSession = updater(currentSession)
    if (currentSession === newSession) {
      const metaMap = get(sessionMetaMapAtom)
      if (!newSession || metaMap.has(sessionId)) return
    }
    const sessionUnchanged = currentSession === newSession || (
      currentSession !== null &&
      newSession !== null &&
      shallowEqualSession(currentSession, newSession)
    )
    if (!sessionUnchanged) {
      set(sessionAtom, newSession)
    }

    // Also update metadata if session exists
    if (newSession) {
      const newMeta = extractSessionMeta(newSession)
      const metaMap = get(sessionMetaMapAtom)
      const currentMeta = metaMap.get(sessionId)
      if (currentMeta && shallowEqualSessionMeta(currentMeta, newMeta)) return
      const newMetaMap = new Map(metaMap)
      newMetaMap.set(sessionId, newMeta)
      set(sessionMetaMapAtom, newMetaMap)
    }
  }
)

function shallowEqualSession(a: Session, b: Session): boolean {
  const aKeys = Object.keys(a) as Array<keyof Session>
  const bKeys = Object.keys(b) as Array<keyof Session>
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every(key => a[key] === b[key])
}

function shallowEqualSessionMeta(a: SessionMeta, b: SessionMeta): boolean {
  const aKeys = Object.keys(a) as Array<keyof SessionMeta>
  const bKeys = Object.keys(b) as Array<keyof SessionMeta>
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every(key => a[key] === b[key])
}

function areSessionIdsSortedByMetaTime(ids: string[], metaMap: Map<string, SessionMeta>): boolean {
  if (ids.length !== metaMap.size) return false

  let previousTime = Number.POSITIVE_INFINITY
  for (const id of ids) {
    const meta = metaMap.get(id)
    if (!meta) return false
    const time = meta.lastMessageAt || 0
    if (time > previousTime) return false
    previousTime = time
  }
  return true
}

/**
 * Action atom: update only session metadata (for list display updates)
 * Doesn't affect the full session atom
 */
export const updateSessionMetaAtom = atom(
  null,
  (get, set, sessionId: string, updates: Partial<SessionMeta>) => {
    const metaMap = get(sessionMetaMapAtom)
    const existing = metaMap.get(sessionId)
    if (existing) {
      const nextMeta = { ...existing, ...updates }
      if (shallowEqualSessionMeta(existing, nextMeta)) return
      const newMetaMap = new Map(metaMap)
      newMetaMap.set(sessionId, nextMeta)
      set(sessionMetaMapAtom, newMetaMap)
    }
  }
)

/**
 * Action atom: replace a session with an authoritative full session payload.
 *
 * Use this for data returned by getSessionMessages() or createSession(), where
 * the `messages` array is known to represent the loaded transcript. Keeping the
 * full session atom and loadedSessionsAtom in one write prevents the chat panel
 * from hiding real messages behind a stale lazy-loading spinner.
 */
export const replaceLoadedSessionAtom = atom(
  null,
  (get, set, session: Session) => {
    set(restoreUserQuestionsAtom, session)
    const sessionAtom = sessionAtomFamily(session.id)
    const currentSession = get(sessionAtom)
    if (!currentSession || !shallowEqualSession(currentSession, session)) {
      set(sessionAtom, session)
    }

    const metaMap = get(sessionMetaMapAtom)
    const newMeta = extractSessionMeta(session)
    const currentMeta = metaMap.get(session.id)
    if (!currentMeta || !shallowEqualSessionMeta(currentMeta, newMeta)) {
      const newMetaMap = new Map(metaMap)
      newMetaMap.set(session.id, newMeta)
      set(sessionMetaMapAtom, newMetaMap)
    }

    const loadedSessions = get(loadedSessionsAtom)
    if (!loadedSessions.has(session.id)) {
      const newLoadedSessions = new Set(loadedSessions)
      newLoadedSessions.add(session.id)
      set(loadedSessionsAtom, newLoadedSessions)
    }
  }
)

/**
 * Action atom: initialize sessions from loaded data
 */
export const initializeSessionsAtom = atom(
  null,
  (get, set, sessions: Session[]) => {
    // Clean up stale atom family entries from previous workspace.
    // Without this, switching workspaces leaves orphaned atoms in memory
    // and components subscribed to old session IDs see stale/empty data.
    const oldIds = get(sessionIdsAtom)
    const newIdSet = new Set<string>()
    for (const session of sessions) {
      newIdSet.add(session.id)
    }
    for (const oldId of oldIds) {
      if (!newIdSet.has(oldId)) {
        sessionAtomFamily.remove(oldId)
      }
    }
    // Reset loaded sessions tracking — new workspace needs fresh lazy loading
    set(loadedSessionsAtom, new Set<string>())

    // Set individual session atoms
    for (const session of sessions) {
      set(restoreUserQuestionsAtom, session)
      set(sessionAtomFamily(session.id), session)
    }

    // Build metadata map
    const metaMap = new Map<string, SessionMeta>()
    for (const session of sessions) {
      metaMap.set(session.id, extractSessionMeta(session))
    }
    set(sessionMetaMapAtom, metaMap)

    // Set ordered IDs (sorted by lastMessageAt desc)
    const ids = [...sessions]
      .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
      .map(s => s.id)
    set(sessionIdsAtom, ids)

    // NOTE: Do NOT mark sessions as loaded here
    // Sessions from getSessions() have empty messages: [] to save memory
    // Messages are lazy-loaded via ensureSessionMessagesLoadedAtom when session is opened
    // This reduces initial memory usage from ~500MB to ~50MB for 300+ sessions
  }
)

/**
 * Action atom: refresh session metadata after a stale reconnect.
 *
 * Unlike initializeSessionsAtom (which resets everything for workspace switches),
 * this preserves messages for already-loaded sessions and only marks overwritten
 * metadata-only sessions as unloaded for lazy re-fetching.
 *
 * All cross-atom mutations happen inside a single write transaction so that
 * React subscribers see one consistent update instead of intermediate states.
 */
export const refreshSessionsMetadataAtom = atom(
  null,
  (
    get,
    set,
    payload: { sessions: Session[]; loadedSessionIds: Set<string>; removeMissing?: boolean }
  ): Map<string, SessionMeta> => {
    const { sessions, loadedSessionIds, removeMissing = true } = payload

    // Remove stale sessions only for authoritative refreshes. Stale reconnect
    // recovery can receive a transient partial list immediately after sleep/wake;
    // treating that as authoritative is what makes the sidebar collapse to the
    // single active session. In non-destructive mode we upsert returned sessions
    // and preserve missing metadata until a confirmed delete/workspace reload.
    const currentIds = get(sessionIdsAtom)
    if (removeMissing) {
      const latestIds = new Set<string>()
      for (const session of sessions) latestIds.add(session.id)
      for (const staleId of currentIds) {
        if (!latestIds.has(staleId)) {
          set(removeSessionAtom, staleId)
        }
      }
    }

    // Update each session atom, preserving messages for loaded sessions
    const unloadedIds: string[] = []
    for (const session of sessions) {
      set(restoreUserQuestionsAtom, session)
      const currentSession = get(sessionAtomFamily(session.id))
      const shouldPreserveMessages = !!currentSession && loadedSessionIds.has(session.id)
      let nextSession = shouldPreserveMessages && currentSession
        ? { ...session, messages: currentSession.messages }
        : session
      if (currentSession && currentSession.messages.length === 0 && nextSession.messages.length === 0) {
        nextSession = { ...nextSession, messages: currentSession.messages }
      }

      if (!currentSession || !shallowEqualSession(currentSession, nextSession)) {
        set(sessionAtomFamily(session.id), nextSession)
      }

      // Track sessions that lost their messages so lazy-loading re-fetches them
      if (!shouldPreserveMessages && loadedSessionIds.has(session.id)) {
        unloadedIds.push(session.id)
      }
    }

    // Remove overwritten sessions from loadedSessionsAtom
    if (unloadedIds.length > 0) {
      const nextLoaded = new Set(get(loadedSessionsAtom))
      for (const id of unloadedIds) nextLoaded.delete(id)
      set(loadedSessionsAtom, nextLoaded)
    }

    // Build and set metadata map. Non-destructive refresh starts from the
    // existing map so sessions omitted by a transient partial response remain
    // visible. Returned sessions are still authoritative for their own fields.
    const currentMetaMap = get(sessionMetaMapAtom)
    const nextMetaMap = removeMissing
      ? new Map<string, SessionMeta>()
      : new Map(currentMetaMap)
    let metadataChanged = removeMissing
      ? currentMetaMap.size !== sessions.length
      : false
    let orderMayHaveChanged = metadataChanged
    for (const session of sessions) {
      const nextMeta = extractSessionMeta(session)
      const currentMeta = currentMetaMap.get(session.id)
      if (!currentMeta) {
        metadataChanged = true
        orderMayHaveChanged = true
      } else {
        if (!metadataChanged && !shallowEqualSessionMeta(currentMeta, nextMeta)) {
          metadataChanged = true
        }
        if (currentMeta.lastMessageAt !== nextMeta.lastMessageAt) {
          orderMayHaveChanged = true
        }
      }
      nextMetaMap.set(session.id, nextMeta)
    }
    if (metadataChanged) {
      set(sessionMetaMapAtom, nextMetaMap)
    }

    if (!orderMayHaveChanged && areSessionIdsSortedByMetaTime(currentIds, nextMetaMap)) {
      return metadataChanged ? nextMetaMap : currentMetaMap
    }

    // Set ordered IDs from the metadata map we actually exposed to the UI.
    const nextIds = Array.from(nextMetaMap.values())
      .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
      .map(s => s.id)
    if (currentIds.length !== nextIds.length || currentIds.some((id, index) => id !== nextIds[index])) {
      set(sessionIdsAtom, nextIds)
    }

    return metadataChanged ? nextMetaMap : currentMetaMap
  }
)

/**
 * Action atom: add a new session
 */
export const addSessionAtom = atom(
  null,
  (get, set, session: Session) => {
    set(restoreUserQuestionsAtom, session)
    // Set session atom
    set(sessionAtomFamily(session.id), session)

    // Add to metadata map
    const metaMap = get(sessionMetaMapAtom)
    const newMeta = extractSessionMeta(session)
    const currentMeta = metaMap.get(session.id)
    if (!currentMeta || !shallowEqualSessionMeta(currentMeta, newMeta)) {
      const newMetaMap = new Map(metaMap)
      newMetaMap.set(session.id, newMeta)
      set(sessionMetaMapAtom, newMetaMap)
    }

    // Add to beginning of IDs list
    const ids = get(sessionIdsAtom)
    if (!ids.includes(session.id)) {
      set(sessionIdsAtom, [session.id, ...ids])
    }

    // Mark as loaded (new sessions are complete - no lazy loading needed)
    const loadedSessions = get(loadedSessionsAtom)
    if (!loadedSessions.has(session.id)) {
      const newLoadedSessions = new Set(loadedSessions)
      newLoadedSessions.add(session.id)
      set(loadedSessionsAtom, newLoadedSessions)
    }
  }
)

/**
 * Action atom: remove a session
 */
export const removeSessionAtom = atom(
  null,
  (get, set, sessionId: string) => {
    const metaMap = get(sessionMetaMapAtom)
    const ids = get(sessionIdsAtom)
    const loadedSessions = get(loadedSessionsAtom)
    if (!metaMap.has(sessionId) && !ids.includes(sessionId) && !loadedSessions.has(sessionId)) {
      return
    }

    // Clear session atom value first
    set(sessionAtomFamily(sessionId), null)
    // Remove atom from family cache to allow GC of the atom and its stored value
    sessionAtomFamily.remove(sessionId)

    // Remove from metadata map
    const newMetaMap = new Map(metaMap)
    newMetaMap.delete(sessionId)
    set(sessionMetaMapAtom, newMetaMap)

    // Remove from IDs list
    set(sessionIdsAtom, ids.filter(id => id !== sessionId))

    // Remove from loaded sessions tracking
    const newLoadedSessions = new Set(loadedSessions)
    newLoadedSessions.delete(sessionId)
    set(loadedSessionsAtom, newLoadedSessions)

    // Clean up additional atom families to prevent memory leaks
    // These store per-session UI state that should be garbage collected
  }
)

/**
 * Action atom: Load session messages if not already loaded
 * Returns the loaded session or current session if already loaded.
 * Uses promise deduplication to prevent redundant IPC calls from concurrent requests.
 *
 * IMPORTANT: This only merges messages into the existing session atom.
 * UI state fields (hasUnread, isFlagged, sessionStatus, etc.) are preserved from
 * the in-memory atom, NOT overwritten with potentially stale disk data.
 * This prevents a race condition where optimistic updates (e.g., clearing the
 * NEW badge on session view) get clobbered by async message loading that reads
 * older state from disk.
 */
async function loadSessionMessages(
  get: Getter,
  set: Setter,
  sessionId: string,
  options?: { force?: boolean },
): Promise<Session | null> {
  const force = options?.force ?? false

  if (force) {
    const nextLoadedSessions = new Set(get(loadedSessionsAtom))
    nextLoadedSessions.delete(sessionId)
    set(loadedSessionsAtom, nextLoadedSessions)

    // Clear any stale in-flight request so the caller gets a fresh fetch.
    sessionLoadingPromises.delete(sessionId)
  } else {
    const loadedSessions = get(loadedSessionsAtom)

    // Already loaded, return current session
    if (loadedSessions.has(sessionId)) {
      return get(sessionAtomFamily(sessionId))
    }
  }

  // Check if already loading - return existing promise to deduplicate concurrent calls
  const existingPromise = sessionLoadingPromises.get(sessionId)
  if (existingPromise) {
    return existingPromise
  }

  // Create the loading promise with all the fetch and update logic
  const loadPromise = (async (): Promise<Session | null> => {
    // Fetch messages from main process
    const loadedSession = await window.electronAPI.getSessionMessages(sessionId)
    if (!loadedSession) {
      return get(sessionAtomFamily(sessionId))
    }
    set(restoreUserQuestionsAtom, loadedSession)

    // Merge messages and disk-only fields into existing session, preserving in-memory UI state.
    // The renderer's atom is authoritative for UI fields (hasUnread, isFlagged, etc.)
    // because optimistic updates may have changed them since the disk write.
    // tokenUsage and sessionFolderPath are only returned by getSession() (not getSessions()),
    // so they must be explicitly merged here to be available after app restart.
    const existingSession = get(sessionAtomFamily(sessionId))
    const preservedStaleMessages = !!existingSession
      && existingSession.messages.length > 0
      && (!loadedSession.messages || loadedSession.messages.length === 0)

    const mergedSession = existingSession
      ? {
          ...existingSession,
          // CRITICAL: Don't clobber messages if session is actively streaming
          // AND already has messages in the atom. Streaming events update the atom
          // directly and may contain messages the IPC response doesn't know about
          // (race window between IPC request and response).
          // The `messages.length > 0` guard ensures Cmd+R reload works: after reload,
          // the atom starts with messages=[] from getSessions(), so IPC response
          // (which has full history from main process memory) must be used.
          // Also guard against sleep/wake edge case: the server may return
          // empty messages if the session subprocess hasn't finished lazy-loading.
          messages: preservedStaleMessages
            ? existingSession.messages
            : existingSession.isProcessing && existingSession.messages.length > 0
              ? existingSession.messages
              : loadedSession.messages,
          tokenUsage: loadedSession.tokenUsage ?? existingSession.tokenUsage,
          sessionFolderPath: loadedSession.sessionFolderPath ?? existingSession.sessionFolderPath,
        }
      : loadedSession
    set(sessionAtomFamily(sessionId), mergedSession)

    // Update only lastFinalMessageId in metadata (now computable from loaded messages).
    // Don't replace the full meta entry — other fields are maintained through
    // optimistic updates and IPC events, and may be ahead of disk state.
    const lastFinalMessageId = loadedSession.lastFinalMessageId ?? findLastFinalMessageId(loadedSession.messages)
    if (lastFinalMessageId) {
      const metaMap = get(sessionMetaMapAtom)
      const existingMeta = metaMap.get(sessionId)
      if (existingMeta && existingMeta.lastFinalMessageId !== lastFinalMessageId) {
        const newMetaMap = new Map(metaMap)
        newMetaMap.set(sessionId, { ...existingMeta, lastFinalMessageId })
        set(sessionMetaMapAtom, newMetaMap)
      }
    }

    // Mark as loaded only when we received a fresh payload.
    // If we had to preserve stale in-memory messages because the backend returned
    // an empty array during lazy-load recovery, keep the session reloadable.
    if (!preservedStaleMessages) {
      const newLoadedSessions = new Set(get(loadedSessionsAtom))
      newLoadedSessions.add(sessionId)
      set(loadedSessionsAtom, newLoadedSessions)
      reconcileLoadedSessionTranscripts(get, set)
    }

    return mergedSession
  })()

  // Cache the promise before awaiting
  sessionLoadingPromises.set(sessionId, loadPromise)

  try {
    return await loadPromise
  } finally {
    // Always clean up the cache, whether success or failure
    sessionLoadingPromises.delete(sessionId)
  }
}

export const ensureSessionMessagesLoadedAtom = atom(
  null,
  async (get, set, sessionId: string): Promise<Session | null> => {
    touchSessionTranscriptAccess(sessionId)
    return loadSessionMessages(get, set, sessionId)
  }
)

/**
 * Force-refresh session messages even if the session is currently marked as loaded.
 * Used by reconnect recovery when a session atom is stuck in an empty-but-loaded state.
 */
export const forceSessionMessagesReloadAtom = atom(
  null,
  async (get, set, sessionId: string): Promise<Session | null> => {
    touchSessionTranscriptAccess(sessionId)
    return loadSessionMessages(get, set, sessionId, { force: true })
  }
)

// ---------------------------------------------------------------------------
// Transcript working set (long-lived memory bound)
// ---------------------------------------------------------------------------
//
// Root cause of session-switch heap growth: ensureSessionMessagesLoaded keeps the
// full message array on sessionAtomFamily forever. Switching across many sessions
// therefore retains O(N) full transcripts in the renderer.
//
// Correct model: only pin transcripts for currently open panels (hard pins) plus
// a small recency buffer for back-navigation. Everything else keeps SessionMeta
// and an empty message shell, and re-fetches on next open.

/** Extra full transcripts retained beyond currently open session panels. */
export const SESSION_TRANSCRIPT_WORKING_SET_EXTRA = 2

/** Bound on recency bookkeeping (not the same as retained transcripts). */
const SESSION_TRANSCRIPT_RECENCY_CAP = 32

/** Most-recent-last access order for transcript soft pins. */
let recentTranscriptAccess: string[] = []

/** Latest renderer-owned hard pins, read again when an async load completes. */
const sessionTranscriptOpenIdsAtom = atom<readonly string[]>([])

/** Test-only reset for the module-level recency list. */
export function __resetSessionTranscriptWorkingSetForTests(): void {
  recentTranscriptAccess = []
}

/** Record that a session's full transcript was accessed / should stay warm briefly. */
export function touchSessionTranscriptAccess(sessionId: string): void {
  if (!sessionId) return
  recentTranscriptAccess = [
    ...recentTranscriptAccess.filter((id) => id !== sessionId),
    sessionId,
  ]
  if (recentTranscriptAccess.length > SESSION_TRANSCRIPT_RECENCY_CAP) {
    recentTranscriptAccess = recentTranscriptAccess.slice(-SESSION_TRANSCRIPT_RECENCY_CAP)
  }
}

/**
 * Resolve the set of session ids allowed to keep full message arrays in memory.
 * Open panel/selected ids are hard pins; recency fills remaining soft slots.
 */
export function resolveSessionTranscriptWorkingSet(
  openSessionIds: readonly string[],
  extraSlots: number = SESSION_TRANSCRIPT_WORKING_SET_EXTRA,
): string[] {
  const open: string[] = []
  const seen = new Set<string>()
  for (const id of openSessionIds) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    open.push(id)
  }
  const extras = recentTranscriptAccess
    .filter((id) => !seen.has(id))
    .slice(-Math.max(0, extraSlots))
  return [...open, ...extras]
}

/**
 * Drop a session's full transcript while preserving metadata and session shell.
 * Skips sessions that are actively processing (streaming is source of truth there).
 * Best-effort asks main to release the matching idle transcript cache so both
 * sides stay on the same working-set model.
 */
export const unloadSessionTranscriptAtom = atom(
  null,
  (get, set, sessionId: string): boolean => {
    const session = get(sessionAtomFamily(sessionId))
    if (session?.isProcessing) return false

    if (session && (session.messages?.length ?? 0) > 0) {
      set(sessionAtomFamily(sessionId), { ...session, messages: [] })
    }

    const loadedSessions = get(loadedSessionsAtom)
    if (loadedSessions.has(sessionId)) {
      const nextLoaded = new Set(loadedSessions)
      nextLoaded.delete(sessionId)
      set(loadedSessionsAtom, nextLoaded)
    }

    sessionLoadingPromises.delete(sessionId)

    // Fire-and-forget: main may refuse (processing/queue). Renderer already dropped.
    if (typeof window !== 'undefined') {
      void window.electronAPI?.releaseSessionMessages?.(sessionId)?.catch(() => {})
    }

    return true
  },
)

function reconcileLoadedSessionTranscripts(get: Getter, set: Setter): void {
  const keep = new Set(resolveSessionTranscriptWorkingSet(get(sessionTranscriptOpenIdsAtom)))
  for (const id of get(loadedSessionsAtom)) {
    if (keep.has(id)) continue
    set(unloadSessionTranscriptAtom, id)
  }
}

/**
 * Evict full transcripts that are outside the working set.
 * Call after opening/selecting a session with the currently open session ids
 * (panel stack + selected).
 */
export const reconcileSessionTranscriptWorkingSetAtom = atom(
  null,
  (get, set, openSessionIds: readonly string[]) => {
    const normalizedOpenIds = [...new Set(openSessionIds.filter(Boolean))]
    set(sessionTranscriptOpenIdsAtom, normalizedOpenIds)
    for (const id of normalizedOpenIds) {
      touchSessionTranscriptAccess(id)
    }
    reconcileLoadedSessionTranscripts(get, set)
  },
)

/** Re-run eviction against the latest hard pins after background processing ends. */
export const reconcileCurrentSessionTranscriptWorkingSetAtom = atom(
  null,
  (get, set) => {
    reconcileLoadedSessionTranscripts(get, set)
  },
)

/**
 * Window's current workspace ID — shared between Root (ThemeProvider) and App.
 * Written by App on workspace switch, read by Root to keep the theme in sync.
 */
export const windowWorkspaceIdAtom = atom<string | null>(null)

/** Window's resolved runtime workspace, including the hidden free-conversation workspace. */
export const windowRuntimeWorkspaceAtom = atom<Workspace | null>(null)

/**
 * Window's workspace list — paired with windowWorkspaceIdAtom for active-workspace lookups.
 * Written by App when workspace state changes, read by focused workspace consumers.
 */
export const windowWorkspacesAtom = atom<Workspace[]>([])

export const hasOtherWorkspacesAtom = selectAtom(
  windowWorkspacesAtom,
  (workspaces) => workspaces.length > 1,
  Object.is,
)

export interface WorkspacePanelFields {
  name: string
  slug: string
  rootPath: string
  remoteWorkspaceId?: string
}

function workspacePanelFieldsEqual(
  a: WorkspacePanelFields | null,
  b: WorkspacePanelFields | null,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.name === b.name
    && a.slug === b.slug
    && a.rootPath === b.rootPath
    && a.remoteWorkspaceId === b.remoteWorkspaceId
}

export const workspacePanelFieldsAtomFamily = atomFamily(
  (workspaceId: string | null) => selectAtom(
    windowWorkspacesAtom,
    (workspaces): WorkspacePanelFields | null => {
      if (!workspaceId) return null
      const workspace = workspaces.find((entry) => entry.id === workspaceId)
      if (!workspace) return null
      return {
        name: workspace.name,
        slug: workspace.slug,
        rootPath: workspace.rootPath,
        remoteWorkspaceId: workspace.remoteServer?.remoteWorkspaceId,
      }
    },
    workspacePanelFieldsEqual,
  ),
  (a, b) => a === b,
)

/**
 * State for "Send to Workspace" dialog.
 * Set session IDs to open; clear to close.
 */
export const sendToWorkspaceAtom = atom<string[]>([])
