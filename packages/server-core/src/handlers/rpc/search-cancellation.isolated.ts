// input: Real search RPC clients and a controlled executable at the ripgrep IO boundary
// output: Cancellation isolation and actual child-exit checks
// pos: Spec #29 search lifecycle regression
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WsRpcClient, WsRpcServer } from '../../transport'
import { createHeadlessPlatform } from '../../runtime/platform-headless'
import { setSearchPlatform, searchWorkspaceDocuments, SearchUnavailableError } from '../../services/search'
import { registerSearchHandlers } from './search'
import type { HandlerDeps } from '../handler-deps'
import { getWorkspaceSessionsPath } from '@craft-agent/shared/workspaces'

const root = mkdtempSync(join(tmpdir(), 'search-cancel-'))
const pidFile = join(root, 'pids')
const binaryDir = join(root, 'node_modules/@vscode/ripgrep-binary/bin')
mkdirSync(binaryDir, { recursive: true })
mkdirSync(getWorkspaceSessionsPath(root), { recursive: true })
writeFileSync(pidFile, '')
writeFileSync(join(binaryDir, 'rg'), `#!${process.execPath}
import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(pidFile)}, process.pid+'\\n');
if (process.argv.some(a => a.includes('fast'))) process.exit(1);
if (process.argv.some(a => a.includes('half')) && process.argv.includes('**/session.jsonl')) process.exit(1);
if (process.argv.some(a => a.includes('failure'))) {console.error('fixture failure');process.exit(2)}
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`, { mode: 0o755 })
const platform = { ...createHeadlessPlatform(), appRootPath: root, isPackaged: true }
setSearchPlatform(platform)
const clientIds: string[] = []
const server = new WsRpcServer({ port: 0, onClientConnected: info => clientIds.push(info.clientId) })
registerSearchHandlers(server, {
  platform, sessionManager: { getSessions: async () => [] },
  resolveRuntimeWorkspaceById: (id: string) => ({ id, rootPath: root }),
} as unknown as HandlerDeps)
const clients: WsRpcClient[] = []
const pids = () => readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean).map(Number)
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) { if (check()) return; await Bun.sleep(10) }
  throw new Error('condition timeout')
}
async function connect() {
  const client = new WsRpcClient(`ws://127.0.0.1:${server.port}`, { workspaceId: 'workspace', autoReconnect: false })
  clients.push(client); client.connect(); await until(() => client.isConnected); return client
}
afterAll(() => {
  clients.forEach(client => client.destroy()); server.close()
  for (const pid of pids()) if (alive(pid)) process.kill(pid, 'SIGKILL')
  setSearchPlatform(createHeadlessPlatform())
  rmSync(root, { recursive: true, force: true })
})
test('cancels both scans, isolates windows/requests, and cleans up on workspace change/disconnect', async () => {
  await server.listen()
  const a = await connect(); const b = await connect()
  const first = a.invoke('search:queryWorkspace', { query: 'slow', requestId: 'one' })
  await until(() => pids().length === 2)
  const firstPids = pids()
  const other = b.invoke('search:queryWorkspace', { query: 'slow', requestId: 'one' }).catch(() => null)
  await until(() => pids().length === 4)
  const otherPids = pids().slice(2)
  await a.invoke('search:cancelWorkspace', 'one')
  expect(await first).toEqual({ status: 'cancelled', hits: [] })
  expect(firstPids.some(alive)).toBe(false)
  expect(otherPids.every(alive)).toBe(true)
  const next = a.invoke('search:queryWorkspace', { query: 'slow', requestId: 'two' })
  await until(() => pids().length === 6)
  await a.invoke('search:cancelWorkspace', 'one')
  expect(pids().slice(4).every(alive)).toBe(true)
  server.updateClientWorkspace(clientIds[0]!, 'another-workspace')
  expect(await next).toEqual({ status: 'cancelled', hits: [] })
  expect(pids().slice(4).some(alive)).toBe(false)
  b.destroy(); await other
  await until(() => otherPids.every(pid => !alive(pid)))
  await a.invoke('search:cancelWorkspace', 'two')
  expect(await a.invoke('search:queryWorkspace', { query: 'fast', requestId: 'three' })).toEqual({ status: 'complete', hits: [] })
  const halfStart = pids().length
  const half = a.invoke('search:queryWorkspace', { query: 'half', requestId: 'half' })
  await until(() => pids().length === halfStart + 2 && pids().slice(halfStart).filter(alive).length === 1)
  await a.invoke('search:cancelWorkspace', 'half')
  await a.invoke('search:cancelWorkspace', 'half')
  expect(await half).toEqual({ status: 'cancelled', hits: [] })
  expect(pids().slice(halfStart).some(alive)).toBe(false)
  expect((await a.invoke('search:queryWorkspace', { query: 'failure' })).status).toBe('unavailable')
  await expect(searchWorkspaceDocuments('slow', root, { timeout: 20 })).rejects.toBeInstanceOf(SearchUnavailableError)
  await until(() => pids().every(pid => !alive(pid)))
}, 15000)
