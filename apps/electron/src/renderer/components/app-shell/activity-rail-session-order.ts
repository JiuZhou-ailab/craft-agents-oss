// input: Workspace-scoped Session metadata and a persisted manual id order
// output: Deterministic sidebar ordering, grouping, and move operations
// pos: Pure presentation policy for ActivityRail conversation lists

import type { SessionMeta } from '@/atoms/sessions'

export function normalizeSessionOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.filter((id): id is string => {
    if (typeof id !== 'string' || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

function recency(meta: SessionMeta): number {
  return meta.lastMessageAt ?? meta.createdAt ?? 0
}

export function orderSessionMetas(
  metas: readonly SessionMeta[],
  preferredIds: readonly string[],
): SessionMeta[] {
  const preferredIndex = new Map(normalizeSessionOrder(preferredIds).map((id, index) => [id, index]))

  return [...metas].sort((left, right) => {
    const leftIndex = preferredIndex.get(left.id)
    const rightIndex = preferredIndex.get(right.id)
    if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex
    if (leftIndex !== undefined) return 1
    if (rightIndex !== undefined) return -1
    return recency(right) - recency(left)
  })
}

export function moveSessionId(
  orderedIds: readonly string[],
  draggedId: string,
  targetId: string,
  position: 'before' | 'after' = 'before',
): string[] {
  if (draggedId === targetId) return [...orderedIds]
  const withoutDragged = orderedIds.filter(id => id !== draggedId)
  const targetIndex = withoutDragged.indexOf(targetId)
  if (targetIndex < 0) return [...withoutDragged, draggedId]
  const insertionIndex = targetIndex + (position === 'after' ? 1 : 0)
  return [
    ...withoutDragged.slice(0, insertionIndex),
    draggedId,
    ...withoutDragged.slice(insertionIndex),
  ]
}

export function partitionSessionMetas(metas: readonly SessionMeta[]): {
  fixed: SessionMeta[]
  regular: SessionMeta[]
} {
  const fixed: SessionMeta[] = []
  const regular: SessionMeta[] = []
  for (const meta of metas) {
    if (meta.isPinned) fixed.push(meta)
    else regular.push(meta)
  }
  return { fixed, regular }
}

export function setSessionPinnedInMetas(
  metas: readonly SessionMeta[],
  sessionId: string,
  isPinned: boolean,
): SessionMeta[] {
  return metas.map(meta => meta.id === sessionId ? { ...meta, isPinned } : meta)
}
