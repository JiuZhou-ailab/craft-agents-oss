// input: Mixed enabled, disabled, scheduled, and invalid automation records
// output: Regression coverage for the scheduled-task overview projection
// pos: Protects filtering, timezone-aware cron parsing, ordering, and result limits

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'
import type { AutomationListItem } from '../types'
import { getUpcomingScheduledTasks } from '../schedule-overview'

const overviewSource = readFileSync(new URL('../ScheduledTasksOverview.tsx', import.meta.url), 'utf8')
const editPopoverSource = readFileSync(new URL('../../ui/EditPopover.tsx', import.meta.url), 'utf8')
const navigationSource = readFileSync(new URL('../../../contexts/NavigationContext.tsx', import.meta.url), 'utf8')

function automation(
  overrides: Partial<AutomationListItem> & Pick<AutomationListItem, 'id' | 'event'>,
): AutomationListItem {
  return {
    id: overrides.id,
    event: overrides.event,
    matcherIndex: 0,
    name: overrides.id,
    summary: '',
    enabled: overrides.enabled ?? true,
    actions: [],
    cron: overrides.cron,
    timezone: overrides.timezone,
  }
}

describe('getUpcomingScheduledTasks', () => {
  it('returns only enabled schedules with valid future runs in chronological order', () => {
    const results = getUpcomingScheduledTasks([
      automation({ id: 'hourly', event: 'SchedulerTick', cron: '0 * * * *', timezone: 'Asia/Shanghai' }),
      automation({ id: 'frequent', event: 'SchedulerTick', cron: '*/5 * * * *', timezone: 'UTC' }),
      automation({ id: 'disabled', event: 'SchedulerTick', cron: '* * * * *', enabled: false }),
      automation({ id: 'invalid', event: 'SchedulerTick', cron: 'not a cron' }),
      automation({ id: 'event', event: 'LabelAdd', cron: '* * * * *' }),
    ])

    expect(results.map(result => result.automation.id).sort()).toEqual(['frequent', 'hourly'])
    expect(results[0]!.runAt.getTime()).toBeLessThanOrEqual(results[1]!.runAt.getTime())
  })

  it('honors the requested overview limit', () => {
    const results = getUpcomingScheduledTasks([
      automation({ id: 'one', event: 'SchedulerTick', cron: '* * * * *' }),
      automation({ id: 'two', event: 'SchedulerTick', cron: '*/2 * * * *' }),
    ], 1)

    expect(results).toHaveLength(1)
    expect(getUpcomingScheduledTasks(results.map(result => result.automation), 0)).toEqual([])
  })

  it('replaces empty metrics with one centered creation path', () => {
    expect(overviewSource).toContain('if (scheduledTasks.length === 0)')
    expect(overviewSource).toContain("t('automations.scheduledEmptyTitle')")
    expect(overviewSource).toContain("getEditConfig('scheduled-task', workspaceRootPath)")
    expect(overviewSource).toContain('conversationWorkspaceId={workspace.id}')
    expect(overviewSource).toContain('text-2xl font-semibold tracking-tight')
    expect(overviewSource).toContain('{pageHeader}')
  })

  it('runs automation configuration in a visible bound conversation', () => {
    const automationConfigSource = editPopoverSource.slice(
      editPopoverSource.indexOf("'scheduled-task':"),
      editPopoverSource.indexOf('\n  }),', editPopoverSource.indexOf("'scheduled-task':")) + 6,
    )

    expect(automationConfigSource).toContain('inlineExecution: false')
    expect(automationConfigSource).toContain('pinSession: true')
    expect(automationConfigSource).toContain('Bind sessionId to THIS conversation')
    expect(editPopoverSource).toContain('await navigate(routes.action.newSession({')
    expect(editPopoverSource).toContain('workspaceId: conversationWorkspaceId')
    expect(editPopoverSource).not.toContain('craftagents://')
    expect(editPopoverSource).toContain("pinned: pinSession ? 'true' : undefined")
    expect(editPopoverSource).toContain('setOpen(false)')
  })

  it('creates the fixed session before sending through the normal optimistic message path', () => {
    const actionSource = navigationSource.slice(
      navigationSource.indexOf("case 'new-session':"),
      navigationSource.indexOf("case 'rename-session':"),
    )

    expect(actionSource).toContain("if (parsed.params.pinned === 'true') createOptions.isPinned = true")
    expect(actionSource).toContain('await commitCreatedSessionSend(')
    expect(actionSource).toContain('() => onSendMessage(')
    expect(actionSource).toContain('() => onAutoDeleteEmptySession?.(session.id, true)')
    expect(actionSource).not.toContain('window.electronAPI.sendMessage(')
  })
})
