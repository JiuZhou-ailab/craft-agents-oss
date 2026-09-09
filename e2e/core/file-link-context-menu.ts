// input: Built Electron app and an offline conversation with an encoded relative file link
// output: Native file menu, side-panel preview, clipboard path, and Finder selection assertions
// pos: Desktop regression check for file actions linked in chat messages
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchApp, evalOn, waitFor, sleep, type LaunchedApp } from '../perf/launch'

const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'storyflow-file-menu-')))
let app: LaunchedApp | undefined
let directory: string | undefined
try {
  execFileSync(process.execPath, ['run', 'scripts/perf/generate-fixture.ts', '--out', fixture, '--scale', '0.01'], { cwd: resolve(import.meta.dirname, '../..'), stdio: 'pipe' })
  const config = JSON.parse(readFileSync(join(fixture, 'config.json'), 'utf8'))
  const workspace = config.workspaces[0]
  directory = join(workspace.rootPath, '稿件')
  mkdirSync(directory)
  const filename = '斯奈德节拍表.md'
  const filePath = join(directory, filename)
  writeFileSync(filePath, '# 节拍表\n')
  const sessionsRoot = join(workspace.rootPath, '.craft-agent', 'sessions')
  const sessionId = readdirSync(sessionsRoot)[0]!
  const sessionPath = join(sessionsRoot, sessionId, 'session.jsonl')
  const header = JSON.parse(readFileSync(sessionPath, 'utf8').split('\n')[0]!)
  const messages = [
    { id: 'user-menu', type: 'user', content: '查看节拍表', timestamp: 1 },
    { id: 'assistant-menu', type: 'assistant', content: `[${filename}](${encodeURIComponent(filename)})\n\n[网页链接](https://example.com/report.md)`, timestamp: 2 },
  ]
  writeFileSync(sessionPath, [JSON.stringify({ ...header, name: '文件右键验收', workingDirectory: directory, messageCount: 2, lastFinalMessageId: 'assistant-menu', lastMessageRole: 'assistant' }), ...messages.map(m => JSON.stringify(m))].join('\n') + '\n')
  app = await launchApp(fixture)
  const live = app
  await waitFor(live, `document.querySelector('[data-tutorial="activity-profile"]')`)
  await evalOn(live, `Array.from(document.querySelectorAll('[role="dialog"] button')).find(b=>/继续使用|Continue/.test(b.textContent))?.click()`)
  await evalOn(live, `(() => {const url=new URL(location.href); url.search=new URLSearchParams({workspaceId:${JSON.stringify(workspace.id)},ws:${JSON.stringify(workspace.id)},route:'allSessions/session/${sessionId}'}).toString(); location.href=url.href})()`)
  const selector = `a[href="${encodeURIComponent(filename)}"]`
  await waitFor(live, `document.querySelector(${JSON.stringify(selector)}) && !document.querySelector('.z-splash')`)
  const click = async (expression: string, button: 'left' | 'right') => {
    await evalOn(live, `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
    const point = await evalOn<{x: number; y: number}>(live, `(() => {const e=${expression}; const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    await live.cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved',...point},live.sid)
    await live.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, clickCount: 1 }, live.sid)
    await live.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, clickCount: 1 }, live.sid)
  }
  await click(`document.querySelector(${JSON.stringify(selector)})`, 'right')
  const menuItem = `Array.from(document.querySelectorAll('[role="menuitem"]')).find(e=>e.textContent.trim()==='打开文件位置')`
  await waitFor(live, menuItem, 5000, 'File context menu offers 打开文件位置')
  assert.deepEqual(await evalOn(live, `Array.from(document.querySelectorAll('[role="menuitem"]')).map(e=>e.textContent.trim())`), ['打开文件', '打开文件位置', '复制文件路径'])
  assert.equal(await evalOn(live, `document.querySelector('a[href="https://example.com/report.md"]').hasAttribute('data-state')`), false)
  if (process.env.CRAFT_E2E_SCREENSHOTS) {
    const shot = await live.cdp.send('Page.captureScreenshot', { format: 'png' }, live.sid)
    writeFileSync(join(process.env.CRAFT_E2E_SCREENSHOTS, 'file-link-context-menu.png'), Buffer.from(shot.data, 'base64'))
  }
  // Capture the clipboard boundary without overwriting the user's system clipboard.
  await evalOn(live, `window.__copiedFilePath = null; navigator.clipboard.writeText = async text => { window.__copiedFilePath = text }`)
  await click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(e=>e.textContent.trim()==='复制文件路径')`, 'left')
  await waitFor(live, `window.__copiedFilePath === ${JSON.stringify(filePath)}`, 5000, 'Copy uses the decoded absolute file path')
  await waitFor(live, `!document.querySelector('[role="menu"]')`)
  await click(`document.querySelector(${JSON.stringify(selector)})`, 'right')
  await waitFor(live, menuItem)
  await click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(e=>e.textContent.trim()==='打开文件')`, 'left')
  await waitFor(live, `document.querySelector('.ProseMirror')?.textContent.includes('节拍表')`, 10000, 'Open file displays its contents in the side panel')
  assert.ok(await evalOn(live, `document.querySelector('.ProseMirror').getBoundingClientRect().left > document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().right`), 'The document opens to the right of the conversation')
  if (process.env.CRAFT_E2E_SCREENSHOTS) {
    const shot = await live.cdp.send('Page.captureScreenshot', {format:'png'},live.sid)
    writeFileSync(join(process.env.CRAFT_E2E_SCREENSHOTS, 'file-open-side-panel.png'),Buffer.from(shot.data,'base64'))
  }
  await click(`document.querySelector(${JSON.stringify(selector)})`, 'right')
  await waitFor(live, menuItem)
  await click(menuItem, 'left')
  let selected = ''
  for (let attempt = 0; attempt < 30; attempt++) {
    selected = execFileSync('osascript', ['-e', 'tell application "Finder"\nset chosen to get selection\nif (count of chosen) > 0 then return POSIX path of ((item 1 of chosen) as alias)\nend tell'], { encoding: 'utf8' }).trim()
    if (selected === filePath) break
    await sleep(100)
  }
  assert.equal(selected, filePath, 'Finder selects the decoded file in the conversation cwd, not the workspace root')
  console.log('PASS: three file actions → side-panel preview, decoded absolute clipboard path, correct Finder selection')
} catch (error) {
  if (app) {
    console.error(await evalOn(app, `({text:document.body.innerText.slice(-7000),viewers:Array.from(document.querySelectorAll('[data-file-viewer-kind]')).map(e=>e.outerHTML.slice(0,500))})`))
    if (process.env.CRAFT_E2E_SCREENSHOTS) {
      const shot = await app.cdp.send('Page.captureScreenshot', {format:'png'},app.sid)
      writeFileSync(join(process.env.CRAFT_E2E_SCREENSHOTS, 'file-actions-failure.png'), Buffer.from(shot.data,'base64'))
    }
  }
  console.error(error)
  throw error
} finally {
  await app?.close()
  if (directory) {
    execFileSync('osascript', ['-e', 'on run argv\ntell application "Finder"\nrepeat with w in (get every Finder window)\nif POSIX path of ((get target of w) as alias) is (item 1 of argv) then close w\nend repeat\nend tell\nend run', `${directory}/`])
  }
  rmSync(fixture, { recursive: true, force: true })
}
