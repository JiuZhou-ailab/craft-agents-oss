// input: Built Electron main and an isolated offline project fixture
// output: Project-independent creation UI and schedule visibility checks without sending requests
// pos: UI regression guard for scheduled tasks opened from projects or free conversations

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchApp, evalOn, type LaunchedApp } from '../perf/launch'

const fixture = mkdtempSync(join(tmpdir(), 'storyflow-scheduled-creation-'))
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
let live: LaunchedApp | undefined

async function openScheduled(app: LaunchedApp, workspaceId: string) {
  await evalOn(app, `window.electronAPI.switchWorkspace(${JSON.stringify(workspaceId)})`)
  await evalOn(app, `(() => { const url = new URL(location.href); url.search = new URLSearchParams({workspaceId:${JSON.stringify(workspaceId)},ws:${JSON.stringify(workspaceId)},route:'automations/scheduled'}).toString(); location.href = url.href })()`)
  for (let i = 0; i < 80; i++) {
    await pause(150)
    if (await evalOn(app, `!!document.querySelector('[data-testid="create-scheduled-task"]')`)) return
  }
  assert.fail(`Missing creation entry: ${await evalOn(app, 'document.body.innerText')}`)
}

async function verifyComposer(app: LaunchedApp) {
  await evalOn(app, `document.querySelector('[data-testid="create-scheduled-task"]').click()`)
  for (let i = 0; i < 40; i++) {
    await pause(100)
    if (await evalOn(app, `!!document.querySelector('[role="dialog"] [contenteditable="true"]')`)) break
  }
  assert.equal(await evalOn(app, `!!document.querySelector('[role="dialog"] [contenteditable="true"]')`), true)
  await evalOn(app, `document.querySelector('[role="dialog"] [contenteditable="true"]').focus()`)
  await app.cdp.send('Input.insertText', { text: 'Every day at 9am remind me to review my outline' }, app.sid)
  await pause(200)
  assert.match(await evalOn(app, `document.querySelector('[role="dialog"] [contenteditable="true"]').textContent`), /Every day at 9am/)
  await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, app.sid)
  await pause(300)
  assert.equal(await evalOn(app, `!!document.querySelector('[role="dialog"] [contenteditable="true"]')`), false)
}

try {
  execFileSync(process.execPath, ['run', 'scripts/perf/generate-fixture.ts', '--out', fixture, '--scale', '0.01'], { cwd: resolve(import.meta.dirname, '../..'), stdio: 'pipe' })
  const config = JSON.parse(readFileSync(join(fixture, 'config.json'), 'utf8'))
  const project = config.workspaces[0]
  live = await launchApp(fixture)
  await pause(6000)
  await evalOn(live, `Array.from(document.querySelectorAll('[role="dialog"] button')).find(b => /继续使用|Continue/.test(b.textContent))?.click()`)
  await openScheduled(live, project.id)
  await verifyComposer(live)
  console.log('PASS: empty project schedule opens the creation composer')

  await openScheduled(live, '__storyflow_free__')
  assert.equal(await evalOn(live, '!!document.querySelector("main select")'), false)
  await verifyComposer(live)
  console.log('PASS: free conversations create schedules without choosing a project')

  writeFileSync(join(fixture, 'runtime/free/automations.json'), JSON.stringify({ version: 2, automations: { SchedulerTick: [{ id: 'qa-disabled', name: 'Disabled QA task', enabled: false, cron: '0 9 * * *', actions: [{ type: 'prompt', prompt: 'Offline fixture only' }] }] } }))
  await openScheduled(live, project.id)
  for (let i = 0; i < 40; i++) {
    if (await evalOn(live, `!!document.querySelector('.titlebar-no-drag [data-testid="create-scheduled-task"]')`)) break
    await pause(100)
  }
  await verifyComposer(live)
  assert.equal(await evalOn(live, `!!document.querySelector('.titlebar-no-drag [data-testid="create-scheduled-task"]')`), true)
  console.log('PASS: standalone schedules are visible from project windows')
  await live.close()
  live = undefined
  config.workspaces = []
  config.activeWorkspaceId = null
  writeFileSync(join(fixture, 'config.json'), JSON.stringify(config))
  live = await launchApp(fixture)
  await pause(3000)
  await openScheduled(live, '__storyflow_free__')
  await verifyComposer(live)
  assert.equal(await evalOn(live, '!!document.querySelector("main select")'), false)
  console.log('PASS: creation and saved schedules survive restart with zero projects')
} finally {
  await live?.close()
  rmSync(fixture, { recursive: true, force: true })
}
