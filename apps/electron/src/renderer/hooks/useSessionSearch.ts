import { useState, useCallback, useEffect, useRef, useMemo } from "react"
import { startOfDay } from "date-fns"

import { searchLog } from "@/lib/logger"
import { parseLabelEntry } from "@craft-agent/shared/labels"
import { fuzzyScore } from "@craft-agent/shared/search"
import { getSessionTitle, getSessionStatus } from "@/utils/session"
import type { SessionMeta } from "@/atoms/sessions"
import type { ViewConfig } from "../../shared/views"
import type { SessionFilter } from "@/contexts/NavigationContext"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INITIAL_DISPLAY_LIMIT = 50
const BATCH_SIZE = 50
const MAX_SEARCH_RESULTS = 100

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Filter mode for tri-state filtering: include shows only matching, exclude hides matching */
export type FilterMode = 'include' | 'exclude'

export interface ContentSearchResult {
  matchCount: number
  snippet: string
}

/** Metadata for a collapsed group — emitted by the data pipeline so the renderer can show header-only groups */
export interface CollapsedGroupMeta {
  key: string
  count: number
}

export interface UseSessionSearchOptions {
  items: SessionMeta[]
  searchActive: boolean
  searchQuery: string
  workspaceId?: string
  currentFilter?: SessionFilter
  evaluateViews?: (meta: SessionMeta) => ViewConfig[]
  statusFilter?: Map<string, FilterMode>
  labelFilterMap?: Map<string, FilterMode>
  getDescendantLabelIds?: (labelId: string) => readonly string[]
  /** Collapsed group keys — collapsed items are excluded from pagination and flatItems */
  collapsedGroups?: Set<string>
  /** Grouping mode — needed to compute group keys for collapse-aware pagination */
  groupingMode?: 'date' | 'status' | 'unread'
  /** Ref to the ScrollArea viewport element — used for scroll-based pagination */
  scrollViewportRef?: React.RefObject<HTMLDivElement>
}

export interface UseSessionSearchResult {
  // Search state
  isSearchMode: boolean
  highlightQuery: string | undefined
  isSearchingContent: boolean
  /** Whether the search service is unavailable (e.g. ripgrep not found on remote server) */
  isSearchUnavailable: boolean
  /** Raw content search results — needed by SessionItem for `chatMatchCount` */
  contentSearchResults: Map<string, ContentSearchResult>

  // Filtered + grouped results
  matchingFilterItems: SessionMeta[]
  otherResultItems: SessionMeta[]
  exceededSearchLimit: boolean

  // Render-ready outputs
  flatItems: SessionMeta[]

  // Pagination
  hasMore: boolean
  /** Metadata for collapsed groups (key + item count) — used to build header-only placeholder groups */
  collapsedGroupsMeta: CollapsedGroupMeta[]

