// input: Local/remote RPC client doubles and secret-free workspace switch responses
// output: Routing and workspace transport swap regression coverage
// pos: Transport contract guard for RoutedClient

/**
 * RoutedClient tests — channel routing, workspace switch, listener re-subscription.
 */

import { describe, it, expect, mock } from 'bun:test'
import { RoutedClient } from '../routed-client'
import type { WsRpcClient, TransportConnectionState } from '@craft-agent/server-core/transport'

// ---------------------------------------------------------------------------
// Minimal WsRpcClient stub
// ---------------------------------------------------------------------------

function stubClient(overrides?: Partial<WsRpcClient>): WsRpcClient {
  const listeners = new Map<string, Set<(...args: any[]) => void>>()
  const capabilities = new Map<string, (...args: any[]) => any>()

  return {
    connect: mock(() => {}),
    destroy: mock(() => {}),
    invoke: mock(async () => undefined),
    on: mock((channel: string, cb: (...args: any[]) => void) => {
      let set = listeners.get(channel)
      if (!set) { set = new Set(); listeners.set(channel, set) }
      set.add(cb)
      return () => { set!.delete(cb) }
    }),
    handleCapability: mock((channel: string, handler: (...args: any[]) => any) => {
      capabilities.set(channel, handler)
    }),
    isChannelAvailable: mock(() => true),
    getConnectionState: mock((): TransportConnectionState => ({
      mode: 'local', status: 'connected', url: 'ws://127.0.0.1:9000', attempt: 0, updatedAt: Date.now(),
    })),
    onConnectionStateChanged: mock((cb: (state: TransportConnectionState) => void) => {
      cb({ mode: 'local', status: 'connected', url: 'ws://127.0.0.1:9000', attempt: 0, updatedAt: Date.now() })
      return () => {}
    }),
    reconnectNow: mock(() => {}),
    emitReconnected: mock((isStale: boolean) => {
      const set = listeners.get('__transport:reconnected')
      if (!set) return
      for (const cb of set) {
        try { cb(isStale) } catch { /* listener errors must not break transport */ }
      }
    }),
    // expose internals for assertions
    _listeners: listeners,
    _capabilities: capabilities,
    ...overrides,
  } as any
}

// Use real channel constants — RoutedClient routes based on isLocalOnly()
import { isLocalOnly, RPC_CHANNELS, FREE_CONVERSATION_WORKSPACE_ID } from '@craft-agent/shared/protocol'

const LOCAL_CHANNEL = RPC_CHANNELS.window.GET_WORKSPACE   // LOCAL_ONLY
const REMOTE_CHANNEL = RPC_CHANNELS.sessions.GET           // REMOTE_ELIGIBLE
const SWITCH_CHANNEL = RPC_CHANNELS.window.SWITCH_WORKSPACE

