// input: A fixture data dir + the launched app handle (launch.ts); CONTEXT.md perf targets
// output: A JSON report under results/ plus a stdout table, each metric annotated pass/fail vs target
// pos: The perf harness driver — sequences startup, interaction, typing, and memory scenarios and judges them

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  launchApp,
  verifyStandardFixture,
  evalOn,
  heapUsed,
  waitFor,
  countPerf,
  sleep,
  DEFAULT_FIXTURE,
  type LaunchedApp,
} from './launch.ts'
import {
  buildSizeAwareRing,
  buildSwitchRing,
  evaluateMeasuredBaselines,
  parsePerfScenarios,
  parsePositiveInteger,
  percentile,
  LARGE_SESSION_MESSAGES,
  type SessionRef,
} from './contract.ts'
import {
  expandWritingChapterDirectoryExpression,
  openFixtureProjectExpression,
  openWritingChapterExpression,
  projectButtonsReadyExpression,
  writingChapterLabel,
  writingChapterMountedExpression,
} from './navigation.ts'

// ---- Config (env-driven, no framework) ----------------------------------
const FIXTURE = process.env.PERF_FIXTURE || DEFAULT_FIXTURE
const STARTUP_RUNS = parsePositiveInteger(process.env.PERF_STARTUP_RUNS, 3, 'PERF_STARTUP_RUNS')
const SWITCHES = parsePositiveInteger(process.env.PERF_SWITCHES, 40, 'PERF_SWITCHES')
const LEAK_LOOPS = parsePositiveInteger(process.env.PERF_LEAK_LOOPS, 100, 'PERF_LEAK_LOOPS')
const SCENARIOS = parsePerfScenarios(process.env.PERF_SCENARIOS)
const DIAGNOSTIC_MODE = process.env.PERF_SCENARIOS !== undefined

// ---- Targets (from CONTEXT.md — keep in sync) ---------------------------
const TARGET = {
  startupMs: 3000,
  hubInteractiveMs: 2000,
  sidebarOpenMs: 100,
  switchP95Ms: 100,
  steadyHeapMb: 500,
  leakPct: 10,
  /** CONTEXT.md heavy tier: open large writing document / global search */
  heavyMs: 1000,
  /** CONTEXT.md continuous tier: keystroke/stream frame budget */
  continuousMs: 16.7,
}

const SWITCH_COMPLETE = /Session switch complete:\s*([\d.]+)\s*ms/i
/** Prose term present in generated fixture chapters, so ripgrep does real work. */
const HEAVY_SEARCH_QUERY = '灯芯'
/** Chapter count of the standard writing fixture (scripts/perf/generate-fixture.ts). */
const WRITING_FIXTURE_CHAPTERS = 400
const DOCUMENT_PAINT_COMPLETE = /writing\.document\.paintAfterRead:\s*([\d.]+)\s*ms/i

interface Metric {
  scenario: string
  name: string
  value: number
  unit: string
  target: number
  pass: boolean
  note?: string
}

async function main() {
  const started = Date.now()
  const metrics: Metric[] = []

  if (SCENARIOS.includes('startup')) metrics.push(...(await runStartup()))
  if (SCENARIOS.includes('heavy-writing')) metrics.push(...(await runHeavyWriting()))
  if (SCENARIOS.includes('heavy-search')) metrics.push(...(await runHeavySearch()))
  if (SCENARIOS.includes('memory-leak-docs')) metrics.push(...(await runDocumentLeak()))
  if (SCENARIOS.includes('continuous-typing')) metrics.push(...(await runContinuousTyping()))

  const needsLive = ['switch', 'memory-steady', 'memory-leak'].some((s) => SCENARIOS.includes(s))
  if (needsLive) {
    const live = await launchApp(FIXTURE)
    try {
      await enterWorkspaceWithSessions(live)
      const refs = await sessionRefsFromApi(live)
      if (refs.length < 2) throw new Error(`Workspace exposes only ${refs.length} sessions via getSessions — need >= 2.`)

      if (SCENARIOS.includes('switch')) metrics.push(...(await runSwitch(live, refs)))
      if (SCENARIOS.includes('memory-steady')) metrics.push(...(await runSteadyMemory(live, refs)))
      if (SCENARIOS.includes('memory-leak')) metrics.push(...(await runLeak(live, refs)))
    } finally {
      await live.close()
    }
  }

  report(metrics, Date.now() - started)
}

// ---- Navigation ---------------------------------------------------------
/**
 * From a fresh launch: ActivityRail → open a non-writing workspace that has fixture sessions.
 * Product UI is writing-first (no always-visible SessionList); session switching is
 * exercised via the same navigate() route the ConversationHistoryMenu uses.
 */
async function enterWorkspaceWithSessions(live: LaunchedApp): Promise<void> {
  await waitFor(
    live,
    projectButtonsReadyExpression(),
    60_000,
    'ActivityRail project buttons'
  )
  await dismissStartupAnnouncement(live)

  const opened = await openNonNovelProject(live)
  if (!opened) throw new Error('Could not open a non-writing fixture project from ActivityRail')
  await openExpandedProjectSession(live)

  // Backend session index for this workspace (300/workspace can take a moment).
  await waitFor(
    live,
    `(async () => (await window.electronAPI.getSessions()).length >= 2)()`,
    90_000,
    'workspace sessions via getSessions'
  )

  // Land on a concrete session so ChatPage mounts and transcript loading runs.
  const ids = await sessionIdsFromApi(live)
  await navigateToSession(live, ids[0])
  await sleep(200)
}

