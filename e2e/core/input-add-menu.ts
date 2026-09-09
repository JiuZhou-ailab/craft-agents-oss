// input: Built Electron and an offline project containing one skill and one local source
// output: Hover expansion, keyboard search, skill insertion and source-toggle assertions
// pos: Desktop composer add-menu regression check without model calls
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchApp, evalOn, callOn, waitFor, type LaunchedApp } from '../perf/launch'

const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'storyflow-add-menu-')))
let app: LaunchedApp | undefined
try {
  execFileSync(process.execPath, ['run', 'scripts/perf/generate-fixture.ts', '--out', fixture, '--scale', '0.01'], { cwd: resolve(import.meta.dirname, '../..'), stdio: 'pipe' })
  const config = JSON.parse(readFileSync(join(fixture, 'config.json'), 'utf8'))
  const workspace = config.workspaces[0]
  const skillDir = join(workspace.rootPath, '.pi', 'skills', 'hover-skill')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: hover-skill\nmetadata:\n  displayName: 悬停技能\ndescription: 技能内容预览\n---\n\n这是本地验收技能。\n')
  const sessionId = readdirSync(join(workspace.rootPath, '.craft-agent', 'sessions'))[0]!
  app = await launchApp(fixture)
  const live = app
  await waitFor(live, `document.querySelector('[data-tutorial="activity-profile"]')`)
  await evalOn(live, `Array.from(document.querySelectorAll('[role="dialog"] button')).find(b=>/继续使用|Continue/.test(b.textContent))?.click()`)
  const source = await callOn<{ slug: string }>(live, `async function(id, path) {
    await window.electronAPI.switchWorkspace(id);
    return window.electronAPI.createSource(id, {name:'悬停数据源',type:'local',provider:'local',local:{path}});
  }`, [workspace.id, workspace.rootPath])
  writeFileSync(join(fixture, 'sources', source.slug, 'config.json'), JSON.stringify({...source, tagline:'数据源内容预览'}))
  await evalOn(live, `(() => {const url=new URL(location.href); url.search=new URLSearchParams({workspaceId:${JSON.stringify(workspace.id)},ws:${JSON.stringify(workspace.id)},route:'allSessions/session/${sessionId}'}).toString(); location.href=url.href})()`)
  const editor = `document.querySelector('[contenteditable="true"]')`
  await waitFor(live, `${editor} && !document.querySelector('.z-splash')`)
  const point = async (expression: string) => evalOn<{x: number; y: number}>(live, `(() => {const e=${expression}; const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
  const click = async (expression: string) => {
    await evalOn(live, `(${expression}).scrollIntoView({block:'nearest'})`)
    const p = await point(expression)
    await live.cdp.send('Input.dispatchMouseEvent', {type:'mousePressed',...p,button:'left',clickCount:1},live.sid)
    await live.cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased',...p,button:'left',clickCount:1},live.sid)
  }
  const hover = async (expression: string) => live.cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved',...await point(expression)},live.sid)
  const item = (label: string) => `Array.from(document.querySelectorAll('[role="menuitem"]')).find(e=>e.textContent.trim()===${JSON.stringify(label)})`
  const key = async (key: string, code = key) => {
    await live.cdp.send('Input.dispatchKeyEvent', {type:'keyDown',key,code},live.sid)
    await live.cdp.send('Input.dispatchKeyEvent', {type:'keyUp',key,code},live.sid)
  }
  const plus = `document.querySelector('[data-tutorial="source-selector-button"]')`
  await click(editor)
  await live.cdp.send('Input.insertText', {text:'保留中文草稿'},live.sid)
  await click(plus)
  await waitFor(live, item('选择技能'))
  await hover(item('选择技能'))
  const skill = `Array.from(document.querySelectorAll('[role="menuitem"]')).find(e=>e.textContent.includes('技能内容预览'))`
  await waitFor(live, skill, 5000, 'Skill list opens on hover without a click')
  assert.ok(await evalOn(live, `(() => {const menu=document.querySelector('input[aria-label="选择技能"]').closest('[role="menu"]'); return Array.from(menu.querySelectorAll('[role="menuitem"]')).every(item=>item.scrollHeight<=item.clientHeight+1)})()`), 'Long skill descriptions must stay within their menu rows')
  await click(`document.querySelector('input[aria-label="选择技能"]')`)
  await live.cdp.send('Input.insertText', {text:'悬停'},live.sid)
  await waitFor(live, `(${skill}) && document.querySelectorAll('[role="menuitem"]').length===4`, 5000, 'Skill search narrows the list')
  if (process.env.CRAFT_E2E_SCREENSHOTS) {
    const shot = await live.cdp.send('Page.captureScreenshot', {format:'png'},live.sid)
    writeFileSync(join(process.env.CRAFT_E2E_SCREENSHOTS,'input-add-skills.png'),Buffer.from(shot.data,'base64'))
  }
  await click(skill)
  await waitFor(live, `${editor}.textContent.includes('悬停技能') && ${editor}.textContent.includes('保留中文草稿') && document.activeElement===${editor}`, 5000, 'Skill insertion preserves the draft and returns focus to the editor')
  await click(plus)
  await hover(item('选择数据源'))
  const sourceItem = `Array.from(document.querySelectorAll('[role="menuitemcheckbox"]')).find(e=>e.textContent.includes('悬停数据源'))`
  await waitFor(live, sourceItem, 5000, 'Source list opens on hover without a click')
  if (process.env.CRAFT_E2E_SCREENSHOTS) {
    const shot = await live.cdp.send('Page.captureScreenshot', {format:'png'},live.sid)
    writeFileSync(join(process.env.CRAFT_E2E_SCREENSHOTS,'input-add-sources.png'),Buffer.from(shot.data,'base64'))
  }
  await click(sourceItem)
  await waitFor(live, `(${sourceItem})?.getAttribute('aria-checked')==='true'`, 5000, 'Source toggles without closing the menu')
  const enabled = await callOn<string[]>(live, `async function(id) {return (await window.electronAPI.getSessionMessages(id)).enabledSourceSlugs}`, [sessionId])
  assert.ok(enabled.includes(source.slug))
  await click(`document.querySelector('input[aria-label="选择数据源"]')`)
  await live.cdp.send('Input.insertText', {text:'不存在的来源'},live.sid)
  await waitFor(live, `!(${sourceItem})`, 5000, 'Source search filters the list')
  await key('Escape')
  await waitFor(live, `!document.querySelector('[role="menu"]') && document.activeElement===${plus}`)
  await key('ArrowDown')
  await waitFor(live, item('选择数据源'))
  await key('End')
  await waitFor(live, `document.activeElement===(${item('选择数据源')})`)
  await key('ArrowRight')
  await waitFor(live, sourceItem, 5000, 'Keyboard can reopen the submenu')
  await click(`document.querySelector('input[aria-label="选择数据源"]')`)
  await live.cdp.send('Input.insertText', {text:'悬停'},live.sid)
  await key('ArrowDown')
  await waitFor(live, `document.activeElement===(${sourceItem})`)
  await key('Enter')
  await waitFor(live, `(${sourceItem})?.getAttribute('aria-checked')==='false'`, 5000, 'Keyboard can toggle a filtered source')
  console.log('PASS: skill/source hover, descriptions, draft-safe skill insertion, persistent source toggle and keyboard search')
} catch (error) {
  if (app) console.error(await evalOn(app, `({editor:document.querySelector('[contenteditable="true"]')?.outerHTML,active:document.activeElement?.outerHTML,menus:Array.from(document.querySelectorAll('[role="menu"]')).map(e=>e.textContent)})`))
  console.error(app?.processLines.slice(-10).join('\n'))
  throw error
} finally {
  await app?.close()
  rmSync(fixture, { recursive: true, force: true })
}
