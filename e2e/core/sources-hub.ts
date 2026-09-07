// input: Isolated Electron fixture and source routes
// output: Verifies source overview, modal selection, dismissal, and stable list width
// pos: Source page layout regression check without external services
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchApp, evalOn, type LaunchedApp } from '../perf/launch'
const fixture = mkdtempSync(join(tmpdir(), 'storyflow-sources-hub-'))
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
let app: LaunchedApp | undefined
try {
  execFileSync(process.execPath, ['run', 'scripts/perf/generate-fixture.ts', '--out', fixture, '--scale', '0.01'], { cwd: resolve(import.meta.dirname, '../..'), stdio: 'pipe' })
  const config = JSON.parse(readFileSync(join(fixture, 'config.json'), 'utf8'))
  app = await launchApp(fixture)
  await pause(6000)
  await evalOn(app, `Array.from(document.querySelectorAll('[role="dialog"] button')).find(b => /继续使用|Continue/.test(b.textContent))?.click()`)
  for (const workspaceId of ['__storyflow_free__', config.workspaces[0].id]) {
    await evalOn(app, `window.electronAPI.switchWorkspace(${JSON.stringify(workspaceId)})`)
    await evalOn(app, `window.electronAPI.createSource(${JSON.stringify(workspaceId)}, {name:'QA source',type:'local',provider:'local',local:{path:${JSON.stringify(fixture)}}})`)
    await evalOn(app, `(() => { const url = new URL(location.href); url.search = new URLSearchParams({workspaceId:${JSON.stringify(workspaceId)},ws:${JSON.stringify(workspaceId)},route:'sources'}).toString(); location.href=url.href })()`)
    for (let i = 0; i < 80; i++) {
      if (await evalOn(app, `!!document.querySelector('[data-testid="sources-hub"] h1') && document.body.innerText.includes('QA source')`)) break
      await pause(100)
    }
    assert.equal(await evalOn(app, `!!document.querySelector('[aria-modal="true"]')`), false, 'Entering sources must show the overview without selecting a source')
    assert.equal(await evalOn(app, `getComputedStyle(document.querySelector('[data-testid="sources-hub"] header')).getPropertyValue('-webkit-app-region')`), 'drag')
    assert.ok(await evalOn(app, `!!document.querySelector('[data-tutorial="add-source-button"]')`), `Add Source must exist in ${workspaceId}`)
    assert.equal(await evalOn(app, `getComputedStyle(document.querySelector('[data-tutorial="add-source-button"]').closest('.titlebar-no-drag')).getPropertyValue('-webkit-app-region')`), 'no-drag')
    const width = await evalOn(app, `document.querySelector('[data-testid="sources-hub"]').getBoundingClientRect().width`)
    assert.equal(await evalOn(app, `parseFloat(getComputedStyle(document.querySelector('h1')).fontSize) / parseFloat(getComputedStyle(document.documentElement).fontSize)`), 1.5)
    await evalOn(app, `Array.from(document.querySelectorAll('[data-testid="sources-hub"] button')).find(b => b.textContent.includes('QA source')).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`)
    await pause(800)
    assert.ok(await evalOn(app, `!!document.querySelector('[role="dialog"][aria-modal="true"]')`))
    assert.equal(await evalOn(app, `document.querySelector('[data-testid="sources-hub"]').getBoundingClientRect().width`), width)
    await app.cdp.send('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27}, app.sid)
    await pause(600)
    assert.equal(await evalOn(app, `!!document.querySelector('[aria-modal="true"]')`), false)
    console.log(`PASS: source creation entry and modal details in ${workspaceId}`)
  }
} finally {
  await app?.close()
  rmSync(fixture, {recursive:true,force:true})
}
