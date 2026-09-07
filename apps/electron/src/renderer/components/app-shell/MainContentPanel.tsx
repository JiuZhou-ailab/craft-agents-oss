/**
 * MainContentPanel - Right panel component for displaying content
 *
 * input: Navigation state, workspace-scoped session metadata, title inset, narrow action contexts, and entity selection atoms
 * output: Route-selected chat independent of file loading, actionable empty states, content panels, and scheduled-task overview
 * pos: Renderer content router inside the app-shell panel stack
 *
 * Renders content based on the unified NavigationState:
 * - Chats navigator: ChatPage for the selected or base session
 * - Sources navigator: Source list with modal details, or MCP discovery
 *
 * The NavigationState is the single source of truth for what to display.
 *
 * In focused mode (single window), wraps content with StoplightProvider
 * so PanelHeader components automatically compensate for macOS traffic lights.
 *
 * When multiple sessions are selected (multi-select mode), shows the
 * MultiSelectPanel with batch action buttons instead of a single chat.
 */

import * as React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation, Trans } from 'react-i18next'
import { Panel } from './Panel'
import { ChatPanelPlaceholder } from './ChatPanelPlaceholder'
import { MultiSelectPanel } from './MultiSelectPanel'
import { useSessionBatchActions } from '@/context/AppShellContext'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { workspacePanelFieldsAtomFamily, hasOtherWorkspacesAtom, sessionMetaAtomFamily, windowWorkspaceIdAtom, windowWorkspacesAtom, type SessionMeta } from '@/atoms/sessions'
import { StoplightProvider } from '@/context/StoplightContext'
import {
  useNavigationState,
  useNavigationActions,
  isWritingNavigation,
  isSessionsNavigation,
  isSourcesNavigation,
  isSkillsNavigation,
  isAutomationsNavigation,
} from '@/contexts/NavigationContext'
import { useSessionSelection, useIsMultiSelectActive, useSelectedIds, useSelectedSessionMetas, useSelectionCount } from '@/hooks/useSession'
import { routes } from '@/lib/navigate'
import { sourceSelection, automationSelection } from '@/hooks/useEntitySelection'
import { extractLabelId } from '@craft-agent/shared/labels'
import type { SessionStatusId } from '@/config/session-status-config'
import SourcesHubPage from '@/pages/SourcesHubPage'
import McpHubPage from '@/pages/McpHubPage'
import SkillInfoPage from '@/pages/SkillInfoPage'
import SkillsHubPage from '@/pages/SkillsHubPage'
import { AutomationInfoPage } from '../automations/AutomationInfoPage'
import { ScheduledTasksOverview } from '../automations/ScheduledTasksOverview'
import type { ExecutionEntry } from '../automations/types'
import { useAutomations } from '@/hooks/useAutomations'
import { FREE_CONVERSATION_WORKSPACE_ID } from '@craft-agent/shared/protocol'
import { SendResourceToWorkspaceDialog, type SendResourceType } from './SendResourceToWorkspaceDialog'

const LazyChatPage = React.lazy(() => import('@/pages/ChatPage'))

export interface MainContentPanelProps {
  /** Whether both sidebar and navigator are hidden by responsive compaction. */
  isSidebarAndNavigatorHidden?: boolean
  /** Stable screen-space title inset used while the activity rail collapses. */
  stoplightLeadingInset?: number
  /** Optional className for the container */
  className?: string
  /**
   * Override the navigation state for this panel.
   * When provided, this panel renders based on the override instead of the global NavigationState.
   * Used by PanelSlot to render panels in the panel stack.
   */
  navStateOverride?: import('../../../shared/types').NavigationState | null
}

