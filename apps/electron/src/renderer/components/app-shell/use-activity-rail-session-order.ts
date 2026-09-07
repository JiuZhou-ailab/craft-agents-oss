// input: Workspace-scoped Session metadata plus transactional pin/unpin actions
// output: Multi-window-safe order projection and native drag handlers for ActivityRail
// pos: Renderer controller for sidebar session movement within one workspace

import * as React from 'react'
import type { SessionMeta } from '@/atoms/sessions'
import * as storage from '@/lib/local-storage'
import type { ActivityRailSessionDragHandlers } from './ActivityRailRows'
import { moveSessionIdBefore, normalizeSessionOrder, orderSessionMetas } from './activity-rail-session-order'

type SessionOrderByWorkspace = Record<string, string[]>

export function useActivityRailSessionOrder(actions?: {
  onPin?: (sessionId: string, workspaceId: string) => Promise<boolean>
  onUnpin?: (sessionId: string, workspaceId: string) => Promise<boolean>
}) {
  const [orderByWorkspace, setOrderByWorkspace] = React.useState<SessionOrderByWorkspace>({})
  const [draggedSession, setDraggedSession] = React.useState<{ id: string; workspaceId: string } | null>(null)

  const orderWorkspaceSessions = React.useCallback((workspaceId: string, metas: readonly SessionMeta[]) => {
    const persisted = orderByWorkspace[workspaceId]
      ?? normalizeSessionOrder(storage.get<unknown>(storage.KEYS.activitySessionOrder, [], workspaceId))
    return orderSessionMetas(metas, persisted)
  }, [orderByWorkspace])

  const persistOrder = React.useCallback((workspaceId: string, ids: string[]) => {
    const normalized = normalizeSessionOrder(ids)
    storage.set(storage.KEYS.activitySessionOrder, normalized, workspaceId)
    setOrderByWorkspace(previous => ({ ...previous, [workspaceId]: normalized }))
  }, [])

  React.useEffect(() => {
    const keyPrefix = `${storage.getKeyString(storage.KEYS.activitySessionOrder)}:`
    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || !event.key?.startsWith(keyPrefix)) return
      const workspaceId = event.key.slice(keyPrefix.length)
      let parsed: unknown = []
      try {
        parsed = event.newValue === null ? [] : JSON.parse(event.newValue)
      } catch {
        parsed = []
      }
      const normalized = normalizeSessionOrder(parsed)
      setOrderByWorkspace(previous => ({ ...previous, [workspaceId]: normalized }))
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  const createDragHandlers = React.useCallback((
    workspaceId: string,
    metas: SessionMeta[],
  ): ActivityRailSessionDragHandlers => {
    const orderedMetas = orderWorkspaceSessions(workspaceId, metas)

    const moveToGroup = (draggedId: string, fixed: boolean): string[] => {
      const orderedIds = orderedMetas.map(meta => meta.id)
      const firstGroupTarget = orderedMetas.find(meta => (
        meta.id !== draggedId && Boolean(meta.isPinned) === fixed
      ))
      if (firstGroupTarget) return moveSessionIdBefore(orderedIds, draggedId, firstGroupTarget.id)
      const remaining = orderedIds.filter(id => id !== draggedId)
      return fixed ? [draggedId, ...remaining] : [...remaining, draggedId]
    }

    const updatePinnedState = async (draggedId: string, fixed: boolean): Promise<boolean> => {
      const draggedMeta = metas.find(meta => meta.id === draggedId)
      if (!draggedMeta) return false
      if (Boolean(draggedMeta.isPinned) === fixed) return true
      const action = fixed ? actions?.onPin : actions?.onUnpin
      return action ? action(draggedId, workspaceId) : false
    }

    return {
      draggingSessionId: draggedSession?.workspaceId === workspaceId ? draggedSession.id : null,
      onDragStart: (event, meta) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', meta.id)
        setDraggedSession({ id: meta.id, workspaceId })
      },
      onDragEnd: () => setDraggedSession(null),
      onDropOnSession: (event, target) => {
        event.preventDefault()
        event.stopPropagation()
        if (!draggedSession || draggedSession.workspaceId !== workspaceId) return
        const draggedId = draggedSession.id
        void (async () => {
          const updated = await updatePinnedState(draggedId, Boolean(target.isPinned))
          if (updated) {
            persistOrder(
              workspaceId,
              moveSessionIdBefore(orderedMetas.map(meta => meta.id), draggedId, target.id),
            )
          }
          setDraggedSession(null)
        })()
      },
      onDropOnGroup: (event, fixed) => {
        event.preventDefault()
        event.stopPropagation()
        if (!draggedSession || draggedSession.workspaceId !== workspaceId) return
        const draggedId = draggedSession.id
        void (async () => {
          const updated = await updatePinnedState(draggedId, fixed)
          if (updated) persistOrder(workspaceId, moveToGroup(draggedId, fixed))
          setDraggedSession(null)
        })()
      },
    }
  }, [actions, draggedSession, orderWorkspaceSessions, persistOrder])

  return { createDragHandlers, orderWorkspaceSessions }
}
