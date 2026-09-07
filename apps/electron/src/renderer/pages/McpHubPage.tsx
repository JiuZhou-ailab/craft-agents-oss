// input: Read-only official MCP Registry snapshots, local Sources, and the active workspace runtime
// output: Searchable MCP discovery with explicit endpoint review and safe local Source creation
// pos: Native MCP market surface inside the Sources domain; runtime traffic and credentials stay outside the Hub

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { Check, ExternalLink, Search, Server, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import {
  getMcpRegistryExternalUrl,
  getMcpRegistryInstallDecision,
  type McpRegistryInstallDecision,
  type McpRegistryServerResponse,
} from '@craft-agent/shared/sources/marketplace'
import type { LoadedSource } from '@craft-agent/shared/sources/types'
import { sourcesAtom } from '@/atoms/sources'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { navigate, routes } from '@/lib/navigate'

interface McpHubPageProps { workspaceId: string }

export default function McpHubPage({ workspaceId }: McpHubPageProps) {
  const { t } = useTranslation()
  const sources = useAtomValue(sourcesAtom)
  const [query, setQuery] = React.useState('')
  const deferredQuery = React.useDeferredValue(query)
  const [servers, setServers] = React.useState<McpRegistryServerResponse[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [reloadToken, setReloadToken] = React.useState(0)
  const [selected, setSelected] = React.useState<McpRegistryServerResponse | null>(null)
  const [adding, setAdding] = React.useState(false)
  const currentWorkspaceId = React.useRef(workspaceId)
  currentWorkspaceId.current = workspaceId

  React.useEffect(() => {
    let active = true
    const timeout = window.setTimeout(() => {
      setLoading(true)
      setError(null)
      void window.electronAPI.listMcpServersFromMarket(deferredQuery)
        .then(response => {
          if (!active) return
          setServers(response.servers)
          setLoading(false)
        })
        .catch(cause => {
          if (!active) return
          setError(cause instanceof Error ? cause.message : String(cause))
          setLoading(false)
        })
    }, 200)
    return () => {
      active = false
      window.clearTimeout(timeout)
    }
  }, [deferredQuery, reloadToken])

  const addServer = React.useCallback(async (server: McpRegistryServerResponse) => {
    if (!workspaceId || adding) return
    const targetWorkspaceId = workspaceId
    const decision = getMcpRegistryInstallDecision(server)
    if (!decision.installable) return
    const existing = findInstalledSource(sources, decision)
    if (existing) {
      setSelected(null)
      navigate(routes.view.sourcesMcp(existing.config.slug))
      return
    }
    setAdding(true)
    try {
      const created = await window.electronAPI.createSource(targetWorkspaceId, decision.input)
      setSelected(null)
      toast.success(t('mcpHub.added', { name: decision.input.name }))
      if (currentWorkspaceId.current !== targetWorkspaceId) {
        return
      }
      navigate(routes.view.sourcesMcp(created.slug))
    } catch (cause) {
      toast.error(t('mcpHub.addFailed'), {
        description: cause instanceof Error ? cause.message : String(cause),
      })
    } finally {
      setAdding(false)
    }
  }, [adding, sources, t, workspaceId])

  return (
    <main className="relative h-full min-h-0 overflow-y-auto bg-background text-foreground">
      <div aria-hidden="true" className="titlebar-drag-region absolute inset-x-0 top-0 h-5 sm:h-6" />
      <div className="mx-auto w-full max-w-5xl px-6 pt-5 pb-8 sm:px-8 sm:pt-6">
        <header className="titlebar-drag-region">
          <h1 className="text-2xl font-semibold tracking-tight">{t('mcpHub.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('mcpHub.description')}</p>
        </header>

        <div className="relative mt-4">
          <label className="sr-only" htmlFor="mcp-hub-search">{t('mcpHub.searchLabel')}</label>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            id="mcp-hub-search"
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('mcpHub.searchPlaceholder')}
            className="pl-9"
          />
        </div>

        <div className="mt-5" aria-live="polite">
          {loading ? (
            <div role="status" className="grid grid-cols-1 gap-x-8 lg:grid-cols-2">
              <span className="sr-only">{t('mcpHub.loading')}</span>
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index} className="border-b border-border/60 py-4">
                  <div className="h-4 w-36 animate-pulse rounded bg-foreground/10" />
                  <div className="mt-2 h-3 w-full animate-pulse rounded bg-foreground/[0.06]" />
                </div>
              ))}
            </div>
          ) : error ? (
            <div role="alert" className="rounded-lg border border-destructive/25 bg-destructive/[0.04] px-4 py-4">
              <p className="text-sm font-medium">{t('mcpHub.loadFailed')}</p>
              <p className="mt-1 text-xs text-muted-foreground">{error}</p>
              <Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => setReloadToken(value => value + 1)}>
                {t('common.retry')}
              </Button>
            </div>
          ) : servers.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/80 px-4 py-8 text-center">
              <Server className="mx-auto size-5 text-muted-foreground" aria-hidden="true" />
              <p className="mt-2 text-sm font-medium">{t('mcpHub.noResults')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-x-8 lg:grid-cols-2">
              {servers.map(item => {
                const decision = getMcpRegistryInstallDecision(item)
                const installed = decision.installable && Boolean(findInstalledSource(sources, decision))
                return (
                  <article key={`${item.server.name}:${item.server.version}`} className="flex min-w-0 items-start gap-3 border-b border-border/60 py-4">
                    <button
                      type="button"
                      onClick={() => setSelected(item)}
                      aria-label={t('mcpHub.viewDetail', { name: item.server.title ?? item.server.name })}
                      className="flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.05] text-muted-foreground">
                        <Server className="size-4" aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{item.server.title ?? item.server.name}</span>
                        <span className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{item.server.description}</span>
                        <span className="mt-1.5 flex min-w-0 gap-2 overflow-hidden whitespace-nowrap text-[11px] text-muted-foreground">
                          <span className="truncate">{item.server.name}</span>
                          <span aria-hidden="true">·</span>
                          <span>v{item.server.version}</span>
                          {installed ? (
                            <><span aria-hidden="true">·</span><span className="inline-flex items-center gap-1 text-success"><Check className="size-3" />{t('mcpHub.addedLabel')}</span></>
                          ) : null}
                        </span>
                      </span>
                    </button>
                  </article>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <McpServerDialog
        server={selected}
        sources={sources}
        adding={adding}
        onClose={() => setSelected(null)}
        onAdd={addServer}
      />
    </main>
  )
}

function McpServerDialog({
  server,
  sources,
  adding,
  onClose,
  onAdd,
}: {
  server: McpRegistryServerResponse | null
  sources: LoadedSource[]
  adding: boolean
  onClose: () => void
  onAdd: (server: McpRegistryServerResponse) => Promise<void>
}) {
  const { t } = useTranslation()
  const decision = server ? getMcpRegistryInstallDecision(server) : null
  const installed = decision?.installable ? findInstalledSource(sources, decision) : null
  const externalUrl = server ? getMcpRegistryExternalUrl(server.server) : null
  const shownEndpoint = decision?.installable
    ? decision.endpoint
    : server?.server.remotes?.[0]?.url ?? t('mcpHub.noRemoteEndpoint')

  return (
    <Dialog open={Boolean(server)} onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="max-h-[85vh] w-[calc(100%-2rem)] overflow-y-auto sm:max-w-[960px]">
        {server ? (
          <>
            <DialogHeader>
              <DialogTitle>{server.server.title ?? server.server.name}</DialogTitle>
              <DialogDescription>{server.server.description}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 text-sm">
              <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-2">
                <dt className="text-muted-foreground">{t('mcpHub.registryName')}</dt>
                <dd className="min-w-0 break-all">{server.server.name}</dd>
                <dt className="text-muted-foreground">{t('mcpHub.version')}</dt>
                <dd>{server.server.version}</dd>
                <dt className="text-muted-foreground">{t('mcpHub.endpoint')}</dt>
                <dd className="min-w-0 break-all font-mono text-xs">{shownEndpoint}</dd>
                <dt className="text-muted-foreground">{t('mcpHub.source')}</dt>
                <dd>{t('mcpHub.officialRegistry')}</dd>
              </dl>
              <div className="rounded-lg border border-border/70 bg-foreground/[0.025] px-3 py-3 text-xs leading-relaxed text-muted-foreground">
                {decision?.installable ? (
                  <p>{t('mcpHub.confirmDescription', { host: new URL(decision.endpoint).host })}</p>
                ) : (
                  <p className="flex items-start gap-2 text-warning">
                    <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    <span>{decision ? t(`mcpHub.manualReason.${decision.reason}`) : t('mcpHub.manualOnly')}</span>
                  </p>
                )}
              </div>
            </div>
            <DialogFooter>
              {externalUrl ? (
                <Button type="button" variant="ghost" onClick={() => window.electronAPI.openUrl(externalUrl)}>
                  {t('mcpHub.openSource')}<ExternalLink aria-hidden="true" />
                </Button>
              ) : null}
              <Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
              <Button
                type="button"
                disabled={!decision?.installable || adding}
                onClick={() => { if (server) void onAdd(server) }}
              >
                {installed ? t('mcpHub.openAdded') : adding ? t('mcpHub.adding') : t('mcpHub.addToDevice')}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function findInstalledSource(
  sources: LoadedSource[],
  decision: Extract<McpRegistryInstallDecision, { installable: true }>,
) {
  return sources.find(source => source.config.type === 'mcp'
    && source.config.mcp?.url === decision.endpoint)
}
