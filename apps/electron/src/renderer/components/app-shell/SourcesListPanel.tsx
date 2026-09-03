// input: Workspace sources, current source filter, and user drag-drop events
// output: Navigable source list with empty state, menus, and dropped local source creation
// pos: Sidebar panel for browsing and adding reusable data/tool sources

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Compass, DatabaseZap, FolderOpen } from 'lucide-react'
import { toast } from 'sonner'
import { SourceAvatar } from '@/components/ui/source-avatar'
import { deriveConnectionStatus } from '@/components/ui/source-status-indicator'
import { EntityPanel } from '@/components/ui/entity-panel'
import { EntityListBadge } from '@/components/ui/entity-list-badge'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { ServerDirectoryBrowser } from '@/components/ServerDirectoryBrowser'
import { useDirectoryPicker } from '@/hooks/useDirectoryPicker'
import { cn } from '@/lib/utils'
import { buildDroppedLocalSourceInputs } from '@/lib/source-drop'
import { sourceSelection } from '@/hooks/useEntitySelection'
import { SourceMenu } from './SourceMenu'
import { SendResourceToWorkspaceDialog } from './SendResourceToWorkspaceDialog'
import { EditPopover, getEditConfig, type EditContextKey } from '@/components/ui/EditPopover'
import type { LoadedSource, SourceFilter, Workspace } from '../../../shared/types'

const SOURCE_TYPE_CONFIG: Record<string, { labelKey: string; colorClass: string }> = {
  mcp: { labelKey: 'sourcesList.typeMcp', colorClass: 'bg-accent/10 text-accent' },
  api: { labelKey: 'sourcesList.typeApi', colorClass: 'bg-success/10 text-success' },
  local: { labelKey: 'sourcesList.typeLocal', colorClass: 'bg-info/10 text-info' },
}

const SOURCE_STATUS_CONFIG: Record<string, { labelKey: string; colorClass: string } | null> = {
  connected: null,
  needs_auth: { labelKey: 'sourcesList.statusAuthRequired', colorClass: 'bg-warning/10 text-warning' },
  failed: { labelKey: 'sourcesList.statusDisconnected', colorClass: 'bg-destructive/10 text-destructive' },
  untested: { labelKey: 'sourcesList.statusNotTested', colorClass: 'bg-foreground/10 text-foreground/50' },
  local_disabled: { labelKey: 'sourcesList.statusDisabled', colorClass: 'bg-foreground/10 text-foreground/50' },
}

const SOURCE_TYPE_FILTER_LABEL_KEYS: Record<string, string> = {
  api: 'sourcesList.filterApi',
  mcp: 'sourcesList.filterMcp',
  local: 'sourcesList.filterLocalFolder',
}

export interface SourcesListPanelProps {
  sources: LoadedSource[]
  sourceFilter?: SourceFilter | null
  workspaceId?: string
  workspaceRootPath?: string
  activeWorkspaceId?: string | null
  workspaces?: Workspace[]
  onDeleteSource: (sourceSlug: string) => void
  onSourceClick: (source: LoadedSource) => void
  onDiscoverMcp?: () => void
  selectedSourceSlug?: string | null
  localMcpEnabled?: boolean
  className?: string
}

