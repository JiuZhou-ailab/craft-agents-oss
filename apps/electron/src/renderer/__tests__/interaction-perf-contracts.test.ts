// input: Session atoms, panel stack, global-search ranking, and the remaining structural hot paths
// output: Deterministic CI proxy contracts for continuous/discrete interaction performance
// pos: ADR-0001 interaction-axis regression guard (re-render/subscription structure, not wall-clock)

import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createStore } from 'jotai'
import type { Message, Session } from '../../shared/types'
import {
  sessionAtomFamily,
  sessionMetaMapAtom,
  updateSessionAtom,
  loadedSessionsAtom,
  reconcileSessionTranscriptWorkingSetAtom,
  resolveSessionTranscriptWorkingSet,
  touchSessionTranscriptAccess,
  SESSION_TRANSCRIPT_WORKING_SET_EXTRA,
  __resetSessionTranscriptWorkingSetForTests,
} from '../atoms/sessions'
import {
  panelStackAtom,
  focusedPanelIdAtom,
  updateFocusedPanelRouteAtom,
} from '../atoms/panel-stack'
import { buildGlobalSearchResults } from '../lib/global-search'

/**
 * Structural fallbacks only.
 *
 * These contracts guard behavior that lives inside component closures (App.tsx event
 * routing, FreeFormInput draft debounce, ChatDisplay turn patching) and cannot be
 * driven without a DOM. The repo has no DOM test environment — `navigation.test.tsx`
 * uses `renderToStaticMarkup`, so effects never run and render counts are not
 * observable — and ADR-0001 forbids adding wall-clock assertions to CI.
 *
 * Assertions below therefore match executable code, never comments: a comment is not
 * a behavioral guarantee, and matching one means deleting the comment reddens CI while
 * deleting the logic does not. Wall-clock coverage for these paths is the local e2e
 * layer's job (`e2e/perf/`, scenarios `continuous-typing` and `switch`).
 */
const sessionsAtomSource = readFileSync(new URL('../atoms/sessions.ts', import.meta.url), 'utf8')
const freeFormInputSource = readFileSync(
  new URL('../components/app-shell/input/FreeFormInput.tsx', import.meta.url),
  'utf8',
)
const sessionListSource = readFileSync(
  new URL('../components/app-shell/SessionList.tsx', import.meta.url),
  'utf8',
)
const sessionItemSource = readFileSync(
  new URL('../components/app-shell/SessionItem.tsx', import.meta.url),
  'utf8',
)
const chatPageSource = readFileSync(new URL('../pages/ChatPage.tsx', import.meta.url), 'utf8')
const appShellSource = readFileSync(
  new URL('../components/app-shell/AppShell.tsx', import.meta.url),
  'utf8',
)
const textHandlerSource = readFileSync(
  new URL('../event-processor/handlers/text.ts', import.meta.url),
  'utf8',
)
const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

function msg(id: string, role: Message['role'] = 'user', content = `content:${id}`): Message {
  return { id, role, content, timestamp: Date.now() }
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: overrides.id ?? 'session-1',
    workspaceId: overrides.workspaceId ?? 'workspace-1',
    messages: overrides.messages ?? [],
    permissionMode: overrides.permissionMode ?? 'ask',
    supportsBranching: overrides.supportsBranching ?? true,
    ...overrides,
  } as Session
}

