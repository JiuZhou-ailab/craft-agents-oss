// input: Isolated Electron fixture and a local OpenAI-compatible model stub
// output: Enter submits a task, opens its bound conversation, receives a reply, and saves configuration
// pos: Regression guard for the complete scheduled-task creation path without external model calls

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchApp, evalOn, type LaunchedApp } from '../perf/launch'

const fixture = mkdtempSync(join(tmpdir(), 'storyflow-scheduled-submit-'))
const configPath = join(fixture, 'runtime/free/automations.json')
const modelId = 'schedule-e2e'
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
let live: LaunchedApp | undefined
let modelRequests = 0
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 })
    const body = await request.json() as any
    const canWrite = body.tools?.some((tool: any) => tool.function?.name === 'write')
    const hasResult = body.messages?.some((message: any) => message.role === 'tool')
    const sse = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: 'schedule-e2e', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
    let chunks: string
    if (canWrite && !hasResult) {
      modelRequests++
      const prompt = JSON.stringify(body.messages)
      const text = body.messages.map((message: any) => typeof message.content === 'string' ? message.content : (message.content ?? []).map((part: any) => part.text ?? '').join('\n')).join('\n')
      const sessionId = [...text.matchAll(/<session_state>\s*sessionId: ([A-Za-z0-9_-]+)/g)].at(-1)?.[1]
      assert.ok(sessionId, 'Creation prompt must identify the bound conversation')
      assert.ok(prompt.includes('QA_SCHEDULE_REQUEST'), 'Model must receive the user instruction')
      const oldText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined
      const config = oldText ? JSON.parse(oldText) : { version: 2, automations: { SchedulerTick: [] } }
      config.automations.SchedulerTick.push({ id: sessionId, name: 'QA scheduled task', sessionId, enabled: false, cron: '0 9 * * *', timezone: 'Asia/Shanghai', actions: [{ type: 'prompt', prompt: 'Review the outline' }] })
      const operation = oldText
        ? { name: 'edit', arguments: JSON.stringify({ path: configPath, edits: [{ oldText, newText: JSON.stringify(config) }] }) }
        : { name: 'write', arguments: JSON.stringify({ path: configPath, content: JSON.stringify(config) }) }
      chunks = sse({ role: 'assistant' }) + sse({ tool_calls: [{ index: 0, id: 'create_task', type: 'function', function: operation }] }) + sse({}, 'tool_calls')
    } else {
      if (!canWrite) assert.ok(!JSON.stringify(body.messages).includes('<edit_request>'), 'Title generation must receive user intent without configuration instructions')
      chunks = sse({ role: 'assistant', content: canWrite ? 'QA_SCHEDULE_CREATED' : 'Review outline daily' }) + sse({}, 'stop')
    }
    return new Response(chunks + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  },
})

