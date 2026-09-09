// input: Synthetic session atom state and mocked renderer session loading APIs
// output: Regression coverage for isolated session atoms and metadata update behavior
// pos: Guards renderer session atom performance contracts and loading correctness

import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createStore } from 'jotai'
import { acceptUserQuestionRevisionAtom, restoreUserQuestionsAtom, pendingUserQuestionsAtom, pendingUserQuestionAtomFamily } from '../pending-requests'
import type { Message, Session } from '../../../shared/types'
import {
  sessionAtomFamily,
  sessionMetaAtomFamily,
  sessionMetaMapAtom,
  sessionIdsAtom,
  loadedSessionsAtom,
  sessionMessagesLoadedAtomFamily,
  ensureSessionMessagesLoadedAtom,
  forceSessionMessagesReloadAtom,
  unloadSessionTranscriptAtom,
  reconcileCurrentSessionTranscriptWorkingSetAtom,
  reconcileSessionTranscriptWorkingSetAtom,
  resolveSessionTranscriptWorkingSet,
  touchSessionTranscriptAccess,
  __resetSessionTranscriptWorkingSetForTests,
  SESSION_TRANSCRIPT_WORKING_SET_EXTRA,
  addSessionAtom,
  removeSessionAtom,
  refreshSessionsMetadataAtom,
  initializeSessionsAtom,
  replaceLoadedSessionAtom,
  updateSessionAtom,
  updateSessionMetaAtom,
} from '../sessions'
import {
  beginSessionStatusMutation,
  commitOptimisticSessionStatus,
  invalidateSessionStatusMutation,
  ownsSessionStatusMutation,
  shouldRefreshGlobalSessionMetasForEvent,
} from '../session-status-transition'

const sessionsAtomSource = readFileSync(new URL('../sessions.ts', import.meta.url), 'utf8')

function msg(id: string, role: Message['role'] = 'user'): Message {
  return {
    id,
    role,
    content: `content:${id}`,
    timestamp: Date.now(),
  }
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: overrides.id ?? 'session-1',
    workspaceId: overrides.workspaceId ?? 'workspace-1',
    messages: overrides.messages ?? [],
    permissionMode: overrides.permissionMode ?? 'ask',
    supportsBranching: overrides.supportsBranching ?? true,
    ...overrides,
  } as Session
}

it('restores questions on project reload, stale reconnect and full session refresh', () => {
  const store = createStore()
  const question = { requestId: 'question-1', sessionId: 'question-session', questions: [] }
  const session = makeSession({ id: question.sessionId, pendingUserQuestions: [question] })
  store.set(initializeSessionsAtom, [session])
  expect(store.get(pendingUserQuestionAtomFamily(session.id))).toEqual(question)
  store.set(pendingUserQuestionsAtom, new Map())
  store.set(initializeSessionsAtom, [session])
  expect(store.get(pendingUserQuestionAtomFamily(session.id))).toEqual(question)
  store.set(pendingUserQuestionsAtom, new Map())
  store.set(refreshSessionsMetadataAtom, { sessions: [session], loadedSessionIds: new Set<string>(), removeMissing: false })
  expect(store.get(pendingUserQuestionAtomFamily(session.id))).toEqual(question)
  store.set(replaceLoadedSessionAtom, { ...session, pendingUserQuestions: [] })
  expect(store.get(pendingUserQuestionAtomFamily(session.id))).toBeUndefined()
  store.set(replaceLoadedSessionAtom, session)
  expect(store.get(pendingUserQuestionAtomFamily(session.id))).toEqual(question)
})

