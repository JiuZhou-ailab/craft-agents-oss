// input: Built Electron main and an isolated offline project fixture
// output: Automation data stays scoped to its own panel when focus moves
// pos: Multi-panel automation ownership regression without provider calls

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

try {
  execFileSync(process.execPath, ['run', 'scripts/perf/generate-fixture.ts', '--out', fixture, '--scale', '0.01'], { cwd: resolve(import.meta.dirname, '../..'), stdio: 'pipe' })
  const config = JSON.parse(readFileSync(join(fixture, 'config.json'), 'utf8'))
  const project = config.workspaces[0]
  live = await launchApp(fixture)
  await pause(6000)
  await evalOn(live, `Array.from(document.querySelectorAll('[role="dialog"] button')).find(b => /继续使用|Continue/.test(b.textContent))?.click()`)
  await evalOn(live, `window.electronAPI.resolveRuntimeWorkspace('__storyflow_free__')`)
  writeFileSync(join(fixture, 'runtime/free/automations.json'), JSON.stringify({version:2,automations:{SchedulerTick:[{id:'qa-disabled',name:'Disabled QA task',enabled:false,cron:'0 9 * * *',actions:[{type:'prompt',prompt:'Offline only'}]}]}}))
  await openScheduled(live, project.id)
  for (let i = 0; i < 40; i++) {
    if (await evalOn(live, `!!document.querySelector('[data-automation-id="qa-disabled"]')`)) break
    await pause(100)
  }
  assert.ok(await evalOn(live, `!!document.querySelector('[data-automation-id="qa-disabled"]')`))
  await evalOn(live, `window.dispatchEvent(new CustomEvent('craft-agent-navigate', {detail:{route:'allSessions',newPanel:true}}))`)
  await pause(1200)
  assert.ok(await evalOn(live, `document.querySelectorAll('[data-panel-role="content"]').length >= 2`), 'Exercise two panels')
  assert.ok(await evalOn(live, `!!document.querySelector('[data-automation-id="qa-disabled"]')`), 'Unfocused schedule panel must retain its own runtime data')
  console.log('PASS: task runtime data survives focus switching to a separate chat panel')
} finally {
  await live?.close()
  rmSync(fixture, { recursive: true, force: true })
}
