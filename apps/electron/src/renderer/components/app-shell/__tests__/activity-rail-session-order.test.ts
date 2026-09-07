// input: Session metadata plus a workspace-scoped manual order
// output: Regression coverage for stable sidebar grouping and drag reorder
// pos: Protects the ActivityRail presentation contract from recency re-sorting

import { describe, expect, it } from 'bun:test'
import type { SessionMeta } from '@/atoms/sessions'
import {
  moveSessionId,
  normalizeSessionOrder,
  orderSessionMetas,
  partitionSessionMetas,
  setSessionPinnedInMetas,
} from '../activity-rail-session-order'

function meta(id: string, lastMessageAt: number, isPinned = false): SessionMeta {
  return {
    id,
    workspaceId: 'workspace-1',
    name: id,
    createdAt: lastMessageAt,
    lastMessageAt,
    isPinned,
  } as SessionMeta
}

describe('ActivityRail session order', () => {
  it('keeps a manual order while placing unseen new sessions first', () => {
    const sessions = [meta('older', 1), meta('new', 3), meta('newer', 2)]

    expect(orderSessionMetas(sessions, ['newer', 'older']).map(session => session.id))
      .toEqual(['new', 'newer', 'older'])
  })

  it('moves a dragged session before or after its drop target without losing other ids', () => {
    expect(moveSessionId(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
    expect(moveSessionId(['a', 'b', 'c'], 'a', 'b', 'after')).toEqual(['b', 'a', 'c'])
    expect(moveSessionId(['a', 'b', 'c'], 'a', 'c', 'after')).toEqual(['b', 'c', 'a'])
    expect(moveSessionId(['a', 'b', 'c'], 'b', 'b', 'after')).toEqual(['a', 'b', 'c'])
  })

  it('projects fixed sessions separately without duplicating or changing their order', () => {
    const ordered = [meta('fixed-2', 3, true), meta('normal', 2), meta('fixed-1', 1, true)]

    expect(partitionSessionMetas(ordered)).toEqual({
      fixed: [ordered[0], ordered[2]],
      regular: [ordered[1]],
    })
  })

  it('updates the cached projection for a session owned by an inactive workspace', () => {
    const cached = [meta('session-1', 1), meta('session-2', 2)]

    expect(setSessionPinnedInMetas(cached, 'session-1', true).map(session => session.isPinned))
      .toEqual([true, false])
  })

  it('rejects malformed persisted order values and removes duplicate ids', () => {
    expect(normalizeSessionOrder('session-1')).toEqual([])
    expect(normalizeSessionOrder({ ids: ['session-1'] })).toEqual([])
    expect(normalizeSessionOrder(['session-1', 42, 'session-1', 'session-2']))
      .toEqual(['session-1', 'session-2'])
  })
})
