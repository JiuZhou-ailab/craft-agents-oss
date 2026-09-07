// input: Built Electron app, a v0.17-style local Project, and a deterministic OpenAI-compatible HTTP stub
// output: Assertions for upgrades, login routing, safe Session cleanup, a real Pi edit turn, version restore, and restart recovery
// pos: Release-gate smoke test for the desktop product's durable core loop

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { strict as assert } from 'node:assert'
import { FREE_CONVERSATION_WORKSPACE_ID } from '@craft-agent/shared/protocol'
import {
  callOn,
  evalOn,
  launchApp,
  sleep,
  waitFor,
  type LaunchedApp,
  type LaunchAppOptions,
} from '../perf/launch.ts'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const WORKSPACE_SLUG = 'core-e2e'
const CONNECTION_SLUG = 'core-e2e-local'
const MODEL_ID = 'core-e2e-model'
const ORIGINAL = '# Core E2E\n\nbefore\n'
const AGENT_EDIT = '# Core E2E\n\nafter agent edit\n'
const USER_DRIFT = '# Core E2E\n\nuncommitted user drift\n'
const launchOptions: LaunchAppOptions = process.env.CRAFT_E2E_ELECTRON_BIN
  ? { executablePath: process.env.CRAFT_E2E_ELECTRON_BIN, packaged: true }
  : {}

interface Fixture {
  configDir: string
  workspaceRoot: string
  targetFile: string
}

