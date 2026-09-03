// input: Typed routes, external deep links, current project identity, and navigation events
// output: Panel navigation, settings overlay state, and explicit side effects such as verified Skills Market imports
// pos: Renderer navigation authority; external actions must cross a visible confirmation boundary

/**
 * Provides a global `navigate()` function that decouples components from
 * direct session/action imports. The focused peer panel drives navigation,
 * while browser history remains URL-driven so back/forward preserves panel
 * identity, scroll position, and streaming state.
 */

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  useMemo,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { useSession } from '@/hooks/useSession'
import {
  parseRoute,
  parseRouteToNavigationState,
  buildRouteFromNavigationState,
  buildRightSidebarParam,
  type ParsedRoute,
} from '../../shared/route-parser'
import { routes, type Route, type ViewRoute } from '../../shared/routes'
import { parsePermissionMode } from '@craft-agent/shared/agent/mode-types'
import { downloadMarketSkillBundle } from '@craft-agent/shared/skills/marketplace'
import { NAVIGATE_EVENT, type NavigateOptions } from '../lib/navigate'
import {
  normalizePanelRouteForReconcile,
  shouldDefaultInitialRouteToWriting,
  shouldPreserveProjectLandingRoute,
} from './navigation-reconcile'
import { buildSemanticHistoryKey, canRunInitialRestore } from './navigation-history'
import * as storage from '@/lib/local-storage'
import type {
  DeepLinkNavigation,
  Session,
  NavigationState,
  SessionFilter,
  SourceFilter,
  RightSidebarPanel,
  ContentBadge,
} from '../../shared/types'
import {
  isSessionsNavigation,
  isWritingNavigation,
  isSourcesNavigation,
  isSettingsNavigation,
  isSkillsNavigation,
  isAutomationsNavigation,
  DEFAULT_NAVIGATION_STATE,
} from '../../shared/types'
import { isValidSettingsSubpage, type SettingsSubpage } from '../../shared/settings-registry'
import { sessionMetaMapAtom, updateSessionMetaAtom, type SessionMeta } from '@/atoms/sessions'
import { sourcesAtom } from '@/atoms/sources'
import {
  panelStackAtom,
  pushPanelAtom,
  reconcilePanelStackAtom,
  focusedPanelIdAtom,
  focusedPanelRouteAtom,
  focusedPanelIndexAtom,
  updateFocusedPanelRouteAtom,
  parseSessionIdFromRoute,
} from '@/atoms/panel-stack'

// Re-export routes for convenience
export { routes }
export type { Route }

// Re-export navigation state types for consumers
export type { NavigationState, SessionFilter }
export { isWritingNavigation, isSessionsNavigation, isSourcesNavigation, isSettingsNavigation, isSkillsNavigation, isAutomationsNavigation }

// =============================================================================
// Context
// =============================================================================

interface NavigationActionsContextValue {
  /** Navigate to a route */
  navigate: (route: Route, options?: NavigateOptions) => void | Promise<void>
  /** Settings is a utility overlay, not a panel route. */
  settingsSubpage: SettingsSubpage | null
  /** Close the settings overlay without changing the focused panel. */
  closeSettings: () => void
  /** Go back in history */
  goBack: () => void
  /** Go forward in history */
  goForward: () => void
  /** Update right sidebar panel */
  updateRightSidebar: (panel: RightSidebarPanel | undefined) => void
  /** Toggle right sidebar (with optional panel) */
  toggleRightSidebar: (panel?: RightSidebarPanel) => void
  /** Navigate to a source (or source list if no slug), preserving the current filter type */
  navigateToSource: (sourceSlug?: string) => void
  /** Navigate to a session, preserving the current filter type */
  navigateToSession: (sessionId: string) => void
}

const NavigationActionsContext = createContext<NavigationActionsContextValue | null>(null)
const NavigationStateContext = createContext<NavigationState | null>(null)

function areRightSidebarPanelsEqual(
  a: RightSidebarPanel | undefined,
  b: RightSidebarPanel | undefined
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.type !== b.type) return false
  if (a.type !== 'files' || b.type !== 'files') return true
  return a.path === b.path
}

interface NavigationProviderProps {
  children: ReactNode
  /** Current workspace ID */
  workspaceId: string | null
  /** Stable Host workspace ID used for URL ?ws= and localStorage. */
  workspaceRouteKey: string | null
  /** Switch by stable ID; the App may also accept legacy slug URLs. */
  onSwitchWorkspaceByRouteKey?: (routeKey: string) => boolean
  /** Session creation handler */
  onCreateSession: (workspaceId: string, options?: import('../../shared/types').CreateSessionOptions) => Promise<Session>
  /** Input change handler for pre-filling chat input */
  onInputChange?: (sessionId: string, value: string) => void
  /** Get draft input text for a session (reads from ref, no re-render) */
  getDraft?: (sessionId: string) => string
  /** Auto-delete an empty session (no confirmation needed) */
  onAutoDeleteEmptySession?: (sessionId: string) => void
  /** Whether the app is ready to navigate */
  isReady?: boolean
  /** Whether session metadata has been initialized (required for deterministic route restoration) */
  isSessionsReady?: boolean
  /** Remote workspace ID — when set, sessions with this ID are also considered part of the workspace */
  remoteWorkspaceId?: string | null
  /** Owner-specific landing route when the URL does not already carry navigation state. */
  defaultViewRoute?: ViewRoute
}

