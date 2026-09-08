// input: Project catalog, active workspace metadata, writing files, and open callbacks
// output: Ranked application search across projects and active-runtime content
// pos: Top-bar search surface; composes app navigation without crossing runtime ownership

import * as React from 'react'
import { FileText, FolderKanban, MessageSquareText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import type { DocumentSearchTarget } from '@craft-agent/ui'
import type { Workspace, WorkspaceSearchHit } from '../../../shared/types'
import { sessionMetaMapAtom, type SessionMeta } from '@/atoms/sessions'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { buildGlobalSearchResults } from '@/lib/global-search'
import type { NovelWorkspaceFile } from '@/lib/writing-workspace'
import { cn } from '@/lib/utils'
import { highlightMatch } from '@/utils/session'

export interface GlobalSearchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId?: string
  workspaceLabel?: string
  remoteWorkspaceId?: string | null
  workspaces: Workspace[]
  novelFiles: NovelWorkspaceFile[]
  formatNovelFileTitle: (file: NovelWorkspaceFile) => string
  onOpenWorkspace: (workspaceId: string) => void | Promise<void>
  onOpenSession: (workspaceId: string, sessionId: string, query: string) => void | Promise<void>
  onOpenNovelFile: (path: string, target?: DocumentSearchTarget) => void | Promise<void>
}

type SearchState = 'idle' | 'searching' | 'complete' | 'unavailable' | 'error'

function workspaceHitKey(hit: WorkspaceSearchHit): string {
  return hit.kind === 'session' ? `session:${hit.sessionId}` : `document:${hit.path}`
}

function reuseGlobalSearchContentResults(
  previous: Map<string, WorkspaceSearchHit>,
  next: Map<string, WorkspaceSearchHit>,
): Map<string, WorkspaceSearchHit> {
  if (previous.size !== next.size) return next
  for (const [key, previousHit] of previous) {
    const nextHit = next.get(key)
    if (!nextHit || JSON.stringify(previousHit) !== JSON.stringify(nextHit)) return next
  }
  return previous
}

export function GlobalSearchDialog(props: GlobalSearchDialogProps) {
  return props.open ? <GlobalSearchDialogContent {...props} /> : null
}

function GlobalSearchDialogContent(props: GlobalSearchDialogProps) {
  const { t } = useTranslation()
  const [query, setQuery] = React.useState('')
  const [isComposing, setIsComposing] = React.useState(false)
  const hasQuery = query.trim().length >= 2
  const workspaceLabel = props.workspaceLabel?.trim() || t('globalSearch.currentWorkspace', 'Current workspace')
  const scopeDescription = props.workspaceId
    ? t('globalSearch.scopeHint', {
        workspace: workspaceLabel,
        defaultValue: 'Search all project names, plus conversations and files in “{{workspace}}”.',
      })
    : t('globalSearch.projectsOnlyHint', 'No workspace is open, so only project names are searched.')

  return (
    <CommandDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      shouldFilter={false}
      title={t('globalSearch.dialogTitle', 'Application search')}
      description={scopeDescription}
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => setIsComposing(false)}
        placeholder={props.workspaceId
          ? t('globalSearch.placeholder', {
              workspace: workspaceLabel,
              defaultValue: 'Search projects, or conversations and files in “{{workspace}}”...',
            })
          : t('globalSearch.projectsOnlyPlaceholder', 'Search projects...')}
      />
      <CommandList className="max-h-[min(520px,70vh)]">
        {!hasQuery ? (
          <CommandEmpty className="space-y-1 px-6 py-8 text-xs text-muted-foreground">
            <div>{t('globalSearch.hint', 'Type at least 2 characters to search.')}</div>
            <div className="text-[11px] text-muted-foreground/75">{scopeDescription}</div>
          </CommandEmpty>
        ) : (
          <GlobalSearchResults {...props} query={query} isComposing={isComposing} />
        )}
      </CommandList>
    </CommandDialog>
  )
}