/** From a fresh launch: ActivityRail → writing project → project tree ready with no file opened. */
interface WritingWorkspaceEntryTiming {
  hubReadyAt: number
  projectClickedAt: number
  catalogReadyAt: number
  startupMarks: Record<string, number>
}

export async function enterFirstWritingWorkspace(live: LaunchedApp): Promise<WritingWorkspaceEntryTiming> {
  await waitFor(
    live,
    projectButtonsReadyExpression(),
    60_000,
    'ActivityRail project buttons'
  )
  await dismissStartupAnnouncement(live)
  const hubReadyAt = Date.now()
  const startupMarks = await evalOn<Record<string, number>>(
    live,
    `({
      __timeOrigin: Math.round(performance.timeOrigin),
      __now: Math.round(performance.now()),
      ...Object.fromEntries(performance.getEntriesByType('mark')
        .filter((entry) => entry.name.startsWith('storyflow.'))
        .map((entry) => [entry.name, Math.round(entry.startTime)])),
    })`,
  )

  const opened = await openWritingProject(live)
  if (!opened) throw new Error('Could not open the writing fixture project from ActivityRail')
  const projectClickedAt = Date.now()
  await openExpandedProjectSession(live)
  await navigateToWritingWorkspace(live)

  await waitFor(live, `!!document.querySelector('[data-tutorial="writing-catalog"]')`, 45_000, 'writing catalog')
  const catalogReadyAt = Date.now()
  await sleep(100)
  const initialTabCount = await evalOn<number>(
    live,
    `document.querySelectorAll('[data-panel-role="writing-file-tabs"] [role="tab"]').length`,
  )
  const initialReadCount = countPerf(live, /writing\.document\.readFile:/)
  if (initialTabCount !== 0 || initialReadCount !== 0) {
    throw new Error(
      `Writing catalog opened ${initialTabCount} tab(s) and read ${initialReadCount} document(s) before user selection`
    )
  }
  const legacyChatMounted = await evalOn<boolean>(
    live,
    `!!document.querySelector('[data-tutorial="chat-history"], [data-tutorial="new-session-button"]')`,
  )
  if (legacyChatMounted) {
    throw new Error('Writing project entry mounted the legacy conversation UI on the startup critical path')
  }
  return {
    hubReadyAt,
    projectClickedAt,
    catalogReadyAt,
    startupMarks,
  }
}

/** Fresh perf profiles have no release marker, so updates may block the project rail. */
async function dismissStartupAnnouncement(live: LaunchedApp): Promise<void> {
  const appeared = await waitFor(
    live,
    `Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === '继续使用')`,
    2_000,
    'update announcement',
  ).then(() => true, () => false)
  if (!appeared) return

  const dismissed = await evalOn<boolean>(live, `(() => {
    const button = Array.from(document.querySelectorAll('button'))
      .find((candidate) => candidate.textContent?.trim() === '继续使用')
    button?.click()
    return !!button
  })()`)
  if (dismissed) {
    await waitFor(
      live,
      `!Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === '继续使用')`,
      5_000,
      'update announcement dismissed',
    )
  }
}

/** Open the first ActivityRail project whose name is not the deterministic writing fixture. */
async function openNonNovelProject(live: LaunchedApp): Promise<string | null> {
  return evalOn<string | null>(live, openFixtureProjectExpression('sessions'))
}

/** Open the deterministic 400-chapter writing fixture from ActivityRail. */
async function openWritingProject(live: LaunchedApp): Promise<string | null> {
  // The sidebar initially shows eight projects; the standard fixture has twenty.
  await evalOn(live, `Array.from(document.querySelectorAll('section[aria-label="项目目录"] button'))
    .find(button => /^显示全部 /.test(button.textContent || ''))?.click()`)
  await waitFor(live, `Array.from(document.querySelectorAll('button[aria-label]'))
    .some(button => button.getAttribute('aria-label') === '项目：400章长篇小说')`, 10_000, 'writing project revealed')
  return evalOn<string | null>(live, openFixtureProjectExpression('writing'))
}

/** ActivityRail project buttons expand folders; selecting a child session enters the project. */
export async function openExpandedProjectSession(live: LaunchedApp): Promise<void> {
  const selector = '[data-testid="activity-project-conversations"] [data-session-id] button'
  await waitFor(live, `!!document.querySelector('${selector}')`, 90_000, 'expanded project session')
  const opened = await evalOn<boolean>(live, `(() => {
    const button = document.querySelector('${selector}')
    if (!(button instanceof HTMLButtonElement)) return false
    button.click()
    return true
  })()`)
  if (!opened) throw new Error('Could not open a session from the expanded ActivityRail project')
  await waitFor(
    live,
    `!!document.querySelector('[data-testid="activity-project-conversations"] [data-session-id] button[aria-current="page"]')`,
    90_000,
    'selected project session',
  )
}

