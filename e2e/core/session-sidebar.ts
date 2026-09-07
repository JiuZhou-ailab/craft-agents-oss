// input: Isolated Electron fixture and real sidebar drag/button events
// output: Project pin ordering, drag unpin, owner-scoped actions, and persisted pin checks
// pos: Offline regression for the global conversation rail
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchApp, evalOn, type LaunchedApp } from '../perf/launch'
const fixture = mkdtempSync(join(tmpdir(), 'storyflow-session-sidebar-'))
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
let app: LaunchedApp | undefined
async function waitFor(expression: string) {
  for (let i = 0; i < 100; i++) {
    if (await evalOn(app!, expression)) return
    await pause(100)
  }
  const state = await evalOn(app!, `({url:location.href,body:document.body.innerText.slice(0,2500)})`)
  assert.fail(`Timed out: ${expression}; ${JSON.stringify(state)}`)
}
async function drag(from: string, to: string) {
  await evalOn(app!, `document.querySelector('[data-session-id="${from}"] [draggable]').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:new DataTransfer()}))`)
  await pause(100)
  await evalOn(app!, `document.querySelector('[data-session-id="${to}"] [draggable]').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:new DataTransfer()}))`)
  await pause(300)
}
try {
  execFileSync(process.execPath, ['run', 'scripts/perf/generate-fixture.ts', '--out', fixture, '--scale', '0.01'], { cwd: resolve(import.meta.dirname, '../..'), stdio: 'pipe' })
  const config = JSON.parse(readFileSync(join(fixture, 'config.json'), 'utf8'))
  const workspaceId = config.workspaces[0].id
  app = await launchApp(fixture)
  await pause(6000)
  await evalOn(app, `Array.from(document.querySelectorAll('[role="dialog"] button')).find(b => /继续使用|Continue/.test(b.textContent))?.click()`)
  const ids = await evalOn<string[]>(app, `(async () => {
    const ids=[];
    for (const [name,pin] of [['Pinned A',true],['Pinned B',true],['Regular',false]]) {
      const session=await window.electronAPI.createSession(${JSON.stringify(workspaceId)}, {isPinned:pin});
      await window.electronAPI.sessionCommand(session.id,{type:'rename',name},${JSON.stringify(workspaceId)});
      ids.push(session.id);
    }
    return ids;
  })()`)
  await evalOn(app, `window.electronAPI.switchWorkspace(${JSON.stringify(workspaceId)})`)
  await evalOn(app, `(() => { const url=new URL(location.href); url.search=new URLSearchParams({workspaceId:${JSON.stringify(workspaceId)},ws:${JSON.stringify(workspaceId)},route:'allSessions/session/${ids[2]}'}).toString(); location.href=url.href })()`)
  await waitFor(`!!document.querySelector('[data-session-id="${ids[0]}"]')`)
  await evalOn(app, `Array.from(document.querySelectorAll('button[aria-label]')).find(b=>b.getAttribute('aria-label')===${JSON.stringify('项目：'+config.workspaces[0].name)})?.click()`)
  await waitFor(`!!document.querySelector('[data-session-id="${ids[2]}"]')`)
  await drag(ids[0]!, ids[1]!)
  const orderExpression = `Array.from(document.querySelectorAll('[data-testid="activity-fixed-sessions"] [data-session-id]')).map(e=>e.dataset.sessionId)`
  const order = await evalOn<string[]>(app, orderExpression)
  assert.ok(order.indexOf(ids[0]!) < order.indexOf(ids[1]!), 'Pinned project rows must follow the saved drag order')
  await drag(ids[0]!, ids[2]!)
  await waitFor(`document.querySelector('[data-session-id="${ids[0]}"]')?.dataset.sessionFixed==='false'`)
  const sessions = await evalOn<any[]>(app, `window.electronAPI.listSessionsByWorkspace(${JSON.stringify(workspaceId)})`)
  assert.equal(sessions.find(s=>s.id===ids[0]).isPinned, false, 'Dragging to regular must persist unpin on its owner')
  assert.ok(await evalOn(app, `!!document.querySelector('[data-testid="activity-project-conversations"] [data-session-id="${ids[0]}"]')`))
  await evalOn(app, `document.querySelector('[data-session-id="${ids[0]}"] [data-session-action="pin"]').click()`)
  await waitFor(`document.querySelector('[data-session-id="${ids[0]}"]')?.dataset.sessionFixed==='true'`)
  console.log('PASS: project pin drag order, drag unpin, and owner-scoped pin button')
} finally {
  await app?.close()
  rmSync(fixture, {recursive:true,force:true})
}
