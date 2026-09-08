// input: Managed sessions, stored connection resolution, and runtime refresh payloads
// output: Regression coverage for serialized in-place runtime updates and restart fallbacks
// pos: SessionManager runtime-refresh contract tests

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveBackendContext } from '@craft-agent/shared/agent/backend'
import { getEnable1MContext, getExtendedPromptCache } from '@craft-agent/shared/config'
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces'
import { SessionManager, createManagedSession, setSessionRuntimeHooks } from './SessionManager.ts'
import { buildRestartRequiredSignature } from './runtime-config.ts'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'

// Regression coverage for the stale-Pi-subprocess bug where toggling
// `supportsImages` on a custom-endpoint model wrote to disk but never reached
// the live agent.
//
// Two failure modes are guarded here:
//   1. `getOrCreateAgent` deferred refresh whenever `managed.isProcessing` was
//      true, but `sendMessage` flips that flag *before* calling
//      `getOrCreateAgent` — which made the refresh branch dead code on the
//      send path. The new gate uses only `agent.isProcessing()`.
//   2. Saving a connection had no notification path to active sessions, so
//      capability changes only propagated lazily after the next send.
//      `refreshConnectionRuntime` now pushes updates from the SAVE handler.

interface AgentStub {
  isProcessing: () => boolean
  isIdle?: () => boolean
  updateRuntimeConfig: jest.Mock
  reloadCredentials?: jest.Mock
  dispose: () => void
  disposeForRestart?: () => Promise<void>
}

function createAgentStub(opts: {
  isProcessing?: boolean
  refreshSucceeds?: boolean
  refreshDelayMs?: number
} = {}): AgentStub {
  const delay = opts.refreshDelayMs ?? 0
  const result = opts.refreshSucceeds ?? true
  return {
    isProcessing: () => opts.isProcessing ?? false,
    updateRuntimeConfig: jest.fn().mockImplementation(async () => {
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      return result
    }),
    dispose: () => { /* no-op for tests */ },
  }
}

function injectSession(
  sm: SessionManager,
  id: string,
  workspaceRoot: string,
  llmConnection: string,
  agent: AgentStub | null,
  opts: { backendRuntimeSignature?: string; backendRestartSignature?: string; isProcessing?: boolean } = {},
) {
  const workspace = {
    id: 'ws_test',
    name: 'Test Workspace',
    rootPath: realpathSync(workspaceRoot),
    createdAt: Date.now(),
    directoryConfigId: 'directory-test',
  }
  const managed = createManagedSession(
    { id, name: id, llmConnection },
    workspace as never,
    { messagesLoaded: true },
  ) as unknown as {
    id: string
    agent: AgentStub | null
    backendRuntimeSignature?: string
    backendRestartSignature?: string
    credentialRestartRequired?: boolean
    managedModelAccessToken?: string
    isProcessing: boolean
    llmConnection?: string
    runtimeState?: 'invalidating' | 'deleting'
  }
  managed.agent = agent
  // Force a stale runtime signature so the helper's comparison always reaches
  // the refresh branch — the signature it computes from real disk config will
  // never equal this sentinel.
  managed.backendRuntimeSignature = opts.backendRuntimeSignature ?? '__stale_runtime_signature_for_test__'
  // Pre-compute the restart signature against the same resolution the helper
  // will use, so by default tests route through the in-place refresh path.
  // Tests that want the restart-required path pass an explicit sentinel.
  if (opts.backendRestartSignature !== undefined) {
    managed.backendRestartSignature = opts.backendRestartSignature
  } else {
    const workspaceConfig = loadWorkspaceConfig(workspaceRoot)
    const ctx = resolveBackendContext({
      sessionConnectionSlug: llmConnection,
      workspaceDefaultConnectionSlug: workspaceConfig?.defaults?.defaultLlmConnection,
    })
    managed.backendRestartSignature = buildRestartRequiredSignature({
      connection: ctx.connection,
      authType: ctx.authType,
      resolvedModel: ctx.resolvedModel,
      enable1MContext: getEnable1MContext(),
      extendedPromptCache: getExtendedPromptCache(),
    })
  }
  managed.isProcessing = opts.isProcessing ?? false
  managed.llmConnection = llmConnection
  managed.managedModelAccessToken = 'managed-test-token'
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
  return managed
}

