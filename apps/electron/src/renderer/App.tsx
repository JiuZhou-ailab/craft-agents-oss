// input: Electron preload API, persisted app/workspace/session state, and renderer navigation events
// output: Top-level renderer state orchestration, account settings data, and AppShell context wiring
// pos: Root renderer application component

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/hooks/useTheme'
import type { ThemeOverrides } from '@config/theme'
import { useSetAtom, useStore, useAtomValue, useAtom } from 'jotai'
import type { Session, Workspace, SessionEvent, Message, FileAttachment, StoredAttachment, CredentialResponse, SessionStatus, NewChatActionParams, ContentBadge, PermissionModeState, SendMessageOptions, ClientAuthState, SettingsSubpage, WhatsNewManifest } from '../shared/types'
import type { SessionDraft, DraftAttachmentRef } from '@craft-agent/shared/config'
import type { SessionOptionUpdates } from './hooks/useSessionOptions'
import { defaultSessionOptions, sessionOptionsAtom, updateSessionOptionsMap, initializeSessionOptionsMap } from './hooks/useSessionOptions'
import {
  FREE_CONVERSATION_WORKSPACE_ID,
  FREE_CONVERSATION_WORKSPACE_SLUG,
  generateMessageId,
} from '../shared/types'
import { useEventProcessor } from './event-processor'
import type { AgentEvent, Effect } from './event-processor'
import { AccountSettingsProvider, type AppShellContextType } from '@/context/AppShellContext'
import { ActivityRailFrame } from '@/components/app-shell/ActivityRailFrame'
import { getWhatsNewStartupAction } from '@/components/app-shell/whats-new-announcement'
import {
  ProjectHubNavigationActions,
  useProjectHubReturnLocation,
} from '@/components/project-hub'
import { ResetConfirmationDialog } from '@/components/ResetConfirmationDialog'
import { SplashScreen } from '@/components/SplashScreen'
import { TooltipProvider } from '@craft-agent/ui/tooltip'
import { FocusProvider } from '@/context/FocusContext'
import { ModalProvider } from '@/context/ModalContext'
import { DismissibleLayerProvider } from '@/context/DismissibleLayerContext'
import { useWindowCloseHandler } from '@/hooks/useWindowCloseHandler'
import { useNotifications } from '@/hooks/useNotifications'
import { useSession } from '@/hooks/useSession'
import { NavigationProvider } from '@/contexts/NavigationContext'
import { GLOBAL_SETTINGS_SUBPAGES, SettingsDialog } from '@/pages/settings/SettingsNavigator'
import { navigate, routes, type Route } from './lib/navigate'
import { attachmentFromContentRef, toDraftRef } from './lib/drafts'
import { stripMarkdown } from './utils/text'
import { coerceInputText } from './lib/input-text'
import { getSessionsToRefreshAfterStaleReconnect } from './lib/reconnect-recovery'
import {
  formatSessionLoadFailure,
  shouldApplyCreatedSessionSnapshot,
  shouldAutoCreateBaseSession,
  shouldTreatSessionLoadFailureAsTransportFallback,
} from './lib/session-load'
import { resolvePostSetupAppState, selectStartupWorkspaceId } from './lib/startup-flow'

import { isProjectShellReady } from './lib/app-readiness'
import { appendUniqueRequestForSession, removeFirstRequestForSession } from './lib/request-queue'
import { DEFAULT_THINKING_LEVEL } from '@craft-agent/shared/agent/thinking-levels'
import {
  isManagedLlmConnectionSlug,
  resolveEffectiveConnectionSlug,
} from '@config/llm-connections'
import { initRendererPerf } from './lib/perf'
import {
  initializeSessionsAtom,
  addSessionAtom,
  removeSessionAtom,
  updateSessionAtom,
  replaceLoadedSessionAtom,
  refreshSessionsMetadataAtom,
  sessionAtomFamily,
  sessionMetaMapAtom,
  sessionMetadataReadyAtom,
  sessionIdsAtom,
  loadedSessionsAtom,
  forceSessionMessagesReloadAtom,
  reconcileCurrentSessionTranscriptWorkingSetAtom,
  windowWorkspaceIdAtom,
  windowRuntimeWorkspaceAtom,
  windowWorkspacesAtom,
  type SessionMeta,
} from '@/atoms/sessions'
import {
  beginSessionStatusMutation,
  commitOptimisticSessionStatus,
  invalidateSessionStatusMutation,
  ownsSessionStatusMutation,
} from '@/atoms/session-status-transition'
import { focusedPanelRouteAtom, parseSessionIdFromRoute } from '@/atoms/panel-stack'
import { pendingCredentialsAtom, pendingPermissionsAtom, pendingUserQuestionsAtom } from '@/atoms/pending-requests'
import { sourcesAtom } from '@/atoms/sources'
import { skillsAtom } from '@/atoms/skills'
import { llmConnectionsAtom, refreshLlmConnectionsAtom, workspaceDefaultLlmConnectionAtom } from '@/atoms/llm-connections'
import { extractBadges } from '@/lib/mentions'
import { PlatformProvider } from '@craft-agent/ui/context'
import { useLinkInterceptor } from '@/hooks/useLinkInterceptor'
import { useTransportConnectionState } from '@/hooks/useTransportConnectionState'
import { useStaleSessionRecovery } from '@/hooks/useStaleSessionRecovery'
import { TransportConnectionBanner, shouldShowTransportConnectionBanner } from '@/components/app-shell/TransportConnectionBanner'
import { getFileManagerName, getPathBasename } from '@/lib/platform'
import { rendererLog } from '@/lib/logger'
import { ActionRegistryProvider } from '@/actions'
import { toast } from 'sonner'
import * as storage from '@/lib/local-storage'
import { findWorkspaceByRouteKey } from '@/lib/workspace-route'

let workspaceSurfaceModulePromise: Promise<typeof import('@/components/workspace/WorkspaceSurface')> | null = null

function loadWorkspaceSurfaceModule() {
  workspaceSurfaceModulePromise ??= import('@/components/workspace/WorkspaceSurface')
  return workspaceSurfaceModulePromise
}

const WorkspaceSurface = React.lazy(async () => {
  const module = await loadWorkspaceSurfaceModule()
  return { default: module.WorkspaceSurface }
})
const WorkspacePicker = React.lazy(async () => {
  const module = await import('@/components/workspace/WorkspacePicker')
  return { default: module.WorkspacePicker }
})
const FilePreviewRenderer = React.lazy(async () => {
  const module = await import('@/components/file-preview/FilePreviewRenderer')
  return { default: module.FilePreviewRenderer }
})

type AppState = 'loading' | 'project-hub' | 'workspace-picker' | 'ready'

type SessionListRefreshOptions = {
  removeMissing?: boolean
  reason?: string
  selectedSessionId?: string | null
}
type SessionListMetadataRefreshResult = Map<string, SessionMeta> | null
type SessionRefreshResult = 'refreshed' | 'preserved_stale_messages' | 'failed'

const SESSION_REFRESH_LOG_ID_LIMIT = 25
const STARTUP_RPC_TIMEOUT_MS = 5000
const SESSION_RPC_TIMEOUT_MS = 8000
const WORKSPACE_SWITCH_RPC_TIMEOUT_MS = 5000

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    operation.then(
      (value) => {
        window.clearTimeout(timeoutId)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timeoutId)
        reject(error)
      }
    )
  })
}

function summarizeIds(ids: Iterable<string>, limit = SESSION_REFRESH_LOG_ID_LIMIT) {
  const all = Array.from(ids)
  return {
    count: all.length,
    ids: all.slice(0, limit),
    truncated: all.length > limit,
  }
}

function workspaceDistribution(sessions: Iterable<{ workspaceId?: string }>): Record<string, number> {
  const distribution: Record<string, number> = {}
  for (const session of sessions) {
    const key = session.workspaceId || '(missing)'
    distribution[key] = (distribution[key] ?? 0) + 1
  }
  return distribution
}

