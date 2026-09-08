// input: Fixture data dir, repo-built Electron app (apps/electron/dist), raw CDP client (cdp.ts)
// output: A launched-app handle (page session + perf log capture) and page-driving helpers for scenarios
// pos: Shared launch/teardown/interaction boundary for the perf harness; owns no measurement policy itself

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { CdpClient, evaluate } from './cdp.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const ELECTRON_APP_DIR = join(REPO_ROOT, 'apps', 'electron')
const ELECTRON_BIN = join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const BUILT_MAIN = join(ELECTRON_APP_DIR, 'dist', 'main.cjs')

export const DEFAULT_FIXTURE = join(homedir(), '.craft-agent-perf-fixture')

export interface PerfLogLine {
  at: number
  text: string
}

export interface LaunchedApp {
  proc: ChildProcess
  cdp: CdpClient
  /** Current page (renderer) session id. Navigation is same-page, so this stays stable. */
  sid: string
  perfLines: PerfLogLine[]
  processLines: string[]
  launchTimings: {
    spawnedAt: number
    devtoolsReadyAt: number
    cdpConnectedAt: number
    pageAttachedAt: number
  }
  close(): Promise<void>
}

export interface LaunchAppOptions {
  executablePath?: string
  packaged?: boolean
  preserveServerLockState?: boolean
}

/**
 * Launch the built Electron app against a fixture data dir and attach over raw CDP.
 *
 * We spawn Electron with `--remote-debugging-port=0` and drive it through cdp.ts. Playwright
 * (both `_electron.launch` and `connectOverCDP`) cannot complete a CDP handshake with Electron
 * 39 / Chrome 142 and hangs; raw CDP works. `CRAFT_IS_PACKAGED=false` forces isDebugMode=true
 * (logger.ts:resolveDebugMode) so the perf console transport streams rendererPerf lines to
 * stdout — do NOT pass `--debug`, which Electron/Node intercept as deprecated `node --debug`.
 */
