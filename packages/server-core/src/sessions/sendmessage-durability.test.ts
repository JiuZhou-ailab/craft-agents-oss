// input: SessionManager persistence, transient context, performance hooks, and Pi runtime lifecycle
// output: Regression coverage for durable messages, compatible leases, exclusive mutations, and deletion tombstones
// pos: Guards send acceptance and runtime ownership across concurrent session operations

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSessionFilePath, sessionPersistenceQueue } from '@craft-agent/shared/sessions/storage'
import { clearMetrics, configurePerfTracking } from '@craft-agent/shared/utils'
import { SessionManager, createManagedSession } from './SessionManager.ts'

interface CapturedPerfMetric {
  name: string
  marks: Array<{ name: string }>
  metadata?: Record<string, unknown>
}

// Regression test for the High-severity finding in eb81086e:
//
//   sendMessage's `{ accepted, messageId }` ack contract was returning before
//   the user message hit disk because `persistSession` only enqueues with a
//   500ms debounce. A crash inside the debounce window after ack would lose
//   the message.
//
// The fix added `await this.flushSession(managed.id)` between persistSession
// and onAck. This test locks that ordering by reading the session file from
// inside the onAck callback and asserting the user message is already there.

describe('sendMessage durability', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-durability-'))
    mkdirSync(join(tmpRoot, '.craft-agent'))
    writeFileSync(join(tmpRoot, '.craft-agent', 'config.json'), JSON.stringify({
      id: 'directory-test', name: 'Test Workspace', slug: 'test-workspace', createdAt: 1, updatedAt: 1,
    }))
    sm = new SessionManager((_workspaceId, managed) => managed.workspace)
    clearMetrics()
  })

  afterEach(async () => {
    const sessionIds = (sm as unknown as { sessions: Map<string, unknown> }).sessions.keys()
    for (const sessionId of sessionIds) await sm.flushSession(sessionId)
    sm.cleanup()
    configurePerfTracking({ enabled: false, onMetric: undefined })
    clearMetrics()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function capturePerfMetrics(): CapturedPerfMetric[] {
    const metrics: CapturedPerfMetric[] = []
    configurePerfTracking({
      enabled: true,
      onMetric: metric => {
        metrics.push(metric)
      },
    })
    return metrics
  }

  function buildSession(id: string) {
    const workspace = {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: realpathSync(tmpRoot),
      directoryConfigId: 'directory-test',
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: 'durability test' },
      workspace as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  function readPersistedMessageIds(sessionId: string): string[] {
    const path = getSessionFilePath(tmpRoot, sessionId)
    if (!existsSync(path)) return []
    const lines = readFileSync(path, 'utf-8').trim().split('\n')
    // First line is the header, remaining lines are messages.
    return lines.slice(1).map(l => JSON.parse(l)).map(m => m.id as string)
  }

  function readPersistedTitle(sessionId: string): string | undefined {
    const path = getSessionFilePath(tmpRoot, sessionId)
    if (!existsSync(path)) return undefined
    const [header] = readFileSync(path, 'utf-8').trim().split('\n')
    return JSON.parse(header).name as string | undefined
  }

  function findAcceptMetric(metrics: CapturedPerfMetric[], status: string): CapturedPerfMetric | undefined {
    return metrics.find(metric =>
      metric.name === 'session.sendMessage.accept'
      && metric.metadata?.status === status
    )
  }

  function expectAcceptMetric(metric: CapturedPerfMetric | undefined, status: string) {
    expect(metric).toBeDefined()
    if (!metric) throw new Error('missing session.sendMessage.accept metric')

    expect(metric.name).toBe('session.sendMessage.accept')
    expect(metric.metadata).toEqual(expect.objectContaining({ status }))

    const messageCount = metric.metadata?.messageCount
    expect(typeof messageCount).toBe('number')
    expect(messageCount as number).toBeGreaterThan(0)

    const markNames = metric.marks.map(mark => mark.name)
    expect(markNames).toContain('pendingPlan.cleared')
    expect(markNames).toContain('messages.loaded')
    expect(markNames).toContain('session.flushed')
    expect(markNames).toContain('ack')
  }

  it('user message is on disk before onAck fires (normal branch)', async () => {
    const sessionId = 'durability-normal'
    buildSession(sessionId)
    const metrics = capturePerfMetrics()

    let ackedMessageId: string | null = null
    let onDiskAtAck = false
    let acceptMetricAtAck: CapturedPerfMetric | undefined

    // sendMessage continues past the ack into agent-init, which would throw
    // because we haven't called `setSessionPlatform()` in this minimal test
    // harness. That's fine — we only care about the persist+flush+ack ordering
    // that happens before agent-init. Catch the post-ack rejection.
    await sm
      .sendMessage(
        sessionId,
        'hello',
        undefined,
        undefined,
        undefined,
        undefined,
        (messageId) => {
          ackedMessageId = messageId
          onDiskAtAck = readPersistedMessageIds(sessionId).includes(messageId)
          acceptMetricAtAck = findAcceptMetric(metrics, 'accepted')
        },
      )
      .catch(() => { /* expected post-ack agent-init failure */ })

    expect(ackedMessageId).not.toBeNull()
    expect(onDiskAtAck).toBe(true)
    expectAcceptMetric(acceptMetricAtAck, 'accepted')
  })

  it('persists the first deterministic title in the same durable acceptance write', async () => {
    const sessionId = 'durability-first-title'
    const managed = buildSession(sessionId)
    managed.name = undefined
    const observedOrder: string[] = []
    let titleOnDiskAtAck: string | undefined

    sm.setEventSink((_channel, _target, event) => {
      if (event?.type === 'user_message' || event?.type === 'title_generated') {
        observedOrder.push(event.type)
      }
    })

    await sm
      .sendMessage(
        sessionId,
        'hello',
        undefined,
        undefined,
        undefined,
        undefined,
        () => {
          titleOnDiskAtAck = readPersistedTitle(sessionId)
          observedOrder.push('ack')
        },
      )
      .catch(() => { /* expected post-ack agent-init failure */ })

    expect(titleOnDiskAtAck).toBe('hello')
    expect(observedOrder.slice(0, 3)).toEqual(['ack', 'user_message', 'title_generated'])
  })

  it('names edit sessions from user intent and gives the same clean input to title inference', async () => {
    const managed = buildSession('edit-title')
    managed.name = undefined
    const metadata = '<edit_request><label>Scheduled Task</label><context>Create a scheduled task</context></edit_request>\n\n'
    const instruction = 'Remind me to write my weekly report on Friday'
    let titleInput: string | undefined
    ;(sm as any).generateTitle = async (_managed: unknown, input: string) => { titleInput = input }
    await sm.sendMessage('edit-title', metadata + instruction, undefined, undefined, {
      badges: [{ type: 'context', label: 'Scheduled Task', rawText: metadata, start: 0, end: metadata.length }],
    }).catch(() => { /* expected post-ack agent-init failure */ })
    expect(readPersistedTitle('edit-title')).toBe(instruction)
    expect(titleInput).toBe(instruction)
    expect(managed.messages[0]?.content).toBe(metadata + instruction)
  })

  it('queues a concurrent send while the first message is still being durably accepted', async () => {
    const managed = buildSession('concurrent-admission')
    let enterFlush!: () => void
    let releaseFlush!: () => void
    let finishChat!: () => void
    let acknowledgeSecond!: () => void
    const flushing = new Promise<void>(resolve => { enterFlush = resolve })
    const flushGate = new Promise<void>(resolve => { releaseFlush = resolve })
    const chatGate = new Promise<void>(resolve => { finishChat = resolve })
    const secondAck = new Promise<void>(resolve => { acknowledgeSecond = resolve })
    const flush = sm.flushSession.bind(sm)
    let firstFlush = true
    sm.flushSession = async id => {
      if (firstFlush) {
        firstFlush = false
        enterFlush()
        await flushGate
      }
      await flush(id)
    }
    const chats: string[] = []
    const agent = {
      getModel: () => 'test-model', setAllSources() {}, getSessionId: () => undefined, dispose() {},
      chat: async function* (message: string) {
        chats.push(message)
        if (message === 'first') await chatGate
        yield { type: 'text_complete', text: `reply:${message}` }
        yield { type: 'complete' }
      },
    }
    ;(sm as any).getOrCreateAgentLocked = async () => agent
    const first = sm.sendMessage(managed.id, 'first')
    await flushing
    const second = sm.sendMessage(managed.id, 'second', undefined, undefined, undefined, undefined, acknowledgeSecond)
    // Give the competing send time to reach admission while the first flush is blocked.
    await Bun.sleep(20)
    releaseFlush()
    try {
      await secondAck
      expect(managed.messages.find(message => message.content === 'second')?.isQueued).toBe(true)
      expect(managed.messageQueue).toHaveLength(1)
    } finally {
      finishChat()
      await Promise.all([first, second])
      for (let i = 0; i < 100 && (chats.length < 2 || (sm as any).agentLease.hasActiveOperations(managed.id)); i++) await Bun.sleep(5)
    }
    expect(chats).toEqual(['first', 'second'])
    expect(managed.messages.filter(message => message.role === 'assistant').map(message => message.content))
      .toEqual(['reply:first', 'reply:second'])
  })

  it('releases send admission when preflight fails so the next send can run', async () => {
    const managed = buildSession('admission-preflight-failure')
    const ensureMessagesLoaded = (sm as any).ensureMessagesLoaded.bind(sm)
    let first = true
    ;(sm as any).ensureMessagesLoaded = async (session: typeof managed) => {
      if (first) {
        first = false
        throw new Error('preflight unavailable')
      }
      await ensureMessagesLoaded(session)
    }
    ;(sm as any).getOrCreateAgentLocked = async () => ({
      getModel: () => 'test-model', setAllSources() {}, getSessionId: () => undefined, dispose() {},
      async *chat() { yield { type: 'text_complete', text: 'reply' }; yield { type: 'complete' } },
    })
    const failed = sm.sendMessage(managed.id, 'failed')
    const next = sm.sendMessage(managed.id, 'next')
    await expect(failed).rejects.toThrow('preflight unavailable')
    await next
    expect(managed.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['next'])
    expect(managed.messages.some(message => message.content === 'reply')).toBe(true)
    expect((sm as any).agentLease.hasActiveOperations(managed.id)).toBe(false)
  })

  it('user message is on disk before onAck fires (mid-stream / queued branch)', async () => {
    const sessionId = 'durability-midstream'
    const managed = buildSession(sessionId)
    // Force the mid-stream branch. Agent is null, so redirect() falls back to
    // false and the queue path runs.
    managed.isProcessing = true
    const metrics = capturePerfMetrics()

    let ackedMessageId: string | null = null
    let onDiskAtAck = false
    let acceptMetricAtAck: CapturedPerfMetric | undefined

    await sm.sendMessage(
      sessionId,
      'queued message',
      undefined,
      undefined,
      { workspaceFreshnessContext: 'read chapter-2.md before editing' },
      undefined,
      (messageId) => {
        ackedMessageId = messageId
        onDiskAtAck = readPersistedMessageIds(sessionId).includes(messageId)
        acceptMetricAtAck = findAcceptMetric(metrics, 'queued')
      },
    )

    expect(ackedMessageId).not.toBeNull()
    expect(onDiskAtAck).toBe(true)
    expectAcceptMetric(acceptMetricAtAck, 'queued')

    const restoredManager = new SessionManager((_workspaceId, managed) => managed.workspace)
    const restored = createManagedSession(
      { id: sessionId, name: 'restored queue' },
      managed.workspace,
      { messagesLoaded: false, isProcessing: true },
    )
    ;(restoredManager as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, restored)
    // Queue recovery now lives behind the SessionPersistence module.
    await ((restoredManager as unknown as {
      persistence: { loadMessagesFromDisk(session: typeof restored): Promise<void> }
    }).persistence).loadMessagesFromDisk(restored)
    expect(restored.messageQueue[0]?.options?.workspaceFreshnessContext)
      .toBe('read chapter-2.md before editing')
  })

  it('dequeues a replay only inside the durable send transaction', async () => {
    const sessionId = 'durability-queued-replay'
    const managed = buildSession(sessionId)
    managed.messages = [
      { id: 'queued-1', role: 'user', content: 'later', timestamp: 1, isQueued: true },
      { id: 'answer-1', role: 'assistant', content: 'done', timestamp: 2 },
    ] as never
    managed.messageQueue = [{ message: 'later', messageId: 'queued-1' }]
    const agent = {
      getModel: () => 'test-model',
      setAllSources: () => {},
      getSessionId: () => undefined,
      chat: async function* () { yield { type: 'complete' } },
    }
    ;(sm as any).getOrCreateAgentLocked = async () => agent
    let durableAtAck = false

    await sm.sendMessage(
      sessionId,
      'later',
      undefined,
      undefined,
      undefined,
      'queued-1',
      () => {
        durableAtAck = managed.messageQueue.length === 0
          && readPersistedMessageIds(sessionId).at(-1) === 'queued-1'
      },
    )

    expect(durableAtAck).toBe(true)
    expect(managed.messageQueue).toEqual([])
    expect(managed.messages.map(message => message.id)).toEqual(['answer-1', 'queued-1'])
  })

  it('keeps one-time and interruption context out of the durable model message', async () => {
    const sessionId = 'transient-turn-context'
    const managed = buildSession(sessionId)
    managed.wasInterrupted = true
    let captured: { message: string; oneTimeContext?: string; turnPolicy?: string } | undefined
    ;(sm as unknown as { getOrCreateAgentLocked: () => Promise<unknown> }).getOrCreateAgentLocked = async () => ({
      getModel: () => 'test-model',
      setAllSources: () => {},
      getSessionId: () => undefined,
      chat: async function* (
        message: string,
        _attachments: unknown,
        options: { oneTimeContext?: string; turnPolicy?: string },
      ) {
        captured = {
          message,
          oneTimeContext: options.oneTimeContext,
          turnPolicy: options.turnPolicy,
        }
        yield { type: 'complete' }
      },
    })

    await sm.sendMessage(
      sessionId,
      'hello',
      undefined,
      undefined,
      {
        oneTimeContext: 'OTHER TRANSIENT DATA',
        workspaceFreshnessContext: '<workspace-brief>\nNOVEL WORKSPACE BRIEF\n</workspace-brief>',
      },
    )

    expect(captured?.message).toBe('hello')
    expect(captured?.oneTimeContext).toContain('OTHER TRANSIENT DATA')
    expect(captured?.oneTimeContext).toContain('NOVEL WORKSPACE BRIEF')
    expect(captured?.turnPolicy).toContain('previous assistant response was interrupted')
    expect(captured?.turnPolicy).toContain('Before editing any listed file, read its latest content first')
    expect(managed.wasInterrupted).toBe(false)
    expect(readFileSync(getSessionFilePath(tmpRoot, sessionId), 'utf-8'))
      .not.toContain('NOVEL WORKSPACE BRIEF')
  })

  it('shares one-shot queries with chat while disposal waits for the chat lease', async () => {
    const sessionId = 'chat-runtime-lease'
    const managed = buildSession(sessionId)
    managed.llmConnection = 'lease-test'
    let markStarted!: () => void
    let finishChat!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const chatGate = new Promise<void>(resolve => { finishChat = resolve })
    let disposeCalls = 0
    const agent = {
      isProcessing: () => false,
      getModel: () => 'test-model',
      setAllSources: () => {},
      getSessionId: () => undefined,
      dispose: () => { disposeCalls++ },
      forceAbort: () => {},
      queryLlm: async () => ({ text: 'rewritten', model: 'test-model' }),
      chat: async function* () {
        markStarted()
        await chatGate
        yield { type: 'complete' }
      },
    }
    managed.agent = agent as never
    ;(sm as any).getOrCreateAgentLocked = async () => agent

    const send = sm.sendMessage(sessionId, 'hi')
    await started

    await expect(sm.queryOnce(sessionId, { prompt: 'rewrite' }))
      .resolves.toEqual({ text: 'rewritten', model: 'test-model' })

    const disposal = sm.disposeConnectionRuntimes('lease-test')
    await Promise.resolve()
    expect(disposeCalls).toBe(0)

    finishChat()
    await send
    await disposal
    expect(disposeCalls).toBe(1)
  })

  it('defers source runtime mutation until the active chat lease settles', async () => {
    const sessionId = 'chat-source-writer'
    const managed = buildSession(sessionId)
    let markStarted!: () => void
    let finishChat!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const chatGate = new Promise<void>(resolve => { finishChat = resolve })
    let sourceUpdateCalls = 0
    const agent = {
      isProcessing: () => false,
      getModel: () => 'test-model',
      getSessionId: () => undefined,
      getSummarizeCallback: () => async () => null,
      setAllSources: () => {},
      applyBridgeUpdates: async () => {},
      setSourceServers: async () => { sourceUpdateCalls++ },
      chat: async function* () {
        markStarted()
        await chatGate
        yield { type: 'complete' }
      },
    }
    managed.agent = agent as never
    ;(sm as any).getOrCreateAgentLocked = async () => agent

    const send = sm.sendMessage(sessionId, 'hi')
    await started
    const sourceUpdate = sm.setSessionSources(sessionId, [])
    await Promise.resolve()
    expect(sourceUpdateCalls).toBe(0)

    finishChat()
    await send
    await sourceUpdate
    expect(sourceUpdateCalls).toBe(1)
    await sm.flushSession(sessionId)
  })

  it('does not recreate or persist a session after deletion starts', async () => {
    const sessionId = 'delete-runtime-tombstone'
    const managed = buildSession(sessionId)
    managed.name = undefined
    let markStarted!: () => void
    let finishChat!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const chatGate = new Promise<void>(resolve => { finishChat = resolve })
    let titleCalls = 0
    const agent = {
      isProcessing: () => false,
      getModel: () => 'test-model',
      getSessionId: () => undefined,
      setAllSources: () => {},
      dispose: () => {},
      forceAbort: () => { finishChat() },
      generateTitle: async () => {
        titleCalls++
        return 'stale title'
      },
      chat: async function* () {
        markStarted()
        await chatGate
        yield { type: 'complete' }
      },
    }
    managed.agent = agent as never
    ;(sm as any).getOrCreateAgentLocked = async () => agent

    const send = sm.sendMessage(sessionId, 'Investigate runtime deletion safety')
    await started
    const deletion = sm.deleteSession(sessionId)
    // The acceptance path is already covered by `acked`; the minimal harness
    // intentionally has no session platform for the post-ack agent init.
    await Promise.all([send.catch(() => {}), deletion])
    await Promise.resolve()

    expect(titleCalls).toBe(0)
    expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.has(sessionId)).toBe(false)
    expect(existsSync(getSessionFilePath(tmpRoot, sessionId))).toBe(false)
  })

  it('rejects metadata persistence after durable deletion commits', async () => {
    const sessionId = 'delete-metadata-tombstone'
    const managed = buildSession(sessionId)
    managed.sharedId = 'shared-delete-window'
    ;(sm as unknown as { persistSession(session: typeof managed): void }).persistSession(managed)
    await sm.flushSession(sessionId)

    const originalFetch = globalThis.fetch
    let markShareRevokeStarted!: () => void
    let finishShareRevoke!: () => void
    const shareRevokeStarted = new Promise<void>(resolve => { markShareRevokeStarted = resolve })
    const shareRevokeGate = new Promise<void>(resolve => { finishShareRevoke = resolve })
    globalThis.fetch = (async () => {
      markShareRevokeStarted()
      await shareRevokeGate
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch

    try {
      const deletion = sm.deleteSession(sessionId)
      await shareRevokeStarted
      expect(existsSync(getSessionFilePath(tmpRoot, sessionId))).toBe(false)

      await sm.setSessionStatus(sessionId, 'done')
      finishShareRevoke()
      await deletion

      expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.has(sessionId)).toBe(false)
      expect(existsSync(getSessionFilePath(tmpRoot, sessionId))).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      finishShareRevoke()
    }
  })

  it('waits for an accepted direct metadata writer before durable deletion', async () => {
    const sessionId = 'delete-share-lease'
    const managed = buildSession(sessionId)
    ;(sm as unknown as { persistSession(session: typeof managed): void }).persistSession(managed)
    await sm.flushSession(sessionId)

    const originalFetch = globalThis.fetch
    let markShareStarted!: () => void
    let finishShare!: () => void
    const shareStarted = new Promise<void>(resolve => { markShareStarted = resolve })
    const shareGate = new Promise<void>(resolve => { finishShare = resolve })
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (init?.method === 'POST') {
        markShareStarted()
        await shareGate
        return Response.json({ id: 'shared-id', url: 'https://viewer.example/shared-id' })
      }
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch

    try {
      const sharing = sm.shareToViewer(sessionId)
      await shareStarted
      let deletionFinished = false
      const deletion = sm.deleteSession(sessionId).then(() => { deletionFinished = true })
      await Promise.resolve()

      expect(managed.runtimeState).toBe('deleting')
      expect(deletionFinished).toBe(false)
      expect(existsSync(getSessionFilePath(tmpRoot, sessionId))).toBe(true)

      finishShare()
      await expect(sharing).resolves.toEqual({ success: true, url: 'https://viewer.example/shared-id' })
      await deletion

      expect(existsSync(getSessionFilePath(tmpRoot, sessionId))).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      finishShare()
    }
  })

  it('waits for an accepted Session-path write before durable deletion', async () => {
    const sessionId = 'delete-session-path-lease'
    const managed = buildSession(sessionId)
    ;(sm as unknown as { persistSession(session: typeof managed): void }).persistSession(managed)
    await sm.flushSession(sessionId)

    let markOperationStarted!: () => void
    let allowWrite!: () => void
    let markWriteFinished!: () => void
    let finishOperation!: () => void
    const operationStarted = new Promise<void>(resolve => { markOperationStarted = resolve })
    const writeGate = new Promise<void>(resolve => { allowWrite = resolve })
    const writeFinished = new Promise<void>(resolve => { markWriteFinished = resolve })
    const operationGate = new Promise<void>(resolve => { finishOperation = resolve })
    const notePath = join(tmpRoot, '.craft-agent', 'sessions', sessionId, 'notes.md')

    const pathWrite = sm.withSessionPathOperation(sessionId, async sessionPath => {
      markOperationStarted()
      await writeGate
      writeFileSync(join(sessionPath, 'notes.md'), 'accepted write')
      markWriteFinished()
      await operationGate
    })
    await operationStarted

    let deletionFinished = false
    const deletion = sm.deleteSession(sessionId).then(() => { deletionFinished = true })
    await Promise.resolve()
    expect(managed.runtimeState).toBe('deleting')
    expect(deletionFinished).toBe(false)

    allowWrite()
    await writeFinished
    expect(existsSync(notePath)).toBe(true)
    expect(deletionFinished).toBe(false)

    finishOperation()
    await Promise.all([pathWrite, deletion])
    expect(existsSync(notePath)).toBe(false)
  })

  it('waits for an accepted export before durable deletion', async () => {
    const sessionId = 'delete-export-lease'
    const managed = buildSession(sessionId)
    ;(sm as unknown as { persistSession(session: typeof managed): void }).persistSession(managed)
    await sm.flushSession(sessionId)

    let markExportStarted!: () => void
    let finishExport!: () => void
    const exportStarted = new Promise<void>(resolve => { markExportStarted = resolve })
    const exportGate = new Promise<void>(resolve => { finishExport = resolve })
    ;(sm as any).exportImport.exportSession = async () => {
      markExportStarted()
      await exportGate
      return null
    }

    const exporting = sm.exportSession(sessionId, 'ws_test')
    await exportStarted
    let deletionFinished = false
    const deletion = sm.deleteSession(sessionId).then(() => { deletionFinished = true })
    await Promise.resolve()

    expect(managed.runtimeState).toBe('deleting')
    expect(deletionFinished).toBe(false)

    finishExport()
    await expect(exporting).resolves.toBeNull()
    await deletion
    expect(existsSync(getSessionFilePath(tmpRoot, sessionId))).toBe(false)
  })

  it('does not let deletion race ahead of an accepted send transaction', async () => {
    const sessionId = 'delete-send-acceptance'
    const managed = buildSession(sessionId)
    let markPreflightStarted!: () => void
    let finishPreflight!: () => void
    const preflightStarted = new Promise<void>(resolve => { markPreflightStarted = resolve })
    const preflightGate = new Promise<void>(resolve => { finishPreflight = resolve })
    ;(sm as unknown as {
      ensureMessagesLoaded(session: typeof managed): Promise<void>
    }).ensureMessagesLoaded = async () => {
      markPreflightStarted()
      await preflightGate
    }

    let acked = false
    const send = sm.sendMessage(
      sessionId,
      'accepted before deletion',
      undefined,
      undefined,
      undefined,
      undefined,
      () => { acked = true },
    )
    await preflightStarted
    const deletion = sm.deleteSession(sessionId)
    await Promise.resolve()
    expect(managed.runtimeState).toBe('deleting')

    finishPreflight()
    await Promise.all([send, deletion])

    expect(acked).toBe(true)
    expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.has(sessionId)).toBe(false)
    expect(existsSync(getSessionFilePath(tmpRoot, sessionId))).toBe(false)
  })

  it('only auto-deletes a known empty idle Session', async () => {
    const managed = buildSession('conditional-delete')
    ;(sm as any).persistSession(managed)
    await sm.flushSession(managed.id)
    managed.messagesLoaded = false
    expect(await sm.deleteEmptySession(managed.id)).toBe(false)
    expect(existsSync(getSessionFilePath(tmpRoot, managed.id))).toBe(true)
    managed.messagesLoaded = true
    expect(await sm.deleteEmptySession(managed.id)).toBe(true)
    expect(existsSync(getSessionFilePath(tmpRoot, managed.id))).toBe(false)
  })

  it('preserves an accepted send before and after its durable acknowledgement', async () => {
    const managed = buildSession('conditional-delete-send')
    let entered!: () => void
    let resume!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { resume = resolve })
    ;(sm as any).ensureMessagesLoaded = async () => { entered(); await gate }
    let acked = false
    const send = sm.sendMessage(managed.id, 'Keep my request', undefined, undefined, undefined, undefined, () => { acked = true })
    await started
    try {
      expect(await sm.deleteEmptySession(managed.id)).toBe(false)
    } finally {
      resume()
      await send
    }
    expect(acked).toBe(true)
    expect(await sm.deleteEmptySession(managed.id)).toBe(false)
    expect(readPersistedMessageIds(managed.id).length).toBeGreaterThan(0)
  })

  it('releases the Project lock before waiting for the active runtime lease', async () => {
    const sessionId = 'delete-spawn-lock-order'
    const managed = buildSession(sessionId)
    ;(sm as unknown as { persistSession(session: typeof managed): void }).persistSession(managed)
    await sm.flushSession(sessionId)

    let markQueryStarted!: () => void
    let allowSpawn!: () => void
    const queryStarted = new Promise<void>(resolve => { markQueryStarted = resolve })
    const spawnGate = new Promise<void>(resolve => { allowSpawn = resolve })
    ;(sm as any).createSessionLocked = async () => ({ id: 'spawned-during-delete' })
    const agent = {
      dispose: () => {},
      queryLlm: async () => {
        markQueryStarted()
        await spawnGate
        await sm.createSession('ws_test')
        return { text: 'done', model: 'test-model' }
      },
    }
    managed.agent = agent as never
    ;(sm as any).getOrCreateAgentLocked = async () => agent

    const query = sm.queryOnce(sessionId, { prompt: 'spawn' } as never)
    await queryStarted
    const deletion = sm.deleteSession(sessionId)
    while (managed.runtimeState !== 'deleting') await Promise.resolve()

    allowSpawn()
    let timeoutId: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Project/runtime lock inversion')), 1_000)
    })
    await expect(Promise.race([Promise.all([query, deletion]), timeout])).resolves.toBeDefined()
    clearTimeout(timeoutId!)
    expect(existsSync(getSessionFilePath(tmpRoot, sessionId))).toBe(false)
  })

  it('durably completes once with facade, first-event, and turn-usage evidence', async () => {
    const sessionId = 'agent-readiness-metrics'
    buildSession(sessionId)
    const metrics: CapturedPerfMetric[] = []
    const completedWriteMessageCounts: number[] = []
    let assistantCompleted = false
    configurePerfTracking({
      enabled: true,
      onMetric: metric => {
        metrics.push(metric)
        if (assistantCompleted && metric.name === 'session.persist.write') {
          completedWriteMessageCounts.push(Number(metric.metadata?.messageCount))
        }
      },
    })
    sm.setEventSink((_channel, _target, event) => {
      if (event?.type === 'text_complete') assistantCompleted = true
    })
    await sm.setActiveViewingSession(sessionId, 'ws_test')
    ;(sm as unknown as { getOrCreateAgentLocked: () => Promise<unknown> }).getOrCreateAgentLocked = async () => ({
      getModel: () => 'test-model',
      setAllSources: () => {},
      getSessionId: () => undefined,
      chat: async function* () {
        yield { type: 'status', message: 'starting' }
        yield { type: 'text_complete', text: 'done' }
        yield {
          type: 'complete',
          usage: {
            inputTokens: 13,
            outputTokens: 7,
            modelCalls: 1,
            cacheReadTokens: 5,
            costUsd: 0,
            contextTokens: 13,
            contextWindow: 100,
          },
        }
      },
    })

    await sm.sendMessage(sessionId, 'hello')

    const sendMetric = metrics.find(metric => metric.name === 'session.sendMessage')
    const marks = sendMetric?.marks.map(mark => mark.name) ?? []
    expect(marks).toContain('agent.facade.ready')
    expect(marks.filter(mark => mark === 'agent.first_event')).toHaveLength(1)
    expect(sendMetric?.metadata?.usage).toEqual(expect.objectContaining({
      modelCalls: 1,
      inputTokens: 13,
      outputTokens: 7,
      cacheReadTokens: 5,
    }))
    expect(completedWriteMessageCounts).toEqual([2])
    expect(sessionPersistenceQueue.hasPending(sessionId)).toBe(false)
  })
})