function GlobalSearchResults({
  workspaceId,
  remoteWorkspaceId,
  workspaceLabel: workspaceLabelProp,
  workspaces,
  novelFiles,
  formatNovelFileTitle,
  onOpenChange,
  onOpenWorkspace,
  onOpenSession,
  onOpenNovelFile,
  query,
  isComposing,
}: GlobalSearchDialogProps & { query: string; isComposing: boolean }) {
  const { t } = useTranslation()
  const trimmedQuery = query.trim()
  const workspaceLabel = workspaceLabelProp?.trim() || t('globalSearch.currentWorkspace', 'Current workspace')
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const [contentResults, setContentResults] = React.useState<Map<string, WorkspaceSearchHit>>(new Map())
  const [searchState, setSearchState] = React.useState<SearchState>('idle')
  const clearContentResults = React.useCallback(() => {
    setContentResults(prev => prev.size === 0 ? prev : new Map())
  }, [])

  const sessions = React.useMemo(() => {
    if (!workspaceId) return []
    const result: SessionMeta[] = []
    for (const meta of sessionMetaMap.values()) {
      if (meta.hidden) continue
      if (
        meta.workspaceId !== workspaceId &&
        (!remoteWorkspaceId || meta.workspaceId !== remoteWorkspaceId)
      ) {
        continue
      }
      result.push(meta)
    }
    return result
  }, [remoteWorkspaceId, sessionMetaMap, workspaceId])

  React.useEffect(() => {
    if (isComposing || !workspaceId) {
      clearContentResults()
      setSearchState('idle')
      return
    }

    let cancelled = false
    setSearchState('searching')
    const requestId = crypto.randomUUID()
    let started = false
    const timer = window.setTimeout(async () => {
      try {
        started = true
        const response = await window.electronAPI.searchWorkspace({ query: trimmedQuery, requestId })
        if (cancelled || response.status === 'cancelled') return
        const resultMap = new Map(response.hits.map(hit => [workspaceHitKey(hit), hit]))
        setContentResults(prev => reuseGlobalSearchContentResults(prev, resultMap))
        setSearchState(response.status)
      } catch (error) {
        if (cancelled) return
        console.error('[GlobalSearch] Search failed:', error)
        clearContentResults()
        setSearchState('error')
      }
    }, 120)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      if (started) void window.electronAPI.cancelWorkspaceSearch(requestId).catch((error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'CHANNEL_NOT_FOUND') return
        console.warn('[GlobalSearch] Cancellation failed:', error)
      })
    }
  }, [isComposing, trimmedQuery, workspaceId, clearContentResults])

  const results = React.useMemo(
    () => buildGlobalSearchResults({
      query,
      workspaces,
      sessions,
      novelFiles,
      workspaceSearchHits: Array.from(contentResults.values()),
      formatNovelFileTitle,
    }),
    [contentResults, formatNovelFileTitle, novelFiles, query, sessions, workspaces],
  )
  const hasResults = results.workspaces.length > 0 || results.sessions.length > 0 || results.files.length > 0
  const closeAndRun = (action: () => void | Promise<void>) => {
    onOpenChange(false)
    void action()
  }

  return (
    <>
      {/* Non-localized completion signal for the perf harness: content search is
          debounced + ripgrep-backed, so "first result rendered" does not mean done. */}
      <div hidden data-global-search-state={searchState} />
      {!hasResults && searchState !== 'searching' ? (
        <CommandEmpty className="py-8 text-xs text-muted-foreground">
          {t('globalSearch.empty', 'No results found.')}
        </CommandEmpty>
      ) : null}

      {results.workspaces.length > 0 ? (
        <CommandGroup heading={t('globalSearch.switchProjects', 'Switch projects')}>
          {results.workspaces.map(({ workspace }) => (
            <CommandItem
              key={`workspace:${workspace.id}`}
              value={`workspace:${workspace.id}`}
              onSelect={() => closeAndRun(() => onOpenWorkspace(workspace.id))}
              className="gap-3 rounded-[6px] px-2.5 py-2"
            >
              <SearchResultIcon><FolderKanban className="h-4 w-4" /></SearchResultIcon>
              <div className="min-w-0 flex-1 truncate text-sm font-medium">
                {highlightMatch(workspace.name, trimmedQuery)}
              </div>
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}

      {results.sessions.length > 0 && workspaceId ? (
        <CommandGroup heading={t('globalSearch.sessionsInWorkspace', {
          workspace: workspaceLabel,
          defaultValue: '{{workspace}} · Conversations',
        })}>
          {results.sessions.map(({ session, title, preview, matchCount }) => (
            <CommandItem
              key={`session:${session.id}`}
              value={`session:${session.id}`}
              onSelect={() => closeAndRun(() => onOpenSession(workspaceId, session.id, query.trim()))}
              className="items-start gap-3 rounded-[6px] px-2.5 py-2"
            >
              <SearchResultIcon><MessageSquareText className="h-4 w-4" /></SearchResultIcon>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{highlightMatch(title, trimmedQuery)}</div>
                {preview ? (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {highlightMatch(preview, trimmedQuery)}
                  </div>
                ) : null}
              </div>
              {matchCount ? (
                <MatchCount label={t('globalSearch.matchCount', {
                  count: matchCount,
                  defaultValue: '{{count}} matches',
                })} />
              ) : null}
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}

      {results.files.length > 0 ? (
        <CommandGroup heading={t('globalSearch.filesInWorkspace', {
          workspace: workspaceLabel,
          defaultValue: '{{workspace}} · Files',
        })}>
          {results.files.map(({ file, title, preview, matchCount, lineNumber }) => (
            <CommandItem
              key={`file:${file.path}`}
              value={`file:${file.path}`}
              onSelect={() => closeAndRun(() => onOpenNovelFile(file.path, lineNumber ? { lineNumber, query: trimmedQuery, snippet: preview ?? '', requestId: crypto.randomUUID() } : undefined))}
              className="items-start gap-3 rounded-[6px] px-2.5 py-2"
            >
              <SearchResultIcon><FileText className="h-4 w-4" /></SearchResultIcon>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{highlightMatch(title, trimmedQuery)}</div>
                {preview ? (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {highlightMatch(preview, trimmedQuery)}
                  </div>
                ) : null}
                <div className="mt-0.5 truncate text-[11px] text-muted-foreground/75">
                  {file.relativePath}{lineNumber ? `:${lineNumber}` : ''}
                </div>
              </div>
              {matchCount ? (
                <MatchCount label={t('globalSearch.matchCount', {
                  count: matchCount,
                  defaultValue: '{{count}} matches',
                })} />
              ) : null}
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}

      {searchState === 'searching' ? (
        <SearchStatus>{t('globalSearch.searchingContent', {
          workspace: workspaceLabel,
          defaultValue: 'Searching content in “{{workspace}}”...',
        })}</SearchStatus>
      ) : null}
      {searchState === 'unavailable' || searchState === 'error' ? (
        <SearchStatus>{t('common.unavailable', 'Content search is temporarily unavailable.')}</SearchStatus>
      ) : null}
    </>
  )
}

function MatchCount({ label }: { label: string }) {
  return (
    <span
      className="mt-1 shrink-0 rounded-[4px] bg-foreground/[0.05] px-1.5 py-0.5 text-[11px] text-muted-foreground"
      title={label}
    >
      {label}
    </span>
  )
}

function SearchStatus({ children }: { children: React.ReactNode }) {
  return <div className="border-t border-border/50 px-3 py-2 text-[11px] text-muted-foreground">{children}</div>
}

function SearchResultIcon({ children }: { children: React.ReactNode }) {
  return (
    <span className={cn(
      'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px]',
      'bg-foreground/[0.04] text-muted-foreground',
    )}>
      {children}
    </span>
  )
}
