// input: Repo-built Electron app and a generated, isolated session fixture
// output: Offline startup/restart checks for project and free-conversation composers
// pos: Regression guard for session recovery independent of the project file pane

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchApp, evalOn, type LaunchedApp } from '../perf/launch'

const root = resolve(import.meta.dirname, '../..')
const fixture = mkdtempSync(join(tmpdir(), 'storyflow-startup-recovery-'))
let live: LaunchedApp | undefined
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitForComposer(app: LaunchedApp): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await evalOn(app, `!!document.querySelector('[contenteditable="true"]')`)) return
    await pause(150)
  }
  const state = await evalOn(app, `({url:location.href,placeholder:document.querySelector('[data-testid="writing-chat-placeholder"]')?.innerText})`)
  const runtime = await evalOn(app, `(async () => ({
    workspaceId: await window.electronAPI.getWindowWorkspace(),
    sessions: (await window.electronAPI.getSessions()).map(s => ({id:s.id,workspaceId:s.workspaceId})),
  }))()`).catch(error => ({ error: String(error) }))
  assert.fail(`Conversation did not become usable: ${JSON.stringify({ state, runtime, process: app.processLines.slice(-40) })}`)
}

async function openRoute(app: LaunchedApp, route: string) {
  await evalOn(app, `(() => { const url = new URL(location.href); url.searchParams.delete('panels'); url.searchParams.set('route', ${JSON.stringify(route)}); location.href = url.href })()`)
  await pause(1500)
  await waitForComposer(app)
}

try {
  execFileSync(process.execPath, ['run', 'scripts/perf/generate-fixture.ts', '--out', fixture, '--scale', '0.01'], { cwd: root, stdio: 'pipe' })
  live = await launchApp(fixture)
  await pause(6000)
  await evalOn(live, `localStorage.setItem('craft-writing-workspace-visible', 'false')`)
  await openRoute(live, 'writing')
  console.log('PASS: project conversation loads with the file pane closed')

  const ids = await evalOn<string[]>(live, `(async () => (await window.electronAPI.getSessions()).filter(s => !s.hidden && !s.isArchived).map(s => s.id))()`)
  assert.ok(ids.length >= 2)
  await openRoute(live, 'allSessions/session/' + ids[1])
  assert.equal(await evalOn(live, `new URL(location.href).searchParams.get('route')`), 'allSessions/session/' + ids[1])
  await openRoute(live, 'writing')
  const remembered = await evalOn<string>(live, `new URL(location.href).searchParams.get('route')`)
  assert.equal(remembered, 'allSessions/session/' + ids[1])
  console.log('PASS: project landing restores the last selected conversation')

  await live.close()
  live = undefined
  const saved = JSON.parse(readFileSync(join(fixture, 'window-state.json'), 'utf8'))
  assert.equal(new URL(saved.windows[0].url).searchParams.get('route'), remembered)
  live = await launchApp(fixture)
  await waitForComposer(live)
  assert.equal(await evalOn(live, `new URL(location.href).searchParams.get('route')`), remembered)
  console.log('PASS: cold restart restores the saved project conversation')

  await evalOn(live, `window.electronAPI.switchWorkspace('__storyflow_free__')`)
  await evalOn(live, `(() => { const url = new URL(location.href); url.search = '?workspaceId=__storyflow_free__&ws=__storyflow_free__&route=allSessions'; location.href = url.href })()`)
  await pause(1500)
  await waitForComposer(live)
  const freeSessions = await evalOn<any[]>(live, `window.electronAPI.getSessions()`)
  assert.equal(freeSessions.length, 1)
  assert.equal(freeSessions[0].messages.length, 0)
  const freeRoute = await evalOn<string>(live, `new URL(location.href).searchParams.get('route')`)
  await live.close()
  live = undefined
  live = await launchApp(fixture)
  await waitForComposer(live)
  assert.equal(await evalOn(live, `new URL(location.href).searchParams.get('route')`), freeRoute)
  assert.equal((await evalOn<any[]>(live, `window.electronAPI.getSessions()`)).length, 1)
  console.log('PASS: empty free workspace opens one composer and survives restart without duplicates')

  const projectRoot = join(fixture, 'empty-project')
  mkdirSync(projectRoot)
  const project = await evalOn<{id: string}>(live, `window.electronAPI.createWorkspace(${JSON.stringify(projectRoot)}, 'Empty startup project')`)
  await evalOn(live, `window.electronAPI.switchWorkspace(${JSON.stringify(project.id)})`)
  await evalOn(live, `(() => { const url = new URL(location.href); url.search = new URLSearchParams({workspaceId:${JSON.stringify(project.id)},ws:${JSON.stringify(project.id)},route:'writing'}).toString(); location.href = url.href })()`)
  await pause(1500)
  await waitForComposer(live)
  const projectSessions = await evalOn<any[]>(live, `window.electronAPI.getSessions()`)
  assert.equal(projectSessions.length, 1)
  assert.equal(projectSessions[0].messages.length, 0)
  await openRoute(live, 'writing')
  assert.equal((await evalOn<any[]>(live, `window.electronAPI.getSessions()`)).length, 1)
  console.log('PASS: empty project opens one blank conversation without duplicates or model calls')
} finally {
  await live?.close()
  rmSync(fixture, { recursive: true, force: true })
}