async function main(): Promise<void> {
  const fixture = createFixture()
  const model = startModelStub(fixture.targetFile)
  let app: LaunchedApp | undefined

  try {
    configureAccountSmokeEnvironment()
    configureModel(fixture, model.url)
    seedIncompatibleV017ServerLock(fixture.configDir)
    app = await launchApp(fixture.configDir, { ...launchOptions, preserveServerLockState: true })
    assert.equal(lstatSync(join(fixture.configDir, '.server.lock')).isFile(), true)
    assert.equal(lstatSync(join(fixture.configDir, '.server.lease')).isDirectory(), true)

    const auth = await callOn<{ required: boolean; configured: boolean; authenticated: boolean }>(
      app,
      'async function () { return await window.electronAPI.getClientAuthState() }',
    )
    assert.equal(auth.required, false, 'local projects must open without client login')
    assert.equal(auth.configured, true, 'account smoke must exercise the configured sign-in form')
    assert.equal(auth.authenticated, false, 'account smoke fixture must start signed out')
    await smokeAccountCenter(app)
    await smokeManagedLoginRedirect(app)
    await assertRootViewportCannotScroll(app)
    await smokeFreeConversationSkillImport(app)

    const workspace = await callOn<{ id: string; rootPath: string; directoryConfigId?: string } | undefined>(
      app,
      `async function (id) {
        return (await window.electronAPI.getWorkspaces()).find(workspace => workspace.id === id)
      }`,
      [WORKSPACE_ID],
    )
    assert.equal(workspace?.rootPath, realpathSync(fixture.workspaceRoot))
    assert.equal(workspace?.directoryConfigId, WORKSPACE_ID, 'v0.17 Project identity was not upgraded')
    assert.equal(readFileSync(fixture.targetFile, 'utf8'), ORIGINAL, 'workspace changed during app startup')

    const userHeadBefore = git(fixture.workspaceRoot, 'rev-parse', 'HEAD')
    const userIndexBefore = git(fixture.workspaceRoot, 'diff', '--cached', '--binary')

    const session = await callOn<{ id: string }>(
      app,
      `async function (workspaceId, rootPath, connection, model) {
        return await window.electronAPI.createSession(workspaceId, {
          name: 'Core E2E',
          permissionMode: 'ask',
          workingDirectory: rootPath,
          llmConnection: connection,
          model,
        })
      }`,
      [WORKSPACE_ID, fixture.workspaceRoot, CONNECTION_SLUG, MODEL_ID],
    )
    assert.equal(readFileSync(fixture.targetFile, 'utf8'), ORIGINAL, 'workspace changed during session creation')

    await callOn<void>(app, `function (sessionId) {
      window.__corePermissionRequests = []
      window.electronAPI.onSessionEvent(event => {
        if (event.type === 'permission_request' && event.sessionId === sessionId) {
          window.__corePermissionRequests.push(event.request.requestId)
        }
      })
    }`, [session.id])

    await callOn<void>(
      app,
      `async function (sessionId) {
        await window.electronAPI.sendMessage(
          sessionId,
          'Edit README.md so its final line is exactly: after agent edit'
        )
      }`,
      [session.id],
    )
    await callOn<void>(app, `function (id) {
      window.dispatchEvent(new CustomEvent('craft-agent-navigate', { detail: { route: 'allSessions/session/' + id } }))
    }`, [session.id])
    await waitFor(app, `!!document.querySelector('[data-tutorial="permission-banner"]')`, 30_000, 'Pi edit permission prompt')
    // Structured input also renders an inert height-measurement copy.
    await clickSelector(app, '.input-container [data-tutorial="permission-allow-all-button"]')
    await waitFor(app, `document.querySelector('[data-tutorial="permission-mode-dropdown"]')?.classList.contains('text-accent')`,
      10_000, 'Allow All updates the visible execution mode')
    await waitForAgent(app, session.id, fixture.targetFile)
    assert.equal(readFileSync(fixture.targetFile, 'utf8'), AGENT_EDIT)
    assert.equal(readFileSync(join(fixture.workspaceRoot, 'allow-all-proof.txt'), 'utf8'), 'Second tool executed\n')
    assert.equal(await evalOn<number>(app, 'window.__corePermissionRequests.length'), 1, 'the next Pi tool must execute without another prompt')

    const cleanup = await callOn<{ deleted: boolean }>(app,
      `async function (id) { return await window.electronAPI.sessionCommand(id, { type: 'deleteIfEmpty' }) }`,
      [session.id],
    )
    assert.equal(cleanup.deleted, false, 'automatic cleanup must retain a Session with a user message')

    const version = await callOn<{ created: boolean; commitHash?: string }>(
      app,
      `async function (rootPath) {
        return await window.electronAPI.createWorkspaceVersion(rootPath, {
          reason: 'agent-turn',
          label: 'Core E2E agent edit',
        })
      }`,
      [fixture.workspaceRoot],
    )
    assert.ok(version.commitHash)
    const versionedContent = await callOn<string | null>(
      app,
      `async function (rootPath, commitHash) {
        return await window.electronAPI.readWorkspaceFileAtVersion(rootPath, commitHash, 'README.md')
      }`,
      [fixture.workspaceRoot, version.commitHash],
    )
    assert.equal(versionedContent, AGENT_EDIT)
    assert.equal(git(fixture.workspaceRoot, 'rev-parse', 'HEAD'), userHeadBefore)
    assert.equal(git(fixture.workspaceRoot, 'diff', '--cached', '--binary'), userIndexBefore)
    assert.match(git(fixture.workspaceRoot, 'status', '--short'), /M README\.md/)

    writeFileSync(fixture.targetFile, USER_DRIFT)
    const restored = await callOn<{ restored: boolean; commitHash: string }>(
      app,
      `async function (rootPath, commitHash) {
        return await window.electronAPI.restoreWorkspaceVersion(rootPath, commitHash)
      }`,
      [fixture.workspaceRoot, version.commitHash],
    )
    assert.equal(restored.restored, true)
    assert.equal(readFileSync(fixture.targetFile, 'utf8'), AGENT_EDIT)
    assert.equal(git(fixture.workspaceRoot, 'rev-parse', 'HEAD'), userHeadBefore)
    assert.equal(git(fixture.workspaceRoot, 'diff', '--cached', '--binary'), userIndexBefore)

    await sleep(250)
    await app.close()
    assert.equal(existsSync(join(fixture.configDir, '.server.lock')), false)
    assert.equal(existsSync(join(fixture.configDir, '.server.lease')), false)
    app = await launchApp(fixture.configDir, { ...launchOptions, preserveServerLockState: true })

    const recovered = await callOn<Array<{ id: string }>>(
      app,
      'async function (workspaceId) { return await window.electronAPI.listSessionsByWorkspace(workspaceId) }',
      [WORKSPACE_ID],
    )
    assert.ok(recovered.some(candidate => candidate.id === session.id))
    const recoveredMode = await callOn<{ permissionMode: string }>(app,
      'async function (id) { return await window.electronAPI.getSessionPermissionModeState(id) }', [session.id])
    assert.equal(recoveredMode.permissionMode, 'ask', 'Project restart must renew execute consent; Session files cannot grant capabilities')
    assert.equal(readFileSync(fixture.targetFile, 'utf8'), AGENT_EDIT)

    process.stdout.write('core Electron E2E: PASS\n')
  } finally {
    await app?.close().catch(() => {})
    model.stop()
    try {
      rmSync(fixture.configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch (error) {
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EBUSY') throw error
      process.stderr.write(`core Electron E2E: cleanup deferred for locked temp directory ${fixture.configDir}\n`)
    }
  }
}

function seedIncompatibleV017ServerLock(configDir: string): void {
  const lockPath = join(configDir, '.server.lock')
  mkdirSync(lockPath)
  writeJson(join(lockPath, 'owner.json'), {
    pid: 2_147_483_647,
    startedAt: Date.now() - 120_000,
  })
  const staleAt = new Date(Date.now() - 120_000)
  utimesSync(lockPath, staleAt, staleAt)
}

async function smokeFreeConversationSkillImport(app: LaunchedApp): Promise<void> {
  const slug = 'core-e2e-market-skill'
  const result = await callOn<{ skills: { imported: string[] } }>(
    app,
    `async function (workspaceId, slug) {
      const markdown = '---\\nname: ' + slug + '\\ndescription: Core E2E Market Skill\\n---\\n\\nbody\\n'
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: { skills: [{
          slug,
          files: [{
            relativePath: 'SKILL.md',
            contentBase64: btoa(markdown),
            size: new TextEncoder().encode(markdown).byteLength,
          }],
        }] },
      }
      return await window.electronAPI.importResources(
        workspaceId,
        bundle,
        'skip',
        { skillScope: 'project' },
      )
    }`,
    [FREE_CONVERSATION_WORKSPACE_ID, slug],
  )
  assert.deepEqual(result.skills.imported, [slug])

  const installed = await callOn<Array<{ slug: string }>>(
    app,
    'async function (workspaceId) { return await window.electronAPI.getSkills(workspaceId) }',
    [FREE_CONVERSATION_WORKSPACE_ID],
  )
  assert.ok(installed.some(skill => skill.slug === slug), 'Free Conversations Skill import was not discoverable')

  await callOn<void>(
    app,
    'async function (workspaceId, slug) { await window.electronAPI.deleteSkill(workspaceId, slug) }',
    [FREE_CONVERSATION_WORKSPACE_ID, slug],
  )
}

async function assertRootViewportCannotScroll(app: LaunchedApp): Promise<void> {
  const result = await evalOn<{
    overflow: string
    scrollHeight: number
    clientHeight: number
    scrollTop: number
    railTopBefore: number | null
    railTopAfter: number | null
  }>(app, `(() => {
    const root = document.getElementById('root')
    if (!root) throw new Error('root not mounted')

    const rail = document.querySelector('[data-testid="activity-rail"]')
    const railTopBefore = rail?.getBoundingClientRect().top ?? null
    const sentinel = document.createElement('div')
    sentinel.style.height = window.innerHeight + 'px'
    sentinel.style.flex = '0 0 auto'
    root.appendChild(sentinel)

    try {
      root.scrollTop = 0
      sentinel.scrollIntoView({ behavior: 'instant', block: 'end' })
      return {
        overflow: getComputedStyle(root).overflow,
        scrollHeight: root.scrollHeight,
        clientHeight: root.clientHeight,
        scrollTop: root.scrollTop,
        railTopBefore,
        railTopAfter: rail?.getBoundingClientRect().top ?? null,
      }
    } finally {
      sentinel.remove()
      root.scrollTop = 0
    }
  })()`)

  assert.equal(result.overflow, 'clip', 'the app root must not be a scroll container')
  assert.ok(result.scrollHeight > result.clientHeight, 'root overflow probe did not create overflow')
  assert.equal(result.scrollTop, 0, 'descendant scrolling moved the app root')
  assert.equal(result.railTopAfter, result.railTopBefore, 'descendant scrolling moved the app shell')
}

function configureAccountSmokeEnvironment(): void {
  process.env.CRAFT_CLIENT_AUTH_BROKER_URL = 'https://broker.example.invalid'
  process.env.CRAFT_CLIENT_NEON_AUTH_BASE_URL = 'https://auth.example.invalid'
}

async function smokeAccountCenter(app: LaunchedApp): Promise<void> {
  const rendererErrors: string[] = []
  const onException = (params: any, sessionId?: string) => {
    if (sessionId === app.sid) {
      rendererErrors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'renderer exception')
    }
  }
  const onConsole = (params: any, sessionId?: string) => {
    if (sessionId !== app.sid || params.type !== 'error') return
    rendererErrors.push((params.args ?? [])
      .map((arg: any) => arg.value ?? arg.description ?? '')
      .filter(Boolean)
      .join(' '))
  }
  app.cdp.on('Runtime.exceptionThrown', onException)
  app.cdp.on('Runtime.consoleAPICalled', onConsole)

  try {
    const profileSelector = '[data-tutorial="activity-profile"]'
    await waitFor(
      app,
      `!!document.querySelector('${profileSelector}')`,
      15_000,
      'rendered account profile entry',
    )
    // This fixture validates account settings, not the Motion-driven startup transition.
    // Reveal the already-rendered shell so CDP can exercise the real pointer path.
    await callOn<void>(app, `function () {
      const style = document.createElement('style')
      style.textContent = '.z-splash { display: none !important; }'
      document.head.append(style)
    }`)
    if (await evalOn<boolean>(app, `!!document.querySelector('[role="dialog"] [data-slot="dialog-close"]')`)) {
      await callOn<void>(app, `function () {
        document.querySelector('[role="dialog"] [data-slot="dialog-close"]')?.click()
      }`)
      await waitFor(
        app,
        `!document.querySelector('[role="dialog"] [data-slot="dialog-close"]')`,
        5_000,
        'startup announcement dismissal',
      )
    }
    if (await evalOn<boolean>(app, `!!document.querySelector('[role="dialog"] #client-auth-identifier')`)) {
      await clickSelector(app, '[role="dialog"] button[aria-label]')
      await waitFor(app, `!document.querySelector('#client-auth-identifier')`, 5_000, 'preexisting settings dismissal')
    }
    await clickSelector(app, profileSelector)
    await waitFor(
      app,
      `!!document.querySelector('[data-tutorial="activity-settings"]')`,
      10_000,
      'settings menu item',
    )
    await clickSelector(app, '[data-tutorial="activity-profile-settings"]')
    await waitFor(
      app,
      `!!document.querySelector('#client-auth-identifier')
        || !!document.querySelector('[data-testid="root-crash-fallback"]')`,
      15_000,
      'account route result',
    )
    const account = await evalOn<{ crashed: boolean; signIn: boolean; text: string }>(
      app,
      `({
        crashed: !!document.querySelector('[data-testid="root-crash-fallback"]'),
        signIn: !!document.querySelector('#client-auth-identifier'),
        text: document.body.textContent?.trim().slice(0, 500) ?? '',
      })`,
    )
    assert.deepEqual(rendererErrors, [], `account settings emitted renderer errors: ${rendererErrors.join('\n')}`)
    assert.equal(account.crashed, false, `account settings entered the root error boundary: ${account.text}`)
    assert.equal(account.signIn, true, `configured account sign-in form did not render: ${account.text}`)
  } finally {
    app.cdp.off('Runtime.exceptionThrown', onException)
    app.cdp.off('Runtime.consoleAPICalled', onConsole)
  }
}

async function smokeManagedLoginRedirect(app: LaunchedApp): Promise<void> {
  await clickSelector(app, '[role="dialog"] button[aria-label]')
  await waitFor(app, `!document.querySelector('#client-auth-identifier')`, 5_000, 'profile dismissal')
  const previousRoute = await evalOn<string | null>(app, `new URL(location.href).searchParams.get('route')`)
  await clickSelector(app, '[data-testid="activity-projects"] button[title="新建任务"]')
  // Startup may already have restored a session. Wait for the newly created
  // session before configuring its connection, rather than accepting the old route.
  await waitFor(app, `(() => {
    const route = new URL(location.href).searchParams.get('route')
    return route !== ${JSON.stringify(previousRoute)} && route?.includes('/session/')
      && !!document.querySelector('[data-tutorial="chat-input"][contenteditable="true"]')
  })()`,
    15_000, 'project task creation activates its owning runtime')
  const sessionId = await evalOn<string>(app, `new URL(location.href).searchParams.get('route').split('/session/')[1]`)
  try {
    await callOn<void>(app, `async function (id) {
      await window.electronAPI.sessionCommand(id, { type: 'setConnection', connectionSlug: 'storyflow-managed' })
    }`, [sessionId])
    await clickSelector(app, '[data-tutorial="chat-input"][contenteditable="true"]')
    await app.cdp.send('Input.insertText', { text: 'Login preflight probe' }, app.sid)
    await clickSelector(app, '[data-tutorial="send-button"]')
    await waitFor(app, `!!document.querySelector('#client-auth-identifier')`, 10_000, 'send preflight opens profile sign-in')
    const transcript = await callOn<{ messages: unknown[] }>(app,
      `async function (id) { return await window.electronAPI.getSessionMessages(id) }`, [sessionId])
    assert.equal(transcript.messages.length, 0, 'login rejection must happen before sending')
  } catch (error) {
    const diagnostic = await evalOn(app, `({
      url: location.href,
      text: document.body.innerText.slice(0, 2500),
      inputs: [...document.querySelectorAll('[contenteditable]')].map(element => ({
        html: element.outerHTML.slice(0, 600),
        rect: element.getBoundingClientRect().toJSON(),
      })),
    })`)
    process.stderr.write(`login preflight diagnostic: ${JSON.stringify(diagnostic)}\n`)
    throw error
  } finally {
    await callOn<void>(app, `async function (id) { await window.electronAPI.deleteSession(id) }`, [sessionId])
  }
}

async function clickSelector(app: LaunchedApp, selector: string): Promise<void> {
  const selectorLiteral = JSON.stringify(selector)
  await waitFor(
    app,
    `(() => {
      const element = document.querySelector(${selectorLiteral})
      if (!element) return false
      const rect = element.getBoundingClientRect()
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      )
      return hit === element || element.contains(hit)
    })()`,
    15_000,
    `clickable target: ${selector}`,
  ).catch(async error => {
    const diagnostic = await evalOn(app, `(() => {
      const element = document.querySelector(${selectorLiteral})
      const rect = element?.getBoundingClientRect()
      return { text: document.body.innerText.slice(-3000), element: element?.outerHTML,
        rect, hit: rect && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.outerHTML.slice(0, 1000) }
    })()`)
    process.stderr.write(`click diagnostic: ${JSON.stringify(diagnostic)}\n`)
    throw error
  })
  const box = await callOn<{ x: number; y: number } | null>(
    app,
    `function (selector) {
      const element = document.querySelector(selector)
      if (!element) return null
      const rect = element.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) return null
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      }
    }`,
    [selector],
  )
  assert.ok(box, `click target is missing or hidden: ${selector}`)
  await app.cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' },
    app.sid,
  )
  await app.cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 },
    app.sid,
  )
  await app.cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 },
    app.sid,
  )
}