function SessionLoadErrorBanner({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  const { t } = useTranslation()

  return (
    <div className="flex items-center gap-3 border-b border-border/50 bg-background px-3 py-2 text-xs text-foreground/70">
      <span className="min-w-0 flex-1 truncate" title={message}>
        {t("errors.failedToLoadSessionsDesc")}
      </span>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-7 shrink-0 items-center justify-center rounded-[8px] bg-foreground px-3 font-medium text-background transition-opacity hover:opacity-90"
        >
          {t("errors.retryLoadingSessions")}
        </button>
    </div>
  )
}

function AppContent() {
  const { t } = useTranslation()

  // Initialize renderer perf tracking early (debug mode = running from source)
  // Uses useEffect with empty deps to run once on mount before any session switches
  useEffect(() => {
    performance.mark('storyflow.app-mounted')
    window.electronAPI.isDebugMode().then((isDebug) => {
      initRendererPerf(isDebug)
    })
  }, [])

  // App state: loading -> project catalog or active workspace
  const [appState, setAppState] = useState<AppState>('loading')
  const [globalSettingsSubpage, setGlobalSettingsSubpage] = useState<SettingsSubpage | null>(null)
  const [clientAuthState, setClientAuthState] = useState<ClientAuthState | null>(null)

  // Keep ProjectHub's first frame lean, then use its idle time to fetch and
  // parse the workspace shell. Opening a project no longer pays the cold
  // AppShell/Tiptap/Shiki module cost before directory loading can begin.
  useEffect(() => {
    if (appState !== 'project-hub') return

    const preloadWorkspaceSurface = () => {
      void loadWorkspaceSurfaceModule()
    }
    if ('requestIdleCallback' in window) {
      const idleCallbackId = window.requestIdleCallback(preloadWorkspaceSurface)
      return () => window.cancelIdleCallback(idleCallbackId)
    }

    const timeoutId = setTimeout(preloadWorkspaceSurface, 0)
    return () => clearTimeout(timeoutId)
  }, [appState])
  const [pendingReadyRoute, setPendingReadyRoute] = useState<Route | null>(null)
  const [openGlobalSearchSignal, setOpenGlobalSearchSignal] = useState(0)
  const [openWhatsNewSignal, setOpenWhatsNewSignal] = useState(0)
  const [whatsNewManifest, setWhatsNewManifest] = useState<WhatsNewManifest | null>(null)
  const [hasUnseenReleaseNotes, setHasUnseenReleaseNotes] = useState(false)
  const shellInteractiveReportedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    void window.electronAPI.getWhatsNewManifest().then((manifest) => {
      if (cancelled || !manifest) return
      setWhatsNewManifest(manifest)
      setHasUnseenReleaseNotes(getWhatsNewStartupAction({
        manifest,
        lastSeenDigest: storage.get(storage.KEYS.whatsNewLastSeenDigest, ''),
        lastSeenVersion: storage.get(storage.KEYS.whatsNewLastSeenVersion, ''),
      }).hasUnseenReleaseNotes)
    }).catch((error) => {
      console.warn('[whats-new] Failed to load update announcement:', error)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (appState === 'loading' || shellInteractiveReportedRef.current) return
    performance.mark(`storyflow.surface-committed:${appState}`)

    // Two frames ensure React's committed product surface has reached the
    // compositor before the main process begins synchronous session discovery.
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        shellInteractiveReportedRef.current = true
        window.electronAPI.notifyShellInteractive?.()
      })
    })

    return () => {
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame) window.cancelAnimationFrame(secondFrame)
    }
  }, [appState])

  // Per-session Jotai atom setters for isolated updates
  // NOTE: No sessionsAtom - we don't store a Session[] array anywhere to prevent memory leaks
  // Instead we use:
  // - sessionMetaMapAtom for lightweight listing
  // - sessionAtomFamily(id) for individual session data
  const initializeSessions = useSetAtom(initializeSessionsAtom)
  const addSession = useSetAtom(addSessionAtom)
  const removeSession = useSetAtom(removeSessionAtom)
  const updateSessionDirect = useSetAtom(updateSessionAtom)
  const replaceLoadedSession = useSetAtom(replaceLoadedSessionAtom)
  const setSessionOptions = useSetAtom(sessionOptionsAtom)
  const setPendingPermissions = useSetAtom(pendingPermissionsAtom)
  const setPendingCredentials = useSetAtom(pendingCredentialsAtom)
  const setPendingUserQuestions = useSetAtom(pendingUserQuestionsAtom)
  const store = useStore()
  const activeViewingSessionIdRef = useRef<string | null>(null)
  const sessionRefreshInFlightRef = useRef<Map<string, Promise<SessionRefreshResult>>>(new Map())
  const sessionListMetadataRefreshInFlightRef = useRef<Map<string, Promise<SessionListMetadataRefreshResult>>>(new Map())
  const baseSessionCreationRef = useRef<Map<string, Promise<string>>>(new Map())

  // Helper to update a session by ID with partial fields
  // Uses per-session atom directly instead of updating an array
  const updateSessionById = useCallback((
    sessionId: string,
    updates: Partial<Session> | ((session: Session) => Partial<Session>)
  ) => {
    updateSessionDirect(sessionId, (prev) => {
      if (!prev) return prev
      const partialUpdates = typeof updates === 'function' ? updates(prev) : updates
      return { ...prev, ...partialUpdates }
    })
  }, [updateSessionDirect])

  const [workspaces, setWorkspaces] = useAtom(windowWorkspacesAtom)
  // Window's workspace ID — shared atom so Root/ThemeProvider stays in sync on switch
  const [windowWorkspaceId, setWindowWorkspaceId] = useAtom(windowWorkspaceIdAtom)
  const [runtimeWorkspace, setRuntimeWorkspace] = useAtom(windowRuntimeWorkspaceAtom)
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [isAddingLocalProject, setIsAddingLocalProject] = useState(false)
  const addLocalProjectInFlightRef = useRef(false)
  const focusedProjectRoute = useAtomValue(focusedPanelRouteAtom)
  const {
    clearReturnLocation,
    consumeReturnRoute,
    returnDestination,
  } = useProjectHubReturnLocation(activeProjectId, focusedProjectRoute)
  const pendingCreatedWorkspaceRef = useRef<Workspace | null>(null)


  // Get initial sessionId from URL params (for "Open in New Window" feature)
  const initialSessionId = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('sessionId')
  }, [])

  const windowRemoteWorkspaceId = runtimeWorkspace?.remoteServer?.remoteWorkspaceId ?? null

  const llmConnections = useAtomValue(llmConnectionsAtom)
  const workspaceDefaultLlmConnection = useAtomValue(workspaceDefaultLlmConnectionAtom)
  const refreshLlmConnections = useSetAtom(refreshLlmConnectionsAtom)

  const [menuNewChatTrigger, setMenuNewChatTrigger] = useState(0)
  // Draft composer state per session (text + attachment refs), preserved across mode
  // switches, conversation changes, and app restarts. Using a ref avoids re-renders
  // during typing; attachments are stored as lightweight refs (path + name) and
  // hydrated via readFileAttachment() on session switch.
  const sessionDraftsRef = useRef<Map<string, SessionDraft>>(new Map())
  // Theme state (app-level only)
  const [appTheme, setAppTheme] = useState<ThemeOverrides | null>(null)
  // Reset confirmation dialog
  const [showResetDialog, setShowResetDialog] = useState(false)

  // Session hydration is background state. It must never gate project rendering.
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [sessionLoadError, setSessionLoadError] = useState<string | null>(null)
  const [splashExiting, setSplashExiting] = useState(false)
  const [splashHidden, setSplashHidden] = useState(false)
  const lastLoadedSessionsWorkspaceRef = useRef<string | null>(null)
  const workspaceSwitchInFlightRef = useRef<string | null>(null)
  const workspaceSelectionGenerationRef = useRef(0)

  // Notifications enabled state (from app settings)
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)

  // Sources and skills for badge extraction
  const sources = useAtomValue(sourcesAtom)
  const skills = useAtomValue(skillsAtom)

  const projectShellReady = isProjectShellReady({
    appState,
    workspaceId: windowWorkspaceId,
  })

  // Background session/LLM/draft/notification hydration deliberately does not
  // participate in this transition.
  useEffect(() => {
    if (projectShellReady && !splashExiting) {
      setSplashExiting(true)
    }
  }, [projectShellReady, splashExiting])

  // Handler for when splash exit animation completes
  const handleSplashExitComplete = useCallback(() => {
    setSplashHidden(true)
  }, [])

  // Apply theme via hook (injects CSS variables)
  // shikiTheme is passed to ShikiThemeProvider to ensure correct syntax highlighting
  // theme for dark-only themes in light system mode
  const { shikiTheme, isDark } = useTheme({ appTheme })

  const applyPermissionModeState = useCallback((sessionId: string, state: PermissionModeState, source: 'event' | 'reconcile') => {
    setSessionOptions(prev => {
      const current = prev.get(sessionId) ?? defaultSessionOptions
      const currentVersion = current.permissionModeVersion ?? -1

      if (state.modeVersion < currentVersion) {
        window.electronAPI.debugLog(
          '[ModeSync] Ignoring stale permission mode update',
          { sessionId, source, incoming: state.modeVersion, current: currentVersion }
        )
        return prev
      }

      if (
        state.modeVersion === currentVersion &&
        current.permissionMode !== state.permissionMode
      ) {
        window.electronAPI.debugLog(
          '[ModeSync] Equal modeVersion with differing mode detected, applying and requesting reconciliation',
          {
            sessionId,
            source,
            modeVersion: state.modeVersion,
            currentMode: current.permissionMode,
            incomingMode: state.permissionMode,
          }
        )
      }

      return updateSessionOptionsMap(prev, sessionId, {
        permissionMode: state.permissionMode,
        permissionModeVersion: state.modeVersion,
      })
    })
  }, [])

  const reconcilePermissionModeState = useCallback(async (sessionId: string) => {
    try {
      const state = await window.electronAPI.getSessionPermissionModeState(sessionId)
      if (!state) return
      applyPermissionModeState(sessionId, state, 'reconcile')
    } catch (error) {
      window.electronAPI.debugLog('[ModeSync] Failed to reconcile permission mode', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }, [applyPermissionModeState])

  // Event processor hook - handles all agent events through pure functions
  const { processAgentEvent, clearStreamingState } = useEventProcessor()

  const syncSessionOptionsFromSession = useCallback((session: Session) => {
    setSessionOptions(prev => (
      updateSessionOptionsMap(prev, session.id, {
        permissionMode: session.permissionMode ?? defaultSessionOptions.permissionMode,
        thinkingLevel: session.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
      })
    ))
  }, [])

  const createSessionOnServer = useCallback(async (
    workspaceId: string,
    options?: import('../shared/types').CreateSessionOptions,
  ): Promise<Session> => {
    return window.electronAPI.createSession(workspaceId, options)
  }, [])

  const handleCreateSession = useCallback(async (
    workspaceId: string,
    options?: import('../shared/types').CreateSessionOptions,
  ): Promise<Session> => {
    const session = await createSessionOnServer(workspaceId, options)
    // Add to per-session atom and metadata map (no sessionsAtom)
    addSession(session)
    syncSessionOptionsFromSession(session)
    return session
  }, [addSession, createSessionOnServer, syncSessionOptionsFromSession])

  // Free Conversation always owns one renderable conversation. Deduplicate
  // replacement creation across optimistic deletion and session lifecycle events.
  const ensureBaseSessionId = useCallback((
    workspaceId: string,
    workspaceAliases: readonly string[] = [],
  ): Promise<string> => {
    const acceptedWorkspaceIds = new Set([workspaceId, ...workspaceAliases])
    for (const meta of store.get(sessionMetaMapAtom).values()) {
      if (
        acceptedWorkspaceIds.has(meta.workspaceId ?? '')
        && !meta.hidden
        && !meta.isArchived
      ) {
        return Promise.resolve(meta.id)
      }
    }

    const existingCreation = baseSessionCreationRef.current.get(workspaceId)
    if (existingCreation) return existingCreation

    const creation = handleCreateSession(workspaceId)
      .then(session => session.id)
      .finally(() => {
        baseSessionCreationRef.current.delete(workspaceId)
      })
    baseSessionCreationRef.current.set(workspaceId, creation)
    return creation
  }, [handleCreateSession, store])

  const maintainBaseSessionAfterRemoval = useCallback(async ({
    sessionId,
    sessionWorkspaceId,
    focusReplacement,
  }: {
    sessionId: string
    sessionWorkspaceId?: string
    focusReplacement: boolean
  }) => {
    removeSession(sessionId)

    const activeWorkspaceId = windowWorkspaceId
    if (!activeWorkspaceId || !sessionWorkspaceId) return
    const workspaceAliases = windowRemoteWorkspaceId ? [windowRemoteWorkspaceId] : []
    if (sessionWorkspaceId !== activeWorkspaceId && !workspaceAliases.includes(sessionWorkspaceId)) return

    const acceptedWorkspaceIds = new Set([activeWorkspaceId, ...workspaceAliases])
    const replacementId = [...store.get(sessionMetaMapAtom).values()].find(meta => (
      acceptedWorkspaceIds.has(meta.workspaceId ?? '')
      && !meta.hidden
      && !meta.isArchived
    ))?.id ?? (
      activeWorkspaceId === FREE_CONVERSATION_WORKSPACE_ID
        ? await ensureBaseSessionId(activeWorkspaceId, workspaceAliases)
        : null
    )
    if (focusReplacement) {
      navigate(replacementId ? routes.view.allSessions(replacementId) : routes.view.writing())
    }
  }, [ensureBaseSessionId, removeSession, store, windowRemoteWorkspaceId, windowWorkspaceId])

  const refreshSessionFromServer = useCallback(async (sessionId: string): Promise<SessionRefreshResult> => {
    const inFlight = sessionRefreshInFlightRef.current.get(sessionId)
    if (inFlight) return inFlight

    const refreshPromise = (async (): Promise<SessionRefreshResult> => {
      try {
        const fresh = await window.electronAPI.getSessionMessages(sessionId)
        if (!fresh) return 'failed'

        const prevSession = store.get(sessionAtomFamily(sessionId))
        const preservedStaleMessages = !!prevSession && prevSession.messages.length > 0 && (!fresh.messages || fresh.messages.length === 0)
        const nextSession = preservedStaleMessages
          ? { ...fresh, messages: prevSession.messages }
          : fresh

        clearStreamingState(sessionId)
        replaceLoadedSession(nextSession)
        syncSessionOptionsFromSession(nextSession)
        void reconcilePermissionModeState(sessionId)
        return preservedStaleMessages ? 'preserved_stale_messages' : 'refreshed'
      } catch (err) {
        console.error(`[App] Failed to refresh session ${sessionId}:`, err)
        return 'failed'
      }
    })()

    sessionRefreshInFlightRef.current.set(sessionId, refreshPromise)
    try {
      return await refreshPromise
    } finally {
      sessionRefreshInFlightRef.current.delete(sessionId)
    }
  }, [clearStreamingState, replaceLoadedSession, syncSessionOptionsFromSession, reconcilePermissionModeState, store])

  const loadSessionsFromServer = useCallback(async (
    workspaceIdForLoad = windowWorkspaceId,
    selectionGeneration = workspaceSelectionGenerationRef.current,
  ): Promise<Session[]> => {
    const loadingWorkspaceId = workspaceIdForLoad
    const optionsBeforeLoad = store.get(sessionOptionsAtom)
    setSessionLoadError(null)
    store.set(sessionMetadataReadyAtom, false)

    try {
      let loadedSessions = await withTimeout(
        window.electronAPI.getSessions(),
        SESSION_RPC_TIMEOUT_MS,
        'getSessions'
      )

      if (selectionGeneration !== workspaceSelectionGenerationRef.current) return []

      // Every opened workspace needs a usable composer when no conversation can be restored.
      if (loadingWorkspaceId && shouldAutoCreateBaseSession(loadingWorkspaceId, loadedSessions)) {
        const baseSession = await createSessionOnServer(loadingWorkspaceId)
        if (selectionGeneration !== workspaceSelectionGenerationRef.current) return []
        loadedSessions = [...loadedSessions, baseSession]
      }

      // Initialize per-session atoms and metadata map
      // NOTE: No sessionsAtom used - sessions are only in per-session atoms
      initializeSessions(loadedSessions)
      store.set(sessionMetadataReadyAtom, true)

      setSessionOptions(current => initializeSessionOptionsMap(loadedSessions, optionsBeforeLoad, current))

      setSessionsLoaded(true)
      lastLoadedSessionsWorkspaceRef.current = loadingWorkspaceId
      void Promise.allSettled(
        // Current hosts reconcile in sessions:get. Legacy hosts still need per-session RPCs.
        loadedSessions.filter(s => s.permissionModeVersion == null).map(s => reconcilePermissionModeState(s.id))
      )

      if (initialSessionId && loadingWorkspaceId) {
        const session = loadedSessions.find(s => s.id === initialSessionId)
        if (session) {
          navigate(routes.view.allSessions(session.id))
        }
      }

      return loadedSessions
    } catch (err) {
      if (selectionGeneration !== workspaceSelectionGenerationRef.current) return []
      console.error('[App] Failed to load sessions:', err)
      const transportState = await window.electronAPI.getTransportConnectionState().catch(() => null)

      if (shouldTreatSessionLoadFailureAsTransportFallback(transportState)) {
        console.error('[App] Treating session load failure as transport fallback:', transportState)
        store.set(sessionMetadataReadyAtom, true)
        setSessionsLoaded(true)
        setSessionLoadError(null)
        lastLoadedSessionsWorkspaceRef.current = loadingWorkspaceId
        return []
      }

      setSessionLoadError(formatSessionLoadFailure(err))
      store.set(sessionMetadataReadyAtom, true)
      setSessionsLoaded(true)
      lastLoadedSessionsWorkspaceRef.current = loadingWorkspaceId
      return []
    }
  }, [createSessionOnServer, initializeSessions, initialSessionId, reconcilePermissionModeState, store, windowWorkspaceId])

  const refreshSessionListMetadataFromServer = useCallback(async (options: SessionListRefreshOptions = {}): Promise<SessionListMetadataRefreshResult> => {
    const {
      removeMissing = true,
      reason = 'manual-or-authoritative',
      selectedSessionId = null,
    } = options
    const refreshKey = `${windowWorkspaceId ?? ''}|${windowRemoteWorkspaceId ?? ''}|${removeMissing ? 'remove' : 'preserve'}|${reason}|${selectedSessionId ?? ''}`
    const inFlight = sessionListMetadataRefreshInFlightRef.current.get(refreshKey)
    if (inFlight) return inFlight

    const refreshPromise = (async (): Promise<SessionListMetadataRefreshResult> => {
      const beforeMetaMap = store.get(sessionMetaMapAtom)
      const beforeIds = new Set(beforeMetaMap.keys())
      const transportState = await window.electronAPI.getTransportConnectionState().catch(() => null)

      try {
        const sessions = await window.electronAPI.getSessions()
        const returnedIds = new Set(sessions.map(s => s.id))
        const missingIds = Array.from(beforeIds).filter(id => !returnedIds.has(id))
        const addedIds = sessions.map(s => s.id).filter(id => !beforeIds.has(id))
        const logPayload = {
          reason,
          removeMissing,
          windowWorkspaceId,
          windowRemoteWorkspaceId,
          selectedSessionId,
          beforeCount: beforeIds.size,
          returnedCount: sessions.length,
          beforeIds: summarizeIds(beforeIds),
          returnedIds: summarizeIds(returnedIds),
          missingIds: summarizeIds(missingIds),
          addedIds: summarizeIds(addedIds),
          beforeWorkspaceIds: workspaceDistribution(beforeMetaMap.values()),
          returnedWorkspaceIds: workspaceDistribution(sessions),
          transportState,
        }

        rendererLog.info('[App] Session list metadata refresh result', logPayload)
        if (!removeMissing && missingIds.length > 0) {
          rendererLog.warn('[App] Non-destructive refresh preserved sessions omitted by getSessions(); this indicates a partial backend response or workspace-context mismatch', logPayload)
        }

        const loadedSessionIds = store.get(loadedSessionsAtom)

        // Single transactional atom write — all cross-atom mutations happen
        // inside one Jotai write function so React subscribers see one
        // consistent update instead of intermediate states.
        const nextMetaMap = store.set(refreshSessionsMetadataAtom, { sessions, loadedSessionIds, removeMissing })

        // Sync app-level state (React hooks / non-atom concerns) after the atom transaction
        for (const session of sessions) {
          syncSessionOptionsFromSession(session)
        }
        await Promise.allSettled(sessions.map(s => reconcilePermissionModeState(s.id)))

        return nextMetaMap
      } catch (err) {
        rendererLog.error('[App] Failed to refresh session list metadata after reconnect:', {
          reason,
          removeMissing,
          windowWorkspaceId,
          windowRemoteWorkspaceId,
          selectedSessionId,
          beforeCount: beforeIds.size,
          beforeIds: summarizeIds(beforeIds),
          beforeWorkspaceIds: workspaceDistribution(beforeMetaMap.values()),
          transportState,
          error: err,
        })
        return null
      }
    })()

    sessionListMetadataRefreshInFlightRef.current.set(refreshKey, refreshPromise)
    try {
      return await refreshPromise
    } finally {
      sessionListMetadataRefreshInFlightRef.current.delete(refreshKey)
    }
  }, [store, syncSessionOptionsFromSession, reconcilePermissionModeState, windowWorkspaceId, windowRemoteWorkspaceId])

  // Stale session watchdog — catches stuck sessions that the reconnect protocol misses
  const { trackSessionActivity } = useStaleSessionRecovery({
    store,
    refreshSessionFromServer,
  })

  const DRAFT_SAVE_DEBOUNCE_MS = 500

  const loadClientAuthState = useCallback(async (): Promise<ClientAuthState | null> => {
    if (!window.electronAPI?.getClientAuthState) return null
    try {
      const nextState = await window.electronAPI.getClientAuthState()
      setClientAuthState(nextState)
      return nextState
    } catch (error) {
      console.error('[App] Failed to load client auth state:', error)
      return null
    }
  }, [])

  useEffect(() => window.electronAPI.onClientAuthStateChanged(setClientAuthState), [])

  // Resolve the window and project catalog on mount. Managed model defaults are
  // seeded by the runtime before this renderer becomes interactive.
  useEffect(() => {
    const initialize = async () => {
      performance.mark('storyflow.startup-rpc:start')
      try {
        // Get this window's workspace ID (passed via URL query param from main process)
        const wsId = await withTimeout(
          window.electronAPI.getWindowWorkspace(),
          STARTUP_RPC_TIMEOUT_MS,
          'getWindowWorkspace'
        )
        performance.mark('storyflow.startup-rpc:workspace')
        let initialRuntimeWorkspace: Workspace | null = null
        if (wsId) {
          initialRuntimeWorkspace = await withTimeout(
            window.electronAPI.resolveRuntimeWorkspace(wsId),
            STARTUP_RPC_TIMEOUT_MS,
            'resolveRuntimeWorkspace'
          )
        }
        setRuntimeWorkspace(initialRuntimeWorkspace)
        setWindowWorkspaceId(initialRuntimeWorkspace?.id ?? null)
        if (initialRuntimeWorkspace && initialRuntimeWorkspace.id !== FREE_CONVERSATION_WORKSPACE_ID) {
          setActiveProjectId(initialRuntimeWorkspace.id)
        }

        await loadClientAuthState()
        performance.mark('storyflow.startup-rpc:client-auth')

        const ws = await withTimeout(
          window.electronAPI.getWorkspaces(),
          STARTUP_RPC_TIMEOUT_MS,
          'getWorkspaces'
        )
        performance.mark('storyflow.startup-rpc:workspaces')
        setWorkspaces(ws)

        if (!initialRuntimeWorkspace) {
          const startupWorkspaceId = selectStartupWorkspaceId(ws)
          if (startupWorkspaceId) {
            try {
              initialRuntimeWorkspace = await withTimeout(
                window.electronAPI.resolveRuntimeWorkspace(startupWorkspaceId),
                STARTUP_RPC_TIMEOUT_MS,
                'resolveStartupWorkspace'
              )
              if (initialRuntimeWorkspace) {
                await withTimeout(
                  window.electronAPI.switchWorkspace(startupWorkspaceId),
                  STARTUP_RPC_TIMEOUT_MS,
                  'switchStartupWorkspace'
                )
                setRuntimeWorkspace(initialRuntimeWorkspace)
                setWindowWorkspaceId(initialRuntimeWorkspace.id)
                setActiveProjectId(initialRuntimeWorkspace.id)
              }
            } catch (error) {
              console.warn('[App] Failed to restore startup project:', error)
              initialRuntimeWorkspace = null
            }
          }
        }

        setAppState(resolvePostSetupAppState({
          windowWorkspaceId: initialRuntimeWorkspace?.id,
          workspaceCount: ws.length,
        }))
        performance.mark('storyflow.startup-rpc:state-selected')
      } catch (error) {
        console.error('Failed to initialize app state:', error)
        setAppState('project-hub')
      }
    }

    initialize()
  }, [loadClientAuthState, setRuntimeWorkspace])

  // Session selection state
  const [sessionSelection, setSession] = useSession()

  // Notification system - shows native OS notifications and badge count
  const handleNavigateToSession = useCallback((sessionId: string) => {
    // Navigate to the session via central routing (uses allSessions filter)
    navigate(routes.view.allSessions(sessionId))
  }, [])

  const { showSessionNotification } = useNotifications({
    workspaceId: windowWorkspaceId,
    // NOTE: sessions removed - hook now uses sessionMetaMapAtom internally
    // to prevent closures from retaining full message arrays
    onNavigateToSession: handleNavigateToSession,
    enabled: notificationsEnabled,
  })

  // Load startup-global data when app is ready
  useEffect(() => {
    if (appState !== 'ready') return

    withTimeout(
      window.electronAPI.getWorkspaces(),
      STARTUP_RPC_TIMEOUT_MS,
      'getWorkspaces'
    )
      .then(setWorkspaces)
      .catch((error) => {
        console.error('[App] Failed to load workspaces:', error)
      })

    withTimeout(
      window.electronAPI.getNotificationsEnabled(),
      STARTUP_RPC_TIMEOUT_MS,
      'getNotificationsEnabled'
    )
      .then(setNotificationsEnabled)
      .catch(() => {})

    // Show actionable toast for missing system dependencies (Windows only)
    window.electronAPI.getSystemWarnings().then((warnings) => {
      if (warnings.vcredistMissing) {
        toast.warning(t('toast.vcRedistNotFound'), {
          description: t('toast.vcRedistNotFoundDesc'),
          duration: Infinity,
          action: {
            label: 'Install',
            onClick: () => window.electronAPI.openUrl(warnings.downloadUrl ?? 'https://aka.ms/vs/17/release/vc_redist.x64.exe'),
          },
        })
      }
    }).catch(() => { /* non-fatal startup check */ })
    // Load LLM connections with authentication status
    withTimeout(
      refreshLlmConnections(),
      STARTUP_RPC_TIMEOUT_MS,
      'listLlmConnectionsWithStatus'
    ).catch((error) => {
      console.error('[App] Failed to load LLM connections:', error)
    })
    // Load persisted input drafts into ref (no re-render needed).
    // Attachment files are not read here — hydration happens lazily when the session
    // is opened so app startup isn't delayed by reading potentially large files.
    withTimeout(
      window.electronAPI.getAllDrafts(),
      STARTUP_RPC_TIMEOUT_MS,
      'getAllDrafts'
    )
      .then((drafts) => {
        if (Object.keys(drafts).length > 0) {
          sessionDraftsRef.current = new Map(Object.entries(drafts))
        }
      })
      .catch((error) => {
        console.error('[App] Failed to load drafts:', error)
      })
    // Load app-level theme
    withTimeout(
      window.electronAPI.getAppTheme(),
      STARTUP_RPC_TIMEOUT_MS,
      'getAppTheme'
    )
      .then(setAppTheme)
      .catch((error) => {
        console.error('[App] Failed to load app theme:', error)
      })
  }, [appState, refreshLlmConnections, t])

  // Load sessions for the active workspace
  useEffect(() => {
    if (appState !== 'ready' || !windowWorkspaceId) return
    if (workspaceSwitchInFlightRef.current === windowWorkspaceId) return
    if (sessionsLoaded && lastLoadedSessionsWorkspaceRef.current === windowWorkspaceId) return

    void loadSessionsFromServer()
  }, [appState, loadSessionsFromServer, sessionsLoaded, windowWorkspaceId])

  // Subscribe to theme change events (live updates when theme.json changes)
  useEffect(() => {
    const cleanupApp = window.electronAPI.onAppThemeChange((theme) => {
      setAppTheme(theme)
    })
    return () => {
      cleanupApp()
    }
  }, [])

  // Subscribe to LLM connections change events (live updates when models are fetched)
  useEffect(() => {
    const cleanup = window.electronAPI.onLlmConnectionsChanged(() => {
      refreshLlmConnections()
    })
    return () => { cleanup() }
  }, [refreshLlmConnections])

  // Refresh LLM connections and workspace default when workspace changes
  useEffect(() => {
    if (windowWorkspaceId) {
      refreshLlmConnections()
    }
  }, [windowWorkspaceId, refreshLlmConnections])

  // Listen for session events. Per-session atoms are the sole renderer source of truth;
  // text deltas bypass metadata projection while structural events update both views.
  useEffect(() => {
    // Handoff events end streaming and may change list-visible metadata.
    const handoffEventTypes = new Set(['complete', 'error', 'interrupted', 'typed_error', 'session_status_changed', 'session_flagged', 'session_unflagged', 'session_pinned', 'session_unpinned', 'name_changed', 'labels_changed', 'title_generated', 'async_operation'])
    // Helper to handle side effects (same logic for both paths)
    const handleEffects = (effects: Effect[], sessionId: string, eventType: string) => {
      for (const effect of effects) {
        switch (effect.type) {
          case 'permission_request': {
            setPendingPermissions(prevPerms => appendUniqueRequestForSession(prevPerms, sessionId, effect.request))

            // Native notification for approval-required pauses (same gating as completion notifications)
            const notifySession = store.get(sessionAtomFamily(sessionId))
            if (notifySession && !notifySession.hidden) {
              const isAdminPrompt = effect.request.type === 'admin_approval'
              const promptBody = isAdminPrompt
                ? `Admin approval required: ${effect.request.appName || effect.request.toolName}`
                : `Permission required: ${effect.request.toolName}`
              showSessionNotification(notifySession, promptBody)
            }
            break
          }
          case 'user_question_request': {
            setPendingUserQuestions(current => appendUniqueRequestForSession(current, sessionId, effect.request))
            const notifySession = store.get(sessionAtomFamily(sessionId))
            if (notifySession && !notifySession.hidden) {
              showSessionNotification(notifySession, effect.request.questions[0]?.question ?? 'Input required')
            }
            break
          }
          case 'permission_mode_changed': {
            if (typeof effect.modeVersion === 'number' && effect.changedAt && effect.changedBy) {
              applyPermissionModeState(effect.sessionId, {
                permissionMode: effect.permissionMode,
                modeVersion: effect.modeVersion,
                changedAt: effect.changedAt,
                changedBy: effect.changedBy,
              }, 'event')
            } else {
              // Backward compatibility: apply mode optimistically then reconcile authoritative state.
              setSessionOptions(prevOpts => updateSessionOptionsMap(prevOpts, effect.sessionId, {
                permissionMode: effect.permissionMode,
              }))
              void reconcilePermissionModeState(effect.sessionId)
            }
            break
          }
          case 'credential_request': {
            setPendingCredentials(prevCreds => appendUniqueRequestForSession(prevCreds, sessionId, effect.request))
            break
          }
          case 'restore_input': {
            // Queued messages were removed from chat on abort — restore their text to the input field.
            // Append to existing draft (user may have started typing) rather than overwrite.
            const existingDraft = sessionDraftsRef.current.get(sessionId)
            const existingText = coerceInputText(existingDraft?.text)
            const restoredText = coerceInputText(effect.text)
            const restored = existingText
              ? `${existingText}\n\n${restoredText}`
              : restoredText
            handleInputChange(sessionId, restored)
            // handleInputChange updates the ref but ChatPage has local state.
            // Dispatch a custom event so ChatPage re-reads the draft.
            window.dispatchEvent(new CustomEvent('craft:restore-input', {
              detail: { sessionId, text: restored },
            }))
            break
          }
          case 'toast_error': {
            toast.error(effect.message, { duration: 5000 })
            break
          }
        }
      }

      // Clear pending permissions and credentials on complete
      if (eventType === 'complete') {
        setPendingPermissions(prevPerms => {
          if (prevPerms.has(sessionId)) {
            const next = new Map(prevPerms)
            next.delete(sessionId)
            return next
          }
          return prevPerms
        })
        setPendingCredentials(prevCreds => {
          if (prevCreds.has(sessionId)) {
            const next = new Map(prevCreds)
            next.delete(sessionId)
            return next
          }
          return prevCreds
        })
        setPendingUserQuestions(current => {
          if (!current.has(sessionId)) return current
          const next = new Map(current)
          next.delete(sessionId)
          return next
        })
      }
    }

    const cleanup = window.electronAPI.onSessionEvent((event: SessionEvent) => {
      if (!('sessionId' in event)) return

      const sessionId = event.sessionId
      const workspaceId = windowWorkspaceId ?? ''
      if (event.type === 'session_status_changed') {
        invalidateSessionStatusMutation(sessionId)
      }

      // Session lifecycle events are handled explicitly (not by the agent event processor).
      if (event.type === 'session_created') {
        window.electronAPI.getSessionMessages(sessionId)
          .then((createdSession: Session | null) => {
            if (createdSession) {
              const currentSession = store.get(sessionAtomFamily(sessionId))
              if (!shouldApplyCreatedSessionSnapshot(currentSession, createdSession)) return
              const existingMeta = store.get(sessionMetaMapAtom).has(sessionId)
              if (existingMeta) {
                replaceLoadedSession(createdSession)
              } else {
                addSession(createdSession)
              }
              syncSessionOptionsFromSession(createdSession)
              return
            }
            return window.electronAPI.getSessions().then(initializeSessions)
          })
          .catch((error: unknown) => console.error('Failed to handle session_created event:', error))
        return
      }

      if (event.type === 'session_deleted') {
        const deletedMeta = store.get(sessionMetaMapAtom).get(sessionId)
        const focusedSessionId = parseSessionIdFromRoute(store.get(focusedPanelRouteAtom) ?? '')
        void maintainBaseSessionAfterRemoval({
          sessionId,
          sessionWorkspaceId: deletedMeta?.workspaceId,
          focusReplacement: focusedSessionId === sessionId,
        }).catch((error) => {
          console.error('[App] Failed to restore base session after deletion event:', error)
        })
        return
      }

      const agentEvent = event as unknown as AgentEvent

      // Track activity for stale session watchdog
      trackSessionActivity(sessionId)

      // Dispatch window event when compaction completes
      // This allows FreeFormInput to sequence the plan execution message after compaction
      // Note: markCompactionComplete is called on the backend (sessions.ts) to ensure
      // it happens even if CMD+R occurs during compaction
      if (event.type === 'info' && event.statusType === 'compaction_complete') {
        window.dispatchEvent(new CustomEvent('craft:compaction-complete', {
          detail: { sessionId }
        }))
      }

      const isHandoff = handoffEventTypes.has(event.type)
      const currentSession = store.get(sessionAtomFamily(sessionId))
      const { session: updatedSession, effects } = processAgentEvent(
        agentEvent,
        currentSession,
        workspaceId
      )

      // Text deltas change only the active transcript body. All structural events
      // flow through the metadata-aware update action.
      if (event.type === 'text_delta') {
        store.set(sessionAtomFamily(sessionId), updatedSession)
      } else {
        updateSessionDirect(sessionId, () => updatedSession)
      }
      if (isHandoff && !updatedSession.isProcessing) {
        store.set(reconcileCurrentSessionTranscriptWorkingSetAtom)
      }

      handleEffects(effects, sessionId, event.type)
      if (event.type === 'complete' && !updatedSession.hidden) {
        const lastMessage = updatedSession.messages.findLast(
          m => (m.role === 'assistant' || m.role === 'plan') && !m.isIntermediate
        )
        const rawPreview = lastMessage?.content?.substring(0, 200) || undefined
        const preview = rawPreview ? stripMarkdown(rawPreview).substring(0, 100) || undefined : undefined
        showSessionNotification(updatedSession, preview)
      }
    })

    return () => {
      cleanup()
    }
  }, [
    processAgentEvent,
    trackSessionActivity,
    windowWorkspaceId,
    store,
    updateSessionDirect,
    replaceLoadedSession,
    showSessionNotification,
    initializeSessions,
    addSession,
    maintainBaseSessionAfterRemoval,
    syncSessionOptionsFromSession,
    applyPermissionModeState,
    reconcilePermissionModeState,
    setPendingCredentials,
    setPendingPermissions,
    setPendingUserQuestions,
    setSessionOptions,
  ])

  // Transport reconnect recovery — refresh session metadata plus active/processing
  // session content after stale reconnects.
  useEffect(() => {
    let isDisposed = false
    const reconnectRetryTimeouts = new Set<ReturnType<typeof setTimeout>>()
    const delayReconnectRetry = (delay: number) => new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        reconnectRetryTimeouts.delete(timer)
        resolve()
      }, delay)
      reconnectRetryTimeouts.add(timer)
    })

    const cleanup = window.electronAPI.onReconnected(async (isStale: boolean) => {
      if (!isStale) {
        // Server replayed buffered events — we're caught up, nothing to do
        console.info('[App] Reconnected with event replay — no refresh needed')
        return
      }

      console.warn('[App] Stale reconnect — refreshing session metadata and active/processing sessions')

      const refreshedMetaMap = await refreshSessionListMetadataFromServer({
        removeMissing: false,
        reason: 'stale-reconnect',
        selectedSessionId: sessionSelection.selected,
      })
      const metaMap = refreshedMetaMap ?? store.get(sessionMetaMapAtom)
      const activeSession = sessionSelection.selected
        ? store.get(sessionAtomFamily(sessionSelection.selected))
        : null
      const loadedSessionIds = store.get(loadedSessionsAtom)
      const refreshIds = getSessionsToRefreshAfterStaleReconnect(
        metaMap,
        sessionSelection.selected,
        sessionSelection.selected
          ? {
              loaded: loadedSessionIds.has(sessionSelection.selected),
              messageCount: activeSession?.messages?.length ?? 0,
            }
          : undefined
      )

      console.info(`[App] Stale reconnect — refreshing ${refreshIds.length} session(s):`, refreshIds)

      // Refresh full message content only for the active session plus any
      // session still marked processing after the metadata refresh.
      for (const sessionId of refreshIds) {
        if (isDisposed) break
        let refreshResult = await refreshSessionFromServer(sessionId)
        if (refreshResult !== 'refreshed') {
          // Server may need time to restart session subprocess after reconnect,
          // or it may still be lazily loading session messages.
          for (const delay of [2000, 4000]) {
            console.warn(`[App] Retrying session refresh for ${sessionId} after ${delay}ms (${refreshResult})`)
            await delayReconnectRetry(delay)
            if (isDisposed) break
            refreshResult = await refreshSessionFromServer(sessionId)
            if (refreshResult === 'refreshed') break
          }
        }
      }

      // Final fallback: if the active session is still empty, force a reload
      // even when the session is already marked loaded.
      if (!isDisposed && sessionSelection.selected) {
        const session = store.get(sessionAtomFamily(sessionSelection.selected))
        if (session && (!session.messages || session.messages.length === 0)) {
          console.warn('[App] Active session still has no messages after stale reconnect refresh — forcing message reload')
          await store.set(forceSessionMessagesReloadAtom, sessionSelection.selected)
        } else if (session) {
          console.info(`[App] Stale reconnect recovery complete — active session has ${session.messages?.length ?? 0} messages`)
        }
      }

    })

    return () => {
      isDisposed = true
      for (const timer of reconnectRetryTimeouts) clearTimeout(timer)
      reconnectRetryTimeouts.clear()
      cleanup()
    }
  }, [store, sessionSelection.selected, refreshSessionFromServer, refreshSessionListMetadataFromServer])

  // Listen for menu bar events
  useEffect(() => {
    const unsubNewChat = window.electronAPI.onMenuNewChat(() => {
      setMenuNewChatTrigger(n => n + 1)
    })
    const unsubSettings = window.electronAPI.onMenuOpenSettings(() => {
      handleOpenSettings()
    })
    const unsubShortcuts = window.electronAPI.onMenuKeyboardShortcuts(() => {
      navigate(routes.view.settings('shortcuts'))
    })
    return () => {
      unsubNewChat()
      unsubSettings()
      unsubShortcuts()
    }
  }, [])

  // Deep link navigation is initialized later after handleInputChange is defined

  const handleDeleteSession = useCallback(async (sessionId: string, skipConfirmation = false, workspaceId?: string): Promise<boolean> => {
    // Show confirmation dialog before deleting (unless skipped or session is empty)
    if (!skipConfirmation) {
      // Check if session has any messages using session metadata from Jotai store
      // We use store.get() instead of closing over sessions to prevent memory leaks
      // (closures would retain the full sessions array with all messages)
      const metaMap = store.get(sessionMetaMapAtom)
      const meta = !workspaceId || workspaceId === store.get(windowWorkspaceIdAtom) ? metaMap.get(sessionId) : undefined
      // Session is empty if it has no lastFinalMessageId (no assistant responses) and no name (set on first user message)
      const isEmpty = !!meta && (!meta.lastFinalMessageId && !meta.name)

      if (!isEmpty) {
        const confirmed = await window.electronAPI.showDeleteSessionConfirmation(meta?.name || 'Untitled')
        if (!confirmed) return false
      }
    }

    const deletedMeta = store.get(sessionMetaMapAtom).get(sessionId)
    const focusedSessionId = parseSessionIdFromRoute(store.get(focusedPanelRouteAtom) ?? '')
    await window.electronAPI.deleteSession(sessionId, workspaceId)
    if (workspaceId && workspaceId !== store.get(windowWorkspaceIdAtom)) return true
    await maintainBaseSessionAfterRemoval({
      sessionId,
      sessionWorkspaceId: deletedMeta?.workspaceId,
      focusReplacement: focusedSessionId === sessionId,
    })
    return true
  }, [maintainBaseSessionAfterRemoval, store])

  // Auto-delete handler for empty sessions (fire-and-forget, no confirmation)
  const handleAutoDeleteEmptySession = useCallback(async (sessionId: string, focusReplacement = false) => {
    const deletedMeta = store.get(sessionMetaMapAtom).get(sessionId)
    try {
      const result = await window.electronAPI.sessionCommand(sessionId, { type: 'deleteIfEmpty' })
      if (!result || !('deleted' in result) || !result.deleted) return
      await maintainBaseSessionAfterRemoval({
        sessionId,
        sessionWorkspaceId: deletedMeta?.workspaceId,
        focusReplacement,
      })
    } catch (error) {
      console.error('[App] Failed to auto-delete empty session:', error)
    }
  }, [maintainBaseSessionAfterRemoval, store])

  const handleFlagSession = useCallback((sessionId: string) => {
    updateSessionById(sessionId, { isFlagged: true })
    window.electronAPI.sessionCommand(sessionId, { type: 'flag' })
  }, [updateSessionById])

  const handleUnflagSession = useCallback((sessionId: string) => {
    updateSessionById(sessionId, { isFlagged: false })
    window.electronAPI.sessionCommand(sessionId, { type: 'unflag' })
  }, [updateSessionById])

  const updatePinnedSession = useCallback(async (sessionId: string, isPinned: boolean, workspaceId?: string): Promise<boolean> => {
    const isCurrentWorkspace = !workspaceId || workspaceId === store.get(windowWorkspaceIdAtom)
    const previous = store.get(sessionAtomFamily(sessionId))?.isPinned
    if (isCurrentWorkspace) updateSessionById(sessionId, { isPinned })
    try {
      await window.electronAPI.sessionCommand(sessionId, { type: isPinned ? 'pin' : 'unpin' }, workspaceId)
      return true
    } catch (error) {
      if (isCurrentWorkspace && (!workspaceId || workspaceId === store.get(windowWorkspaceIdAtom))) updateSessionById(sessionId, { isPinned: previous })
      console.error(`[App] Failed to ${isPinned ? 'pin' : 'unpin'} session:`, error)
      toast.error(isPinned ? '固定会话失败' : '取消固定失败')
      return false
    }
  }, [store, updateSessionById])

  const handlePinSession = useCallback(
    (sessionId: string, workspaceId?: string) => updatePinnedSession(sessionId, true, workspaceId),
    [updatePinnedSession],
  )

  const handleUnpinSession = useCallback(
    (sessionId: string, workspaceId?: string) => updatePinnedSession(sessionId, false, workspaceId),
    [updatePinnedSession],
  )

  const handleArchiveSession = useCallback(async (sessionId: string, workspaceId?: string) => {
    try {
      await window.electronAPI.sessionCommand(sessionId, { type: 'archive' }, workspaceId)
      if (!workspaceId || workspaceId === store.get(windowWorkspaceIdAtom)) {
        updateSessionById(sessionId, { isArchived: true, archivedAt: Date.now() })
      }
    } catch (error) {
      console.error('[App] Failed to archive session:', error)
      toast.error('归档会话失败')
    }
  }, [updateSessionById, store])

  const handleUnarchiveSession = useCallback((sessionId: string) => {
    updateSessionById(sessionId, { isArchived: false, archivedAt: undefined })
    window.electronAPI.sessionCommand(sessionId, { type: 'unarchive' })
  }, [updateSessionById])

  /**
   * Set which session user is actively viewing (for unread state machine).
   * Called when user navigates to a session. Main process uses this to determine
   * whether to mark new assistant messages as unread.
   */
  const handleSetActiveViewingSession = useCallback((sessionId: string) => {
    const currentSession = store.get(sessionAtomFamily(sessionId))
    const alreadyViewing = activeViewingSessionIdRef.current === sessionId
    if (alreadyViewing && currentSession?.hasUnread !== true) return

    activeViewingSessionIdRef.current = sessionId
    // Optimistic UI update: clear hasUnread immediately
    if (currentSession?.hasUnread === true) {
      updateSessionById(sessionId, { hasUnread: false })
    }
    // Tell main process user is viewing this session
    window.electronAPI.sessionCommand(sessionId, { type: 'setActiveViewing', workspaceId: windowWorkspaceId ?? '' })
  }, [store, updateSessionById, windowWorkspaceId])

  const handleMarkSessionRead = useCallback((sessionId: string) => {
    // Update hasUnread flag (primary source of truth for NEW badge)
    // Also update lastReadMessageId for backwards compatibility
    updateSessionById(sessionId, (s) => {
      const lastFinalId = s.messages.findLast(
        m => (m.role === 'assistant' || m.role === 'plan') && !m.isIntermediate
      )?.id
      return {
        hasUnread: false,
        ...(lastFinalId ? { lastReadMessageId: lastFinalId } : {}),
      }
    })
    window.electronAPI.sessionCommand(sessionId, { type: 'markRead' })
  }, [updateSessionById])

  const handleMarkSessionUnread = useCallback((sessionId: string) => {
    // Set hasUnread flag (primary source of truth for NEW badge)
    updateSessionById(sessionId, { hasUnread: true, lastReadMessageId: undefined })
    window.electronAPI.sessionCommand(sessionId, { type: 'markUnread' })
  }, [updateSessionById])

  const handleSessionStatusChange = useCallback((sessionId: string, state: SessionStatus) => {
    const mutationToken = beginSessionStatusMutation(sessionId)
    void commitOptimisticSessionStatus({
      nextStatus: state,
      getCurrentStatus: () => store.get(sessionAtomFamily(sessionId))?.sessionStatus,
      applyStatus: sessionStatus => {
        updateSessionById(sessionId, { sessionStatus })
      },
      persist: () => window.electronAPI.sessionCommand(sessionId, {
        type: 'setSessionStatus',
        state,
      }),
      ownsMutation: () => ownsSessionStatusMutation(sessionId, mutationToken),
      onError: error => {
        toast.error(t('session.statusUpdateFailed', '状态更新失败'), {
          description: error instanceof Error ? error.message : String(error),
        })
      },
    })
  }, [store, t, updateSessionById])

  const handleRenameSession = useCallback(async (sessionId: string, name: string, workspaceId?: string) => {
    try {
      await window.electronAPI.sessionCommand(sessionId, { type: 'rename', name }, workspaceId)
      if (!workspaceId || workspaceId === store.get(windowWorkspaceIdAtom)) updateSessionById(sessionId, { name })
    } catch (error) {
      console.error('[App] Failed to rename session:', error)
      toast.error('重命名会话失败')
    }
  }, [updateSessionById, store])

  const handleSendMessage = useCallback(async (sessionId: string, message: string, attachments?: FileAttachment[], skillSlugs?: string[], externalBadges?: ContentBadge[], sendOptions?: Pick<SendMessageOptions, 'oneTimeContext' | 'workspaceFreshnessContext' | 'hideUserMessage'> & { forceQueuedUserMessage?: boolean }) => {
    try {
      const session = store.get(sessionAtomFamily(sessionId))
      const connectionSlug = resolveEffectiveConnectionSlug(
        session?.llmConnection,
        workspaceDefaultLlmConnection,
        llmConnections,
      )
      if (connectionSlug && isManagedLlmConnectionSlug(connectionSlug)) {
        const auth = await loadClientAuthState()
        if (auth && !auth.user) {
          navigate(routes.view.settings('profile'))
          toast.info('请先登录以使用 Storyflow 托管模型')
          return 'rejected' as const
        }
      }

      const hideUserMessage = sendOptions?.hideUserMessage === true
      // Capture pre-send processing state so we can flag mid-stream sends
      // for the queued badge (#616 follow-up — covers Pi steer path which
      // returns status 'accepted', not 'queued').
      const sendingMidStream = sendOptions?.forceQueuedUserMessage === true
        || store.get(sessionAtomFamily(sessionId))?.isProcessing === true

      // Step 1: Store attachments and get persistent metadata
      let storedAttachments: StoredAttachment[] | undefined
      let processedAttachments: FileAttachment[] | undefined

      if (attachments?.length) {
        // Store immutable originals and derive reusable representations.
        // Use allSettled so one failure doesn't kill all attachments
        const storeResults = await Promise.allSettled(
          attachments.map(a => window.electronAPI.storeAttachment(sessionId, a))
        )

        // Filter successful stores, warn about failures
        storedAttachments = []
        const successfulAttachments: FileAttachment[] = []
        const modelInputBase64: Array<string | undefined> = []
        const modelInputMimeType: Array<string | undefined> = []
        storeResults.forEach((result, i) => {
          if (result.status === 'fulfilled') {
            storedAttachments!.push(result.value.attachment)
            successfulAttachments.push(attachments[i])
            modelInputBase64.push(result.value.modelInputBase64)
            modelInputMimeType.push(result.value.modelInputMimeType)
          } else {
            console.warn(`Failed to store attachment "${attachments[i].name}":`, result.reason)
          }
        })

        // Notify user about failed attachments
        const failedCount = storeResults.filter(r => r.status === 'rejected').length
        if (failedCount > 0) {
          console.warn(`${failedCount} attachment(s) failed to store`)
          // Add warning message to session so user knows some attachments weren't included
          const failedNames = attachments
            .filter((_, i) => storeResults[i].status === 'rejected')
            .map(a => a.name)
            .join(', ')
          updateSessionById(sessionId, (s) => ({
            messages: [...s.messages, {
              id: generateMessageId(),
              role: 'warning' as const,
              content: `⚠️ ${failedCount} attachment(s) could not be stored and will not be sent: ${failedNames}`,
              timestamp: Date.now()
            }]
          }))
        }

        // Step 2: Add durable representations and select bounded model-input bytes.
        processedAttachments = await Promise.all(
          successfulAttachments.map(async (att, i) => {
            const stored = storedAttachments?.[i]
            if (!stored) {
              console.error(`Missing stored attachment at index ${i}`)
              return att // Fall back to original
            }
            return {
              ...att,
              storedPath: stored.storedPath,
              markdownPath: stored.markdownPath,
              representations: stored.representations,
              base64: modelInputBase64[i] ?? att.base64,
              mimeType: modelInputMimeType[i] ?? att.mimeType,
            }
          })
        )
      }

      // Step 3: Extract badges from mentions (sources/skills) with embedded icons
      // Badges are self-contained for display in UserMessageBubble and viewer
      // Merge with any externally provided badges (e.g., from EditPopover context badges)
      const mentionBadges: ContentBadge[] = windowWorkspaceId
        ? extractBadges(message, skills, sources, windowWorkspaceId)
        : []
      const badges: ContentBadge[] = [...(externalBadges || []), ...mentionBadges]

      // Step 4.1: Detect SDK slash commands (e.g., /compact) and create command badges
      // This makes /compact render as an inline badge rather than raw text
      const commandMatch = message.match(/^\/([a-z]+)(\s|$)/i)
      if (commandMatch && commandMatch[1].toLowerCase() === 'compact') {
        const commandText = commandMatch[0].trimEnd() // "/compact" without trailing space
        badges.unshift({
          type: 'command',
          label: 'Compact',
          rawText: commandText,
          start: 0,
          end: commandText.length,
        })
      }

      // Step 4.2: Detect plan execution messages and create file badges
      // Pattern: "Read the plan at <path> and execute it."
      // This is sent after compaction when accepting a plan, displays as clickable file badge
      // Only the file path is replaced with a badge - surrounding text remains visible
      const planExecuteMatch = message.match(/^(Read the plan at )(.+?)( and execute it\.?)$/i)
      if (planExecuteMatch) {
        const prefix = planExecuteMatch[1]      // "Read the plan at "
        const filePath = planExecuteMatch[2]    // the actual path
        const fileName = filePath.split('/').pop() || 'plan.md'
        badges.push({
          type: 'file',
          label: fileName,
          rawText: filePath,
          filePath: filePath,
          start: prefix.length,
          end: prefix.length + filePath.length,
        })
      }

      // Step 5: Create user message with StoredAttachments (for UI display)
      // Mark as isPending for optimistic UI — will be confirmed by user_message
      // event. Flag mid-stream sends as queued so the composer queue preview
      // appears immediately. The backend now treats ordinary mid-stream sends
      // as queue-only; explicit interruption is a separate queued-item action.
      const optimisticMessageId = hideUserMessage ? undefined : generateMessageId()

      if (!hideUserMessage) {
        const userMessage: Message = {
          id: optimisticMessageId!,
          role: 'user',
          content: message,
          timestamp: Date.now(),
          attachments: storedAttachments,
          badges: badges.length > 0 ? badges : undefined,
          isPending: true,  // Optimistic - will be confirmed by backend
          isQueued: sendingMidStream,
        }

        // Optimistic UI update - add user message and set processing state
        updateSessionById(sessionId, (s) => ({
          messages: [...s.messages, userMessage],
          isProcessing: true,
          lastMessageAt: Date.now()
        }))
      } else {
        updateSessionById(sessionId, {
          isProcessing: true,
          lastMessageAt: Date.now()
        })
      }

      // Step 6: Send to Claude with processed attachments + stored attachments for persistence
      await window.electronAPI.sendMessage(sessionId, message, processedAttachments, storedAttachments, {
        skillSlugs,
        badges: badges.length > 0 ? badges : undefined,
        optimisticMessageId,
        oneTimeContext: sendOptions?.oneTimeContext,
        workspaceFreshnessContext: sendOptions?.workspaceFreshnessContext,
        hideUserMessage,
      })
      return 'accepted' as const
    } catch (error) {
      console.error('Failed to send message:', error)
      updateSessionById(sessionId, (s) => ({
        isProcessing: false,
        messages: [
          ...s.messages,
          {
            id: generateMessageId(),
            role: 'error' as const,
            content: `Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`,
            timestamp: Date.now()
          }
        ]
      }))
      return 'unknown' as const
    }
  }, [
    updateSessionById,
    skills,
    sources,
    windowWorkspaceId,
    store,
    workspaceDefaultLlmConnection,
    llmConnections,
    loadClientAuthState,
  ])

  /**
   * Unified handler for all session option changes.
   * Handles persistence and backend sync for each option type.
   */
  const handleSessionOptionsChange = useCallback((sessionId: string, updates: SessionOptionUpdates) => {
    setSessionOptions(prev => updateSessionOptionsMap(prev, sessionId, updates))

    // Handle persistence/backend for specific options
    if (updates.permissionMode !== undefined) {
      // Sync permission mode change with backend
      window.electronAPI.sessionCommand(sessionId, { type: 'setPermissionMode', mode: updates.permissionMode })
    }
    if (updates.thinkingLevel !== undefined) {
      // Sync thinking level change with backend (session-level, persisted)
      window.electronAPI.sessionCommand(sessionId, { type: 'setThinkingLevel', level: updates.thinkingLevel })
    }
  }, [])

  // Handle input draft changes per session with debounced persistence
  const draftSaveTimeoutRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Cleanup draft save timers on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      draftSaveTimeoutRef.current.forEach(clearTimeout)
      draftSaveTimeoutRef.current.clear()
    }
  }, [])

  // Getter for draft text - reads from ref without triggering re-renders
  const getDraft = useCallback((sessionId: string): string => {
    const draft = sessionDraftsRef.current.get(sessionId) as unknown
    const text = draft && typeof draft === 'object'
      ? (draft as { text?: unknown }).text
      : draft
    return coerceInputText(text)
  }, [])

  // Getter for persisted attachment refs (path + name only — not hydrated files).
  // Consumers that need FileAttachment objects should call hydrateDraftAttachments.
  const getDraftAttachmentRefs = useCallback((sessionId: string): DraftAttachmentRef[] => {
    const attachments = sessionDraftsRef.current.get(sessionId)?.attachments
    return Array.isArray(attachments) ? attachments : []
  }, [])

  // Hydrate persisted attachment refs into full FileAttachment objects.
  //  - Track C (ref.content set): reconstruct directly from the inlined bytes.
  //  - Track P (path-only): re-read from disk via the readUserAttachment RPC.
  // Missing/moved files on Track P are silently dropped with a console warn — same
  // UX as any other editor draft restore when the backing file is gone.
  const hydrateDraftAttachments = useCallback(async (sessionId: string): Promise<FileAttachment[]> => {
    const attachments = sessionDraftsRef.current.get(sessionId)?.attachments
    const refs = Array.isArray(attachments) ? attachments : []
    if (refs.length === 0) return []
    const results = await Promise.all(
      refs.map(async (ref) => {
        if (ref.content) {
          return attachmentFromContentRef(ref)
        }
        try {
          const attachment = await window.electronAPI.readUserAttachment(ref.path)
          if (!attachment) {
            console.warn('[drafts] Attachment missing on restore, dropping:', ref.path)
            return null
          }
          return { ...attachment, name: ref.name }
        } catch (err) {
          console.warn('[drafts] Failed to restore attachment, dropping:', ref.path, err)
          return null
        }
      })
    )
    return results.filter((a): a is FileAttachment => a !== null)
  }, [])

  // Write a debounced snapshot of the current ref entry to disk.
  const schedulePersistDraft = useCallback((sessionId: string) => {
    const existingTimeout = draftSaveTimeoutRef.current.get(sessionId)
    if (existingTimeout) {
      clearTimeout(existingTimeout)
    }
    const timeout = setTimeout(() => {
      const draft = sessionDraftsRef.current.get(sessionId) ?? { text: '' }
      window.electronAPI.setDraft(sessionId, draft)
      draftSaveTimeoutRef.current.delete(sessionId)
    }, DRAFT_SAVE_DEBOUNCE_MS)
    draftSaveTimeoutRef.current.set(sessionId, timeout)
  }, [])

  const handleInputChange = useCallback((sessionId: string, value: string) => {
    const text = coerceInputText(value)
    const existing = sessionDraftsRef.current.get(sessionId)
    const existingAttachments = Array.isArray(existing?.attachments) ? existing.attachments : []
    const nextDraft: SessionDraft = {
      text,
      ...(existingAttachments.length > 0
        ? { attachments: existingAttachments }
        : {}),
    }
    const isEmpty = !nextDraft.text && (!nextDraft.attachments || nextDraft.attachments.length === 0)
    if (isEmpty) {
      sessionDraftsRef.current.delete(sessionId)
    } else {
      sessionDraftsRef.current.set(sessionId, nextDraft)
    }
    schedulePersistDraft(sessionId)
  }, [schedulePersistDraft])

  const handleAttachmentsChange = useCallback((sessionId: string, attachments: FileAttachment[]) => {
    const existing = sessionDraftsRef.current.get(sessionId)
    const refs: DraftAttachmentRef[] = []
    for (const a of attachments) {
      const ref = toDraftRef(a)
      if (ref) {
        refs.push(ref)
      } else {
        console.warn('[drafts] attachment exceeds per-draft size cap, not persisted:', a.name, a.size)
      }
    }
    const nextDraft: SessionDraft = {
      text: coerceInputText(existing?.text),
      ...(refs.length > 0 ? { attachments: refs } : {}),
    }
    const isEmpty = !nextDraft.text && (!nextDraft.attachments || nextDraft.attachments.length === 0)
    if (isEmpty) {
      sessionDraftsRef.current.delete(sessionId)
    } else {
      sessionDraftsRef.current.set(sessionId, nextDraft)
    }
    schedulePersistDraft(sessionId)
  }, [schedulePersistDraft])

  // Open new chat - creates session and selects it
  // Used by components via AppShellContext and for programmatic navigation
  const openNewChat = useCallback(async (params: NewChatActionParams = {}) => {
    if (!windowWorkspaceId) {
      console.warn('[App] Cannot open new chat: no workspace ID')
      return
    }

    const session = await handleCreateSession(windowWorkspaceId)

    if (params.name) {
      await window.electronAPI.sessionCommand(session.id, { type: 'rename', name: params.name })
    }

    // Seed the draft before navigation so ChatPage reads it on its first render.
    if (params.input) {
      handleInputChange(session.id, params.input)
    }

    // Navigate to the chat view - this sets both selectedSession and activeView
    navigate(routes.view.allSessions(session.id))
  }, [windowWorkspaceId, handleCreateSession, handleInputChange])

  const handleRespondToPermission = useCallback(async (
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: import('../shared/types').PermissionResponseOptions,
  ) => {
    await window.electronAPI.respondToPermission(sessionId, requestId, allowed, alwaysAllow, options)
    setPendingPermissions(prev => removeFirstRequestForSession(prev, sessionId))
  }, [])

  const handleRespondToCredential = useCallback(async (sessionId: string, requestId: string, response: CredentialResponse) => {
    await window.electronAPI.respondToCredential(sessionId, requestId, response)
    setPendingCredentials(prev => removeFirstRequestForSession(prev, sessionId))
  }, [])

  const handleRespondToUserQuestion = useCallback(async (
    sessionId: string,
    requestId: string,
    response: import('../shared/types').UserQuestionResponse,
  ) => {
    await window.electronAPI.respondToUserQuestion(sessionId, requestId, response)
    setPendingUserQuestions(current => removeFirstRequestForSession(current, sessionId))
  }, [])

  // Centralized link interceptor: classifies file types and decides whether to
  // show an in-app preview overlay or open externally. Replaces the old
  // handleOpenFile/handleOpenUrl that always opened in external apps.
  const linkInterceptor = useLinkInterceptor({
    openFileExternal: async (path) => {
      try {
        await window.electronAPI.openFile(path)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        console.error('Failed to open file:', error)
        toast.error(t('toast.failedToOpenFile'), {
          description: message,
        })
      }
    },
    openUrl: async (url) => {
      try {
        await window.electronAPI.openUrl(url)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        console.error('Failed to open URL:', error)
        toast.error(t('toast.failedToOpenLink'), {
          description: `${message}. If this is a local path, use Open File instead.`,
        })
      }
    },
    showInFolder: async (path) => {
      try {
        await window.electronAPI.showInFolder(path)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        console.error('Failed to show in folder:', error)
        toast.error(t("toast.failedToReveal", { fileManager: getFileManagerName() }), {
          description: message,
        })
      }
    },
    readFile: (path) => window.electronAPI.readFile(path),
    readFileDataUrl: (path) => window.electronAPI.readFileDataUrl(path),
    readFileBinary: (path) => window.electronAPI.readFileBinary(path),
  })

  const connectionState = useTransportConnectionState()
  const showTransportConnectionBanner = shouldShowTransportConnectionBanner(connectionState)

  const handleReconnectTransport = useCallback(() => {
    void window.electronAPI.reconnectTransport().catch((error) => {
      const message = error instanceof Error ? error.message : 'Unknown error'
      toast.error(t('toast.reconnectFailed'), { description: message })
    })
  }, [])

  const handleOpenFile = linkInterceptor.handleOpenFile
  const handleOpenUrl = linkInterceptor.handleOpenUrl

  const handleOpenSettings = useCallback(() => {
    navigate(routes.view.settings())
  }, [])

  const handleOpenKeyboardShortcuts = useCallback(() => {
    navigate(routes.view.settings('shortcuts'))
  }, [])

  const handleOpenStoredUserPreferences = useCallback(() => {
    navigate(routes.view.settings('ai'))
  }, [])

  // Show reset confirmation dialog
  const handleReset = useCallback(() => {
    setShowResetDialog(true)
  }, [])

  // Execute reset after user confirms in dialog
  const executeReset = useCallback(async () => {
    try {
      await window.electronAPI.logout()
      // Reset all state
      // Clear session atoms - initialize with empty array clears all per-session atoms
      initializeSessions([])
      setWorkspaces([])
      setWindowWorkspaceId(null)
      setRuntimeWorkspace(null)
      setActiveProjectId(null)
      await refreshLlmConnections()
      await loadClientAuthState()
      setAppState('project-hub')
    } catch (error) {
      console.error('Reset failed:', error)
    } finally {
      setShowResetDialog(false)
    }
  }, [initializeSessions, loadClientAuthState, refreshLlmConnections, setRuntimeWorkspace])

  const activateRuntimeWorkspace = useCallback(async (
    workspaceId: string,
    landingRoute?: Route,
  ) => {
    const nextWorkspace = await withTimeout(
      window.electronAPI.resolveRuntimeWorkspace(workspaceId),
      WORKSPACE_SWITCH_RPC_TIMEOUT_MS,
      'resolveRuntimeWorkspace'
    )
    if (!nextWorkspace) throw new Error(`Workspace not found: ${workspaceId}`)

    if (workspaceId === windowWorkspaceId) {
      setRuntimeWorkspace(nextWorkspace)
      if (workspaceId !== FREE_CONVERSATION_WORKSPACE_ID) setActiveProjectId(workspaceId)
      if (landingRoute) setPendingReadyRoute(landingRoute)
      setAppState('ready')
      return
    }

    const selectionGeneration = ++workspaceSelectionGenerationRef.current
    workspaceSwitchInFlightRef.current = workspaceId

    setRuntimeWorkspace(nextWorkspace)
    setWindowWorkspaceId(workspaceId)
    if (workspaceId !== FREE_CONVERSATION_WORKSPACE_ID) setActiveProjectId(workspaceId)

    setSessionsLoaded(false)
    setSessionLoadError(null)
    setSession({ selected: null })
    setPendingPermissions(new Map())
    setPendingCredentials(new Map())
    setPendingUserQuestions(new Map())
    setSessionOptions(new Map())
    sessionDraftsRef.current.clear()
    store.set(sourcesAtom, [])
    store.set(skillsAtom, [])
    store.set(sessionMetadataReadyAtom, false)
    store.set(sessionMetaMapAtom, new Map())
    store.set(sessionIdsAtom, [])

    try {
      await withTimeout(
        window.electronAPI.switchWorkspace(workspaceId),
        WORKSPACE_SWITCH_RPC_TIMEOUT_MS,
        'switchWorkspace'
      )
      await loadSessionsFromServer(workspaceId, selectionGeneration)
      if (selectionGeneration !== workspaceSelectionGenerationRef.current) return
      if (pendingCreatedWorkspaceRef.current?.id === workspaceId) {
        pendingCreatedWorkspaceRef.current = null
      }
      if (landingRoute) setPendingReadyRoute(landingRoute)
      setAppState('ready')
    } catch (error) {
      if (selectionGeneration !== workspaceSelectionGenerationRef.current) return
      console.error('[App] Failed to activate runtime workspace:', error)
      setSessionLoadError(formatSessionLoadFailure(error))
      store.set(sessionMetadataReadyAtom, true)
      setSessionsLoaded(true)
      lastLoadedSessionsWorkspaceRef.current = workspaceId
    } finally {
      if (workspaceSwitchInFlightRef.current === workspaceId) {
        workspaceSwitchInFlightRef.current = null
      }
    }
  }, [loadSessionsFromServer, setRuntimeWorkspace, setSession, store, windowWorkspaceId])

  // Handle project selection. The project catalog remains independent from the
  // active runtime, while project switches continue to reuse the existing
  // transport and session hydration path.
  const handleSelectWorkspace = useCallback(async (workspaceId: string, openInNewWindow = false) => {
    if (openInNewWindow) {
      window.electronAPI.openWorkspace(workspaceId)
      return
    }
    await activateRuntimeWorkspace(
      workspaceId,
      routes.view.writing(),
    )
  }, [activateRuntimeWorkspace])

  // Explicit cross-domain jump: switch the runtime to the owning project and
  // land directly on the chosen session. The rail lists project conversations,
  // but selecting one always moves the whole runtime — never an overlay that
  // merges two domains (ADR 0006).
  const handleSelectProjectSession = useCallback(async (workspaceId: string, sessionId: string) => {
    await activateRuntimeWorkspace(workspaceId, routes.view.allSessions(sessionId))
  }, [activateRuntimeWorkspace])

  // New URLs use stable Host IDs; legacy slug URLs remain readable.
  const handleSwitchWorkspaceByRouteKey = useCallback((routeKey: string) => {
    if (routeKey === FREE_CONVERSATION_WORKSPACE_ID || routeKey === FREE_CONVERSATION_WORKSPACE_SLUG) {
      void activateRuntimeWorkspace(FREE_CONVERSATION_WORKSPACE_ID)
      return true
    }
    const target = findWorkspaceByRouteKey(workspaces, routeKey)
    if (!target) return false
    void activateRuntimeWorkspace(target.id)
    return true
  }, [workspaces, activateRuntimeWorkspace])

  // Handle workspace refresh (e.g., after icon upload)
  const handleRefreshWorkspaces = useCallback(() => {
    window.electronAPI.getWorkspaces().then(setWorkspaces)
  }, [setWorkspaces])

  const handleRelinkProjectFromHub = useCallback(async (workspaceId: string) => {
    try {
      const rootPath = await window.electronAPI.openFolderDialog()
      if (!rootPath) return

      await window.electronAPI.relinkWorkspace(workspaceId, rootPath)
      const refreshed = await window.electronAPI.getWorkspaces()
      setWorkspaces(refreshed)
      toast.success(t('toast.workspaceReconnected'))
      await handleSelectWorkspace(workspaceId)
    } catch (error) {
      console.error('[App] Failed to relink project:', error)
      toast.error(t('toast.reconnectFailed'), {
        description: error instanceof Error ? error.message : t('toast.unknownError'),
      })
      handleRefreshWorkspaces()
    }
  }, [handleRefreshWorkspaces, handleSelectWorkspace, setWorkspaces, t])

  const handleRenameProjectFromHub = useCallback(async (workspaceId: string, name: string) => {
    const nextName = name.trim()
    if (!nextName) return

    setWorkspaces(prev => prev.map(workspace =>
      workspace.id === workspaceId ? { ...workspace, name: nextName } : workspace
    ))

    try {
      await window.electronAPI.updateWorkspaceSetting(workspaceId, 'name', nextName)
      const refreshed = await window.electronAPI.getWorkspaces()
      setWorkspaces(refreshed)
      toast.success(`已重命名为 ${nextName}`)
    } catch (error) {
      console.error('[App] Failed to rename project:', error)
      toast.error('重命名项目失败')
      handleRefreshWorkspaces()
    }
  }, [handleRefreshWorkspaces, setWorkspaces])

  const handleRemoveProjectFromHub = useCallback(async (workspaceId: string) => {
    const project = workspaces.find(workspace => workspace.id === workspaceId)

    try {
      const removed = await window.electronAPI.removeWorkspace(workspaceId)
      if (!removed) {
        toast.error('移除项目失败')
        return
      }

      setWorkspaces(prev => prev.filter(workspace => workspace.id !== workspaceId))
      if (workspaceId === activeProjectId) {
        setActiveProjectId(null)
      }
      if (runtimeWorkspace?.id === workspaceId) {
        setRuntimeWorkspace(null)
        setWindowWorkspaceId(null)
        setAppState('project-hub')
      }

      const refreshed = await window.electronAPI.getWorkspaces()
      setWorkspaces(refreshed)
      toast.success(`已移除${project ? `：${project.name}` : '项目'}`)
    } catch (error) {
      console.error('[App] Failed to remove project:', error)
      toast.error('移除项目失败')
      handleRefreshWorkspaces()
    }
  }, [activeProjectId, handleRefreshWorkspaces, runtimeWorkspace, setRuntimeWorkspace, setWindowWorkspaceId, setWorkspaces, workspaces])

  const handleSetProjectArchived = useCallback(async (workspaceId: string, archived: boolean) => {
    const project = workspaces.find(workspace => workspace.id === workspaceId)

    try {
      const updated = await window.electronAPI.setWorkspaceArchived(workspaceId, archived)
      if (!updated) {
        toast.error(archived ? '归档项目失败' : '恢复项目失败')
        return
      }

      const refreshed = await window.electronAPI.getWorkspaces()
      setWorkspaces(refreshed)

      if (archived && runtimeWorkspace?.id === workspaceId) {
        setRuntimeWorkspace(null)
        setWindowWorkspaceId(null)
        setActiveProjectId(null)
        setAppState('project-hub')
      }

      toast.success(`${archived ? '已归档' : '已恢复'}${project ? `：${project.name}` : '项目'}`)
    } catch (error) {
      console.error(`[App] Failed to ${archived ? 'archive' : 'restore'} project:`, error)
      toast.error(archived ? '归档项目失败' : '恢复项目失败')
      handleRefreshWorkspaces()
    }
  }, [handleRefreshWorkspaces, runtimeWorkspace, setRuntimeWorkspace, setWindowWorkspaceId, setWorkspaces, workspaces])

  const handleWorkspaceCreated = useCallback(async (workspace: Workspace) => {
    pendingCreatedWorkspaceRef.current = workspace

    setWorkspaces(prev => {
      const existingIndex = prev.findIndex(item => item.id === workspace.id)
      if (existingIndex === -1) return [...prev, workspace]

      const next = [...prev]
      next[existingIndex] = workspace
      return next
    })

    try {
      const refreshed = await window.electronAPI.getWorkspaces()
      setWorkspaces(prev => {
        const canonical = refreshed.length > 0 ? refreshed : prev
        const existingIndex = canonical.findIndex(item => item.id === workspace.id)
        if (existingIndex === -1) return [...canonical, workspace]

        const next = [...canonical]
        next[existingIndex] = workspace
        return next
      })
    } catch (error) {
      console.error('[App] Failed to refresh workspaces after creation:', error)
    }
  }, [setWorkspaces])

  const handleAddLocalProject = useCallback(async () => {
    if (addLocalProjectInFlightRef.current) return
    addLocalProjectInFlightRef.current = true
    setIsAddingLocalProject(true)

    try {
      const rootPath = await window.electronAPI.openFolderDialog()
      if (!rootPath) return

      const name = getPathBasename(rootPath)
      if (!name) throw new Error('无法从所选文件夹确定项目名称')

      const workspace = await window.electronAPI.createWorkspace(rootPath, name)
      const alreadyRegistered = workspaces.some(candidate => candidate.id === workspace.id)
      await handleWorkspaceCreated(workspace)
      if (!alreadyRegistered && !storage.get(storage.KEYS.firstRunTourCompleted, false)) {
        storage.set(storage.KEYS.firstRunTourPending, true)
      }
      clearReturnLocation()
      await activateRuntimeWorkspace(workspace.id, routes.view.writing())
    } catch (error) {
      toast.error('添加项目失败', {
        description: error instanceof Error ? error.message : 'Unknown error',
      })
    } finally {
      addLocalProjectInFlightRef.current = false
      setIsAddingLocalProject(false)
    }
  }, [
    activateRuntimeWorkspace,
    clearReturnLocation,
    handleWorkspaceCreated,
    workspaces,
  ])

  const handleClientSignedIn = useCallback(async () => {
    await loadClientAuthState()
  }, [loadClientAuthState])

  const handleClientSignOut = useCallback(async () => {
    await window.electronAPI.signOutClient()
    await loadClientAuthState()
  }, [loadClientAuthState])

  const handleReturnToActiveProject = useCallback(() => {
    if (!activeProjectId) return
    void activateRuntimeWorkspace(
      activeProjectId,
      consumeReturnRoute(routes.view.writing()),
    )
  }, [activeProjectId, activateRuntimeWorkspace, consumeReturnRoute])

  const fallbackRuntimeWorkspaceId = useMemo(() => {
    const recentWorkspace = workspaces.reduce<Workspace | null>((current, workspace) => {
      if (workspace.id === FREE_CONVERSATION_WORKSPACE_ID) return current
      if (!current) return workspace
      const currentAccessedAt = current.lastAccessedAt ?? 0
      const workspaceAccessedAt = workspace.lastAccessedAt ?? 0
      return workspaceAccessedAt > currentAccessedAt ? workspace : current
    }, null)
    return recentWorkspace?.id ?? null
  }, [workspaces])
  const runtimeNavigationWorkspaceId = windowWorkspaceId
    ?? activeProjectId
    ?? fallbackRuntimeWorkspaceId

  const handleOpenRuntimeRoute = useCallback((route: Route) => {
    const targetWorkspaceId = runtimeNavigationWorkspaceId
    if (!targetWorkspaceId) return
    if (targetWorkspaceId !== windowWorkspaceId) {
      void activateRuntimeWorkspace(targetWorkspaceId, route)
      return
    }
    setPendingReadyRoute(route)
    setAppState('ready')
  }, [activateRuntimeWorkspace, runtimeNavigationWorkspaceId, windowWorkspaceId])

  const handleOpenGlobalSettings = useCallback((subpage: SettingsSubpage = 'app') => {
    const route = routes.view.settings(subpage)
    if (appState === 'project-hub' || !runtimeNavigationWorkspaceId) {
      setGlobalSettingsSubpage(subpage)
      return
    }
    handleOpenRuntimeRoute(route)
  }, [appState, handleOpenRuntimeRoute, runtimeNavigationWorkspaceId])

  const handleOpenRuntimeSearch = useCallback(async () => {
    const targetWorkspaceId = runtimeNavigationWorkspaceId
    if (!targetWorkspaceId) return
    if (targetWorkspaceId !== windowWorkspaceId) {
      await activateRuntimeWorkspace(targetWorkspaceId)
    }
    setOpenGlobalSearchSignal(signal => signal + 1)
    setAppState('ready')
  }, [activateRuntimeWorkspace, runtimeNavigationWorkspaceId, windowWorkspaceId])

  const handleOpenRuntimeWhatsNew = useCallback(async () => {
    const targetWorkspaceId = runtimeNavigationWorkspaceId ?? FREE_CONVERSATION_WORKSPACE_ID
    if (targetWorkspaceId !== windowWorkspaceId) {
      await activateRuntimeWorkspace(targetWorkspaceId)
    }
    setOpenWhatsNewSignal(signal => signal + 1)
    setAppState('ready')
  }, [activateRuntimeWorkspace, runtimeNavigationWorkspaceId, windowWorkspaceId])

  const handleOpenWritingWorkspace = useCallback(() => {
    if (!activeProjectId) return
    void activateRuntimeWorkspace(
      activeProjectId,
      routes.view.writing(),
    )
  }, [activeProjectId, activateRuntimeWorkspace])

  const handleOpenFreeConversations = useCallback((options?: { createNew?: boolean }) => {
    const targetRoute = options?.createNew ? routes.action.newSession() : routes.view.allSessions()
    if (windowWorkspaceId === FREE_CONVERSATION_WORKSPACE_ID) {
      navigate(targetRoute)
      return
    }
    return activateRuntimeWorkspace(FREE_CONVERSATION_WORKSPACE_ID, targetRoute)
  }, [activateRuntimeWorkspace, windowWorkspaceId])

  useEffect(() => {
    if (appState !== 'ready' || !pendingReadyRoute) return

    // NavigationProvider is mounted before this parent effect runs, so dispatch
    // the landing route immediately. Scheduling it in an animation frame made
    // clearing the pending state cancel that same frame during effect cleanup.
    navigate(pendingReadyRoute)
    setPendingReadyRoute(null)
  }, [appState, pendingReadyRoute])

  const projectManagerActions = useMemo(() => ({
    onAddLocalProject: handleAddLocalProject,
    isAddingLocalProject,
    onOpenProjectInNewWindow: (workspaceId: string) => {
      void window.electronAPI.openWorkspace(workspaceId)
    },
    onRelinkProject: (workspaceId: string) => {
      void handleRelinkProjectFromHub(workspaceId)
    },
    onRenameProject: (workspaceId: string, name: string) => {
      void handleRenameProjectFromHub(workspaceId, name)
    },
    onSetProjectArchived: (workspaceId: string, archived: boolean) => {
      void handleSetProjectArchived(workspaceId, archived)
    },
    onRemoveProject: (workspaceId: string) => {
      void handleRemoveProjectFromHub(workspaceId)
    },
  }), [
    handleAddLocalProject,
    handleRelinkProjectFromHub,
    handleRemoveProjectFromHub,
    handleRenameProjectFromHub,
    handleSetProjectArchived,
    isAddingLocalProject,
  ])

  const activityRailProfile = useMemo(() => {
    const user = clientAuthState?.user
    const email = user?.email?.trim()
    const name = user?.name?.trim() || email || user?.userId || '本地用户'
    return {
      name,
      detail: email && email !== name ? email : undefined,
      avatarUrl: user?.avatarUrl,
    }
  }, [clientAuthState])

  // Shared by account / project-hub ActivityRailFrame (and ready shell project actions).
  const canOpenRuntimeNavigation = Boolean(runtimeNavigationWorkspaceId)
  const activityRailProjectProps = useMemo(() => ({
    workspaces,
    activeWorkspaceId: activeProjectId,
    profile: activityRailProfile,
    ...projectManagerActions,
    onSelectSession: (sessionId: string, workspaceId: string) => {
      clearReturnLocation()
      void handleSelectProjectSession(workspaceId, sessionId)
    },
    onOpenFreeConversations: handleOpenFreeConversations,
    onOpenSources: canOpenRuntimeNavigation
      ? () => handleOpenRuntimeRoute(routes.view.sources())
      : undefined,
    onOpenSkills: canOpenRuntimeNavigation
      ? () => handleOpenRuntimeRoute(routes.view.skills())
      : undefined,
    onOpenAutomations: canOpenRuntimeNavigation
      ? () => handleOpenRuntimeRoute(routes.view.automationsScheduled())
      : undefined,
    onOpenSearch: canOpenRuntimeNavigation ? handleOpenRuntimeSearch : undefined,
    onOpenSettings: handleOpenGlobalSettings,
    onOpenWhatsNew: handleOpenRuntimeWhatsNew,
    whatsNew: { unseen: hasUnseenReleaseNotes },
  }), [
    activeProjectId,
    activityRailProfile,
    canOpenRuntimeNavigation,
    clearReturnLocation,
    handleOpenFreeConversations,
    handleOpenRuntimeRoute,
    handleOpenRuntimeSearch,
    handleOpenRuntimeWhatsNew,
    handleOpenGlobalSettings,
    hasUnseenReleaseNotes,
    handleSelectProjectSession,
    projectManagerActions,
    workspaces,
  ])

  // Build context value for AppShell component
  // This is memoized to prevent unnecessary re-renders
  // IMPORTANT: Must be before early returns to maintain consistent hook order
  const appShellContextValue = useMemo<AppShellContextType>(() => ({
    // Data
    // NOTE: sessions is NOT included - use sessionMetaMapAtom for listing
    // and useSession(id) hook for individual sessions. This prevents memory leaks.
    workspaces,
    clientAuthState,
    onClientSignedIn: handleClientSignedIn,
    onClientSignOut: handleClientSignOut,
    runtimeWorkspace,
    activeProjectId,
    llmConnections,
    workspaceDefaultLlmConnection,
    refreshLlmConnections,
    getDraft,
    getDraftAttachmentRefs,
    hydrateDraftAttachments,
    // Session callbacks
    onCreateSession: handleCreateSession,
    onSendMessage: handleSendMessage,
    onRenameSession: handleRenameSession,
    onFlagSession: handleFlagSession,
    onUnflagSession: handleUnflagSession,
    onPinSession: handlePinSession,
    onUnpinSession: handleUnpinSession,
    onArchiveSession: handleArchiveSession,
    onUnarchiveSession: handleUnarchiveSession,
    onMarkSessionRead: handleMarkSessionRead,
    onMarkSessionUnread: handleMarkSessionUnread,
    onSetActiveViewingSession: handleSetActiveViewingSession,
    onSessionStatusChange: handleSessionStatusChange,
    onDeleteSession: handleDeleteSession,
    onRespondToPermission: handleRespondToPermission,
    onRespondToCredential: handleRespondToCredential,
    onRespondToUserQuestion: handleRespondToUserQuestion,
    // File/URL handlers
    onOpenFile: handleOpenFile,
    onOpenUrl: handleOpenUrl,
    // Workspace
    onSelectWorkspace: handleSelectWorkspace,
    onSelectProjectSession: handleSelectProjectSession,
    onRefreshWorkspaces: handleRefreshWorkspaces,
    onOpenWritingWorkspace: handleOpenWritingWorkspace,
    onOpenFreeConversations: handleOpenFreeConversations,
    // App actions
    onOpenSettings: handleOpenSettings,
    onOpenKeyboardShortcuts: handleOpenKeyboardShortcuts,
    onOpenStoredUserPreferences: handleOpenStoredUserPreferences,
    onReset: handleReset,
    // Session options
    onSessionOptionsChange: handleSessionOptionsChange,
    onInputChange: handleInputChange,
    onAttachmentsChange: handleAttachmentsChange,
    // New chat (via deep link navigation)
    openNewChat,
  }), [
    // NOTE: sessions removed to prevent memory leaks - components use atoms instead
    workspaces,
    clientAuthState,
    handleClientSignedIn,
    handleClientSignOut,
    runtimeWorkspace,
    activeProjectId,
    llmConnections,
    workspaceDefaultLlmConnection,
    refreshLlmConnections,
    getDraft,
    getDraftAttachmentRefs,
    hydrateDraftAttachments,
    handleCreateSession,
    handleSendMessage,
    handleRenameSession,
    handleFlagSession,
    handleUnflagSession,
    handlePinSession,
    handleUnpinSession,
    handleArchiveSession,
    handleUnarchiveSession,
    handleMarkSessionRead,
    handleMarkSessionUnread,
    handleSetActiveViewingSession,
    handleSessionStatusChange,
    handleDeleteSession,
    handleRespondToPermission,
    handleRespondToCredential,
    handleRespondToUserQuestion,
    handleOpenFile,
    handleOpenUrl,
    handleSelectWorkspace,
    handleSelectProjectSession,
    handleRefreshWorkspaces,
    handleOpenWritingWorkspace,
    handleOpenFreeConversations,
    handleOpenSettings,
    handleOpenKeyboardShortcuts,
    handleOpenStoredUserPreferences,
    handleReset,
    handleSessionOptionsChange,
    handleInputChange,
    handleAttachmentsChange,
    openNewChat,
  ])

  // Platform actions for @craft-agent/ui components (overlays, etc.)
  // Memoized to prevent re-renders when these callbacks don't change
  // NOTE: Must be defined before early returns to maintain consistent hook order
  const platformActions = useMemo(() => ({
    onOpenFile: handleOpenFile,
    onOpenUrl: handleOpenUrl,
    // Bypass link interceptor — opens file directly in system editor.
    // Used by overlay header badges (when already viewing a file, "Open" should launch editor).
    onOpenFileExternal: linkInterceptor.openFileExternal,
    // Read file contents as UTF-8 string (used by datatable/spreadsheet/html-preview src fields)
    onReadFile: (path: string) => window.electronAPI.readFile(path),
    // Read file as data URL (used by image-preview blocks)
    onReadFileDataUrl: (path: string) => window.electronAPI.readFileDataUrl(path),
    // Read file as binary Uint8Array (used by PDF preview blocks)
    onReadFileBinary: (path: string) => window.electronAPI.readFileBinary(path),
    // Reveal a file in the system file manager (Finder on macOS, Explorer on Windows, etc.)
    onRevealInFinder: (path: string) => {
      window.electronAPI.showInFolder(path).catch(() => {})
    },
    // Platform-specific file manager name for UI labels
    fileManagerName: getFileManagerName(),
    // Hide/show macOS traffic lights when fullscreen overlays are open
    onSetTrafficLightsVisible: (visible: boolean) => {
      window.electronAPI.setTrafficLightsVisible(visible)
    },
  }), [handleOpenFile, handleOpenUrl, linkInterceptor.openFileExternal])

  // Loading state - show splash screen
  if (appState === 'loading') {
    return <SplashScreen isExiting={false} />
  }

  // Project catalog — browsing stays in the rail; the main surface no longer duplicates it.
  if (appState === 'project-hub') {
    const hasActiveProjects = workspaces.some(workspace => (
      workspace.id !== FREE_CONVERSATION_WORKSPACE_ID
      && !workspace.archivedAt
    ))
    return (
      <DismissibleLayerProvider>
        <ModalProvider>
        <TooltipProvider delayDuration={0}>
          <WindowCloseHandler />
          {activeProjectId ? (
            <ProjectHubNavigationActions onReturn={handleReturnToActiveProject} />
          ) : null}
          <ActivityRailFrame
            activeItem="recent"
            {...activityRailProjectProps}
            onSignOut={clientAuthState?.user ? handleClientSignOut : undefined}
          >
            <div className="flex h-full min-h-0 flex-col items-center justify-center bg-[radial-gradient(ellipse_at_50%_30%,color-mix(in_oklab,var(--foreground)_4%,transparent),transparent_55%)] px-6 py-12">
              <p className="text-[14px] font-medium text-foreground/80">
                {hasActiveProjects ? '从左侧展开项目并选择对话' : '还没有项目'}
              </p>
              <p className="mt-1.5 text-[12px] text-muted-foreground">
                使用左侧“项目”旁的 + 添加本地文件夹
              </p>
              {activeProjectId && returnDestination ? (
                <button
                  type="button"
                  className="mt-5 text-[12px] text-muted-foreground/80 transition-colors hover:text-foreground"
                  onClick={handleReturnToActiveProject}
                >
                  返回 · {returnDestination}
                </button>
              ) : null}
            </div>
          </ActivityRailFrame>
          <AccountSettingsProvider value={{
            clientAuthState,
            workspaces,
            runtimeWorkspace,
            onClientSignedIn: handleClientSignedIn,
          }}>
            <SettingsDialog
              open={globalSettingsSubpage !== null}
              selectedSubpage={globalSettingsSubpage ?? 'app'}
              availableSubpages={GLOBAL_SETTINGS_SUBPAGES}
              onSelectSubpage={setGlobalSettingsSubpage}
              onClose={() => setGlobalSettingsSubpage(null)}
            />
          </AccountSettingsProvider>
        </TooltipProvider>
        </ModalProvider>
      </DismissibleLayerProvider>
    )
  }

  // Workspace picker — thin client with no workspace selected
  if (appState === 'workspace-picker') {
    return (
      <DismissibleLayerProvider>
        <ModalProvider>
          <WindowCloseHandler />
          <WorkspacePicker
            onSelectWorkspace={async (id) => {
              await window.electronAPI.switchWorkspace(id)
              setWindowWorkspaceId(id)
              setAppState('ready')
            }}
          />
        </ModalProvider>
      </DismissibleLayerProvider>
    )
  }

  // Show splash until exit animation completes
  const showSplash = !splashHidden

  // Ready state - main app with splash overlay during data loading
  return (
    <PlatformProvider actions={platformActions}>
      <FocusProvider>
        <DismissibleLayerProvider>
        <ModalProvider>
        <TooltipProvider delayDuration={0}>
        <NavigationProvider
          workspaceId={windowWorkspaceId}
          workspaceRouteKey={windowWorkspaceId}
          onSwitchWorkspaceByRouteKey={handleSwitchWorkspaceByRouteKey}
          onActivateWorkspace={activateRuntimeWorkspace}
          onCreateSession={handleCreateSession}
          onSendMessage={handleSendMessage}
          onInputChange={handleInputChange}
          getDraft={getDraft}
          onAutoDeleteEmptySession={handleAutoDeleteEmptySession}
          isReady={appState === 'ready'}
          isSessionsReady={sessionsLoaded}
          remoteWorkspaceId={windowRemoteWorkspaceId}
          defaultViewRoute={runtimeWorkspace?.id === FREE_CONVERSATION_WORKSPACE_ID
            ? routes.view.allSessions()
            : routes.view.writing()}
        >
          {/* Handle window close requests (X button, Cmd+W) - close modal first if open */}
          <WindowCloseHandler />

          {/* Splash screen overlay - fades out when fully ready */}
          {showSplash && (
            <SplashScreen
              isExiting={splashExiting}
              onExitComplete={handleSplashExitComplete}
            />
          )}

          {/* Main UI - always rendered, splash fades away to reveal it */}
          <div className="h-full flex flex-col text-foreground">
            {showTransportConnectionBanner && connectionState && (
              <TransportConnectionBanner
                state={connectionState}
                onRetry={handleReconnectTransport}
              />
            )}
            <div className="flex min-h-0 flex-1 flex-col">
              {sessionLoadError && (
                <SessionLoadErrorBanner
                  message={sessionLoadError}
                  onRetry={() => { void loadSessionsFromServer() }}
                />
              )}
              <React.Suspense fallback={(
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                  {t('writing.loadingWorkspace', '正在加载项目目录...')}
                </div>
              )}>
                <div className="min-h-0 flex-1">
                <WorkspaceSurface
                  shikiTheme={shikiTheme}
                  contextValue={appShellContextValue}
                  menuNewChatTrigger={menuNewChatTrigger}
                  openGlobalSearchSignal={openGlobalSearchSignal}
                  openWhatsNewSignal={openWhatsNewSignal}
                  onOpenWhatsNewSignalHandled={() => setOpenWhatsNewSignal(0)}
                  whatsNewManifest={whatsNewManifest}
                  hasUnseenReleaseNotes={hasUnseenReleaseNotes}
                  onReleaseNotesSeen={() => setHasUnseenReleaseNotes(false)}
                  profile={activityRailProfile}
                  onAddLocalProject={projectManagerActions.onAddLocalProject}
                  isAddingLocalProject={projectManagerActions.isAddingLocalProject}
                  onOpenProjectInNewWindow={projectManagerActions.onOpenProjectInNewWindow}
                  onRelinkProject={projectManagerActions.onRelinkProject}
                  onRenameProject={projectManagerActions.onRenameProject}
                  onSetProjectArchived={projectManagerActions.onSetProjectArchived}
                  onRemoveProject={projectManagerActions.onRemoveProject}
                />
                </div>
              </React.Suspense>
            </div>
            <ResetConfirmationDialog
              open={showResetDialog}
              onConfirm={executeReset}
              onCancel={() => setShowResetDialog(false)}
            />
          </div>

          {/* File preview overlay — rendered by the link interceptor when a previewable file is clicked */}
          {linkInterceptor.previewState && (
            <React.Suspense fallback={null}>
              <FilePreviewRenderer
                state={linkInterceptor.previewState}
                onClose={linkInterceptor.closePreview}
                loadDataUrl={linkInterceptor.readFileDataUrl}
                loadPdfData={linkInterceptor.readFileBinary}
                isDark={isDark}
              />
            </React.Suspense>
          )}
        </NavigationProvider>
        </TooltipProvider>
        </ModalProvider>
        </DismissibleLayerProvider>
      </FocusProvider>
    </PlatformProvider>
  )
}

export default function App() {
  return (
    <ActionRegistryProvider>
      <AppContent />
    </ActionRegistryProvider>
  )
}

/**
 * Component that handles window close requests.
 * Must be inside ModalProvider to access the modal registry.
 */
function WindowCloseHandler() {
  useWindowCloseHandler()
  return null
}
