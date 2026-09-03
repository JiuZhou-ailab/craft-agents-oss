// input: Current runtime workspace and its persisted per-session and daily token totals
// output: Read-only token totals, composition, and switchable usage heat maps for the active project
// pos: Current-project usage section rendered by the dedicated Usage settings page

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Spinner } from '@craft-agent/ui'
import { useTranslation } from 'react-i18next'
import HeatMap from '@uiw/react-heat-map'

import {
  SettingsCard,
  SettingsCardContent,
  SettingsSegmentedControl,
} from '@/components/settings'
import { useAccountSettings } from '@/context/AppShellContext'
import type { Message, Session } from '../../../shared/types'
import {
  buildUsageCalendar,
  buildUsagePeriodBuckets,
  getUsagePeriodKey,
  parseUsageDate,
  summarizeLocalUsage,
  summarizeUsageActivity,
  type LocalUsageSummary,
  type UsagePeriod,
} from './local-usage'
import { cn } from '@/lib/utils'

const ACTIVITY_COLORS = {
  0: 'var(--foreground-5)',
  1: 'var(--foreground-5)',
  2: 'color-mix(in oklab, oklch(0.72 0.12 255) 36%, var(--background))',
  3: 'color-mix(in oklab, oklch(0.68 0.15 255) 58%, var(--background))',
  4: 'color-mix(in oklab, oklch(0.63 0.18 255) 78%, var(--background))',
  5: 'oklch(0.58 0.21 255)',
}
const ACTIVITY_CELL_SIZE = 9
const ACTIVITY_CELL_GAP = 3
const ACTIVITY_CELL_STEP = ACTIVITY_CELL_SIZE + ACTIVITY_CELL_GAP
const usageSummaryLoads = new Map<string, Promise<LocalUsageSummary>>()

function loadUsageSummary(
  workspaceId: string,
  sessions: Array<Pick<Session, 'id' | 'tokenUsage'>>,
): Promise<LocalUsageSummary> {
  const existing = usageSummaryLoads.get(workspaceId)
  if (existing) return existing

  const load = (async () => {
    const toolMessages: Message[] = []
    for (const session of sessions) {
      try {
        const loaded = await window.electronAPI.getSessionMessages(session.id)
        toolMessages.push(...(loaded?.messages ?? []).filter(message => message.role === 'tool'))
      } catch (error) {
        console.warn(`[LocalUsageSection] Failed to read tools for session ${session.id}:`, error)
      } finally {
        await window.electronAPI.releaseSessionMessages(session.id).catch(() => false)
      }
    }
    return summarizeLocalUsage(sessions, toolMessages)
  })()
  usageSummaryLoads.set(workspaceId, load)
  void load.then(
    () => usageSummaryLoads.delete(workspaceId),
    () => usageSummaryLoads.delete(workspaceId),
  )
  return load
}