describe('session status transitions', () => {
  it('rolls back a failed optimistic status write when it is still current', async () => {
    let status: string | undefined = 'todo'
    const applied: Array<string | undefined> = []
    const error = new Error('offline')
    let reported: unknown

    const result = await commitOptimisticSessionStatus({
      nextStatus: 'done',
      getCurrentStatus: () => status,
      applyStatus: (nextStatus) => {
        status = nextStatus
        applied.push(nextStatus)
      },
      persist: () => Promise.reject(error),
      ownsMutation: () => true,
      onError: failure => {
        reported = failure
      },
    })

    expect(result).toBe('rolled_back')
    expect(status).toBe('todo')
    expect(applied).toEqual(['done', 'todo'])
    expect(reported).toBe(error)
  })

  it('does not let an older failed write overwrite a newer status choice', async () => {
    let status: string | undefined = 'todo'
    let rejectPersist!: (error: Error) => void
    const persist = new Promise<void>((_resolve, reject) => {
      rejectPersist = reject
    })

    const transition = commitOptimisticSessionStatus({
      nextStatus: 'in-progress',
      getCurrentStatus: () => status,
      applyStatus: nextStatus => {
        status = nextStatus
      },
      persist: () => persist,
      ownsMutation: () => true,
      onError: () => {},
    })

    status = 'done'
    rejectPersist(new Error('stale failure'))

    expect(await transition).toBe('superseded')
    expect(status).toBe('done')
  })

  it('does not let an older failed write roll back a newer choice with the same value', async () => {
    let status: string | undefined = 'todo'
    let rejectPersist!: (error: Error) => void
    const sessionId = 'session-repeated-status'
    const firstToken = beginSessionStatusMutation(sessionId)
    const persist = new Promise<void>((_resolve, reject) => {
      rejectPersist = reject
    })

    const transition = commitOptimisticSessionStatus({
      nextStatus: 'in-progress',
      getCurrentStatus: () => status,
      applyStatus: nextStatus => {
        status = nextStatus
      },
      persist: () => persist,
      ownsMutation: () => ownsSessionStatusMutation(sessionId, firstToken),
      onError: () => {},
    })

    status = 'done'
    beginSessionStatusMutation(sessionId)
    status = 'in-progress'
    rejectPersist(new Error('stale failure'))

    expect(await transition).toBe('superseded')
    expect(status).toBe('in-progress')
  })

  it('invalidates local mutation ownership when an authoritative status event arrives', () => {
    const token = beginSessionStatusMutation('session-authoritative')
    expect(ownsSessionStatusMutation('session-authoritative', token)).toBe(true)

    invalidateSessionStatusMutation('session-authoritative')

    expect(ownsSessionStatusMutation('session-authoritative', token)).toBe(false)
  })

  it('refreshes list membership changes while keeping display-only metadata precise', () => {
    expect(shouldRefreshGlobalSessionMetasForEvent('session_status_changed')).toBe(false)
    expect(shouldRefreshGlobalSessionMetasForEvent('name_changed')).toBe(false)
    expect(shouldRefreshGlobalSessionMetasForEvent('complete')).toBe(true)
    expect(shouldRefreshGlobalSessionMetasForEvent('session_deleted')).toBe(true)
    expect(shouldRefreshGlobalSessionMetasForEvent('session_archived')).toBe(true)
    expect(shouldRefreshGlobalSessionMetasForEvent('session_unarchived')).toBe(true)
    expect(shouldRefreshGlobalSessionMetasForEvent('session_flagged')).toBe(true)
    expect(shouldRefreshGlobalSessionMetasForEvent('session_unflagged')).toBe(true)
    expect(shouldRefreshGlobalSessionMetasForEvent('session_pinned')).toBe(true)
    expect(shouldRefreshGlobalSessionMetasForEvent('session_unpinned')).toBe(true)
  })
})

