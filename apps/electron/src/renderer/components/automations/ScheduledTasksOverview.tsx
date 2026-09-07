// input: Workspace scheduled automations, standalone automation runtime, and selection callback
// output: Single task list with modal details and conversation-bound creation
// pos: Scheduled-task page layout and selected-task dialog

import type { ReactNode } from 'react'
import type { Workspace } from '../../../shared/types'
import { CalendarClock, ChevronRight, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { EditPopover, getEditConfig } from '@/components/ui/EditPopover'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { AutomationListItem } from './types'
import { AutomationAvatar } from './AutomationAvatar'
import { getUpcomingScheduledTasks } from './schedule-overview'

export interface ScheduledTasksOverviewProps {
  automations: AutomationListItem[]
  workspace: Workspace | null
  onSelectAutomation: (automationId: string) => void
  selectedAutomationId?: string
  detail?: ReactNode
  onCloseDetail?: () => void
}

function formatRunAt(date: Date, locale: string, timezone?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      ...(timezone ? { timeZone: timezone } : {}),
    }).format(date)
  } catch {
    return date.toLocaleString(locale)
  }
}

export function ScheduledTasksOverview({
  automations,
  workspace,
  onSelectAutomation,
  selectedAutomationId,
  detail,
  onCloseDetail,
}: ScheduledTasksOverviewProps) {
  const { t, i18n } = useTranslation()
  const workspaceRootPath = workspace?.rootPath
  const locale = i18n.resolvedLanguage || i18n.language || 'en'
  const scheduledTasks = automations.filter((automation) => automation.event === 'SchedulerTick')
  const upcomingTasks = getUpcomingScheduledTasks(scheduledTasks, scheduledTasks.length)

  const creationAction = workspaceRootPath && workspace ? (
    <div className="titlebar-no-drag flex flex-wrap items-center justify-center gap-2">
      <EditPopover
        key={workspace.id}
        align="center"
        trigger={(
          <Button data-testid="create-scheduled-task" size="sm" variant="outline">
            <Plus className="size-3.5" />
            {t('automations.createScheduledTask')}
          </Button>
        )}
        {...getEditConfig('scheduled-task', workspaceRootPath)}
        conversationWorkspaceId={workspace.id}
        overridePlaceholder={t('automations.scheduledCreatePlaceholder')}
        example={t('automations.scheduledCreateExample')}
      />
    </div>
  ) : null

  const pageHeader = (
    <div className="relative shrink-0">
      <div aria-hidden="true" className="titlebar-drag-region absolute inset-x-0 top-0 h-8 sm:h-10" />
      <div className="mx-auto w-full max-w-5xl px-6 pt-8 pb-4 sm:px-8 sm:pt-10">
        <header className="titlebar-drag-region flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">{t('sidebar.scheduled')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('automations.scheduledPageDescription')}</p>
          </div>
          {creationAction}
        </header>
      </div>
    </div>
  )

  if (scheduledTasks.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {pageHeader}
        <main className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10">
          <section className="flex w-full max-w-md flex-col items-center text-center">
            <div className="flex size-11 items-center justify-center rounded-[12px] bg-foreground/[0.045] text-foreground/55">
              <CalendarClock className="size-5" strokeWidth={1.6} />
            </div>
            <h2 className="mt-4 text-[18px] font-semibold tracking-[-0.012em] text-foreground">
              {t('automations.scheduledEmptyTitle')}
            </h2>
            <p className="mt-2 max-w-sm text-[13px] leading-5 text-muted-foreground">
              {workspaceRootPath
                ? t('automations.scheduledEmptyDescription')
                : t('common.loading')}
            </p>
          </section>
        </main>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {pageHeader}
      <div className="flex min-h-0 flex-1 overflow-x-auto" data-testid="scheduled-task-content">
        <div className="min-w-[280px] min-h-0 flex-1 mask-fade-y" data-testid="scheduled-task-list-column">
          <ScrollArea className="h-full">
            <main className="mx-auto w-full max-w-5xl px-6 pb-8 sm:px-8">
              <div className="divide-y divide-border/50" data-testid="scheduled-task-list">
                {scheduledTasks.map((automation) => {
                  const runAt = upcomingTasks.find(task => task.automation.id === automation.id)?.runAt
                  return (
                    <button
                      key={automation.id}
                      data-automation-id={automation.id}
                      data-selected={selectedAutomationId === automation.id}
                      aria-current={selectedAutomationId === automation.id ? 'true' : undefined}
                      type="button"
                      onClick={() => onSelectAutomation(automation.id)}
                      className="group flex w-full items-center gap-3 rounded px-3 py-4 text-left outline-none data-[selected=true]:bg-foreground/[0.05] hover:bg-foreground/[0.03] focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <AutomationAvatar event={automation.event} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{automation.name}</span>
                        <span className="mt-1 block truncate text-xs text-muted-foreground">{automation.actions.find(action => action.type === 'prompt')?.prompt}</span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {!automation.enabled ? t('automations.pausedTitle') : runAt ? formatRunAt(runAt, locale, automation.timezone) : t('common.never')}
                      </span>
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" />
                    </button>
                  )
                })}
              </div>
              <p className="mt-5 px-3 text-xs leading-5 text-muted-foreground">{t('automations.scheduledMachineNotice')}</p>
            </main>
          </ScrollArea>
        </div>
      </div>
      <Dialog open={Boolean(detail)} onOpenChange={open => { if (!open) onCloseDetail?.() }}>
        <DialogContent
          data-testid="scheduled-task-detail"
          showCloseButton={false}
          aria-modal="true"
          aria-describedby={undefined}
          className="flex h-[min(780px,85vh)] flex-col gap-0 overflow-hidden p-0 w-[calc(100%-2rem)] sm:max-w-[960px]"
        >
          <DialogTitle className="sr-only">{scheduledTasks.find(task => task.id === selectedAutomationId)?.name}</DialogTitle>
          <div className="min-h-0 flex-1 overflow-hidden">{detail}</div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