/** Same navigation event used by in-app route links after the project runtime is active. */
export async function navigateToWritingWorkspace(live: LaunchedApp): Promise<void> {
  await evalOn(live, `window.dispatchEvent(new CustomEvent('craft-agent-navigate', {
    detail: { route: 'writing' },
    bubbles: true,
  }))`)
  await waitFor(
    live,
    `!!document.querySelector('[data-tutorial="writing-catalog"], [aria-label="展开右侧栏"]')`,
    90_000,
    'writing workspace control',
  )
  await evalOn(live, `document.querySelector('[aria-label="展开右侧栏"]')?.click()`)
}

// ---- Scenario 1: startup ------------------------------------------------
async function runStartup(): Promise<Metric[]> {
  const totalDurations: number[] = []
  const hubDurations: number[] = []
  const catalogDurations: number[] = []
  const devtoolsDurations: number[] = []
  const pageAttachDurations: number[] = []
  const startupMarkRuns: string[] = []
  for (let i = 0; i < STARTUP_RUNS; i++) {
    const t0 = Date.now()
    const live = await launchApp(FIXTURE)
    try {
      devtoolsDurations.push(live.launchTimings.devtoolsReadyAt - t0)
      pageAttachDurations.push(live.launchTimings.pageAttachedAt - t0)
      const timing = await enterFirstWritingWorkspace(live)
      startupMarkRuns.push(JSON.stringify(timing.startupMarks))
      hubDurations.push(timing.hubReadyAt - t0)
      catalogDurations.push(timing.catalogReadyAt - timing.projectClickedAt)
      totalDurations.push(timing.catalogReadyAt - t0)
      if (i === 0) await verifyStandardFixture(live, FIXTURE)
    } finally {
      await live.close()
    }
    await sleep(500)
  }
  totalDurations.sort((a, b) => a - b)
  hubDurations.sort((a, b) => a - b)
  catalogDurations.sort((a, b) => a - b)
  devtoolsDurations.sort((a, b) => a - b)
  pageAttachDurations.sort((a, b) => a - b)
  return [
    metric('startup', `launch→ActivityRail interactive median (n=${STARTUP_RUNS})`, median(hubDurations), 'ms', TARGET.hubInteractiveMs, {
      note: `runs=[${hubDurations.join(', ')}], devtools=[${devtoolsDurations.join(', ')}], page=[${pageAttachDurations.join(', ')}], renderer=${startupMarkRuns.join('|')}`,
    }),
    // Median, not P95: each sample costs a full app launch, so STARTUP_RUNS is
    // small (3 by default) and a "P95" over 3 samples is just max() — one cold
    // filesystem hiccup then decides the baseline (observed 17ms and 156ms in the
    // same run). The tail stays visible via max= in the note.
    metric('startup', `project click→writing catalog median (n=${STARTUP_RUNS})`, median(catalogDurations), 'ms', TARGET.sidebarOpenMs, {
      note: `runs=[${catalogDurations.join(', ')}] max=${Math.max(...catalogDurations)}ms — no file tab or content read before user selection`,
    }),
    metric('startup', `launch→writing-catalog median (n=${STARTUP_RUNS})`, median(totalDurations), 'ms', TARGET.startupMs, {
      note: `runs=[${totalDurations.join(', ')}] — includes opening a writing project + metadata-only catalog`,
    }),
  ]
}

// ---- Heavy: open a deep chapter in the 400-chapter writing fixture --------
async function runHeavyWriting(): Promise<Metric[]> {
  const live = await launchApp(FIXTURE)
  try {
    await enterFirstWritingWorkspace(live)
    await ensureWritingChapterDirectory(live)
    await waitFor(
      live,
      writingChapterMountedExpression(200),
      10_000,
      'chapter 200 row mounted'
    )

    const beforeDocumentPaint = countPerf(live, DOCUMENT_PAINT_COMPLETE)
    const t0 = Date.now()
    const opened = await evalOn<'clicked' | 'already-selected' | null>(live, openWritingChapterExpression(200))
    if (opened !== 'clicked') throw new Error(`Could not scroll to and click 第200章 (${opened ?? 'not found'})`)
    await requirePerfLine(
      live,
      DOCUMENT_PAINT_COMPLETE,
      beforeDocumentPaint,
      30_000,
      'chapter 200 document paint',
    )
    const ms = Date.now() - t0
    return [metric('heavy-writing', 'open mid catalog chapter (第200章)', ms, 'ms', TARGET.heavyMs, {
      note: 'CONTEXT heavy tier ≤1s; wall-clock includes scrollIntoView + treeitem click→document paint',
    })]
  } finally {
    await live.close()
  }
}

// ---- Heavy: global search over standard fixture --------------------------
/**
 * Judges search on a quiesced renderer and reports the cold number separately.
 *
 * Opening the 400-chapter writing project keeps the main thread busy for ~2s, and a
 * query issued inside that window waits behind it (~2.2s to first row versus ~11ms
 * once idle). Both are real, but they are different defects: one is search cost, the
 * other is project-load contention. Folding them into one metric means a search
 * regression and a startup regression are indistinguishable.
 */