  // Refs
  searchInputRef: React.RefObject<HTMLInputElement>
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function getSessionDateGroupKey(item: SessionMeta): string {
  return startOfDay(new Date(item.lastMessageAt || 0)).toISOString()
}

function getCollapseGroupKey(item: SessionMeta, groupingMode?: 'date' | 'status' | 'unread'): string {
  if (groupingMode === 'status') return `status-${getSessionStatus(item)}`
  if (groupingMode === 'unread') return item.hasUnread ? 'unread-yes' : 'unread-no'
  return getSessionDateGroupKey(item)
}

export interface CollapsedPaginationResult {
  paginatedItems: SessionMeta[]
  hasMore: boolean
  collapsedGroupsMeta: CollapsedGroupMeta[]
}

const EMPTY_SEARCH_PAGINATION: CollapsedPaginationResult = {
  paginatedItems: [],
  hasMore: false,
  collapsedGroupsMeta: [],
}

export function computeCollapsedPagination(
  items: SessionMeta[],
  displayLimit: number,
  collapsedGroups?: Set<string>,
  groupingMode?: 'date' | 'status' | 'unread',
): CollapsedPaginationResult {
  // Fast path: no collapse state → original slice
  if (!collapsedGroups || collapsedGroups.size === 0) {
    return {
      paginatedItems: items.slice(0, displayLimit),
      hasMore: displayLimit < items.length,
      collapsedGroupsMeta: [],
    }
  }

  const itemGroupKeys: string[] = []
  const groupKeysInView = new Set<string>()
  for (const item of items) {
    const groupKey = getCollapseGroupKey(item, groupingMode)
    itemGroupKeys.push(groupKey)
    groupKeysInView.add(groupKey)
  }

  // Safety guard: don't allow collapse state to hide the entire list when only one
  // group exists in the current filtered view (there would be no meaningful collapse UX).
  if (groupKeysInView.size <= 1) {
    return {
      paginatedItems: items.slice(0, displayLimit),
      hasMore: displayLimit < items.length,
      collapsedGroupsMeta: [],
    }
  }

  const effectiveCollapsedKeys = new Set<string>()
  for (const key of collapsedGroups) {
    if (groupKeysInView.has(key)) effectiveCollapsedKeys.add(key)
  }

  if (effectiveCollapsedKeys.size === 0) {
    return {
      paginatedItems: items.slice(0, displayLimit),
      hasMore: displayLimit < items.length,
      collapsedGroupsMeta: [],
    }
  }

  const expandedItems: SessionMeta[] = []
  const collapsedCounts = new Map<string, number>()

  for (const [index, item] of items.entries()) {
    const groupKey = itemGroupKeys[index]

    if (effectiveCollapsedKeys.has(groupKey)) {
      collapsedCounts.set(groupKey, (collapsedCounts.get(groupKey) || 0) + 1)
    } else {
      expandedItems.push(item)
    }
  }

  const meta: CollapsedGroupMeta[] = Array.from(collapsedCounts.entries()).map(
    ([key, count]) => ({ key, count })
  )

  return {
    paginatedItems: expandedItems.slice(0, displayLimit),
    hasMore: displayLimit < expandedItems.length,
    collapsedGroupsMeta: meta,
  }
}

export function reuseContentSearchResultsIfEqual(
  previous: Map<string, ContentSearchResult>,
  next: Map<string, ContentSearchResult>
): Map<string, ContentSearchResult> {
  if (previous.size !== next.size) return next
  for (const [sessionId, previousResult] of previous) {
    const nextResult = next.get(sessionId)
    if (
      !nextResult ||
      previousResult.matchCount !== nextResult.matchCount ||
      previousResult.snippet !== nextResult.snippet
    ) {
      return next
    }
  }
  return previous
}

interface RankedSearchItem {
  item: SessionMeta
  score: number
  matchCount: number
}

function compareRankedSearchItems(a: RankedSearchItem, b: RankedSearchItem): number {
  if (a.score > 0 && b.score === 0) return -1
  if (a.score === 0 && b.score > 0) return 1
  if (a.score !== b.score) return b.score - a.score
  return b.matchCount - a.matchCount
}

function insertBoundedSearchItem(results: RankedSearchItem[], result: RankedSearchItem): void {
  const insertIndex = results.findIndex(existing => compareRankedSearchItems(result, existing) < 0)

  if (insertIndex === -1) {
    if (results.length < MAX_SEARCH_RESULTS) {
      results.push(result)
    }
    return
  }

  results.splice(insertIndex, 0, result)
  if (results.length > MAX_SEARCH_RESULTS) {
    results.pop()
  }
}

interface FilterMatchOptions {
  evaluateViews?: (meta: SessionMeta) => ViewConfig[]
  statusFilter?: Map<string, 'include' | 'exclude'>
  labelFilterMap?: Map<string, 'include' | 'exclude'>
  getDescendantLabelIds?: (labelId: string) => readonly string[]
}

export function sessionMatchesCurrentFilter(
  session: SessionMeta,
  currentFilter: SessionFilter | undefined,
  options: FilterMatchOptions = {}
): boolean {
  const { evaluateViews, statusFilter, labelFilterMap, getDescendantLabelIds } = options
  let sessionLabelIds: Set<string> | undefined

  const getSessionLabelIds = (): Set<string> => {
    if (!sessionLabelIds) {
      sessionLabelIds = new Set((session.labels ?? []).map(label => parseLabelEntry(label).id))
    }
    return sessionLabelIds
  }

  const sessionHasLabel = (labelId: string): boolean => {
    const labelIds = getSessionLabelIds()
    if (labelIds.has(labelId)) return true
    return getDescendantLabelIds?.(labelId).some(descendantId => labelIds.has(descendantId)) ?? false
  }

  const passesStatusFilter = (): boolean => {
    if (!statusFilter || statusFilter.size === 0) return true
    const sessionState = (session.sessionStatus || 'todo') as string

    let hasIncludes = false
    let matchesInclude = false
    for (const [stateId, mode] of statusFilter) {
      if (mode === 'exclude' && sessionState === stateId) return false
      if (mode === 'include') {
        hasIncludes = true
        if (sessionState === stateId) matchesInclude = true
      }
    }
    return !hasIncludes || matchesInclude
  }

  const passesLabelFilter = (): boolean => {
    if (!labelFilterMap || labelFilterMap.size === 0) return true

    let hasIncludes = false
    let matchesInclude = false
    for (const [labelId, mode] of labelFilterMap) {
      if (mode === 'exclude' && sessionHasLabel(labelId)) return false
      if (mode === 'include') {
        hasIncludes = true
        if (sessionHasLabel(labelId)) matchesInclude = true
      }
    }
    return !hasIncludes || matchesInclude
  }

  if (!passesStatusFilter() || !passesLabelFilter()) return false

  if (!currentFilter) return true

  switch (currentFilter.kind) {
    case 'allSessions':
      return session.isArchived !== true

    case 'flagged':
      return session.isFlagged === true && session.isArchived !== true

    case 'archived':
      return session.isArchived === true

    case 'state':
      return (session.sessionStatus || 'todo') === currentFilter.stateId && session.isArchived !== true

    case 'label': {
      if (!session.labels?.length) return false
      if (session.isArchived === true) return false
      if (currentFilter.labelId === '__all__') return true
      return sessionHasLabel(currentFilter.labelId)
    }

    case 'view':
      if (session.isArchived === true) return false
      if (!evaluateViews) return true
      const matched = evaluateViews(session)
      if (currentFilter.viewId === '__all__') return matched.length > 0
      return matched.some(v => v.id === currentFilter.viewId)

    default:
      void (currentFilter satisfies never)
      return true
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSessionSearch({
  items,
  searchActive,
  searchQuery,
  workspaceId,
  currentFilter,
  evaluateViews,
  statusFilter,
  labelFilterMap,
  getDescendantLabelIds,
  collapsedGroups,
  groupingMode,
  scrollViewportRef,
}: UseSessionSearchOptions): UseSessionSearchResult {

  const [contentSearchResults, setContentSearchResults] = useState<Map<string, ContentSearchResult>>(new Map())
  const [isSearchingContent, setIsSearchingContent] = useState(false)
  const [isSearchUnavailable, setIsSearchUnavailable] = useState(false)
  const [displayLimit, setDisplayLimit] = useState(INITIAL_DISPLAY_LIMIT)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const clearContentSearchResults = useCallback(() => {
    setContentSearchResults(prev => prev.size === 0 ? prev : new Map())
  }, [])

  // Search mode is active when search is open AND query has 2+ characters
  const isSearchMode = searchActive && searchQuery.length >= 2
  const highlightQuery = isSearchMode ? searchQuery : undefined

  // --- Content search (ripgrep IPC with debounce + cancellation) ---

  useEffect(() => {
    if (!workspaceId || !isSearchMode) {
      clearContentSearchResults()
      return
    }

    const searchId = Date.now().toString(36)
    searchLog.info('query:change', { searchId, query: searchQuery })

    let cancelled = false
    setIsSearchingContent(true)
    setIsSearchUnavailable(false)

    const timer = setTimeout(async () => {
      try {
        searchLog.info('ipc:call', { searchId })
        const ipcStart = performance.now()

        const results = await window.electronAPI.searchSessionContent(workspaceId, searchQuery, searchId)

        if (cancelled) return

        searchLog.info('ipc:received', {
          searchId,
          durationMs: Math.round(performance.now() - ipcStart),
          resultCount: results.length,
        })

        const resultMap = new Map<string, ContentSearchResult>()
        for (const result of results) {
          resultMap.set(result.sessionId, {
            matchCount: result.matchCount,
            snippet: result.matches[0]?.snippet || '',
          })
        }
        setContentSearchResults(prev => reuseContentSearchResultsIfEqual(prev, resultMap))

        requestAnimationFrame(() => {
          searchLog.info('render:complete', { searchId, sessionsDisplayed: resultMap.size })
        })
      } catch (error) {
        if (cancelled) return
        // Detect search unavailable (ripgrep not found) vs transient errors
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('SearchUnavailableError') || message.includes('ripgrep')) {
          console.warn('[useSessionSearch] Search unavailable:', message)
          setIsSearchUnavailable(true)
        } else {
          console.error('[useSessionSearch] Content search error:', error)
        }
        clearContentSearchResults()
      } finally {
        if (!cancelled) {
          setIsSearchingContent(false)
        }
      }
    }, 100)

    return () => {
      cancelled = true
      clearTimeout(timer)
      setIsSearchingContent(false)
    }
  }, [workspaceId, isSearchMode, searchQuery, clearContentSearchResults])

  // --- Focus search input when search activates ---

  useEffect(() => {
    if (searchActive) {
      searchInputRef.current?.focus()
    }
  }, [searchActive])

  // --- Data pipeline ---

  // Filter out hidden sessions before any processing
  const visibleItems = useMemo(() => items.filter(item => !item.hidden), [items])

  // Sort by most recent activity first
  const sortedItems = useMemo(() =>
    [...visibleItems].sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0)),
    [visibleItems]
  )