export function NavigationProvider({
  children,
  workspaceId,
  workspaceRouteKey,
  onSwitchWorkspaceByRouteKey,
  onCreateSession,
  onInputChange,
  getDraft,
  onAutoDeleteEmptySession,
  isReady = true,
  isSessionsReady = true,
  remoteWorkspaceId,
  defaultViewRoute = routes.view.writing(),
}: NavigationProviderProps) {
  const { t } = useTranslation()
  const [, setSession] = useSession()

  const updateSessionMeta = useSetAtom(updateSessionMetaAtom)

  const pushPanel = useSetAtom(pushPanelAtom)

  // Store reference for reading fresh atom values in callbacks (avoids stale closures)
  const store = useStore()
  const runtimeWorkspaceRouteRef = useRef(workspaceId)
  useEffect(() => {
    runtimeWorkspaceRouteRef.current = workspaceId
  }, [workspaceId])

  // Read sources from atom (populated by AppShell)
  const sources = useAtomValue(sourcesAtom)

  // Settings is orthogonal to the workspace panel stack. Keeping it here prevents
  // opening preferences from replacing (or auto-cleaning) the focused session.
  const [settingsSubpage, setSettingsSubpage] = useState<SettingsSubpage | null>(null)
  const settingsSubpageRef = useRef<SettingsSubpage | null>(settingsSubpage)
  const setSettingsOverlay = useCallback((subpage: SettingsSubpage | null) => {
    settingsSubpageRef.current = subpage
    setSettingsSubpage(subpage)
  }, [])

  // =========================================================================
  // DERIVED NAVIGATION STATE (from focused panel + right sidebar)
  // =========================================================================

  const focusedRoute = useAtomValue(focusedPanelRouteAtom)

  // Right sidebar is independent of panels (not per-panel state)
  const [rightSidebar, setRightSidebar] = useState<RightSidebarPanel | undefined>()
  const rightSidebarRef = useRef<RightSidebarPanel | undefined>(rightSidebar)
  useEffect(() => { rightSidebarRef.current = rightSidebar }, [rightSidebar])
  const setRightSidebarIfChanged = useCallback((panel: RightSidebarPanel | undefined) => {
    setRightSidebar(previous => areRightSidebarPanelsEqual(previous, panel) ? previous : panel)
  }, [])

  // NavigationState derived from the focused panel's route
  const navigationState: NavigationState = useMemo(() => {
    const base = focusedRoute
      ? parseRouteToNavigationState(focusedRoute) ?? DEFAULT_NAVIGATION_STATE
      : DEFAULT_NAVIGATION_STATE
    return rightSidebar ? { ...base, rightSidebar } : base
  }, [focusedRoute, rightSidebar])
  const navigationStateRef = useRef<NavigationState>(navigationState)
  navigationStateRef.current = navigationState

  // =========================================================================
  // BROWSER HISTORY TRACKING
  // =========================================================================

  const [, setCanGoBack] = useState(false)
  const [, setCanGoForward] = useState(false)

  // Sequence numbers stored in history.state for tracking position
  const historySeqRef = useRef(0)                // Current history position
  const historyMaxSeqRef = useRef(0)              // Highest pushed seq (for canGoForward)
  const nextHistorySeqRef = useRef(1)             // Next seq to assign on pushState

  // Suppress pushState in atom subscriptions during restore/reconciliation
  const suppressPushRef = useRef(false)

  // Coalesce compound atom writes (e.g. pushPanelAtom sets both panelStackAtom
  // and focusedPanelIdAtom) into a single pushState via microtask debounce
  const pendingPushRef = useRef(false)

  // Flag: workspace switch was triggered by popstate (URL already correct)
  const isPopstateSwitchRef = useRef(false)

  // Queue navigation if not ready yet
  const pendingNavigationRef = useRef<ParsedRoute | null>(null)

  // Suppress auto-select for one cycle (used by skipAutoSelect to prevent the effect from re-selecting)
  const suppressAutoSelectRef = useRef(false)

  // Track whether initial route restoration has been attempted
  const initialRouteRestoredRef = useRef(false)

  // Semantic key for the last history entry we intentionally pushed/reconciled.
  // Excludes layout-only values (like panel proportions) so resize does not create history entries.
  const lastSemanticHistoryKeyRef = useRef('')

  const updateCanGoBackForward = useCallback(() => {
    setCanGoBack(historySeqRef.current > 0)
    setCanGoForward(historySeqRef.current < historyMaxSeqRef.current)
  }, [])

  const getSemanticHistoryKey = useCallback(() => {
    const panels = store.get(panelStackAtom)
    const focusedIdx = store.get(focusedPanelIndexAtom)
    const sidebarKey = buildRightSidebarParam(rightSidebarRef.current) ?? ''
    return buildSemanticHistoryKey({
      workspaceSlug: workspaceRouteKey,
      panelRoutes: panels.map(p => p.route),
      focusedPanelIndex: focusedIdx,
      sidebarParam: sidebarKey,
    })
  }, [store, workspaceRouteKey])

  // =========================================================================
  // URL SYNC (builds URL from current state, push or replace)
  // =========================================================================

  /**
   * Build the current URL from atom state and either push or replace.
   *
   * push=true: creates a new browser history entry (meaningful navigation)
   * push=false: updates the current entry (resize, auto-select, etc.)
   *
   * Also persists the URL per-workspace in localStorage for workspace switch restoration.
   */
  const syncUrl = useCallback((push: boolean = false) => {
    const panels = store.get(panelStackAtom)
    const focusedIdx = store.get(focusedPanelIndexAtom)
    if (panels.length === 0) return

    const focusedPanel = panels[focusedIdx] ?? panels[0]
    const url = new URL(window.location.href)

    // ?ws= stable Host workspace ID
    if (workspaceRouteKey) {
      url.searchParams.set('ws', workspaceRouteKey)
    }

    // ?route= is the focused panel's route
    url.searchParams.set('route', focusedPanel.route)

    // ?panels= encodes ALL panels in stack order
    if (panels.length > 1) {
      const encoded = panels.map(p => `${p.route}:${p.proportion.toFixed(4)}`).join(',')
      url.searchParams.set('panels', encoded)
    } else {
      url.searchParams.delete('panels')
    }

    // ?fi= is focused panel index (for multi-panel layouts)
    if (panels.length > 1) {
      url.searchParams.set('fi', String(focusedIdx))
    } else {
      url.searchParams.delete('fi')
    }

    // ?sidebar=
    const sidebarParam = buildRightSidebarParam(rightSidebarRef.current)
    if (sidebarParam) {
      url.searchParams.set('sidebar', sidebarParam)
    } else {
      url.searchParams.delete('sidebar')
    }

    // Utility overlays keep their own URL state instead of becoming panel routes.
    if (settingsSubpageRef.current) {
      url.searchParams.set('settings', settingsSubpageRef.current)
    } else {
      url.searchParams.delete('settings')
    }

    const urlStr = url.toString()

    if (push) {
      const seq = nextHistorySeqRef.current++
      history.pushState({ seq }, '', urlStr)
      historySeqRef.current = seq
      historyMaxSeqRef.current = seq // Forward history discarded by browser
      updateCanGoBackForward()
    } else {
      history.replaceState({ ...history.state, seq: historySeqRef.current }, '', urlStr)
    }

    // Persist per-workspace URL for workspace switch restoration
    if (workspaceRouteKey) {
      storage.set(storage.KEYS.workspaceUrl, url.search, workspaceRouteKey)
    }
  }, [store, workspaceRouteKey, updateCanGoBackForward])

  const syncUrlRef = useRef(syncUrl)
  useEffect(() => { syncUrlRef.current = syncUrl }, [syncUrl])

  const maybePushHistoryForSemanticChange = useCallback(() => {
    const currentSemanticKey = getSemanticHistoryKey()
    if (currentSemanticKey === lastSemanticHistoryKeyRef.current) return

    syncUrlRef.current?.(true)
    lastSemanticHistoryKeyRef.current = currentSemanticKey
  }, [getSemanticHistoryKey])

  // replaceState sync when panel stack, focus, or sidebar changes (catches resize, etc.)
  const panelStack = useAtomValue(panelStackAtom)
  const focusedPanelId = useAtomValue(focusedPanelIdAtom)
  useEffect(() => {
    if (!initialRouteRestoredRef.current) return
    syncUrlRef.current(false)
  }, [panelStack, focusedPanelId, rightSidebar])

  // =========================================================================
  // ATOM SUBSCRIPTIONS FOR pushState (meaningful navigation)
  // =========================================================================

  // Panel stack changes: push history on add/remove/route change (NOT resize)
  useEffect(() => {
    let prevRoutes = store.get(panelStackAtom).map(p => p.route)
    const unsub = store.sub(panelStackAtom, () => {
      if (suppressPushRef.current || !initialRouteRestoredRef.current) return
      const currRoutes = store.get(panelStackAtom).map(p => p.route)
      if (currRoutes.length !== prevRoutes.length || !currRoutes.every((r, i) => r === prevRoutes[i])) {
        if (!pendingPushRef.current) {
          pendingPushRef.current = true
          queueMicrotask(() => { pendingPushRef.current = false; maybePushHistoryForSemanticChange() })
        }
      }
      prevRoutes = currRoutes
    })
    return unsub
  }, [store, maybePushHistoryForSemanticChange])

  // Focus changes: push history when active panel changes
  useEffect(() => {
    let prevFocusId = store.get(focusedPanelIdAtom)
    const unsub = store.sub(focusedPanelIdAtom, () => {
      if (suppressPushRef.current || !initialRouteRestoredRef.current) return
      const newFocusId = store.get(focusedPanelIdAtom)
      if (newFocusId !== prevFocusId) {
        if (!pendingPushRef.current) {
          pendingPushRef.current = true
          queueMicrotask(() => { pendingPushRef.current = false; maybePushHistoryForSemanticChange() })
        }
        prevFocusId = newFocusId
      }
    })
    return unsub
  }, [store, maybePushHistoryForSemanticChange])

  // Right sidebar changes: push history
  const prevSidebarTypeRef = useRef(rightSidebar?.type)
  useEffect(() => {
    if (rightSidebar?.type === prevSidebarTypeRef.current) return
    prevSidebarTypeRef.current = rightSidebar?.type
    if (suppressPushRef.current) return
    if (!initialRouteRestoredRef.current) return
    maybePushHistoryForSemanticChange()
  }, [rightSidebar, maybePushHistoryForSemanticChange])

  // =========================================================================
  // RECONCILE PANELS FROM URL PARAMS
  // =========================================================================

  /**
   * Parse URL search params and reconcile the panel stack + sidebar.
   * Uses reconcilePanelStackAtom for smart matching (preserves React keys).
   */
  const reconcileFromUrlParams = useCallback(
    (params: URLSearchParams) => {
      const initialRoute = params.get('route')
      const sidebarParam = params.get('sidebar') || undefined
      const panelsParam = params.get('panels')
      const focusedIndexParam = params.get('fi')
      const shouldSkipAutoSelect = shouldPreserveProjectLandingRoute(params)
      if (shouldSkipAutoSelect) {
        suppressAutoSelectRef.current = true
      }

      const resolveForReconcile = (state: NavigationState, options?: { skipAutoSelect?: boolean }) => {
        if (options?.skipAutoSelect) {
          return resolveAutoSelectionRef.current(state, { skipAutoSelect: true })
        }
        return resolveAutoSelectionRef.current(state)
      }

      const settingsParam = params.get('settings')
      setSettingsOverlay(
        settingsParam && isValidSettingsSubpage(settingsParam)
          ? settingsParam
          : null,
      )

      const normalizeRestoredPanelRoute = (rawRoute: ViewRoute): ViewRoute => {
        const state = parseRouteToNavigationState(rawRoute)
        if (state && isSettingsNavigation(state)) {
          setSettingsOverlay(state.subpage)
          return defaultViewRoute
        }
        return normalizePanelRouteForReconcile(
          rawRoute,
          resolveForReconcile,
          shouldSkipAutoSelect ? { skipAutoSelect: true } : undefined,
        )
      }

      // Restore right sidebar
      if (sidebarParam) {
        const parsed = parseRouteToNavigationState('allSessions', sidebarParam)
        if (parsed?.rightSidebar) {
          setRightSidebarIfChanged(parsed.rightSidebar)
        } else {
          setRightSidebarIfChanged(undefined)
        }
      } else {
        setRightSidebarIfChanged(undefined)
      }

      // Parse panel entries from URL
      let entries: { route: ViewRoute; proportion: number }[] = []
      let focusedIndex = 0

      if (panelsParam) {
        // Canonical format: ?panels= contains ALL panels, ?fi= is focused index.
        // We intentionally no longer support older mixed route/panels formats.
        entries = panelsParam.split(',').filter(Boolean).map(entry => {
          const colonIdx = entry.lastIndexOf(':')
          if (colonIdx > 0) {
            const proportion = parseFloat(entry.slice(colonIdx + 1))
            if (!isNaN(proportion) && proportion > 0 && proportion < 1) {
              const rawRoute = entry.slice(0, colonIdx) as ViewRoute
              const route = normalizeRestoredPanelRoute(rawRoute)
              return { route, proportion }
            }
          }
          const rawRoute = entry as ViewRoute
          const route = normalizeRestoredPanelRoute(rawRoute)
          return { route, proportion: 0 }
        })

        const hasProportions = entries.some(e => e.proportion > 0)
        if (!hasProportions) {
          const equal = 1 / entries.length
          entries.forEach(e => { e.proportion = equal })
        } else {
          const total = entries.reduce((s, e) => s + e.proportion, 0)
          if (total > 0 && Math.abs(total - 1) > 0.001) {
            entries.forEach(e => { e.proportion = e.proportion / total })
          }
        }

        focusedIndex = focusedIndexParam != null ? (parseInt(focusedIndexParam, 10) || 0) : 0
      } else if (initialRoute) {
        // Single panel from ?route=
        if (parseRouteToNavigationState(initialRoute)) {
          const finalRoute = normalizeRestoredPanelRoute(initialRoute as ViewRoute)
          entries = [{ route: finalRoute, proportion: 1 }]
        }
      }

      if (entries.length > 0) {
        store.set(reconcilePanelStackAtom, { entries, focusedIndex })
      }
    },
    [defaultViewRoute, setSettingsOverlay, setRightSidebarIfChanged, store]
  )

  // Keep ref fresh for use in event handlers / effects that capture stale closures
  const reconcileFromUrlParamsRef = useRef(reconcileFromUrlParams)
  useEffect(() => { reconcileFromUrlParamsRef.current = reconcileFromUrlParams }, [reconcileFromUrlParams])

  // =========================================================================
  // EMPTY SESSION CLEANUP (reactive — covers navigate, close tab, etc.)
  // =========================================================================

  // Track which session IDs are visible across all panels. When a session ID
  // disappears (navigate away, close tab, Cmd+W), check if it was empty and
  // auto-delete it. This is the single codepath for all navigate-away cleanup.
  const prevVisibleSessionIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const currentIds = new Set<string>()
    for (const entry of panelStack) {
      const sessionId = parseSessionIdFromRoute(entry.route)
      if (sessionId) currentIds.add(sessionId)
    }

    // Only check after we've seen at least one set of IDs
    // (skip first render to avoid false positives during initialization)
    if (onAutoDeleteEmptySession && prevVisibleSessionIdsRef.current.size > 0) {
      for (const prevId of prevVisibleSessionIdsRef.current) {
        if (!currentIds.has(prevId)) {
          const meta = store.get(sessionMetaMapAtom).get(prevId)
          const isEmpty = meta && !meta.lastFinalMessageId && !meta.name && !meta.isProcessing
          const hasDraft = getDraft?.(prevId)?.trim()
          if (isEmpty && !hasDraft) {
            onAutoDeleteEmptySession(prevId)
          }
        }
      }
    }

    prevVisibleSessionIdsRef.current = currentIds
  }, [panelStack, onAutoDeleteEmptySession, store, getDraft])

  // =========================================================================
  // SESSION SELECTION SYNC
  // =========================================================================

  // Keep the global session selection in sync with the focused panel
  useEffect(() => {
    if (isSessionsNavigation(navigationState) && navigationState.details) {
      const selectedSessionMeta = store.get(sessionMetaMapAtom).get(navigationState.details.sessionId)
      const selectedSessionMatchesWorkspace = !workspaceId || (
        selectedSessionMeta?.workspaceId === workspaceId
        || (!!remoteWorkspaceId && selectedSessionMeta?.workspaceId === remoteWorkspaceId)
      )
      if (!selectedSessionMatchesWorkspace) return

      setSession({ selected: navigationState.details.sessionId })
      if (workspaceId) {
        if (selectedSessionMeta?.workspaceId === workspaceId || (!!remoteWorkspaceId && selectedSessionMeta?.workspaceId === remoteWorkspaceId)) {
          storage.set(storage.KEYS.lastSelectedSessionId, navigationState.details.sessionId, workspaceId)
        }
      }
    }
  }, [navigationState, setSession, workspaceId, remoteWorkspaceId, store])

  // =========================================================================
  // HELPERS
  // =========================================================================

  // Helper: Match sessions by SessionFilter without materializing filtered arrays.
  // Always excludes hidden sessions - they should never appear in navigation.
  const doesSessionMatchFilter = useCallback(
    (session: SessionMeta | undefined, filter: SessionFilter): session is SessionMeta => {
      if (!session) return false
      if (session.hidden) return false
      if (workspaceId && session.workspaceId !== workspaceId) return false

      switch (filter.kind) {
        case 'allSessions':
          return session.isArchived !== true
        case 'flagged':
          return session.isFlagged === true && session.isArchived !== true
        case 'archived':
          return session.isArchived === true
        case 'state':
          return session.sessionStatus === filter.stateId && session.isArchived !== true
        case 'label': {
          if (session.isArchived === true) return false
          if (!session.labels?.length) return false
          if (filter.labelId === '__all__') return true
          return session.labels.some(l => l === filter.labelId || l.startsWith(`${filter.labelId}::`))
        }
        case 'view':
          if (session.isArchived === true) return false
          return true
        default:
          return false
      }
    },
    [workspaceId]
  )

  const getFirstSessionId = useCallback(
    (filter: SessionFilter): string | null => {
      const sessionMetaMap = store.get(sessionMetaMapAtom)
      for (const session of sessionMetaMap.values()) {
        if (doesSessionMatchFilter(session, filter)) {
          return session.id
        }
      }
      return null
    },
    [doesSessionMatchFilter, store]
  )

  const getLastSelectedSessionId = useCallback(
    (filter: SessionFilter): string | null => {
      if (!workspaceId) return null
      const storedId = storage.get<string | null>(
        storage.KEYS.lastSelectedSessionId,
        null,
        workspaceId
      )
      if (!storedId) return null
      const sessionMetaMap = store.get(sessionMetaMapAtom)
      const session = sessionMetaMap.get(storedId)
      return doesSessionMatchFilter(session, filter) ? storedId : null
    },
    [doesSessionMatchFilter, store, workspaceId]
  )

  const getFirstSourceSlug = useCallback(
    (filter?: SourceFilter | null): string | null => {
      if (!filter) {
        return sources[0]?.config.slug ?? null
      }
      const filtered = sources.filter(s => s.config.type === filter.sourceType)
      return filtered[0]?.config.slug ?? null
    },
    [sources]
  )

  // =========================================================================
  // AUTO-SELECTION (pure computation, no side effects)
  // =========================================================================

  /**
   * Resolve auto-selection for a NavigationState.
   * When navigating to a filter without explicit details, auto-select the
   * first available item. Returns the final state (no side effects).
   */
  const resolveAutoSelection = useCallback(
    (newState: NavigationState, options?: { skipAutoSelect?: boolean }): NavigationState => {
      let nextState = newState

      // Validate session exists in current workspace (local or remote ID)
      if (isSessionsNavigation(nextState) && nextState.details) {
        const freshMetaMap = store.get(sessionMetaMapAtom)
        const meta = freshMetaMap.get(nextState.details.sessionId)
        const matchesWorkspace = !workspaceId
          || meta?.workspaceId === workspaceId
          || (remoteWorkspaceId && meta?.workspaceId === remoteWorkspaceId)
        if (!meta || !matchesWorkspace) {
          nextState = { ...nextState, details: null }
        }
      }

      // Sessions: auto-select last/first session
      if (isSessionsNavigation(nextState) && !nextState.details && !options?.skipAutoSelect) {
        const lastSelectedSessionId = getLastSelectedSessionId(nextState.filter)
        const fallbackSessionId = lastSelectedSessionId ?? getFirstSessionId(nextState.filter)
        if (fallbackSessionId) {
          return { ...nextState, details: { type: 'session', sessionId: fallbackSessionId } }
        }
        return nextState
      }

      // Sources: auto-select first source
      if (isSourcesNavigation(nextState) && !nextState.details && !options?.skipAutoSelect) {
        const firstSourceSlug = getFirstSourceSlug(nextState.filter)
        if (firstSourceSlug) {
          return { ...nextState, details: { type: 'source', sourceSlug: firstSourceSlug } }
        }
        return nextState
      }

      return nextState
    },
    [store, workspaceId, remoteWorkspaceId, getLastSelectedSessionId, getFirstSessionId, getFirstSourceSlug]
  )

  // Ref keeps resolveAutoSelection fresh for reconcileFromUrlParams (defined earlier in the file)
  const resolveAutoSelectionRef = useRef(resolveAutoSelection)
  useEffect(() => { resolveAutoSelectionRef.current = resolveAutoSelection }, [resolveAutoSelection])

  // =========================================================================
  // ACTION NAVIGATION
  // =========================================================================

  const handleActionNavigation = useCallback(
    async (parsed: ParsedRoute, options?: { newPanel?: boolean }) => {
      if (!workspaceId) return

      switch (parsed.name) {
        case 'new-session': {
          const createOptions: import('../../shared/types').CreateSessionOptions = {}
          if (parsed.params.mode) {
            const parsedMode = parsePermissionMode(parsed.params.mode)
            if (parsedMode) {
              createOptions.permissionMode = parsedMode
            }
          }
          if (parsed.params.workdir) {
            createOptions.workingDirectory = parsed.params.workdir as 'user_default' | 'none' | string
          }
          if (parsed.params.model) {
            createOptions.model = parsed.params.model
          }
          if (parsed.params.systemPrompt) {
            createOptions.systemPromptPreset = parsed.params.systemPrompt as 'default' | 'mini' | string
          }
          const session = await onCreateSession(workspaceId, createOptions)

          if (parsed.params.name) {
            await window.electronAPI.sessionCommand(session.id, { type: 'rename', name: parsed.params.name })
          }

          if (parsed.params.status) {
            updateSessionMeta(session.id, { sessionStatus: parsed.params.status })
          }
          if (parsed.params.label) {
            updateSessionMeta(session.id, { labels: [parsed.params.label] })
          }

          if (parsed.params.status) {
            await window.electronAPI.sessionCommand(session.id, { type: 'setSessionStatus', state: parsed.params.status })
          }
          if (parsed.params.label) {
            await window.electronAPI.sessionCommand(session.id, { type: 'setLabels', labels: [parsed.params.label] })
          }

          // Determine navigation filter
          const filter: import('../../shared/types').SessionFilter =
            parsed.params.status ? { kind: 'state', stateId: parsed.params.status } :
            parsed.params.label ? { kind: 'label', labelId: parsed.params.label } :
            { kind: 'allSessions' }

          if (options?.newPanel) {
            // Open the new session in a new panel (pushPanel auto-focuses it)
            pushPanel({
              route: routes.view.allSessions(session.id) as ViewRoute,
            })
          } else {
            // Navigate the focused panel to the new session
            const newState: NavigationState = {
              navigator: 'sessions',
              filter,
              details: { type: 'session', sessionId: session.id },
            }
            const route = buildRouteFromNavigationState(newState) as ViewRoute
            store.set(updateFocusedPanelRouteAtom, route)
            // Session selection sync handled by effect
          }

          // Parse badges from params
          let badges: ContentBadge[] | undefined
          if (parsed.params.badges) {
            try {
              badges = JSON.parse(parsed.params.badges) as ContentBadge[]
            } catch (e) {
              console.warn('[Navigation] Failed to parse badges param:', e)
            }
          }

          // Handle input: either auto-send or pre-fill
          if (parsed.params.input) {
            const shouldSend = parsed.params.send === 'true'
            if (shouldSend) {
              setTimeout(() => {
                window.electronAPI.sendMessage(
                  session.id,
                  parsed.params.input!,
                  undefined,
                  undefined,
                  badges ? { badges } : undefined
                )
              }, 100)
            } else if (onInputChange) {
              const text = parsed.params.input
              onInputChange(session.id, text)
              window.dispatchEvent(new CustomEvent('craft:restore-input', {
                detail: { sessionId: session.id, text },
              }))
            }
          }
          break
        }

        case 'rename-session':
          if (parsed.id && parsed.params.name) {
            await window.electronAPI.sessionCommand(parsed.id, { type: 'rename', name: parsed.params.name })
          }
          break

        case 'delete-session':
          if (parsed.id) {
            await window.electronAPI.deleteSession(parsed.id)
          }
          break

        case 'flag-session':
          if (parsed.id) {
            await window.electronAPI.sessionCommand(parsed.id, { type: 'flag' })
          }
          break

        case 'unflag-session':
          if (parsed.id) {
            await window.electronAPI.sessionCommand(parsed.id, { type: 'unflag' })
          }
          break

        case 'oauth':
          if (parsed.id) {
            await window.electronAPI.performOAuth({ sourceSlug: parsed.id })
          }
          break

        case 'delete-source':
          if (parsed.id) {
            await window.electronAPI.deleteSource(workspaceId, parsed.id)
          }
          break

        case 'set-mode':
          if (parsed.id && parsed.params.mode) {
            const parsedMode = parsePermissionMode(parsed.params.mode)
            if (!parsedMode) {
              console.warn('[Navigation] Invalid permission mode:', parsed.params.mode)
              break
            }
            await window.electronAPI.sessionCommand(
              parsed.id,
              { type: 'setPermissionMode', mode: parsedMode }
            )
          }
          break

        case 'copy':
          if (parsed.params.text) {
            await navigator.clipboard.writeText(parsed.params.text)
          }
          break

        case 'install-skill': {
          const { slug, version, sha256 } = parsed.params
          const targetRuntimeWorkspaceId = workspaceId
          if (!slug || !version || !sha256 || !targetRuntimeWorkspaceId) {
            toast.error(t('toast.invalidLink'), { description: t('skillsMarket.invalidLink') })
            break
          }
          const toastId = toast.loading(t('skillsMarket.validating', { slug }))
          try {
            const downloaded = await downloadMarketSkillBundle({ slug, version, sha256 })
            toast.info(t('skillsMarket.ready', { slug }), {
              id: toastId,
              description: t('skillsMarket.readyDescription', {
                version,
                sha256: downloaded.sha256.slice(0, 12),
              }),
              duration: 20_000,
              action: {
                label: t('skillsMarket.confirm'),
                onClick: () => {
                  if (runtimeWorkspaceRouteRef.current !== targetRuntimeWorkspaceId) {
                    toast.error(t('skillsMarket.runtimeChanged'))
                    return
                  }
                  const importToastId = toast.loading(t('skillsMarket.importing', { slug }))
                  void window.electronAPI.importResources(
                    targetRuntimeWorkspaceId,
                    downloaded.bundle,
                    'skip',
                    {
                      skillScope: 'project',
                      installArtifact: { slug, version, sha256: downloaded.sha256, raw: downloaded.raw },
                    },
                  )
                    .then(result => {
                      const bucket = result.skills
                      if (bucket.imported.includes(slug)) {
                        toast.success(t('skillsMarket.imported', { slug }), { id: importToastId })
                      } else if (bucket.skipped.includes(slug)) {
                        toast.info(t('skillsMarket.exists', { slug }), { id: importToastId })
                      } else {
                        const reason = bucket.failed.find(item => item.id === slug)?.error
                        toast.error(t('skillsMarket.importFailed', { slug }), { id: importToastId, description: reason })
                      }
                    })
                    .catch(error => {
                      toast.error(t('skillsMarket.importFailed', { slug }), {
                        id: importToastId,
                        description: error instanceof Error ? error.message : String(error),
                      })
                    })
                },
              },
            })
          } catch (error) {
            toast.error(t('skillsMarket.validationFailed', { slug }), {
              id: toastId,
              description: error instanceof Error ? error.message : String(error),
            })
          }
          break
        }

        default:
          console.warn('[Navigation] Unknown action:', parsed.name)
      }
    },
    [workspaceId, onCreateSession, onInputChange, pushPanel, store, t, updateSessionMeta]
  )

  // =========================================================================
  // NAVIGATE
  // =========================================================================

  const navigate = useCallback(
    async (route: Route, options?: NavigateOptions) => {
      // Reset auto-select suppression on any normal navigation
      if (!options?.skipAutoSelect) {
        suppressAutoSelectRef.current = false
      }

      const parsed = parseRoute(route)
      if (!parsed) {
        console.warn('[Navigation] Invalid route:', route)
        return
      }

      if (!isReady) {
        pendingNavigationRef.current = parsed
        return
      }

      // Handle actions (side effects)
      if (parsed.type === 'action') {
        await handleActionNavigation(parsed, options)
        return
      }

      // Settings is a utility overlay. Resolve and persist its subpage without
      // mutating the focused panel route or its session lifecycle.
      let newNavState = parseRouteToNavigationState(route)
      if (newNavState && isSettingsNavigation(newNavState)) {
        const isBareSettingsRoute = route === 'settings'
        if (isBareSettingsRoute) {
          const savedSubpage = storage.get<string>(storage.KEYS.lastSettingsSubpage, 'app')
          if (isValidSettingsSubpage(savedSubpage)) {
            newNavState = { ...newNavState, subpage: savedSubpage }
          }
        } else {
          storage.set(storage.KEYS.lastSettingsSubpage, newNavState.subpage)
        }
        setSettingsOverlay(newNavState.subpage)
        queueMicrotask(() => syncUrlRef.current(false))
        return
      }

      if (settingsSubpageRef.current) {
        setSettingsOverlay(null)
      }

      // For view routes with newPanel, append a panel and focus it.
      if (options?.newPanel) {
        pushPanel({
          route: route as ViewRoute,
        })
        return
      }

      // Suppress auto-select effect
      if (options?.skipAutoSelect) {
        suppressAutoSelectRef.current = true
      }

      if (newNavState) {
        // Resolve auto-selection (pure — no side effects)
        const resolvedState = resolveAutoSelection(newNavState, options)
        const finalRoute = buildRouteFromNavigationState(resolvedState) as ViewRoute

        // Persist last selected session for auto-select on next visit
        if (isSessionsNavigation(resolvedState) && resolvedState.details && workspaceId) {
          storage.set(storage.KEYS.lastSelectedSessionId, resolvedState.details.sessionId, workspaceId)
        }

        // Update the focused panel's route (atom update is synchronous)
        // The panelStack atom subscription detects the route change and calls syncUrl(true)
        store.set(updateFocusedPanelRouteAtom, finalRoute)
      }
    },
    [handleActionNavigation, isReady, pushPanel, resolveAutoSelection, setSettingsOverlay, store, workspaceId]
  )

  const closeSettings = useCallback(() => {
    if (!settingsSubpageRef.current) return
    setSettingsOverlay(null)
    queueMicrotask(() => syncUrlRef.current(false))
  }, [setSettingsOverlay])

  // =========================================================================
  // BACK / FORWARD (browser history)
  // =========================================================================

  const goBack = useCallback(() => {
    history.back()
  }, [])

  const goForward = useCallback(() => {
    history.forward()
  }, [])

  // =========================================================================
  // POPSTATE HANDLER (browser back/forward)
  // =========================================================================

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      // Update sequence tracking
      const eventSeq = event.state?.seq ?? 0
      historySeqRef.current = eventSeq
      updateCanGoBackForward()

      // Read state from URL (the browser already navigated to it)
      const params = new URLSearchParams(window.location.search)
      const workspaceRouteKeyFromUrl = params.get('ws')

      // Check if workspace changed
      if (workspaceRouteKeyFromUrl && workspaceRouteKeyFromUrl !== workspaceRouteKey && onSwitchWorkspaceByRouteKey) {
        // Workspace boundary crossed — trigger workspace switch
        // The workspace switch effect will handle reconciliation
        if (onSwitchWorkspaceByRouteKey(workspaceRouteKeyFromUrl)) {
          isPopstateSwitchRef.current = true
        } else {
          // The historical Project no longer exists. Keep runtime and URL on the
          // current stable Project instead of poisoning the next UI switch.
          isPopstateSwitchRef.current = false
          syncUrlRef.current(false)
          lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
        }
        return
      }

      if (!isSessionsReady) {
        // Session metadata is not initialized yet; initial restore will reconcile
        // current URL state once metadata is available.
        return
      }

      // Same workspace — reconcile panels from the URL
      suppressPushRef.current = true
      reconcileFromUrlParamsRef.current(params)
      lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
      requestAnimationFrame(() => {
        suppressPushRef.current = false
      })
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [workspaceRouteKey, onSwitchWorkspaceByRouteKey, updateCanGoBackForward, getSemanticHistoryKey, isSessionsReady])

  // =========================================================================
  // WORKSPACE SWITCH
  // =========================================================================

  const previousWorkspaceRouteKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!workspaceId || !workspaceRouteKey) return

    if (previousWorkspaceRouteKeyRef.current === null) {
      // First mount — initial route restoration handles it
      previousWorkspaceRouteKeyRef.current = workspaceRouteKey
      return
    }

    if (previousWorkspaceRouteKeyRef.current === workspaceRouteKey) return

    if (isPopstateSwitchRef.current && !isSessionsReady) return
    previousWorkspaceRouteKeyRef.current = workspaceRouteKey

    // Suppress pushState during reconciliation
    suppressPushRef.current = true

    if (isPopstateSwitchRef.current) {
      // Popstate-triggered: URL is already correct, just reconcile from it
      isPopstateSwitchRef.current = false
      reconcileFromUrlParamsRef.current(new URLSearchParams(window.location.search))
      lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
    } else {
      // UI-triggered: load stored URL for the new workspace, push history entry
      const url = new URL(window.location.href)
      // Opening a project is a product-level navigation event. It always lands
      // on the writing surface; session history restoration is an independent
      // Agent concern and must not take ownership of the project entry route.
      for (const key of [...url.searchParams.keys()]) {
        url.searchParams.delete(key)
      }
      url.searchParams.set('ws', workspaceRouteKey)
      url.searchParams.set('route', 'writing')

      // Push a new history entry for the workspace switch
      const seq = nextHistorySeqRef.current++
      history.pushState({ seq }, '', url.toString())
      historySeqRef.current = seq
      historyMaxSeqRef.current = seq
      updateCanGoBackForward()

      // Reconcile panels from the new URL
      reconcileFromUrlParamsRef.current(new URLSearchParams(url.search))
      lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
    }

    initialRouteRestoredRef.current = true

    requestAnimationFrame(() => {
      suppressPushRef.current = false
      lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
    })
  }, [workspaceId, workspaceRouteKey, store, updateCanGoBackForward, getSemanticHistoryKey, isSessionsReady])

  // =========================================================================
  // INITIAL ROUTE RESTORATION (CMD+R reload)
  // =========================================================================

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const route = params.get('route')
    const panels = params.get('panels')
    const routePrefix = route?.split('/')[0]
    const sessionRoutePrefixes = new Set(['allSessions', 'flagged', 'archived', 'state', 'label', 'view'])
    const requiresSessions = Boolean(
      panels?.includes('/session/')
      || (routePrefix && sessionRoutePrefixes.has(routePrefix) && route !== 'allSessions')
    )
    if (!canRunInitialRestore({
      isReady,
      isSessionsReady,
      requiresSessions,
      workspaceId,
      initialRouteRestored: initialRouteRestoredRef.current,
    })) return
    initialRouteRestoredRef.current = true

    // Suppress pushState during initial restoration
    suppressPushRef.current = true

    // Reconcile panels + sidebar from current URL
    reconcileFromUrlParamsRef.current(params)
    lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()

    // If nothing was in the URL, navigate to default
    if (shouldDefaultInitialRouteToWriting(params)) {
      navigate(defaultViewRoute)
    }

    // Initialize history with seq=0 (replaceState so we don't create an extra entry)
    history.replaceState({ seq: 0 }, '', window.location.href)
    historySeqRef.current = 0
    historyMaxSeqRef.current = 0

    requestAnimationFrame(() => {
      suppressPushRef.current = false
      lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
    })
  }, [defaultViewRoute, isReady, isSessionsReady, workspaceId, navigate, store, getSemanticHistoryKey])

  // =========================================================================
  // PENDING NAVIGATION
  // =========================================================================

  useEffect(() => {
    if (isReady && pendingNavigationRef.current) {
      const pending = pendingNavigationRef.current
      pendingNavigationRef.current = null

      if (pending.type === 'action') {
        handleActionNavigation(pending)
        return
      }

      const routeStr = `${pending.name}${pending.id ? `/${pending.id}` : ''}`
      const navState = parseRouteToNavigationState(routeStr)
      if (navState) {
        if (isSettingsNavigation(navState)) {
          void navigate(routeStr as Route)
          return
        }
        const resolved = resolveAutoSelection(navState)
        const finalRoute = buildRouteFromNavigationState(resolved) as ViewRoute
        store.set(updateFocusedPanelRouteAtom, finalRoute)
      }
    }
  }, [isReady, handleActionNavigation, navigate, resolveAutoSelection, store])

  // =========================================================================
  // DEEP LINK LISTENER
  // =========================================================================

  useEffect(() => {
    if (!workspaceId) return

    const cleanup = window.electronAPI.onDeepLinkNavigate((nav: DeepLinkNavigation) => {
      let route: string | null = null

      if (nav.view) {
        route = nav.view
      } else if (nav.action) {
        route = `action/${nav.action}`
        if (nav.actionParams?.id) {
          route += `/${nav.actionParams.id}`
        }
        const otherParams = { ...nav.actionParams }
        delete otherParams.id
        if (Object.keys(otherParams).length > 0) {
          const params = new URLSearchParams(otherParams)
          route += `?${params.toString()}`
        }
      }

      if (route) {
        const navState = parseRouteToNavigationState(route)
        if (!navState && !route.startsWith('action/')) {
          toast.error(t('toast.invalidLink'), {
            description: t('toast.invalidLinkDesc'),
          })
          return
        }
        navigate(route as Route)
      }
    })

    return cleanup
  }, [workspaceId, navigate])

  // =========================================================================
  // INTERNAL NAVIGATION EVENT LISTENER
  // =========================================================================

  useEffect(() => {
    const handleNavigateEvent = (event: Event) => {
      const customEvent = event as CustomEvent<{ route: Route; newPanel?: boolean }>
      if (customEvent.detail?.route) {
        const { route: r, newPanel } = customEvent.detail
        navigate(r, newPanel ? { newPanel } : undefined)
      }
    }

    window.addEventListener(NAVIGATE_EVENT, handleNavigateEvent)
    return () => {
      window.removeEventListener(NAVIGATE_EVENT, handleNavigateEvent)
    }
  }, [navigate])

  // =========================================================================
  // SIDEBAR HELPERS
  // =========================================================================

  const updateRightSidebar = useCallback((panel: RightSidebarPanel | undefined) => {
    setRightSidebarIfChanged(panel)
    // pushState handled by the rightSidebar change effect
  }, [setRightSidebarIfChanged])

  const toggleRightSidebar = useCallback((panel?: RightSidebarPanel) => {
    const currentSidebar = rightSidebarRef.current
    const newPanel = panel || (currentSidebar && currentSidebar.type !== 'none'
      ? { type: 'none' as const }
      : { type: 'none' as const })
    updateRightSidebar(newPanel)
  }, [updateRightSidebar])

  // =========================================================================
  // PRESERVE-FILTER NAVIGATION HELPERS
  // =========================================================================

  const navigateToSource = useCallback((sourceSlug?: string) => {
    const currentNavigationState = navigationStateRef.current
    if (isSourcesNavigation(currentNavigationState) && currentNavigationState.filter?.kind === 'type') {
      switch (currentNavigationState.filter.sourceType) {
        case 'api':
          navigate(routes.view.sourcesApi(sourceSlug))
          return
        case 'mcp':
          navigate(routes.view.sourcesMcp(sourceSlug))
          return
        case 'local':
          navigate(routes.view.sourcesLocal(sourceSlug))
          return
      }
    }
    navigate(routes.view.sources(sourceSlug ? { sourceSlug } : undefined))
  }, [navigate])

  const navigateToSession = useCallback((sessionId: string) => {
    const currentNavigationState = navigationStateRef.current
    if (!isSessionsNavigation(currentNavigationState)) {
      navigate(routes.view.allSessions(sessionId))
      return
    }

    const filter = currentNavigationState.filter
    switch (filter.kind) {
      case 'allSessions':
        navigate(routes.view.allSessions(sessionId))
        break
      case 'flagged':
        navigate(routes.view.flagged(sessionId))
        break
      case 'archived':
        navigate(routes.view.archived(sessionId))
        break
      case 'state':
        navigate(routes.view.state(filter.stateId, sessionId))
        break
      case 'label':
        navigate(routes.view.label(filter.labelId, sessionId))
        break
      case 'view':
        navigate(routes.view.view(filter.viewId, sessionId))
        break
      default:
        navigate(routes.view.allSessions(sessionId))
    }
  }, [navigate])

  // =========================================================================
  // STALE SESSION PANEL ROUTE RECONCILIATION
  // =========================================================================

  useEffect(() => {
    if (!isReady || !isSessionsReady || !workspaceId) return
    if (panelStack.length === 0) return

    let changed = false
    const entries = panelStack.map((entry) => {
      const navState = parseRouteToNavigationState(entry.route)
      if (!navState || !isSessionsNavigation(navState) || !navState.details) {
        return { route: entry.route, proportion: entry.proportion }
      }

      const resolved = resolveAutoSelection(navState)
      const route = buildRouteFromNavigationState(resolved) as ViewRoute
      if (route !== entry.route) {
        changed = true
      }
      return { route, proportion: entry.proportion }
    })

    if (!changed) return

    const focusedIndex = Math.max(
      0,
      panelStack.findIndex((entry) => entry.id === store.get(focusedPanelIdAtom))
    )

    suppressPushRef.current = true
    store.set(reconcilePanelStackAtom, { entries, focusedIndex })
    syncUrlRef.current(false)
    lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
    requestAnimationFrame(() => {
      suppressPushRef.current = false
      lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
    })
  }, [isReady, isSessionsReady, workspaceId, panelStack, resolveAutoSelection, store, getSemanticHistoryKey])

  // =========================================================================
  // AUTO-SELECT ON SESSION LOAD
  // =========================================================================

  useEffect(() => {
    if (suppressAutoSelectRef.current) return
    if (!isReady || !isSessionsReady || !workspaceId) return
    // Don't auto-select when panel stack is empty (user closed all panels)
    if (store.get(panelStackAtom).length === 0) return
    if (!isSessionsNavigation(navigationState) || navigationState.details) return

    const lastSelectedSessionId = getLastSelectedSessionId(navigationState.filter)
    const fallbackSessionId = lastSelectedSessionId ?? getFirstSessionId(navigationState.filter)
    if (!fallbackSessionId) return

    navigateToSession(fallbackSessionId)
  }, [
    isReady,
    isSessionsReady,
    workspaceId,
    navigationState,
    getLastSelectedSessionId,
    getFirstSessionId,
    navigateToSession,
    store,
  ])

  const actionsValue = useMemo<NavigationActionsContextValue>(() => ({
    navigate,
    settingsSubpage,
    closeSettings,
    goBack,
    goForward,
    updateRightSidebar,
    toggleRightSidebar,
    navigateToSource,
    navigateToSession,
  }), [
    navigate,
    settingsSubpage,
    closeSettings,
    goBack,
    goForward,
    updateRightSidebar,
    toggleRightSidebar,
    navigateToSource,
    navigateToSession,
  ])

  return (
    <NavigationActionsContext.Provider value={actionsValue}>
      <NavigationStateContext.Provider value={navigationState}>
        {children}
      </NavigationStateContext.Provider>
    </NavigationActionsContext.Provider>
  )
}

export function useNavigationActions() {
  const context = useContext(NavigationActionsContext)
  if (!context) {
    throw new Error('useNavigationActions must be used within NavigationProvider')
  }
  return context
}

/**
 * Hook to access just the navigation state
 */
export function useNavigationState(): NavigationState {
  const navigationState = useContext(NavigationStateContext)
  if (!navigationState) {
    throw new Error('useNavigationState must be used within NavigationProvider')
  }
  return navigationState
}
