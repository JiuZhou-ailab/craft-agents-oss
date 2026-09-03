// input: Persisted local usage dates and daily token totals
// output: Regression coverage for strict date parsing and period aggregation
// pos: Contract test for the usage trend data model

import { describe, expect, it } from 'bun:test'
import { buildUsageCalendar, buildUsagePeriodBuckets, getUsagePeriodKey, isLocalDateKey, parseUsageDate } from './local-usage.ts'

describe('parseUsageDate', () => {
  it('parses an unpadded local date', () => {
    const date = parseUsageDate('2026/9/3')
    expect(date).not.toBeNull()
    expect(date!.getFullYear()).toBe(2026)
    expect(date!.getMonth()).toBe(8) // 0-indexed September
    expect(date!.getDate()).toBe(3)
  })

  it('parses padded ISO YYYY-MM-DD too (the format we feed into the value prop)', () => {
    const date = parseUsageDate('2026-03-05')
    expect(date).not.toBeNull()
    expect(date!.getFullYear()).toBe(2026)
    expect(date!.getMonth()).toBe(2)
    expect(date!.getDate()).toBe(5)
  })

  it('returns null for unparseable values instead of letting the Date constructor throw', () => {
    expect(parseUsageDate('')).toBeNull()
    expect(parseUsageDate('invalid')).toBeNull()
    expect(parseUsageDate('2026-02-31')).toBeNull() // Feb 31 does not exist
    expect(parseUsageDate('garbage/13/99')).toBeNull()
    expect(parseUsageDate('2026/13/1')).toBeNull() // month 13 does not exist
  })
})

describe('buildUsageCalendar', () => {
  it('emits padded ISO date keys that survive strict parsing', () => {
    const calendar = buildUsageCalendar(
      [{ date: '2026-08-01', inputTokens: 0, outputTokens: 0, totalTokens: 5 }],
      new Date(2026, 8, 3),
    )
    const withUsage = calendar.find(day => day.count > 0)
    expect(withUsage?.date).toBe('2026-08-01')
    // The library re-serializes to YYYY/M/D; parsing that must round-trip.
    expect(parseUsageDate('2026/8/1')).not.toBeNull()
  })
})

describe('buildUsagePeriodBuckets', () => {
  const usage = [
    { date: '2025-12-31', inputTokens: 80, outputTokens: 20, totalTokens: 100 },
    { date: '2026-01-01', inputTokens: 160, outputTokens: 40, totalTokens: 200 },
    { date: '2026-01-05', inputTokens: 240, outputTokens: 60, totalTokens: 300 },
  ]

  it('groups persisted daily totals by day, calendar week, and month without losing tokens', () => {
    const endDate = new Date(2026, 0, 5)
    const daily = buildUsagePeriodBuckets(usage, 'day', endDate)
    const weekly = buildUsagePeriodBuckets(usage, 'week', endDate)
    const monthly = buildUsagePeriodBuckets(usage, 'month', endDate)

    expect(daily.reduce((total, bucket) => total + bucket.totalTokens, 0)).toBe(600)
    expect(weekly.at(-2)).toEqual({ startDate: '2025-12-28', totalTokens: 300 })
    expect(weekly.at(-1)).toEqual({ startDate: '2026-01-04', totalTokens: 300 })
    expect(monthly.at(-2)).toEqual({ startDate: '2025-12-01', totalTokens: 100 })
    expect(monthly.at(-1)).toEqual({ startDate: '2026-01-01', totalTokens: 500 })

    const weeklyGrid = buildUsageCalendar(usage, endDate, 'week')
    const monthlyGrid = buildUsageCalendar(usage, endDate, 'month')
    expect(weeklyGrid.at(-1)?.count).toBe(300)
    expect(monthlyGrid.at(-1)?.count).toBe(500)
  })

  it('aligns weekly hover groups to heatmap columns and monthly groups to calendar months', () => {
    expect(getUsagePeriodKey(new Date(2026, 8, 6), 'week')).toBe('2026-09-06')
    expect(getUsagePeriodKey(new Date(2026, 8, 1), 'month')).toBe('2026-09-01')
    expect(getUsagePeriodKey(new Date(2026, 8, 30), 'month')).toBe('2026-09-01')
  })
})

describe('isLocalDateKey', () => {
  it('rejects non-canonical or impossible date keys', () => {
    expect(isLocalDateKey('2026-08-01')).toBe(true)
    expect(isLocalDateKey('2026/8/1')).toBe(false)
    expect(isLocalDateKey('2026-02-31')).toBe(false)
    expect(isLocalDateKey('not-a-date')).toBe(false)
  })
})