describe('interaction perf contracts (ADR-0001 CI proxy)', () => {
  afterEach(() => {
    __resetSessionTranscriptWorkingSetForTests()
  })

  it('keeps typing drafts local with debounced parent sync (continuous axis)', () => {
    // Structural: the debounce lives in a component closure (no DOM env to drive it).
    // Asserts executable code — a timer wrapping onInputChange, and a local ref used
    // as the between-flush source of truth — so removing the logic fails the test.
    expect(freeFormInputSource).toMatch(/syncTimeoutRef\s*=\s*React\.useRef/)
    expect(freeFormInputSource).toMatch(/syncTimeoutRef\.current\s*=\s*setTimeout\(/)
    expect(freeFormInputSource).toMatch(/setTimeout\([\s\S]{0,200}?onInputChange\(/)
    expect(freeFormInputSource).toMatch(/clearTimeout\(syncTimeoutRef\.current\)/)
    expect(freeFormInputSource).toContain('inputRef.current')
  })

  it('restores drafts from explicit events instead of polling component state', () => {
    expect(chatPageSource).not.toContain('const interval = setInterval(() => {')
    expect(appSource).not.toContain('setTimeout(() => handleInputChange(session.id, params.input!), 100)')
  })

  it('scopes pending plan recovery to the session lifecycle', () => {
    expect(freeFormInputSource).toContain('const onSubmitRef = React.useRef(onSubmit)')
    expect(freeFormInputSource).toContain('onSubmitRef.current(executionMessage, undefined)')
    expect(freeFormInputSource).toMatch(
      /Reload recovery:[\s\S]*?React\.useEffect\([\s\S]*?\}, \[sessionId\]\)/,
    )
    expect(freeFormInputSource.match(/'craft:compaction-complete'/g)).toHaveLength(2)
    expect(freeFormInputSource).not.toContain('await new Promise(resolve => setTimeout(resolve, 100))')
  })

  it('does not refetch the global model catalog after a session model mutation', () => {
    const modelChangeHandler = chatPageSource.slice(
      chatPageSource.indexOf('const handleModelChange'),
      chatPageSource.indexOf('// Session connection change handler'),
    )
    expect(modelChangeHandler).toContain('await window.electronAPI.setSessionModel')
    expect(modelChangeHandler).not.toContain('refreshLlmConnections()')
  })

  it('keeps session atoms as the only renderer session source of truth', () => {
    expect(sessionsAtomSource).not.toContain('syncSessionsToAtomsAtom')
    expect(appSource).not.toContain('React state is source of truth')
  })

  it('streams text deltas without scanning the full transcript on the common path', () => {
    expect(textHandlerSource).toContain('getLastStreamingMessageIndex')
    expect(textHandlerSource).toContain('appendMessage(session, newMessage, false, false)')
    // Intermediate streaming must not bump lastMessageAt (keeps session list meta stable).
    expect(textHandlerSource).toContain('const shouldUpdateTimestamp = !event.isIntermediate')
  })

  it('patches structure-stable stream deltas without full turn regroup (continuous axis)', () => {
    // ChatDisplay must use the pure patch helper so stream frames do not re-walk
    // completed history on every text_delta. Full regroup remains the fallback.
    const chatDisplaySource = readFileSync(
      new URL('../components/app-shell/ChatDisplay.tsx', import.meta.url),
      'utf8',
    )
    expect(chatDisplaySource).toContain('tryPatchTurnsForStreamingContentChange')
    expect(chatDisplaySource).toContain('turnsCacheRef')
    expect(chatDisplaySource).toContain('groupMessagesByTurn(transcriptMessages)')
  })

  it('applies text_delta via session atom only (skips metadata map rebuild)', () => {
    // Structural: the unified event path writes deltas directly while all
    // structural events keep the metadata-aware action.
    expect(appSource).toMatch(
      /if \(event\.type === 'text_delta'\) \{\s*store\.set\(sessionAtomFamily\(sessionId\), updatedSession\)\s*\} else \{\s*updateSessionDirect\(/,
    )
  })

  it('session list rows subscribe to meta / per-row atoms, not full message arrays', () => {
    expect(sessionListSource).toContain('workspaceSessionMetasAtom')
    expect(sessionListSource).not.toContain('sessionAtomFamily')
    expect(sessionItemSource).not.toContain('sessionAtomFamily')
    expect(sessionItemSource).not.toContain('.messages')
  })

  it('bounds full transcript residency with a working set reconcile on selection', () => {
    // Behavioral: the resolver decides residency, so assert the bound directly —
    // open sessions plus a fixed number of recent extras, never the whole history.
    __resetSessionTranscriptWorkingSetForTests()
    for (const id of ['old-1', 'old-2', 'old-3', 'old-4', 'recent-1', 'recent-2']) {
      touchSessionTranscriptAccess(id)
    }
    const resolved = resolveSessionTranscriptWorkingSet(['open-1'])
    expect(resolved[0]).toBe('open-1')
    expect(resolved.length).toBe(1 + SESSION_TRANSCRIPT_WORKING_SET_EXTRA)
    // Extras are the most recently accessed, not an unbounded tail.
    expect(resolved).toContain('recent-2')
    expect(resolved).not.toContain('old-1')

    // Structural: the AppShell call site that feeds open ids into the reconcile.
    expect(sessionsAtomSource).toContain('reconcileSessionTranscriptWorkingSetAtom')
    expect(sessionsAtomSource).toContain('releaseSessionMessages')
    expect(appShellSource).toContain('reconcileSessionTranscriptWorkingSet(openIds)')
  })

  it('bounds novel version baselines so document open/close cannot retain every chapter', () => {
    expect(appShellSource).toContain('NOVEL_VERSION_BASELINE_WORKING_SET')
    expect(appShellSource).toContain('rememberNovelVersionBaseline')
    expect(appShellSource).toContain('pruneNovelVersionBaselines')
    expect(appShellSource).not.toMatch(
      /novelVersionBaselinesRef\.current\[selectedNovelDocumentPath\]\s*\?\?=/,
    )
  })

  it('reuses the manuscript TipTap editor across chapter switches', () => {
    const editorPanelSource = readFileSync(
      new URL('../components/writing/NovelDocumentEditorPanel.tsx', import.meta.url),
      'utf8',
    )
    expect(editorPanelSource).not.toContain('key={file.path}')
    // Loading overlay must not unmount the editor (remount = ProseMirror leak surface).
    expect(editorPanelSource).toContain('Keep the editor mounted during loads')
    expect(editorPanelSource).toContain('editable={!loading && editable}')
  })

  it('keeps chapter selection local and same-route navigation idempotent', () => {
    const selectHandlerSource = appShellSource.slice(
      appShellSource.indexOf('const handleSelectNovelFile = React.useCallback'),
      appShellSource.indexOf('const handleSelectNovelFileByPath'),
    )
    const selectByPathSource = appShellSource.slice(
      appShellSource.indexOf('const handleSelectNovelFileByPath = React.useCallback'),
      appShellSource.indexOf('const handleOpenNovelWorkspaceStart'),
    )
    expect(selectHandlerSource).not.toContain('onOpenWritingWorkspace()')
    expect(selectHandlerSource).toContain('if (!saved) return false')
    expect(selectByPathSource).toContain('const selected = await handleSelectNovelFile(file)')
    expect(selectByPathSource).toContain('if (selected && !isWritingNavigation(navState)')
    expect(selectByPathSource).toContain('!isWritingNavigation(navState) && !isSessionsNavigation(navState)')

    // Other identical route requests must still preserve panel identity.
    const store = createStore()
    store.set(updateFocusedPanelRouteAtom, 'writing' as never)
    const stackAfterFirst = store.get(panelStackAtom)
    const focusedAfterFirst = store.get(focusedPanelIdAtom)
    expect(stackAfterFirst.length).toBeGreaterThan(0)

    store.set(updateFocusedPanelRouteAtom, 'writing' as never)
    expect(store.get(panelStackAtom)).toBe(stackAfterFirst)
    expect(store.get(focusedPanelIdAtom)).toBe(focusedAfterFirst)

    // A genuinely different route must still update, or navigation would be broken.
    store.set(updateFocusedPanelRouteAtom, 'allSessions' as never)
    expect(store.get(panelStackAtom)).not.toBe(stackAfterFirst)
  })

  it('keeps one session-switch timer across list and direct navigation entry paths', () => {
    // Same-session clicks do not navigate and therefore must not leave a pending timer.
    expect(sessionItemSource).toMatch(/if \(!isSelected\) \{\s*rendererPerf\.startSessionSwitch\(item\.id\)/)
    // ChatPage provides the fallback for direct navigate() callers.
    expect(chatPageSource).toContain('rendererPerf.startSessionSwitch(sessionId)')
    expect(chatPageSource).toContain("rendererPerf.markSessionSwitch(sessionId, 'panel.mounted')")
    expect(chatPageSource).toContain('if (!session || !messageLoadState.messagesReady) return')
    expect(chatPageSource).toContain('rendererPerf.cancelSessionSwitch(sessionId)')
    expect(chatPageSource).toContain('rendererPerf.endSessionSwitch(sessionId)')
  })

  it('caps global search result groups (heavy-search pure bound)', () => {
    // Behavioral: ranking must stay bounded regardless of catalog size, so a
    // 400-chapter project cannot turn one keystroke into an unbounded render.
    const sessions = Array.from({ length: 200 }, (_, i) => ({
      id: `session-${i}`,
      workspaceId: 'workspace-1',
      name: `chapter match ${i}`,
      hidden: false,
      lastMessageAt: i,
    }))
    const novelFiles = Array.from({ length: 400 }, (_, i) => ({
      path: `/novel/chapter-match-${i}.md`,
      name: `chapter match ${i}`,
    }))

    const results = buildGlobalSearchResults({
      query: 'match',
      sessions: sessions as never,
      novelFiles: novelFiles as never,
      formatNovelFileTitle: (file: { name?: string; path: string }) => file.name ?? file.path,
    })

    expect(sessions.length).toBeGreaterThan(8)
    expect(novelFiles.length).toBeGreaterThan(8)
    expect(results.sessions.length).toBeLessThanOrEqual(8)
    expect(results.files.length).toBeLessThanOrEqual(8)
    // Bounded, not empty — a cap that returns nothing would also "pass" a max check.
    expect(results.sessions.length + results.files.length).toBeGreaterThan(0)
  })

  it('does not rewrite session metadata when only message content changes', () => {
    // Proxy for "streaming into active session does not thrash SessionList meta".
    const store = createStore()
    const sessionId = 'session-active'
    // Seed through updateSessionAtom so meta matches extractSessionMeta exactly.
    store.set(updateSessionAtom, sessionId, () => makeSession({
      id: sessionId,
      name: 'Stable title',
      messages: [msg('m1', 'assistant', 'hello')],
      lastMessageAt: 1000,
    }))
    const metaBefore = store.get(sessionMetaMapAtom)

    store.set(updateSessionAtom, sessionId, (prev) => {
      if (!prev) return prev
      return {
        ...prev,
        messages: [{ ...prev.messages[0], content: 'hello world stream' }],
      }
    })

    const metaAfter = store.get(sessionMetaMapAtom)
    expect(metaAfter).toBe(metaBefore)
    expect(store.get(sessionAtomFamily(sessionId))?.messages[0]?.content).toBe('hello world stream')
  })

  it('evicts out-of-working-set transcripts after multi-session load (memory×interaction)', () => {
    const store = createStore()
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      store.set(sessionAtomFamily(id), makeSession({
        id,
        messages: [msg(`${id}-1`), msg(`${id}-2`, 'assistant')],
      }))
    }
    store.set(loadedSessionsAtom, new Set(['a', 'b', 'c', 'd', 'e']))
    __resetSessionTranscriptWorkingSetForTests()

    store.set(reconcileSessionTranscriptWorkingSetAtom, ['e'])

    expect(store.get(loadedSessionsAtom).has('e')).toBe(true)
    expect(store.get(sessionAtomFamily('e'))?.messages.length).toBe(2)
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(store.get(loadedSessionsAtom).has(id)).toBe(false)
      expect(store.get(sessionAtomFamily(id))?.messages).toEqual([])
    }
  })
})
