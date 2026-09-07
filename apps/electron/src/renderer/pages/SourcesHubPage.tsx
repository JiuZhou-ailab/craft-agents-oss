// input: Explicit runtime identity, workspace sources, and source route selection
// output: Full-width source list with compact header and modal details
// pos: Sources discovery and management page, reusing source list operations

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FREE_CONVERSATION_WORKSPACE_ID } from '@craft-agent/shared/protocol'
import { sourcesAtom } from '@/atoms/sources'
import { windowWorkspacesAtom } from '@/atoms/sessions'
import { SourcesListPanel } from '@/components/app-shell/SourcesListPanel'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useNavigationActions } from '@/contexts/NavigationContext'
import { routes } from '@/lib/navigate'
import type { SourcesNavigationState, Workspace } from '../../shared/types'
import SourceInfoPage from './SourceInfoPage'

export default function SourcesHubPage({ workspaceId, navState }: { workspaceId: string; navState: SourcesNavigationState }) {
  const { t } = useTranslation()
  const { navigate, navigateToSource } = useNavigationActions()
  const sources = useAtomValue(sourcesAtom)
  const workspaces = useAtomValue(windowWorkspacesAtom)
  const [runtime, setRuntime] = React.useState<Workspace | null>(null)
  const workspace = runtime?.id === workspaceId ? runtime : null
  const [localMcpEnabled, setLocalMcpEnabled] = React.useState(false)
  React.useEffect(() => {
    let active = true
    void window.electronAPI.resolveRuntimeWorkspace(workspaceId).then(resolved => {
      if (active) setRuntime(resolved)
    }).catch(error => {
      if (active) { setRuntime(null); console.error('[Sources] Failed to resolve runtime:', error) }
    })
    setLocalMcpEnabled(workspaceId === FREE_CONVERSATION_WORKSPACE_ID)
    if (workspaceId && workspaceId !== FREE_CONVERSATION_WORKSPACE_ID) void window.electronAPI.getWorkspaceSettings(workspaceId).then(settings => {
      if (active) setLocalMcpEnabled(settings?.localMcpEnabled ?? false)
    }).catch(error => {
      if (active) console.error('[Sources] Failed to load workspace settings:', error)
    })
    return () => { active = false }
  }, [workspaceId])
  const sourceSlug = navState.details?.type === 'source' ? navState.details.sourceSlug : undefined
  const closeDetail = () => { void navigateToSource() }
  const deleteSource = async (slug: string) => {
    try {
      await window.electronAPI.deleteSource(workspaceId, slug)
      toast.success(t('toast.deletedSource'))
      if (slug === sourceSlug) closeDetail()
    } catch {
      toast.error(t('toast.failedToDeleteSource'))
    }
  }
  return (
    <main className="relative flex h-full min-h-0 flex-col bg-background text-foreground" data-testid="sources-hub">
      <div aria-hidden="true" className="titlebar-drag-region absolute inset-x-0 top-0 h-8 sm:h-10" />
      <SourcesListPanel
        className="mx-auto w-full max-w-5xl px-6 pt-8 pb-4 sm:px-8 sm:pt-10"
        sources={sources}
        sourceFilter={navState.filter}
        workspaceId={workspaceId}
        workspaceRootPath={workspace?.rootPath}
        activeWorkspaceId={workspaceId}
        workspaces={workspaces}
        onDeleteSource={deleteSource}
        onSourceClick={source => navigateToSource(source.config.slug)}
        onDiscoverMcp={() => navigate(routes.view.mcpMarket())}
        onFilterChange={type => navigate(routes.view.sources({ type }))}
        selectedSourceSlug={sourceSlug}
        localMcpEnabled={localMcpEnabled}
      />
      <Dialog open={Boolean(sourceSlug)} onOpenChange={open => { if (!open) closeDetail() }}>
        <DialogContent aria-modal="true" aria-describedby={undefined} className="flex h-[min(780px,85vh)] flex-col gap-0 overflow-hidden p-0 w-[calc(100%-2rem)] sm:max-w-[960px]">
          <DialogTitle className="sr-only">{sources.find(source => source.config.slug === sourceSlug)?.config.name ?? sourceSlug}</DialogTitle>
          <div className="min-h-0 flex-1 overflow-hidden">
            {sourceSlug ? <SourceInfoPage sourceSlug={sourceSlug} workspaceId={workspaceId} /> : null}
          </div>
        </DialogContent>
      </Dialog>
    </main>
  )
}
