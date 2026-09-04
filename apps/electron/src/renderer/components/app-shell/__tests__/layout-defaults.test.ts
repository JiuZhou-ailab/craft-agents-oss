// input: App shell viewport, main-process window geometry, rail-collapse, panel chrome, and column sizing contracts
// output: Regression coverage for default shell geometry and native title-bar ownership
// pos: Protects the continuous desktop workbench from detached or overlapping chrome

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'

import * as layoutDefaults from '../layout-defaults'
import {
  DEFAULT_WRITING_WORKSPACE_LAYOUT_RATIO,
  getNavigatorResizeMaxWidth,
  getDefaultWritingWorkspaceLayoutWidths,
  isUserConfiguredShellLayoutWidth,
  resolveInitialShellLayoutWidths,
  shouldResolveInitialShellLayoutWidths,
} from '../layout-defaults'
import {
  PANEL_EDGE_INSET,
  PANEL_GAP,
  PANEL_SASH_LINE_WIDTH,
} from '../panel-constants'

const appShellSource = readFileSync(new URL('../AppShell.tsx', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../../../App.tsx', import.meta.url), 'utf8')
const windowManagerSource = readFileSync(new URL('../../../../main/window-manager.ts', import.meta.url), 'utf8')
const activityRailSource = readFileSync(new URL('../ActivityRail.tsx', import.meta.url), 'utf8')
const panelConstantsSource = readFileSync(new URL('../panel-constants.ts', import.meta.url), 'utf8')
const panelStackSource = readFileSync(new URL('../PanelStackContainer.tsx', import.meta.url), 'utf8')
const panelSlotSource = readFileSync(new URL('../PanelSlot.tsx', import.meta.url), 'utf8')
const panelHeaderSource = readFileSync(new URL('../PanelHeader.tsx', import.meta.url), 'utf8')
const resizableColumnSource = readFileSync(new URL('../ResizableColumn.tsx', import.meta.url), 'utf8')
const resizeGradientSource = readFileSync(new URL('../../../hooks/useResizeGradient.ts', import.meta.url), 'utf8')
const rendererCssSource = readFileSync(new URL('../../../index.css', import.meta.url), 'utf8')
const inputContainerSource = readFileSync(new URL('../input/InputContainer.tsx', import.meta.url), 'utf8')
const editorPanelSource = readFileSync(
  new URL('../../writing/NovelDocumentEditorPanel.tsx', import.meta.url),
  'utf8',
)
const workspaceEmptyStateSource = readFileSync(
  new URL('../../workspace/WorkspaceEmptyState.tsx', import.meta.url),
  'utf8',
)
const novelDocumentTabStripSource = readFileSync(
  new URL('../../writing/NovelDocumentTabStrip.tsx', import.meta.url),
  'utf8',
)
const workspaceProjectSidebarSource = readFileSync(
  new URL('../../workspace/WorkspaceProjectSidebar.tsx', import.meta.url),
  'utf8',
)
const tiptapEditorStyles = readFileSync(
  new URL('../../../../../../../packages/ui/src/components/markdown/tiptap-editor.css', import.meta.url),
  'utf8',
)
const localStorageSource = readFileSync(new URL('../../../lib/local-storage.ts', import.meta.url), 'utf8')

describe('app shell layout defaults', () => {
  it('uses a 2:5:3 default ratio for catalog, document, and dialog columns', () => {
    expect(DEFAULT_WRITING_WORKSPACE_LAYOUT_RATIO).toEqual({
      catalog: 2,
      document: 5,
      dialog: 3,
    })

    expect(getDefaultWritingWorkspaceLayoutWidths(1000)).toEqual({
      catalog: 200,
      document: 500,
      dialog: 300,
    })

    expect(Object.prototype.hasOwnProperty.call(layoutDefaults, 'DEFAULT_SHELL_LAYOUT_RATIO')).toBe(false)
  })

  it('derives first-run writing workspace width from catalog/document/dialog space', () => {
    const widths = resolveInitialShellLayoutWidths({
      totalWidth: 2000,
      edgeInset: 6,
      panelGap: 6,
      sidebarPersisted: false,
      workspacePersisted: false,
    })

    expect(widths.sidebar).toBe(396)
    expect(widths.workspace).toBe(991)
    expect(widths.assistant).toBe(595)
  })

  it('excludes the activity rail from the catalog/document/dialog ratio denominator', () => {
    const widths = resolveInitialShellLayoutWidths({
      totalWidth: 2000,
      activityRailWidth: 48,
      edgeInset: 6,
      panelGap: 6,
      sidebarPersisted: false,
      workspacePersisted: false,
    })

    expect(widths.sidebar).toBe(387)
    expect(widths.workspace).toBe(967)
    expect(widths.assistant).toBe(580)
  })

  it('keeps persisted user widths instead of overriding them with the ratio', () => {
    const widths = resolveInitialShellLayoutWidths({
      totalWidth: 2000,
      edgeInset: 6,
      panelGap: 6,
      sidebarPersisted: true,
      workspacePersisted: true,
      currentSidebarWidth: 240,
      currentWorkspaceWidth: 720,
    })

    expect(widths.sidebar).toBe(240)
    expect(widths.workspace).toBe(720)
    expect(widths.assistant).toBe(1022)
  })

  it('clamps an oversized persisted writing workspace so the assistant keeps its desktop minimum', () => {
    const widths = resolveInitialShellLayoutWidths({
      totalWidth: 2000,
      edgeInset: 6,
      panelGap: 6,
      assistantMinWidth: 440,
      sidebarPersisted: true,
      workspacePersisted: true,
      currentSidebarWidth: 300,
      currentWorkspaceWidth: 1600,
    })

    expect(widths.sidebar).toBe(300)
    expect(widths.workspace).toBe(1242)
    expect(widths.assistant).toBe(440)
  })

  it('does not treat legacy default widths as user-configured layout choices', () => {
    expect(isUserConfiguredShellLayoutWidth('sidebar', 220, true)).toBe(false)
    expect(isUserConfiguredShellLayoutWidth('workspace', 560, true)).toBe(false)
    expect(isUserConfiguredShellLayoutWidth('workspace', 860, true)).toBe(false)

    expect(isUserConfiguredShellLayoutWidth('sidebar', 248, true)).toBe(true)
    expect(isUserConfiguredShellLayoutWidth('workspace', 720, true)).toBe(true)
    expect(isUserConfiguredShellLayoutWidth('workspace', 560, false)).toBe(false)
  })

  it('splits the remaining width as 5:3 when only the sidebar width is persisted', () => {
    const widths = resolveInitialShellLayoutWidths({
      totalWidth: 2000,
      edgeInset: 6,
      panelGap: 6,
      sidebarPersisted: true,
      workspacePersisted: false,
      currentSidebarWidth: 220,
    })

    expect(widths.sidebar).toBe(220)
    expect(widths.workspace).toBe(1101)
    expect(widths.assistant).toBe(661)
  })

  it('allows the writing workspace to grow until the assistant reaches its minimum width', () => {
    expect(getNavigatorResizeMaxWidth({
      shellWidth: 2000,
      navigatorStartX: 230,
      edgeInset: 6,
      panelGap: 6,
      assistantMinWidth: 440,
    })).toBe(1318)
  })

  it('keeps the assistant panel at its minimum width when resolving first-run desktop proportions', () => {
    const widths = resolveInitialShellLayoutWidths({
      totalWidth: 1400,
      edgeInset: 6,
      panelGap: 6,
      sidebarPersisted: false,
      workspacePersisted: false,
      assistantMinWidth: 440,
    })

    expect(widths.sidebar).toBe(276)
    expect(widths.workspace).toBe(666)
    expect(widths.assistant).toBe(440)
  })

  it('keeps an empty project starter conversation free of file columns', () => {
    expect(appShellSource).toContain(
      'const showEmptyProjectSession = shouldUseEmptyProjectStarterLayout({',
    )
    expect(appShellSource).toContain('loadedMessageCount: effectiveSessionMessageCount')
    expect(appShellSource).toContain('persistedMessageCount: rawEffectiveSessionMeta?.messageCount')
    expect(appShellSource).toContain(
      'activeWritingDocumentSurface && rightWorkspaceVisible && canPresentConversationDiffInWorkspace',
    )
    expect(appShellSource).toContain('&& !showEmptyProjectSession')
  })

  it('only delegates diff review when the workspace can render it', () => {
    expect(appShellSource).toContain(
      'const canPresentConversationDiffInWorkspace = showWritingDocumentSurface && !isAutoCompact && !showEmptyProjectSession',
    )
    expect(appShellSource).toContain(
      'onOpenFileChanges: canPresentConversationDiffInWorkspace ? handleOpenConversationFileChanges : undefined',
    )
    expect(appShellSource).toContain(
      'activeWritingDocumentSurface && rightWorkspaceVisible && canPresentConversationDiffInWorkspace',
    )
  })

  it('defers first-run desktop proportions while the shell is still compact', () => {
    expect(shouldResolveInitialShellLayoutWidths(0, 768)).toBe(false)
    expect(shouldResolveInitialShellLayoutWidths(767, 768)).toBe(false)
    expect(shouldResolveInitialShellLayoutWidths(768, 768)).toBe(true)
  })

  it('keeps the manuscript column independent of the active route', () => {
    // The manuscript and the conversation list are distinct roles. Gating the
    // document on the writing route made opening a new conversation replace the
    // manuscript with the conversation list.
    expect(appShellSource).toContain('const showWritingDocumentSurface = showWritingWorkspaceShell')
    expect(appShellSource).not.toContain('const showWritingDocumentSurface = isProjectRuntime && isWritingNavigation(navState)')
    // The navigator column carries one role, so its width no longer switches meaning.
    expect(appShellSource).toContain('const navigatorPanelWidth = sessionListWidth')
  })

  it('leaves the manuscript width to the user when the window resizes', () => {
    // The dock is anchored to the right edge, so a wider window must widen the
    // conversation, not the manuscript. Only the clamp may move it.
    expect(appShellSource).toContain('shouldResolveInitialShellLayoutWidths(shellWidth, MOBILE_THRESHOLD)')
    expect(appShellSource).toContain('DEFAULT_DOCUMENT_DOCK_WIDTH_RATIO')
    expect(appShellSource).not.toContain('preserveAssistantWidthOnShellResize')
    expect(appShellSource).not.toContain('preservingNovelWorkspaceAssistant')
  })

  it('resizes both right-side columns by one shared handle-delta rule', () => {
    // The directory owns the right edge; the manuscript is now a middle column.
    // Neither can measure from a wall, so both share the position-independent
    // delta rule (width = dragStartWidth + handleDelta) in a single branch.
    expect(appShellSource).toContain("if (mode === 'directory-dock' || mode === 'document-dock')")
    expect(appShellSource).toContain('resizeStartXRef.current - clientX')
  })

  it('bounds the directory column by its own min width as the outermost navigator', () => {
    expect(appShellSource).toContain("if (mode === 'directory-dock')")
    expect(appShellSource).toContain('WORKSPACE_DIRECTORY_MIN_WIDTH')
  })

  it('keeps the writing columns on one panel chrome contract', () => {
    expect(appShellSource).toContain('paddingBottom: PANEL_EDGE_INSET, gap: PANEL_GAP')
    expect(resizableColumnSource).toContain('useResizeGradient')
    expect(resizableColumnSource).not.toContain('bg-border/60')
    expect(resizableColumnSource).not.toContain('marginBottom: PANEL_EDGE_INSET')
    expect(resizableColumnSource).not.toContain('borderRadius')
    expect(appShellSource).not.toContain('isRightSidebarVisible')
    expect(appShellSource).not.toContain('isAtRightEdge')
    expect(editorPanelSource).toContain('toolbarAccessory={toolbarAccessory}')
    expect(editorPanelSource).not.toContain('flex h-[42px] shrink-0')
    expect(tiptapEditorStyles).toContain('.tiptap-editor--manuscript .tiptap-toolbar')
    expect(tiptapEditorStyles).toContain('height: 42px')
    expect(workspaceEmptyStateSource).not.toContain('h-[42px]')
    expect(novelDocumentTabStripSource).toContain('h-[42px]')
    expect(panelHeaderSource).toContain('h-[42px]')
  })

  it('uses the existing panel headers as window chrome without a duplicate project title strip', () => {
    expect(appSource).not.toContain('paddingTop: WINDOW_TITLE_BAR_HEIGHT')
    expect(appShellSource).not.toContain('<TopBar')
    expect(panelHeaderSource).toContain('titlebar-drag-region')
    expect(activityRailSource).toContain('style={{ height: WINDOW_TITLE_BAR_HEIGHT }}')
    expect(tiptapEditorStyles).toContain('-webkit-app-region: drag')
    expect(appShellSource).toContain('rightSidebarButton={!rightWorkspaceVisible ? rightWorkspaceToggleButton : undefined}')
    expect(panelStackSource).toContain('index === visiblePanels.length - 1 ? rightSidebarButton : undefined')
  })

  it('limits panel-header no-drag regions to the visible controls', () => {
    expect(panelHeaderSource).toContain('min-w-0 w-fit justify-self-start flex items-center')
    expect(panelHeaderSource).not.toContain("titleAlign === 'start' && 'w-full'")
    expect(panelHeaderSource).not.toContain(
      'titlebar-no-drag min-w-0 w-fit justify-self-start flex items-center',
    )
    expect(panelHeaderSource).toContain(
      'titlebar-no-drag min-w-0 w-fit justify-self-end flex items-center gap-1',
    )
  })

  it('keeps rail actions pinned beside the macOS traffic lights across rail collapse', () => {
    const activityRailControlsSource = appShellSource.slice(
      appShellSource.indexOf('const activityRailControls'),
      appShellSource.indexOf('// One rail callback'),
    )

    expect(appShellSource).not.toContain('ACTIVITY_RAIL_COLLAPSED_WIDTH')
    expect(appShellSource).not.toContain('data-testid="activity-rail-collapsed"')
    expect(appShellSource).not.toContain('data-activity-rail-collapsed')
    expect(rendererCssSource).not.toContain("html[data-activity-rail-collapsed='true']")
    expect(appShellSource).toContain('const contentNeedsStoplightCompensation = isAutoCompact')
    expect(appShellSource).toContain('|| (!isActivityRailVisible && hideSessionListNavigator)')
    expect(appShellSource).toContain(
      'const contentHeaderLeadingInset = !isAutoCompact && !isActivityRailVisible && hideSessionListNavigator',
    )
    expect(appShellSource).toContain('? activityRailWidth + 16')
    expect(appShellSource).toContain("'--panel-header-leading-inset': `${contentHeaderLeadingInset}px`")
    expect(appShellSource).toContain('isSidebarAndNavigatorHidden={contentNeedsStoplightCompensation}')
    expect(appShellSource).toContain('compensateForStoplight={!isActivityRailVisible}')
    expect(appShellSource).not.toContain('const isSidebarAndNavigatorHidden = false')
    expect(activityRailControlsSource).toContain('fixed left-0 top-0')
    expect(activityRailControlsSource).toContain('justify-end')
    expect(activityRailControlsSource).toContain('px-2')
    expect(activityRailControlsSource).toContain('translate-y-0.5')
    expect(activityRailControlsSource).toContain('style={{ width: activityRailWidth, height: WINDOW_TITLE_BAR_HEIGHT }}')
    expect(activityRailControlsSource).not.toContain('left-[84px]')
    expect(activityRailControlsSource.match(/titlebar-no-drag pointer-events-auto/g)).toHaveLength(2)
    expect(activityRailSource).toContain('className="flex items-center gap-2 px-2.5 pb-2"')
    expect(appShellSource).toContain('{showActivityRail ? activityRailControls : null}')
    expect(appShellSource.indexOf('{showActivityRail ? activityRailControls : null}')).toBeGreaterThan(
      appShellSource.indexOf('data-testid="panel-stack-inset"'),
    )
    expect(appShellSource).toContain('<AnimatePresence initial={false}>')
    expect(appShellSource).toContain('data-testid="activity-rail-motion"')
    expect(appShellSource).toContain('className="h-full min-w-0 shrink-0 overflow-hidden border-r border-border"')
    expect(appShellSource).toContain('key="activity-rail"')
    expect(appShellSource).toContain('initial={{ width: 0 }}')
    expect(appShellSource).toContain('animate={{ width: activityRailWidth }}')
    expect(appShellSource).toContain('exit={{ width: 0 }}')
    expect(appShellSource).toContain('transition={shouldReduceMotion ? { duration: 0 } : PANEL_SPRING}')
    expect(appShellSource).not.toContain('activityRailLeadingAction')
    expect(activityRailSource).toContain('className="titlebar-drag-region shrink-0"')
    expect(activityRailSource).toContain('aria-label="调整侧边栏宽度"')
    expect(activityRailSource).toContain('storage.KEYS.activityRailWidth')
    expect(panelHeaderSource).toContain("var(--panel-header-leading-inset, ${STOPLIGHT_PADDING}px)")
    expect(panelHeaderSource).toContain('transition={PANEL_SPRING}')
    expect(windowManagerSource).toContain('const MACOS_TRAFFIC_LIGHT_POSITION = { x: 17, y: 13 }')
    expect(windowManagerSource).toContain('hasShadow: false')
    expect(windowManagerSource).toContain('window.setHasShadow(false)')
    expect(rendererCssSource).toContain('html[data-platform="darwin"] body::after')
  })

  it('renders structural panes as one continuous workbench with parent-owned seams', () => {
    expect(PANEL_GAP).toBe(0)
    expect(PANEL_EDGE_INSET).toBe(0)
    expect(PANEL_SASH_LINE_WIDTH).toBe(1)
    expect(panelConstantsSource).not.toContain('RADIUS_')
    expect(panelConstantsSource).not.toContain('PANEL_STACK_VERTICAL_OVERFLOW')
    expect(panelConstantsSource).not.toContain('PANEL_SASH_FLEX_MARGIN')
    expect(panelStackSource).not.toContain('shadow-middle')
    expect(panelStackSource).not.toContain('borderRadius')
    expect(panelSlotSource).not.toContain('shadow-middle')
    expect(panelSlotSource).not.toContain('borderRadius')
    expect(resizableColumnSource).not.toContain('shadow-middle')
    expect(resizeGradientSource).toContain('var(--foreground) 6%')
    expect(panelHeaderSource).toContain('border-b border-foreground/[0.06]')
    expect(panelSlotSource).toContain('bg-background')
    expect(panelSlotSource).not.toContain('background-elevated')
    expect(activityRailSource).not.toContain('border-r')
    expect(tiptapEditorStyles).toContain('background: var(--background)')
    expect(tiptapEditorStyles).not.toContain('--tiptap-manuscript-paper')
    expect(rendererCssSource).toContain('[data-panel-role="navigator"]')
    expect(rendererCssSource).toContain('[data-panel-role="content"]')
    expect(rendererCssSource).toContain('[data-panel-role="document"]')
    expect(rendererCssSource).toContain('[data-panel-role="directory"]')
  })

  it('keeps the shell edge flat while preserving the composer boundary', () => {
    expect(inputContainerSource).toContain('border border-foreground/[0.07]')
    expect(inputContainerSource).toContain('focus-within:border-foreground/[0.12]')
    expect(inputContainerSource).toContain('bg-foreground/[0.025]')
    expect(inputContainerSource).not.toContain('isFocusedPanel ? "shadow-middle" : "shadow-minimal"')
  })

  it('folds the directory inside a stable shared writing workspace header', () => {
    const workspaceColumnStart = appShellSource.indexOf('key="writing-workspace"')
    const directoryColumnStart = appShellSource.indexOf('key="workspace-directory"')
    const directoryColumnEnd = appShellSource.indexOf('</ResizableColumn>', directoryColumnStart)
    expect(workspaceColumnStart).toBeGreaterThan(-1)
    expect(directoryColumnStart).toBeGreaterThan(-1)
    expect(directoryColumnStart).toBeGreaterThan(workspaceColumnStart)
    expect(directoryColumnEnd).toBeGreaterThan(directoryColumnStart)
    const directoryColumnSource = appShellSource.slice(directoryColumnStart, directoryColumnEnd)

    expect(localStorageSource).toContain("writingWorkspaceVisible: 'writing-workspace-visible'")
    expect(localStorageSource).toContain("workspaceDirectoryVisible: 'workspace-directory-visible'")
    expect(appShellSource).toContain('const [workspaceDirectoryVisible, setWorkspaceDirectoryVisible]')
    const directoryVisibilityStart = appShellSource.indexOf('const showWorkspaceDirectoryColumn = Boolean(')
    const directoryVisibilityEnd = appShellSource.indexOf('\n  return (', directoryVisibilityStart)
    const directoryVisibilitySource = appShellSource.slice(directoryVisibilityStart, directoryVisibilityEnd)
    expect(directoryVisibilitySource).toContain('activityWorkspaceDirectory')
    expect(directoryVisibilitySource).not.toContain('conversationDiffSurface')
    const directoryContentStart = appShellSource.indexOf('const activityWorkspaceDirectory =')
    const directoryContentEnd = appShellSource.indexOf('\n\n  // The document and the conversation list', directoryContentStart)
    const directoryContentSource = appShellSource.slice(directoryContentStart, directoryContentEnd)
    expect(directoryContentSource).not.toContain('isSidebarVisible')
    expect(appShellSource).not.toContain('WORKSPACE_DIRECTORY_COLLAPSED_WIDTH')
    expect(appShellSource).toContain('const writingWorkspaceDockWidth = novelWorkspaceNavigatorWidth + workspaceDirectoryWidth')
    expect(appShellSource).toContain('width={writingWorkspaceDockWidth}')
    expect(directoryColumnSource).toContain('width={workspaceDirectoryWidth}')
    expect(appShellSource).not.toContain('resizable={workspaceDirectoryVisible}')
    expect(appShellSource).toContain('const directoryToggleButton')
    expect(appShellSource).toContain('<NovelDocumentTabStrip')
    expect(appShellSource).toContain('trailingActions={(')
    expect(appShellSource).not.toContain('absolute right-2 top-[46px] z-panel')
    expect(directoryColumnSource).not.toContain('header={(')
    expect(directoryColumnSource).not.toContain('data-panel-role="directory-header"')
    expect(appShellSource).toContain("t('writing.directory.collapse', '收起目录')")
    expect(appShellSource).toContain("t('writing.directory.expand', '展开目录')")
    expect(appShellSource).toContain('onClick={() => setWorkspaceDirectoryVisible((visible) => !visible)}')
    expect(workspaceProjectSidebarSource).not.toContain('HeaderIconButton')
    expect(workspaceProjectSidebarSource).not.toContain('<FolderOpen')
    expect(workspaceProjectSidebarSource).not.toContain('h-[42px]')
    expect(appShellSource).toContain('<AnimatePresence initial={false}>')
    expect(resizableColumnSource).toContain('useReducedMotion')
    expect(resizableColumnSource).toContain('resizable = true')
    expect(resizableColumnSource).toContain('initial={{ width: 0, x: PANEL_SLIDE_OFFSET, opacity: 0 }}')
    expect(resizableColumnSource).toContain('exit={{ width: 0, x: PANEL_SLIDE_OFFSET, opacity: 0 }}')
    expect(resizableColumnSource).toContain('disableAnimation')
  })

  it('keeps the shared desktop panel minimum as the default while writing can reserve less space', () => {
    expect(panelSlotSource).toContain('minWidth = PANEL_MIN_WIDTH')
    expect(panelSlotSource).toContain('? { flexGrow: 1, minWidth: isCompact ? 0 : minWidth }')
    expect(panelSlotSource).toContain(': { flexGrow: proportion, flexShrink: 1, flexBasis: 0, minWidth }')
    expect(appShellSource).toContain('const WRITING_ASSISTANT_MIN_WIDTH = 320')
    expect(appShellSource).toContain('contentPanelMinWidth={showWritingDocumentColumn ? WRITING_ASSISTANT_MIN_WIDTH : PANEL_MIN_WIDTH}')
    expect(panelStackSource).toContain('minWidth={contentPanelMinWidth}')
  })

  it('uses shared default layout constants for both navigator widths before measurement', () => {
    expect(appShellSource).toContain('storage.get(storage.KEYS.sessionListWidth, DEFAULT_WORKSPACE_WIDTH)')
    expect(appShellSource).toContain('const NOVEL_WORKSPACE_NAVIGATOR_DEFAULT_WIDTH = DEFAULT_WORKSPACE_WIDTH')
  })
})
