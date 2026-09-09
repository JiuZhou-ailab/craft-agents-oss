// input: Built Electron app and native rapid sidebar resize events
// output: Per-frame rail/container width equality, collapse/reopen, and saved-width assertions
// pos: Offline regression for sidebar resize paint gaps
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {launchApp,evalOn,waitFor,sleep} from '../perf/launch'
const fixture=mkdtempSync(join(tmpdir(),'storyflow-rail-drag-'))
let app
try {
execFileSync(process.execPath,['run','scripts/perf/generate-fixture.ts','--out',fixture,'--scale','0.01'],{cwd:resolve(import.meta.dirname,'../..'),stdio:'pipe'})
app=await launchApp(fixture)
await waitFor(app,`document.querySelector('[aria-label="调整侧边栏宽度"]') && !document.querySelector('.z-splash')`)
await evalOn(app,`Array.from(document.querySelectorAll('[role="dialog"] button')).find(b=>/继续使用|Continue/.test(b.textContent))?.click()`)
await evalOn(app,`window.__dragFrames=[];window.__dragProbe=true;(()=>{const sample=()=>{if(!window.__dragProbe)return;const rail=document.querySelector('[data-testid="activity-rail"]'),wrapper=rail.parentElement;window.__dragFrames.push({time:performance.now(),rail:rail.getBoundingClientRect().width,wrapper:wrapper.getBoundingClientRect().width,background:getComputedStyle(wrapper).backgroundColor});requestAnimationFrame(sample)};sample()})()`)
const p=await evalOn(app,`(()=>{const r=document.querySelector('[aria-label="调整侧边栏宽度"]').getBoundingClientRect();return {x:r.right-3,y:r.top+300}})()`)
await app.cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...p},app.sid)
await app.cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',buttons:1,clickCount:1},app.sid)
await app.cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x+120,y:p.y,button:'left',buttons:1},app.sid)
await sleep(400)
await app.cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x-40,y:p.y,button:'left',buttons:1},app.sid)
await sleep(40)
if(process.env.CRAFT_E2E_SCREENSHOTS){
const shot=await app.cdp.send('Page.captureScreenshot',{format:'png'},app.sid)
writeFileSync(join(process.env.CRAFT_E2E_SCREENSHOTS,'activity-rail-resize.png'),Buffer.from(shot.data,'base64'))
}
await app.cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x-40,y:p.y,button:'left',buttons:0,clickCount:1},app.sid)
await sleep(700)
const result=await evalOn<{peakGap:number;last:{rail:number;wrapper:number}}>(app,`window.__dragProbe=false;(()=>{const frames=window.__dragFrames;return {peakGap:Math.max(...frames.map(f=>Math.abs(f.wrapper-f.rail))),last:frames.at(-1)}})()`)
assert.ok(result.peakGap<=1,`Rail/container width mismatch: ${result.peakGap}px`)
assert.equal(result.last.rail,200)
assert.equal(result.last.wrapper,200)
await evalOn(app, `document.querySelector('[aria-label="收起侧边栏"]').click()`)
await waitFor(app, `!document.querySelector('[data-testid="activity-rail"]')`)
await evalOn(app, `document.querySelector('[aria-label="展开侧边栏"]').click()`)
await waitFor(app, `document.querySelector('[data-testid="activity-rail-motion"]')?.getBoundingClientRect().width === 200`)
await evalOn(app, `location.reload()`)
await waitFor(app, `document.querySelector('[aria-label="调整侧边栏宽度"]')?.getAttribute('aria-valuenow') === '200' && !document.querySelector('.z-splash')`)
console.log('PASS: every drag frame stays aligned; collapse/reopen and saved width work',result)
}finally{await app?.close();rmSync(fixture,{recursive:true,force:true})}