function createFixture(): Fixture {
  const configDir = mkdtempSync(join(tmpdir(), 'craft-core-e2e-'))
  const workspaceRoot = join(configDir, 'workspaces', WORKSPACE_SLUG)
  const stateDir = join(workspaceRoot, '.craft-agent')
  const targetFile = join(workspaceRoot, 'README.md')
  const now = Date.now()

  mkdirSync(join(stateDir, 'sessions'), { recursive: true })
  mkdirSync(join(stateDir, 'statuses'), { recursive: true })
  mkdirSync(join(stateDir, 'labels'), { recursive: true })
  writeJson(join(configDir, 'config.json'), {
    workspaces: [{
      id: WORKSPACE_ID,
      name: 'Core E2E',
      slug: WORKSPACE_SLUG,
      rootPath: workspaceRoot,
      createdAt: now,
    }],
    activeWorkspaceId: WORKSPACE_ID,
    activeSessionId: null,
    llmConnections: [],
  })
  writeJson(join(stateDir, 'config.json'), {
    id: WORKSPACE_ID,
    name: 'Core E2E',
    slug: WORKSPACE_SLUG,
    defaults: {
      defaultLlmConnection: CONNECTION_SLUG,
      model: MODEL_ID,
      permissionMode: 'allow-all',
      cyclablePermissionModes: ['ask', 'allow-all'],
      enabledSourceSlugs: [],
      workingDirectory: workspaceRoot,
    },
    localMcpServers: { enabled: false },
    createdAt: now,
    updatedAt: now,
  })
  writeJson(join(stateDir, 'statuses', 'config.json'), {
    version: 1,
    statuses: [
      { id: 'backlog', label: 'Backlog', category: 'open', isFixed: false, isDefault: true, order: 0 },
      { id: 'done', label: 'Done', category: 'closed', isFixed: true, isDefault: false, order: 1 },
    ],
  })
  writeJson(join(stateDir, 'labels', 'config.json'), { version: 1, labels: [] })
  writeFileSync(targetFile, ORIGINAL)

  git(workspaceRoot, 'init', '--initial-branch=main')
  git(workspaceRoot, 'config', 'core.autocrlf', 'false')
  git(workspaceRoot, 'config', 'user.name', 'Core E2E')
  git(workspaceRoot, 'config', 'user.email', 'core-e2e@example.invalid')
  git(workspaceRoot, 'add', 'README.md')
  git(workspaceRoot, 'commit', '-m', 'baseline')
  assert.equal(readFileSync(targetFile, 'utf8'), ORIGINAL, 'Git fixture setup changed README.md')

  return { configDir, workspaceRoot, targetFile }
}

