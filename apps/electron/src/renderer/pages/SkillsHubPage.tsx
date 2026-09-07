// input: Pi-native Skills/Sources, authenticated Skills Market details, and the active workspace
// output: Discovery, dependency-safe installation guidance, installed Skill management, and publication actions
// pos: Default Skills route; local Pi catalog remains the authority for installed state

import * as React from 'react'
import type { TFunction } from 'i18next'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import {
  Check,
  ChevronDown,
  Compass,
  Download,
  ExternalLink,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import { isDefaultGlobalAgentSkillSlug } from '@craft-agent/shared/agent-defaults/skills'
import type { MarketSkillDetail, MarketSkillSummary } from '@craft-agent/shared/skills/marketplace'
import type { SkillInstallReceipt } from '@craft-agent/shared/resources'
import { skillsAtom } from '@/atoms/skills'
import { sourcesAtom } from '@/atoms/sources'
import { windowRuntimeWorkspaceAtom, windowWorkspaceIdAtom } from '@/atoms/sessions'
import { AddSkillPopover } from '@/components/app-shell/AddSkillPopover'
import { PublishSkillDialog } from '@/components/app-shell/PublishSkillDialog'
import { SkillRemovalDialog } from '@/components/app-shell/SkillMenu'
import { SkillAvatar, SkillVisualAvatar, resolveSkillVisual } from '@/components/ui/skill-avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Info_Markdown } from '@/components/info'
import { navigate, routes } from '@/lib/navigate'
import { cn } from '@/lib/utils'
import type { LoadedSkill, LoadedSource } from '../../shared/types'
import {
  filterMarketSkills,
  getInstalledMarketSlug,
  hasMarketSkillUpdate,
  isInstallableMarketSkill,
  normalizeMarketSkillExternalUrl,
  normalizeRequiredSourceSlugs,
  resolveRequiredSources,
  stripSkillFrontmatter,
  type CatalogView,
  type RequiredSourceDependency,
} from './skills-hub-logic'

type SkillsTab = 'discover' | 'installed'

export function getMarketSkillVisual(skill: MarketSkillSummary) {
  return resolveSkillVisual([skill.slug, skill.displayName, ...skill.tags, ...skill.roots])
}

export default function SkillsHubPage() {
  const { t } = useTranslation()
  const skills = useAtomValue(skillsAtom)
  const sources = useAtomValue(sourcesAtom)
  const workspaceId = useAtomValue(windowWorkspaceIdAtom)
  const workspace = useAtomValue(windowRuntimeWorkspaceAtom)
  const currentWorkspaceId = React.useRef(workspaceId)
  const detailRequestId = React.useRef(0)
  currentWorkspaceId.current = workspaceId

  const [marketSkills, setMarketSkills] = React.useState<MarketSkillSummary[]>([])
  const [catalogLoading, setCatalogLoading] = React.useState(true)
  const [catalogError, setCatalogError] = React.useState<string | null>(null)
  const [reloadToken, setReloadToken] = React.useState(0)
  const [activeTab, setActiveTab] = React.useState<SkillsTab>('discover')
  const [query, setQuery] = React.useState('')
  const [catalogView, setCatalogView] = React.useState<CatalogView>('all')
  const [installingSlug, setInstallingSlug] = React.useState<string | null>(null)
  const [upgradingSlug, setUpgradingSlug] = React.useState<string | null>(null)
  const [installReceipts, setInstallReceipts] = React.useState<SkillInstallReceipt[]>([])
  const [receiptReloadToken, setReceiptReloadToken] = React.useState(0)
  const [selectedMarketSkill, setSelectedMarketSkill] = React.useState<MarketSkillSummary | null>(null)
  const [marketSkillDetail, setMarketSkillDetail] = React.useState<MarketSkillDetail | null>(null)
  const [marketSkillDetailLoading, setMarketSkillDetailLoading] = React.useState(false)
  const [marketSkillDetailError, setMarketSkillDetailError] = React.useState<string | null>(null)
  const [skillToPublish, setSkillToPublish] = React.useState<LoadedSkill | null>(null)
  const [skillToRemove, setSkillToRemove] = React.useState<LoadedSkill | null>(null)

  React.useEffect(() => {
    let active = true
    setCatalogLoading(true)
    setCatalogError(null)
    void window.electronAPI.listSkillsFromMarket()
      .then(response => {
        if (!active) return
        setMarketSkills(response.skills)
        setCatalogLoading(false)
      })
      .catch(error => {
        if (!active) return
        setCatalogError(error instanceof Error ? error.message : String(error))
        setCatalogLoading(false)
      })
    return () => { active = false }
  }, [reloadToken])

  React.useEffect(() => {
    if (!workspaceId) {
      setInstallReceipts([])
      return
    }
    let active = true
    void window.electronAPI.listSkillInstallReceipts(workspaceId, 'project')
      .then(receipts => { if (active) setInstallReceipts(receipts) })
      .catch(() => { if (active) setInstallReceipts([]) })
    return () => { active = false }
  }, [receiptReloadToken, workspaceId])

  const installedBySlug = React.useMemo(
    () => new Map(skills.flatMap(skill => {
      const marketSlug = getInstalledMarketSlug(skill)
      return marketSlug ? [[marketSlug, skill] as const] : []
    })),
    [skills],
  )
  const installReceiptsBySlug = React.useMemo(
    () => new Map(installReceipts.map(receipt => [receipt.slug, receipt])),
    [installReceipts],
  )
  const marketBySlug = React.useMemo(
    () => new Map(marketSkills.map(skill => [skill.slug, skill])),
    [marketSkills],
  )
  const filteredInstalledSkills = React.useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    if (!normalizedQuery) return skills
    return skills.filter(skill => [
      skill.metadata.displayName,
      skill.metadata.name,
      skill.metadata.description,
      skill.slug,
    ].filter(Boolean).join(' ').toLocaleLowerCase().includes(normalizedQuery))
  }, [query, skills])
  const filteredMarketSkills = React.useMemo(
    () => filterMarketSkills(marketSkills, query, catalogView)
      .filter(skill => !installedBySlug.has(skill.slug)),
    [catalogView, installedBySlug, marketSkills, query],
  )
  const publishableSkills = React.useMemo(
    () => workspace?.remoteServer ? [] : skills.filter(skill => (
      skill.origin === 'top-level'
      && !isDefaultGlobalAgentSkillSlug(getInstalledMarketSlug(skill) ?? skill.slug)
    )),
    [skills, workspace?.remoteServer],
  )

  const openSkill = React.useCallback((skill: LoadedSkill) => {
    navigate(routes.view.skills(skill.slug))
  }, [])

  const openMarketSkill = React.useCallback(async (skill: MarketSkillSummary) => {
    const requestId = ++detailRequestId.current
    setSelectedMarketSkill(skill)
    setMarketSkillDetail(null)
    setMarketSkillDetailError(null)
    setMarketSkillDetailLoading(true)
    try {
      const detail = await window.electronAPI.getSkillDetailFromMarket(skill.slug)
      if (requestId === detailRequestId.current) {
        setSelectedMarketSkill(detail)
        setMarketSkillDetail(detail)
        setMarketSkills(current => current.map(item => item.slug === detail.slug ? detail : item))
      }
    } catch (error) {
      if (requestId === detailRequestId.current) {
        setMarketSkillDetailError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (requestId === detailRequestId.current) setMarketSkillDetailLoading(false)
    }
  }, [])

  const openMarketSkillUrl = React.useCallback((url: string) => {
    const externalUrl = normalizeMarketSkillExternalUrl(url)
    if (externalUrl) void window.electronAPI.openUrl(externalUrl)
  }, [])

  const closeMarketSkill = React.useCallback(() => {
    detailRequestId.current += 1
    setSelectedMarketSkill(null)
    setMarketSkillDetail(null)
    setMarketSkillDetailError(null)
    setMarketSkillDetailLoading(false)
  }, [])

  const installSkill = React.useCallback(async (skill: MarketSkillSummary) => {
    if (!workspaceId || installingSlug || !isInstallableMarketSkill(skill)) return
    const targetWorkspaceId = workspaceId
    setInstallingSlug(skill.slug)
    try {
      const downloaded = await window.electronAPI.downloadSkillFromMarket(skill)
      if (currentWorkspaceId.current !== targetWorkspaceId) {
        throw new Error(t('skillsMarket.runtimeChanged'))
      }
      const result = await window.electronAPI.importResources(
        targetWorkspaceId,
        downloaded.bundle,
        'skip',
        {
          skillScope: 'project',
          installArtifact: {
            slug: skill.slug,
            version: skill.version,
            sha256: downloaded.sha256,
            raw: downloaded.raw,
          },
        },
      )
      const bucket = result.skills
      if (bucket.imported.includes(skill.slug)) {
        setReceiptReloadToken(value => value + 1)
        toast.success(t('skillsMarket.imported', { slug: skill.slug }))
        return
      }
      if (bucket.skipped.includes(skill.slug)) {
        toast.info(t('skillsMarket.exists', { slug: skill.slug }))
        return
      }
      const reason = bucket.failed.find(item => item.id === skill.slug)?.error
      throw new Error(reason ?? t('skillsMarket.importFailed', { slug: skill.slug }))
    } catch (error) {
      toast.error(t('skillsMarket.importFailed', { slug: skill.slug }), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setInstallingSlug(null)
    }
  }, [installingSlug, t, workspaceId])

  const upgradeSkill = React.useCallback(async (
    skill: MarketSkillSummary,
    receipt: SkillInstallReceipt,
  ) => {
    if (!workspaceId || upgradingSlug) return
    const targetWorkspaceId = workspaceId
    setUpgradingSlug(skill.slug)
    try {
      const [current, target] = await Promise.all([
        window.electronAPI.downloadSkillFromMarket(receipt),
        window.electronAPI.downloadSkillFromMarket(skill),
      ])
      if (currentWorkspaceId.current !== targetWorkspaceId) {
        throw new Error(t('skillsMarket.runtimeChanged'))
      }
      const result = await window.electronAPI.upgradeInstalledSkill(
        targetWorkspaceId,
        { slug: receipt.slug, version: receipt.version, sha256: current.sha256, raw: current.raw },
        { slug: skill.slug, version: skill.version, sha256: target.sha256, raw: target.raw },
        receipt.scope,
      )
      setReceiptReloadToken(value => value + 1)
      toast.success(t('skillsMarket.updated', { slug: skill.slug }))
      if (result.preservedPaths.length > 0) {
        toast.info(t('skillsMarket.localChangesPreserved', { count: result.preservedPaths.length }))
      }
    } catch (error) {
      toast.error(t('skillsMarket.updateFailed', { slug: skill.slug }), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setUpgradingSlug(null)
    }
  }, [t, upgradingSlug, workspaceId])

  return (
    <main className="relative h-full min-h-0 overflow-y-auto bg-background text-foreground">
      <div aria-hidden="true" className="titlebar-drag-region absolute inset-x-0 top-0 h-8 sm:h-10" />
      <div className="mx-auto w-full max-w-5xl px-6 py-8 sm:px-8 sm:py-10">
        <header className="titlebar-drag-region flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">
              {t('skillsHub.title', '技能')}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('skillsHub.description', '为你的创作工作流安装和管理 Skills')}
            </p>
          </div>
          <div className="titlebar-no-drag flex shrink-0 items-center gap-2">
            {workspace ? (
              <AddSkillPopover
                workspace={workspace}
                trigger={(
                  <Button type="button" size="sm" variant="outline">
                    <Plus aria-hidden="true" />
                    {t('skillsHub.create', '创建 Skill')}
                  </Button>
                )}
              />
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled
                title={t('workspace.loadingWorkspaces', '正在加载项目...')}
              >
                <Plus aria-hidden="true" />
                {t('skillsHub.create', '创建 Skill')}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  disabled={!workspace || publishableSkills.length === 0}
                  title={!workspace
                    ? t('workspace.loadingWorkspaces', '正在加载项目...')
                    : publishableSkills.length === 0
                      ? t('skillsHub.noPublishableSkills', '没有可发布的本地 Skill')
                      : undefined}
                >
                  <Upload aria-hidden="true" />
                  {t('skillsHub.publish', '发布')}
                  <ChevronDown aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <StyledDropdownMenuContent align="end" className="min-w-56">
                {publishableSkills.map(skill => (
                  <StyledDropdownMenuItem key={skill.slug} onClick={() => setSkillToPublish(skill)}>
                    <SkillAvatar skill={skill} size="sm" workspaceId={workspace?.id ?? workspaceId ?? undefined} />
                    <span className="min-w-0 truncate">
                      {skill.metadata.displayName ?? skill.metadata.name}
                    </span>
                  </StyledDropdownMenuItem>
                ))}
              </StyledDropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            setActiveTab(value as SkillsTab)
            setQuery('')
          }}
          className="mt-6"
        >
          <TabsList className="h-9 rounded-md bg-foreground/[0.04] p-0.5">
            <TabsTrigger value="discover" className="h-8 rounded-[5px] px-4 text-sm">
              {t('skillsHub.discover', '发现')}
            </TabsTrigger>
            <TabsTrigger value="installed" className="h-8 rounded-[5px] px-4 text-sm">
              {t('skillsHub.installed', '已安装')}
              <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">{skills.length}</span>
            </TabsTrigger>
          </TabsList>

        <div className="relative mt-4">
          <label className="sr-only" htmlFor="skills-hub-search">
            {t('skillsHub.searchLabel', '搜索 Skills')}
          </label>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id="skills-hub-search"
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={activeTab === 'discover'
              ? t('skillsHub.searchPlaceholder', '搜索名称、发布者、内容来源或标签')
              : t('skillsHub.searchInstalledPlaceholder', '搜索已安装 Skills')}
            className="pl-9"
          />
        </div>

        <TabsContent value="installed" className="mt-5">
          {filteredInstalledSkills.length > 0 ? (
            <div id="installed-skills-grid" className="grid grid-cols-1 gap-x-8 lg:grid-cols-2">
              {filteredInstalledSkills.map(skill => {
                const marketSlug = getInstalledMarketSlug(skill)
                const receipt = marketSlug ? installReceiptsBySlug.get(marketSlug) : undefined
                const marketSkill = marketSlug ? marketBySlug.get(marketSlug) : undefined
                const updateAvailable = Boolean(receipt && marketSkill && hasMarketSkillUpdate(receipt, marketSkill))
                return (
                <article key={skill.slug} className="flex min-w-0 items-start gap-3 border-b border-border/60 py-4">
                  <button
                    type="button"
                    onClick={() => openSkill(skill)}
                    className="flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <SkillAvatar skill={skill} size="md" workspaceId={workspaceId ?? undefined} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {skill.metadata.displayName ?? skill.metadata.name}
                      </span>
                      <span className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                        {skill.metadata.description}
                      </span>
                    </span>
                  </button>
                  {updateAvailable && receipt && marketSkill ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      disabled={upgradingSlug !== null}
                      onClick={() => void upgradeSkill(marketSkill, receipt)}
                    >
                      <RefreshCw aria-hidden="true" className={cn(upgradingSlug === marketSlug && 'animate-spin motion-reduce:animate-none')} />
                      {upgradingSlug === marketSlug ? t('skillsMarket.updating') : t('skillsMarket.update')}
                    </Button>
                  ) : null}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={t('skillManagement.manage', {
                          name: skill.metadata.displayName ?? skill.metadata.name,
                        })}
                        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <MoreHorizontal className="size-3.5" aria-hidden="true" />
                      </button>
                    </DropdownMenuTrigger>
                    <StyledDropdownMenuContent align="end" className="min-w-48">
                      {skill.origin === 'top-level'
                        && !isDefaultGlobalAgentSkillSlug(getInstalledMarketSlug(skill) ?? skill.slug)
                        && workspaceId ? (
                        <StyledDropdownMenuItem variant="destructive" onClick={() => setSkillToRemove(skill)}>
                          <Trash2 className="size-3.5" aria-hidden="true" />
                          {t('skillManagement.removeAction')}
                        </StyledDropdownMenuItem>
                      ) : (
                        <StyledDropdownMenuItem disabled>
                          {t('skillManagement.managedBySource', {
                            source: isDefaultGlobalAgentSkillSlug(getInstalledMarketSlug(skill) ?? skill.slug)
                              ? 'Storyflow'
                              : skill.source,
                          })}
                        </StyledDropdownMenuItem>
                      )}
                    </StyledDropdownMenuContent>
                  </DropdownMenu>
                </article>
                )
              })}
            </div>
          ) : (
            <p className="mt-3 rounded-lg border border-dashed border-border/80 px-4 py-5 text-sm text-muted-foreground">
              {query
                ? t('skillsHub.noInstalledMatches', '没有匹配的已安装 Skill')
                : t('skillsHub.noInstalled', '当前项目还没有安装 Skill')}
            </p>
          )}
        </TabsContent>

        <TabsContent value="discover" className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 pb-3">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => window.electronAPI.openUrl('https://skillhub.cn')}
            >
              <Compass aria-hidden="true" />
              {t('skillsHub.browseSkillHub', '浏览 SkillHub')}
              <ExternalLink aria-hidden="true" />
            </Button>
            <div className="flex rounded-md bg-foreground/[0.04] p-0.5" role="group" aria-label={t('skillsHub.catalogView', '目录范围')}>
              {([
                ...(marketSkills.some(skill => skill.visibility === 'company') ? ['company'] as const : []),
                'featured',
                'all',
              ] as const).map(view => (
                <button
                  key={view}
                  type="button"
                  aria-pressed={catalogView === view}
                  onClick={() => setCatalogView(view)}
                  className={cn(
                    'rounded-[5px] px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    catalogView === view
                      ? 'bg-background text-foreground shadow-minimal'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {view === 'company'
                    ? t('skillsHub.company', '公司')
                    : view === 'featured'
                      ? t('skillsHub.featured', '精选')
                      : t('skillsHub.all', '全部')}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4" aria-live="polite">
            {catalogLoading ? (
              <>
                <p className="sr-only">{t('skillsHub.loading', '正在加载 Skills 目录')}</p>
                <CatalogSkeleton />
              </>
            ) : catalogError ? (
              <div role="alert" className="rounded-lg border border-destructive/25 bg-destructive/[0.04] px-4 py-4">
                <p className="text-sm font-medium">{t('skillsHub.loadFailed', 'Skills 目录加载失败')}</p>
                <p className="mt-1 text-xs text-muted-foreground">{catalogError}</p>
                <Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => setReloadToken(value => value + 1)}>
                  {t('common.retry', '重试')}
                </Button>
              </div>
            ) : filteredMarketSkills.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/80 px-4 py-8 text-center">
                <Zap className="mx-auto size-5 text-muted-foreground" aria-hidden="true" />
                <p className="mt-2 text-sm font-medium">{t('skillsHub.noResults', '没有找到匹配的 Skill')}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {catalogView === 'featured' && !query
                    ? t('skillsHub.noFeatured', '暂时没有精选 Skill，可以查看全部')
                    : t('skillsHub.adjustFilters', '尝试修改搜索词或切换目录范围')}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-x-8 lg:grid-cols-2">
                {filteredMarketSkills.map(skill => {
                  const installing = installingSlug === skill.slug
                  const installable = isInstallableMarketSkill(skill)
                  const visual = getMarketSkillVisual(skill)
                  return (
                    <article key={`${skill.slug}@${skill.version}`} className="flex min-w-0 items-start gap-3 border-b border-border/60 py-4">
                      <button
                        type="button"
                        onClick={() => void openMarketSkill(skill)}
                        className="flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={t('skillsHub.viewDetail', { defaultValue: '查看 {{name}}', name: skill.displayName })}
                      >
                        <SkillVisualAvatar visual={visual} size="md" alt={skill.displayName} />
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-baseline gap-2">
                            <span className="truncate text-sm font-medium">{skill.displayName}</span>
                            <span className="shrink-0 text-[11px] text-muted-foreground">v{skill.version}</span>
                          </span>
                          <span className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                            {skill.summary}
                          </span>
                          <span className="mt-1 flex min-w-0 gap-2 overflow-hidden whitespace-nowrap text-xs text-muted-foreground">
                            <span className="truncate font-medium text-foreground/75">{skill.publisher.displayName}</span>
                            <span className="inline-flex shrink-0 items-center gap-1">
                              <Download className="size-3" aria-hidden="true" />
                              {t('skillsHub.downloadCount', {
                                defaultValue: '{{count}} 次下载',
                                count: skill.downloadCount,
                              })}
                            </span>
                          </span>
                        </span>
                      </button>
                      {installable ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="shrink-0"
                          disabled={!workspaceId || installingSlug !== null}
                          onClick={() => void openMarketSkill(skill)}
                        >
                          <Download aria-hidden="true" />
                          {installing
                            ? t('skillsHub.installing', '安装中')
                            : t('skillsHub.install', '安装')}
                        </Button>
                      ) : (
                        <Button type="button" size="sm" variant="ghost" className="shrink-0" disabled>
                          {t('skillsHub.referenceOnly', '仅供参考')}
                        </Button>
                      )}
                    </article>
                  )
                })}
              </div>
            )}
          </div>
        </TabsContent>
        </Tabs>
      </div>

      <MarketSkillDetailDialog
        skill={selectedMarketSkill}
        detail={marketSkillDetail}
        loading={marketSkillDetailLoading}
        error={marketSkillDetailError}
        installed={selectedMarketSkill ? installedBySlug.get(selectedMarketSkill.slug) : undefined}
        sources={sources}
        installing={selectedMarketSkill?.slug === installingSlug}
        canInstall={Boolean(workspaceId && marketSkillDetail && !marketSkillDetailError)}
        onOpenChange={open => { if (!open) closeMarketSkill() }}
        onRetry={() => { if (selectedMarketSkill) void openMarketSkill(selectedMarketSkill) }}
        onInstall={() => {
          const installTarget = marketSkillDetail ?? selectedMarketSkill
          if (installTarget) void installSkill(installTarget)
        }}
        onOpenUrl={openMarketSkillUrl}
        onOpenManagedAccount={() => {
          closeMarketSkill()
          navigate(routes.view.settings('profile'))
        }}
        onOpenInstalled={(skill) => {
          closeMarketSkill()
          openSkill(skill)
        }}
        onOpenRequiredSource={(dependency) => {
          closeMarketSkill()
          if (dependency.access === 'managed') {
            navigate(routes.view.settings('profile'))
            return
          }
          if (dependency.source) {
            navigate(routes.view.sources({
              sourceSlug: dependency.source.config.slug,
              type: dependency.source.config.type,
            }))
            return
          }
          navigate(routes.view.sources())
        }}
      />

      {workspace ? (
        <PublishSkillDialog
          skill={skillToPublish}
          workspaceId={workspace.id}
          workspaceRootPath={workspace.rootPath}
          open={skillToPublish !== null}
          onOpenChange={open => { if (!open) setSkillToPublish(null) }}
          onPublished={() => setReloadToken(value => value + 1)}
        />
      ) : null}
      <SkillRemovalDialog
        skill={skillToRemove}
        workspaceId={workspaceId}
        open={skillToRemove !== null}
        onOpenChange={open => { if (!open) setSkillToRemove(null) }}
      />
    </main>
  )
}

function MarketSkillDetailDialog({
  skill,
  detail,
  loading,
  error,
  installed,
  sources,
  installing,
  canInstall,
  onOpenChange,
  onRetry,
  onInstall,
  onOpenUrl,
  onOpenManagedAccount,
  onOpenInstalled,
  onOpenRequiredSource,
}: {
  skill: MarketSkillSummary | null
  detail: MarketSkillDetail | null
  loading: boolean
  error: string | null
  installed?: LoadedSkill
  sources: LoadedSource[]
  installing: boolean
  canInstall: boolean
  onOpenChange: (open: boolean) => void
  onRetry: () => void
  onInstall: () => void
  onOpenUrl: (url: string) => void
  onOpenManagedAccount: () => void
  onOpenInstalled: (skill: LoadedSkill) => void
  onOpenRequiredSource: (dependency: RequiredSourceDependency) => void
}) {
  const { t } = useTranslation()
  if (!skill) return null
  const resolvedSkill = detail ?? skill
  const visual = getMarketSkillVisual(resolvedSkill)
  const instructions = detail && isInstallableMarketSkill(detail)
    ? stripSkillFrontmatter(detail.skillMarkdown)
    : ''
  const requiredSources = resolveRequiredSources(
    normalizeRequiredSourceSlugs(detail?.manifest.contributes?.requiredSources),
    sources,
  )
  const requiresStoryflowLogin = detail?.requiresStoryflowLogin === true
  const showContent = loading || Boolean(error) || Boolean(instructions)
    || requiredSources.length > 0 || requiresStoryflowLogin

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        size="xl"
        className={cn(
          'max-h-[82vh] w-[calc(100%-2rem)] gap-0 overflow-hidden p-0 sm:max-w-[960px]',
          showContent ? 'grid-rows-[auto_minmax(0,1fr)_auto]' : 'grid-rows-[auto_auto]',
        )}
      >
        <DialogHeader className="px-6 pb-5 pt-6 pr-12">
          <div className="flex items-start gap-3">
            <SkillVisualAvatar visual={visual} size="xl" alt={resolvedSkill.displayName} />
            <div className="min-w-0">
              <DialogTitle className="truncate">{resolvedSkill.displayName}</DialogTitle>
              <DialogDescription className="mt-1 leading-relaxed">{resolvedSkill.summary}</DialogDescription>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{resolvedSkill.publisher.displayName}</span>
                <span>{t('skillsHub.downloadCount', {
                  defaultValue: '{{count}} 次下载',
                  count: resolvedSkill.downloadCount,
                })}</span>
              </div>
            </div>
          </div>
        </DialogHeader>

        {showContent ? (
          <div className="min-h-0 overflow-y-auto border-y border-border/60 px-6 py-5">
            {loading ? (
              <div className="space-y-3" aria-label={t('skillsHub.loadingDetail', '正在加载 Skill 内容')}>
                <div className="h-3 w-1/3 animate-pulse rounded bg-foreground/[0.07] motion-reduce:animate-none" />
                <div className="h-2.5 w-full animate-pulse rounded bg-foreground/[0.05] motion-reduce:animate-none" />
                <div className="h-2.5 w-5/6 animate-pulse rounded bg-foreground/[0.05] motion-reduce:animate-none" />
                <div className="h-2.5 w-3/4 animate-pulse rounded bg-foreground/[0.05] motion-reduce:animate-none" />
              </div>
            ) : error ? (
              <div role="alert" className="rounded-lg border border-destructive/25 bg-destructive/[0.04] px-4 py-4">
                <p className="text-sm font-medium">{t('skillsHub.detailLoadFailed', 'Skill 内容加载失败')}</p>
                <p className="mt-1 text-xs text-muted-foreground">{error}</p>
                <Button type="button" size="sm" variant="outline" className="mt-3" onClick={onRetry}>
                  {t('common.retry', '重试')}
                </Button>
              </div>
            ) : (
              <div className="space-y-5">
                {requiresStoryflowLogin && (
                  <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-3">
                    <div>
                      <h3 className="text-sm font-medium text-foreground">
                        {t('settings.app.account.title')}
                      </h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t('skillManagement.managedBySource', { source: 'Storyflow' })}
                      </p>
                    </div>
                    <Button type="button" size="sm" variant="outline" onClick={onOpenManagedAccount}>
                      {t('settings.app.account.title')}
                    </Button>
                  </section>
                )}
                {requiredSources.length > 0 && (
                  <RequiredSourcesSection
                    dependencies={requiredSources}
                    onOpenRequiredSource={onOpenRequiredSource}
                  />
                )}
                {instructions && (
                  <Info_Markdown mode="full" className="px-0 pb-0" allowImages={false} onUrlClick={onOpenUrl}>
                    {instructions}
                  </Info_Markdown>
                )}
              </div>
            )}
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-3 px-6 py-4">
          <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{resolvedSkill.license}</span>
            {resolvedSkill.tags.map(tag => <span key={tag}>{tag}</span>)}
          </div>
          {installed ? (
            <Button type="button" size="sm" onClick={() => onOpenInstalled(installed)}>
              <Check aria-hidden="true" />
              {t('skillsHub.open', '打开')}
            </Button>
          ) : isInstallableMarketSkill(resolvedSkill) ? (
            <Button type="button" size="sm" disabled={!canInstall || installing} onClick={onInstall}>
              <Download aria-hidden="true" />
              {installing ? t('skillsHub.installing', '安装中') : t('skillsHub.install', '安装')}
            </Button>
          ) : detail?.manifest.author.url ? (
            <Button type="button" size="sm" variant="outline" onClick={() => onOpenUrl(detail.manifest.author.url!)}>
              <ExternalLink aria-hidden="true" />
              {t('skillsHub.openSource', '查看来源')}
            </Button>
          ) : (
            <Button type="button" size="sm" variant="ghost" disabled>{t('skillsHub.referenceOnly', '仅供参考')}</Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function RequiredSourcesSection({
  dependencies,
  onOpenRequiredSource,
}: {
  dependencies: RequiredSourceDependency[]
  onOpenRequiredSource: (dependency: RequiredSourceDependency) => void
}) {
  const { t } = useTranslation()

  return (
    <section aria-labelledby="market-skill-required-sources">
      <h3 id="market-skill-required-sources" className="text-sm font-medium text-foreground">
        {t('skillInfo.requiredSources')}
      </h3>
      <ul className="mt-3 divide-y divide-border/50 rounded-lg border border-border/60">
        {dependencies.map(dependency => (
          <li key={dependency.slug} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-foreground">
                {dependency.source?.config.name ?? dependency.slug}
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                {dependency.slug}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {getRequiredSourceAccessCopy(dependency.access, t)}
              </div>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={() => onOpenRequiredSource(dependency)}
            >
              {dependency.access === 'managed'
                ? t('settings.app.account.title')
                : dependency.source
                  ? t('common.open')
                  : t('sidebar.sources')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function getRequiredSourceAccessCopy(
  access: RequiredSourceDependency['access'],
  t: TFunction,
): string {
  switch (access) {
    case 'managed':
      return t('skillManagement.managedBySource', { source: 'Storyflow' })
    case 'byok':
      return `BYOK · ${t('sourcesList.statusAuthRequired')}`
    case 'no-auth':
      return t('skillManagement.managedBySource', { source: t('common.source') })
    case 'missing':
      return t('auth.connectionRequired')
  }
}

function CatalogSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-x-8 lg:grid-cols-2" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="flex items-start gap-3 border-b border-border/60 py-4">
          <div className="size-5 shrink-0 animate-pulse rounded-[4px] bg-foreground/[0.06] ring-1 ring-border/30 motion-reduce:animate-none" />
          <div className="min-w-0 flex-1 space-y-2 py-0.5">
            <div className="h-3 w-2/5 animate-pulse rounded bg-foreground/[0.07] motion-reduce:animate-none" />
            <div className="h-2.5 w-full animate-pulse rounded bg-foreground/[0.05] motion-reduce:animate-none" />
            <div className="h-2.5 w-3/5 animate-pulse rounded bg-foreground/[0.05] motion-reduce:animate-none" />
          </div>
        </div>
      ))}
    </div>
  )
}
