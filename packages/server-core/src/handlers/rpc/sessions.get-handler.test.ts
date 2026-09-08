// input: Session list requests plus typed rewind success and failure outcomes
// output: Regression coverage for workspace scoping, permission snapshots, and rewind results
// pos: Guards in-window workspace ownership and the renderer-facing rewind boundary

import { describe, expect, it } from 'bun:test'
import { FREE_CONVERSATION_WORKSPACE_ID, RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { registerSessionsHandlers } from './sessions'

function createSessionsHarness(
  windowWorkspaceId: string | undefined,
  rewindUserMessage: () => Promise<{ draftText: string }> = async () => ({ draftText: '' }),
) {
  const handlers = new Map<string, HandlerFn>()
  const requestedWorkspaceIds: Array<string | undefined> = []

  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient() {
      return undefined
    },
  }

  const deps: HandlerDeps = {
    sessionManager: {
      waitForInit: async () => {},
      getSessions: (workspaceId?: string) => {
        requestedWorkspaceIds.push(workspaceId)
        return []
      },
      rewindUserMessage,
    } as unknown as HandlerDeps['sessionManager'],
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
    windowManager: {
      getWorkspaceForWindow: () => windowWorkspaceId,
    } as unknown as HandlerDeps['windowManager'],
    platform: {
      appRootPath: '/',
      resourcesPath: '/',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
    },
  }

  registerSessionsHandlers(server, deps)

  const getSessions = handlers.get(RPC_CHANNELS.sessions.GET)
  if (!getSessions) {
    throw new Error('sessions get handler not registered')
  }
  const listSessionsByWorkspace = handlers.get(RPC_CHANNELS.sessions.LIST_BY_WORKSPACE)
  if (!listSessionsByWorkspace) {
    throw new Error('sessions list-by-workspace handler not registered')
  }
  const rewindSession = handlers.get(RPC_CHANNELS.sessions.REWIND)
  if (!rewindSession) throw new Error('sessions rewind handler not registered')

  return {
    getSessions,
    listSessionsByWorkspace,
    rewindSession,
    requestedWorkspaceIds,
    deps,
  }
}

describe('sessions get RPC registration', () => {
  it('returns authoritative permission versions with the scoped list', async () => {
    const { getSessions, deps } = createSessionsHarness('workspace-new')
    deps.sessionManager.getSessions = () => [{ id: 's1', workspaceId: 'workspace-new', permissionMode: 'ask' }] as ReturnType<typeof deps.sessionManager.getSessions>
    deps.sessionManager.getSessionPermissionModeState = (id) => {
      expect(id).toBe('s1')
      return { permissionMode: 'safe', modeVersion: 7, changedAt: '', changedBy: 'user' }
    }
    const sessions = await getSessions({ clientId: 'client-1', workspaceId: 'workspace-new', webContentsId: 1 })
    expect(sessions[0]).toMatchObject({ id: 's1', permissionMode: 'safe', permissionModeVersion: 7 })
  })

  it('prefers the current Electron window workspace over a stale context workspace', async () => {
    const { getSessions, requestedWorkspaceIds } = createSessionsHarness('workspace-new')
    const ctx: RequestContext = {
      clientId: 'client-1',
      workspaceId: 'workspace-old',
      webContentsId: 1,
    }

    await getSessions(ctx)

    expect(requestedWorkspaceIds).toEqual(['workspace-new'])
  })

  it('scopes an explicit workspace list to the requested workspace, not the window', async () => {
    const { listSessionsByWorkspace, requestedWorkspaceIds } = createSessionsHarness('workspace-new')
    const ctx: RequestContext = {
      clientId: 'client-1',
      workspaceId: 'workspace-old',
      webContentsId: 1,
    }

    await listSessionsByWorkspace(ctx, FREE_CONVERSATION_WORKSPACE_ID)

    expect(requestedWorkspaceIds).toEqual([FREE_CONVERSATION_WORKSPACE_ID])
  })

  // A missing workspaceId must not silently degrade into an unfiltered query:
  // that is exactly how project conversations leaked into Free Conversations.
  it('refuses to list sessions without a workspace instead of returning every workspace', async () => {
    const { listSessionsByWorkspace, requestedWorkspaceIds } = createSessionsHarness('workspace-new')
    const ctx: RequestContext = {
      clientId: 'client-1',
      workspaceId: 'workspace-old',
      webContentsId: 1,
    }

    await expect(listSessionsByWorkspace(ctx, '')).rejects.toThrow(/workspaceId/)
    expect(requestedWorkspaceIds).toEqual([])
  })

  it('exposes no channel that returns sessions across workspaces', () => {
    expect(RPC_CHANNELS.sessions).not.toHaveProperty('GET_ALL')
  })

  it('serializes the legacy rewind outcome instead of relying on custom Error fields', async () => {
    const error = Object.assign(new Error('Legacy rewind mapping is unavailable'), {
      code: 'REWIND_UNAVAILABLE_LEGACY',
    })
    const { rewindSession } = createSessionsHarness(undefined, async () => { throw error })

    await expect(rewindSession({
      clientId: 'client-1',
      workspaceId: null,
      webContentsId: null,
    }, 'session-1', 'message-1')).resolves.toEqual({
      success: false,
      errorCode: 'REWIND_UNAVAILABLE_LEGACY',
      errorMessage: 'Legacy rewind mapping is unavailable',
    })
  })
})
