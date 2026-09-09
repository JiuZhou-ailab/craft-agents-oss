// input: Built Electron app and an offline turn containing both supported diff formats
// output: Visible highlighted content and headers after both viewers signal readiness
// pos: Desktop regression for the shared diff renderer
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchApp, evalOn, waitFor, type LaunchedApp } from '../perf/launch'

const fixture = mkdtempSync(join(tmpdir(), 'storyflow-diff-viewers-'))
let app: LaunchedApp | undefined
try {
  execFileSync(process.execPath, ['run', 'scripts/perf/generate-fixture.ts', '--out', fixture, '--scale', '0.01'], { cwd: resolve(import.meta.dirname, '../..'), stdio: 'pipe' })
  const workspace = JSON.parse(readFileSync(join(fixture, 'config.json'), 'utf8')).workspaces[0]
  const sessionsRoot = join(workspace.rootPath, '.craft-agent', 'sessions')
  const sessionId = readdirSync(sessionsRoot)[0]!
  const sessionPath = join(sessionsRoot, sessionId, 'session.jsonl')
  const header = JSON.parse(readFileSync(sessionPath, 'utf8').split('\n')[0]!)
  const messages = [
    { id: 'user-diff', type: 'user', content: '查看修改', timestamp: 1 },
    ...[
      { file_path: join(workspace.rootPath, 'contents.ts'), old_string: 'const before = 1\n', new_string: 'const after = 2\n' },
      { changes: [{ path: join(workspace.rootPath, 'patch.ts'), kind: 'update', diff: '@@ -1 +1 @@\n-const oldPatch = 1\n+const newPatch = 2\n' }] },
    ].map((toolInput, index) => ({ id: `edit-${index}`, type: 'tool', toolName: 'Edit', toolUseId: `edit-${index}`, toolInput, toolStatus: 'completed', content: 'Edited', turnId: 'turn-diff', timestamp: index + 2 })),
    { id: 'assistant-diff', type: 'assistant', content: '修改完成', turnId: 'turn-diff', timestamp: 4 },
  ]
  writeFileSync(sessionPath, [JSON.stringify({ ...header, name: 'Diff viewer QA', messageCount: messages.length, lastFinalMessageId: 'assistant-diff', lastMessageRole: 'assistant' }), ...messages.map(m => JSON.stringify(m))].join('\n') + '\n')
  app = await launchApp(fixture)
  const live = app
  await waitFor(live, `document.querySelector('[data-tutorial="activity-profile"]')`)
  await evalOn(live, `Array.from(document.querySelectorAll('[role="dialog"] button')).find(b=>/继续使用|Continue/.test(b.textContent))?.click()`)
  await evalOn(live, `(() => {const url=new URL(location.href); url.search=new URLSearchParams({workspaceId:${JSON.stringify(workspace.id)},ws:${JSON.stringify(workspace.id)},route:'allSessions/session/${sessionId}'}).toString(); location.href=url.href})()`)
  await waitFor(live, `document.body.textContent.includes('修改完成') && !document.querySelector('.z-splash')`)
  await evalOn(live, `Array.from(document.querySelectorAll('[role="button"]')).find(e=>e.querySelector('svg.lucide-ellipsis'))?.click()`)
  await waitFor(live, `Array.from(document.querySelectorAll('[data-simple-dropdown-item]')).some(e=>/查看文件变更|View file changes/.test(e.textContent))`)
  await evalOn(live, `Array.from(document.querySelectorAll('[data-simple-dropdown-item]')).find(e=>/查看文件变更|View file changes/.test(e.textContent)).click()`)
  const viewers = `Array.from(document.querySelectorAll('diffs-container'))`
  await waitFor(live, `${viewers}.length === 2 && ${viewers}.every(e=>e.shadowRoot?.querySelector('[data-diffs-header]'))`, 15000)
  const rendered = await evalOn<string[]>(live, `${viewers}.map(e=>e.shadowRoot.textContent)`)
  assert.ok(rendered.some(text => text.includes('after') && text.includes('before')))
  assert.ok(rendered.some(text => text.includes('newPatch') && text.includes('oldPatch')))
  await waitFor(live, `${viewers}.every(e=>{for(let p=e;p;p=p.parentElement){if(Number(getComputedStyle(p).opacity)===0)return false}return true})`, 5000, 'Both ready callbacks reveal the diff overlay')
  console.log('PASS: content and patch viewers render highlighted changes and visible file headers')
} finally {
  await app?.close()
  rmSync(fixture, { recursive: true, force: true })
}