export function SourcesListPanel({
  sources,
  sourceFilter,
  workspaceId,
  workspaceRootPath,
  activeWorkspaceId = null,
  workspaces = [],
  onDeleteSource,
  onSourceClick,
  onDiscoverMcp,
  selectedSourceSlug,
  localMcpEnabled = true,
  className,
}: SourcesListPanelProps) {
  const { t } = useTranslation()
  const hasOtherWorkspaces = workspaces.length > 1
  const dragDepthRef = React.useRef(0)
  const [isDraggingFiles, setIsDraggingFiles] = React.useState(false)

  // Send to Workspace dialog state
  const [sendDialogOpen, setSendDialogOpen] = React.useState(false)
  const [sendResourceSlug, setSendResourceSlug] = React.useState<string | null>(null)
  const [sendResourceLabel, setSendResourceLabel] = React.useState('')

  const createLocalSources = React.useCallback(async (paths: string[]) => {
    if (!workspaceId) return

    const inputs = buildDroppedLocalSourceInputs(paths)
    if (inputs.length === 0) {
      toast.error(t('sourcesList.noDroppedFilePath'))
      return
    }

    try {
      for (const input of inputs) {
        await window.electronAPI.createSource(workspaceId, input)
      }
      toast.success(t('sourcesList.createdLocalSources', { count: inputs.length }))
    } catch (error) {
      toast.error(t('sourcesList.failedToCreateLocalSource'), {
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }, [t, workspaceId])

  const handleDirectorySelected = React.useCallback((path: string) => {
    void createLocalSources([path])
  }, [createLocalSources])

  const {
    pickDirectory,
    showServerBrowser,
    serverBrowserMode,
    cancelServerBrowser,
    confirmServerBrowser,
  } = useDirectoryPicker(handleDirectorySelected)

  const filteredSources = React.useMemo(() => {
    if (!sourceFilter) return sources
    return sources.filter(s => s.config.type === sourceFilter.sourceType)
  }, [sources, sourceFilter])

  const emptyMessage = React.useMemo(() => {
    if (sourceFilter?.kind === 'type') {
      const filterLabelKey = SOURCE_TYPE_FILTER_LABEL_KEYS[sourceFilter.sourceType]
      const filterLabel = filterLabelKey ? t(filterLabelKey) : sourceFilter.sourceType
      return t('sourcesList.noSourcesOfType', { type: filterLabel })
    }
    return t('sourcesList.noSourcesConfigured')
  }, [sourceFilter, t])

  const handleDragEnter = React.useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current += 1
    setIsDraggingFiles(true)
  }, [])

  const handleDragOver = React.useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = workspaceId ? 'copy' : 'none'
  }, [workspaceId])

  const handleDragLeave = React.useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) {
      setIsDraggingFiles(false)
    }
  }, [])

  const handleDrop = React.useCallback(async (event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = 0
    setIsDraggingFiles(false)

    if (!workspaceId) return

    const paths = Array.from(event.dataTransfer.files)
      .map(file => window.electronAPI.getFilePath?.(file) ?? '')
      .filter(Boolean)
    await createLocalSources(paths)
  }, [createLocalSources, workspaceId])

  return (
    <>
      <div
        className={cn('relative flex min-h-0 flex-1 flex-col', className)}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {sourceFilter?.sourceType === 'mcp' && onDiscoverMcp ? (
          <div className="shrink-0 border-b border-border/60 px-3 py-2">
            <button
              type="button"
              onClick={onDiscoverMcp}
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-foreground/85 outline-none transition-colors hover:bg-foreground/[0.05] focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Compass className="size-3.5" aria-hidden="true" />
              {t('mcpHub.discoverAction')}
            </button>
          </div>
        ) : null}
        <EntityPanel<LoadedSource>
          items={filteredSources}
          getId={(s) => s.config.slug}
          selection={sourceSelection}
          selectedId={selectedSourceSlug}
          onItemClick={onSourceClick}
          emptyState={
            <EntityListEmptyScreen
              icon={<DatabaseZap />}
              title={emptyMessage}
              description={t('sourcesList.emptyDescription')}
              docKey="sources"
            >
              {workspaceRootPath && (
                <>
                  <button
                    type="button"
                    onClick={pickDirectory}
                    className="inline-flex items-center gap-1.5 h-7 px-3 text-xs font-medium rounded-[8px] bg-foreground/[0.02] shadow-minimal hover:bg-foreground/[0.05] transition-colors"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    {t('sourcesList.chooseLocalFolder')}
                  </button>
                  <EditPopover
                    align="center"
                    trigger={
                      <button className="inline-flex items-center h-7 px-3 text-xs font-medium rounded-[8px] bg-background shadow-minimal hover:bg-foreground/[0.03] transition-colors">
                        {t('sourcesList.addSource')}
                      </button>
                    }
                    {...getEditConfig(
                      sourceFilter?.kind === 'type' ? `add-source-${sourceFilter.sourceType}` as EditContextKey : 'add-source',
                      workspaceRootPath
                    )}
                  />
                </>
              )}
            </EntityListEmptyScreen>
          }
          mapItem={(source) => {
            const connectionStatus = deriveConnectionStatus(source, localMcpEnabled)
            const typeConfig = SOURCE_TYPE_CONFIG[source.config.type]
            const statusConfig = SOURCE_STATUS_CONFIG[connectionStatus]
            const subtitle = source.config.tagline || source.config.provider || ''
            return {
              icon: <SourceAvatar source={source} size="sm" />,
              title: source.config.name,
              badges: (
                <>
                  {typeConfig && <EntityListBadge colorClass={typeConfig.colorClass}>{t(typeConfig.labelKey)}</EntityListBadge>}
                  {statusConfig && (
                    <EntityListBadge colorClass={statusConfig.colorClass} tooltip={source.config.connectionError || undefined} className="cursor-default">
                      {t(statusConfig.labelKey)}
                    </EntityListBadge>
                  )}
                  {source.origin === 'shared-global' && (
                    <EntityListBadge colorClass="bg-foreground/10 text-foreground/60">
                      {t('sourcesList.sharedReadOnly')}
                    </EntityListBadge>
                  )}
                  {subtitle && <span className="truncate">{subtitle}</span>}
                </>
              ),
              menu: (
                <SourceMenu
                  sourceSlug={source.config.slug}
                  sourceName={source.config.name}
                  onOpenInNewWindow={() => window.electronAPI.openUrl(`craftagents://sources/source/${source.config.slug}?window=focused`)}
                  onShowInFinder={() => window.electronAPI.showInFolder(source.folderPath)}
                  onDelete={source.origin === 'shared-global'
                    ? undefined
                    : () => onDeleteSource(source.config.slug)}
                  onSendToWorkspace={hasOtherWorkspaces && source.origin === 'workspace' ? () => {
                    setSendResourceSlug(source.config.slug)
                    setSendResourceLabel(source.config.name)
                    setSendDialogOpen(true)
                  } : undefined}
                />
              ),
            }
          }}
        />

        {isDraggingFiles && (
          <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-[8px] border border-dashed border-accent/50 bg-background/85 px-6 text-center shadow-minimal backdrop-blur-sm">
            <div className="space-y-1">
              <div className="text-sm font-medium text-foreground">{t('sourcesList.dropDataTitle')}</div>
              <div className="text-xs text-muted-foreground">{t('sourcesList.dropDataDescription')}</div>
            </div>
          </div>
        )}
      </div>

      {/* Send to Workspace dialog */}
      {sendResourceSlug && (
        <SendResourceToWorkspaceDialog
          open={sendDialogOpen}
          onOpenChange={setSendDialogOpen}
          resourceType="source"
          resourceIds={[sendResourceSlug]}
          resourceLabel={sendResourceLabel}
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
        />
      )}
      <ServerDirectoryBrowser
        open={showServerBrowser}
        mode={serverBrowserMode}
        onSelect={confirmServerBrowser}
        onCancel={cancelServerBrowser}
      />
    </>
  )
}