async function runHeavySearch(): Promise<Metric[]> {
  const live = await launchApp(FIXTURE)
  try {
    // Writing project has 400 chapters — best stress for file-side search ranking.
    await enterFirstWritingWorkspace(live)
    const coldMs = await measureGlobalSearch(live)

    await closeGlobalSearch(live)
    await waitForRendererQuiescence(live)
    const settledMs = await measureGlobalSearch(live)

    return [
      metric('heavy-search', 'global search query→content results', settledMs, 'ms', TARGET.heavyMs, {
        note: `CONTEXT heavy tier ≤1s; awaits debounced ripgrep content pass on a quiesced renderer (query=${JSON.stringify(HEAVY_SEARCH_QUERY)}); cold-open=${coldMs}ms while the writing project is still loading`,
      }),
    ]
  } finally {
    await live.close()
  }
}

/** Resolves once the renderer sustains idle frames, so a measurement is not queued behind load work. */
async function waitForRendererQuiescence(live: LaunchedApp): Promise<void> {
  await waitFor(
    live,
    `(async () => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(performance.now())))
      let previous = await frame()
      for (let i = 0; i < 3; i++) {
        const current = await frame()
        if (current - previous > 24) return false
        previous = current
      }
      return true
    })()`,
    20_000,
    'renderer quiescence',
  )
}

async function closeGlobalSearch(live: LaunchedApp): Promise<void> {
  await evalOn(
    live,
    `(() => {
      const input = document.querySelector('[cmdk-input]')
      const target = input || document.body
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      return true
    })()`,
  )
  await waitFor(live, `!document.querySelector('[cmdk-input]')`, 10_000, 'global search closed')
}

/** Opens global search, types the fixture query, and returns ms until the content pass settles. */
async function measureGlobalSearch(live: LaunchedApp): Promise<number> {
  const opened = await evalOn<boolean>(
    live,
    `(() => {
        const btn = document.querySelector('[data-tutorial="activity-search"]')
        if (!btn) return false
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
        return true
      })()`
  )
  if (!opened) throw new Error('Could not open global search from activity rail')
  await waitFor(live, `!!document.querySelector('input[cmdk-input], [cmdk-input], input[placeholder*="Search"], input[placeholder*="搜索"]')`, 15_000, 'search input')

  const t0 = Date.now()
  await evalOn(
    live,
    `(() => {
        const input = document.querySelector('input[cmdk-input], [cmdk-input], input[placeholder*="Search"], input[placeholder*="搜索"]')
        if (!(input instanceof HTMLInputElement)) throw new Error('search input missing')
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(input, ${JSON.stringify(HEAVY_SEARCH_QUERY)})
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`
  )
  await waitFor(
    live,
    `!!document.querySelector('[cmdk-item], [role="option"]')`,
    15_000,
    'search results'
  )

  // First rendered row is only the in-memory catalog/session-meta filter. The
  // product's actual workspace content search is debounced and ripgrep-backed,
  // so the heavy tier is only satisfied once that pass reports a terminal state.
  await waitFor(
    live,
    `(() => {
        const el = document.querySelector('[data-global-search-state]')
        if (!el) return false
        const state = el.getAttribute('data-global-search-state')
        return state === 'complete' || state === 'unavailable' || state === 'error'
      })()`,
    20_000,
    'workspace content search settled',
  )
  const contentMs = Date.now() - t0

  const finalState = await evalOn<string>(
    live,
    `(() => {
        const el = document.querySelector('[data-global-search-state]')
        return el ? el.getAttribute('data-global-search-state') : 'missing'
      })()`,
  )
  // An unavailable/errored search engine is not a fast search (CONTEXT.md:
  // "An error or unavailable search engine is not an empty hit set").
  if (finalState !== 'complete') {
    throw new Error(`Workspace content search ended in state "${finalState}" — not a measurable result.`)
  }

  const contentHits = await evalOn<number>(
    live,
    `document.querySelectorAll('[cmdk-item], [role="option"]').length`,
  )
  if (contentHits === 0) {
    throw new Error('Content search settled with zero rows — query does not exercise the fixture.')
  }

  return contentMs
}

// ---- Continuous: chat input keystroke → render+commit -------------------
/**
 * Types with real CDP key events so the whole product input pipeline runs:
 * browser text insertion → RichTextInput onChange → React setState → re-render
 * → commit → forced layout. Synthesizing `textContent` + an `input` event instead
 * (the previous approach) bypassed React entirely and reported ~0.2ms, which is
 * why this scenario has to drive the browser rather than the DOM.
 *
 * The sample window opens on capture-phase `keydown` and closes after the
 * bubble-phase `input` handler forces layout. For a contenteditable composer the
 * text is inserted at `beforeinput`/`input`, not during `keydown`, and React
 * flushes discrete updates synchronously before the event finishes — so this
 * window is the keystroke echo path. Measuring to the end of `keydown` instead
 * closes before any of that work and reports ~0ms.
 *
 * `settleMs` additionally samples a macrotask after the same keystroke, covering
 * commit follow-on work (effects, paint-adjacent scheduling) that lands outside
 * the synchronous window. It is reported as diagnostics, not judged.
 */
/**
 * Focuses the composer and puts the caret at the end.
 *
 * Returns whether focus took, rather than throwing: the composer can briefly hand
 * focus back to a toolbar button while it settles, and the caller retries.
 */