export async function launchApp(fixtureDir: string, options: LaunchAppOptions = {}): Promise<LaunchedApp> {
  const executablePath = options.executablePath ?? ELECTRON_BIN
  const packaged = options.packaged === true
  if (!existsSync(executablePath)) throw new Error(`Electron binary not found at ${executablePath}. Run \`bun install\` or build the requested package.`)
  if (!packaged && !existsSync(BUILT_MAIN)) throw new Error(`Built main not found at ${BUILT_MAIN}. Run \`cd apps/electron && bun run build\`.`)
  if (!existsSync(join(fixtureDir, 'config.json'))) throw new Error(`Fixture config.json missing under ${fixtureDir}. Run scripts/perf/generate-fixture.ts first.`)

  if (!options.preserveServerLockState) {
    // The fixture is harness-owned and single-use, so clearing its lock state before launch is safe.
    rmSync(join(fixtureDir, '.server.lock'), { recursive: true, force: true })
    rmSync(join(fixtureDir, '.server.lease'), { recursive: true, force: true })
  }

  const perfLines: PerfLogLine[] = []
  const processLines: string[] = []
  const userDataDir = mkdtempSync(join(fixtureDir, '.electron-userdata-'))

  const spawnedAt = Date.now()
  const proc = spawn(
    executablePath,
    [...(packaged ? [] : ['.']), `--user-data-dir=${userDataDir}`, '--remote-debugging-port=0'],
    {
      cwd: packaged ? dirname(executablePath) : ELECTRON_APP_DIR,
      env: {
        ...process.env,
        CRAFT_CONFIG_DIR: fixtureDir,
        CRAFT_DEBUG: '1',
        CRAFT_IS_PACKAGED: String(packaged),
        CRAFT_DISABLE_FILE_LOG: '1',
        // Perf fixture is synthetic and offline. Force-disable client auth so the shell
        // reaches Project Hub / SessionList without Neon/Feishu login (root process.env
        // often has CRAFT_CLIENT_AUTH_REQUIRED=true from .env).
        CRAFT_CLIENT_AUTH_REQUIRED: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )

  const collect = (raw: string) => {
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t) continue
      const text = unwrap(t)
      if (!/\[PERF\] (?:session\.getSession|rpc\.getSessionMessages)/.test(text)) {
        processLines.push(text)
        if (processLines.length > 200) processLines.shift()
      }
      if (/\[perf\]|session[- ]?switch|text_delta|writing\.document|session-list\.tap/i.test(text)) {
        perfLines.push({ at: Date.now(), text })
      }
    }
  }

  const browserWs = await new Promise<string>((resolveWs, rejectWs) => {
    const timer = setTimeout(() => rejectWs(new Error('Timed out waiting for DevTools endpoint (60s)')), 60_000)
    let buf = ''
    proc.stderr?.on('data', (b: Buffer) => {
      const s = b.toString()
      collect(s)
      buf += s
      const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (m) {
        clearTimeout(timer)
        resolveWs(m[1])
      }
    })
    proc.stdout?.on('data', (b: Buffer) => collect(b.toString()))
    proc.on('exit', (code) => {
      clearTimeout(timer)
      rejectWs(new Error(`Electron exited before DevTools endpoint (code ${code}).`))
    })
  })
  const devtoolsReadyAt = Date.now()

  const cdp = await CdpClient.connect(browserWs)
  const cdpConnectedAt = Date.now()

  // Flat-session auto-attach: track the current page target's session id. Navigation is
  // same-page so this rarely changes, but re-enable domains on any fresh page attach.
  let sid = ''
  const enablePage = async (s: string) => {
    await cdp.send('Runtime.enable', {}, s).catch(() => {})
    await cdp.send('HeapProfiler.enable', {}, s).catch(() => {})
    await cdp.send('Performance.enable', {}, s).catch(() => {})
  }
  cdp.on('Target.attachedToTarget', (p, _sid) => {
    if (p.targetInfo?.type === 'page') {
      sid = p.sessionId
      void enablePage(sid)
    }
  })
  await cdp.send('Target.setDiscoverTargets', { discover: true })
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })

  // Wait for the first page session to be attached + domains enabled.
  const deadline = Date.now() + 60_000
  while (!sid && Date.now() < deadline) await sleep(100)
  if (!sid) throw new Error('No page target attached over CDP within 60s')
  await enablePage(sid)
  const pageAttachedAt = Date.now()

  const app: LaunchedApp = {
    proc,
    cdp,
    get sid() {
      return sid
    },
    perfLines,
    processLines,
    launchTimings: {
      spawnedAt,
      devtoolsReadyAt,
      cdpConnectedAt,
      pageAttachedAt,
    },
    async close() {
      if (proc.exitCode === null && proc.signalCode === null) {
        const exited = new Promise<void>((resolveExit) => proc.once('exit', () => resolveExit()))
        await Promise.race([
          callOn<void>(
            app,
            'async function () { await window.electronAPI.menuQuit() }',
          ).catch(() => {}),
          sleep(1_000),
        ])
        const graceful = await Promise.race([
          exited.then(() => true),
          sleep(5_000).then(() => false),
        ])
        if (!graceful && proc.exitCode === null && proc.signalCode === null) {
          proc.kill('SIGKILL')
          await Promise.race([exited, sleep(5_000)])
        }
      }
      cdp.close()
      rmSync(userDataDir, { recursive: true, force: true })
    },
  } as LaunchedApp
  return app
}

// ---- Page-driving helpers ----------------------------------------------
export function evalOn<T = any>(app: LaunchedApp, expression: string): Promise<T> {
  return evaluate<T>(app.cdp, app.sid, expression)
}

