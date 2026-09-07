import { describe, expect, it } from 'bun:test'
import {
  normalizePanelRouteForReconcile,
  shouldDefaultInitialRouteToWriting,
} from '../navigation-reconcile'
import type { NavigationState } from '../../../shared/types'

describe('shouldDefaultInitialRouteToWriting', () => {
  it('defaults an empty URL to writing', () => {
    expect(shouldDefaultInitialRouteToWriting(new URLSearchParams())).toBe(true)
  })

  it('preserves an explicit allSessions route across refresh', () => {
    expect(shouldDefaultInitialRouteToWriting(new URLSearchParams('ws=demo&route=allSessions'))).toBe(false)
  })

  it('does not override explicit routes or panel state', () => {
    expect(shouldDefaultInitialRouteToWriting(new URLSearchParams('route=writing'))).toBe(false)
    expect(shouldDefaultInitialRouteToWriting(new URLSearchParams('panels=allSessions/session/s1:1&fi=0'))).toBe(false)
  })
})

describe('normalizePanelRouteForReconcile', () => {
  it('auto-selects session details for filter-only session routes', () => {
    const resolver = (state: NavigationState): NavigationState => {
      if (state.navigator === 'sessions' && !state.details) {
        return {
          ...state,
          details: { type: 'session', sessionId: 's1' },
        }
      }
      return state
    }

    const normalized = normalizePanelRouteForReconcile('allSessions', resolver)
    expect(normalized).toBe('allSessions/session/s1')
  })

  it('keeps valid explicit session details unchanged when the resolver preserves them', () => {
    const resolver = (state: NavigationState): NavigationState => state

    const normalized = normalizePanelRouteForReconcile('allSessions/session/s2', resolver)
    expect(normalized).toBe('allSessions/session/s2')
  })

  it('normalizes invalid explicit session details through the resolver', () => {
    const resolver = (state: NavigationState): NavigationState => {
      if (state.navigator === 'sessions' && state.details?.sessionId === 'stale') {
        return {
          ...state,
          details: { type: 'session', sessionId: 'fresh' },
        }
      }
      return state
    }

    const normalized = normalizePanelRouteForReconcile('allSessions/session/stale', resolver)
    expect(normalized).toBe('allSessions/session/fresh')
  })

  it('normalizes each session panel route independently', () => {
    const resolver = (state: NavigationState): NavigationState => {
      if (state.navigator === 'sessions' && !state.details) {
        const sessionId = state.filter.kind === 'flagged' ? 'flagged-1' : 'all-1'
        return {
          ...state,
          details: { type: 'session', sessionId },
        }
      }
      return state
    }

    const routes = ['allSessions', 'flagged'] as const
    const normalized = routes.map((route) => normalizePanelRouteForReconcile(route, resolver))

    expect(normalized).toEqual(['allSessions/session/all-1', 'flagged/session/flagged-1'])
  })

  it('keeps route unchanged when resolver leaves state without details', () => {
    const resolver = (state: NavigationState): NavigationState => state

    const normalized = normalizePanelRouteForReconcile('allSessions', resolver)
    expect(normalized).toBe('allSessions')
  })

  it('passes skipAutoSelect through so default session landing stays list-only', () => {
    const resolver = (state: NavigationState, options?: { skipAutoSelect?: boolean }): NavigationState => {
      if (options?.skipAutoSelect) return state
      if (state.navigator === 'sessions' && !state.details) {
        return {
          ...state,
          details: { type: 'session', sessionId: 's1' },
        }
      }
      return state
    }

    const normalized = normalizePanelRouteForReconcile('allSessions', resolver, { skipAutoSelect: true })
    expect(normalized).toBe('allSessions')
  })

  it('keeps explicit session routes selected even when auto-select is skipped', () => {
    const resolver = (state: NavigationState, options?: { skipAutoSelect?: boolean }): NavigationState => {
      if (options?.skipAutoSelect) return state
      if (state.navigator === 'sessions' && !state.details) {
        return {
          ...state,
          details: { type: 'session', sessionId: 's1' },
        }
      }
      return state
    }

    const normalized = normalizePanelRouteForReconcile('allSessions/session/s2', resolver, { skipAutoSelect: true })
    expect(normalized).toBe('allSessions/session/s2')
  })

  it('keeps non-session routes unchanged with session-only resolver', () => {
    const resolver = (state: NavigationState): NavigationState => {
      if (state.navigator === 'sessions' && !state.details) {
        return {
          ...state,
          details: { type: 'session', sessionId: 's1' },
        }
      }
      return state
    }

    expect(normalizePanelRouteForReconcile('settings', resolver)).toBe('settings/app')
    expect(normalizePanelRouteForReconcile('sources', resolver)).toBe('sources')
  })

  it('uses the resolver as the authority for explicit detail routes', () => {
    const resolver = (state: NavigationState): NavigationState => {
      if ('details' in state) {
        if (state.navigator === 'sessions') {
          return { ...state, details: { type: 'session', sessionId: 'rewritten' } }
        }
        if (state.navigator === 'sources') {
          return { ...state, details: { type: 'source', sourceSlug: 'rewritten' } }
        }
      }
      return state
    }

    expect(normalizePanelRouteForReconcile('allSessions/session/s2', resolver)).toBe('allSessions/session/rewritten')
    expect(normalizePanelRouteForReconcile('sources/source/github', resolver)).toBe('sources/source/rewritten')
  })

  it('keeps explicit detail routes distinct across multiple panels', () => {
    const resolver = (state: NavigationState): NavigationState => state

    const routes = ['allSessions/session/left', 'allSessions/session/right'] as const
    const normalized = routes.map((route) => normalizePanelRouteForReconcile(route, resolver))

    expect(normalized).toEqual(['allSessions/session/left', 'allSessions/session/right'])
  })
})