function configureModel(fixture: Fixture, baseUrl: string): void {
  const configPath = join(fixture.configDir, 'config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  config.llmConnections = [{
    slug: CONNECTION_SLUG,
    name: 'Core E2E local model',
    providerType: 'pi_compat',
    baseUrl,
    authType: 'none',
    models: [MODEL_ID],
    defaultModel: MODEL_ID,
    customEndpoint: { api: 'openai-completions' },
    createdAt: Date.now(),
  }]
  config.defaultLlmConnection = CONNECTION_SLUG
  writeJson(configPath, config)
}

function startModelStub(targetFile: string): { url: string; stop(): void } {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/chat/completions')) {
        return new Response('not found', { status: 404 })
      }

      const body = await request.json() as {
        model?: string
        messages?: Array<{ role?: string }>
        tools?: Array<{ function?: { name?: string } }>
      }
      const hasEdit = body.tools?.some(tool => tool.function?.name === 'edit') ?? false
      const hasToolResult = body.messages?.some(message => message.role === 'tool') ?? false
      const chunks = hasEdit && !hasToolResult
        ? toolCallChunks(body.model ?? MODEL_ID, targetFile)
        : textChunks(
            body.model ?? MODEL_ID,
            hasEdit && readFileSync(targetFile, 'utf8') === AGENT_EDIT
              ? 'Edit complete.'
              : hasEdit ? 'Edit failed.' : 'Core E2E',
          )

      return new Response(chunks.join(''), {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
      })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    stop: () => server.stop(true),
  }
}