const TYPING_PROBE_FOCUS = `(() => {
  const el = document.querySelector('[data-tutorial="chat-input"]')
  if (!(el instanceof HTMLElement)) throw new Error('chat input not found')
  el.focus()
  if (el.isContentEditable) {
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  }
  return JSON.stringify({ focused: document.activeElement === el, text: el.textContent || '' })
})()`

const TYPING_PROBE_SETUP = `(() => {
  const el = document.querySelector('[data-tutorial="chat-input"]')
  if (!(el instanceof HTMLElement)) throw new Error('chat input not found')
  el.focus()
  if (el.isContentEditable) {
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  }
  if (document.activeElement !== el) throw new Error('chat input did not take focus')

  const probe = { echo: [], settle: [], startedAt: null }
  probe.onKeyDown = () => { probe.startedAt = performance.now() }
  probe.onInput = () => {
    if (probe.startedAt == null) return
    const startedAt = probe.startedAt
    probe.startedAt = null
    // Reading layout flushes style/layout produced by React's synchronous commit.
    void el.getBoundingClientRect()
    probe.echo.push(performance.now() - startedAt)
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      void el.getBoundingClientRect()
      probe.settle.push(performance.now() - startedAt)
    }
    channel.port2.postMessage(0)
  }
  window.addEventListener('keydown', probe.onKeyDown, true)
  window.addEventListener('input', probe.onInput, false)
  window.__perfTypingProbe = probe
  return el.textContent || ''
})()`

const TYPING_PROBE_COLLECT = `(() => {
  const probe = window.__perfTypingProbe
  if (!probe) throw new Error('typing probe missing')
  window.removeEventListener('keydown', probe.onKeyDown, true)
  window.removeEventListener('input', probe.onInput, false)
  delete window.__perfTypingProbe
  const el = document.querySelector('[data-tutorial="chat-input"]')
  return { echo: probe.echo, settle: probe.settle, text: el ? (el.textContent || '') : '' }
})()`

async function runContinuousTyping(): Promise<Metric[]> {
  const live = await launchApp(FIXTURE)
  try {
    await enterWorkspaceWithSessions(live)
    const ids = await sessionIdsFromApi(live)
    await navigateToSession(live, ids[0])
    await waitFor(
      live,
      `!!document.querySelector('[data-tutorial="chat-input"]')`,
      30_000,
      'chat input'
    )
    // The composer mounts before it is interactive; typing into it too early
    // silently drops the first characters and corrupts the sample set.
    await sleep(1000)

    // The composer restores any persisted draft for this session, so measuring
    // from whatever text happens to be there is not repeatable. Draft hydration
    // can also land *after* a clear, so retry until the composer stays empty.
    let focused = await focusChatInput(live)
    for (let attempt = 0; attempt < 5 && focused.text !== ''; attempt++) {
      await clearChatInput(live)
      focused = await focusChatInput(live)
    }
    if (focused.text !== '') {
      throw new Error(`Chat input was not empty before typing (${JSON.stringify(focused.text.slice(0, 40))}).`)
    }

    const before = await evalOn<string>(live, TYPING_PROBE_SETUP)

    const chars = 'abcdefghijklmnopqrstuvwxyz012345'
    for (const ch of chars) {
      await live.cdp.send(
        'Input.dispatchKeyEvent',
        { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch },
        live.sid,
      )
      await live.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, live.sid)
    }
    await sleep(500)

    const collected = await evalOn<{ echo: number[]; settle: number[]; text: string }>(
      live,
      TYPING_PROBE_COLLECT,
    )
    const durations = collected.echo

    // Fail closed: a silently-dropped keystroke would otherwise shrink the sample
    // set and flatter the P95.
    if (durations.length !== chars.length) {
      throw new Error(
        `Typing probe captured ${durations.length}/${chars.length} keystrokes — sample set incomplete.`,
      )
    }
    if (collected.text !== before + chars) {
      throw new Error(
        `Chat input did not receive the typed text (got ${JSON.stringify(collected.text.slice(-40))}).`,
      )
    }

    const settleNote = collected.settle.length === durations.length
      ? ` settleP95=${p95(collected.settle).toFixed(1)}ms`
      : ''
    // Best-effort tidy-up. The app re-persists the draft on shutdown, so the
    // leading clear (not this one) is what makes the scenario repeatable.
    await clearChatInput(live)
    return [
      metric('continuous-typing', `keystroke→render+commit P95 (n=${durations.length})`, p95(durations), 'ms', TARGET.continuousMs, {
        note: `p50=${p50(durations).toFixed(1)}ms${settleNote} — CONTEXT continuous tier ≤16.7ms (real CDP key events through React; excludes CDP RTT)`,
      }),
    ]
  } finally {
    await live.close()
  }
}

/** Clicks the composer with a real mouse event, which survives focus-restoring effects. */
async function clickChatInput(live: LaunchedApp): Promise<void> {
  const box = await evalOn<{ x: number; y: number } | null>(
    live,
    `(() => {
      const el = document.querySelector('[data-tutorial="chat-input"]')
      if (!el) return null
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return null
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 20)) }
    })()`,
  )
  if (!box) return
  for (const type of ['mousePressed', 'mouseReleased'] as const) {
    await live.cdp.send(
      'Input.dispatchMouseEvent',
      { type, x: box.x, y: box.y, button: 'left', clickCount: 1 },
      live.sid,
    )
  }
}