export function MainContentPanel({
  isSidebarAndNavigatorHidden = false,
  stoplightLeadingInset,
  className,
  navStateOverride,
}: MainContentPanelProps) {
  const { t } = useTranslation()
  const globalNavState = useNavigationState()
  const { navigate } = useNavigationActions()
  const navState = navStateOverride ?? globalNavState
  const isMultiSelectActive = useIsMultiSelectActive()
  const activeWorkspaceId = useAtomValue(windowWorkspaceIdAtom)
  const hasOtherWorkspaces = useAtomValue(hasOtherWorkspacesAtom)
  const activeWorkspace = useAtomValue(workspacePanelFieldsAtomFamily(activeWorkspaceId ?? null))
  const automationRuntimeId = isAutomationsNavigation(navState)
    ? navState.filter?.automationType === 'scheduled' ? FREE_CONVERSATION_WORKSPACE_ID : activeWorkspaceId
    : null
  const {
    automations, automationWorkspace,
    automationTestResults,
    getAutomationHistory,
    handleDeleteAutomation,
    handleDuplicateAutomation,
    handleReplayAutomation,
    handleTestAutomation,
    handleToggleAutomation,
    automationPendingDelete,
    confirmDeleteAutomation,
    pendingDeleteAutomation,
    setAutomationPendingDelete,
  } = useAutomations(automationRuntimeId)

  // Execution history for the selected automation
  const selectedAutomationId = isAutomationsNavigation(navState) ? navState.details?.automationId : undefined
  const [executionHistory, setExecutionHistory] = useState<{
    workspaceId: string
    automationId: string
    entries: ExecutionEntry[]
  } | null>(null)

  useEffect(() => {
    if (!selectedAutomationId || !automationRuntimeId) return
    let stale = false

    // Initial fetch
    getAutomationHistory(selectedAutomationId).then(entries => {
      if (!stale) setExecutionHistory({ workspaceId: automationRuntimeId, automationId: selectedAutomationId, entries })
    })

    // Re-fetch on automation changes (live updates when automations fire)
    const cleanup = window.electronAPI.onAutomationsChanged(() => {
      if (!stale) {
        getAutomationHistory(selectedAutomationId).then(entries => {
          if (!stale) setExecutionHistory({ workspaceId: automationRuntimeId, automationId: selectedAutomationId, entries })
        })
      }
    })

    return () => { stale = true; cleanup() }
  }, [selectedAutomationId, automationRuntimeId, getAutomationHistory])

  const executions = executionHistory && executionHistory.workspaceId === automationRuntimeId && executionHistory.automationId === selectedAutomationId
    ? executionHistory.entries
    : []

  // Source multi-select state
  const isSourceMultiSelectActive = sourceSelection.useIsMultiSelectActive()
  const sourceSelectionCount = sourceSelection.useSelectionCount()
  const selectedSourceIds = sourceSelection.useSelectedIds()
  const { clearMultiSelect: clearSourceSelection } = sourceSelection.useSelection()

  // Automation multi-select state
  const isAutomationMultiSelectActive = automationSelection.useIsMultiSelectActive()
  const automationSelectionCount = automationSelection.useSelectionCount()
  const selectedAutomationIds = automationSelection.useSelectedIds()
  const { clearMultiSelect: clearAutomationSelection } = automationSelection.useSelection()

  // Send to Workspace dialog state (shared across resource types)
  const [sendDialogOpen, setSendDialogOpen] = useState(false)
  const [sendResourceType, setSendResourceType] = useState<SendResourceType>('source')
  const [sendResourceIds, setSendResourceIds] = useState<string[]>([])
  const [sendResourceLabel, setSendResourceLabel] = useState('')
  const remoteWorkspaceId = activeWorkspace?.remoteWorkspaceId

  const openSendDialog = useCallback((type: SendResourceType, ids: Set<string>) => {
    const count = ids.size
    setSendResourceType(type)
    setSendResourceIds([...ids])
    setSendResourceLabel(`${count} ${type}${count !== 1 ? 's' : ''}`)
    setSendDialogOpen(true)
  }, [])

  // Wrap content with StoplightProvider so PanelHeaders auto-compensate in focused mode.
  // Also renders the Send to Workspace dialog (portal-based, so it overlays regardless of position).
  const wrapWithStoplight = (content: React.ReactNode) => (
    <StoplightProvider value={{ enabled: isSidebarAndNavigatorHidden, leadingInset: stoplightLeadingInset }}>
      {content}
      {sendDialogOpen ? (
        <SendResourceWorkspaceDialogHost
          open={sendDialogOpen}
          onOpenChange={setSendDialogOpen}
          resourceType={sendResourceType}
          resourceIds={sendResourceIds}
          resourceLabel={sendResourceLabel}
          activeWorkspaceId={activeWorkspaceId || ''}
        />
      ) : null}
      <Dialog open={!!automationPendingDelete} onOpenChange={(open) => { if (!open) setAutomationPendingDelete(null) }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t('dialog.deleteAutomation.title')}</DialogTitle>
            <DialogDescription>
              <Trans
                i18nKey="dialog.deleteAutomation.description"
                values={{ name: pendingDeleteAutomation?.name }}
                components={{ strong: <strong /> }}
              />
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAutomationPendingDelete(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={confirmDeleteAutomation}>{t('common.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </StoplightProvider>
  )

  // Sources navigator - show source info, multi-select panel, or empty state
  if (isSourcesNavigation(navState)) {
    if (isSourceMultiSelectActive) {
      return wrapWithStoplight(
        <Panel variant="grow" className={className}>
          <MultiSelectPanel
            count={sourceSelectionCount}
            entityType="source"
            onSendToWorkspace={hasOtherWorkspaces ? () => openSendDialog('source', selectedSourceIds) : undefined}
            onClearSelection={clearSourceSelection}
          />
        </Panel>
      )
    }
    if (navState.details?.type === 'mcp-market') {
      return wrapWithStoplight(
        <Panel variant="grow" className={className}>
          <McpHubPage workspaceId={activeWorkspaceId || ''} />
        </Panel>
      )
    }
    return wrapWithStoplight(
      <Panel variant="grow" className={className}>
        <SourcesHubPage workspaceId={activeWorkspaceId || ''} navState={navState} />
      </Panel>
    )
  }

  // Skills uses one full-width native Hub with a dedicated detail route.
  if (isSkillsNavigation(navState)) {
    if (navState.details?.type === 'skill') {
      return wrapWithStoplight(
        <Panel variant="grow" className={className}>
          <SkillInfoPage
            skillSlug={navState.details.skillSlug}
            workspaceId={activeWorkspaceId || ''}
            workspaceRootPath={activeWorkspace?.rootPath ?? ''}
            canRevealLocally={!activeWorkspace?.remoteWorkspaceId}
          />
        </Panel>
      )
    }
    // The bare Skills route is the native discovery and management surface.
    return wrapWithStoplight(
      <Panel variant="grow" className={className}>
        <SkillsHubPage />
      </Panel>
    )
  }

  // Automations navigator - show automation info, multi-select panel, or empty state
  if (isAutomationsNavigation(navState)) {
    if (isAutomationMultiSelectActive) {
      return wrapWithStoplight(
        <Panel variant="grow" className={className}>
          <MultiSelectPanel
            count={automationSelectionCount}
            entityType="automation"
            onSendToWorkspace={hasOtherWorkspaces ? () => openSendDialog('automation', selectedAutomationIds) : undefined}
            onClearSelection={clearAutomationSelection}
          />
        </Panel>
      )
    }
    const automation = automations.find(item => item.id === navState.details?.automationId)
    const detail = automation ? (
      <AutomationInfoPage
        automation={automation}
        onClose={navState.filter?.automationType === 'scheduled' ? () => { void navigate(routes.view.automationsScheduled()) } : undefined}
        executions={executions}
        testResult={automationTestResults?.[automation.id]}
        onTest={() => handleTestAutomation(automation.id)}
        onToggleEnabled={() => handleToggleAutomation(automation.id)}
        onDuplicate={() => handleDuplicateAutomation(automation.id)}
        onDelete={() => handleDeleteAutomation(automation.id)}
        onReplay={handleReplayAutomation}
        workspaceId={automationWorkspace?.id}
        workspaceRootPath={automationWorkspace?.rootPath}
      />
    ) : null
    if (navState.filter?.automationType === 'scheduled') {
      return wrapWithStoplight(
        <Panel variant="grow" className={className}>
          <ScheduledTasksOverview
            automations={automations}
            workspace={automationWorkspace}
            onSelectAutomation={(automationId) => navigate(routes.view.automationsScheduled(automationId))}
            selectedAutomationId={automation?.id}
            detail={detail}
            onCloseDetail={() => { void navigate(routes.view.automationsScheduled()) }}
          />
        </Panel>
      )
    }
    if (detail) return wrapWithStoplight(<Panel variant="grow" className={className}>{detail}</Panel>)
    return wrapWithStoplight(
      <Panel variant="grow" className={className}>
        <div className="flex items-center justify-center h-full text-muted-foreground">
          <p className="text-sm">{t("automations.noAutomationsConfigured")}</p>
        </div>
      </Panel>
    )
  }

  // Writing owns the default chat surface. Session metadata may arrive after
  // the file workspace, so this child activates ChatPage independently.
  if (isWritingNavigation(navState)) {
    return wrapWithStoplight(
      <Panel variant="grow" className={className}>
        <ChatPanelPlaceholder />
      </Panel>
    )
  }

  // Session routes reuse the same chat surface for history/deep links.
  if (isSessionsNavigation(navState)) {
    // Multi-select mode: show batch actions panel
    if (isMultiSelectActive) {
      return wrapWithStoplight(
        <Panel variant="grow" className={className}>
          <SessionBatchActionsPanel />
        </Panel>
      )
    }

    if (navState.details) {
      return wrapWithStoplight(
        <Panel variant="grow" className={className}>
          <SessionRouteContent
            sessionId={navState.details.sessionId}
            activeWorkspaceId={activeWorkspaceId}
            remoteWorkspaceId={remoteWorkspaceId}
          />
        </Panel>
      )
    }
    return wrapWithStoplight(
      <Panel variant="grow" className={className}>
        <ChatPanelPlaceholder empty />
      </Panel>
    )
  }

  // Fallback (should not happen with proper NavigationState)
  return wrapWithStoplight(
    <Panel variant="grow" className={className}>
      <ChatPanelPlaceholder empty />
    </Panel>
  )
}

function SendResourceWorkspaceDialogHost({
  open,
  onOpenChange,
  resourceType,
  resourceIds,
  resourceLabel,
  activeWorkspaceId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  resourceType: SendResourceType
  resourceIds: string[]
  resourceLabel: string
  activeWorkspaceId: string
}) {
  const workspaces = useAtomValue(windowWorkspacesAtom)

  return (
    <SendResourceToWorkspaceDialog
      open={open}
      onOpenChange={onOpenChange}
      resourceType={resourceType}
      resourceIds={resourceIds}
      resourceLabel={resourceLabel}
      workspaces={workspaces}
      activeWorkspaceId={activeWorkspaceId}
    />
  )
}

function SessionBatchActionsPanel() {
  const {
    onSessionStatusChange,
    onArchiveSession,
    onSessionLabelsChange,
    sessionStatuses,
    labels,
  } = useSessionBatchActions()
  const selectedIds = useSelectedIds()
  const selectedMetas = useSelectedSessionMetas()
  const selectionCount = useSelectionCount()
  const { clearMultiSelect } = useSessionSelection()

  const activeStatusId = useMemo((): SessionStatusId | null => {
    if (selectedMetas.length === 0) return null
    const first = (selectedMetas[0].sessionStatus || 'todo') as SessionStatusId
    const allSame = selectedMetas.every(meta => (meta.sessionStatus || 'todo') === first)
    return allSame ? first : null
  }, [selectedMetas])

  const appliedLabelIds = useMemo(() => {
    if (selectedMetas.length === 0) return new Set<string>()
    const toLabelSet = (meta: SessionMeta) =>
      new Set((meta.labels || []).map(entry => extractLabelId(entry)))
    const [first, ...rest] = selectedMetas.map(toLabelSet)
    const intersection = new Set(first)
    for (const labelSet of rest) {
      for (const id of [...intersection]) {
        if (!labelSet.has(id)) intersection.delete(id)
      }
    }
    return intersection
  }, [selectedMetas])

  const handleBatchSetStatus = useCallback((status: SessionStatusId) => {
    selectedIds.forEach(sessionId => {
      onSessionStatusChange(sessionId, status)
    })
  }, [selectedIds, onSessionStatusChange])

  const handleBatchArchive = useCallback(() => {
    selectedIds.forEach(sessionId => {
      onArchiveSession(sessionId)
    })
    clearMultiSelect()
  }, [selectedIds, onArchiveSession, clearMultiSelect])

  const handleBatchToggleLabel = useCallback((labelId: string) => {
    if (!onSessionLabelsChange) return
    const allHaveLabel = selectedMetas.every(meta =>
      (meta.labels || []).some(entry => extractLabelId(entry) === labelId)
    )

    selectedMetas.forEach(meta => {
      const labels = meta.labels || []
      const hasLabel = labels.some(entry => extractLabelId(entry) === labelId)
      const filtered = labels.filter(entry => extractLabelId(entry) !== labelId)
      const nextLabels = allHaveLabel
        ? filtered
        : (hasLabel ? labels : [...labels, labelId])
      onSessionLabelsChange(meta.id, nextLabels)
    })
  }, [selectedMetas, onSessionLabelsChange])

  return (
    <MultiSelectPanel
      count={selectionCount}
      sessionStatuses={sessionStatuses}
      activeStatusId={activeStatusId}
      onSetStatus={handleBatchSetStatus}
      labels={labels}
      appliedLabelIds={appliedLabelIds}
      onToggleLabel={handleBatchToggleLabel}
      onArchive={handleBatchArchive}
      onClearSelection={clearMultiSelect}
    />
  )
}

function SessionRouteContent({
  sessionId,
  activeWorkspaceId,
  remoteWorkspaceId,
}: {
  sessionId: string
  activeWorkspaceId?: string | null
  remoteWorkspaceId?: string | null
}) {
  const selectedSessionMeta = useAtomValue(sessionMetaAtomFamily(sessionId))
  const selectedSessionMatchesWorkspace = !activeWorkspaceId || (
    selectedSessionMeta?.workspaceId === activeWorkspaceId
    || (!!remoteWorkspaceId && selectedSessionMeta?.workspaceId === remoteWorkspaceId)
  )

  if (!selectedSessionMatchesWorkspace) {
    return <ChatPanelPlaceholder />
  }

  return (
    <React.Suspense fallback={<ChatPanelPlaceholder />}>
      <LazyChatPage sessionId={sessionId} />
    </React.Suspense>
  )
}