function toolCallChunks(model: string, targetFile: string): string[] {
  const id = 'chatcmpl-core-e2e'
  const args = JSON.stringify({
    path: targetFile,
    edits: [{ oldText: ORIGINAL, newText: AGENT_EDIT }],
  })
  return [
    sse({ id, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }),
    sse({
      id,
      model,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_core_e2e_edit',
            type: 'function',
            function: { name: 'edit', arguments: args },
          }, {
            index: 1,
            id: 'call_core_e2e_write',
            type: 'function',
            function: { name: 'write', arguments: JSON.stringify({
              path: join(dirname(targetFile), 'allow-all-proof.txt'), content: 'Second tool executed\n',
            }) },
          }],
        },
        finish_reason: null,
      }],
    }),
    sse({ id, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ]
}

function textChunks(model: string, text: string): string[] {
  const id = 'chatcmpl-core-e2e-final'
  return [
    sse({ id, model, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }),
    sse({ id, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ]
}

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

async function waitForAgent(app: LaunchedApp, sessionId: string, targetFile: string): Promise<void> {
  const deadline = Date.now() + 90_000
  let lastState: {
    processing: boolean
    messages: Array<{
      role: string
      content: string
      toolName?: string
      toolResult?: string
      isError?: boolean
      error?: string
    }>
  } | null = null
  while (Date.now() < deadline) {
    const state = await callOn<{
      processing: boolean
      messages: Array<{
        role: string
        content: string
        toolName?: string
        toolResult?: string
        isError?: boolean
        error?: string
      }>
    } | null>(
      app,
      `async function (id) {
        const session = await window.electronAPI.getSessionMessages(id)
        if (!session) return null
        return {
          processing: session.isProcessing,
          messages: session.messages.slice(-5).map(message => ({
            role: message.role,
            content: message.content,
            toolName: message.toolName,
            toolResult: message.toolResult,
            isError: message.isError,
            error: message.error,
          })),
        }
      }`,
      [sessionId],
    ).catch(() => null)
    lastState = state
    if (
      state?.messages.some(message => message.role === 'assistant')
      && !state.processing
      && readFileSync(targetFile, 'utf8') === AGENT_EDIT
    ) return
    await sleep(100)
  }
  throw new Error(
    `Timed out waiting for the real Pi edit turn: state=${JSON.stringify(lastState)} file=${JSON.stringify(readFileSync(targetFile, 'utf8'))} process=${JSON.stringify(app.processLines.slice(-40))}`,
  )
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

await main()
