// input: Mixed-workspace metadata plus current-runtime, retained-project, and active navigation state
// output: Behavioral proof that rail data stays scoped and its selected target remains exclusive
// pos: Enforces the ADR 0006 ownership and navigation-selection boundaries at the global rail

import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { FREE_CONVERSATION_WORKSPACE_ID } from '@craft-agent/shared/protocol'
import { sessionMetadataReadyAtom, sessionMetaMapAtom, type SessionMeta } from '@/atoms/sessions'
import { FocusProvider } from '@/context/FocusContext'

const appSource = readFileSync(new URL('../../../App.tsx', import.meta.url), 'utf8')
const appShellSource = readFileSync(new URL('../AppShell.tsx', import.meta.url), 'utf8')
const appShellContextSource = readFileSync(new URL('../../../context/AppShellContext.tsx', import.meta.url), 'utf8')
const activityRailSource = readFileSync(new URL('../ActivityRail.tsx', import.meta.url), 'utf8')

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))

const PROJECT_WORKSPACE_ID = 'workspace-jiuzhou'

function meta(id: string, workspaceId: string, name: string): SessionMeta {
  return {
    id,
    workspaceId,
    name,
    createdAt: 1,
    lastMessageAt: 1,
  } as SessionMeta
}

/**
 * The rail reads sessions from two independent paths:
 *   1. the RPC list, which used to be a cross-workspace `getAllSessions`
 *   2. the local atom overlay, which is scoped to the *running* workspace
 * Static rendering does not run effects, so these tests cover path 2 — the one
 * that leaks even after the server is fixed, because an open project fills that
 * atom with its own sessions. Path 1 is covered by the scoped-channel contract
 * in packages/server-core/src/handlers/rpc/sessions.get-handler.test.ts.
 */
function installElectronApi() {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window ??= {}
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.electronAPI = {
    listSessionsByWorkspace: async (workspaceId: string) => [
      meta('free-1', FREE_CONVERSATION_WORKSPACE_ID, '自由对话记录'),
      meta('project-1', PROJECT_WORKSPACE_ID, '九州项目对话'),
    ].filter(session => session.workspaceId === workspaceId),
    getUnreadSummary: async () => ({
      totalUnreadSessions: 0,
      byWorkspace: {},
      hasUnreadByWorkspace: {},
    }),
    onUnreadSummaryChanged: () => () => {},
    onSessionEvent: () => () => {},
  }
}

let ActivityRail: typeof import('../ActivityRail').ActivityRail
let resolveActivityWorkspaceSessionMetas: typeof import('../ActivityRail').resolveActivityWorkspaceSessionMetas

beforeAll(async () => {
  const activityRailModule = await import('../ActivityRail')
  ActivityRail = activityRailModule.ActivityRail
  resolveActivityWorkspaceSessionMetas = activityRailModule.resolveActivityWorkspaceSessionMetas
})