describe('refreshConnectionRuntime', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-refresh-'))
    mkdirSync(join(tmpRoot, '.craft-agent'), { recursive: true })
    writeFileSync(join(tmpRoot, '.craft-agent', 'config.json'), JSON.stringify({
      id: 'directory-test', name: 'Test Workspace', slug: 'test-workspace', createdAt: 1, updatedAt: 1,
    }))
    sm = new SessionManager((_workspaceId, managed) => managed.workspace)
    setSessionRuntimeHooks({
      ensureManagedModelAccessToken: async () => ({
        token: 'managed-test-token',
        refreshed: false,
      }),
    })
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('keeps failed cleanup retryable without replacing the existing runtime', async () => {
    const agent = createAgentStub({ refreshSucceeds: false })
    let failed = true
    agent.disposeForRestart = async () => { if (failed) throw new Error('child still alive') }
    const managed = injectSession(sm, 'cleanup-failure', tmpRoot, 'slug-A', agent)
    await sm.refreshConnectionRuntime('slug-A')
    expect(managed.agent).toBe(agent)
    failed = false
    await sm.refreshConnectionRuntime('slug-A')
    expect(managed.agent).toBeNull()
  })

  it('releases every connection invalidation after one child fails, allowing retry', async () => {
    const agent = createAgentStub()
    let failed = true
    agent.disposeForRestart = async () => { if (failed) throw new Error('child still alive') }
    const first = injectSession(sm, 'failed-child', tmpRoot, 'slug-A', agent)
    const second = injectSession(sm, 'stopped-child', tmpRoot, 'slug-A', createAgentStub())
    await expect(sm.disposeConnectionRuntimes('slug-A')).rejects.toThrow()
    expect(first.runtimeState).toBeUndefined()
    expect(second.runtimeState).toBeUndefined()
    expect(first.agent).toBe(agent)
    expect(second.agent).toBeNull()
    failed = false
    await sm.disposeConnectionRuntimes('slug-A')
    expect(first.agent).toBeNull()
  })

  it('keeps three most recent idle runtimes and exempts background and interaction work', async () => {
    const sessions = Array.from({ length: 7 }, (_, i) => {
      const agent = createAgentStub()
      agent.isIdle = () => true
      const managed = injectSession(sm, `idle-${i}`, tmpRoot, 'slug-A', agent)
      Object.assign(managed, { runtimeLastUsedAt: i })
      return managed
    })
    Object.assign(sessions[0]!, { pendingAuthRequestId: 'auth-pending' })
    Object.assign(sessions[1]!, { activeBackgroundTasks: new Map([['tool', 'task']]) })
    await sm.refreshConnectionRuntime('slug-A')
    for (let i = 0; i < 10 && sessions[2]!.agent; i++) await new Promise(resolve => setImmediate(resolve))
    expect(sessions.map(s => !!s.agent)).toEqual([true, true, false, false, true, true, true])
  })

  it('pushes updateRuntimeConfig to sessions on the matching connection slug', async () => {
    const matchingAgent = createAgentStub()
    const otherAgent = createAgentStub()
    injectSession(sm, 'matching', tmpRoot, 'slug-A', matchingAgent)
    injectSession(sm, 'other', tmpRoot, 'slug-B', otherAgent)

    await sm.refreshConnectionRuntime('slug-A')

    expect(matchingAgent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
    expect(otherAgent.updateRuntimeConfig).not.toHaveBeenCalled()
  })

  it('pushes rotated credentials to every live runtime on the matching connection', async () => {
    const matchingAgent = createAgentStub()
    matchingAgent.reloadCredentials = jest.fn().mockResolvedValue(true)
    const otherAgent = createAgentStub()
    otherAgent.reloadCredentials = jest.fn().mockResolvedValue(true)
    injectSession(sm, 'matching', tmpRoot, 'slug-A', matchingAgent)
    injectSession(sm, 'other', tmpRoot, 'slug-B', otherAgent)

    await sm.reloadConnectionCredentials('slug-A')

    expect(matchingAgent.reloadCredentials).toHaveBeenCalledTimes(1)
    expect(otherAgent.reloadCredentials).not.toHaveBeenCalled()
  })

  it('continues credential rotation after a snapshotted session is removed', async () => {
    let markFirstStarted!: () => void
    let releaseFirst!: () => void
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve })
    const firstRelease = new Promise<void>(resolve => { releaseFirst = resolve })

    const firstAgent = createAgentStub()
    firstAgent.reloadCredentials = jest.fn().mockImplementation(async () => {
      markFirstStarted()
      await firstRelease
      return true
    })
    const removedAgent = createAgentStub()
    removedAgent.reloadCredentials = jest.fn().mockResolvedValue(true)
    const lastAgent = createAgentStub()
    lastAgent.reloadCredentials = jest.fn().mockResolvedValue(true)

    injectSession(sm, 'first', tmpRoot, 'slug-A', firstAgent)
    injectSession(sm, 'removed', tmpRoot, 'slug-A', removedAgent)
    injectSession(sm, 'last', tmpRoot, 'slug-A', lastAgent)

    const rotation = sm.reloadConnectionCredentials('slug-A')
    await firstStarted
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.delete('removed')
    releaseFirst()

    await expect(rotation).resolves.toBeUndefined()
    expect(removedAgent.reloadCredentials).not.toHaveBeenCalled()
    expect(lastAgent.reloadCredentials).toHaveBeenCalledTimes(1)
  })

  it('recreates an idle runtime when it cannot accept rotated credentials', async () => {
    const agent = createAgentStub()
    agent.reloadCredentials = jest.fn().mockResolvedValue(false)
    const managed = injectSession(sm, 'stale', tmpRoot, 'slug-A', agent)

    await sm.reloadConnectionCredentials('slug-A')

    expect(agent.reloadCredentials).toHaveBeenCalledTimes(1)
    expect(managed.agent).toBeNull()
  })

  it('marks a busy runtime for restart when credentials cannot be hot-reloaded', async () => {
    const agent = createAgentStub({ isProcessing: true })
    agent.reloadCredentials = jest.fn().mockResolvedValue(false)
    const managed = injectSession(sm, 'busy-credential', tmpRoot, 'slug-A', agent)

    await sm.reloadConnectionCredentials('slug-A')

    expect(managed.agent).toBe(agent)
    expect(managed.credentialRestartRequired).toBe(true)
  })

  it('disposes matching runtimes when the managed account signs out', async () => {
    const matchingAgent = createAgentStub()
    const otherAgent = createAgentStub()
    const matching = injectSession(sm, 'matching', tmpRoot, 'slug-A', matchingAgent)
    const other = injectSession(sm, 'other', tmpRoot, 'slug-B', otherAgent)

    await sm.disposeConnectionRuntimes('slug-A')

    expect(matching.agent).toBeNull()
    expect(other.agent).toBe(otherAgent)
  })

  it('skips sessions whose agent is mid-stream (defers, does not yank)', async () => {
    const busyAgent = createAgentStub({ isProcessing: true })
    injectSession(sm, 'busy', tmpRoot, 'slug-A', busyAgent)

    await sm.refreshConnectionRuntime('slug-A')

    expect(busyAgent.updateRuntimeConfig).not.toHaveBeenCalled()
  })

  it('does not defer just because managed.isProcessing is true (Fix 1 regression)', async () => {
    // sendMessage flips managed.isProcessing=true *before* calling
    // getOrCreateAgent → tryRefreshAgentRuntime. The pre-fix gate
    // `managed.isProcessing || agent.isProcessing()` was therefore always true
    // on the send path, making the refresh branch dead code. The fix narrows
    // the gate to `agent.isProcessing()` only — which is what actually means
    // "an in-flight stream we shouldn't yank."
    const idleAgent = createAgentStub({ isProcessing: false })
    injectSession(sm, 'sending', tmpRoot, 'slug-A', idleAgent, { isProcessing: true })

    await sm.refreshConnectionRuntime('slug-A')

    expect(idleAgent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when there is no agent yet (cold session)', async () => {
    injectSession(sm, 'cold', tmpRoot, 'slug-A', null)

    await expect(sm.refreshConnectionRuntime('slug-A')).resolves.toBeUndefined()
  })

  it('disposes the runtime when in-place refresh fails so the next send rebuilds it', async () => {
    const failingAgent = createAgentStub({ refreshSucceeds: false })
    const managed = injectSession(sm, 'failing', tmpRoot, 'slug-A', failingAgent)

    await sm.refreshConnectionRuntime('slug-A')

    expect(failingAgent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
    expect(managed.agent).toBeNull()
  })

  it('skips in-place refresh and forces recreation when a restart-required field changed', async () => {
    // `update_runtime_config` cannot propagate `piAuthProvider`, slug,
    // providerType, or authType cleanly. When any of those drift, the helper
    // must dispose the runtime instead of marking it refreshed (which would
    // record the new signature against a stale subprocess).
    const agent = createAgentStub()
    const managed = injectSession(sm, 'auth-changed', tmpRoot, 'slug-A', agent, {
      backendRestartSignature: '__stale_restart_signature__',
    })

    await sm.refreshConnectionRuntime('slug-A')

    expect(agent.updateRuntimeConfig).not.toHaveBeenCalled()
    expect(managed.agent).toBeNull()
  })

  it('serializes concurrent refresh requests via the per-session mutex', async () => {
    // SAVE handler is fire-and-forget (Finding 1) so its refresh can be
    // mid-flight when sendMessage triggers another via getOrCreateAgent.
    // Without a mutex, both fire updateRuntimeConfig and the subprocess can
    // race a chat against the still-pending update.
    //
    // The first call holds the lock long enough for the second to see it,
    // wait, and re-evaluate from the post-refresh state — at which point the
    // signature matches and the second call is a no-op.
    const agent = createAgentStub({ refreshDelayMs: 50 })
    injectSession(sm, 'concurrent', tmpRoot, 'slug-A', agent)

    const [first, second] = await Promise.all([
      sm.refreshConnectionRuntime('slug-A'),
      sm.refreshConnectionRuntime('slug-A'),
    ])

    expect(first).toBeUndefined()
    expect(second).toBeUndefined()
    // Only one updateRuntimeConfig — the second call awaited the first via
    // the mutex, then saw matching signatures and bailed.
    expect(agent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
  })

  it('holds runtime disposal until a one-shot query settles', async () => {
    let markStarted!: () => void
    let finishQuery!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const queryGate = new Promise<void>(resolve => { finishQuery = resolve })
    const agent = createAgentStub()
    const dispose = jest.fn()
    agent.dispose = dispose
    ;(agent as any).queryLlm = async () => {
      markStarted()
      await queryGate
      return { text: 'done' }
    }
    injectSession(sm, 'leased-query', tmpRoot, 'slug-A', agent)

    const query = sm.queryOnce('leased-query', { prompt: 'summarize' } as never)
    await started
    const disposal = sm.disposeConnectionRuntimes('slug-A')
    await Promise.resolve()
    expect(dispose).not.toHaveBeenCalled()

    finishQuery()
    await expect(query).resolves.toEqual({ text: 'done' })
    await disposal
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('invalidates every matching session before waiting for runtime disposal', async () => {
    let markStarted!: () => void
    let finishQuery!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const queryGate = new Promise<void>(resolve => { finishQuery = resolve })
    const firstAgent = createAgentStub()
    ;(firstAgent as any).queryLlm = async () => {
      markStarted()
      await queryGate
      return { text: 'done' }
    }
    const first = injectSession(sm, 'signout-first', tmpRoot, 'slug-A', firstAgent)
    const second = injectSession(sm, 'signout-second', tmpRoot, 'slug-A', createAgentStub())

    const query = sm.queryOnce(first.id, { prompt: 'hold' } as never)
    await started
    const disposal = sm.disposeConnectionRuntimes('slug-A')
    await Promise.resolve()

    expect(first.runtimeState).toBe('invalidating')
    expect(second.runtimeState).toBe('invalidating')
    await expect(sm.queryOnce(second.id, { prompt: 'must not start' } as never))
      .rejects.toThrow('closing')

    finishQuery()
    await query
    await disposal
    expect(first.runtimeState).toBeUndefined()
    expect(second.runtimeState).toBeUndefined()
    expect(first.agent).toBeNull()
    expect(second.agent).toBeNull()
  })

  it('does not take over a Session already owned by another invalidation', async () => {
    const agent = createAgentStub()
    agent.dispose = jest.fn()
    const managed = injectSession(sm, 'already-invalidating', tmpRoot, 'slug-A', agent)
    managed.runtimeState = 'invalidating'
    ;(managed as typeof managed & { runtimeEpoch: number }).runtimeEpoch = 7

    await sm.disposeConnectionRuntimes('slug-A')

    expect(managed.runtimeState).toBe('invalidating')
    expect((managed as typeof managed & { runtimeEpoch: number }).runtimeEpoch).toBe(7)
    expect(agent.dispose).not.toHaveBeenCalled()
  })

  it('preserves per-model capabilities in the runtime refresh IPC payload', async () => {
    // End-to-end shape check: when the session's connection resolves to a
    // pi_compat connection with explicit per-model `supportsImages`, the
    // helper must forward that field on `customModels` so the Pi subprocess
    // can re-register the model with `input: ['text', 'image']`.
    const agent = createAgentStub()
    const managed = injectSession(sm, 'shape-check', tmpRoot, 'slug-A', agent)
    const backendContext = {
      connection: {
        slug: 'slug-A',
        name: 'Custom endpoint',
        providerType: 'pi_compat',
        authType: 'api_key',
        models: [{
          id: 'custom-model',
          supportsImages: true,
          supportsThinking: true,
          thinkingLevelMap: {
            off: 'none',
            minimal: null,
            low: 'low',
            medium: 'medium',
            high: 'high',
            xhigh: 'xhigh',
            max: null,
          },
        }],
        defaultModel: 'custom-model',
        createdAt: Date.now(),
      },
      authType: 'api_key',
      resolvedModel: 'custom-model',
    } as ReturnType<typeof resolveBackendContext>

    // Runtime refresh now lives behind the AgentRuntime module.
    await ((sm as unknown as {
      agentRuntime: {
        runAgentRuntimeRefresh(
          session: typeof managed,
          context: ReturnType<typeof resolveBackendContext>,
          runtimeSignature: string,
          restartSignature: string,
          restartRequired: boolean,
          reason: string,
        ): Promise<void>
      }
    }).agentRuntime).runAgentRuntimeRefresh(
      managed,
      backendContext,
      '__runtime_signature__',
      '__restart_signature__',
      false,
      'test',
    )

    expect(agent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
    const payload = agent.updateRuntimeConfig.mock.calls[0]?.[0]
    expect(payload).toBeDefined()
    expect(payload.runtime?.customModels).toEqual([{
      id: 'custom-model',
      supportsImages: true,
      supportsThinking: true,
      thinkingLevelMap: {
        off: 'none',
        minimal: null,
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh',
        max: null,
      },
    }])
    expect(typeof payload.model).toBe('string')
  })
})

describe('global config broadcasts', () => {
  it('coalesces the per-workspace watcher fanout into one client invalidation', async () => {
    const sm = new SessionManager((_workspaceId, managed) => managed.workspace)
    const channels: string[] = []
    sm.setEventSink(((channel: string) => {
      channels.push(channel)
    }) as never)

    const manager = sm as unknown as { broadcastLlmConnectionsChanged: () => void }
    manager.broadcastLlmConnectionsChanged()
    manager.broadcastLlmConnectionsChanged()
    manager.broadcastLlmConnectionsChanged()

    expect(channels).toEqual([])
    await Promise.resolve()
    expect(channels).toEqual([RPC_CHANNELS.llmConnections.CHANGED])
  })
})