describe('RoutedClient', () => {
  describe('routing', () => {
    it('keeps standalone tasks and local updates on the Host from a remote Project', async () => {
      const local = stubClient()
      const remote = stubClient()
      const client = new RoutedClient(local, remote)
      await client.invoke(RPC_CHANNELS.automations.GET, FREE_CONVERSATION_WORKSPACE_ID)
      await client.invoke(RPC_CHANNELS.automations.TEST, { workspaceId: FREE_CONVERSATION_WORKSPACE_ID, sessionId: 'bound' })
      await client.invoke(RPC_CHANNELS.automations.GET, 'remote-project')
      expect(local.invoke).toHaveBeenCalledTimes(2)
      expect(remote.invoke).toHaveBeenCalledTimes(1)
      const changed = mock(() => {})
      const unsubscribe = client.on(RPC_CHANNELS.automations.CHANGED, changed)
      for (const callback of (local as any)._listeners.get(RPC_CHANNELS.automations.CHANGED)) callback()
      expect(changed).toHaveBeenCalledTimes(1)
      unsubscribe()
      expect((local as any)._listeners.get(RPC_CHANNELS.automations.CHANGED).size).toBe(0)
      expect((remote as any)._listeners.get(RPC_CHANNELS.automations.CHANGED).size).toBe(0)
    })

    it('routes LOCAL_ONLY invokes to localClient', async () => {
      const local = stubClient({ invoke: mock(async () => 'local-result') })
      const workspace = stubClient()
      const routed = new RoutedClient(local, workspace)

      const result = await routed.invoke(LOCAL_CHANNEL)
      expect(result).toBe('local-result')
      expect(local.invoke).toHaveBeenCalledWith(LOCAL_CHANNEL)
      expect(workspace.invoke).not.toHaveBeenCalled()
    })

    it('routes REMOTE_ELIGIBLE invokes to workspaceClient', async () => {
      const local = stubClient()
      const workspace = stubClient({ invoke: mock(async () => 'ws-result') })
      const routed = new RoutedClient(local, workspace)

      const result = await routed.invoke(REMOTE_CHANNEL)
      expect(result).toBe('ws-result')
      expect(workspace.invoke).toHaveBeenCalledWith(REMOTE_CHANNEL)
      expect(local.invoke).not.toHaveBeenCalled()
    })

    it('routes LOCAL_ONLY listeners to localClient', () => {
      const local = stubClient()
      const workspace = stubClient()
      const routed = new RoutedClient(local, workspace)

      const cb = mock(() => {})
      routed.on(LOCAL_CHANNEL, cb)

      expect(local.on).toHaveBeenCalledWith(LOCAL_CHANNEL, cb)
      expect(workspace.on).not.toHaveBeenCalledWith(LOCAL_CHANNEL, expect.any(Function))
    })

    it('routes REMOTE_ELIGIBLE listeners to workspaceClient', () => {
      const local = stubClient()
      const workspace = stubClient()
      const routed = new RoutedClient(local, workspace)

      const cb = mock(() => {})
      routed.on(REMOTE_CHANNEL, cb)

      expect(workspace.on).toHaveBeenCalledWith(REMOTE_CHANNEL, cb)
    })
  })

  describe('workspace switch', () => {
    // SWITCH_WORKSPACE is LOCAL_ONLY — the switch result mock goes on localClient
    it('swaps workspaceClient when SWITCH_WORKSPACE returns remoteServer', async () => {
      const local = stubClient({
        invoke: mock(async () => ({
          workspaceId: 'ws-2',
          remoteServer: { url: 'wss://remote:9001', credentialRef: 'remote_server_token::ws-1', remoteWorkspaceId: 'rw-1' },
        })),
      })
      const workspace = stubClient()

      const newRemote = stubClient()
      const routed = new RoutedClient(local, workspace)
      routed.setClientFactory(() => newRemote)

      await routed.invoke(SWITCH_CHANNEL)

      // New client should have been connected
      expect(newRemote.connect).toHaveBeenCalled()
      // Old workspace client should have been destroyed (it's not the local client)
      expect(workspace.destroy).toHaveBeenCalled()
    })

    it('reverts to localClient when switching to local workspace', async () => {
      const local = stubClient({
        invoke: mock(async () => ({
          workspaceId: 'ws-local',
          remoteServer: null,
        })),
      })
      const remoteWs = stubClient()

      const routed = new RoutedClient(local, remoteWs)
      await routed.invoke(SWITCH_CHANNEL)

      // Remote client should be destroyed
      expect(remoteWs.destroy).toHaveBeenCalled()
      // Subsequent REMOTE_ELIGIBLE calls should go to localClient
      await routed.invoke(REMOTE_CHANNEL)
      expect(local.invoke).toHaveBeenCalledWith(REMOTE_CHANNEL)
    })

    it('re-subscribes REMOTE_ELIGIBLE listeners on swap (make-before-break)', async () => {
      const local = stubClient({
        invoke: mock(async () => ({
          workspaceId: 'ws-2',
          remoteServer: { url: 'wss://remote:9001', credentialRef: 'remote_server_token::ws-1', remoteWorkspaceId: 'rw-1' },
        })),
      })
      const workspace = stubClient()

      const newRemote = stubClient()
      const routed = new RoutedClient(local, workspace)
      routed.setClientFactory(() => newRemote)

      // Subscribe a listener before switch
      const cb = mock(() => {})
      routed.on(REMOTE_CHANNEL, cb)
      expect(workspace.on).toHaveBeenCalledWith(REMOTE_CHANNEL, cb)

      // Trigger switch
      await routed.invoke(SWITCH_CHANNEL)

      // Listener should be re-subscribed on the new client
      expect(newRemote.on).toHaveBeenCalledWith(REMOTE_CHANNEL, cb)
    })

    it('re-registers capabilities on swap', async () => {
      const local = stubClient({
        invoke: mock(async () => ({
          workspaceId: 'ws-2',
          remoteServer: { url: 'wss://remote:9001', credentialRef: 'remote_server_token::ws-1', remoteWorkspaceId: 'rw-1' },
        })),
      })
      const workspace = stubClient()

      const newRemote = stubClient()
      const routed = new RoutedClient(local, workspace)
      routed.setClientFactory(() => newRemote)

      const handler = mock(async () => 'capability-result')
      routed.handleCapability('test:capability', handler)

      await routed.invoke(SWITCH_CHANNEL)

      expect(newRemote.handleCapability).toHaveBeenCalledWith('test:capability', handler)
    })
  })

  describe('connection state', () => {
    it('delegates getConnectionState to workspaceClient', () => {
      const expectedState: TransportConnectionState = {
        mode: 'remote', status: 'reconnecting', url: 'wss://remote:9001',
        attempt: 2, updatedAt: Date.now(),
      }
      const local = stubClient()
      const workspace = stubClient({ getConnectionState: mock(() => expectedState) })
      const routed = new RoutedClient(local, workspace)

      expect(routed.getConnectionState()).toEqual(expectedState)
    })

    it('notifies connection state listeners on change', () => {
      let capturedCb: ((state: TransportConnectionState) => void) | null = null
      const workspace = stubClient({
        onConnectionStateChanged: mock((cb: (state: TransportConnectionState) => void) => {
          capturedCb = cb
          // Initial callback
          cb({ mode: 'remote', status: 'connected', url: 'wss://remote', attempt: 0, updatedAt: Date.now() })
          return () => {}
        }),
      })
      const local = stubClient()
      const routed = new RoutedClient(local, workspace)

      const listener = mock(() => {})
      routed.onConnectionStateChanged(listener)

      // Should have received initial state
      expect(listener).toHaveBeenCalled()

      // Simulate a state change via the captured workspace client callback
      capturedCb!({ mode: 'remote', status: 'reconnecting', url: 'wss://remote', attempt: 1, updatedAt: Date.now() })

      // 1: initial from onConnectionStateChanged → callback(getConnectionState())
      // 2: the simulated change forwarded through connectionStateListeners
      expect(listener).toHaveBeenCalledTimes(2)
    })

    it('delegates reconnectNow to workspaceClient', () => {
      const local = stubClient()
      const workspace = stubClient()
      const routed = new RoutedClient(local, workspace)

      routed.reconnectNow()
      expect(workspace.reconnectNow).toHaveBeenCalled()
    })
  })

  describe('cleanup', () => {
    it('unsubscribes listeners when cleanup function is called', () => {
      const local = stubClient()
      const workspace = stubClient()
      const routed = new RoutedClient(local, workspace)

      const cb = mock(() => {})
      const unsub = routed.on(REMOTE_CHANNEL, cb)

      // Should be tracked
      unsub()

      // After cleanup, switching workspace should not attempt to re-subscribe this listener
      // (no error thrown = success)
    })
  })
})

