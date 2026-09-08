// input: Standard fixture, built Electron, deterministic local model SSE
// output: First-text latency, source-locator QA, and 20/50-session process-tree diagnostics
// pos: Spec #29 user-visible and runtime performance evidence; no external provider calls

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'vite'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchApp, evalOn, callOn, waitFor, heapUsed, sleep, type LaunchedApp } from './launch'

const root = resolve(import.meta.dirname, '../..')
const connection = 'offline-perf'
const baseline = process.env.PERF_BASELINE === '1'
const diagnostic = process.env.PERF_RUNTIME === '1'
const selected = (process.env.PERF_INTERACTIONS ?? (diagnostic ? 'runtime' : 'first-text,long-stream,search-navigation,markdown')).split(',')
const allowed = ['first-text', 'long-stream', 'search-navigation', 'markdown', 'runtime']
assert.ok(selected.length && selected.every(s => allowed.includes(s)) && new Set(selected).size === selected.length, 'Invalid PERF_INTERACTIONS')
assert.ok(!selected.includes('runtime') || selected.length === 1, 'Run runtime alone so residency stages contain exactly 20/50 sessions')
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'storyflow-interaction-')))
let app: LaunchedApp | undefined
let responseText = '中文首片暂停测试'
let requests = 0
let streamLong = false
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (!new URL(request.url).pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 })
  const body = await request.json() as any
  const isAgent = body.tools?.length > 0
  if (isAgent) requests++
  const text = isAgent ? responseText : 'Offline test'
  const sse = (content: string, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: 'offline', model: connection, choices: [{ index: 0, delta: { content }, finish_reason }] })}\n\n`
  return new Response(new ReadableStream({ async start(controller) {
    controller.enqueue(new TextEncoder().encode(sse(text.slice(0, 12))))
    await sleep(isAgent ? 800 : 0)
    if (streamLong && isAgent) {
      const chunkSize = Math.max(12, Math.ceil(text.length / 120))
      for (let offset = 12; offset < text.length; offset += chunkSize) {
        controller.enqueue(new TextEncoder().encode(sse(text.slice(offset, offset + chunkSize))))
        await sleep(30)
      }
    } else if (text.length > 12) controller.enqueue(new TextEncoder().encode(sse(text.slice(12))))
    controller.enqueue(new TextEncoder().encode(sse('', 'stop') + 'data: [DONE]\n\n'))
    controller.close()
  } }), { headers: { 'content-type': 'text/event-stream' } })
} })
const results: Record<string, unknown> = {
  at: new Date().toISOString(), baseline, scenarios: selected, bun: Bun.version,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  buildSha256: Object.fromEntries(['apps/electron/dist/main.cjs', 'apps/electron/dist/renderer/index.html'].map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')])),
  dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
}
function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  return { n: samples.length, p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) }
}
function processTree(pid: number) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' }).trim().split('\n').map(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)!
    return { pid: +m[1]!, ppid: +m[2]!, rssKb: +m[3]!, command: m[4]! }
  })
  const ids = new Set([pid])
  for (let size = -1; size !== ids.size;) { size = ids.size; for (const row of rows) if (ids.has(row.ppid)) ids.add(row.pid) }
  const tree = rows.filter(row => ids.has(row.pid))
  return { rssMb: tree.reduce((sum, row) => sum + row.rssKb, 0) / 1024, piCount: tree.filter(row => /pi-agent-server/.test(row.command)).length, processes: tree }
}
try {
  execFileSync(process.execPath, ['run', 'scripts/perf/generate-fixture.ts', '--out', fixture, '--scale', '1'], { cwd: root, stdio: 'pipe' })
  const configPath = join(fixture, 'config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const workspace = config.workspaces[0]
  config.llmConnections = [{ slug: connection, name: 'Offline performance', providerType: 'pi_compat', baseUrl: `http://127.0.0.1:${server.port}/v1`, authType: 'none', models: [connection], defaultModel: connection, customEndpoint: { api: 'openai-completions' }, createdAt: Date.now() }]
  const searchFiles = [
    { name: 'zz-search.md', query: 'MARKDOWN_SEARCH', content: '# Source lines\n\n' + 'A paragraph before the target.\n\n'.repeat(90) + '- Correct **MARKDOWN_SEARCH** occurrence\n\n- Later MARKDOWN_SEARCH occurrence' },
    { name: 'zz-search.txt', query: 'TEXT_SEARCH', content: 'A line before the target.\n'.repeat(90) + 'Correct TEXT_SEARCH occurrence\nLater TEXT_SEARCH occurrence' },
    { name: 'zz-search.log', query: 'LOG_SEARCH', content: 'A line before the target.\n'.repeat(90) + 'Correct LOG_SEARCH occurrence\nLater LOG_SEARCH occurrence' },
  ]
  for (const file of searchFiles) writeFileSync(join(workspace.rootPath, file.name), file.content)
  config.defaultLlmConnection = connection
  writeFileSync(configPath, JSON.stringify(config))
  app = await launchApp(fixture)
  const live = app
  await sleep(5000)
  await evalOn(live, `Array.from(document.querySelectorAll('[role="dialog"] button')).find(b => /继续使用|Continue/.test(b.textContent))?.click()`)
  results.electron = await evalOn(live, 'navigator.userAgent')
  await callOn(live, `async function(id) { await window.electronAPI.switchWorkspace(id); const url = new URL(location.href); url.search = new URLSearchParams({workspaceId:id,ws:id,route:'allSessions'}).toString(); location.href = url.href }`, [workspace.id])
  await sleep(3000)
  const create = async () => await callOn<{ id: string }>(live, `async function(workspaceId, rootPath, connection) { return window.electronAPI.createSession(workspaceId, {name:'Offline performance', permissionMode:'ask', workingDirectory:rootPath, llmConnection:connection, model:connection}) }`, [workspace.id, workspace.rootPath, connection])
  const navigate = async (id: string) => {
    await callOn(live, `function(id) { const url = new URL(location.href); url.searchParams.set('route','allSessions/session/'+id); location.href=url.href }`, [id])
    await sleep(1800)
    await waitFor(live, '!!document.querySelector(".input-container")', 20000, 'conversation input')
  }
  const send = async (id: string) => {
    await callOn(live, `async function(id) { await window.electronAPI.sendMessage(id, 'Reply with the offline fixture') }`, [id])
    for (let i = 0; i < 600; i++) {
      const done = await callOn(live, `async function(id) { const s = await window.electronAPI.getSessionMessages(id); return !s.isProcessing && s.messages.some(m => m.role === 'assistant') }`, [id])
      if (done) { await sleep(100); return }
      await sleep(50)
    }
    throw new Error('Offline reply timeout: '+live.processLines.slice(-12).join('\n'))
  }
  const latencies: number[] = []
  const texts = ['中文首片暂停测试', '日本語の最初の応答', 'Yes', '混合 mixed response', '```ts\nconst value = 1']
  for (let i = 0; i < (selected.includes('first-text') ? 20 : 0); i++) {
    const session = await create()
    responseText = texts[i % texts.length]!
    await navigate(session.id)
    await callOn(live, `function(id) {
      window.__firstText = {delta:null, visible:null};
      const off = window.electronAPI.onSessionEvent(e => { if(e.sessionId === id && e.type === 'text_delta' && e.delta?.trim() && window.__firstText.delta === null) window.__firstText.delta = performance.now() });
      const observer = new MutationObserver(() => { if(window.__firstText.delta !== null && window.__firstText.visible === null && document.querySelector('[data-search-root="response"]')?.textContent.trim()) window.__firstText.visible = performance.now() });
      observer.observe(document.body,{subtree:true,childList:true,characterData:true});
      window.__stopFirstText = () => {off();observer.disconnect()};
    }`, [session.id])
    await send(session.id)
    const sample = await evalOn<{ delta: number | null; visible: number | null }>(live, 'window.__firstText')
    await evalOn(live, 'window.__stopFirstText()')
    assert.ok(sample.delta !== null && sample.visible !== null, JSON.stringify({ sample, ui: await evalOn(live, '({url:location.href, text:document.body.innerText.slice(-2000)})'), logs: live.processLines.slice(-15) }))
    latencies.push(sample.visible - sample.delta)
  }
  if (latencies.length) { results.firstTextMs = stats(latencies); console.log('firstTextMs', results.firstTextMs) }
  if (selected.includes('runtime')) {
    const stages = []
    const ids: string[] = []
    for (let i = 0; i < 50; i++) {
      const session = await create(); ids.push(session.id)
      await navigate(session.id)
      responseText = 'Offline lifecycle reply'
      await send(session.id)
      if (i === 19 || i === 49) {
        await callOn(live, `function() { window.dispatchEvent(new CustomEvent('craft-agent-navigate', {detail:{route:'allSessions'}})) }`, [])
        await sleep(3000)
        const released = await callOn<number>(live, `async function(ids) { const results = await Promise.all(ids.map(id => window.electronAPI.releaseSessionMessages(id))); return results.filter(Boolean).length }`, [ids])
        const heapMb = await heapUsed(live) / 1e6
        const tree = processTree(live.proc.pid!)
        const readBegin = performance.now()
        await callOn(live, `async function(id) { return window.electronAPI.getSessionMessages(id) }`, [ids[0]])
        const coldTranscriptMs = performance.now() - readBegin
        await navigate(ids[0]!)
        await callOn(live, `function(id) { window.__resumeDelta = null; window.__resumeOff = window.electronAPI.onSessionEvent(e => {if(e.sessionId === id && e.type==='text_delta' && window.__resumeDelta===null) window.__resumeDelta=performance.now()-window.__resumeStart}) }`, [ids[0]])
        await callOn(live, `async function(id) {window.__resumeStart=performance.now(); await window.electronAPI.sendMessage(id,'Reply with the offline fixture')}`, [ids[0]])
        await waitFor(live, 'window.__resumeDelta !== null', 30000, 'resume first delta')
        const resumeFirstDeltaMs = await evalOn(live, 'window.__resumeDelta')
        await evalOn(live, 'window.__resumeOff()')
        await sleep(1200)
        stages.push({ sessions: i + 1, releasedTranscripts: released, heapMb, ...tree, coldTranscriptMs, resumeFirstDeltaMs })
        console.log('runtime stage', JSON.stringify({ sessions: i + 1, heapMb, rssMb: tree.rssMb, piCount: tree.piCount, resumeFirstDeltaMs }))
      }
    }
    results.runtime = stages
  }
  if (selected.includes('long-stream')) {
    const sessionsRoot = join(workspace.rootPath, '.craft-agent', 'sessions')
    const largeTranscript = readdirSync(sessionsRoot).map(id => readFileSync(join(sessionsRoot, id, 'session.jsonl'), 'utf8'))
      .sort((a, b) => b.split('\n').length - a.split('\n').length)[0]!
    const longSamples = []
    for (const size of [2000, 10000, 30000]) {
      const session = await create()
      await callOn(live, `async function(id) { return window.electronAPI.releaseSessionMessages(id) }`, [session.id])
      const filePath = join(sessionsRoot, session.id, 'session.jsonl')
      const header = readFileSync(filePath, 'utf8').split('\n')[0]
      writeFileSync(filePath, header + '\n' + largeTranscript.slice(largeTranscript.indexOf('\n') + 1))
      await navigate(session.id)
      responseText = ('Paragraph **bold** with [reference][r].\n\n- List item\n- Second item\n\n').repeat(Math.ceil(size / 70)).slice(0, size) + '\n\n[r]: https://example.com\n\nSTREAM_FINAL_MARKER'
      streamLong = true
      await evalOn(live, `(() => {
        const el = document.querySelector('[data-tutorial="chat-input"]'); el.focus();
        window.__typing = {echo:[],settle:[],started:null};
        window.__keydown = () => window.__typing.started=performance.now();
        window.__input = () => { const start=window.__typing.started; if(start===null)return; window.__typing.started=null; void el.getBoundingClientRect(); window.__typing.echo.push(performance.now()-start); setTimeout(()=>{void el.getBoundingClientRect();window.__typing.settle.push(performance.now()-start)},0) };
        window.addEventListener('keydown',window.__keydown,true);window.addEventListener('input',window.__input);
      })()`)
      await evalOn(live, `window.__streamDeltas=0;window.__streamOff=window.electronAPI.onSessionEvent(e => {if(e.type==='text_delta')window.__streamDeltas++})`)
      const sending = send(session.id)
      await waitFor(live, 'window.__streamDeltas > 0', 30000, 'long reply first delta')
      await sleep(850)
      for (const ch of 'abcdefghijklmnopqrstuvwx0123456789') {
        await live.cdp.send('Input.dispatchKeyEvent', { type:'keyDown', key:ch, text:ch }, live.sid)
        await live.cdp.send('Input.dispatchKeyEvent', { type:'keyUp', key:ch }, live.sid)
        await sleep(30)
      }
      // Exercise Chromium's composition path while later chunks are still arriving.
      const deltasBeforeIme = await evalOn<number>(live, 'window.__streamDeltas')
      if (size === 30000) assert.ok(await callOn(live, `async function(id) {return (await window.electronAPI.getSessionMessages(id)).isProcessing}`, [session.id]), 'Long reply must still be streaming before IME')
      const compositionStart = performance.now()
      await live.cdp.send('Input.imeSetComposition', { text:'中文输入', selectionStart:4, selectionEnd:4 }, live.sid)
      await live.cdp.send('Input.insertText', { text:'中文输入' }, live.sid)
      assert.ok(await evalOn(live, `document.querySelector('[data-tutorial="chat-input"]').textContent.includes('中文输入')`), 'IME commit must preserve composed text')
      const imeCommitMs = performance.now() - compositionStart
      if (size === 30000) {
        await sleep(150)
        assert.ok(await callOn(live, `async function(id) {return (await window.electronAPI.getSessionMessages(id)).isProcessing}`, [session.id]), 'Long reply must still be streaming after IME')
        assert.ok(await evalOn<number>(live, 'window.__streamDeltas') > deltasBeforeIme, 'IME must overlap actual incoming deltas')
      }
      let reading: unknown
      if (size === 30000) {
        const point = await evalOn(live, `(() => { const r=document.querySelector('[data-focus-zone="chat"] [data-radix-scroll-area-viewport]').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
        await live.cdp.send('Input.dispatchMouseEvent', {type:'mouseWheel', ...point, deltaY:-500, deltaX:0}, live.sid)
        await sleep(200)
        reading = await evalOn(live, `(() => {
          const viewport=document.querySelector('[data-focus-zone="chat"] [data-radix-scroll-area-viewport]');
          const responses=Array.from(viewport.querySelectorAll('[data-search-root="response"]'));
          const content=responses.slice(0,-1).at(-1); content.scrollIntoView({block:'center'}); const node=document.createTreeWalker(content,NodeFilter.SHOW_TEXT).nextNode();
          const range=document.createRange();range.setStart(node,0);range.setEnd(node,Math.min(12,node.length));getSelection().removeAllRanges();getSelection().addRange(range);
          window.__reading={selection:getSelection().toString(),top:viewport.scrollTop};return window.__reading;
        })()`)
        await sleep(500)
        assert.deepEqual(await evalOn(live, `({selection:getSelection().toString(),top:document.querySelector('[data-focus-zone="chat"] [data-radix-scroll-area-viewport]').scrollTop})`), reading, 'Streaming must preserve historical selection and scroll position')
      }
      await sending
      await evalOn(live, 'window.__streamOff()')
      const typing = await evalOn(live, `(() => {window.removeEventListener('keydown',window.__keydown,true);window.removeEventListener('input',window.__input);return window.__typing})()`)
      assert.equal(typing.echo.length, 34)
      if (!baseline) assert.ok(stats(typing.echo).p95! < 16.7, 'Long-stream typing P95 must remain below 16.7ms')
      const persisted = await callOn<string>(live, `async function(id) {const s=await window.electronAPI.getSessionMessages(id);return s.messages.filter(m=>m.role==='assistant').at(-1).content}`, [session.id])
      assert.equal(persisted, responseText)
      assert.ok(await evalOn(live, `Array.from(document.querySelectorAll('[data-search-root="response"]')).at(-1)?.textContent.includes('STREAM_FINAL_MARKER')`))
      longSamples.push({ size:responseText.length, imeCommitMs, imeOverlapVerified:size===30000, reading, historyMessages:largeTranscript.split('\n').length-2, typingEchoMs:stats(typing.echo), typingSettleMs:stats(typing.settle) })
    }
    streamLong = false
    results.longStream = longSamples
    console.log('longStream', JSON.stringify(longSamples))
  }
  const navigation = []
  for (const [index, file] of (selected.includes('search-navigation') ? searchFiles : []).entries()) {
    const path = join(workspace.rootPath, file.name)
    const openSearch = async () => {
      await evalOn(live, `document.querySelector('[data-tutorial="activity-search"]').click()`)
      await waitFor(live, `!!document.querySelector('[cmdk-input]')`, 5000, 'search input')
      await live.cdp.send('Input.insertText', { text: file.query }, live.sid)
      await waitFor(live, `document.querySelector('[data-global-search-state]')?.getAttribute('data-global-search-state') === 'complete'`, 5000, 'search complete')
    }
    const select = async () => {
      if (index === 0) {
        await live.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, live.sid)
        await live.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, live.sid)
      } else await callOn(live, `function(path) { document.querySelector('[cmdk-item][data-value="file:'+path+'"]').click() }`, [path])
      await sleep(800)
    }
    await openSearch(); await select()
    const location = await evalOn(live, `(() => { const s=getSelection(); const mark=document.querySelector('[data-document-search-match]'); const r=mark?.getBoundingClientRect() ?? (s?.rangeCount ? s.getRangeAt(0).getBoundingClientRect() : null); const prefix=mark ? (()=>{const range=document.createRange();range.selectNodeContents(mark.parentElement);range.setEndBefore(mark);return range.toString()})() : undefined; return {sourceOffset:prefix?.length,state:document.querySelector('[data-document-search-state]')?.getAttribute('data-document-search-state'), active:document.activeElement?.outerHTML.slice(0,120), text:mark?.textContent ?? s?.toString(), parent:(mark?.parentElement ?? s?.anchorNode?.parentElement?.closest('p,li'))?.textContent.slice(-100), visible:!!r && r.top>=0 && r.bottom<=innerHeight, tabs:document.querySelectorAll('[data-panel-role="writing-file-tabs"] [role="tab"]').length} })()`)
    navigation.push({ name: file.name, location })
    results.searchNavigation = navigation
    console.log('location', JSON.stringify(location))
    if (!baseline) {
      assert.equal(location.text, file.query)
      if (file.name.endsWith('.log')) assert.equal(location.sourceOffset, file.content.indexOf(file.query), 'Plain preview must highlight the actual hit offset')
      assert.ok(location.parent?.includes('Correct'), JSON.stringify(location))
      assert.ok(location.visible, JSON.stringify(location))
      await openSearch(); await select()
      assert.equal(await evalOn(live, `document.querySelectorAll('[data-panel-role="writing-file-tabs"] [role="tab"]').length`), location.tabs)
      // Keep the original RPC hit, mutate its source before selection, and verify a truthful fallback.
      await openSearch()
      writeFileSync(path, 'Inserted paragraph.\n\n' + file.content)
      await select()
      assert.equal(await evalOn(live, "document.querySelector('[data-document-search-match]')?.textContent ?? getSelection()?.toString()"), file.query)
      assert.ok(await evalOn(live, "Array.from(document.querySelectorAll('[role=status]')).some(el => /文件内容已变化|file changed/i.test(el.textContent))"), 'Changed source must disclose relocation')
      await openSearch()
      writeFileSync(path, 'The match has been removed.')
      await select()
      assert.ok(await evalOn(live, "Array.from(document.querySelectorAll('[role=status]')).some(el => /已失效|no longer present/i.test(el.textContent))"), 'Missing match must disclose staleness')
    }
  }
  if (navigation.length) { results.searchNavigation = navigation; console.log('searchNavigation', JSON.stringify(navigation)) }
  if (selected.includes('search-navigation') && !baseline) {
    const source = join(workspace.rootPath, 'zz-save-source.md')
    const destination = join(workspace.rootPath, 'zz-save-destination.md')
    writeFileSync(source, '# SAVE_GUARD_SOURCE\n\nOriginal source.')
    writeFileSync(destination, '# SAVE_GUARD_DESTINATION\n\nDestination source.')
    const choose = async (query: string, path: string) => {
      await evalOn(live, `document.querySelector('[data-tutorial="activity-search"]').click()`)
      await waitFor(live, `!!document.querySelector('[cmdk-input]')`, 5000, 'save guard search')
      await live.cdp.send('Input.insertText', {text:query}, live.sid)
      await waitFor(live, `document.querySelector('[data-global-search-state]')?.getAttribute('data-global-search-state') === 'complete'`, 5000, 'save guard results')
      await callOn(live, `function(path) {document.querySelector('[cmdk-item][data-value="file:'+path+'"]').click()}`, [path])
      await sleep(800)
    }
    await choose('SAVE_GUARD_SOURCE', source)
    chmodSync(source, 0o444)
    try {
      await evalOn(live, `(() => {const editor=document.querySelector('.tiptap');editor.focus();const range=document.createRange();range.selectNodeContents(editor);range.collapse(false);getSelection().removeAllRanges();getSelection().addRange(range)})()`)
      await live.cdp.send('Input.insertText', {text:' UNSAVED_SEARCH_GUARD'}, live.sid)
      await choose('SAVE_GUARD_DESTINATION', destination)
      assert.ok(await evalOn(live, `document.querySelector('.tiptap')?.textContent.includes('UNSAVED_SEARCH_GUARD')`), 'Save failure must keep the edited source open')
      assert.ok(await evalOn(live, `document.querySelector('[data-panel-role="writing-file-tabs"] [aria-selected=true]')?.getAttribute('title') === 'zz-save-source.md'`), 'Save failure must not switch tabs')
      assert.ok(!readFileSync(source,'utf8').includes('UNSAVED_SEARCH_GUARD'))
    } finally { chmodSync(source, 0o644) }
    await choose('SAVE_GUARD_DESTINATION', destination)
    assert.ok(readFileSync(source,'utf8').includes('UNSAVED_SEARCH_GUARD'), 'Successful switch must persist the old buffer')
    results.searchSaveGuard = { failedSaveKeptBuffer:true, successfulSwitchPersisted:true }
  }
  if (selected.includes('markdown')) {
  const vite = await createServer({
    configFile: join(root, 'apps/electron/vite.config.ts'),
    cacheDir: join(fixture, '.vite'),
    optimizeDeps: { entries: [join(root, 'e2e/perf/markdown-probe.tsx')] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
    plugins: [{ name: 'markdown-perf-probe', configureServer(server) {
      server.middlewares.use('/perf-probe', async (_req, res) => {
        res.setHeader('content-type', 'text/html')
        res.end(await server.transformIndexHtml('/perf-probe', `<html><body><script type="module" src="/@fs/${root}/e2e/perf/markdown-probe.tsx"></script></body></html>`))
      })
    } }],
  })
  await vite.listen()
  try {
    const address = vite.httpServer!.address() as { port: number }
    await live.cdp.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/perf-probe` }, live.sid)
    await waitFor(live, '!!window.__markdownProbe', 30000, 'Markdown component probe')
    results.markdown = await evalOn(live, 'window.__markdownProbe')
    assert.ok(!(results.markdown as any).error, JSON.stringify(results.markdown))
  } finally {
    // Bun/Vite can leave close() pending after its listener has closed; bound harness teardown.
    await Promise.race([vite.close(), sleep(2000)])
  }
  }
  results.modelRequests = requests
  const keys: Record<string, string> = { 'first-text':'firstTextMs', 'long-stream':'longStream', 'search-navigation':'searchNavigation', markdown:'markdown', runtime:'runtime' }
  assert.ok(selected.every(s => results[keys[s]!] !== undefined), 'Missing selected scenario evidence')
  results.coveragePass = true
  if (!baseline && selected.includes('first-text')) assert.ok(stats(latencies).p95! < 100, 'First-text P95 must be <100ms')
} catch (error) {
  results.failure = String(error)
  if (app) { results.logs = app.processLines.slice(-30); results.ui = await evalOn(app, '({url:location.href,text:document.body.innerText.slice(-1500)})').catch(() => null) }
  throw error
} finally {
  mkdirSync(join(root, 'e2e/perf/results'), { recursive: true })
  const output = join(root, 'e2e/perf/results', `interaction-${Date.now()}-${baseline ? 'before' : 'after'}.json`)
  writeFileSync(output, JSON.stringify(results, null, 2))
  console.log('Evidence:', output)
  await app?.close()
  server.stop(true)
  rmSync(fixture, { recursive: true, force: true })
}