/** Invoke one stable function body in the page with by-value arguments. */
export async function callOn<T = any>(
  app: LaunchedApp,
  functionDeclaration: string,
  args: unknown[] = [],
): Promise<T> {
  const globalObject = await app.cdp.send(
    'Runtime.evaluate',
    { expression: 'globalThis', returnByValue: false },
    app.sid,
  )
  const objectId = globalObject.result?.objectId
  if (typeof objectId !== 'string') throw new Error('Could not resolve renderer global object')

  try {
    const result = await app.cdp.send(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration,
        arguments: args.map(value => ({ value })),
        returnByValue: true,
        awaitPromise: true,
      },
      app.sid,
    )
    if (result.exceptionDetails) {
      throw new Error(`callFunctionOn failed: ${result.exceptionDetails.text ?? 'unknown'}`)
    }
    return result.result?.value as T
  } finally {
    await app.cdp.send('Runtime.releaseObject', { objectId }, app.sid).catch(() => {})
  }
}

/** Force GC and return renderer JS heap used (bytes). */
export async function heapUsed(app: LaunchedApp): Promise<number> {
  await app.cdp.send('HeapProfiler.collectGarbage', {}, app.sid)
  const { metrics } = await app.cdp.send('Performance.getMetrics', {}, app.sid)
  const value = metrics.find((m: any) => m.name === 'JSHeapUsedSize')?.value
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('CDP did not return a valid JSHeapUsedSize metric')
  }
  return value
}

/** Poll a boolean JS expression until true or timeout; returns ms waited, or throws on timeout. */
export async function waitFor(app: LaunchedApp, boolExpr: string, timeoutMs = 30_000, label = boolExpr): Promise<number> {
  const t0 = Date.now()
  const deadline = t0 + timeoutMs
  while (Date.now() < deadline) {
    const ok = await evalOn<boolean>(app, `!!(${boolExpr})`).catch(() => false)
    if (ok) return Date.now() - t0
    await sleep(50)
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms: ${label}`)
}

export function countPerf(app: LaunchedApp, regex: RegExp): number {
  return app.perfLines.filter((l) => regex.test(l.text)).length
}

/** electron-log debug format wraps messages as JSON `{scope,message}`. Unwrap when present. */
function unwrap(line: string): string {
  const brace = line.indexOf('{')
  if (brace === -1) return line
  try {
    const obj = JSON.parse(line.slice(brace))
    const msg = Array.isArray(obj.message) ? obj.message.join(' ') : obj.message
    if (msg != null) return `${obj.scope ? `[${obj.scope}] ` : ''}${msg}`
  } catch {
    /* readable console format — as-is */
  }
  return line
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Verify registry acceptance after timing, so validation does not warm the measured path. */
export async function verifyStandardFixture(app: LaunchedApp, fixtureDir: string): Promise<void> {
  const marker = JSON.parse(readFileSync(join(fixtureDir, '.perf-fixture'), 'utf8'))
  if (marker.scale !== 1) throw new Error('Performance acceptance requires the standard scale=1 fixture')
  const config = JSON.parse(readFileSync(join(fixtureDir, 'config.json'), 'utf8'))
  if (config.workspaces.length !== 20) throw new Error('Expected 20 fixture workspaces')
  const ids = new Set<string>()
  for (const workspace of config.workspaces) {
    const sessions = await callOn<Array<{id: string; messageCount?: number}>>(app,
      'async function(id) { return window.electronAPI.listSessionsByWorkspace(id) }', [workspace.id])
    if (sessions.length !== 300 || !sessions.some(session => session.messageCount === 1000)) {
      throw new Error(`Fixture workspace ${workspace.slug}: expected 300 sessions including 1000-message history, received ${sessions.length}`)
    }
    for (const session of sessions) {
      if (ids.has(session.id)) throw new Error(`Duplicate registry Session: ${session.id}`)
      ids.add(session.id)
    }
  }
  if (ids.size !== 6000) throw new Error(`Expected 6000 registered Sessions, received ${ids.size}`)
  const entries = await callOn<Array<{relativePath: string}>>(app,
    'async function(root) { return window.electronAPI.listWorkspaceFiles(root, []) }', [config.workspaces[0].rootPath])
  if (entries.filter(entry => /第\d{3}章/.test(entry.relativePath)).length !== 400) {
    throw new Error('Expected 400 real chapter files')
  }
}