  // Filter items by search query or current filter
  const { searchFilteredItems, searchMatchCount } = useMemo(() => {
    if (!isSearchMode) {
      if (!searchActive) {
        return { searchFilteredItems: sortedItems, searchMatchCount: sortedItems.length }
      }

      const filteredItems = sortedItems.filter(item =>
        sessionMatchesCurrentFilter(item, currentFilter, {
          evaluateViews,
          statusFilter,
          labelFilterMap,
          getDescendantLabelIds,
        })
      )
      return { searchFilteredItems: filteredItems, searchMatchCount: filteredItems.length }
    }

    const rankedSearchItems: RankedSearchItem[] = []
    let searchMatchCount = 0
    for (const item of sortedItems) {
      const searchResult = contentSearchResults.get(item.id)
      if (!searchResult) continue
      searchMatchCount++
      insertBoundedSearchItem(rankedSearchItems, {
        item,
        score: fuzzyScore(getSessionTitle(item), searchQuery),
        matchCount: searchResult.matchCount,
      })
    }

    return {
      searchFilteredItems: rankedSearchItems.map(({ item }) => item),
      searchMatchCount,
    }
  }, [sortedItems, isSearchMode, searchActive, searchQuery, contentSearchResults, currentFilter, evaluateViews, statusFilter, labelFilterMap, getDescendantLabelIds])

