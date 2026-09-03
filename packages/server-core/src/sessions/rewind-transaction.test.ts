// input: SessionManager product messages, queue state, and rewind phase requests
// output: Regression coverage for rewind CAS, runtime serialization, and safe rejection
// pos: Guards the product-side half of the Pi-owned rewind transaction

import { afterEach, expect, it, jest } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ConversationRewindRequest,
  ConversationRewindResult,
} from '@craft-agent/shared/agent/backend/types'
import { SessionManager, createManagedSession, setSessionRuntimeHooks } from './SessionManager.ts'

afterEach(() => {
  setSessionRuntimeHooks({
    ensureManagedModelAccessToken: async () => ({ token: 'managed-token', refreshed: false }),
  })
})

function createHarness() {
  const rootPath = realpathSync(mkdtempSync(join(tmpdir(), 'rewind-transaction-')))
  mkdirSync(join(rootPath, '.craft-agent'), { recursive: true })
  writeFileSync(join(rootPath, '.craft-agent', 'config.json'), JSON.stringify({
    id: 'directory-rewind',
    name: 'Rewind Workspace',
    slug: 'rewind-workspace',
    createdAt: 1,
    updatedAt: 1,
  }))
  const manager = new SessionManager((_workspaceId, managed) => managed.workspace)
  const managed = createManagedSession(
    { id: `rewind-session-${randomUUID()}`, name: 'rewind test' },
    {
      id: 'rewind-workspace',
      name: 'Rewind Workspace',
      rootPath,
      directoryConfigId: 'directory-rewind',
      createdAt: Date.now(),
    } as never,
    { messagesLoaded: true },
  )
  managed.messages = [
    { id: 'user-1', role: 'user', content: 'first', timestamp: 1 },
    { id: 'assistant-1', role: 'assistant', content: 'answer', timestamp: 2 },
    { id: 'user-2', role: 'user', content: 'second', timestamp: 3 },
  ]
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(managed.id, managed)
  const handle = (request: ConversationRewindRequest) => (
    manager as unknown as {
      handleConversationRewind: (
        session: typeof managed,
        request: ConversationRewindRequest,
      ) => Promise<ConversationRewindResult>
    }
  ).handleConversationRewind(managed, request)
  return { rootPath, manager, managed, handle }
}

it('rejects a stale rewind reservation without deleting a newly queued message', async () => {
  const { rootPath, managed, handle } = createHarness()
  try {
    const prepared = await handle({
      phase: 'prepare',
      boundary: { retainThroughMessageId: 'assistant-1' },
    })
    if (prepared.phase !== 'prepared') throw new Error('rewind was not prepared')

    managed.messageQueue.push({ message: 'queued after prepare', messageId: 'queued-1' })

    await expect(handle({
      phase: 'commit',
      token: prepared.token,
      expectedRevision: prepared.revision,
    })).rejects.toThrow('Conversation changed after rewind was prepared')
    expect(managed.messages.map(message => message.id)).toEqual(['user-1', 'assistant-1', 'user-2'])
    expect(managed.messageQueue.map(entry => entry.messageId)).toEqual(['queued-1'])
  } finally {
    rmSync(rootPath, { recursive: true, force: true })
  }
})

it('manual rewind refuses active work without clearing the queue', async () => {
  const { rootPath, manager, managed } = createHarness()
  try {
    managed.isProcessing = true
    managed.messageQueue.push({ message: 'keep me', messageId: 'queued-1' })

    await expect(manager.rewindUserMessage(managed.id, 'user-2'))
      .rejects.toThrow('Cannot rewind while this conversation is processing or has queued messages')
    expect(managed.messageQueue.map(entry => entry.messageId)).toEqual(['queued-1'])
    expect(managed.messages.map(message => message.id)).toEqual(['user-1', 'assistant-1', 'user-2'])
  } finally {
    rmSync(rootPath, { recursive: true, force: true })
  }
})

it('rewinds through the existing idle Pi agent without resolving a new model runtime', async () => {
  const { rootPath, manager, managed } = createHarness()
  try {
    const rewindUserMessage = jest.fn().mockResolvedValue(undefined)
    managed.agent = {
      isProcessing: () => false,
      rewindUserMessage,
    } as never

    const piSessionsPath = join(rootPath, '.craft-agent', 'sessions', managed.id, '.pi-sessions')
    mkdirSync(piSessionsPath, { recursive: true })
    writeFileSync(join(piSessionsPath, 'session.jsonl'), '{}\n')

    const getOrCreateAgentLocked = jest.fn(() => {
      throw new Error('rewind must not resolve or restart the model runtime')
    })
    ;(manager as unknown as { getOrCreateAgentLocked: typeof getOrCreateAgentLocked }).getOrCreateAgentLocked = getOrCreateAgentLocked

    await expect(manager.rewindUserMessage(managed.id, 'user-2'))
      .resolves.toEqual({ draftText: 'second' })
    expect(rewindUserMessage).toHaveBeenCalledWith('user-2')
    expect(getOrCreateAgentLocked).not.toHaveBeenCalled()
  } finally {
    rmSync(rootPath, { recursive: true, force: true })
  }
})

