// input: Permission RPC responses and real Pi Host pre-tool requests
// output: Session mode, persistence, and resume-order regression checks
// pos: Permission approval boundary between clients, the Product Host, and Pi

import { expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAgent } from '@craft-agent/shared/agent/pi-agent'
import { RPC_CHANNELS, type PermissionRequest } from '@craft-agent/shared/protocol'
import { getSessionFilePath } from '@craft-agent/shared/sessions/storage'
import type { HandlerFn, RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handlers/handler-deps'
import { registerSessionsHandlers } from '../handlers/rpc/sessions'
import { SessionManager, createManagedSession } from './SessionManager'

it('switches only the approved Session before Pi resumes, through the permission RPC', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'permission-response-')))
  mkdirSync(join(root, '.craft-agent'))
  const workspace = { id: 'permission-workspace', slug: 'permission-workspace', name: 'Test', rootPath: root, createdAt: 1 }
  const managed = createManagedSession({ id: 'permission-session' }, workspace, { messagesLoaded: true })
  const manager = new SessionManager((_workspaceId, session) => session.workspace)
  const agent = new PiAgent({ workspace, session: {
    id: managed.id, workspaceRootPath: root, createdAt: 1, lastUsedAt: 1, workingDirectory: root,
  }, isHeadless: true })
  managed.agent = agent
  ;(manager as any).sessions.set(managed.id, managed)
  const pending = (manager as any).pendingPermissionRequests as Map<string, { sessionId: string; type?: string }>
  const requests: PermissionRequest[] = []
  const order: string[] = []
  ;(agent as any).send = (message: { action?: string }) => {
    order.push(`resume:${message.action}:${agent.getPermissionMode()}`)
  }
  ;(agent as any).emitAutomationEvent = async () => {}
  agent.onPermissionRequest = request => {
    requests.push({ ...request, sessionId: managed.id })
    pending.set(request.requestId, { sessionId: managed.id, type: request.type })
  }
  manager.setEventSink((_channel, _target, event) => {
    if (event.type === 'permission_mode_changed') order.push(`mode:${event.permissionMode}`)
  })
  const handlers = new Map<string, HandlerFn>()
  registerSessionsHandlers({ handle: (channel, handler) => { handlers.set(channel, handler) } } as RpcServer, {
    sessionManager: manager,
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
  } as unknown as HandlerDeps)
  const respond = handlers.get(RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION)!
  const context = { clientId: 'permission-client', workspaceId: workspace.id, webContentsId: null }
  const check = (id: string) => (agent as any).handlePreToolUseRequest({
    requestId: id, toolName: 'Write', input: { file_path: join(root, `${id}.txt`), content: id },
  }) as Promise<void>
  try {
    await manager.setSessionPermissionMode(managed.id, 'ask')
    const first = check('first')
    await Bun.sleep(0)
    expect(requests).toHaveLength(1)
    const request = requests[0]!
    order.length = 0
    expect(await respond(context, managed.id, request.requestId, true, false, { permissionMode: 'allow-all' })).toBe(true)
    await first
    expect(manager.getSessionPermissionModeState(managed.id)?.permissionMode).toBe('allow-all')
    expect(order).toEqual(['mode:allow-all', 'resume:allow:allow-all'])
    await check('second')
    expect(requests).toHaveLength(1)
    await manager.flushSession(managed.id)
    const header = JSON.parse(readFileSync(getSessionFilePath(root, managed.id), 'utf8').split('\n')[0]!)
    expect(header.permissionMode).toBe('allow-all')

    await manager.setSessionPermissionMode(managed.id, 'ask')
    // A delayed/duplicate response cannot grant a fresh permission mode.
    expect(await respond(context, managed.id, request.requestId, true, false, { permissionMode: 'allow-all' })).toBe(false)
    expect(agent.getPermissionMode()).toBe('ask')
    const once = check('once')
    await Bun.sleep(0)
    const onceRequest = requests.at(-1)!
    pending.set('other-session-request', { sessionId: 'other-session', type: 'file_write' })
    expect(await respond(context, managed.id, 'other-session-request', true, false, { permissionMode: 'allow-all' })).toBe(false)
    expect(pending.has('other-session-request')).toBe(true)
    expect(await respond(context, managed.id, onceRequest.requestId, true, false)).toBe(true)
    await once
    expect(agent.getPermissionMode()).toBe('ask')
    const denied = check('denied')
    await Bun.sleep(0)
    expect(requests).toHaveLength(3)
    expect(await respond(context, managed.id, requests.at(-1)!.requestId, false, false, { permissionMode: 'allow-all' })).toBe(true)
    await denied
    expect(agent.getPermissionMode()).toBe('ask')
    expect(order.at(-1)).toBe('resume:block:ask')
    const stopped = check('stopped')
    await Bun.sleep(0)
    const stoppedRequest = requests.at(-1)!
    await agent.abort()
    await stopped
    expect(await respond(context, managed.id, stoppedRequest.requestId, true, false, { permissionMode: 'allow-all' })).toBe(false)
    expect(agent.getPermissionMode()).toBe('ask')
  } finally {
    agent.destroy()
    await manager.flushSession(managed.id)
    manager.cleanup()
    rmSync(root, { recursive: true, force: true })
  }
})
