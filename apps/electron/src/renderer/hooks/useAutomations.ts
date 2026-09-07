// input: Project or standalone task runtime ID and Electron automation APIs
// output: Runtime-owned metadata, action results, deletion confirmation, and mutation handlers
// pos: Renderer hook boundary between AppShell automation UI and backend automation config

/**
 * useAutomations
 *
 * Encapsulates all automations state management:
 * - Loading automations from automations.json
 * - Subscribing to live updates
 * - Test, toggle, duplicate, delete handlers
 * - Delete confirmation state
 * - Each consumer owns an explicit runtime; concurrent loads are coalesced
 */

import { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { Workspace } from '../../shared/types'
import { parseAutomationsConfig, type AutomationListItem, type TestResult, type ExecutionEntry } from '@/components/automations/types'

type AutomationsLoadApi = Pick<typeof window.electronAPI, 'getAutomations' | 'getAutomationLastExecuted'>

const automationsLoadCache = new Map<string, Promise<AutomationListItem[]>>()

export function __resetAutomationsLoadCacheForTests(): void {
  automationsLoadCache.clear()
}

async function loadAutomationsFromServer(
  workspaceId: string,
  api: AutomationsLoadApi,
): Promise<AutomationListItem[]> {
  const json = await api.getAutomations(workspaceId)
  if (!json) return [] // No automations configured yet
  return parseAutomationsConfig(json)
}

export function loadAutomationsForWorkspace(
  workspaceId: string,
  api: AutomationsLoadApi = window.electronAPI,
): Promise<AutomationListItem[]> {
  const existing = automationsLoadCache.get(workspaceId)
  if (existing) return existing

  const promise = (async () => {
    const items = await loadAutomationsFromServer(workspaceId, api)
    try {
      const map = await api.getAutomationLastExecuted(workspaceId)
      return items.map((item) => ({
        ...item,
        lastExecutedAt: map[item.id] ?? item.lastExecutedAt,
      }))
    } catch {
      return items
    }
  })()

  automationsLoadCache.set(workspaceId, promise)
  const clearIfCurrent = () => {
    if (automationsLoadCache.get(workspaceId) === promise) {
      automationsLoadCache.delete(workspaceId)
    }
  }
  promise.then(clearIfCurrent, clearIfCurrent)

  return promise
}

export interface UseAutomationsResult extends UseAutomationActionsResult {
  automations: AutomationListItem[]
  automationWorkspace: Workspace | null
}

export interface UseAutomationActionsResult {
  automationTestResults: Record<string, TestResult>
  automationPendingDelete: string | null
  pendingDeleteAutomation: AutomationListItem | undefined
  setAutomationPendingDelete: (id: string | null) => void
  handleTestAutomation: (automationId: string) => void
  handleToggleAutomation: (automationId: string) => void
  handleDuplicateAutomation: (automationId: string) => void
  handleDeleteAutomation: (automationId: string) => void
  confirmDeleteAutomation: () => void
  getAutomationHistory: (automationId: string) => Promise<ExecutionEntry[]>
  handleReplayAutomation: (automationId: string, event: string) => void
}

export function useAutomationActions(
  activeWorkspaceId: string | null | undefined,
  automations: AutomationListItem[],
): UseAutomationActionsResult {
  const { t } = useTranslation()
  const [testResultsByRuntime, setTestResultsByRuntime] = useState<Record<string, Record<string, TestResult>>>({})
  const [pendingDelete, setPendingDelete] = useState<{ workspaceId: string; automationId: string } | null>(null)
  const automationTestResults = activeWorkspaceId ? testResultsByRuntime[activeWorkspaceId] ?? {} : {}
  const automationPendingDelete = pendingDelete && pendingDelete.workspaceId === activeWorkspaceId ? pendingDelete.automationId : null
  const setAutomationPendingDelete = useCallback((automationId: string | null) => {
    setPendingDelete(automationId && activeWorkspaceId ? { workspaceId: activeWorkspaceId, automationId } : null)
  }, [activeWorkspaceId])
  const setTestResult = useCallback((automationId: string, result: TestResult) => {
    if (!activeWorkspaceId) return
    setTestResultsByRuntime(previous => ({
      ...previous,
      [activeWorkspaceId]: { ...previous[activeWorkspaceId], [automationId]: result },
    }))
  }, [activeWorkspaceId])

  // Shared lookup — avoids repeating automations.find() in every callback
  const findAutomation = useCallback((id: string) => automations.find(h => h.id === id), [automations])

  // Test automation — aggregate all action results
  const handleTestAutomation = useCallback((automationId: string) => {
    const automation = findAutomation(automationId)
    if (!automation || !activeWorkspaceId) return

    setTestResult(automationId, { state: 'running' })

    window.electronAPI.testAutomation({
      workspaceId: activeWorkspaceId,
      automationId: automation.id,
      sessionId: automation.sessionId,
      automationName: automation.name,
      actions: automation.actions,
      permissionMode: automation.permissionMode,
      labels: automation.labels,
      telegramTopic: automation.telegramTopic,
    }).then((result) => {
      const actions = result.actions
      if (!actions || actions.length === 0) {
        setTestResult(automationId, { state: 'error', stderr: 'No actions to execute' })
        return
      }
      const hasError = actions.some(a => !a.success)
      const state = hasError ? 'error' : 'success'
      const stderr = actions.map(a => ('stderr' in a ? a.stderr : 'error' in a ? a.error : undefined)).filter(Boolean).join('\n')
      const duration = actions.reduce((sum, a) => sum + (a.duration ?? 0), 0)
      setTestResult(automationId, {
        state,
        stderr: stderr || undefined,
        duration: duration || undefined,
      })
    }).catch((err: Error) => {
      setTestResult(automationId, { state: 'error', stderr: err.message })
    })
  }, [findAutomation, activeWorkspaceId, setTestResult])

  const handleToggleAutomation = useCallback((automationId: string) => {
    const automation = findAutomation(automationId)
    if (!automation || !activeWorkspaceId) return
    window.electronAPI.setAutomationEnabled(
      activeWorkspaceId,
      automation.event,
      automation.matcherIndex,
      !automation.enabled,
    ).catch(() => {
      toast.error(t('toast.failedToToggleAutomation'))
    })
  }, [findAutomation, activeWorkspaceId])

  const handleDuplicateAutomation = useCallback((automationId: string) => {
    const automation = findAutomation(automationId)
    if (!automation || !activeWorkspaceId) return
    window.electronAPI.duplicateAutomation(activeWorkspaceId, automation.event, automation.matcherIndex)
      .catch(() => toast.error(t('toast.failedToDuplicateAutomation')))
  }, [findAutomation, activeWorkspaceId])

  // Delete: show confirmation dialog
  const handleDeleteAutomation = setAutomationPendingDelete

  const pendingDeleteAutomation = automationPendingDelete ? findAutomation(automationPendingDelete) : undefined

  const confirmDeleteAutomation = useCallback(() => {
    if (!pendingDeleteAutomation || !activeWorkspaceId) return
    window.electronAPI.deleteAutomation(activeWorkspaceId, pendingDeleteAutomation.event, pendingDeleteAutomation.matcherIndex)
      .catch(() => toast.error(t('toast.failedToDeleteAutomation')))
    setAutomationPendingDelete(null)
  }, [pendingDeleteAutomation, activeWorkspaceId, setAutomationPendingDelete])

  // Fetch execution history for a specific automation
  const getAutomationHistory = useCallback(async (automationId: string): Promise<ExecutionEntry[]> => {
    if (!activeWorkspaceId) return []
    try {
      const entries = await window.electronAPI.getAutomationHistory(activeWorkspaceId, automationId, 20)
      const automation = findAutomation(automationId)
      return entries.map(e => ({
        id: `${e.id}-${e.ts}`,
        automationId: e.id,
        event: automation?.event ?? 'LabelAdd',
        status: e.ok ? 'success' as const : 'error' as const,
        duration: e.webhook?.durationMs ?? 0,
        timestamp: e.ts,
        sessionId: e.sessionId,
        actionSummary: e.webhook
          ? `Webhook ${e.webhook.method} ${e.webhook.url}${e.webhook.attempts && e.webhook.attempts > 1 ? ` (${e.webhook.attempts} attempts)` : ''}`
          : e.prompt,
        error: e.webhook?.error ?? e.error,
        webhookDetails: e.webhook ? {
          method: e.webhook.method,
          url: e.webhook.url,
          statusCode: e.webhook.statusCode,
          durationMs: e.webhook.durationMs,
          attempts: e.webhook.attempts,
          error: e.webhook.error,
          responseBody: e.webhook.responseBody,
        } : undefined,
      }))
    } catch {
      return []
    }
  }, [activeWorkspaceId, findAutomation])

  // Replay failed webhook actions for a specific automation
  const handleReplayAutomation = useCallback((automationId: string, event: string) => {
    if (!activeWorkspaceId) return
    window.electronAPI.replayAutomation(activeWorkspaceId, automationId, event)
      .then(() => {
        toast.success(t('toast.webhookReplayCompleted'))
      })
      .catch((err: Error) => {
        toast.error(t("toast.replayFailed", { error: err.message }))
      })
  }, [activeWorkspaceId])

  return {
    automationTestResults,
    automationPendingDelete,
    pendingDeleteAutomation,
    setAutomationPendingDelete,
    handleTestAutomation,
    handleToggleAutomation,
    handleDuplicateAutomation,
    handleDeleteAutomation,
    confirmDeleteAutomation,
    getAutomationHistory,
    handleReplayAutomation,
  }
}

const EMPTY_AUTOMATIONS: AutomationListItem[] = []

export function useAutomations(
  activeWorkspaceId: string | null | undefined,
): UseAutomationsResult {
  const [loaded, setLoaded] = useState<{ workspace: Workspace; automations: AutomationListItem[] } | null>(null)
  const current = loaded?.workspace.id === activeWorkspaceId ? loaded : null
  const automations = current?.automations ?? EMPTY_AUTOMATIONS
  const automationWorkspace = current?.workspace ?? null
  useEffect(() => {
    if (!activeWorkspaceId) return
    let cancelled = false
    let revision = 0
    const load = async () => {
      const request = ++revision
      try {
        const [workspace, items] = await Promise.all([
          window.electronAPI.resolveRuntimeWorkspace(activeWorkspaceId),
          loadAutomationsForWorkspace(activeWorkspaceId),
        ])
        if (!cancelled && request === revision) {
          setLoaded(workspace ? { workspace, automations: items } : null)
        }
      } catch {
        if (!cancelled && request === revision) setLoaded(null)
      }
    }
    void load()
    const unsubscribe = window.electronAPI.onAutomationsChanged(() => { void load() })
    return () => { cancelled = true; unsubscribe() }
  }, [activeWorkspaceId])

  const actions = useAutomationActions(activeWorkspaceId, automations)
  return { automations, automationWorkspace, ...actions }
}
