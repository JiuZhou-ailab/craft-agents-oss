// input: Workspace catalog, scoped session metadata, session actions, update status, profile, and window chrome inset
// output: Peer pinned/free/project sections, scoped conversation actions, runtime status, and homepage-link sharing
// pos: Global navigation surface; every project subtree is fetched and selected through its own runtime domain (ADR 0006)

import * as React from 'react'
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Clock3,
  DatabaseZap,
  Download,
  Gift,
  Gauge,
  HelpCircle,
  LoaderCircle,
  LogOut,
  MessageSquarePlus,
  Settings,
  ShieldAlert,
  SquarePen,
  UserPlus,
  UserRound,
  Zap,
} from 'lucide-react'
import appPackage from '../../../../package.json'
import storyflowLogo from '@/assets/storyflow-logo.png'
import { atom, useAtom, useAtomValue, useStore } from 'jotai'
import { selectAtom } from 'jotai/utils'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
} from '@/components/ui/styled-dropdown'
import { RenameDialog } from '@/components/ui/rename-dialog'
import { CrossfadeAvatar } from '@/components/ui/avatar'
import { FeedbackDialog } from './FeedbackDialog'
import {
  ProjectFolderRow,
  RecentConversationRow,
  ActivityRailSessionList,
  type ActivityRailSessionActions,
} from './ActivityRailRows'
import { useActivityRailSessionOrder } from './use-activity-rail-session-order'
import { setSessionPinnedInMetas } from './activity-rail-session-order'
import {
  extractSessionMeta,
  sessionMetaMapAtom,
  sessionMetadataReadyAtom,
  type SessionMeta,
} from '@/atoms/sessions'
import { shouldRefreshGlobalSessionMetasForEvent } from '@/atoms/session-status-transition'
import * as storage from '@/lib/local-storage'
import { getSessionTitle, hasSessionHistoryContent } from '@/utils/session'
import { FREE_CONVERSATION_WORKSPACE_ID } from '@craft-agent/shared/protocol'
import { deriveSessionRuntimeStatus, requiresHumanAttention } from '@craft-agent/shared/statuses/runtime'
import { sessionIdsWithPendingPromptAtom } from '@/atoms/pending-requests'
import type { SettingsSubpage, Workspace } from '../../../shared/types'
import { WINDOW_TITLE_BAR_HEIGHT } from './layout-constants'
import type { UpdateIndicatorState } from '@/lib/update-indicator'
import { useFocusActions } from '@/context/FocusContext'
import { useFocusZone } from '@/hooks/keyboard'

export type ActivityRailItemId =
  | 'recent'
  | 'writing'
  | 'sources'
  | 'skills'
  | 'automations'
  | 'settings'
  | 'search'

export interface ActivityRailProps {
  activeItem: ActivityRailItemId
  workspaces?: Workspace[]
  /** Runtime whose local session atom is authoritative for immediate lifecycle updates. */
  runtimeWorkspaceId?: string | null
  activeWorkspaceId?: string | null
  activeSessionId?: string | null
  /**
   * Selects any conversation, free or project. The handler decides whether it is
   * an in-domain focus or an explicit cross-domain runtime switch (ADR 0006).
   */
  onSelectSession?: (sessionId: string, workspaceId: string) => void | Promise<void>
  /** The currently open project session, so its nested row can render as active. */
  activeProjectSessionId?: string | null
  onCreateConversationInProject?: (workspaceId: string) => void | Promise<void>
  onAddLocalProject?: () => void | Promise<void>
  isAddingLocalProject?: boolean
  onOpenProjectInNewWindow?: (workspaceId: string) => void
  onRelinkProject?: (workspaceId: string) => void | Promise<void>
  onRenameProject?: (workspaceId: string, name: string) => void | Promise<void>
  onSetProjectArchived?: (workspaceId: string, archived: boolean) => void | Promise<void>
  onRemoveProject?: (workspaceId: string) => void | Promise<void>
  /** Opens the free-conversation runtime and optionally creates a fresh conversation. */
  onOpenFreeConversations?: (options?: { createNew?: boolean }) => void | Promise<void>
  onOpenSources?: () => void
  onOpenSkills?: () => void
  onOpenAutomations?: () => void
  onOpenSettings?: (subpage?: SettingsSubpage) => void
  width?: number
  onWidthChange?: (width: number) => void
  onSignOut?: () => void | Promise<void>
  profile?: {
    name: string
    detail?: string
    avatarUrl?: string
  }
  /** Optional release-notes surface inside the help menu. */
  onOpenWhatsNew?: () => void
  whatsNew?: {
    unseen: boolean
  }
  updateIndicator?: UpdateIndicatorState | null
  onInstallUpdate?: () => void | Promise<void>
  sessionActions?: ActivityRailSessionActions
}

export type { ActivityRailSessionActions } from './ActivityRailRows'

export const ACTIVITY_RAIL_WIDTH = 240
export const ACTIVITY_RAIL_MIN_WIDTH = 200
export const ACTIVITY_RAIL_MAX_WIDTH = 360
const RECENT_SESSION_LIMIT = 5
const PROJECT_WORKSPACE_LIMIT = 8
const activityFreeSessionMetasAtom = atom<SessionMeta[] | null>(null)
const activityExpandedProjectIdsAtom = atom<Set<string>>(new Set<string>())
const activityProjectSessionMetasAtom = atom<Record<string, SessionMeta[]>>({})
const activityActiveWorkspaceIdsAtom = atom<Set<string>>(new Set<string>())
const activityShowAllRecentAtom = atom(false)
const activityShowAllProjectsAtom = atom(false)
const activityArchivedExpandedAtom = atom(false)
const activitySidebarScrollTopAtom = atom(0)
const activityUnreadByWorkspaceAtom = atom<Record<string, boolean> | null>(null)
const runtimeSessionMetasAtom = selectAtom(
  sessionMetaMapAtom,
  (metas) => [...metas.values()],
  (left, right) => left.length === right.length && left.every((meta, index) => meta === right[index]),
)