  // Split search results: matching current filter vs others
  const { matchingFilterItems, otherResultItems, exceededSearchLimit } = useMemo(() => {
    const hasActiveFilters =
      (currentFilter && currentFilter.kind !== 'allSessions') ||
      (statusFilter && statusFilter.size > 0) ||
      (labelFilterMap && labelFilterMap.size > 0)

    const exceeded = searchMatchCount > MAX_SEARCH_RESULTS

    if (!isSearchMode) {
      const limitedItems = searchFilteredItems.slice(0, MAX_SEARCH_RESULTS)
      return { matchingFilterItems: limitedItems, otherResultItems: [] as SessionMeta[], exceededSearchLimit: exceeded }
    }

    if (!hasActiveFilters) {
      return { matchingFilterItems: searchFilteredItems, otherResultItems: [] as SessionMeta[], exceededSearchLimit: exceeded }
    }

    const matching: SessionMeta[] = []
    const others: SessionMeta[] = []

    for (const item of searchFilteredItems) {
      if (matching.length + others.length >= MAX_SEARCH_RESULTS) break

      const matches = sessionMatchesCurrentFilter(item, currentFilter, {
        evaluateViews,
        statusFilter,
        labelFilterMap,
        getDescendantLabelIds,
      })
      if (matches) {
        matching.push(item)
      } else {
        others.push(item)
      }
    }

    return { matchingFilterItems: matching, otherResultItems: others, exceededSearchLimit: exceeded }
  }, [searchFilteredItems, currentFilter, evaluateViews, isSearchMode, statusFilter, labelFilterMap, searchQuery, searchMatchCount, getDescendantLabelIds])

  // --- Pagination ---

  useEffect(() => {
    setDisplayLimit(INITIAL_DISPLAY_LIMIT)
  }, [searchQuery])

  // Collapse-aware pagination: collapsed items are excluded entirely from
  // paginatedItems (and therefore flatItems / keyboard nav). Their counts are
  // returned as collapsedGroupsMeta so the renderer can show header-only groups.
  const { paginatedItems, hasMore, collapsedGroupsMeta } = useMemo(() => {
    if (isSearchMode) {
      return EMPTY_SEARCH_PAGINATION
    }
    return computeCollapsedPagination(searchFilteredItems, displayLimit, collapsedGroups, groupingMode)
  }, [isSearchMode, searchFilteredItems, displayLimit, collapsedGroups, groupingMode])

  const loadMore = useCallback(() => {
    setDisplayLimit(prev => Math.min(prev + BATCH_SIZE, searchFilteredItems.length))
  }, [searchFilteredItems.length])

  // Scroll-based pagination: listen for scroll on the actual ScrollArea viewport
  // (IntersectionObserver with root=null doesn't detect scroll inside Radix ScrollArea)
  useEffect(() => {
    if (!hasMore) return
    const viewport = scrollViewportRef?.current
    if (!viewport) return

    const check = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport
      if (scrollHeight - scrollTop - clientHeight < 200) {
        loadMore()
      }
    }

    check() // fill viewport on mount / after group expand
    viewport.addEventListener('scroll', check, { passive: true })
    return () => viewport.removeEventListener('scroll', check)
  }, [hasMore, loadMore, displayLimit, scrollViewportRef])

  // --- Derived render data ---

  const flatItems = useMemo(() => {
    if (isSearchMode) {
      return otherResultItems.length === 0
        ? matchingFilterItems
        : [...matchingFilterItems, ...otherResultItems]
    }
    return paginatedItems
  }, [isSearchMode, matchingFilterItems, otherResultItems, paginatedItems])

  return {
    isSearchMode,
    highlightQuery,
    isSearchingContent,
    isSearchUnavailable,
    contentSearchResults,
    matchingFilterItems,
    otherResultItems,
    exceededSearchLimit,
    flatItems,
    hasMore,
    collapsedGroupsMeta,
    searchInputRef,
  }
}