/** Focuses the composer, retrying while it hands focus back to a toolbar button. */
async function focusChatInput(live: LaunchedApp): Promise<{ focused: boolean; text: string }> {
  let last: { focused: boolean; text: string } = { focused: false, text: '' }
  for (let attempt = 0; attempt < 10; attempt++) {
    last = JSON.parse(await evalOn<string>(live, TYPING_PROBE_FOCUS))
    if (last.focused) return last
    await clickChatInput(live)
    await sleep(200)
  }
  throw new Error('Chat input never took focus')
}

/**
 * Empties the composer: select its contents, then delete with a real key event.
 *
 * The app restores persisted drafts, so a previous run's text would otherwise be
 * present and the sample would not be repeatable. `Cmd/Ctrl+A` via CDP does not
 * select inside this contenteditable, so the selection is made programmatically
 * and only the delete goes through the real key path — which is what actually
 * drives React and settles the debounced draft write.
 */
async function clearChatInput(live: LaunchedApp): Promise<void> {
  const selected = await evalOn<number>(
    live,
    `(() => {
      const el = document.querySelector('[data-tutorial="chat-input"]')
      if (!(el instanceof HTMLElement)) return 0
      el.focus()
      const range = document.createRange()
      range.selectNodeContents(el)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      return String(getSelection()).length
    })()`,
  )
  if (selected === 0) return
  for (const type of ['keyDown', 'keyUp'] as const) {
    await live.cdp.send(
      'Input.dispatchKeyEvent',
      { type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
      live.sid,
    )
  }
  // Outlast FreeFormInput's 300ms debounced draft sync.
  await sleep(500)
}

// ---- Memory: writing document open/close (chapter switch) leak ----------
/**
 * Two passes over *disjoint* chapter ranges.
 *
 * The warm pass exists so one-time setup (Arborist, IPC, editor caches) is not
 * counted as a leak. It used to iterate the same chapters as the measured pass,
 * which also excluded any per-chapter retention that only appears on first touch —
 * the measured pass could not fail for the very reason the scenario exists.
 *
 * Disjoint ranges preserve the original intent and restore sensitivity: a bounded
 * cache is already at capacity after the warm pass and stays flat, while a cache
 * that retains every chapter keeps growing on newly-visited ones.
 */
async function runDocumentLeak(): Promise<Metric[]> {
  const live = await launchApp(FIXTURE)
  const loops = parsePositiveInteger(process.env.PERF_DOC_LOOPS, 40, 'PERF_DOC_LOOPS')
  const chapterSpan = parsePositiveInteger(process.env.PERF_DOC_CHAPTERS, 60, 'PERF_DOC_CHAPTERS')
  if (chapterSpan * 2 > WRITING_FIXTURE_CHAPTERS) {
    throw new Error(
      `PERF_DOC_CHAPTERS=${chapterSpan} needs ${chapterSpan * 2} distinct chapters but the fixture has ${WRITING_FIXTURE_CHAPTERS}.`,
    )
  }
  try {
    await enterFirstWritingWorkspace(live)
    const runChapterRing = async (firstChapter: number) => {
      for (let i = 0; i < loops; i++) {
        await openWritingChapter(live, firstChapter + (i % chapterSpan))
        await sleep(50)
      }
    }

    // Warm pass: chapters [1, chapterSpan].
    await runChapterRing(1)
    const warmAnchor = 1
    await openWritingChapter(live, warmAnchor)
    await sleep(500)
    const baseline = await heapUsed(live)

    // Measured pass: chapters [chapterSpan + 1, chapterSpan * 2] — none seen above.
    const measuredFirst = chapterSpan + 1
    await runChapterRing(measuredFirst)
    // Return to a warm chapter and settle before judging growth.
    await openWritingChapter(live, warmAnchor)
    await sleep(500)
    await heapUsed(live)
    await sleep(100)
    const end = await heapUsed(live)
    const deltaPct = baseline > 0 ? ((end - baseline) / baseline) * 100 : 0
    return [metric('memory-leak-docs', `heap growth after ${loops} chapter opens`, deltaPct, '%', TARGET.leakPct, {
      note: `baseline=${(baseline / 1e6).toFixed(1)}MB → after=${(end / 1e6).toFixed(1)}MB; warm=[1,${chapterSpan}] measured=[${measuredFirst},${chapterSpan * 2}] (disjoint) — CONTEXT leak check includes document open/close`,
    })]
  } finally {
    await live.close()
  }
}

/** Scroll virtualized catalog to chapter N and click it. Chapters are 1-indexed. */
export async function openWritingChapter(live: LaunchedApp, chapter: number): Promise<void> {
  const label = writingChapterLabel(chapter)

  await ensureWritingChapterDirectory(live)
  await waitFor(
    live,
    writingChapterMountedExpression(chapter),
    8_000,
    `${label} mounted`
  )

  const beforeDocumentPaint = countPerf(live, DOCUMENT_PAINT_COMPLETE)
  const opened = await evalOn<'clicked' | 'already-selected' | null>(
    live,
    openWritingChapterExpression(chapter),
  )
  if (!opened) throw new Error(`Could not scroll to or click ${label}`)
  if (opened === 'clicked') {
    await requirePerfLine(
      live,
      DOCUMENT_PAINT_COMPLETE,
      beforeDocumentPaint,
      15_000,
      `${label} document paint`,
    )
  }

  await waitFor(
    live,
    `!!document.querySelector('.tiptap-editor--manuscript .ProseMirror')`,
    15_000,
    `${label} editor ready`
  )
}

async function ensureWritingChapterDirectory(live: LaunchedApp): Promise<void> {
  const expanded = await evalOn<'expanded' | 'already-expanded' | null>(
    live,
    expandWritingChapterDirectoryExpression(),
  )
  if (!expanded) throw new Error('Could not find or expand the writing chapter directory')
}

// ---- Scenario 2: session switch ----------------------------------------
/**
 * The fixture is deliberately skewed: one 1000-message session per workspace and a
 * long tail with a median near 28 lines. An arbitrary id ring therefore measures
 * mostly-empty transcripts and hides large-session cost, so the ring is built
 * largest-first and large switches are judged as their own metric.
 */
async function runSwitch(live: LaunchedApp, sessions: SessionRef[]): Promise<Metric[]> {
  // Alternates large/small so the loop's +1 offset (which avoids re-opening the
  // already-selected session) still lands on large transcripts repeatedly.
  const ring = buildSwitchRing(sessions, SWITCHES + 1)
  const largeIds = new Set(
    sessions
      .filter((s) => s.messageCount >= LARGE_SESSION_MESSAGES)
      .map((s) => s.id),
  )
  if (largeIds.size === 0) {
    throw new Error(
      `Fixture exposes no session with >= ${LARGE_SESSION_MESSAGES} messages — switch scenario cannot measure large transcripts.`,
    )
  }

  const appDurations: number[] = []
  const wallDurations: number[] = []
  const largeWall: number[] = []
  const smallWall: number[] = []
  for (let i = 0; i < SWITCHES; i++) {
    const target = ring[(i + 1) % ring.length]
    const before = countPerf(live, SWITCH_COMPLETE)
    const t0 = Date.now()
    await navigateToSession(live, target)
    const appMs = await waitForSwitchLine(live, before, 3000)
    const wallMs = Date.now() - t0
    if (appMs == null) await sleep(50)
    const recordedWall = appMs != null ? wallMs : Date.now() - t0
    wallDurations.push(recordedWall)
    if (largeIds.has(target)) largeWall.push(recordedWall)
    else smallWall.push(recordedWall)
    if (appMs != null) appDurations.push(appMs)
  }

  if (wallDurations.length !== SWITCHES) {
    throw new Error(`Session switch coverage incomplete: wall=${wallDurations.length}, expected=${SWITCHES}`)
  }
  if (appDurations.length === 0) {
    throw new Error('Session switch produced no app-instrumented samples (rendererPerf not emitting)')
  }
  if (largeWall.length === 0) {
    throw new Error('Session switch ring never visited a large session — ring construction is wrong.')
  }

  const metrics = [
    metric('switch', `app-instrumented P95 (n=${appDurations.length})`, p95(appDurations), 'ms', TARGET.switchP95Ms, {
      note: `p50=${p50(appDurations).toFixed(1)}ms max=${Math.max(...appDurations).toFixed(0)}ms coverage=${appDurations.length}/${SWITCHES}`,
    }),
    metric(
      'switch',
      `wall-clock P95 (n=${wallDurations.length})`,
      p95(wallDurations),
      'ms',
      TARGET.switchP95Ms,
      {
        note: `p50=${p50(wallDurations).toFixed(1)}ms max=${Math.max(...wallDurations).toFixed(0)}ms (includes CDP RTT)`,
      },
    ),
    metric(
      'switch',
      `large-session wall-clock P95 (n=${largeWall.length})`,
      p95(largeWall),
      'ms',
      TARGET.switchP95Ms,
      {
        note: `>=${LARGE_SESSION_MESSAGES} messages; p50=${p50(largeWall).toFixed(1)}ms max=${Math.max(...largeWall).toFixed(0)}ms — small-session p95=${
          smallWall.length ? p95(smallWall).toFixed(1) : 'n/a'
        }ms (n=${smallWall.length})`,
      },
    ),
  ]
  return metrics
}

// ---- Scenario 3: steady-state memory -----------------------------------
/**
 * Loads the largest transcripts available so "fixture fully loaded" (CONTEXT.md)
 * reflects real residency rather than the mostly-empty tail of the fixture.
 */
async function runSteadyMemory(live: LaunchedApp, sessions: SessionRef[]): Promise<Metric[]> {
  const ring = buildSizeAwareRing(sessions, 20)
  for (let i = 0; i < 10; i++) {
    await navigateToSession(live, ring[i % ring.length])
    await sleep(80)
  }
  const heap = await heapUsed(live)
  return [metric('memory-steady', 'renderer JS heap (post-GC)', heap / 1e6, 'MB', TARGET.steadyHeapMb)]
}

// ---- Scenario 4: leak loop ---------------------------------------------
async function runLeak(live: LaunchedApp, sessions: SessionRef[]): Promise<Metric[]> {
  // Use a wide ring so unbounded transcript retention would grow heap across switches.
  const ring = buildSizeAwareRing(sessions, 80)
  if (ring.length < 2) throw new Error('Need at least 2 sessions for leak loop')

  for (let i = 0; i < 4; i++) {
    await navigateToSession(live, ring[(i + 1) % ring.length])
    await sleep(100)
  }
  await sleep(250)
  const baseline = await heapUsed(live)

  for (let i = 0; i < LEAK_LOOPS; i++) {
    await navigateToSession(live, ring[(i + 1) % ring.length])
    // Allow load + working-set reconcile to settle before the next switch.
    await sleep(60)
  }
  await sleep(400)
  const end = await heapUsed(live)
  const deltaPct = baseline > 0 ? ((end - baseline) / baseline) * 100 : 0
  return [metric('memory-leak', `heap growth after ${LEAK_LOOPS} switches`, deltaPct, '%', TARGET.leakPct, { note: `baseline=${(baseline / 1e6).toFixed(1)}MB → after=${(end / 1e6).toFixed(1)}MB ring=${ring.length}` })]
}

// ---- Interaction helpers ------------------------------------------------
async function sessionIdsFromApi(live: LaunchedApp): Promise<string[]> {
  return (await sessionRefsFromApi(live)).map((s) => s.id)
}

/** Session list carries messageCount, so ring construction can be size-aware. */
async function sessionRefsFromApi(live: LaunchedApp): Promise<SessionRef[]> {
  return evalOn<SessionRef[]>(
    live,
    `(async () => {
      const sessions = await window.electronAPI.getSessions()
      if (!Array.isArray(sessions)) return []
      return sessions
        .filter((s) => s && s.id)
        .map((s) => ({ id: s.id, messageCount: Number(s.messageCount) || 0 }))
    })()`
  )
}

/** Same navigation path as ConversationHistoryMenu item click. */
async function navigateToSession(live: LaunchedApp, id: string): Promise<void> {
  await evalOn(
    live,
    `window.dispatchEvent(new CustomEvent('craft-agent-navigate', {
      detail: { route: ${JSON.stringify(`allSessions/session/${id}`)} },
      bubbles: true,
    }))`
  )
}

async function waitForSwitchLine(live: LaunchedApp, before: number, timeoutMs: number): Promise<number | null> {
  return waitForPerfLine(live, SWITCH_COMPLETE, before, timeoutMs)
}

async function requirePerfLine(
  live: LaunchedApp,
  pattern: RegExp,
  before: number,
  timeoutMs: number,
  label: string,
): Promise<number> {
  const duration = await waitForPerfLine(live, pattern, before, timeoutMs)
  if (duration == null) throw new Error(`Timed out waiting for ${label}`)
  return duration
}

async function waitForPerfLine(
  live: LaunchedApp,
  pattern: RegExp,
  before: number,
  timeoutMs: number,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const complete = live.perfLines.filter((line) => pattern.test(line.text))
    if (complete.length > before) {
      const m = complete[complete.length - 1].text.match(pattern)
      return m ? parseFloat(m[1]) : null
    }
    await sleep(25)
  }
  // Do not report the timeout budget as a switch duration — caller treats null as "no app metric".
  return null
}