export function LocalUsageSection() {
  const { runtimeWorkspace } = useAccountSettings()
  const { t } = useTranslation()
  const [result, setResult] = useState<{
    workspaceId: string
    summary?: LocalUsageSummary
    error?: true
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!runtimeWorkspace) return
    const workspaceId = runtimeWorkspace.id

    void (async () => {
      try {
        const sessions: Array<Pick<Session, 'id' | 'tokenUsage'>> = await window.electronAPI.listSessionsByWorkspace(workspaceId)
        if (!cancelled) setResult({ workspaceId, summary: summarizeLocalUsage(sessions) })

        const summary = await loadUsageSummary(workspaceId, sessions)
        if (!cancelled) {
          setResult({ workspaceId, summary })
        }
      } catch (error) {
        console.error('[LocalUsageSection] Failed to load workspace usage:', error)
        if (!cancelled) setResult({ workspaceId, error: true })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [runtimeWorkspace])

  const currentResult = result?.workspaceId === runtimeWorkspace?.id ? result : null

  return (
    <SettingsCard divided={false}>
      <SettingsCardContent className="p-5">
        {currentResult?.summary ? (
          <UsageContent summary={currentResult.summary} />
        ) : !runtimeWorkspace || currentResult?.error ? (
          <p className="text-sm text-muted-foreground">{t('settings.app.localUsage.unavailable')}</p>
        ) : (
          <div className="flex min-h-32 items-center justify-center" aria-label={t('settings.app.localUsage.loading')}>
            <Spinner />
          </div>
        )}
      </SettingsCardContent>
    </SettingsCard>
  )
}

function UsageContent({ summary }: { summary: LocalUsageSummary }) {
  const { t, i18n } = useTranslation()
  const [period, setPeriod] = useState<UsagePeriod>('day')
  const [hoveredPeriod, setHoveredPeriod] = useState<{
    periodKey: string
    date: Date
    tokens: number
    column: number
    row: number
  } | null>(null)
  const hoveredPeriodKey = hoveredPeriod?.periodKey
  const compositionTotal = summary.inputTokens + summary.outputTokens
  const inputPercent = compositionTotal > 0
    ? (summary.inputTokens / compositionTotal) * 100
    : 0
  const outputPercent = compositionTotal > 0 ? 100 - inputPercent : 0
  const locale = i18n.resolvedLanguage ?? i18n.language
  const endDate = useMemo(() => new Date(), [])
  const startDate = useMemo(() => {
    const date = new Date(endDate)
    date.setDate(date.getDate() - 364)
    return date
  }, [endDate])
  const buckets = useMemo(
    () => buildUsagePeriodBuckets(summary.dailyUsage, period, endDate),
    [endDate, period, summary.dailyUsage],
  )
  const calendar = useMemo(
    () => buildUsageCalendar(summary.dailyUsage, endDate, period).map(day => ({
      date: day.date,
      count: day.level,
      content: String(day.count),
    })),
    [endDate, period, summary.dailyUsage],
  )
  const trackedTokens = summary.dailyUsage.reduce((total, day) => total + day.totalTokens, 0)
  const historicalTokens = Math.max(0, summary.totalTokens - trackedTokens)
  const visibleTokens = buckets.reduce((total, bucket) => total + bucket.totalTokens, 0)
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, period === 'month'
      ? { year: 'numeric', month: 'short' }
      : { year: 'numeric', month: 'short', day: 'numeric' }),
    [locale, period],
  )
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale])
  const compactNumberFormatter = useMemo(
    () => new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }),
    [locale],
  )
  const activity = useMemo(
    () => summarizeUsageActivity(summary.dailyUsage, endDate),
    [endDate, summary.dailyUsage],
  )
  const months = useMemo(
    () => Array.from({ length: 12 }, (_, month) => new Intl.DateTimeFormat(locale, { month: 'short' }).format(new Date(2024, month, 1))),
    [locale],
  )
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 overflow-hidden rounded-[16px] border border-border/70 sm:grid-cols-5 sm:divide-x sm:divide-border/70">
        <UsageMetric
          label={t('settings.app.localUsage.totalTokens')}
          value={compactNumberFormatter.format(summary.totalTokens)}
          title={numberFormatter.format(summary.totalTokens)}
        />
        <UsageMetric
          label={t('settings.app.localUsage.peakTokens')}
          value={compactNumberFormatter.format(activity.peakTokens)}
          title={numberFormatter.format(activity.peakTokens)}
        />
        <UsageMetric
          label={t('settings.app.localUsage.activeDays')}
          value={t('time.compact.days', { count: activity.activeDays })}
        />
        <UsageMetric
          label={t('settings.app.localUsage.currentStreak')}
          value={t('time.compact.days', { count: activity.currentStreak })}
        />
        <UsageMetric
          label={t('settings.app.localUsage.longestStreak')}
          value={t('time.compact.days', { count: activity.longestStreak })}
        />
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4 text-xs">
          <span className="font-medium text-foreground">{t('settings.app.localUsage.dailyTitle')}</span>
          <SettingsSegmentedControl
            value={period}
            onValueChange={setPeriod}
            size="sm"
            options={[
              { value: 'day', label: t('settings.app.localUsage.daily') },
              { value: 'week', label: t('settings.app.localUsage.weekly') },
              { value: 'month', label: t('settings.app.localUsage.monthly') },
            ]}
          />
        </div>
        <div className="text-muted-foreground">
          <div className="relative w-[650px] pt-7">
            <HeatMap
              aria-label={t('settings.app.localUsage.periodAria', {
                tokens: numberFormatter.format(visibleTokens),
              })}
              endDate={endDate}
              height={110}
              legendCellSize={0}
              monthLabels={months}
              monthPlacement="bottom"
              panelColors={ACTIVITY_COLORS}
              rectProps={{ rx: 3, ry: 3 }}
              rectRender={(props, cell) => {
                const date = parseUsageDate(cell.date)
                const periodKey = date ? getUsagePeriodKey(date, period) : null
                const isHighlightedPeriod = Boolean(hoveredPeriodKey && periodKey === hoveredPeriodKey)
                return (
                  <rect
                    {...props}
                    data-period-highlighted={isHighlightedPeriod || undefined}
                    className={cn(
                      'outline-none transition-opacity duration-150',
                      hoveredPeriodKey && !isHighlightedPeriod ? 'opacity-20' : 'opacity-100',
                    )}
                    style={isHighlightedPeriod ? {
                      ...props.style,
                      stroke: 'var(--foreground)',
                      strokeOpacity: 0.4,
                      strokeWidth: 1.5,
                    } : props.style}
                    onPointerEnter={() => {
                      if (!date || !periodKey) return
                      setHoveredPeriod({
                        periodKey,
                        date: parseUsageDate(periodKey) ?? date,
                        tokens: Number(cell.content ?? 0),
                        column: cell.column,
                        row: cell.row,
                      })
                    }}
                    onPointerLeave={() => setHoveredPeriod(null)}
                  />
                )
              }}
              rectSize={ACTIVITY_CELL_SIZE}
              role="img"
              space={ACTIVITY_CELL_GAP}
              startDate={startDate}
              style={{ color: 'var(--muted-foreground)' }}
              value={calendar}
              weekLabels={false}
              width={650}
            />
            {hoveredPeriod ? (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute z-tooltip whitespace-nowrap rounded-[8px] border border-border/50 bg-background/90 px-2.5 py-1.5 text-xs text-foreground shadow-modal-small backdrop-blur-xl"
                style={{
                  left: Math.min(568, Math.max(82, 10 + hoveredPeriod.column * ACTIVITY_CELL_STEP)),
                  top: 33 + hoveredPeriod.row * ACTIVITY_CELL_STEP,
                  transform: 'translate(-50%, calc(-100% - 6px))',
                }}
              >
                {t('settings.app.localUsage.dayTooltip', {
                  date: dateFormatter.format(hoveredPeriod.date),
                  tokens: numberFormatter.format(hoveredPeriod.tokens),
                })}
              </div>
            ) : null}
          </div>
        </div>
        {historicalTokens > 0 && (
          <p className="text-xs text-muted-foreground">
            {t('settings.app.localUsage.historicalUnattributed', {
              tokens: numberFormatter.format(historicalTokens),
            })}
          </p>
        )}
      </div>

      <div className="grid gap-8 md:grid-cols-2">
        <UsageList title={t('settings.app.localUsage.insights')}>
          <UsageListRow label={t('settings.app.localUsage.inputShare')} value={`${Math.round(inputPercent)}%`} />
          <UsageListRow label={t('settings.app.localUsage.outputShare')} value={`${Math.round(outputPercent)}%`} />
          <UsageListRow label={t('settings.app.localUsage.sessions')} value={numberFormatter.format(summary.sessionCount)} />
          <UsageListRow label={t('settings.app.localUsage.toolCalls')} value={numberFormatter.format(summary.toolCalls)} />
          <UsageListRow label={t('settings.app.localUsage.uniqueTools')} value={numberFormatter.format(summary.uniqueTools)} />
        </UsageList>

        <UsageList title={t('settings.app.localUsage.topTools')}>
          {summary.topTools.length > 0 ? summary.topTools.map(tool => (
            <div key={tool.name} className="flex min-w-0 items-center justify-between gap-4 py-1.5 text-sm">
              <div className="flex min-w-0 items-center gap-2">
                {tool.iconDataUrl?.startsWith('data:image/') ? (
                  <img src={tool.iconDataUrl} alt="" className="h-5 w-5 shrink-0 rounded-[5px]" />
                ) : null}
                <span className="truncate text-foreground">{tool.name}</span>
              </div>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {t('settings.app.localUsage.runs', { count: tool.count })}
              </span>
            </div>
          )) : (
            <p className="py-1.5 text-sm text-muted-foreground">{t('settings.app.localUsage.noToolCalls')}</p>
          )}
        </UsageList>
      </div>

    </div>
  )
}

function UsageMetric({
  label,
  value,
  title,
}: {
  label: string
  value: string
  title?: string
}) {
  return (
    <div className="min-w-0 px-3 py-4 text-center">
      <p className="truncate text-lg font-medium tabular-nums text-foreground" title={title}>
        {value}
      </p>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

function UsageList({ title, children }: { title: string, children: ReactNode }) {
  return (
    <section className="min-w-0">
      <h4 className="mb-2 text-sm font-semibold text-foreground">{title}</h4>
      {children}
    </section>
  )
}

function UsageListRow({ label, value }: { label: string, value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  )
}
