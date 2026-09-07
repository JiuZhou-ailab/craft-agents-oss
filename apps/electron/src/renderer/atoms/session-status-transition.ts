// input: Session metadata events and one renderer-side status mutation
// output: Cross-workspace rail refresh policy and ownership-aware optimistic status commits
// pos: Session-status transition boundary independent from the broader session atom store

import type { SessionEvent, SessionStatus } from '../../shared/types'

const latestMutationTokens = new Map<string, symbol>()

export function beginSessionStatusMutation(sessionId: string): symbol {
  const token = Symbol(sessionId)
  latestMutationTokens.set(sessionId, token)
  return token
}

export function ownsSessionStatusMutation(sessionId: string, token: symbol): boolean {
  return latestMutationTokens.get(sessionId) === token
}

export function invalidateSessionStatusMutation(sessionId: string): void {
  latestMutationTokens.delete(sessionId)
}

const GLOBAL_SESSION_META_REFRESH_EVENT_TYPES = new Set<SessionEvent['type']>([
  'complete',
  'interrupted',
  'title_generated',
  'session_deleted',
  'session_created',
  // Archiving changes membership in every cached workspace snapshot.
  'session_archived',
  'session_unarchived',
  // The ActivityRail can render cached sessions owned by another runtime.
  'session_flagged',
  'session_unflagged',
  'session_pinned',
  'session_unpinned',
  'user_message',
])

/**
 * Global session metadata is a cross-workspace snapshot. Events whose exact
 * fields are already applied to the active workspace atom usually need no
 * global refresh. Membership-changing flag, pin, and archive events refresh
 * cached sessions owned by inactive workspaces as well.
 */
export function shouldRefreshGlobalSessionMetasForEvent(eventType: SessionEvent['type']): boolean {
  return GLOBAL_SESSION_META_REFRESH_EVENT_TYPES.has(eventType)
}

interface CommitOptimisticSessionStatusInput {
  nextStatus: SessionStatus
  getCurrentStatus: () => SessionStatus | undefined
  applyStatus: (status: SessionStatus | undefined) => void
  persist: () => Promise<unknown>
  ownsMutation: () => boolean
  onError: (error: unknown) => void
}

export type OptimisticSessionStatusResult =
  | 'unchanged'
  | 'committed'
  | 'rolled_back'
  | 'superseded'

/**
 * Commits one status choice with an ownership-aware rollback.
 *
 * Comparing status values is insufficient because a later choice may return
 * to the same value. Only the latest mutation token may roll itself back.
 */
export async function commitOptimisticSessionStatus({
  nextStatus,
  getCurrentStatus,
  applyStatus,
  persist,
  ownsMutation,
  onError,
}: CommitOptimisticSessionStatusInput): Promise<OptimisticSessionStatusResult> {
  const previousStatus = getCurrentStatus()
  if (previousStatus === nextStatus) return 'unchanged'

  applyStatus(nextStatus)
  try {
    await persist()
    return 'committed'
  } catch (error) {
    if (ownsMutation() && getCurrentStatus() === nextStatus) {
      applyStatus(previousStatus)
      onError(error)
      return 'rolled_back'
    }
    onError(error)
    return 'superseded'
  }
}