async function submitFrom(workspaceId: string, message: string) {
  const app = live!
  await evalOn(app, `window.electronAPI.switchWorkspace(${JSON.stringify(workspaceId)})`)
  await evalOn(app, `(() => { const url = new URL(location.href); url.search = new URLSearchParams({workspaceId:${JSON.stringify(workspaceId)},ws:${JSON.stringify(workspaceId)},route:'automations/scheduled'}).toString(); location.href = url.href })()`)
  for (let i = 0; i < 100; i++) {
    await pause(100)
    if (await evalOn(app, `!!document.querySelector('[data-testid="create-scheduled-task"]')`)) break
  }
  assert.equal(await evalOn(app, `parseFloat(getComputedStyle(document.querySelector('h1')).fontSize) / parseFloat(getComputedStyle(document.documentElement).fontSize)`), 1.5)
  await pause(400)
  await evalOn(app, `document.querySelector('[data-testid="create-scheduled-task"]').click()`)
  for (let i = 0; i < 40; i++) {
    await pause(100)
    if (await evalOn(app, `!!document.querySelector('[role="dialog"] [contenteditable="true"]')`)) break
  }
  await evalOn(app, `document.querySelector('[role="dialog"] [contenteditable="true"]').focus()`)
  await app.cdp.send('Input.insertText', { text: message }, app.sid)
  await pause(250)
  await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, app.sid)
  await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, app.sid)
  let state: any
  for (let i = 0; i < 300; i++) {
    await pause(100)
    state = await evalOn(app, `(async () => {
      const url = new URL(location.href); const id = url.searchParams.get('route')?.match(/^allSessions\\/session\\/(.+)$/)?.[1];
      const session = id ? await window.electronAPI.getSessionMessages(id) : null;
      return { url:location.href, id, workspaceId:await window.electronAPI.getWindowWorkspace(), session, text:document.body.innerText.slice(-700) };
    })()`)
    if (state.session?.messages.some((m: any) => m.role === 'assistant' && m.content.includes('QA_SCHEDULE_CREATED'))) break
  }
  assert.equal(state?.workspaceId, '__storyflow_free__')
  assert.ok(state?.session?.messages.some((m: any) => m.role === 'assistant' && m.content.includes('QA_SCHEDULE_CREATED')), JSON.stringify({ state, logs: app.processLines.slice(-12) }))
  assert.ok(state.session.messages.some((m: any) => m.role === 'user' && m.content.includes(message.trim())))
  assert.ok(state.session.isPinned)
  const saved = JSON.parse(readFileSync(configPath, 'utf8'))
  assert.ok(state.session.messages.some((m: any) => m.role === 'tool' && m.isError === false))
  assert.ok(!state.session.messages.some((m: any) => m.role === 'tool' && m.isError), JSON.stringify(state.session.messages.filter((m: any) => m.role === 'tool')))
  assert.equal(saved.automations.SchedulerTick.length, modelRequests, 'Existing tasks must be preserved')
  assert.equal(saved.automations.SchedulerTick.at(-1).sessionId, state.id)
  const targets = await app.cdp.send('Target.getTargets', {}) as any
  assert.equal(targets.targetInfos.filter((t: any) => t.type === 'page').length, 1, 'Internal submission must stay in this window')
  for (let i = 0; i < 100; i++) {
    if (await evalOn(app, `window.electronAPI.getSessionMessages(${JSON.stringify(state.id)}).then(s => s.name === 'Review outline daily')`)) break
    await pause(100)
  }
  assert.equal(await evalOn(app, `window.electronAPI.getSessionMessages(${JSON.stringify(state.id)}).then(s => s.name)`), 'Review outline daily')
  await evalOn(app, `document.querySelector('[data-tutorial="activity-automations"]').click()`)
  for (let i = 0; i < 100; i++) {
    if (await evalOn(app, `!!document.querySelector('[data-automation-id="${state.id}"]')`)) break
    await pause(100)
  }
  assert.ok(await evalOn(app, `document.body.innerText.includes('QA scheduled task')`), 'Saved schedules must appear when returning to the scheduled-task page')

  assert.equal(await evalOn(app, `document.querySelectorAll('[data-automation-id]').length`), modelRequests)
  const listWidth = await evalOn(app, `document.querySelector('[data-testid="scheduled-task-list-column"]').getBoundingClientRect().width`)
  await evalOn(app, `document.querySelector('[data-automation-id="${state.id}"]').click()`)
  for (let i = 0; i < 50; i++) {
    if (await evalOn(app, `!!document.querySelector('[data-testid="scheduled-task-detail"]')`)) break
    await pause(100)
  }
  await pause(300)
  const layout = await evalOn(app, `(() => {
    const list = document.querySelector('[data-testid="scheduled-task-list-column"]');
    const detail = document.querySelector('[data-testid="scheduled-task-detail"]');
    const a = list.getBoundingClientRect(), b = detail.getBoundingClientRect();
    return { listWidth:a.width, centerX:b.x + b.width / 2, centerY:b.y + b.height / 2,
      viewportWidth:innerWidth, viewportHeight:innerHeight, height:b.height,
      modal:detail.getAttribute('aria-modal'), position:getComputedStyle(detail).position };
  })()`)
  assert.equal(layout.listWidth, listWidth, 'Opening details must preserve the list width')
  assert.equal(layout.position, 'fixed')
  assert.equal(layout.modal, 'true')
  assert.ok(Math.abs(layout.centerX - layout.viewportWidth / 2) < 1)
  assert.ok(Math.abs(layout.centerY - layout.viewportHeight / 2) < 1)
  assert.ok(layout.height <= layout.viewportHeight * 0.85 + 1)
  assert.equal(await evalOn(app, `document.querySelectorAll('[data-testid="scheduled-task-detail"] h2').length > 0`), true)
  assert.equal(await evalOn(app, `document.querySelectorAll('[data-testid="automation-detail-header"] h2').length`), 1)
  assert.ok(await evalOn(app, `!!document.querySelector('[data-testid="automation-detail-header"] button[aria-label="关闭"], [data-testid="automation-detail-header"] button[aria-label="Close"]')`))
  await evalOn(app, `document.querySelector('[data-testid="scheduled-task-detail"] button').focus()`)
  await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, app.sid)
  await pause(600)
  assert.equal(await evalOn(app, `!!document.querySelector('[data-testid="scheduled-task-detail"]')`), false)
  if (modelRequests > 1) {
    const firstId = saved.automations.SchedulerTick[0].id
    await evalOn(app, `document.querySelector('[data-automation-id="${firstId}"]').click()`)
    for (let i = 0; i < 40; i++) {
      if (await evalOn(app, `document.querySelector('[data-automation-id="${firstId}"]')?.getAttribute('aria-current') === 'true'`)) break
      await pause(100)
    }
    assert.equal(await evalOn(app, `document.querySelector('[data-automation-id="${firstId}"]')?.getAttribute('aria-current')`), 'true')
    await evalOn(app, `document.querySelector('[data-testid="automation-detail-header"] button[aria-label="关闭"], [data-testid="automation-detail-header"] button[aria-label="Close"]').click()`)
    await pause(600)
    assert.equal(await evalOn(app, `!!document.querySelector('[data-testid="scheduled-task-detail"]')`), false)
  }
  assert.equal(await evalOn(app, `document.querySelector('[data-session-id="${state.id}"]')?.closest('section')?.getAttribute('aria-label')`), '固定')

  // The shared row is used for both project and free conversations. Keyboard
  // focus reveals the same quick actions as hover, without selecting the chat.
  const row = `[data-session-id="${state.id}"]`
  await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 500, y: 60 }, app.sid)
  await evalOn(app, `document.activeElement?.blur()`)
  const idleRow = await evalOn(app, `(() => {
    const rect = document.querySelector(${JSON.stringify(row)}).getBoundingClientRect();
    return {height:rect.height, x:rect.x + 20, y:rect.y + rect.height / 2, scrollHeight:document.querySelector('[data-testid="activity-sidebar-scroll"]').scrollHeight};
  })()`)
  await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: idleRow.x, y: idleRow.y }, app.sid)
  const hoveredRow = await evalOn(app, `({ height:document.querySelector(${JSON.stringify(row)}).getBoundingClientRect().height, scrollHeight:document.querySelector('[data-testid="activity-sidebar-scroll"]').scrollHeight })`)
  assert.equal(hoveredRow.height, idleRow.height, 'Hover must not change conversation row height')
  assert.equal(hoveredRow.scrollHeight, idleRow.scrollHeight, 'Hover must not shift the sidebar scroll layout')
  await evalOn(app, `document.querySelector(${JSON.stringify(row + ' > button')}).focus()`)
  assert.equal(await evalOn(app, `getComputedStyle(document.querySelector(${JSON.stringify(row + ' [data-session-action="pin"]')}).parentElement).display`), 'flex')
  for (const pinned of [false, true]) {
    await evalOn(app, `document.querySelector(${JSON.stringify(row + ' [data-session-action="pin"]')}).click()`)
    for (let i = 0; i < 80; i++) {
      if (await evalOn(app, `document.querySelector(${JSON.stringify(row)})?.dataset.sessionFixed === '${pinned}'`)) break
      await pause(100)
    }
    assert.equal(await evalOn(app, `document.querySelector(${JSON.stringify(row)})?.dataset.sessionFixed`), String(pinned))
    assert.equal(await evalOn(app, `window.electronAPI.getSessionMessages(${JSON.stringify(state.id)}).then(s => s.isPinned)`), pinned)
  }
  await evalOn(app, `document.querySelector(${JSON.stringify(row + ' [data-session-action="archive"]')}).click()`)
  for (let i = 0; i < 80; i++) {
    if (await evalOn(app, `!document.querySelector(${JSON.stringify(row)})`)) break
    await pause(100)
  }
  assert.equal(await evalOn(app, `!!document.querySelector(${JSON.stringify(row)})`), false)
  assert.equal(await evalOn(app, `window.electronAPI.getSessionMessages(${JSON.stringify(state.id)}).then(s => s.isArchived)`), true)
  assert.match(await evalOn(app, 'location.href'), /automations/)
  console.log('PASS: saved schedule is visible; quick pin/unpin/archive persist without selecting the conversation')
}