it('holds runtime disposal until Pi rewind settles', async () => {
  const { rootPath, manager, managed } = createHarness()
  try {
    let markStarted!: () => void
    let finishRewind!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const rewindGate = new Promise<void>(resolve => { finishRewind = resolve })
    const dispose = jest.fn()
    managed.llmConnection = 'test-connection'
    managed.agent = {
      isProcessing: () => false,
      rewindUserMessage: async () => {
        markStarted()
        await rewindGate
      },
      dispose,
    } as never

    const piSessionsPath = join(rootPath, '.craft-agent', 'sessions', managed.id, '.pi-sessions')
    mkdirSync(piSessionsPath, { recursive: true })
    writeFileSync(join(piSessionsPath, 'session.jsonl'), '{}\n')

    const rewind = manager.rewindUserMessage(managed.id, 'user-2')
    await started
    const disposal = manager.disposeConnectionRuntimes('test-connection')
    await Promise.resolve()
    expect(dispose).not.toHaveBeenCalled()

    finishRewind()
    await expect(rewind).resolves.toEqual({ draftText: 'second' })
    await disposal
    expect(dispose).toHaveBeenCalledTimes(1)
  } finally {
    rmSync(rootPath, { recursive: true, force: true })
  }
})

it('holds runtime invalidation until a local rewind is durable', async () => {
  const { rootPath, manager, managed } = createHarness()
  try {
    let markFlushStarted!: () => void
    let finishFlush!: () => void
    const flushStarted = new Promise<void>(resolve => { markFlushStarted = resolve })
    const flushGate = new Promise<void>(resolve => { finishFlush = resolve })
    const originalFlush = manager.flushSession.bind(manager)
    ;(manager as unknown as { flushSession: (sessionId: string) => Promise<void> }).flushSession = async sessionId => {
      markFlushStarted()
      await flushGate
      await originalFlush(sessionId)
    }
    managed.llmConnection = 'test-connection'

    const rewind = manager.rewindUserMessage(managed.id, 'user-1')
    await flushStarted
    let invalidationSettled = false
    const invalidation = manager.disposeConnectionRuntimes('test-connection').then(() => {
      invalidationSettled = true
    })
    await Promise.resolve()
    expect(invalidationSettled).toBe(false)

    finishFlush()
    await expect(rewind).resolves.toEqual({ draftText: 'first' })
    await invalidation
    expect(managed.messages).toEqual([])
    expect(managed.runtimeState).toBeUndefined()
  } finally {
    await manager.flushSession(managed.id)
    manager.cleanup()
    rmSync(rootPath, { recursive: true, force: true })
  }
})

it('rejects rewind during credential revocation and resolves fresh access afterward', async () => {
  const { rootPath, manager, managed } = createHarness()
  try {
    let markDisposeStarted!: () => void
    let finishDispose!: () => void
    const disposeStarted = new Promise<void>(resolve => { markDisposeStarted = resolve })
    const disposeGate = new Promise<void>(resolve => { finishDispose = resolve })
    managed.llmConnection = 'storyflow-managed'
    managed.agent = {
      isProcessing: () => false,
      disposeForRestart: async () => {
        markDisposeStarted()
        await disposeGate
      },
    } as never

    const rewindUserMessage = jest.fn().mockResolvedValue(undefined)
    const replacementAgent = { isProcessing: () => false, rewindUserMessage }
    const getOrCreateAgentLocked = jest.fn(async (session: unknown) => {
      const modelAccess = await (manager as any).agentRuntime.ensureManagedCredentialForSessionLocked(session)
      expect(modelAccess).toEqual({ token: 'fresh-managed-token' })
      return replacementAgent
    })
    ;(manager as any).getOrCreateAgentLocked = getOrCreateAgentLocked
    setSessionRuntimeHooks({
      ensureManagedModelAccessToken: async () => ({ token: 'fresh-managed-token', refreshed: false }),
    })

    const piSessionsPath = join(rootPath, '.craft-agent', 'sessions', managed.id, '.pi-sessions')
    mkdirSync(piSessionsPath, { recursive: true })
    writeFileSync(join(piSessionsPath, 'session.jsonl'), '{}\n')

    const disposal = manager.disposeConnectionRuntimes('storyflow-managed')
    await disposeStarted
    await expect(manager.rewindUserMessage(managed.id, 'user-2'))
      .rejects.toThrow('closing')
    finishDispose()

    await disposal
    await expect(manager.rewindUserMessage(managed.id, 'user-2'))
      .resolves.toEqual({ draftText: 'second' })
    expect(getOrCreateAgentLocked).toHaveBeenCalledTimes(1)
    expect(rewindUserMessage).toHaveBeenCalledWith('user-2')
  } finally {
    rmSync(rootPath, { recursive: true, force: true })
  }
})

it('clears a prepared product rewind when the Pi RPC fails', async () => {
  const { rootPath, manager, managed } = createHarness()
  try {
    managed.agent = {
      isProcessing: () => false,
      rewindUserMessage: async () => {
        managed.pendingConversationRewind = {
          token: 'prepared-token',
          revision: 'prepared-revision',
          expiresAt: Date.now() + 30_000,
          boundary: { retainThroughMessageId: 'assistant-1' },
        }
        throw new Error('Pi subprocess exited')
      },
    } as never

    const piSessionsPath = join(rootPath, '.craft-agent', 'sessions', managed.id, '.pi-sessions')
    mkdirSync(piSessionsPath, { recursive: true })
    writeFileSync(join(piSessionsPath, 'session.jsonl'), '{}\n')

    await expect(manager.rewindUserMessage(managed.id, 'user-2'))
      .rejects.toThrow('Pi subprocess exited')
    expect(managed.pendingConversationRewind).toBeUndefined()
  } finally {
    rmSync(rootPath, { recursive: true, force: true })
  }
})
