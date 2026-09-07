// input: Parsed automation list with cron expressions and optional IANA timezones
// output: Chronologically sorted next-run projection for enabled scheduled tasks
// pos: Pure derivation shared by the scheduled-task overview and its tests

import type { AutomationListItem } from './types'
import { computeNextRuns } from './utils'

export interface UpcomingScheduledTask {
  automation: AutomationListItem
  runAt: Date
}

export function getUpcomingScheduledTasks(
  automations: AutomationListItem[],
  limit: number = 5,
): UpcomingScheduledTask[] {
  return automations
    .filter((automation) => automation.event === 'SchedulerTick' && automation.enabled && automation.cron)
    .flatMap((automation) => {
      const runAt = computeNextRuns(automation.cron!, 1, automation.timezone)[0]
      return runAt ? [{ automation, runAt }] : []
    })
    .sort((left, right) => left.runAt.getTime() - right.runAt.getTime())
    .slice(0, Math.max(0, limit))
}
