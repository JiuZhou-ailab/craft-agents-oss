// input: Current-workspace persisted per-session token totals
// output: Regression coverage for scoped usage aggregation and routing
// pos: Minimal runnable check for the App settings local usage section

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { buildUsageCalendar, buildUsagePeriodBuckets, summarizeLocalUsage, summarizeUsageActivity } from '../local-usage'

const source = readFileSync(new URL('../LocalUsageSection.tsx', import.meta.url), 'utf8')
const accountSource = readFileSync(new URL('../AccountSettingsSection.tsx', import.meta.url), 'utf8')

describe('summarizeLocalUsage', () => {
  it('aggregates persisted usage for one runtime workspace', () => {
    const session = (inputTokens: number, outputTokens: number) => ({
      tokenUsage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        contextTokens: 0,
        costUsd: 0,
      },
    })

    expect(summarizeLocalUsage([
      session(100, 20),
      session(30, 10),
      session(400, 40),
    ])).toEqual({
      totalTokens: 600,
      inputTokens: 530,
      outputTokens: 70,
      sessionCount: 3,
      dailyUsage: [],
      toolCalls: 0,
      uniqueTools: 0,
      topTools: [],
    })
  })

  it('aggregates daily totals and maps a year to logarithmic activity levels', () => {
    const summary = summarizeLocalUsage([
      {
        tokenUsage: {
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
          contextTokens: 0,
          costUsd: 0,
          byDay: {
            '2026-01-09': { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
            '2026-01-10': { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
          },
        },
      },
      {
        tokenUsage: {
          inputTokens: 8_000,
          outputTokens: 2_000,
          totalTokens: 10_000,
          contextTokens: 0,
          costUsd: 0,
          byDay: {
            '2026-01-10': { inputTokens: 7_960, outputTokens: 1_990, totalTokens: 9_950 },
          },
        },
      },
    ])

    expect(summary.dailyUsage).toEqual([
      { date: '2026-01-09', inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      { date: '2026-01-10', inputTokens: 8_000, outputTokens: 2_000, totalTokens: 10_000 },
    ])

    const calendar = buildUsageCalendar(summary.dailyUsage, new Date(2026, 0, 10))
    expect(calendar).toHaveLength(365)
    expect(calendar.at(-2)).toEqual({ date: '2026-01-09', count: 100, level: 3 })
    expect(calendar.at(-1)).toEqual({ date: '2026-01-10', count: 10_000, level: 4 })
    expect(summarizeUsageActivity(summary.dailyUsage, new Date(2026, 0, 10))).toEqual({
      peakTokens: 10_000,
      activeDays: 2,
      currentStreak: 2,
      longestStreak: 2,
    })
  })

  it('counts persisted tool calls and keeps skill names distinct', () => {
    const summary = summarizeLocalUsage([], [
      { id: '1', role: 'tool', content: '', timestamp: 1, toolName: 'Read' },
      { id: '2', role: 'tool', content: '', timestamp: 2, toolName: 'Read' },
      { id: '3', role: 'tool', content: '', timestamp: 3, toolName: 'Skill', toolInput: { skill: 'project:tdd' } },
      { id: '4', role: 'assistant', content: '', timestamp: 4 },
    ])

    expect(summary.toolCalls).toBe(3)
    expect(summary.uniqueTools).toBe(2)
    expect(summary.topTools).toEqual([
      { name: 'Read', count: 2, iconDataUrl: undefined },
      { name: '$tdd', count: 1, iconDataUrl: undefined },
    ])
  })

  it('queries only the current runtime workspace', () => {
    expect(source).toContain('const { runtimeWorkspace } = useAccountSettings()')
    expect(source).toContain('listSessionsByWorkspace(workspaceId)')
    expect(source).toContain("import HeatMap from '@uiw/react-heat-map'")
    expect(source).toContain("const [period, setPeriod] = useState<UsagePeriod>('day')")
    expect(source).toContain('buildUsageCalendar(summary.dailyUsage, endDate, period)')
    expect(source).toContain('<SettingsSegmentedControl')
    expect(source).toContain('data-period-highlighted={isHighlightedPeriod || undefined}')
    expect(source).toContain('strokeWidth: 1.5')
    expect(source).toContain('hoveredPeriodKey')
    expect(source).toContain('<SettingsCard divided={false}>')
    expect(accountSource).toContain('className="border-b-0"')
    expect(buildUsagePeriodBuckets([], 'month', new Date(2026, 0, 1))).toHaveLength(12)
    expect(source).toContain('getSessionMessages(session.id)')
    expect(source).toContain('usageSummaryLoads.get(workspaceId)')
    expect(source).not.toContain('Promise.all(sessions.map')
    expect(source).not.toContain('for (const workspace')
  })
})