try {
  execFileSync(process.execPath, ['run', 'scripts/perf/generate-fixture.ts', '--out', fixture, '--scale', '0.01'], { cwd: resolve(import.meta.dirname, '../..'), stdio: 'pipe' })
  const path = join(fixture, 'config.json')
  const config = JSON.parse(readFileSync(path, 'utf8'))
  const project = config.workspaces[0]
  config.llmConnections = [{ slug: 'schedule-e2e', name: 'Schedule E2E', providerType: 'pi_compat', baseUrl: `http://127.0.0.1:${server.port}/v1`, authType: 'none', models: [modelId], defaultModel: modelId, customEndpoint: { api: 'openai-completions' }, createdAt: Date.now() }]
  config.defaultLlmConnection = 'schedule-e2e'
  writeFileSync(path, JSON.stringify(config))
  live = await launchApp(fixture)
  await pause(6000)
  await evalOn(live, `Array.from(document.querySelectorAll('[role="dialog"] button')).find(b => /继续使用|Continue/.test(b.textContent))?.click()`)
  await submitFrom(project.id, 'QA_SCHEDULE_REQUEST: Create a disabled daily task at 9am to review my outline.')
  console.log('PASS: Enter from a project opens the bound free conversation, receives a reply, and saves the task')
  await submitFrom('__storyflow_free__', 'QA_SCHEDULE_REQUEST: Create a disabled daily task at 9am. Notes: ' + 'outline '.repeat(600))
  assert.equal(modelRequests, 2)
  console.log('PASS: Enter from free conversations submits long input intact without duplicate creation')
} finally {
  await live?.close()
  server.stop(true)
  rmSync(fixture, { recursive: true, force: true })
}