export function resolveActivityWorkspaceSessionMetas(
  workspaceId: string,
  runtimeWorkspaceId: string | null | undefined,
  cachedMetas: readonly SessionMeta[] | undefined,
  runtimeMetas: readonly SessionMeta[],
  runtimeMetadataReady = true,
  remoteWorkspaceId?: string,
): readonly SessionMeta[] {
  return runtimeWorkspaceId === workspaceId && runtimeMetadataReady
    ? runtimeMetas
      .filter(meta => meta.workspaceId === workspaceId || (remoteWorkspaceId && meta.workspaceId === remoteWorkspaceId))
      .map(meta => meta.workspaceId === workspaceId ? meta : { ...meta, workspaceId })
    : cachedMetas ?? []
}

export function ActivityRail({
  activeItem,
  workspaces = [],
  runtimeWorkspaceId = null,
  activeWorkspaceId = null,
  activeSessionId = null,
  onSelectSession,
  activeProjectSessionId = null,
  onCreateConversationInProject,
  onAddLocalProject,
  isAddingLocalProject = false,
  onOpenProjectInNewWindow,
  onRelinkProject,
  onRenameProject,
  onSetProjectArchived,
  onRemoveProject,
  onOpenFreeConversations,
  onOpenSources,
  onOpenSkills,
  onOpenAutomations,
  onOpenSettings,
  width,
  onWidthChange,
  onSignOut,
  profile,
  onOpenWhatsNew,
  whatsNew,
  updateIndicator,
  onInstallUpdate,
  sessionActions,
}: ActivityRailProps) {
  const { t } = useTranslation()
  const { focusZone } = useFocusActions()
  const { zoneRef: navigatorRef } = useFocusZone({ zoneId: 'navigator' })
  const activityStore = useStore()
  const scrollContainerRef = React.useRef<HTMLDivElement>(null)
  const localRuntimeSessionMetas = useAtomValue(runtimeSessionMetasAtom)
  const runtimeMetadataReady = useAtomValue(sessionMetadataReadyAtom)
  const sessionIdsWithPendingPrompt = useAtomValue(sessionIdsWithPendingPromptAtom)
  const [freeSessionMetas, setFreeSessionMetas] = useAtom(activityFreeSessionMetasAtom)
  const [unreadByWorkspace, setUnreadByWorkspace] = useAtom(activityUnreadByWorkspaceAtom)
  const [fixedExpanded, setFixedExpanded] = React.useState(true)
  const [recentExpanded, setRecentExpanded] = React.useState(() => (
    storage.get(storage.KEYS.activityRecentExpanded, true)
  ))
  const [projectsExpanded, setProjectsExpanded] = React.useState(() => (
    storage.get(storage.KEYS.activityProjectsExpanded, true)
  ))
  const [archivedExpanded, setArchivedExpanded] = useAtom(activityArchivedExpandedAtom)
  const [showAllRecent, setShowAllRecent] = useAtom(activityShowAllRecentAtom)
  const [showAllProjects, setShowAllProjects] = useAtom(activityShowAllProjectsAtom)
  const [expandedProjectIds, setExpandedProjectIds] = useAtom(activityExpandedProjectIdsAtom)
  const [projectSessionMetas, setProjectSessionMetas] = useAtom(activityProjectSessionMetasAtom)
  const [activeWorkspaceIds, setActiveWorkspaceIds] = useAtom(activityActiveWorkspaceIdsAtom)
  const [loadingProjectIds, setLoadingProjectIds] = React.useState<Set<string>>(() => new Set())
  const [feedbackOpen, setFeedbackOpen] = React.useState(false)
  const [renameTarget, setRenameTarget] = React.useState<
    { kind: 'project' | 'session'; id: string; name: string; workspaceId?: string } | null
  >(null)
  const [renameValue, setRenameValue] = React.useState('')
  const [uncontrolledWidth, setUncontrolledWidth] = React.useState(() => (
    storage.get(storage.KEYS.activityRailWidth, ACTIVITY_RAIL_WIDTH)
  ))
  const resolvedWidth = Math.min(
    ACTIVITY_RAIL_MAX_WIDTH,
    Math.max(ACTIVITY_RAIL_MIN_WIDTH, width ?? uncontrolledWidth),
  )
  const latestWidthRef = React.useRef(resolvedWidth)
  const refreshGenerationRef = React.useRef(0)
  const activeRefreshGenerationRef = React.useRef(0)
  const canCreateProjects = typeof onAddLocalProject === 'function'
  const canCreateTask = Boolean(
    (activeWorkspaceId && onCreateConversationInProject)
    || onOpenFreeConversations,
  )
  const selectedSessionId = activeItem === 'recent' ? activeSessionId : null
  const selectedProjectSessionId = activeItem === 'recent' ? activeProjectSessionId : null
  const selectedWorkspaceId = activeItem === 'recent' || activeItem === 'writing'
    ? activeWorkspaceId
    : null
  const handleNavigatorFocus = React.useCallback(() => {
    // FocusContext intentionally does not track every focusin to avoid shell-wide
    // rerenders. The rail is the navigator zone when one of its controls is used.
    focusZone('navigator', { intent: 'click', moveFocus: false })
  }, [focusZone])
  const updateWidth = React.useCallback((nextWidth: number) => {
    const clampedWidth = Math.min(ACTIVITY_RAIL_MAX_WIDTH, Math.max(ACTIVITY_RAIL_MIN_WIDTH, nextWidth))
    latestWidthRef.current = clampedWidth
    if (onWidthChange) onWidthChange(clampedWidth)
    else setUncontrolledWidth(clampedWidth)
    return clampedWidth
  }, [onWidthChange])
  const handleResizeStart = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = resolvedWidth
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handleMouseMove = (moveEvent: MouseEvent) => {
      updateWidth(startWidth + moveEvent.clientX - startX)
    }
    const handleMouseUp = () => {
      storage.set(storage.KEYS.activityRailWidth, latestWidthRef.current)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      document.removeEventListener('mousemove', handleMouseMove, true)
      document.removeEventListener('mouseup', handleMouseUp, true)
    }

    document.addEventListener('mousemove', handleMouseMove, true)
    document.addEventListener('mouseup', handleMouseUp, true)
  }, [resolvedWidth, updateWidth])
  const handleResizeKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const direction = event.key === 'ArrowLeft' ? -1 : 1
    const nextWidth = updateWidth(latestWidthRef.current + (direction * 10))
    storage.set(storage.KEYS.activityRailWidth, nextWidth)
  }, [updateWidth])
  let updateIndicatorLabel: string | null = null
  if (updateIndicator?.kind === 'downloading' && updateIndicator.version) {
    updateIndicatorLabel = t('settings.about.downloading', {
      version: updateIndicator.version,
      percent: updateIndicator.progress,
    })
  } else if (updateIndicator?.kind === 'ready' && updateIndicator.version) {
    updateIndicatorLabel = t('settings.about.restartToUpdate', { version: updateIndicator.version })
  } else if (updateIndicator?.kind === 'ready') {
    updateIndicatorLabel = t('settings.about.updateReady')
  } else if (updateIndicator?.kind === 'installing') {
    updateIndicatorLabel = t('toast.installingUpdate')
  }

  React.useLayoutEffect(() => {
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = activityStore.get(activitySidebarScrollTopAtom)
  }, [activityStore])

  const refreshFreeSessionMetas = React.useCallback(async () => {
    const generation = ++refreshGenerationRef.current
    try {
      const sessions = await window.electronAPI.listSessionsByWorkspace(FREE_CONVERSATION_WORKSPACE_ID)
      if (generation !== refreshGenerationRef.current) return
      setFreeSessionMetas(sessions.map(extractSessionMeta))
    } catch (error) {
      // Older remote servers may not expose the scoped metadata endpoint yet.
      // Rendering nothing is the honest fallback: the previous cross-workspace
      // fallback leaked project conversations into this list.
      console.warn('[activity-sidebar] Failed to load free conversation metadata:', error)
    }
  }, [setFreeSessionMetas])

  const refreshProjectSessionMetas = React.useCallback(async (workspaceId: string) => {
    setLoadingProjectIds((prev) => {
      const next = new Set(prev)
      next.add(workspaceId)
      return next
    })
    try {
      const sessions = await window.electronAPI.listSessionsByWorkspace(workspaceId)
      const metas = sessions
        .map(extractSessionMeta)
        .filter((meta) => !meta.hidden && meta.isArchived !== true && hasSessionHistoryContent(meta))
        .sort((left, right) => (right.lastMessageAt ?? right.createdAt ?? 0) - (left.lastMessageAt ?? left.createdAt ?? 0))
      setProjectSessionMetas((prev) => ({ ...prev, [workspaceId]: metas }))
    } catch (error) {
      console.warn('[activity-sidebar] Failed to load project conversations:', workspaceId, error)
      setProjectSessionMetas((prev) => ({ ...prev, [workspaceId]: [] }))
    } finally {
      setLoadingProjectIds((prev) => {
        const next = new Set(prev)
        next.delete(workspaceId)
        return next
      })
    }
  }, [setProjectSessionMetas])

  const updateCachedPinnedState = React.useCallback((sessionId: string, isPinned: boolean, workspaceId: string) => {
    setFreeSessionMetas(previous => previous && workspaceId === FREE_CONVERSATION_WORKSPACE_ID
      ? setSessionPinnedInMetas(previous, sessionId, isPinned)
      : previous)
    setProjectSessionMetas((previous) => Object.fromEntries(
      Object.entries(previous).map(([ownerId, metas]) => [
        ownerId,
        ownerId === workspaceId ? setSessionPinnedInMetas(metas, sessionId, isPinned) : metas,
      ]),
    ))
  }, [setFreeSessionMetas, setProjectSessionMetas])
  const railSessionActions = React.useMemo<ActivityRailSessionActions | undefined>(() => {
    if (!sessionActions) return undefined
    const refreshOwner = (workspaceId: string) => workspaceId === FREE_CONVERSATION_WORKSPACE_ID
      ? refreshFreeSessionMetas() : refreshProjectSessionMetas(workspaceId)
    return {
      ...sessionActions,
      onArchive: async (sessionId, workspaceId) => {
        await sessionActions.onArchive(sessionId, workspaceId)
        await refreshOwner(workspaceId)
      },
      onDelete: async (sessionId, workspaceId) => {
        await sessionActions.onDelete(sessionId, workspaceId)
        await refreshOwner(workspaceId)
      },
      onRename: async (sessionId, name, workspaceId) => {
        await sessionActions.onRename(sessionId, name, workspaceId)
        await refreshOwner(workspaceId)
      },
      onPin: sessionActions.onPin
        ? async (sessionId, workspaceId) => {
          const updated = await sessionActions.onPin?.(sessionId, workspaceId) ?? false
          if (updated) updateCachedPinnedState(sessionId, true, workspaceId)
          return updated
        }
        : undefined,
      onUnpin: sessionActions.onUnpin
        ? async (sessionId, workspaceId) => {
          const updated = await sessionActions.onUnpin?.(sessionId, workspaceId) ?? false
          if (updated) updateCachedPinnedState(sessionId, false, workspaceId)
          return updated
        }
        : undefined,
    }
  }, [sessionActions, updateCachedPinnedState, refreshFreeSessionMetas, refreshProjectSessionMetas])
  const { createDragHandlers, orderWorkspaceSessions } = useActivityRailSessionOrder(railSessionActions)

  const toggleProjectExpanded = React.useCallback((workspaceId: string) => {
    setExpandedProjectIds((prev) => {
      const next = new Set(prev)
      if (next.has(workspaceId)) {
        next.delete(workspaceId)
      } else {
        next.add(workspaceId)
        void refreshProjectSessionMetas(workspaceId)
      }
      return next
    })
  }, [refreshProjectSessionMetas, setExpandedProjectIds])

  const refreshUnreadSummary = React.useCallback(async () => {
    try {
      setUnreadByWorkspace((await window.electronAPI.getUnreadSummary()).hasUnreadByWorkspace)
    } catch (error) {
      console.warn('[activity-sidebar] Failed to load unread summary:', error)
    }
  }, [setUnreadByWorkspace])

  const refreshActiveWorkspaceIds = React.useCallback(async () => {
    const generation = ++activeRefreshGenerationRef.current
    try {
      const activeSessions = await window.electronAPI.getActiveSessions()
      if (generation !== activeRefreshGenerationRef.current) return
      setActiveWorkspaceIds(new Set(activeSessions.map(session => session.workspaceId)))
    } catch (error) {
      if (generation === activeRefreshGenerationRef.current) setActiveWorkspaceIds(new Set())
      console.warn('[activity-sidebar] Failed to load active session summary:', error)
    }
  }, [setActiveWorkspaceIds])

  React.useEffect(() => {
    if (freeSessionMetas === null) void refreshFreeSessionMetas()
  }, [freeSessionMetas, refreshFreeSessionMetas])

  React.useEffect(() => {
    void refreshActiveWorkspaceIds()
  }, [refreshActiveWorkspaceIds])

  // The aggregate summary keeps collapsed project rows honest without loading
  // or merging their session identities; expanded lists remain workspace-scoped.
  React.useEffect(() => {
    if (activityStore.get(activityUnreadByWorkspaceAtom) === null) void refreshUnreadSummary()
    return window.electronAPI.onUnreadSummaryChanged((summary) => {
      setUnreadByWorkspace(summary.hasUnreadByWorkspace)
    })
  }, [activityStore, refreshUnreadSummary, setUnreadByWorkspace])

  React.useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = window.electronAPI.onSessionEvent((event) => {
      if (!shouldRefreshGlobalSessionMetasForEvent(event.type)) return
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        void refreshFreeSessionMetas()
        void refreshActiveWorkspaceIds()
        for (const workspaceId of new Set([...expandedProjectIds, ...Object.keys(projectSessionMetas)])) {
          void refreshProjectSessionMetas(workspaceId)
        }
      }, 180)
    })

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      unsubscribe()
    }
  }, [expandedProjectIds, projectSessionMetas, refreshActiveWorkspaceIds, refreshFreeSessionMetas, refreshProjectSessionMetas])

  const sessionMetas = React.useMemo(() => {
    const metas = [...resolveActivityWorkspaceSessionMetas(
      FREE_CONVERSATION_WORKSPACE_ID,
      runtimeWorkspaceId,
      freeSessionMetas ?? undefined,
      localRuntimeSessionMetas,
      runtimeMetadataReady,
    )]
      .filter(meta => !meta.hidden && meta.isArchived !== true && hasSessionHistoryContent(meta))
    return orderWorkspaceSessions(FREE_CONVERSATION_WORKSPACE_ID, metas)
  }, [freeSessionMetas, localRuntimeSessionMetas, orderWorkspaceSessions, runtimeMetadataReady, runtimeWorkspaceId])

  const freeSessionDragHandlers = createDragHandlers(FREE_CONVERSATION_WORKSPACE_ID, sessionMetas)
  // Aggregated over every session, not just the visible slice: a collapsed or
  // truncated group must still reveal that something inside needs a human.
  const recentNeedsAttention = React.useMemo(
    () => sessionMetas.some(meta => requiresHumanAttention(deriveSessionRuntimeStatus({
      isProcessing: meta.isProcessing,
      hasPendingPrompt: sessionIdsWithPendingPrompt.has(meta.id),
      lastMessageRole: meta.lastMessageRole,
    }))),
    [sessionIdsWithPendingPrompt, sessionMetas]
  )
  const projectWorkspaces = React.useMemo(
    () => [...workspaces]
      .filter(workspace => (
        workspace.id !== FREE_CONVERSATION_WORKSPACE_ID
        && !workspace.archivedAt
      ))
      .sort((left, right) => {
        const recentOrder = Math.max(right.lastAccessedAt ?? 0, right.createdAt ?? 0)
          - Math.max(left.lastAccessedAt ?? 0, left.createdAt ?? 0)
        return recentOrder || left.name.localeCompare(right.name, 'zh-Hans')
      }),
    [workspaces],
  )
  React.useEffect(() => {
    for (const workspace of projectWorkspaces) {
      if (workspace.rootAvailable !== false) void refreshProjectSessionMetas(workspace.id)
    }
  }, [projectWorkspaces, refreshProjectSessionMetas])

  // One complete ordered collection drives both projections and drag ownership.
  const orderedProjectSessions = Object.fromEntries(projectWorkspaces.map(workspace => [
    workspace.id,
    orderWorkspaceSessions(workspace.id, [...resolveActivityWorkspaceSessionMetas(
      workspace.id, runtimeWorkspaceId, projectSessionMetas[workspace.id], localRuntimeSessionMetas, runtimeMetadataReady, workspace.remoteServer?.remoteWorkspaceId,
    )].filter(meta => !meta.hidden && !meta.isArchived && hasSessionHistoryContent(meta))),
  ]))
  const fixedSessions = [
    ...sessionMetas.filter(meta => meta.isPinned),
    ...projectWorkspaces.flatMap(workspace => orderedProjectSessions[workspace.id]!.filter(meta => meta.isPinned)),
  ]
  const regularFreeSessions = sessionMetas.filter(meta => !meta.isPinned)
  const archivedWorkspaces = React.useMemo(
    () => workspaces
      .filter(workspace => (
        workspace.id !== FREE_CONVERSATION_WORKSPACE_ID
        && Boolean(workspace.archivedAt)
      ))
      .sort((left, right) => (right.archivedAt ?? 0) - (left.archivedAt ?? 0)),
    [workspaces],
  )
  const visibleProjectWorkspaces = showAllProjects
    ? projectWorkspaces
    : projectWorkspaces.slice(0, PROJECT_WORKSPACE_LIMIT)
  const hasMoreProjectWorkspaces = projectWorkspaces.length > PROJECT_WORKSPACE_LIMIT

  const updateRecentExpanded = React.useCallback((expanded: boolean) => {
    setRecentExpanded(expanded)
    storage.set(storage.KEYS.activityRecentExpanded, expanded)
  }, [])

  const updateProjectsExpanded = React.useCallback((expanded: boolean) => {
    setProjectsExpanded(expanded)
    storage.set(storage.KEYS.activityProjectsExpanded, expanded)
  }, [])

  const handleCreateTask = React.useCallback(() => {
    if (activeWorkspaceId && onCreateConversationInProject) {
      void onCreateConversationInProject(activeWorkspaceId)
      return
    }

    void onOpenFreeConversations?.({ createNew: true })
  }, [activeWorkspaceId, onCreateConversationInProject, onOpenFreeConversations])

  const projectCreateTrigger = (
    <button
      type="button"
      aria-label={isAddingLocalProject ? '正在添加本地项目' : '添加本地项目'}
      aria-busy={isAddingLocalProject || undefined}
      title="添加本地项目"
      disabled={isAddingLocalProject}
      onClick={() => { void onAddLocalProject?.() }}
      data-tutorial="activity-project-hub"
      className="flex h-6 w-6 items-center justify-center rounded-[6px] text-muted-foreground opacity-0 outline-none transition-[color,background-color,opacity] hover:bg-foreground/[0.06] hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 disabled:cursor-wait disabled:opacity-100 focus-visible:ring-1 focus-visible:ring-ring"
    >
      {isAddingLocalProject ? (
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <SquarePen className="h-3.5 w-3.5" />
      )}
    </button>
  )

  return (
    <aside
      ref={navigatorRef}
      tabIndex={-1}
      onFocus={handleNavigatorFocus}
      data-testid="activity-rail"
      aria-label="工作区导航"
      className="titlebar-no-drag relative flex h-full shrink-0 flex-col bg-foreground-1.5 font-medium"
      style={{ width: resolvedWidth }}
    >
      {/* Window-pinned collapse/search controls sit above this draggable title-bar area. */}
      <div
        aria-hidden="true"
        className="titlebar-drag-region shrink-0"
        style={{ height: WINDOW_TITLE_BAR_HEIGHT }}
      />
      <div className="flex min-h-0 flex-1 flex-col px-2 pt-1">
        <div className="flex items-center gap-2 px-2.5 pb-2">
          <img src={storyflowLogo} alt="" aria-hidden="true" className="size-4 shrink-0 rounded-[25%] object-cover" />
          <span className="min-w-0 flex-1 truncate text-[16px] font-medium text-foreground/85">
            Storyflow
            <span className="ml-1 text-[11px] font-normal text-muted-foreground/65">v{appPackage.version}</span>
          </span>
        </div>

        <button
          type="button"
          aria-label="新建任务"
          disabled={!canCreateTask}
          className={cn(
            'mb-0.5 flex h-8 w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-[13px] font-medium text-foreground/90 outline-none transition-colors',
            'hover:bg-foreground/[0.045] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
            'disabled:cursor-default disabled:opacity-45',
          )}
          onClick={handleCreateTask}
        >
          <SquarePen className="h-4 w-4" />
          <span>新建任务</span>
        </button>

        <nav className="shrink-0 space-y-0.5 pb-4" aria-label="插件导航">
          <SidebarNavItem
            label="技能"
            icon={<Zap className="h-4 w-4" />}
            active={activeItem === 'skills'}
            disabled={!onOpenSkills}
            onClick={onOpenSkills}
            dataTutorial="activity-skills"
          />
          <SidebarNavItem
            label="数据源"
            icon={<DatabaseZap className="h-4 w-4" />}
            active={activeItem === 'sources'}
            disabled={!onOpenSources}
            onClick={onOpenSources}
            dataTutorial="activity-sources"
          />
          <SidebarNavItem
            label={t('sidebar.scheduled')}
            icon={<Clock3 className="h-4 w-4" />}
            active={activeItem === 'automations'}
            disabled={!onOpenAutomations}
            onClick={onOpenAutomations}
            dataTutorial="activity-automations"
          />
        </nav>

        <div
          ref={scrollContainerRef}
          onScroll={(event) => activityStore.set(activitySidebarScrollTopAtom, event.currentTarget.scrollTop)}
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pr-0.5"
          data-testid="activity-sidebar-scroll"
        >
          {fixedSessions.length > 0 ? (
            <section aria-label="固定">
              <SidebarSectionHeader label="固定" count={fixedSessions.length} expanded={fixedExpanded} onToggle={() => setFixedExpanded(!fixedExpanded)} />
              {fixedExpanded ? <div className="space-y-0.5 pb-3" data-testid="activity-fixed-sessions" data-session-group="fixed">
                {fixedSessions.map(meta => (
                  <RecentConversationRow key={`${meta.workspaceId}:${meta.id}`} meta={meta} active={runtimeWorkspaceId === meta.workspaceId && (selectedSessionId === meta.id || selectedProjectSessionId === meta.id)}
                    dragHandlers={createDragHandlers(meta.workspaceId ?? FREE_CONVERSATION_WORKSPACE_ID, meta.workspaceId === FREE_CONVERSATION_WORKSPACE_ID ? sessionMetas : orderedProjectSessions[meta.workspaceId] ?? [])}
                    disabled={!onSelectSession} onSelect={() => onSelectSession?.(meta.id, meta.workspaceId)} sessionActions={railSessionActions}
                    onRename={() => { setRenameTarget({ kind: 'session', id: meta.id, workspaceId: meta.workspaceId, name: getSessionTitle(meta) }); setRenameValue(getSessionTitle(meta)) }} />
                ))}
              </div> : null}
            </section>
          ) : null}
          <section aria-label="自由">
            <SidebarSectionHeader
              label="自由"
              count={regularFreeSessions.length}
              expanded={recentExpanded}
              needsAttention={recentNeedsAttention}
              onToggle={() => updateRecentExpanded(!recentExpanded)}
              action={onOpenFreeConversations ? (
                <button
                  type="button"
                  aria-label="新建自由对话"
                  title="新建自由对话"
                  className="flex h-6 w-6 items-center justify-center rounded-[6px] text-muted-foreground opacity-0 outline-none transition-[color,background-color,opacity] hover:bg-foreground/[0.06] hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:ring-1 focus-visible:ring-ring"
                  onClick={() => { void onOpenFreeConversations({ createNew: true }) }}
                >
                  <SquarePen className="h-3.5 w-3.5" />
                </button>
              ) : undefined}
            />
            {recentExpanded ? (
              <div
                className="space-y-0.5 pb-3"
                data-testid="activity-recent-sessions"
              >
                <ActivityRailSessionList
                  sessions={regularFreeSessions}
                  activeSessionId={runtimeWorkspaceId === FREE_CONVERSATION_WORKSPACE_ID ? selectedSessionId : null}
                  disabled={!onSelectSession}
                  onSelectSession={meta => onSelectSession?.(meta.id, meta.workspaceId)}
                  sessionActions={railSessionActions}
                  onRenameSession={(meta) => {
                    setRenameTarget({ kind: 'session', id: meta.id, workspaceId: meta.workspaceId, name: getSessionTitle(meta) })
                    setRenameValue(getSessionTitle(meta))
                  }}
                  dragHandlers={freeSessionDragHandlers}
                  regularLimit={RECENT_SESSION_LIMIT}
                  showAll={showAllRecent}
                  onShowAllChange={setShowAllRecent}
                  emptyLabel="暂无自由对话"
                />
              </div>
            ) : null}
          </section>

          <section aria-label="项目目录">
            <SidebarSectionHeader
              label="项目"
              count={projectWorkspaces.length}
              expanded={projectsExpanded}
              onToggle={() => updateProjectsExpanded(!projectsExpanded)}
              action={canCreateProjects ? projectCreateTrigger : undefined}
            />
            {projectsExpanded ? (
              projectWorkspaces.length > 0 ? (
                <>
                  <div className="space-y-0.5 pb-1" data-testid="activity-projects">
                    {visibleProjectWorkspaces.map((workspace) => {
                      const expanded = expandedProjectIds.has(workspace.id)
                      const rootAvailable = workspace.rootAvailable !== false
                      const workspaceSessions = orderedProjectSessions[workspace.id]!
                      return (
                        <ProjectFolderRow
                          key={workspace.id}
                          workspace={workspace}
                          active={rootAvailable && selectedWorkspaceId === workspace.id && !selectedProjectSessionId}
                          hasUnread={unreadByWorkspace?.[workspace.id] === true}
                          hasActiveSession={activeWorkspaceIds.has(workspace.id)}
                          disabled={!onSelectSession || !rootAvailable}
                          expandable={Boolean(onSelectSession && rootAvailable)}
                          expanded={expanded}
                          onToggleExpanded={() => toggleProjectExpanded(workspace.id)}
                          sessions={workspaceSessions.filter(meta => !meta.isPinned)}
                          loadingSessions={loadingProjectIds.has(workspace.id)}
                          activeSessionId={runtimeWorkspaceId === workspace.id && selectedWorkspaceId === workspace.id ? selectedProjectSessionId : null}
                          onSelectSession={onSelectSession && rootAvailable
                            ? (sessionId) => { void onSelectSession(sessionId, workspace.id) }
                            : undefined}
                          onCreateConversation={onCreateConversationInProject && rootAvailable
                            ? () => onCreateConversationInProject(workspace.id)
                            : undefined}
                          sessionActions={railSessionActions}
                          sessionDragHandlers={createDragHandlers(workspace.id, workspaceSessions)}
                          onRenameSession={(meta) => {
                            setRenameTarget({ kind: 'session', id: meta.id, workspaceId: meta.workspaceId, name: getSessionTitle(meta) })
                            setRenameValue(getSessionTitle(meta))
                          }}
                          onOpenInNewWindow={onOpenProjectInNewWindow && rootAvailable
                            ? () => onOpenProjectInNewWindow(workspace.id)
                            : undefined}
                          onRelink={!rootAvailable && onRelinkProject
                            ? () => onRelinkProject(workspace.id)
                            : undefined}
                          onRename={onRenameProject && rootAvailable
                            ? () => {
                              setRenameTarget({ kind: 'project', id: workspace.id, name: workspace.name })
                              setRenameValue(workspace.name)
                            }
                            : undefined}
                          onArchive={onSetProjectArchived
                            ? () => onSetProjectArchived(workspace.id, true)
                            : undefined}
                        />
                      )
                    })}
                  </div>
                  {hasMoreProjectWorkspaces ? (
                    <button
                      type="button"
                      className="mb-1 w-full rounded-[7px] px-3 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-foreground/[0.045] hover:text-foreground"
                      onClick={() => setShowAllProjects(value => !value)}
                    >
                      {showAllProjects ? '收起项目' : `显示全部 ${projectWorkspaces.length} 个项目`}
                    </button>
                  ) : null}
                </>
              ) : (
                <div className="px-3 py-3 text-xs text-muted-foreground/60">暂无项目</div>
              )
            ) : null}
            {archivedWorkspaces.length > 0 ? (
              <>
                <SidebarSectionHeader
                  label="归档"
                  count={archivedWorkspaces.length}
                  expanded={archivedExpanded}
                  onToggle={() => setArchivedExpanded(value => !value)}
                />
                {archivedExpanded ? (
                  <div className="space-y-0.5 pb-1" data-testid="activity-archived-projects">
                    {archivedWorkspaces.map(workspace => (
                      <ProjectFolderRow
                        key={workspace.id}
                        workspace={workspace}
                        active={false}
                        archived
                        hasUnread={false}
                        disabled
                        onRestore={onSetProjectArchived
                          ? () => onSetProjectArchived(workspace.id, false)
                          : undefined}
                        onRemove={onRemoveProject
                          ? () => {
                            const ok = window.confirm(`从列表中移除「${workspace.name}」？不会删除磁盘文件。`)
                            if (ok) void onRemoveProject(workspace.id)
                          }
                          : undefined}
                      />
                    ))}
                  </div>
                ) : null}
              </>
            ) : null}
          </section>
        </div>
      </div>

      <div className="border-t border-border/35 px-2 py-2">
        {updateIndicator ? (
          <div aria-live="polite">
            <button
              type="button"
              disabled={!updateIndicator.actionable}
              aria-label={updateIndicatorLabel ?? undefined}
              data-tutorial="activity-update"
              className={cn(
                'mb-1.5 flex w-full items-center gap-2 rounded-[8px] px-2 py-2 text-left text-[12px] font-medium outline-none transition-colors',
                updateIndicator.actionable
                  ? 'bg-info/10 text-[var(--info-text)] hover:bg-info/15 focus-visible:ring-1 focus-visible:ring-info'
                  : 'cursor-default bg-foreground/[0.035] text-muted-foreground',
              )}
              onClick={() => {
                if (updateIndicator.actionable) void onInstallUpdate?.()
              }}
            >
              {updateIndicator.kind === 'ready' ? (
                <Download className="size-4 shrink-0" aria-hidden="true" />
              ) : (
                <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1 truncate">{updateIndicatorLabel}</span>
            </button>
          </div>
        ) : null}
        <div className="flex items-center gap-1">
          <nav aria-label="个人菜单" className="min-w-0 flex-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`${profile?.name ?? '本地用户'}的个人菜单`}
                  data-tutorial="activity-profile"
                  className={cn(
                    'flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left outline-none transition-colors',
                    'hover:bg-foreground/[0.045] focus-visible:ring-1 focus-visible:ring-ring',
                    activeItem === 'settings' && 'bg-foreground/[0.07]',
                  )}
                >
                  {profile?.avatarUrl ? (
                    <CrossfadeAvatar
                      src={profile.avatarUrl}
                      alt={`${profile.name}的头像`}
                      className="size-7 rounded-full"
                      fallbackClassName="rounded-full bg-foreground/10 text-[11px] font-semibold text-foreground/80"
                      fallback={getProfileInitial(profile.name)}
                    />
                  ) : (
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-[11px] font-semibold text-foreground/80">
                      {getProfileInitial(profile?.name)}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium leading-4 text-foreground/90">
                      {profile?.name ?? '本地用户'}
                    </span>
                    {profile?.detail ? (
                      <span className="block truncate text-[10px] leading-4 text-muted-foreground/65">
                        {profile.detail}
                      </span>
                    ) : null}
                  </span>
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <StyledDropdownMenuContent side="top" align="start" sideOffset={6}>
                <StyledDropdownMenuItem
                  disabled={!onOpenSettings}
                  onClick={() => onOpenSettings?.('usage')}
                >
                  <Gauge className="size-4" />
                  {t('settings.app.localUsage.title')}
                </StyledDropdownMenuItem>
                <StyledDropdownMenuItem
                  disabled={!onOpenSettings}
                  onClick={() => onOpenSettings?.('app')}
                  data-tutorial="activity-settings"
                >
                  <Settings className="size-4" />
                  {t('sidebar.settings')}
                </StyledDropdownMenuItem>
                <StyledDropdownMenuItem
                  disabled={!onOpenSettings}
                  onClick={() => onOpenSettings?.('profile')}
                  data-tutorial="activity-profile-settings"
                >
                  <UserRound className="size-4" />
                  {t('settings.profile.title')}
                </StyledDropdownMenuItem>
                <StyledDropdownMenuItem
                  onSelect={async () => {
                    const url = 'https://story.zjding.com/'
                    try {
                      await navigator.clipboard.writeText(url)
                      toast.success('邀请链接已复制，粘贴发送给好友即可')
                    } catch {
                      toast.error('复制失败，请手动复制官网链接', { description: url })
                    }
                  }}
                  data-tutorial="activity-invite-friends"
                >
                  <UserPlus className="size-4" />
                  邀请好友
                </StyledDropdownMenuItem>
                {onSignOut ? <StyledDropdownMenuSeparator /> : null}
                {onSignOut ? (
                  <StyledDropdownMenuItem
                    onClick={() => { void onSignOut() }}
                    data-tutorial="activity-sign-out"
                  >
                    <LogOut className="size-4" />
                    {t('webui.logOut')}
                  </StyledDropdownMenuItem>
                ) : null}
              </StyledDropdownMenuContent>
            </DropdownMenu>
          </nav>

          <nav aria-label="帮助菜单">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="帮助菜单"
                  title="帮助"
                  data-tutorial="activity-help-menu"
                  className="relative flex size-10 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.045] hover:text-foreground data-[state=open]:bg-foreground/[0.07] data-[state=open]:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <HelpCircle className="size-[18px]" aria-hidden="true" />
                  {whatsNew?.unseen ? (
                    <span
                      className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-blue-500"
                      aria-label="有未读更新"
                    />
                  ) : null}
                </button>
              </DropdownMenuTrigger>
              <StyledDropdownMenuContent side="top" align="start" sideOffset={8}>
                <StyledDropdownMenuItem
                  disabled={!onOpenWhatsNew}
                  onClick={onOpenWhatsNew}
                  data-tutorial="activity-whats-new"
                >
                  <Gift className="size-4" />
                  <span className="min-w-0 flex-1">
                    {whatsNew?.unseen ? '新功能（未读）' : '新功能'}
                  </span>
                  {whatsNew?.unseen ? (
                    <span
                      className="size-1.5 rounded-full bg-blue-500"
                      aria-hidden="true"
                    />
                  ) : null}
                </StyledDropdownMenuItem>
                <StyledDropdownMenuSeparator />
                <StyledDropdownMenuItem
                  onClick={() => window.electronAPI.openUrl('https://ehyg6a9wjd.feishu.cn/docx/MC49dYJYtoRnalxgYi1ceH01nWb')}
                  data-tutorial="activity-beginner-guide"
                >
                  <BookOpen className="size-4" />
                  新手教程
                </StyledDropdownMenuItem>
                <StyledDropdownMenuItem
                  onClick={() => setFeedbackOpen(true)}
                  data-tutorial="activity-feedback"
                >
                  <MessageSquarePlus className="size-4" />
                  帮助与反馈
                </StyledDropdownMenuItem>
              </StyledDropdownMenuContent>
            </DropdownMenu>
          </nav>
        </div>
        <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
      </div>
      <div
        role="separator"
        tabIndex={0}
        aria-label="调整侧边栏宽度"
        aria-orientation="vertical"
        aria-valuemin={ACTIVITY_RAIL_MIN_WIDTH}
        aria-valuemax={ACTIVITY_RAIL_MAX_WIDTH}
        aria-valuenow={resolvedWidth}
        onMouseDown={handleResizeStart}
        onKeyDown={handleResizeKeyDown}
        className="group absolute inset-y-0 right-0 z-dropdown w-2 cursor-col-resize outline-none"
      >
        <span className="absolute inset-y-0 right-0 w-px bg-transparent transition-colors group-hover:bg-foreground/15 group-focus-visible:bg-ring" />
      </div>
      {renameTarget ? (
        <RenameDialog
          open
          onOpenChange={(open) => {
            if (!open) setRenameTarget(null)
          }}
          title={renameTarget.kind === 'project' ? '重命名项目' : '重命名对话'}
          value={renameValue}
          onValueChange={setRenameValue}
          onSubmit={() => {
            const nextName = renameValue.trim()
            if (nextName && nextName !== renameTarget.name) {
              if (renameTarget.kind === 'project') {
                void onRenameProject?.(renameTarget.id, nextName)
              } else {
                void railSessionActions?.onRename(renameTarget.id, nextName, renameTarget.workspaceId!)
              }
            }
            setRenameTarget(null)
          }}
          placeholder={renameTarget.kind === 'project' ? '输入项目名称' : '输入对话名称'}
        />
      ) : null}
    </aside>
  )
}

function SidebarNavItem({
  label,
  icon,
  active,
  onClick,
  dataTutorial,
  disabled,
}: {
  label: string
  icon: React.ReactNode
  active: boolean
  onClick?: () => void
  dataTutorial?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      disabled={disabled}
      data-tutorial={dataTutorial}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-[13px] outline-none transition-colors',
        'text-foreground/75 hover:bg-foreground/[0.045] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
        'disabled:cursor-default disabled:opacity-45',
        active && 'bg-foreground/[0.07] font-medium text-foreground',
      )}
      onClick={onClick}
    >
      <span className={cn(
        'flex h-4 w-4 shrink-0 items-center justify-center',
        'text-muted-foreground',
      )}>{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  )
}

function SidebarSectionHeader({
  label,
  count,
  expanded,
  onToggle,
  action,
  needsAttention,
}: {
  label: string
  count?: number
  expanded: boolean
  onToggle: () => void
  action?: React.ReactNode
  /** Shows an indicator when a collapsed group hides sessions awaiting a human. */
  needsAttention?: boolean
}) {
  return (
    <div className="group flex items-center justify-between rounded-[7px] transition-colors hover:bg-foreground/[0.045] focus-within:bg-foreground/[0.045]">
      <button
        type="button"
        aria-expanded={expanded}
        className="flex min-w-0 flex-1 items-center gap-1 rounded-[7px] px-2 py-1.5 text-left text-[12px] font-medium text-muted-foreground/80 outline-none transition-colors group-hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        onClick={onToggle}
      >
        <span className="min-w-0 truncate">
          {label}
          {count !== undefined ? <span className="ml-1 font-normal">({count})</span> : null}
        </span>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-55 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-55 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" />
        )}
        {needsAttention && !expanded ? (
          <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-info" aria-label="有对话等待处理" />
        ) : null}
      </button>
      {action}
    </div>
  )
}

function getProfileInitial(name: string | undefined): string {
  const normalized = name?.trim()
  return normalized ? Array.from(normalized)[0].toLocaleUpperCase() : '本'
}
