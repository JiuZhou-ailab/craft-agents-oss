// input: Standard fixture and built Electron; PERF_CATALOG_RUNS controls local sampling
// output: Application click-to-directory samples, legacy wall times, and existing filesystem spans
// pos: Real Electron catalog acceptance alongside the existing performance driver
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchApp, evalOn, waitFor, heapUsed, DEFAULT_FIXTURE, verifyStandardFixture } from './launch'
import { enterFirstWritingWorkspace, openWritingChapter, navigateToWritingWorkspace } from './run'
import { parsePositiveInteger, percentile } from './contract'

const runs = parsePositiveInteger(process.env.PERF_CATALOG_RUNS, 20, 'PERF_CATALOG_RUNS')
const fixture = process.env.PERF_FIXTURE ?? DEFAULT_FIXTURE
const root = resolve(import.meta.dirname, '../..')
const renderer = process.env.VITE_DEV_SERVER_URL ? fileURLToPath(process.env.VITE_DEV_SERVER_URL) : join(root, 'apps/electron/dist/renderer/index.html')
const report: { cold: unknown[]; warm: unknown[]; failure?: string; [key: string]: unknown } = {
  cold: [], warm: [], baseline: process.env.PERF_BASELINE === '1', at: new Date().toISOString(), fixture,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  buildSha256: Object.fromEntries([join(root, 'apps/electron/dist/main.cjs'), renderer].map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
}
const install = `(() => {
  window.__catalogTiming = { timeOrigin: performance.timeOrigin, project: null, session: null, route: null, ready: null };
  const timing = window.__catalogTiming;
  const click = e => {
    if (e.target.closest('button[aria-label^="项目："],button[aria-label^="Project:"]')) timing.project = performance.now();
    if (e.target.closest('[data-session-id] button')) timing.session = performance.now();
  };
  const route = () => { timing.route = performance.now() };
  document.addEventListener('click', click, true);
  window.addEventListener('craft-agent-navigate', route);
  const observer = new MutationObserver(() => {
    if (timing.ready !== null || timing.session === null) return;
    const row = [...document.querySelectorAll('[data-panel-role="directory"] [role="treeitem"]')].find(el => el.firstElementChild?.title === '正文');
    if (row && row.getBoundingClientRect().height > 0) {
      timing.ready = performance.now(); observer.disconnect();
    }
  });
  observer.observe(document.body, {subtree:true,childList:true,attributes:true});
  window.__stopCatalogTiming = () => {observer.disconnect();document.removeEventListener('click',click,true);window.removeEventListener('craft-agent-navigate',route)};
})()`
try {
  const openProject = async (live: Awaited<ReturnType<typeof launchApp>>, writing: boolean) => {
    await evalOn(live, `(() => {
      const button = [...document.querySelectorAll('button[aria-label^="项目："]')].find(b => (b.title === '400章长篇小说') === ${writing});
      if (!button) throw new Error('Missing fixture project');
      window.__catalogProjectRoot = button.parentElement.parentElement;
      if (button.getAttribute('aria-expanded') !== 'true') button.click();
    })()`)
    await waitFor(live, '!!window.__catalogProjectRoot.querySelector("[data-session-id] button")', 30000, 'target project session')
    await evalOn(live, 'window.__catalogProjectRoot.querySelector("[data-session-id] button").click()')
  }
  for (let i = 0; i < runs; i++) {
    const live = await launchApp(fixture)
    try {
      await waitFor(live, '!!window.electronAPI', 30000, 'preload')
      await evalOn(live, install)
      if (process.env.PERF_CATALOG_PROFILE === '1') { await live.cdp.send('Profiler.enable', {}, live.sid); await live.cdp.send('Profiler.start', {}, live.sid) }
      const legacy = await enterFirstWritingWorkspace(live)
      await waitFor(live, 'window.__catalogTiming.ready !== null', 10000, 'real catalog rows')
      report.cold.push({ ...await evalOn(live, 'window.__catalogTiming'), legacyWallMs: legacy.catalogReadyAt - legacy.projectClickedAt, startupMarks: legacy.startupMarks, spans: live.perfLines.map(line => line.text).filter(line => /listFiles/.test(line)) })
      if (process.env.PERF_CATALOG_PROFILE === '1') writeFileSync('/tmp/storyflow-catalog-profile.json', JSON.stringify(await live.cdp.send('Profiler.stop', {}, live.sid)))
      await evalOn(live, 'window.__stopCatalogTiming()')
      console.log('cold sample', JSON.stringify(report.cold.at(-1)))
      if (i === 0) {
        await verifyStandardFixture(live, fixture)
        report.fixtureVerified = true
        report.heapAfterColdMb = await heapUsed(live) / 1e6
        for (let j = 0; j < 30; j++) {
          await openProject(live, false)
          await waitFor(live, `![...document.querySelectorAll('[data-panel-role="directory"] [role="treeitem"]')].some(el => el.firstElementChild?.title === '正文')`, 10000, 'previous catalog left')
          await evalOn(live, install)
          await openProject(live, true)
          await navigateToWritingWorkspace(live)
          await waitFor(live, 'window.__catalogTiming.ready !== null', 10000, 'warm catalog rows')
          report.warm.push(await evalOn(live, 'window.__catalogTiming'))
          await evalOn(live, 'window.__stopCatalogTiming()')
        }
      }
      if (i === 0 && process.env.PERF_CATALOG_RECOVERY === '1') {
        await openWritingChapter(live, 1)
        const config = JSON.parse(readFileSync(join(fixture, 'config.json'), 'utf8'))
        const workspaceRoot = config.workspaces.find((w: { name: string }) => w.name === '400章长篇小说').rootPath
        const directory = join(workspaceRoot.replace(/^~(?=\/|$)/, homedir()), '正文')
        const mode = statSync(directory).mode & 0o777
        try {
          await evalOn(live, `(() => {
            const editor = document.querySelector('.tiptap-editor--manuscript .ProseMirror');
            window.__catalogEditor = editor; editor.focus();
            const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
            getSelection().removeAllRanges(); getSelection().addRange(range);
          })()`)
          chmodSync(directory, 0)
          await live.cdp.send('Input.insertText', { text: ' UNSAVED_CATALOG_GUARD' }, live.sid)
          await evalOn(live, 'window.dispatchEvent(new Event("focus"))')
          const retry = `[...document.querySelectorAll('[role="alert"] button')].find(b => /重试|Retry/.test(b.textContent))`
          await waitFor(live, `!!(${retry})`, 5000, 'catalog read error')
          await evalOn(live, `(${retry}).click()`)
          await waitFor(live, `!!(${retry})`, 5000, 'repeated catalog read error')
          assert.ok(await evalOn(live, `document.querySelector('.tiptap-editor--manuscript .ProseMirror') === window.__catalogEditor && window.__catalogEditor.textContent.includes('UNSAVED_CATALOG_GUARD')`), 'Failed catalog retry must preserve the mounted dirty editor')
          chmodSync(directory, mode)
          await evalOn(live, `(${retry}).click()`)
          await waitFor(live, `!(${retry})`, 5000, 'catalog retry success')
          assert.ok(await evalOn(live, `document.querySelector('.tiptap-editor--manuscript .ProseMirror') === window.__catalogEditor && window.__catalogEditor.textContent.includes('UNSAVED_CATALOG_GUARD')`))
          report.recovery = { repeatedFailurePreservedEditor: true, retryRecovered: true }
        } finally { chmodSync(directory, mode) }
      }
      console.log('catalog', i + 1, JSON.stringify(report.cold.at(-1)))
    } finally { await live.close() }
  }
  const budgets: Record<string, unknown> = {}
  report.budgets = budgets
  for (const [kind, samples] of Object.entries(report)) {
    if (!Array.isArray(samples)) continue
    const ms = samples.map((s: any) => s.ready - s.session).sort((a,b) => a-b)
    assert.ok(ms.length > 0 && ms.every(Number.isFinite), 'Missing catalog samples')
    budgets[kind] = {n:ms.length,p50:percentile(ms,.5),p95:percentile(ms,.95),max:ms.at(-1),pass:percentile(ms,.5)<=100 && percentile(ms,.95)<=500}
    console.log(kind, JSON.stringify(budgets[kind]))

  }
  if (process.env.PERF_BASELINE !== '1') assert.ok(Object.values(budgets).every((value: any) => value.pass), 'Catalog performance budget')
} catch (error) { report.failure = String(error); process.exitCode = 1; console.error(error) }
finally {
  mkdirSync(join(import.meta.dirname, 'results'), { recursive:true })
  const output = join(import.meta.dirname, 'results', `catalog-${Date.now()}.json`)
  writeFileSync(output, JSON.stringify(report,null,2)); console.log('Evidence:',output)
}