describe('ActivityRail free-conversation scope', () => {
  it('keeps top-level navigation exclusive from stale conversation selection', () => {
    installElectronApi()
    const store = createStore()
    store.set(sessionMetaMapAtom, new Map([
      ['free-1', meta('free-1', FREE_CONVERSATION_WORKSPACE_ID, '自由对话记录')],
    ]))
    store.set(sessionMetadataReadyAtom, true)

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <FocusProvider>
          <ActivityRail
            activeItem="skills"
            workspaces={[{
              id: PROJECT_WORKSPACE_ID,
              name: '九州',
              slug: 'jiuzhou',
              rootPath: '/tmp/jiuzhou',
              createdAt: 0,
            }]}
            runtimeWorkspaceId={FREE_CONVERSATION_WORKSPACE_ID}
            activeWorkspaceId={PROJECT_WORKSPACE_ID}
            activeSessionId="free-1"
            onSelectSession={() => {}}
            onOpenSkills={() => {}}
          />
        </FocusProvider>
      </Provider>
    )

    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(html).toContain('aria-current="page" data-tutorial="activity-skills"')
  })

  it('adds a new conversation to history only after its first user message', () => {
    installElectronApi()
    const store = createStore()
    store.set(sessionMetaMapAtom, new Map([
      ['draft', {
        ...meta('draft', FREE_CONVERSATION_WORKSPACE_ID, ''),
        name: undefined,
        messageCount: 0,
      }],
      ['sent', {
        ...meta('sent', FREE_CONVERSATION_WORKSPACE_ID, '已发送对话'),
        messageCount: 1,
      }],
    ]))
    store.set(sessionMetadataReadyAtom, true)

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <FocusProvider>
          <ActivityRail
            activeItem="recent"
            runtimeWorkspaceId={FREE_CONVERSATION_WORKSPACE_ID}
            onSelectSession={() => {}}
          />
        </FocusProvider>
      </Provider>
    )

    expect(html).not.toContain('data-session-id="draft"')
    expect(html).toContain('data-session-id="sent"')
    expect(html).toContain('自由<span class="ml-1 font-normal">(1)</span>')
  })

  it('projects active remote metadata under its catalog owner before session actions', () => {
    const remote = meta('remote-session', 'server-workspace', 'Remote')
    expect(resolveActivityWorkspaceSessionMetas(PROJECT_WORKSPACE_ID, PROJECT_WORKSPACE_ID, [], [remote], true, 'server-workspace'))
      .toEqual([{ ...remote, workspaceId: PROJECT_WORKSPACE_ID }])
  })

  it('applies persisted order to pinned project rows', () => {
    installElectronApi()
    const previousStorage = globalThis.localStorage
    globalThis.localStorage = { getItem: (key: string) => key === `craft-activity-session-order:${PROJECT_WORKSPACE_ID}` ? '["second","first"]' : null } as Storage
    try {
      const store = createStore()
      store.set(sessionMetaMapAtom, new Map([
        ['first', { ...meta('first', PROJECT_WORKSPACE_ID, 'First'), isPinned: true, messageCount: 1 }],
        ['second', { ...meta('second', PROJECT_WORKSPACE_ID, 'Second'), isPinned: true, messageCount: 1 }],
      ]))
      store.set(sessionMetadataReadyAtom, true)
      const html = renderToStaticMarkup(<Provider store={store}><FocusProvider><ActivityRail
        activeItem="recent" runtimeWorkspaceId={PROJECT_WORKSPACE_ID}
        workspaces={[{ id: PROJECT_WORKSPACE_ID, name: 'Project', slug: 'project', rootPath: '/project', createdAt: 1 }]}
        onSelectSession={() => {}}
      /></FocusProvider></Provider>)
      expect(html.indexOf('data-session-id="second"')).toBeLessThan(html.indexOf('data-session-id="first"'))
    } finally { globalThis.localStorage = previousStorage }
  })

  it('renders pinned and free conversations in peer sections with draggable rows', () => {
    installElectronApi()
    const store = createStore()
    store.set(sessionMetaMapAtom, new Map([
      ['fixed', { ...meta('fixed', FREE_CONVERSATION_WORKSPACE_ID, '自动化会话'), isPinned: true, messageCount: 1 }],
      ['regular', { ...meta('regular', FREE_CONVERSATION_WORKSPACE_ID, '普通会话'), messageCount: 1 }],
    ]))
    store.set(sessionMetadataReadyAtom, true)

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <FocusProvider>
          <ActivityRail
            activeItem="recent"
            runtimeWorkspaceId={FREE_CONVERSATION_WORKSPACE_ID}
            onSelectSession={() => {}}
          />
        </FocusProvider>
      </Provider>
    )

    const fixedSection = html.match(/<section aria-label="固定">([\s\S]*?)<\/section>/)?.[1]
    const freeSection = html.match(/<section aria-label="自由">([\s\S]*?)<\/section>/)?.[1]
    expect(fixedSection).toContain('data-session-id="fixed"')
    expect(freeSection).toContain('data-session-id="regular"')
    expect(freeSection).not.toContain('data-session-id="fixed"')
    expect(html).toContain('data-session-group="fixed"')
    expect(html).toContain('固定')
    expect(html).toContain('data-session-group="regular"')
    expect(html).toContain('data-session-id="fixed" data-session-fixed="true"')
    expect(html).toContain('data-session-id="regular" data-session-fixed="false"')
    expect(html.match(/data-session-drag-handle="true"/g)).toHaveLength(2)
  })

  it('shows a pinned project conversation in the global pinned section while its project is collapsed', () => {
    installElectronApi()
    const store = createStore()
    store.set(sessionMetaMapAtom, new Map([
      ['project-pin', { ...meta('project-pin', PROJECT_WORKSPACE_ID, 'Project reminder'), isPinned: true, messageCount: 1 }],
    ]))
    store.set(sessionMetadataReadyAtom, true)
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <FocusProvider>
          <ActivityRail activeItem="recent" runtimeWorkspaceId={PROJECT_WORKSPACE_ID} onSelectSession={() => {}}
            workspaces={[{ id: PROJECT_WORKSPACE_ID, name: 'Project', slug: 'project', rootPath: '/tmp/project', createdAt: 1 }]} />
        </FocusProvider>
      </Provider>,
    )
    expect(html.match(/<section aria-label="固定">([\s\S]*?)<\/section>/)?.[1]).toContain('data-session-id="project-pin"')
    expect(html.match(/<section aria-label="自由">([\s\S]*?)<\/section>/)?.[1]).not.toContain('data-session-id="project-pin"')
    expect(html.match(/data-session-id="project-pin"/g)).toHaveLength(1)
  })

  it('never renders a project conversation, even when the atom overlay holds one', () => {
    installElectronApi()
    const store = createStore()
    // Mirrors an open project: the workspace-scoped atom is full of its sessions.
    store.set(sessionMetaMapAtom, new Map([
      ['project-1', meta('project-1', PROJECT_WORKSPACE_ID, '九州项目对话')],
      ['free-1', meta('free-1', FREE_CONVERSATION_WORKSPACE_ID, '自由对话记录')],
    ]))

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <FocusProvider>
          <ActivityRail
            activeItem="recent"
            workspaces={[{
              id: PROJECT_WORKSPACE_ID,
              name: '九州',
              slug: 'jiuzhou',
              rootPath: '/tmp/jiuzhou',
              createdAt: 0,
            }]}
            activeWorkspaceId={PROJECT_WORKSPACE_ID}
            onSelectSession={() => {}}
            onOpenFreeConversations={() => {}}
          />
        </FocusProvider>
      </Provider>
    )

    expect(html).not.toContain('九州项目对话')
    expect(html).not.toContain('data-session-id="project-1"')
    expect(html).not.toContain('lucide-message-square-text')
    // The project itself still belongs in the rail — only its conversations do not.
    expect(html).toContain('九州')
  })

  it('renders a missing Project root as relink-only instead of recreating or opening it', () => {
    installElectronApi()
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <FocusProvider>
          <ActivityRail
            activeItem="recent"
            workspaces={[{
              id: PROJECT_WORKSPACE_ID,
              name: '已移动项目',
              slug: 'moved-project',
              rootPath: '/tmp/missing-project',
              rootAvailable: false,
              createdAt: 0,
            }]}
            onSelectSession={() => {}}
            onCreateConversationInProject={() => {}}
            onRelinkProject={() => {}}
          />
        </FocusProvider>
      </Provider>
    )

    const projectRowStart = html.indexOf('aria-label="项目：已移动项目"')
    const projectRow = html.slice(projectRowStart, html.indexOf('</div></div>', projectRowStart))
    expect(projectRow).toContain('disabled=""')
    expect(projectRow).toContain('aria-label="workspace.reconnect"')
    expect(projectRow).not.toContain('lucide-chevron-right')
    expect(activityRailSource).toContain('onRelinkProject(workspace.id)')
    expect(appSource).toContain('window.electronAPI.relinkWorkspace(workspaceId, rootPath)')
  })

  it('orders a newly created Project before older Projects without access timestamps', () => {
    installElectronApi()
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <FocusProvider>
          <ActivityRail
            activeItem="recent"
            workspaces={[
              { id: 'older', name: 'A 旧项目', slug: 'older', rootPath: '/tmp/older', createdAt: 1 },
              { id: 'newer', name: 'Z 新项目', slug: 'newer', rootPath: '/tmp/newer', createdAt: 2 },
            ]}
          />
        </FocusProvider>
      </Provider>
    )

    expect(html.indexOf('Z 新项目')).toBeLessThan(html.indexOf('A 旧项目'))
  })

  it('labels the section by its domain rather than as a global recent list', () => {
    installElectronApi()
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <FocusProvider>
          <ActivityRail activeItem="recent" onOpenFreeConversations={() => {}} />
        </FocusProvider>
      </Provider>
    )

    expect(html).toContain('自由对话')
    expect(html).not.toContain('最近对话')
    const createButtonStart = html.indexOf('aria-label="新建任务"')
    const createButton = html.slice(createButtonStart, html.indexOf('</button>', createButtonStart))
    expect(createButton).toContain('新建任务')
    expect(createButton).not.toContain('opacity-0')
  })

  it('keeps the create action on the free-conversation section header', () => {
    installElectronApi()
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <FocusProvider>
          <ActivityRail activeItem="recent" onOpenFreeConversations={() => {}} />
        </FocusProvider>
      </Provider>
    )

    const sectionStart = html.indexOf('<section aria-label="自由">')
    const sectionHtml = html.slice(sectionStart, html.indexOf('</section>', sectionStart))
    expect(sectionHtml).toContain('aria-label="新建自由对话"')
  })

  it('marks the help menu with a blue dot while update content is unseen', () => {
    installElectronApi()
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <FocusProvider>
          <ActivityRail activeItem="recent" whatsNew={{ unseen: true }} />
        </FocusProvider>
      </Provider>
    )

    expect(html).toContain('aria-label="有未读更新"')
    expect(html).toContain('bg-blue-500')
  })

  it('creates in the current runtime instead of a retained project', () => {
    const handlerStart = appSource.indexOf('const handleOpenFreeConversations =')
    const handlerEnd = appSource.indexOf('\n\n  useEffect(', handlerStart)
    const handlerSource = appSource.slice(handlerStart, handlerEnd)
    const railStart = appShellSource.indexOf('<ActivityRail\n')
    const railProps = appShellSource.slice(railStart, appShellSource.indexOf('/>', railStart))
    const projectCreateStart = appShellSource.indexOf('const handleActivityProjectSessionCreate =')
    const projectCreateSource = appShellSource.slice(
      projectCreateStart,
      appShellSource.indexOf('\n\n  const handleSidebarFocus', projectCreateStart),
    )

    expect(railProps).toContain('runtimeWorkspaceId={activeWorkspaceId}')
    expect(railProps).toContain('activeWorkspaceId={projectWorkspaceId}')
    expect(handlerSource).toContain('windowWorkspaceId === FREE_CONVERSATION_WORKSPACE_ID')
    expect(handlerSource).toContain('navigate(targetRoute)')
    expect(handlerSource).toContain('options?.createNew')
    expect(handlerSource).toContain('routes.action.newSession()')
    expect(handlerSource).toContain('routes.view.allSessions()')
    expect(activityRailSource).toContain("useFocusZone({ zoneId: 'navigator' })")
    expect(activityRailSource).toContain('tabIndex={-1}')
    expect(appShellContextSource).toContain(
      'onOpenFreeConversations: (options?: { createNew?: boolean }) => void | Promise<void>'
    )
    expect(activityRailSource).toContain('onCreateConversationInProject(activeWorkspaceId)')
    expect(activityRailSource).toContain('onOpenFreeConversations?.({ createNew: true })')
    expect(projectCreateSource).toContain('if (workspaceId === activeWorkspaceId)')
    expect(projectCreateSource.indexOf('navigateToSessionInPanel(session.id)')).toBeLessThan(
      projectCreateSource.indexOf('await onSelectWorkspace(workspaceId)')
    )
  })

  it('treats the active runtime atom as authoritative for create and delete', () => {
    const staleSnapshot = [
      meta('deleted', PROJECT_WORKSPACE_ID, '已删除对话'),
      meta('kept', PROJECT_WORKSPACE_ID, '保留对话'),
    ]
    const liveRuntime = [
      meta('created', PROJECT_WORKSPACE_ID, '刚创建对话'),
      meta('kept', PROJECT_WORKSPACE_ID, '保留对话'),
    ]

    const active = resolveActivityWorkspaceSessionMetas(
      PROJECT_WORKSPACE_ID,
      PROJECT_WORKSPACE_ID,
      staleSnapshot,
      liveRuntime,
    )
    expect(active.map(session => session.id)).toEqual(['created', 'kept'])

    const inactive = resolveActivityWorkspaceSessionMetas(
      PROJECT_WORKSPACE_ID,
      'another-workspace',
      staleSnapshot,
      liveRuntime,
    )
    expect(inactive.map(session => session.id)).toEqual(['deleted', 'kept'])
  })

  it('keeps the rail cache visible while the runtime metadata map hydrates', () => {
    const cachedSnapshot = [meta('cached', PROJECT_WORKSPACE_ID, '缓存对话')]
    const emptyRuntime: SessionMeta[] = []

    const duringHydration = resolveActivityWorkspaceSessionMetas(
      PROJECT_WORKSPACE_ID,
      PROJECT_WORKSPACE_ID,
      cachedSnapshot,
      emptyRuntime,
      false,
    )

    expect(duringHydration.map(session => session.id)).toEqual(['cached'])
  })

  it('renders the Feishu avatar with an initial fallback and follows auth broadcasts', () => {
    installElectronApi()
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <FocusProvider>
          <ActivityRail
            activeItem="recent"
            profile={{
              name: '飞书用户',
              avatarUrl: 'https://example.com/feishu-avatar.png',
            }}
            onOpenFreeConversations={() => {}}
          />
        </FocusProvider>
      </Provider>
    )

    expect(html).toContain('src="https://example.com/feishu-avatar.png"')
    expect(html).toContain('飞')
    expect(appSource).toContain('avatarUrl: user?.avatarUrl')
    expect(appSource).toContain('onClientAuthStateChanged(setClientAuthState)')
  })
})
