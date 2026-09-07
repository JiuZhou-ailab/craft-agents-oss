// input: Isolated Electron workspace and real menu components in both themes
// output: Shared operation-menu geometry, highlight, submenu and dismiss regression checks
// pos: Offline UI acceptance for dropdown and context-menu presentation
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchApp, evalOn, waitFor, sleep, type LaunchedApp } from '../perf/launch'

const fixture = mkdtempSync(join(tmpdir(), 'storyflow-menu-appearance-'))
let app: LaunchedApp | undefined
try {
  execFileSync(process.execPath, ['run', 'scripts/perf/generate-fixture.ts', '--out', fixture, '--scale', '0.01'], { cwd: resolve(import.meta.dirname, '../..'), stdio: 'pipe' })
  const workspace = JSON.parse(readFileSync(join(fixture, 'config.json'), 'utf8')).workspaces[0]
  const sessionsRoot = join(workspace.rootPath, '.craft-agent', 'sessions')
  const sessionId = readdirSync(sessionsRoot)[0]!
  const sessionPath = join(sessionsRoot, sessionId, 'session.jsonl')
  const lines = readFileSync(sessionPath, 'utf8').split('\n')
  // Expose the existing share submenu without publishing anything.
  lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), sharedUrl: 'https://example.invalid/share', name: '菜单验收' })
  writeFileSync(sessionPath, lines.join('\n'))
  app = await launchApp(fixture)
  await app.cdp.send('Page.bringToFront', {}, app.sid)
  await app.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, app.sid)
  await waitFor(app, `document.querySelector('[data-tutorial="activity-profile"]')`)
  await evalOn(app, `Array.from(document.querySelectorAll('[role="dialog"] button')).find(b=>/继续使用|Continue/.test(b.textContent))?.click()`)
  await evalOn(app, `(() => { const url=new URL(location.href); url.search=new URLSearchParams({workspaceId:${JSON.stringify(workspace.id)},ws:${JSON.stringify(workspace.id)},route:'allSessions/session/${sessionId}'}).toString(); location.href=url.href })()`)
  await waitFor(app, `document.querySelector('[data-testid="chat-project-badge"]')`)
  await evalOn(app, `(() => { const b=document.querySelector(${JSON.stringify(`button[aria-label="项目：${workspace.name}"]`)}); if(b?.getAttribute('aria-expanded')==='false') b.click() })()`)
  await waitFor(app, `document.querySelector('[data-session-id="${sessionId}"] [draggable]')`)
  await sleep(500)
  const menuSelector = '[role="menu"][data-state="open"]'
  for (const theme of ['light', 'dark']) {
    await evalOn(app, `document.documentElement.classList.toggle('dark', ${theme === 'dark'})`)
    let shell: unknown
    for (const [name, selector] of [
      ['profile', '[data-tutorial="activity-profile"]'],
      ['project', `button[aria-label="管理 ${workspace.name}"]`],
      ['session', 'button[data-slot="dropdown-menu-trigger"].ml-1'],
      ['context', `[data-session-id="${sessionId}"] [draggable]`],
    ]) {
      await evalOn(app, `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(${name === 'context' ? "new MouseEvent('contextmenu',{bubbles:true,button:2,clientX:160,clientY:400})" : "new PointerEvent('pointerdown',{bubbles:true,button:0,pointerType:'mouse'})"})`)
      await waitFor(app, `document.querySelector(${JSON.stringify(menuSelector)})`)
      await sleep(200)
      const observed = await evalOn(app, `(() => {
        const menu=document.querySelector(${JSON.stringify(menuSelector)}), item=menu.querySelector('[role="menuitem"]'), icon=item.querySelector('svg');
        const m=getComputedStyle(menu), i=getComputedStyle(item);
        return {shell:{border:m.border,radius:m.borderRadius,shadow:m.boxShadow,background:m.backgroundColor,color:m.color},width:menu.getBoundingClientRect().width,padding:m.padding,item:{font:i.fontSize,line:i.lineHeight,height:item.getBoundingClientRect().height,gap:i.gap,radius:i.borderRadius,padding:i.padding,cursor:i.cursor,icon:icon.getBoundingClientRect().width}};
      })()`)
      assert.equal(observed.width, 180, `${theme} ${name} width`)
      assert.equal(observed.padding, '4px')
      assert.deepEqual(observed.item, {font:'13px',line:'20px',height:30,gap:'8px',radius:'4px',padding: name === 'session' ? '5px 8px' : '5px 16px 5px 8px',cursor:'default',icon:14})
      if (shell) assert.deepEqual(observed.shell, shell, `${theme} ${name} surface`)
      shell = observed.shell
      // Keyboard focus uses the same subtle highlight as pointer hover.
      await evalOn(app, `document.querySelector(${JSON.stringify(menuSelector)}).querySelector('[role="menuitem"]').focus()`)
      await waitFor(app, `document.querySelector(${JSON.stringify(menuSelector)}).querySelector('[role="menuitem"][data-highlighted]')`, 5000)
      assert.ok(await evalOn(app, `getComputedStyle(document.querySelector(${JSON.stringify(menuSelector)}).querySelector('[role="menuitem"][data-highlighted]')).backgroundColor.includes('0.05')`), `${name} keyboard highlight`)
      if (name === 'session') {
        await app.cdp.send('Input.dispatchKeyEvent', {type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39}, app.sid)
        await app.cdp.send('Input.dispatchKeyEvent', {type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39}, app.sid)
        await waitFor(app, `document.querySelectorAll(${JSON.stringify(menuSelector)}).length===2`)
        assert.deepEqual(await evalOn(app, `(() => {const m=Array.from(document.querySelectorAll(${JSON.stringify(menuSelector)})).at(-1),i=m.querySelector('[role="menuitem"]');return [m.getBoundingClientRect().width,getComputedStyle(i).fontSize,i.getBoundingClientRect().height,getComputedStyle(i).gap]})()`), [180,'13px',30,'8px'])
      }
      if (process.env.CRAFT_E2E_SCREENSHOTS) {
        const shot = await app.cdp.send('Page.captureScreenshot', {format:'png'}, app.sid)
        writeFileSync(join(process.env.CRAFT_E2E_SCREENSHOTS, `menu-${name}-${theme}.png`), Buffer.from(shot.data,'base64'))
      }
      // Escape may close just the submenu on the first key press.
      for (let press=0; press<2; press++) {
        await app.cdp.send('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27}, app.sid)
        await app.cdp.send('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27}, app.sid)
      }
      await waitFor(app, `!document.querySelector('[role="menu"]')`)
      console.log('PASS:', theme, name, 'geometry, surface, keyboard highlight and dismiss')
    }
  }
} finally {
  await app?.close()
  rmSync(fixture, {recursive:true,force:true})
}
