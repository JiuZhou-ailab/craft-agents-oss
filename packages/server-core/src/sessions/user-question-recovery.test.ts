// input: Real session question callbacks and SessionManager snapshots
// output: Lost-event recovery and answer/cancellation lifecycle checks without model calls
// pos: Regression guard for questions surviving renderer/project reconnection
import { expect, it } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionScopedToolCallbacks, unregisterSessionScopedToolCallbacks } from '@craft-agent/shared/agent/session-scoped-tool-callback-registry'
import type { SessionEvent, UserQuestionRequest } from '@craft-agent/shared/protocol'
import { SessionManager, createManagedSession } from './SessionManager'
import { wireAgentCallbacks } from './wire-agent-callbacks'

it('recovers unanswered questions from snapshots and removes only the resolved request', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'question-recovery-')))
  const workspace = { id: 'question-workspace', slug: 'question-workspace', name: 'Test', rootPath: root, createdAt: 1 }
  const managed = createManagedSession({ id: 'question-session' }, workspace, { messagesLoaded: true })
  const manager = new SessionManager((_id, session) => session.workspace)
  const events: SessionEvent[] = []
  ;(manager as any).sessions.set(managed.id, managed)
  ;(manager as any).sendEvent = (event: SessionEvent) => events.push(event)
  wireAgentCallbacks({} as any, managed, (manager as any).agentRuntime.deps)
  const ask = getSessionScopedToolCallbacks(managed.id)!.askUserQuestionFn!
  const question = (requestId: string): UserQuestionRequest => ({
    requestId, sessionId: managed.id,
    questions: [{ header: 'Choice', question: requestId, options: [], multiSelect: false }],
  })
  try {
    const first = ask(question('first'))
    const second = ask(question('second'))
    // A fresh renderer receives no original event, only session snapshots.
    expect(manager.getSessions(workspace.id)[0]!.pendingUserQuestions).toEqual([question('first'), question('second')])
    expect((await manager.getSession(managed.id))!.pendingUserQuestions).toEqual([question('first'), question('second')])
    expect(manager.respondToUserQuestion('other-session', 'first', { answers: {} })).toBe(false)
    expect(manager.respondToUserQuestion(managed.id, 'first', { answers: { first: 'answer' } })).toBe(true)
    expect(await first).toEqual({ answers: { first: 'answer' } })
    expect(manager.respondToUserQuestion(managed.id, 'first', { answers: {} })).toBe(false)
    expect(manager.getSessions(workspace.id)[0]!.pendingUserQuestions).toEqual([question('second')])
    expect(events).toContainEqual({ type: 'user_question_resolved', sessionId: managed.id, requestId: 'first', revision: { epoch: expect.any(String), sequence: 3 } })
    ;(manager as any).cancelPendingUserQuestionsForSession(managed.id)
    expect(await second).toEqual({ answers: {}, cancelled: true })
    expect((await manager.getSession(managed.id))!.pendingUserQuestions).toEqual([])
    expect(events).toContainEqual({ type: 'user_question_resolved', sessionId: managed.id, requestId: 'second', revision: { epoch: expect.any(String), sequence: 4 } })
  } finally {
    unregisterSessionScopedToolCallbacks(managed.id)
    manager.cleanup()
    rmSync(root, { recursive: true, force: true })
  }
})