describe('plan submission durability', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-plan-durability-'))
    sm = new SessionManager((_workspaceId, managed) => managed.workspace)
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('persists and emits usage before completing a plan handoff', async () => {
    const sessionId = 'plan-durability'
    const managed = createManagedSession(
      { id: sessionId, name: 'plan durability' },
      {
        id: 'ws_test',
        name: 'Test Workspace',
        rootPath: tmpRoot,
        createdAt: Date.now(),
      } as never,
      { messagesLoaded: true },
    )
    managed.isProcessing = true
    managed.turnStartedAt = Date.now() - 1_000
    managed.agent = {
      getCurrentTurnUsage: () => ({
        inputTokens: 12,
        outputTokens: 3,
        cacheReadTokens: 4,
        costUsd: 0.02,
      }),
      interruptForHandoff: () => {},
    } as never
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)

    const planPath = join(tmpRoot, 'PLAN.md')
    writeFileSync(planPath, '# Test plan', 'utf-8')

    let onDiskAtComplete = false
    let completeEvent: Record<string, unknown> | undefined
    sm.setEventSink((_channel, _target, event) => {
      if (event?.type !== 'complete') return
      completeEvent = event

      const path = getSessionFilePath(tmpRoot, sessionId)
      if (!existsSync(path)) return

      const lines = readFileSync(path, 'utf-8').trim().split('\n')
      const persistedPlan = lines
        .slice(1)
        .map(l => JSON.parse(l))
        .find(m => m.type === 'plan' && m.content === '# Test plan')
      onDiskAtComplete = persistedPlan?.turnMetrics?.usage?.inputTokens === 12
    })

    await (sm as unknown as {
      handlePlanSubmitted(managed: unknown, planPath: string): Promise<void>
    }).handlePlanSubmitted(managed, planPath)

    expect(onDiskAtComplete).toBe(true)
    expect(completeEvent?.tokenUsage).toEqual(expect.objectContaining({
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      cacheReadTokens: 4,
      costUsd: 0.02,
    }))
    expect(completeEvent?.turnMetrics).toEqual([
      expect.objectContaining({
        messageId: expect.stringMatching(/^plan-/),
        metrics: expect.objectContaining({
          usage: expect.objectContaining({ inputTokens: 12, outputTokens: 3 }),
        }),
      }),
    ])
    expect(managed.tokenUsage).toEqual(expect.objectContaining({
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
    }))
    expect(Object.values(managed.tokenUsage?.byDay ?? {})).toEqual([{
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
    }])
  })
})