describe('isLocalOnly consistency', () => {
  it('correctly classifies window channels as LOCAL_ONLY', () => {
    expect(isLocalOnly(LOCAL_CHANNEL)).toBe(true)
  })

  it('correctly classifies session channels as REMOTE_ELIGIBLE', () => {
    expect(isLocalOnly(REMOTE_CHANNEL)).toBe(false)
  })
})


describe('explicit session owner routing', () => {
  it('routes first-call local session mutations locally while a remote project is active', async () => {
    const local = stubClient({ invoke: mock(async (channel: string) => channel === RPC_CHANNELS.window.RESOLVE_RUNTIME_WORKSPACE ? { id: 'local-project' } : undefined) })
    const remote = stubClient()
    const routed = new RoutedClient(local, remote)
    for (const type of ['pin', 'unpin', 'rename', 'archive']) {
      await routed.invoke(RPC_CHANNELS.sessions.COMMAND, 'same-id', { type }, 'local-project')
      expect(local.invoke).toHaveBeenLastCalledWith(RPC_CHANNELS.sessions.COMMAND, 'same-id', { type })
    }
    await routed.invoke(RPC_CHANNELS.sessions.DELETE, 'same-id', 'local-project')
    expect(local.invoke).toHaveBeenLastCalledWith(RPC_CHANNELS.sessions.DELETE, 'same-id')
    expect(remote.invoke).not.toHaveBeenCalled()
    expect(routed.getConnectionState()).toEqual(remote.getConnectionState())
    expect(remote.destroy).not.toHaveBeenCalled()
  })

  it('resolves remote list and command ownership without switching the active client', async () => {
    const remoteServer = { url: 'wss://other', credentialRef: 'other-credential', remoteWorkspaceId: 'remote-id' }
    const local = stubClient({ invoke: mock(async () => ({ id: 'catalog-id', remoteServer })) })
    const other = stubClient({ invoke: mock(async () => [{ id: 'same-id', workspaceId: 'remote-id' }]) })
    const routed = new RoutedClient(local, local)
    routed.setClientFactory(() => other)
    const sessions = await routed.invoke(RPC_CHANNELS.sessions.LIST_BY_WORKSPACE, 'catalog-id')
    expect(other.invoke).toHaveBeenLastCalledWith(RPC_CHANNELS.sessions.LIST_BY_WORKSPACE, 'remote-id')
    expect(sessions[0].workspaceId).toBe('catalog-id')
    await routed.invoke(RPC_CHANNELS.sessions.COMMAND, 'same-id', { type: 'unpin' }, 'catalog-id')
    expect(other.invoke).toHaveBeenLastCalledWith(RPC_CHANNELS.sessions.COMMAND, 'same-id', { type: 'unpin' })
    expect(other.destroy).toHaveBeenCalledTimes(2)
    expect(local.invoke).not.toHaveBeenCalledWith(RPC_CHANNELS.window.SWITCH_WORKSPACE, 'catalog-id')
  })

  it('destroys an independent owner connection when a mutation fails', async () => {
    const local = stubClient({ invoke: mock(async () => ({ remoteServer: { url: 'wss://other', credentialRef: 'other', remoteWorkspaceId: 'remote-id' } })) })
    const other = stubClient({ invoke: mock(async () => { throw new Error('Permission denied') }) })
    const routed = new RoutedClient(local, local)
    routed.setClientFactory(() => other)
    await expect(routed.invoke(RPC_CHANNELS.sessions.COMMAND, 'session', { type: 'pin' }, 'other'))
      .rejects.toThrow('Permission denied')
    expect(other.destroy).toHaveBeenCalledTimes(1)
  })

  it('reuses the active owner connection without mapping the session ID', async () => {
    const local = stubClient({ invoke: mock(async () => ({ remoteServer: { url: 'wss://active', credentialRef: 'active', remoteWorkspaceId: 'remote-id' } })) })
    const active = stubClient()
    const routed = new RoutedClient(local, active)
    routed.setWorkspaceMapping('catalog-id', 'remote-id')
    await routed.invoke(RPC_CHANNELS.sessions.COMMAND, 'catalog-id', { type: 'unpin' }, 'catalog-id')
    expect(active.invoke).toHaveBeenLastCalledWith(RPC_CHANNELS.sessions.COMMAND, 'catalog-id', { type: 'unpin' })
    expect(active.destroy).not.toHaveBeenCalled()
  })

  it('fails closed when an explicit owner no longer exists', async () => {
    const local = stubClient({ invoke: mock(async () => null) })
    const remote = stubClient()
    const routed = new RoutedClient(local, remote)
    await expect(routed.invoke(RPC_CHANNELS.sessions.COMMAND, 'same-id', { type: 'pin' }, 'removed'))
      .rejects.toThrow('Workspace not found')
    expect(remote.invoke).not.toHaveBeenCalled()
  })
})
