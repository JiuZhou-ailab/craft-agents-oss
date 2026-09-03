// input: Persisted per-session and daily token totals for one runtime workspace
// output: Deterministic project aggregation, activity levels, and day/week/month buckets
// pos: Pure data model for the App settings usage visualization

import type { Message, Session } from '../../../shared/types'

export interface LocalUsageSummary {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  sessionCount: number
  dailyUsage: LocalUsageDay[]
  toolCalls: number
  uniqueTools: number
  topTools: LocalUsageTool[]
}

export interface LocalUsageDay {
  date: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface UsageCalendarDay {
  date: string
  count: number
  level: number
}

export type UsagePeriod = 'day' | 'week' | 'month'

export interface UsagePeriodBucket {
  startDate: string
  totalTokens: number
}

export interface LocalUsageTool {
  name: string
  count: number
  iconDataUrl?: string
}

export interface LocalUsageActivity {
  peakTokens: number
  activeDays: number
  currentStreak: number
  longestStreak: number
}

export function summarizeLocalUsage(
  sessions: Array<Pick<Session, 'tokenUsage'>>,
  messages: Message[] = [],
): LocalUsageSummary {
  const byDay = new Map<string, LocalUsageDay>()
  const summary = sessions.reduce<Pick<LocalUsageSummary, 'totalTokens' | 'inputTokens' | 'outputTokens' | 'sessionCount'>>((total, session) => {
    for (const [date, usage] of Object.entries(session.tokenUsage?.byDay ?? {})) {
      if (!isLocalDateKey(date)) continue
      const current = byDay.get(date) ?? { date, inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      current.inputTokens += usage.inputTokens
      current.outputTokens += usage.outputTokens
      current.totalTokens = current.inputTokens + current.outputTokens
      byDay.set(date, current)
    }

    return {
      totalTokens: total.totalTokens + (session.tokenUsage?.totalTokens ?? 0),
      inputTokens: total.inputTokens + (session.tokenUsage?.inputTokens ?? 0),
      outputTokens: total.outputTokens + (session.tokenUsage?.outputTokens ?? 0),
      sessionCount: total.sessionCount + 1,
    }
  }, { totalTokens: 0, inputTokens: 0, outputTokens: 0, sessionCount: 0 })

  const tools = new Map<string, LocalUsageTool>()
  for (const message of messages) {
    if (message.role !== 'tool' || !message.toolName) continue
    const skill = message.toolName === 'Skill' && typeof message.toolInput?.skill === 'string'
      ? message.toolInput.skill.split(':').at(-1)
      : undefined
    const name = skill
      ? `$${skill}`
      : message.toolDisplayMeta?.displayName ?? message.toolDisplayName ?? message.toolName
    const current = tools.get(name)
    tools.set(name, {
      name,
      count: (current?.count ?? 0) + 1,
      iconDataUrl: current?.iconDataUrl ?? message.toolDisplayMeta?.iconDataUrl,
    })
  }
  const topTools = Array.from(tools.values())
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 5)

  return {
    ...summary,
    dailyUsage: Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date)),
    toolCalls: Array.from(tools.values()).reduce((total, tool) => total + tool.count, 0),
    uniqueTools: tools.size,
    topTools,
  }
}

export function summarizeUsageActivity(
  dailyUsage: LocalUsageDay[],
  endDate = new Date(),
): LocalUsageActivity {
  const calendar = buildUsageCalendar(dailyUsage, endDate)
  let currentStreak = 0
  for (let index = calendar.length - 1; index >= 0 && calendar[index].count > 0; index -= 1) {
    currentStreak += 1
  }

  let longestStreak = 0
  let runningStreak = 0
  for (const day of calendar) {
    runningStreak = day.count > 0 ? runningStreak + 1 : 0
    longestStreak = Math.max(longestStreak, runningStreak)
  }

  return {
    peakTokens: Math.max(...calendar.map(day => day.count)),
    activeDays: calendar.filter(day => day.count > 0).length,
    currentStreak,
    longestStreak,
  }
}

export function buildUsageCalendar(
  dailyUsage: LocalUsageDay[],
  endDate = new Date(),
  period: UsagePeriod = 'day',
): UsageCalendarDay[] {
  const usageByPeriod = new Map(
    buildUsagePeriodBuckets(dailyUsage, period, endDate)
      .map(bucket => [bucket.startDate, bucket.totalTokens]),
  )
  const days = Array.from({ length: 365 }, (_, index) => {
    const date = new Date(endDate)
    date.setHours(12, 0, 0, 0)
    date.setDate(date.getDate() - (364 - index))
    const dateKey = localDateKey(date)
    const periodKey = getUsagePeriodKey(date, period)
    return { date: dateKey, count: usageByPeriod.get(periodKey) ?? 0, level: 0 }
  })
  const max = Math.max(...days.map(day => day.count))
  if (max === 0) return days

  return days.map(day => ({
    ...day,
    level: day.count === 0
      ? 0
      : Math.max(1, Math.ceil((Math.log1p(day.count) / Math.log1p(max)) * 4)),
  }))
}

export function buildUsagePeriodBuckets(
  dailyUsage: LocalUsageDay[],
  period: UsagePeriod,
  endDate = new Date(),
): UsagePeriodBucket[] {
  const bucketCount = period === 'day' ? 365 : period === 'week' ? 53 : 12
  const latestStart = startOfUsagePeriod(endDate, period)
  const buckets = Array.from({ length: bucketCount }, (_, index) => {
    const start = new Date(latestStart)
    const offset = index - bucketCount + 1
    if (period === 'month') start.setMonth(start.getMonth() + offset)
    else start.setDate(start.getDate() + offset * (period === 'week' ? 7 : 1))
    return { startDate: localDateKey(start), totalTokens: 0 }
  })
  const byStartDate = new Map(buckets.map(bucket => [bucket.startDate, bucket]))

  for (const usage of dailyUsage) {
    const date = parseUsageDate(usage.date)
    if (!date) continue
    const bucket = byStartDate.get(getUsagePeriodKey(date, period))
    if (bucket) bucket.totalTokens += usage.totalTokens
  }

  return buckets
}

function startOfUsagePeriod(date: Date, period: UsagePeriod): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12)
  if (period === 'week') start.setDate(start.getDate() - start.getDay())
  if (period === 'month') start.setDate(1)
  return start
}

export function getUsagePeriodKey(date: Date, period: UsagePeriod): string {
  return localDateKey(startOfUsagePeriod(date, period))
}

function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Parse local usage date keys without relying on implementation-defined Date parsing. */
export function parseUsageDate(value: string): Date | null {
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value)
  if (!match) return null
  const [, year, month, day] = match.map(Number)
  const date = new Date(year, month - 1, day, 12)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : null
}

export function isLocalDateKey(value: string): boolean {
  // Local usage keys are always canonical padded ISO. Reuse the same strict
  // parser as parseUsageDate so a non-existent date (e.g. Feb 31) stays out.
  const date = parseUsageDate(value)
  return date !== null && localDateKey(date) === value
}