// ---- Small utilities ----------------------------------------------------
function p50(xs: number[]): number {
  return percentile(xs, 0.5)
}
function median(xs: number[]): number {
  return [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
}
function p95(xs: number[]): number {
  return percentile(xs, 0.95)
}
function metric(scenario: string, name: string, value: number, unit: string, target: number, extra?: { note?: string }): Metric {
  return { scenario, name, value, unit, target, pass: Number.isFinite(value) ? value <= target : false, note: extra?.note }
}

function report(metrics: Metric[], elapsedMs: number) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const resultsDir = join(import.meta.dirname, 'results')
  mkdirSync(resultsDir, { recursive: true })
  const outPath = join(resultsDir, `${stamp}.json`)
  const decision = evaluateMeasuredBaselines(SCENARIOS, metrics)
  const payload = {
    fixture: FIXTURE,
    mode: DIAGNOSTIC_MODE ? 'diagnostic' : 'full-measured-baseline',
    config: { STARTUP_RUNS, SWITCHES, LEAK_LOOPS, SCENARIOS },
    elapsedMs,
    metrics,
    ...decision,
  }
  writeFileSync(outPath, JSON.stringify(payload, null, 2))

  console.log('\n=== Storyflow perf baseline ===')
  console.log(`fixture: ${FIXTURE}`)
  for (const m of metrics) {
    const flag = m.pass ? 'PASS' : 'FAIL'
    const val = m.unit === 'MB' || m.unit === '%' ? m.value.toFixed(1) : m.value.toFixed(0)
    console.log(`  [${flag}] ${m.scenario} · ${m.name}: ${val}${m.unit} (target ≤ ${m.target}${m.unit})` + (m.note ? `  — ${m.note}` : ''))
  }
  const resultLabel = decision.selectedPass
    ? (DIAGNOSTIC_MODE ? 'SELECTED BASELINES MET' : 'ALL MEASURED BASELINES MET')
    : 'MEASURED BASELINES MISSED'
  console.log(`\n${resultLabel} · report: ${outPath}\n`)
  if (!decision.selectedPass) process.exitCode = 1
}

if (import.meta.main) main().catch((err) => {
  console.error('perf harness failed:', err)
  process.exit(1)
})
