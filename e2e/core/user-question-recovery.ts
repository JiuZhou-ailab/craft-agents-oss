// input: Built Electron app and a deterministic local model that asks one question
// output: Visible prompt recovery after page/project reload and a completed answer round trip
// pos: Offline desktop regression check for ask_user_question; no external model calls
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchApp, evalOn, callOn, waitFor, type LaunchedApp } from '../perf/launch'

const root = resolve(import.meta.dirname, '../..')
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'storyflow-question-')))
const connection = 'offline-question'
let app: LaunchedApp | undefined
let answered = false
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (!new URL(request.url).pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 })
  const body = await request.json() as any
  const tool = body.tools?.find((tool: any) => tool.function?.name.endsWith('ask_user_question'))
  const result = body.messages?.find((message: any) => message.role === 'tool')
  if (tool && result) answered = JSON.stringify(result).includes('恢复成功')
  const delta = tool && !result ? { tool_calls: [{
    index: 0, id: 'call_question', type: 'function', function: {
      name: tool.function.name,
      arguments: JSON.stringify({ questions: [{
        header: '恢复检查', question: '刷新后还能回答吗？', multiSelect: false,
        options: [{ label: '恢复成功', description: '继续执行' }, { label: '尚未恢复', description: '保持等待' }],
      }] }),
    },
  }] } : { content: tool ? 'Question answered.' : 'Question recovery' }
  const sse = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({
    id: 'offline-question', model: connection, choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`
  return new Response(sse(delta, null) + sse({}, tool && !result ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  })
} })

try {
  execFileSync(process.execPath, ['run', 'scripts/perf/generate-fixture.ts', '--out', fixture, '--scale', '0.01'], { cwd: root, stdio: 'pipe' })
  const configPath = join(fixture, 'config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const workspace = config.workspaces[0]
  config.llmConnections = [{ slug: connection, name: 'Offline question', providerType: 'pi_compat',
    baseUrl: `http://127.0.0.1:${server.port}/v1`, authType: 'none', models: [connection], defaultModel: connection,
    customEndpoint: { api: 'openai-completions' }, createdAt: Date.now() }]
  config.defaultLlmConnection = connection
  writeFileSync(configPath, JSON.stringify(config))
  app = await launchApp(fixture)
  const live = app
  await waitFor(live, `document.querySelector('[data-tutorial="activity-profile"]')`)
  await evalOn(live, `Array.from(document.querySelectorAll('[role="dialog"] button')).find(b=>/继续使用|Continue/.test(b.textContent))?.click()`)
  const session = await callOn<{ id: string }>(live, `async function(workspaceId, rootPath, connection) {
    await window.electronAPI.switchWorkspace(workspaceId);
    return window.electronAPI.createSession(workspaceId, { name:'Question recovery', permissionMode:'ask', workingDirectory:rootPath, llmConnection:connection, model:connection });
  }`, [workspace.id, workspace.rootPath, connection])
  const navigate = async (workspaceId: string, route: string) => callOn(live, `async function(id, route) {
    await window.electronAPI.switchWorkspace(id);
    const url=new URL(location.href); url.search=new URLSearchParams({workspaceId:id,ws:id,route}).toString(); location.href=url.href;
  }`, [workspaceId, route])
  const route = `allSessions/session/${session.id}`
  await navigate(workspace.id, route)
  await waitFor(live, `document.querySelector('[contenteditable="true"]')`)
  await callOn(live, `async function(id) { await window.electronAPI.sendMessage(id, 'Ask the recovery question') }`, [session.id])
  const visiblePrompt = `Array.from(document.querySelectorAll('fieldset')).some(e=>e.textContent.includes('刷新后还能回答吗？') && e.getBoundingClientRect().height>0 && getComputedStyle(e).visibility==='visible')`
  await waitFor(live, visiblePrompt, 30000, 'Live question is visible')
  await evalOn(live, 'location.reload()')
  await waitFor(live, visiblePrompt, 30000, 'Question survives renderer reload')
  await navigate('__storyflow_free__', 'allSessions')
  await waitFor(live, `document.querySelector('[contenteditable="true"]')`)
  await navigate(workspace.id, route)
  await waitFor(live, visiblePrompt, 30000, 'Question survives leaving and reopening the project')
  await evalOn(live, `window.electronAPI.reconnectTransport()`)
  await waitFor(live, visiblePrompt, 30000, 'Question survives transport reconnect')
  await waitFor(live, `!document.querySelector('.z-splash')`, 10000, 'Startup overlay has left the input interactive')
  if (process.env.CRAFT_E2E_SCREENSHOTS) {
    const shot = await live.cdp.send('Page.captureScreenshot', { format: 'png' }, live.sid)
    writeFileSync(join(process.env.CRAFT_E2E_SCREENSHOTS, 'user-question-recovered.png'), Buffer.from(shot.data, 'base64'))
  }
  const clickVisible = async (expression: string) => {
    const point = await evalOn<{ x: number; y: number }>(live, `(() => {
      const e=${expression}; const r=e.getBoundingClientRect();
      const x=r.left+r.width/2, y=r.top+r.height/2;
      if (!e.contains(document.elementFromPoint(x,y))) throw new Error('Question control is covered');
      return {x,y};
    })()`)
    await live.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, live.sid)
    await live.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, live.sid)
  }
  await clickVisible(`Array.from(document.querySelectorAll('input[type="radio"]')).find(e=>getComputedStyle(e).visibility==='visible')`)
  await waitFor(live, `Array.from(document.querySelectorAll('button')).some(e=>/^(提交|Submit)$/.test(e.textContent.trim()) && !e.disabled && getComputedStyle(e).visibility==='visible')`)
  await clickVisible(`Array.from(document.querySelectorAll('button')).find(e=>/^(提交|Submit)$/.test(e.textContent.trim()) && getComputedStyle(e).visibility==='visible')`)
  await waitFor(live, `!(${visiblePrompt})`, 10000, 'Answered question disappears')
  await waitFor(live, `document.body.textContent.includes('Question answered.')`, 30000, 'Pi resumes with the answer')
  assert.ok(answered, 'Local model receives the actual selected answer')
  const pending = await callOn(live, `async function(id) { return (await window.electronAPI.getSessionMessages(id)).pendingUserQuestions }`, [session.id])
  assert.deepEqual(pending, [])
  console.log('PASS: live question, reload, project return, reconnect, visible submission and Pi resume')
} catch (error) {
  console.error(app?.processLines.slice(-15).join('\n'))
  throw error
} finally {
  await app?.close()
  server.stop(true)
  rmSync(fixture, { recursive: true, force: true })
}
