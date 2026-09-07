// input: Isolated Electron fixture and real sidebar drag/button events
// output: Native bidirectional drag, sidebar cursors, project ownership, and persisted pin/order checks
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
async function drag(from: string, to: string, position: 'before' | 'after' = 'before') {
  const point = (id: string, fraction: number) => evalOn<{ x: number; y: number }>(app!, `(() => {
    const row=document.querySelector('[data-session-id="${id}"] [draggable]');
    row.scrollIntoView({block:'nearest'});
    const rect=row.getBoundingClientRect();
    return {x:rect.left+rect.width/2,y:rect.top+rect.height*${fraction}};
  })()`)
  await waitFor(`!document.querySelector('.z-splash')`)
  await pause(100)
  const source = await point(from, 0.5)
  let dragData: any
  const onDrag = (event: any) => { dragData = event.data }
  app!.cdp.on('Input.dragIntercepted', onDrag)
  await app!.cdp.send('Input.setInterceptDrags', { enabled: true }, app!.sid)
  try {
    await app!.cdp.send('Input.dispatchMouseEvent', { type:'mouseMoved', ...source }, app!.sid)
    await app!.cdp.send('Input.dispatchMouseEvent', { type:'mousePressed', ...source, button:'left', buttons:1, clickCount:1 }, app!.sid)
    await app!.cdp.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:source.x+10, y:source.y, button:'left', buttons:1 }, app!.sid)
    await app!.cdp.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:source.x+20, y:source.y+4, button:'left', buttons:1 }, app!.sid)
    for (let i=0; !dragData && i<20; i++) await pause(50)
    assert.ok(dragData, 'A mouse gesture must start a native session drag')
    assert.equal((await point(from, 0.5)).y, source.y, 'Starting a drag must not shift session rows')
    const target = await point(to, position === 'before' ? 0.25 : 0.75)
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await app!.cdp.send('Input.dispatchDragEvent', { type, ...target, data:dragData }, app!.sid)
    }
    await app!.cdp.send('Input.dispatchMouseEvent', { type:'mouseReleased', ...target, button:'left', buttons:0, clickCount:1 }, app!.sid)
    await pause(300)
  } finally {
    app!.cdp.off('Input.dragIntercepted', onDrag)
    await app!.cdp.send('Input.setInterceptDrags', { enabled: false }, app!.sid)
  }
}
try {
  execFileSync(process.execPath, ['run', 'scripts/perf/generate-fixture.ts', '--out', fixture, '--scale', '0.01'], { cwd: resolve(import.meta.dirname, '../..'), stdio: 'pipe' })
  const config = JSON.parse(readFileSync(join(fixture, 'config.json'), 'utf8'))
  const workspaceId = config.workspaces[0].id
  app = await launchApp(fixture)
  await app.cdp.send('Page.bringToFront', {}, app.sid)
  await app.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, app.sid)
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
  await drag(ids[0]!, ids[1]!, 'after')
  const downwardOrder = await evalOn<string[]>(app, orderExpression)
  const chrome = await evalOn(app, `({
    cursors: [
      document.querySelector('[data-tutorial="activity-skills"]'),
      document.querySelector('[data-testid="activity-rail-titlebar-actions"] button'),
      document.querySelector('[data-session-id="${ids[0]}"] [draggable]'),
    ].map(e=>getComputedStyle(e).cursor),
    project: document.querySelector('[data-testid="chat-project-badge"]')?.textContent ?? null,
  })`)
  console.log('Sidebar regression observations:', { downwardOrder, ...chrome })
  assert.deepEqual({
    movedDown: downwardOrder.indexOf(ids[0]!) > downwardOrder.indexOf(ids[1]!),
    ...chrome,
  }, { movedDown:true, cursors:['default','default','default'], project:config.workspaces[0].name })
  await drag(ids[0]!, ids[2]!)
  await waitFor(`document.querySelector('[data-session-id="${ids[0]}"]')?.dataset.sessionFixed==='false'`)
  const sessions = await evalOn<any[]>(app, `window.electronAPI.listSessionsByWorkspace(${JSON.stringify(workspaceId)})`)
  assert.equal(sessions.find(s=>s.id===ids[0]).isPinned, false, 'Dragging to regular must persist unpin on its owner')
  assert.ok(await evalOn(app, `!!document.querySelector('[data-testid="activity-project-conversations"] [data-session-id="${ids[0]}"]')`))
  await drag(ids[0]!, ids[2]!, 'after')
  const regularOrderExpression = `Array.from(document.querySelectorAll('[data-testid="activity-project-conversations"] [data-session-id]')).map(e=>e.dataset.sessionId)`
  const regularOrder = await evalOn<string[]>(app, regularOrderExpression)
  assert.ok(regularOrder.indexOf(ids[0]!) > regularOrder.indexOf(ids[2]!), 'Regular project rows must also move down')
  await evalOn(app, `location.reload()`)
  const projectSelector = `button[aria-label="项目：${config.workspaces[0].name}"]`
  await waitFor(`!!document.querySelector(${JSON.stringify(projectSelector)})`)
  await evalOn(app, `(() => {const button=document.querySelector(${JSON.stringify(projectSelector)}); if(button.getAttribute('aria-expanded')==='false') button.click()})()`)
  await waitFor(`!!document.querySelector('[data-session-id="${ids[0]}"]')`)
  assert.deepEqual(await evalOn(app, regularOrderExpression), regularOrder, 'Manual order must survive reload')
  await evalOn(app, `document.querySelector('[data-session-id="${ids[0]}"] [data-session-action="pin"]').click()`)
  await waitFor(`document.querySelector('[data-session-id="${ids[0]}"]')?.dataset.sessionFixed==='true'`)
  await evalOn(app, `document.querySelector('button[aria-label="新建自由对话"]').click()`)
  await waitFor(`!!document.querySelector('[contenteditable="true"]') && !document.querySelector('[data-testid="chat-project-badge"]')`)
  const freeIds = await evalOn<string[]>(app, `(async () => {
    const ids=[];
    for (const name of ['Free A','Free B']) {
      const session=await window.electronAPI.createSession('__storyflow_free__');
      await window.electronAPI.sessionCommand(session.id,{type:'rename',name},'__storyflow_free__');
      ids.push(session.id);
    }
    return ids;
  })()`)
  await waitFor(`!!document.querySelector('[data-session-id="${freeIds[1]}"]')`)
  await drag(freeIds[0]!, freeIds[1]!)
  await drag(freeIds[0]!, freeIds[1]!, 'after')
  const freeOrder = await evalOn<string[]>(app, `Array.from(document.querySelectorAll('[data-testid="activity-recent-sessions"] [data-session-id]')).map(e=>e.dataset.sessionId)`)
  assert.ok(freeOrder.indexOf(freeIds[0]!) > freeOrder.indexOf(freeIds[1]!), 'Free sessions must also reorder')
  console.log('PASS: native bidirectional drag, persisted order/unpin, default cursors, project badge, and free-chat exclusion')
  // Exercise clipboard success/failure without replacing the user's system clipboard.
  for (const fail of [false, true]) {
    await evalOn(app, `navigator.clipboard.writeText=async text=>{window.__inviteLink=text; if(${fail}) throw new Error('Clipboard denied')}`)
    await evalOn(app, `document.querySelector('[data-tutorial="activity-profile"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerType:'mouse'}))`)
    await waitFor(`!!document.querySelector('[data-tutorial="activity-invite-friends"]')`)
    await evalOn(app, `document.querySelector('[data-tutorial="activity-invite-friends"]').click()`)
    await waitFor(`Array.from(document.querySelectorAll('[data-sonner-toast]')).some(e=>e.textContent.includes(${JSON.stringify(fail ? '复制失败，请手动复制官网链接' : '邀请链接已复制，粘贴发送给好友即可')}))`)
    assert.equal(await evalOn(app, `window.__inviteLink`), 'https://story.zjding.com/')
  }
  await evalOn(app, `delete navigator.clipboard.writeText`)
  console.log('PASS: Invite friends menu copies the official homepage URL and handles clipboard failure')
} finally {
  await app?.close()
  rmSync(fixture, {recursive:true,force:true})
}