describe('session message loading atoms', () => {
  const originalWindow = globalThis.window

  afterEach(() => {
    if (originalWindow) {
      globalThis.window = originalWindow
    } else {
      // @ts-expect-error test cleanup for window shim
      delete globalThis.window
    }
  })

  it('replaceLoadedSessionAtom marks authoritative full sessions as loaded', () => {
    const store = createStore()
    const sessionId = 'session-1'

    store.set(replaceLoadedSessionAtom, makeSession({
      id: sessionId,
      messages: [msg('m1'), msg('m2', 'assistant')],
    }))

    expect(store.get(loadedSessionsAtom).has(sessionId)).toBe(true)
    expect(store.get(sessionAtomFamily(sessionId))?.messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(store.get(sessionMetaMapAtom).get(sessionId)?.messageCount).toBe(2)
  })

  it('replaceLoadedSessionAtom does not notify metadata subscribers when metadata is unchanged', () => {
    const store = createStore()
    const sessionId = 'session-1'

    store.set(replaceLoadedSessionAtom, makeSession({
      id: sessionId,
      name: 'Same',
      messages: [msg('m1'), msg('m2', 'assistant')],
      lastMessageAt: 100,
    }))
    const beforeMetaMap = store.get(sessionMetaMapAtom)
    let notifications = 0
    const unsubscribe = store.sub(sessionMetaMapAtom, () => {
      notifications += 1
    })

    store.set(replaceLoadedSessionAtom, makeSession({
      id: sessionId,
      name: 'Same',
      messages: [msg('m1'), msg('m2', 'assistant')],
      lastMessageAt: 100,
    }))

    expect(store.get(sessionMetaMapAtom)).toBe(beforeMetaMap)
    expect(notifications).toBe(0)

    unsubscribe()
  })

  it('replaceLoadedSessionAtom does not notify session subscribers when session values are unchanged', () => {
    const store = createStore()
    const sessionId = 'session-1'
    const messages = [msg('m1'), msg('m2', 'assistant')]
    const session = makeSession({
      id: sessionId,
      name: 'Same',
      messages,
      lastMessageAt: 100,
    })

    store.set(replaceLoadedSessionAtom, session)
    const before = store.get(sessionAtomFamily(sessionId))
    let notifications = 0
    const unsubscribe = store.sub(sessionAtomFamily(sessionId), () => {
      notifications += 1
    })

    store.set(replaceLoadedSessionAtom, { ...session, messages })

    expect(store.get(sessionAtomFamily(sessionId))).toBe(before)
    expect(notifications).toBe(0)

    unsubscribe()
  })

  it('exposes per-session loaded state without notifying on unrelated sessions', () => {
    const store = createStore()
    const currentLoadedAtom = sessionMessagesLoadedAtomFamily('s1')
    let notifications = 0

    const unsubscribe = store.sub(currentLoadedAtom, () => {
      notifications += 1
    })

    expect(store.get(currentLoadedAtom)).toBe(false)

    store.set(loadedSessionsAtom, new Set(['s2']))
    expect(store.get(currentLoadedAtom)).toBe(false)
    expect(notifications).toBe(0)

    store.set(loadedSessionsAtom, new Set(['s1', 's2']))
    expect(store.get(currentLoadedAtom)).toBe(true)
    expect(notifications).toBe(1)

    store.set(loadedSessionsAtom, new Set(['s1', 's3']))
    expect(store.get(currentLoadedAtom)).toBe(true)
    expect(notifications).toBe(1)

    unsubscribe()
  })

  it('exposes per-session metadata without notifying on unrelated sessions', () => {
    const store = createStore()
    const currentMetaAtom = sessionMetaAtomFamily('s1')
    const currentMeta = {
      id: 's1',
      workspaceId: 'workspace-1',
      name: 'Current',
    }
    let notifications = 0

    store.set(sessionMetaMapAtom, new Map([
      ['s1', currentMeta],
      ['s2', { id: 's2', workspaceId: 'workspace-1', name: 'Other' }],
    ]))

    const unsubscribe = store.sub(currentMetaAtom, () => {
      notifications += 1
    })

    expect(store.get(currentMetaAtom)?.name).toBe('Current')

    store.set(sessionMetaMapAtom, new Map([
      ['s1', currentMeta],
      ['s2', { id: 's2', workspaceId: 'workspace-1', name: 'Other renamed' }],
    ]))
    expect(store.get(currentMetaAtom)?.name).toBe('Current')
    expect(notifications).toBe(0)

    store.set(sessionMetaMapAtom, new Map([
      ['s1', { ...currentMeta, name: 'Current renamed' }],
      ['s2', { id: 's2', workspaceId: 'workspace-1', name: 'Other renamed' }],
    ]))
    expect(store.get(currentMetaAtom)?.name).toBe('Current renamed')
    expect(notifications).toBe(1)

    unsubscribe()
  })

  it('does not notify metadata subscribers when a session update leaves metadata unchanged', () => {
    const store = createStore()
    const sessionId = 's1'
    const session = makeSession({
      id: sessionId,
      messages: [msg('m1', 'assistant')],
      lastMessageAt: 100,
    })
    store.set(replaceLoadedSessionAtom, session)

    let notifications = 0
    const unsubscribe = store.sub(sessionMetaAtomFamily(sessionId), () => {
      notifications += 1
    })

    store.set(updateSessionAtom, sessionId, (prev) => prev && {
      ...prev,
      messages: prev.messages.map((message) => (
        message.id === 'm1' ? { ...message, content: `${message.content}:stream` } : message
      )),
    })

    expect(notifications).toBe(0)
    unsubscribe()
  })

  it('does not notify session subscribers when a session update leaves values unchanged', () => {
    const store = createStore()
    const sessionId = 's1'
    const session = makeSession({
      id: sessionId,
      messages: [msg('m1', 'assistant')],
      lastMessageAt: 100,
    })
    store.set(replaceLoadedSessionAtom, session)
    const before = store.get(sessionAtomFamily(sessionId))

    let notifications = 0
    const unsubscribe = store.sub(sessionAtomFamily(sessionId), () => {
      notifications += 1
    })

    store.set(updateSessionAtom, sessionId, (prev) => prev && { ...prev })

    expect(store.get(sessionAtomFamily(sessionId))).toBe(before)
    expect(notifications).toBe(0)
    unsubscribe()
  })

  it('does not inspect messages for no-op session updates with existing metadata', () => {
    const store = createStore()
    const sessionId = 's1'
    const messages = new Proxy([] as Message[], {
      get(target, prop, receiver) {
        if (prop === 'length') {
          throw new Error('no-op update should not read messages')
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const session = makeSession({
      id: sessionId,
      messages,
      lastMessageAt: 100,
    })
    store.set(sessionAtomFamily(sessionId), session)
    store.set(sessionMetaMapAtom, new Map([
      [sessionId, {
        id: sessionId,
        workspaceId: session.workspaceId,
        lastMessageAt: 100,
        messageCount: 0,
      }],
    ]))

    store.set(updateSessionAtom, sessionId, (prev) => prev)

    expect(store.get(sessionAtomFamily(sessionId))).toBe(session)
  })

  it('does not notify metadata subscribers when a metadata patch leaves values unchanged', () => {
    const store = createStore()
    const sessionId = 's1'

    store.set(initializeSessionsAtom, [makeSession({ id: sessionId, name: 'Same name' })])
    const before = store.get(sessionMetaMapAtom)

    let notifications = 0
    const unsubscribe = store.sub(sessionMetaMapAtom, () => {
      notifications += 1
    })

    store.set(updateSessionMetaAtom, sessionId, { name: 'Same name' })

    expect(store.get(sessionMetaMapAtom)).toBe(before)
    expect(notifications).toBe(0)
    unsubscribe()
  })

  it('addSessionAtom does not duplicate ids or notify global atoms for the same session', () => {
    const store = createStore()
    const session = makeSession({ id: 's1', name: 'Same', lastMessageAt: 100 })

    store.set(addSessionAtom, session)
    const beforeIds = store.get(sessionIdsAtom)
    const beforeMetaMap = store.get(sessionMetaMapAtom)
    const beforeLoaded = store.get(loadedSessionsAtom)
    let idNotifications = 0
    let metaNotifications = 0
    let loadedNotifications = 0
    const unsubscribeIds = store.sub(sessionIdsAtom, () => {
      idNotifications += 1
    })
    const unsubscribeMeta = store.sub(sessionMetaMapAtom, () => {
      metaNotifications += 1
    })
    const unsubscribeLoaded = store.sub(loadedSessionsAtom, () => {
      loadedNotifications += 1
    })

    store.set(addSessionAtom, makeSession({ id: 's1', name: 'Same', lastMessageAt: 100 }))

    expect(store.get(sessionIdsAtom)).toBe(beforeIds)
    expect(store.get(sessionIdsAtom)).toEqual(['s1'])
    expect(store.get(sessionMetaMapAtom)).toBe(beforeMetaMap)
    expect(store.get(loadedSessionsAtom)).toBe(beforeLoaded)
    expect(idNotifications).toBe(0)
    expect(metaNotifications).toBe(0)
    expect(loadedNotifications).toBe(0)

    unsubscribeIds()
    unsubscribeMeta()
    unsubscribeLoaded()
  })

  it('removeSessionAtom does not notify global atoms when the session is missing', () => {
    const store = createStore()
    store.set(addSessionAtom, makeSession({ id: 's1', name: 'Only session' }))
    const beforeIds = store.get(sessionIdsAtom)
    const beforeMetaMap = store.get(sessionMetaMapAtom)
    const beforeLoaded = store.get(loadedSessionsAtom)
    let idNotifications = 0
    let metaNotifications = 0
    let loadedNotifications = 0
    const unsubscribeIds = store.sub(sessionIdsAtom, () => {
      idNotifications += 1
    })
    const unsubscribeMeta = store.sub(sessionMetaMapAtom, () => {
      metaNotifications += 1
    })
    const unsubscribeLoaded = store.sub(loadedSessionsAtom, () => {
      loadedNotifications += 1
    })

    store.set(removeSessionAtom, 'missing')

    expect(store.get(sessionIdsAtom)).toBe(beforeIds)
    expect(store.get(sessionMetaMapAtom)).toBe(beforeMetaMap)
    expect(store.get(loadedSessionsAtom)).toBe(beforeLoaded)
    expect(idNotifications).toBe(0)
    expect(metaNotifications).toBe(0)
    expect(loadedNotifications).toBe(0)

    unsubscribeIds()
    unsubscribeMeta()
    unsubscribeLoaded()
  })

  it('forceSessionMessagesReloadAtom reloads an empty-but-loaded session', async () => {
    const store = createStore()
    const sessionId = 'session-1'
    const calls: string[] = []

    globalThis.window = {
      electronAPI: {
        getSessionMessages: async (id: string) => {
          calls.push(id)
          return makeSession({
            id,
            messages: [msg('m1'), msg('m2', 'assistant')],
          })
        },
      },
    } as unknown as typeof window

    store.set(sessionAtomFamily(sessionId), makeSession({ id: sessionId, messages: [] }))
    store.set(loadedSessionsAtom, new Set([sessionId]))

    const normalResult = await store.set(ensureSessionMessagesLoadedAtom, sessionId)
    expect(calls).toEqual([])
    expect(normalResult?.messages).toHaveLength(0)

    const forcedResult = await store.set(forceSessionMessagesReloadAtom, sessionId)
    expect(calls).toEqual([sessionId])
    expect(forcedResult?.messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(store.get(sessionAtomFamily(sessionId))?.messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(store.get(loadedSessionsAtom).has(sessionId)).toBe(true)
  })

  it('uses loaded lastFinalMessageId without scanning loaded messages', async () => {
    const store = createStore()
    const sessionId = 'session-1'
    const messages = new Proxy([msg('m1', 'assistant')] as Message[], {
      get(target, prop, receiver) {
        if (prop === '0') {
          throw new Error('lastFinalMessageId payload should avoid scanning messages')
        }
        return Reflect.get(target, prop, receiver)
      },
    })

    globalThis.window = {
      electronAPI: {
        getSessionMessages: async (id: string) => makeSession({
          id,
          messages,
          lastFinalMessageId: 'm1',
        }),
      },
    } as unknown as typeof window

    store.set(sessionAtomFamily(sessionId), makeSession({ id: sessionId, messages: [] }))
    store.set(sessionMetaMapAtom, new Map([
      [sessionId, { id: sessionId, workspaceId: 'workspace-1', messageCount: 1 }],
    ]))

    await store.set(ensureSessionMessagesLoadedAtom, sessionId)

    expect(store.get(sessionMetaMapAtom).get(sessionId)?.lastFinalMessageId).toBe('m1')
  })

  it('does not mark stale empty-response fallback as loaded', async () => {
    const store = createStore()
    const sessionId = 'session-1'
    const calls: string[] = []

    globalThis.window = {
      electronAPI: {
        getSessionMessages: async (id: string) => {
          calls.push(id)
          if (calls.length === 1) {
            return makeSession({ id, messages: [] })
          }
          return makeSession({
            id,
            messages: [msg('m1'), msg('m2', 'assistant')],
          })
        },
      },
    } as unknown as typeof window

    store.set(sessionAtomFamily(sessionId), makeSession({
      id: sessionId,
      messages: [msg('local-1'), msg('local-2', 'assistant')],
    }))

    const firstResult = await store.set(ensureSessionMessagesLoadedAtom, sessionId)
    expect(firstResult?.messages.map((message) => message.id)).toEqual(['local-1', 'local-2'])
    expect(store.get(loadedSessionsAtom).has(sessionId)).toBe(false)

    const secondResult = await store.set(forceSessionMessagesReloadAtom, sessionId)
    expect(calls).toEqual([sessionId, sessionId])
    expect(secondResult?.messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(store.get(loadedSessionsAtom).has(sessionId)).toBe(true)
  })
})

describe('session transcript working set', () => {
  const originalWindow = globalThis.window

  afterEach(() => {
    __resetSessionTranscriptWorkingSetForTests()
    if (originalWindow) {
      globalThis.window = originalWindow
    } else {
      // @ts-expect-error test cleanup for window shim
      delete globalThis.window
    }
  })

  it('pins open sessions and fills remaining slots from recency', () => {
    __resetSessionTranscriptWorkingSetForTests()
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      touchSessionTranscriptAccess(id)
    }
    const keep = resolveSessionTranscriptWorkingSet(['open-1', 'open-2'])
    expect(keep.slice(0, 2)).toEqual(['open-1', 'open-2'])
    expect(keep.length).toBe(2 + SESSION_TRANSCRIPT_WORKING_SET_EXTRA)
    // Soft pins are the most recent non-open ids (c,d,e → last EXTRA)
    expect(keep.slice(2)).toEqual(['d', 'e'].slice(-SESSION_TRANSCRIPT_WORKING_SET_EXTRA))
  })

  it('unloadSessionTranscriptAtom drops messages and loaded flag but keeps the shell', () => {
    const store = createStore()
    const sessionId = 'session-1'
    store.set(sessionAtomFamily(sessionId), makeSession({
      id: sessionId,
      messages: [msg('m1'), msg('m2', 'assistant')],
      name: 'Keep me',
    }))
    store.set(loadedSessionsAtom, new Set([sessionId]))

    expect(store.set(unloadSessionTranscriptAtom, sessionId)).toBe(true)
    const shell = store.get(sessionAtomFamily(sessionId))
    expect(shell?.name).toBe('Keep me')
    expect(shell?.messages).toEqual([])
    expect(store.get(loadedSessionsAtom).has(sessionId)).toBe(false)
  })

  it('does not unload a processing session transcript', () => {
    const store = createStore()
    const sessionId = 'streaming'
    store.set(sessionAtomFamily(sessionId), makeSession({
      id: sessionId,
      isProcessing: true,
      messages: [msg('m1'), msg('m2', 'assistant')],
    }))
    store.set(loadedSessionsAtom, new Set([sessionId]))

    expect(store.set(unloadSessionTranscriptAtom, sessionId)).toBe(false)
    expect(store.get(sessionAtomFamily(sessionId))?.messages).toHaveLength(2)
    expect(store.get(loadedSessionsAtom).has(sessionId)).toBe(true)
  })

  it('evicts an off-screen transcript once background processing ends', () => {
    const store = createStore()
    store.set(sessionAtomFamily('current'), makeSession({ id: 'current', messages: [msg('current')] }))
    store.set(sessionAtomFamily('background'), makeSession({
      id: 'background',
      isProcessing: true,
      messages: [msg('background')],
    }))
    store.set(loadedSessionsAtom, new Set(['current', 'background']))

    store.set(reconcileSessionTranscriptWorkingSetAtom, ['current'])
    expect(store.get(loadedSessionsAtom).has('background')).toBe(true)

    store.set(sessionAtomFamily('background'), {
      ...store.get(sessionAtomFamily('background'))!,
      isProcessing: false,
    })
    store.set(reconcileCurrentSessionTranscriptWorkingSetAtom)

    expect(store.get(loadedSessionsAtom).has('background')).toBe(false)
    expect(store.get(sessionAtomFamily('background'))?.messages).toEqual([])
  })

  it('reconcileSessionTranscriptWorkingSetAtom evicts out-of-set loaded transcripts', () => {
    const store = createStore()
    for (const id of ['s1', 's2', 's3', 's4', 's5']) {
      store.set(sessionAtomFamily(id), makeSession({
        id,
        messages: [msg(`${id}-m1`), msg(`${id}-m2`, 'assistant')],
      }))
    }
    store.set(loadedSessionsAtom, new Set(['s1', 's2', 's3', 's4', 's5']))
    __resetSessionTranscriptWorkingSetForTests()

    // Open only s5; with EXTRA=2 and empty recency, only s5 is kept.
    store.set(reconcileSessionTranscriptWorkingSetAtom, ['s5'])

    expect(store.get(loadedSessionsAtom).has('s5')).toBe(true)
    expect(store.get(sessionAtomFamily('s5'))?.messages).toHaveLength(2)

    for (const id of ['s1', 's2', 's3', 's4']) {
      expect(store.get(loadedSessionsAtom).has(id)).toBe(false)
      expect(store.get(sessionAtomFamily(id))?.messages).toEqual([])
    }
  })

  it('reconcile keeps a small recency buffer beyond open sessions', () => {
    const store = createStore()
    for (const id of ['a', 'b', 'c', 'd']) {
      store.set(sessionAtomFamily(id), makeSession({
        id,
        messages: [msg(`${id}-m`)],
      }))
    }
    store.set(loadedSessionsAtom, new Set(['a', 'b', 'c', 'd']))
    __resetSessionTranscriptWorkingSetForTests()
    // Simulate prior visits: a,b,c then open d
    for (const id of ['a', 'b', 'c']) touchSessionTranscriptAccess(id)

    store.set(reconcileSessionTranscriptWorkingSetAtom, ['d'])

    const loaded = store.get(loadedSessionsAtom)
    expect(loaded.has('d')).toBe(true)
    // EXTRA most-recent of a,b,c → b,c (if EXTRA=2)
    expect(loaded.has('c')).toBe(true)
    expect(loaded.has('b')).toBe(SESSION_TRANSCRIPT_WORKING_SET_EXTRA >= 2)
    expect(loaded.has('a')).toBe(SESSION_TRANSCRIPT_WORKING_SET_EXTRA >= 3)
    expect(loaded.size).toBe(1 + Math.min(SESSION_TRANSCRIPT_WORKING_SET_EXTRA, 3))
  })

  it('evicts an async transcript load against the latest hard pins', async () => {
    const store = createStore()
    let resolveLoad!: (session: Session) => void
    const delayedLoad = new Promise<Session>((resolve) => {
      resolveLoad = resolve
    })
    globalThis.window = {
      electronAPI: {
        getSessionMessages: async () => delayedLoad,
      },
    } as unknown as typeof window

    store.set(sessionAtomFamily('old'), makeSession({ id: 'old', messages: [] }))
    store.set(reconcileSessionTranscriptWorkingSetAtom, ['old'])
    const pending = store.set(ensureSessionMessagesLoadedAtom, 'old')

    // Move far enough through recency that the original request is no longer
    // a hard or soft pin before its IPC payload arrives.
    for (const id of ['current', 'next-1', 'next-2', 'next-3']) {
      store.set(reconcileSessionTranscriptWorkingSetAtom, [id])
    }

    resolveLoad(makeSession({ id: 'old', messages: [msg('old-message')] }))
    await pending

    expect(store.get(loadedSessionsAtom).has('old')).toBe(false)
    expect(store.get(sessionAtomFamily('old'))?.messages).toEqual([])
  })
})

describe('refreshSessionsMetadataAtom', () => {
  it('detects refreshed metadata changes while upserting instead of scanning the full retained map', () => {
    const refreshStart = sessionsAtomSource.indexOf('export const refreshSessionsMetadataAtom')
    const refreshEnd = sessionsAtomSource.indexOf('/**\n * Action atom: add a new session', refreshStart)
    const refreshSource = sessionsAtomSource.slice(refreshStart, refreshEnd)

    expect(refreshSource).not.toContain('for (const [id, nextMeta] of nextMetaMap)')
    expect(refreshSource).toContain('metadataChanged = true')
    expect(refreshSource).toContain('const latestIds = new Set<string>()')
    expect(refreshSource).not.toContain('new Set(sessions.map')
  })

  it('does not resort ids when refreshed metadata leaves lastMessageAt unchanged', () => {
    const store = createStore()
    store.set(initializeSessionsAtom, [
      makeSession({ id: 's1', name: 'First', lastMessageAt: 200 }),
      makeSession({ id: 's2', name: 'Second', lastMessageAt: 100 }),
    ])
    const beforeIds = store.get(sessionIdsAtom)
    const originalSort = Array.prototype.sort
    let sortCalls = 0
    Array.prototype.sort = function sortWithCount<T>(this: T[], compareFn?: (a: T, b: T) => number) {
      sortCalls += 1
      return originalSort.call(this, compareFn)
    } as typeof Array.prototype.sort

    try {
      store.set(refreshSessionsMetadataAtom, {
        sessions: [
          makeSession({ id: 's1', name: 'First renamed', lastMessageAt: 200 }),
          makeSession({ id: 's2', name: 'Second', lastMessageAt: 100 }),
        ],
        loadedSessionIds: new Set<string>(),
      })
    } finally {
      Array.prototype.sort = originalSort
    }

    expect(sortCalls).toBe(0)
    expect(store.get(sessionIdsAtom)).toBe(beforeIds)
    expect(store.get(sessionMetaMapAtom).get('s1')?.name).toBe('First renamed')
  })

  it('initializes sorted ids without mutating the caller session array', () => {
    const initializeStart = sessionsAtomSource.indexOf('export const initializeSessionsAtom')
    const initializeEnd = sessionsAtomSource.indexOf('/**\n * Action atom: refresh session metadata', initializeStart)
    const initializeSource = sessionsAtomSource.slice(initializeStart, initializeEnd)
    const store = createStore()
    const sessions = [
      makeSession({ id: 'older', lastMessageAt: 100 }),
      makeSession({ id: 'newer', lastMessageAt: 200 }),
    ]

    expect(initializeSource).toContain('const newIdSet = new Set<string>()')
    expect(initializeSource).not.toContain('new Set(sessions.map')

    store.set(initializeSessionsAtom, sessions)

    expect(sessions.map(session => session.id)).toEqual(['older', 'newer'])
    expect(store.get(sessionIdsAtom)).toEqual(['newer', 'older'])
  })

  it('preserves messages for already-loaded sessions', () => {
    const store = createStore()
    const existingMessages = [msg('m1'), msg('m2', 'assistant')]

    // Pre-populate: session has messages and is marked loaded
    store.set(sessionAtomFamily('s1'), makeSession({ id: 's1', messages: existingMessages }))
    store.set(loadedSessionsAtom, new Set(['s1']))

    // Refresh with metadata-only payload (empty messages, like getSessions returns)
    const freshSessions = [makeSession({ id: 's1', messages: [] })]
    store.set(refreshSessionsMetadataAtom, {
      sessions: freshSessions,
      loadedSessionIds: new Set(['s1']),
    })

    // Messages should be preserved from the existing atom
    const session = store.get(sessionAtomFamily('s1'))
    expect(session?.messages.map(m => m.id)).toEqual(['m1', 'm2'])
  })

  it('marks sessions as unloaded when atom was cleared but loadedSessionIds still tracked them', () => {
    const store = createStore()

    // Session was previously loaded, but its atom was cleared (e.g., by remove + re-add)
    // while loadedSessionsAtom still tracks it. The atom value is null.
    store.set(loadedSessionsAtom, new Set(['s1']))
    // sessionAtomFamily('s1') defaults to null — no store.set needed

    // Refresh — s1 is in loadedSessionIds but current atom is null,
    // so shouldPreserveMessages is false. Since it was in loadedSessionIds,
    // it should be removed so lazy-loading re-fetches messages.
    const freshSessions = [makeSession({ id: 's1', messages: [] })]
    store.set(refreshSessionsMetadataAtom, {
      sessions: freshSessions,
      loadedSessionIds: new Set(['s1']),
    })

    expect(store.get(loadedSessionsAtom).has('s1')).toBe(false)
  })

  it('removes stale sessions from all atoms', () => {
    const store = createStore()

    // Initialize with two sessions via initializeSessionsAtom
    store.set(initializeSessionsAtom, [
      makeSession({ id: 's1' }),
      makeSession({ id: 's2' }),
    ])
    expect(store.get(sessionMetaMapAtom).size).toBe(2)
    expect(store.get(sessionIdsAtom)).toContain('s2')

    // Refresh with only s1 — s2 should be removed
    store.set(refreshSessionsMetadataAtom, {
      sessions: [makeSession({ id: 's1' })],
      loadedSessionIds: new Set<string>(),
    })

    expect(store.get(sessionMetaMapAtom).has('s2')).toBe(false)
    expect(store.get(sessionIdsAtom)).not.toContain('s2')
    expect(store.get(sessionAtomFamily('s2'))).toBe(null)
  })

  it('preserves omitted sessions when removeMissing is false', () => {
    const store = createStore()

    store.set(initializeSessionsAtom, [
      makeSession({ id: 's1', name: 'First', lastMessageAt: 200 }),
      makeSession({ id: 's2', name: 'Second', lastMessageAt: 100 }),
    ])

    const result = store.set(refreshSessionsMetadataAtom, {
      sessions: [makeSession({ id: 's1', name: 'First refreshed', lastMessageAt: 300 })],
      loadedSessionIds: new Set<string>(),
      removeMissing: false,
    })

    expect(result.has('s1')).toBe(true)
    expect(result.has('s2')).toBe(true)
    expect(result.get('s1')?.name).toBe('First refreshed')
    expect(result.get('s2')?.name).toBe('Second')

    const storeMap = store.get(sessionMetaMapAtom)
    expect(storeMap.has('s2')).toBe(true)
    expect(store.get(sessionIdsAtom)).toEqual(['s1', 's2'])
    expect(store.get(sessionAtomFamily('s2'))?.name).toBe('Second')
  })

  it('non-destructive refresh still preserves loaded messages for returned sessions', () => {
    const store = createStore()
    const existingMessages = [msg('m1'), msg('m2', 'assistant')]

    store.set(initializeSessionsAtom, [
      makeSession({ id: 's1', name: 'First', messages: [] }),
      makeSession({ id: 's2', name: 'Second', messages: [] }),
    ])
    store.set(sessionAtomFamily('s1'), makeSession({ id: 's1', name: 'First', messages: existingMessages }))
    store.set(loadedSessionsAtom, new Set(['s1']))

    store.set(refreshSessionsMetadataAtom, {
      sessions: [makeSession({ id: 's1', name: 'First refreshed', messages: [] })],
      loadedSessionIds: new Set(['s1']),
      removeMissing: false,
    })

    expect(store.get(sessionAtomFamily('s1'))?.messages.map(m => m.id)).toEqual(['m1', 'm2'])
    expect(store.get(sessionMetaMapAtom).get('s1')?.name).toBe('First refreshed')
    expect(store.get(sessionMetaMapAtom).get('s2')?.name).toBe('Second')
  })

  it('updates metadata map and returns it', () => {
    const store = createStore()

    const sessions = [
      makeSession({ id: 's1', name: 'First' }),
      makeSession({ id: 's2', name: 'Second' }),
    ]

    const result = store.set(refreshSessionsMetadataAtom, {
      sessions,
      loadedSessionIds: new Set<string>(),
    })

    // Returned map matches store state
    expect(result.size).toBe(2)
    expect(result.get('s1')?.name).toBe('First')
    expect(result.get('s2')?.name).toBe('Second')

    // Store is consistent
    const storeMap = store.get(sessionMetaMapAtom)
    expect(storeMap.size).toBe(2)
    expect(storeMap.get('s1')?.name).toBe('First')

    // IDs are set
    expect(store.get(sessionIdsAtom)).toHaveLength(2)
  })

  it('does not notify metadata or id subscribers when refresh metadata is unchanged', () => {
    const store = createStore()
    const sessions = [
      makeSession({ id: 's1', name: 'First', lastMessageAt: 200 }),
      makeSession({ id: 's2', name: 'Second', lastMessageAt: 100 }),
    ]

    store.set(refreshSessionsMetadataAtom, {
      sessions,
      loadedSessionIds: new Set<string>(),
    })
    const beforeMetaMap = store.get(sessionMetaMapAtom)
    const beforeIds = store.get(sessionIdsAtom)
    const beforeSession = store.get(sessionAtomFamily('s1'))
    let metaNotifications = 0
    let idNotifications = 0
    let sessionNotifications = 0
    const unsubscribeMeta = store.sub(sessionMetaMapAtom, () => {
      metaNotifications += 1
    })
    const unsubscribeIds = store.sub(sessionIdsAtom, () => {
      idNotifications += 1
    })
    const unsubscribeSession = store.sub(sessionAtomFamily('s1'), () => {
      sessionNotifications += 1
    })

    store.set(refreshSessionsMetadataAtom, {
      sessions: [
        makeSession({ id: 's1', name: 'First', lastMessageAt: 200 }),
        makeSession({ id: 's2', name: 'Second', lastMessageAt: 100 }),
      ],
      loadedSessionIds: new Set<string>(),
    })

    expect(store.get(sessionMetaMapAtom)).toBe(beforeMetaMap)
    expect(store.get(sessionIdsAtom)).toBe(beforeIds)
    expect(store.get(sessionAtomFamily('s1'))).toBe(beforeSession)
    expect(metaNotifications).toBe(0)
    expect(idNotifications).toBe(0)
    expect(sessionNotifications).toBe(0)

    unsubscribeMeta()
    unsubscribeIds()
    unsubscribeSession()
  })

  it('still repairs id ordering when unchanged metadata is currently out of order', () => {
    const store = createStore()

    store.set(sessionMetaMapAtom, new Map([
      ['older', {
        id: 'older',
        workspaceId: 'workspace-1',
        name: 'Older',
        lastMessageAt: 100,
        messageCount: 0,
      }],
      ['newer', {
        id: 'newer',
        workspaceId: 'workspace-1',
        name: 'Newer',
        lastMessageAt: 200,
        messageCount: 0,
      }],
    ]))
    store.set(sessionIdsAtom, ['older', 'newer'])

    store.set(refreshSessionsMetadataAtom, {
      sessions: [
        makeSession({ id: 'older', name: 'Older', lastMessageAt: 100 }),
        makeSession({ id: 'newer', name: 'Newer', lastMessageAt: 200 }),
      ],
      loadedSessionIds: new Set<string>(),
    })

    expect(store.get(sessionIdsAtom)).toEqual(['newer', 'older'])
  })
})


it('ignores question snapshots older than live events and accepts a restarted Host', () => {
  const store = createStore()
  const question = { requestId: 'ordered-question', sessionId: 'ordered-session', questions: [] }
  const revision = (sequence: number, epoch = 'host-1') => ({ epoch, sequence })
  const snapshot = (questions: typeof question[], sequence: number, epoch = 'host-1') => makeSession({
    id: question.sessionId, pendingUserQuestions: questions, userQuestionRevision: revision(sequence, epoch),
  })
  store.set(acceptUserQuestionRevisionAtom, question.sessionId, revision(1))
  store.set(pendingUserQuestionsAtom, new Map([[question.sessionId, [question]]]))
  store.set(restoreUserQuestionsAtom, snapshot([], 0))
  expect(store.get(pendingUserQuestionAtomFamily(question.sessionId))).toEqual(question)
  store.set(acceptUserQuestionRevisionAtom, question.sessionId, revision(2))
  store.set(pendingUserQuestionsAtom, new Map())
  store.set(restoreUserQuestionsAtom, snapshot([question], 1))
  expect(store.get(pendingUserQuestionAtomFamily(question.sessionId))).toBeUndefined()
  store.set(restoreUserQuestionsAtom, snapshot([question], 0, 'host-2'))
  expect(store.get(pendingUserQuestionAtomFamily(question.sessionId))).toEqual(question)
})
