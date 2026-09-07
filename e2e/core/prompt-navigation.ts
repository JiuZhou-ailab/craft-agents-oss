// input: Isolated offline transcript and native Electron pointer/keyboard events
// output: Full prompt list/navigation and inverse user-bubble theme checks
// pos: UI regression guard for ChatDisplay prompt navigation and message contrast
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchApp, evalOn, waitFor, sleep, type LaunchedApp } from '../perf/launch'

const fixture = mkdtempSync(join(tmpdir(), 'storyflow-prompt-nav-'))
let app: LaunchedApp | undefined
try {
  execFileSync(process.execPath, ['run', 'scripts/perf/generate-fixture.ts', '--out', fixture, '--scale', '0.01'], { cwd: resolve(import.meta.dirname, '../..'), stdio: 'pipe' })
  const config = JSON.parse(readFileSync(join(fixture, 'config.json'), 'utf8'))
  const workspace = config.workspaces[0]
  const sessionsRoot = join(workspace.rootPath, '.craft-agent', 'sessions')
  const sessionId = readdirSync(sessionsRoot)[0]!
  const sessionPath = join(sessionsRoot, sessionId, 'session.jsonl')
  const header = JSON.parse(readFileSync(sessionPath, 'utf8').split('\n')[0]!)
  const messages = [
    { id: 'u1', type: 'user', content: '你好啊 `hello` [官网](https://story.zjding.com/)\n\n```ts\nconst x = 1\n```\n\n```json\n{"name":"Storyflow","count":1}\n```\n\n```spreadsheet\n{"columns":[{"key":"region","label":"Region"}],"rows":[{"region":"North"}]}\n```\n\n```mermaid\nsequenceDiagram\nactor Alice\nAlice->>Bob: hello\n```', timestamp: 1 },
    { id: 'a1', type: 'assistant', content: '你好，我可以帮你完成项目。\n\n' + '这是第一轮的回复。\n\n'.repeat(50), timestamp: 2 },
    { id: 'u2', type: 'user', content: '你是什么模型 sample.ts', badges: [{ type:'file', label:'sample.ts', rawText:'sample.ts', filePath:'/tmp/sample.ts', start:7, end:16 }], timestamp: 3 },
    { id: 'a2', type: 'assistant', content: '这是第二轮的回复摘要。', timestamp: 4 },
  ]
  writeFileSync(sessionPath, [JSON.stringify({ ...header, name: '消息导航验收', messageCount: messages.length, lastFinalMessageId: 'a2', lastMessageRole: 'assistant' }), ...messages.map(m => JSON.stringify(m))].join('\n') + '\n')
  app = await launchApp(fixture)
  await app.cdp.send('Page.bringToFront', {}, app.sid)
  await app.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, app.sid)
  await waitFor(app, `document.querySelector('[data-tutorial="activity-profile"]')`)
  await evalOn(app, `Array.from(document.querySelectorAll('[role="dialog"] button')).find(b=>/继续使用|Continue/.test(b.textContent))?.click()`)
  await evalOn(app, `(() => { const url=new URL(location.href); url.search=new URLSearchParams({workspaceId:${JSON.stringify(workspace.id)},ws:${JSON.stringify(workspace.id)},route:'allSessions/session/${sessionId}'}).toString(); location.href=url.href })()`)
  await waitFor(app, `document.querySelectorAll('[data-toc-item-index]').length===2`)
  assert.equal(await evalOn(app, `document.querySelector('[data-testid="prompt-table-of-contents"]').getBoundingClientRect().width`), await evalOn(app, `parseFloat(getComputedStyle(document.documentElement).fontSize)*1.5`))
  await sleep(500)
  const point = await evalOn(app, `(() => {const r=document.querySelector('[data-toc-item-index="1"]').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
  await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, app.sid)
  await sleep(300)
  await waitFor(app, `document.querySelectorAll('[data-toc-list-index]').length===2`)
  const labels = await evalOn<string[]>(app, `Array.from(document.querySelectorAll('[data-toc-list-index]')).map(e=>e.textContent)`)
  assert.ok(labels[0]!.includes('你好啊'))
  assert.equal(labels[1], '你是什么模型 sample.ts')
  for (let step = 1; step <= 10; step++) {
    await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y - step * 20 }, app.sid)
  }
  await waitFor(app, `!document.querySelector('[data-testid="prompt-toc-preview"]')`, 5000, 'Preview closes after pointer leaves')
  await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, app.sid)
  await waitFor(app, `document.querySelector('[data-toc-list-index="0"]')`)
  const target = await evalOn(app, `(() => {const r=document.querySelector('[data-toc-list-index="0"]').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
  for (let step = 1; step <= 10; step++) {
    await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x+(target.x-point.x)*step/10, y: point.y+(target.y-point.y)*step/10 }, app.sid)
  }
  assert.equal(await evalOn(app, `document.elementFromPoint(${target.x}, ${target.y})?.closest('[data-toc-list-index]')?.dataset.tocListIndex`), '0', 'Pointer can cross from the rail into the full list')
  await app.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...target, button: 'left', clickCount: 1 }, app.sid)
  await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...target, button: 'left', clickCount: 1 }, app.sid)
  await sleep(500)
  await waitFor(app, `document.querySelector('[data-toc-item-index="0"]')?.hasAttribute('data-toc-active')`)
  await waitFor(app, `(() => {const r=document.querySelector('.user-message-bubble').getBoundingClientRect(); return r.top>=0 && r.top<innerHeight})()`, 5000, 'Click reveals the first user bubble after smooth scrolling')
  await evalOn(app, `document.querySelector('[data-toc-item-index="1"]').focus()`)
  await waitFor(app, `document.querySelector('[data-testid="prompt-toc-preview"]')?.textContent.includes('你是什么模型')`)
  await evalOn(app, `document.querySelector('[data-toc-list-index="1"]').focus()`)
  await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, app.sid)
  await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, app.sid)
  await waitFor(app, `!document.querySelector('[data-testid="prompt-toc-preview"]')`, 5000, 'Preview closes on Escape')
  assert.equal(await evalOn(app, `document.activeElement?.getAttribute('data-toc-item-index')`), '1', 'Escape returns focus to the corresponding tick')
  for (const theme of ['light', 'dark']) {
    await evalOn(app, `localStorage.setItem('craft-theme', JSON.stringify({mode:${JSON.stringify(theme)},colorTheme:'default',isUserOverride:true})); location.reload()`)
    await waitFor(app, `document.querySelector('.user-message-bubble [data-type="string"]')`)

    const colors = await evalOn(app, `(() => {
      document.documentElement.classList.toggle('dark', ${theme === 'dark'});
      const bubble=document.querySelector('.user-message-bubble');
      const style=getComputedStyle(bubble), root=getComputedStyle(document.documentElement);
      return {background:style.backgroundColor,text:style.color,expectedBackground:root.getPropertyValue('--foreground').trim(),expectedText:root.getPropertyValue('--background').trim(),link:getComputedStyle(bubble.querySelector('a')).color};
    })()`)
    assert.equal(colors.background, colors.expectedBackground)
    assert.equal(colors.text, colors.expectedText)
    assert.equal(colors.link, colors.text, 'Links must remain readable on the inverse bubble')
    // Composite real CSS backgrounds to measure text contrast, including translucent hover fills.
    const contrast = (selector: string, property = 'color') => evalOn<number>(app!, `(() => {
      const target=document.querySelector(${JSON.stringify(selector)});
      if (!target || !target.textContent.trim()) throw new Error('Missing contrast target');
      const canvas=document.createElement('canvas'); canvas.width=canvas.height=1;
      const ctx=canvas.getContext('2d');
      const parents=[]; for(let e=target;e;e=e.parentElement) parents.unshift(e);
      for(const e of parents) {ctx.fillStyle=getComputedStyle(e).backgroundColor;ctx.fillRect(0,0,1,1)}
      const bg=ctx.getImageData(0,0,1,1).data;
      ctx.fillStyle=getComputedStyle(target).getPropertyValue(${JSON.stringify(property)});ctx.fillRect(0,0,1,1);
      const fg=ctx.getImageData(0,0,1,1).data;
      const luminance=c=>[...c].slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
      const a=luminance(bg),b=luminance(fg); return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    })()`)
    const jsonSelector='.user-message-bubble [data-type="string"]';
    assert.ok(await contrast(jsonSelector)>=4.5, `${theme} JSON text contrast`)
    assert.ok(await contrast('.user-message-bubble [data-ca-block-type="spreadsheet"] tbody tr:first-child td:nth-child(2)')>=4.5, `${theme} spreadsheet text contrast`)
    assert.ok(await contrast('.user-message-bubble [data-ca-block-type="mermaid"] svg .actor[data-id="Alice"] text', 'fill')>=4.5, `${theme} mermaid label contrast`)
    const badgeSelector='.user-message-bubble [role="button"]';
    await evalOn(app, `document.querySelector(${JSON.stringify(badgeSelector)}).scrollIntoView({block:'center'})`)
    await waitFor(app, `!document.querySelector('.z-splash')`)
    const badgePoint=await evalOn(app, `(() => {const r=document.querySelector(${JSON.stringify(badgeSelector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    await app.cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved',...badgePoint},app.sid)
    await waitFor(app, `document.querySelector(${JSON.stringify(badgeSelector)}).matches(':hover')`)
    await sleep(300)
    assert.ok(await contrast(badgeSelector)>=4.5, `${theme} hovered file badge contrast`)
    console.log('PASS: user bubble and embedded-content contrast', theme, colors)
    if (process.env.CRAFT_E2E_SCREENSHOTS) {
      await evalOn(app, `document.activeElement?.blur()`)
      await app.cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved', x:700, y:100}, app.sid)
      const tickPoint=await evalOn(app, `(() => {const r=document.querySelector('[data-toc-item-index="1"]').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
      await app.cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved', ...tickPoint}, app.sid)
      await waitFor(app, `document.querySelector('[data-testid="prompt-toc-preview"]')`)
      await sleep(200)
      const shot=await app.cdp.send('Page.captureScreenshot', {format:'png'}, app.sid)
      writeFileSync(join(process.env.CRAFT_E2E_SCREENSHOTS, `prompt-navigation-${theme}.png`), Buffer.from(shot.data,'base64'))
    }
  }
  console.log('PASS: compact prompt rail, full history list and pointer access, click navigation, keyboard focus/Escape, inverse bubbles')
} finally {
  await app?.close()
  rmSync(fixture, { recursive: true, force: true })
}
