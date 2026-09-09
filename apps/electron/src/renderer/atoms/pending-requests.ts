// input: Live prompt events and authoritative session question snapshots
// output: Per-session pending request atoms and question recovery on session hydration
// pos: Isolates pending prompt subscriptions from broad app shell context

import { atom } from 'jotai'
import { atomFamily } from 'jotai-family'
import type { CredentialRequest, PermissionRequest, UserQuestionRequest, Session } from '../../shared/types'

export const pendingPermissionsAtom = atom<Map<string, PermissionRequest[]>>(new Map())
export const pendingCredentialsAtom = atom<Map<string, CredentialRequest[]>>(new Map())
export const pendingUserQuestionsAtom = atom<Map<string, UserQuestionRequest[]>>(new Map())

const userQuestionRevisionsAtom = atom(new Map<string, NonNullable<Session['userQuestionRevision']>>())

export const acceptUserQuestionRevisionAtom = atom(null, (get, set, sessionId: string, revision: Session['userQuestionRevision']) => {
  // Hosts predating question recovery do not send revisions.
  if (!revision) return true
  const revisions = get(userQuestionRevisionsAtom)
  const current = revisions.get(sessionId)
  if (current?.epoch === revision.epoch && current.sequence > revision.sequence) return false
  if (current !== revision) set(userQuestionRevisionsAtom, new Map(revisions).set(sessionId, revision))
  return true
})

export const restoreUserQuestionsAtom = atom(null, (get, set, session: Session) => {
  // Older hosts omit this field; only an explicit snapshot can replace live requests.
  if (!session.pendingUserQuestions) return
  if (!set(acceptUserQuestionRevisionAtom, session.id, session.userQuestionRevision)) return
  const current = get(pendingUserQuestionsAtom)
  const queue = current.get(session.id) ?? []
  if (queue.length === session.pendingUserQuestions.length
    && queue.every((request, index) => request.requestId === session.pendingUserQuestions![index]!.requestId)) return
  const next = new Map(current)
  if (session.pendingUserQuestions.length) next.set(session.id, session.pendingUserQuestions)
  else next.delete(session.id)
  set(pendingUserQuestionsAtom, next)
})

export const pendingPermissionAtomFamily = atomFamily(
  (sessionId: string) => atom((get) => get(pendingPermissionsAtom).get(sessionId)?.[0])
)

export const pendingCredentialAtomFamily = atomFamily(
  (sessionId: string) => atom((get) => get(pendingCredentialsAtom).get(sessionId)?.[0])
)

export const pendingUserQuestionAtomFamily = atomFamily(
  (sessionId: string) => atom((get) => get(pendingUserQuestionsAtom).get(sessionId)?.[0])
)

/**
 * Session ids with any outstanding prompt.
 *
 * Aggregate views (collapsed groups, rails) need to answer "does anything in
 * here need me?" without subscribing per session, which a `atomFamily` lookup
 * inside a render loop cannot do.
 */
export const sessionIdsWithPendingPromptAtom = atom((get) => {
  const ids = new Set<string>()
  for (const [sessionId, requests] of get(pendingPermissionsAtom)) {
    if (requests.length > 0) ids.add(sessionId)
  }
  for (const [sessionId, requests] of get(pendingCredentialsAtom)) {
    if (requests.length > 0) ids.add(sessionId)
  }
  for (const [sessionId, requests] of get(pendingUserQuestionsAtom)) {
    if (requests.length > 0) ids.add(sessionId)
  }
  return ids
})

/**
 * Whether the session is blocked on any human response.
 *
 * Covers credentials as well as permissions: both stop the turn until someone
 * answers, so treating only permissions as "pending" left credential-blocked
 * sessions indistinguishable from healthy ones.
 */
export const hasPendingPromptAtomFamily = atomFamily(
  (sessionId: string) => atom((get) => (
    (get(pendingPermissionsAtom).get(sessionId)?.length ?? 0) > 0
    || (get(pendingCredentialsAtom).get(sessionId)?.length ?? 0) > 0
    || (get(pendingUserQuestionsAtom).get(sessionId)?.length ?? 0) > 0
  ))
)
