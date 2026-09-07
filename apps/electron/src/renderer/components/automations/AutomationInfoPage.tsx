/**
 * AutomationInfoPage
 *
 * Detail view for a selected automation, using the Info_Page compound component system.
 * input: Selected automation, runtime scope, and task actions
 * output: Compact title/action header and sections for schedule, actions, settings, and history
 * pos: Detail content shared by the scheduled-task side column and other automation routes
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { MoreHorizontal, X, PauseCircle, Hash } from 'lucide-react'
import {
  Info_Page,
  Info_Section,
  Info_Table,
  Info_Alert,
  Info_Badge,
  Info_Markdown,
} from '@/components/info'
import { EditPopover, EditButton, getEditConfig } from '@/components/ui/EditPopover'
import { DropdownMenu, DropdownMenuTrigger, StyledDropdownMenuContent } from '@/components/ui/styled-dropdown'
import { Button } from '@/components/ui/button'
import { AutomationAvatar } from './AutomationAvatar'
import { AutomationMenu } from './AutomationMenu'
import { AutomationActionRow } from './AutomationActionRow'
import { AutomationTestPanel } from './AutomationTestPanel'
import { AutomationEventTimeline } from './AutomationEventTimeline'
import { PhaseBadge } from './PhaseBadge'
import { getEventDisplayName, getPermissionDisplayName, flattenConditions, type AutomationListItem, type ExecutionEntry, type TestResult } from './types'
import { describeCron, computeNextRuns } from './utils'

// ============================================================================
// Component
// ============================================================================

export interface AutomationInfoPageProps {
  automation: AutomationListItem
  executions?: ExecutionEntry[]
  testResult?: TestResult
  onToggleEnabled?: () => void
  onTest?: () => void
  onDuplicate?: () => void
  onDelete?: () => void
  onReplay?: (automationId: string, event: string) => void
  workspaceId?: string
  workspaceRootPath?: string
  className?: string
  onClose?: () => void
}

export function AutomationInfoPage({
  automation,
  executions = [],
  testResult,
  onToggleEnabled,
  onTest,
  onDuplicate,
  onDelete,
  onReplay,
  workspaceId,
  workspaceRootPath,
  className,
  onClose,
}: AutomationInfoPageProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage || i18n.language || 'en'
  const nextRuns = automation.cron ? computeNextRuns(automation.cron, 3, automation.timezone) : []

  // Lightweight per-mount fetch — mirrors the pattern used in MessagingSettingsPage.
  // Only fired when the matcher actually declares a topic to avoid unnecessary IPC.
  const [hasSupergroup, setHasSupergroup] = React.useState<boolean | null>(null)
  React.useEffect(() => {
    if (!automation.telegramTopic) {
      setHasSupergroup(null)
      return
    }
    let cancelled = false
    void window.electronAPI.getMessagingSupergroup().then((sg) => {
      if (!cancelled) setHasSupergroup(Boolean(sg?.chatId))
    }).catch(() => {
      if (!cancelled) setHasSupergroup(false)
    })
    return () => {
      cancelled = true
    }
  }, [automation.telegramTopic])

  const editActions = workspaceRootPath ? (
    <EditPopover
      trigger={<EditButton />}
      {...getEditConfig('automation-config', workspaceRootPath)}
      conversationWorkspaceId={workspaceId}
      secondaryAction={{ label: t('automations.editFile'), filePath: `${workspaceRootPath}/automations.json` }}
    />
  ) : undefined

  return (
    <Info_Page className={className}>
      <header className="shrink-0 border-b px-5 pt-5 pb-4" data-testid="automation-detail-header">
        <div className="flex items-start gap-3">
          <AutomationAvatar event={automation.event} size="sm" />
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold tracking-tight">{automation.name}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {!automation.enabled ? t('automations.pausedTitle') : nextRuns[0]
                ? `${t('automations.labelNextRuns')} · ${new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', ...(automation.timezone ? { timeZone: automation.timezone } : {}) }).format(nextRuns[0])}`
                : automation.summary}
            </p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7" aria-label={automation.name}><MoreHorizontal className="size-4" /></Button>
            </DropdownMenuTrigger>
            <StyledDropdownMenuContent align="end">
              <AutomationMenu automationId={automation.id} automationName={automation.name} enabled={automation.enabled}
                onToggleEnabled={onToggleEnabled} onTest={onTest} onDuplicate={onDuplicate} onDelete={onDelete} />
            </StyledDropdownMenuContent>
          </DropdownMenu>
          {onClose ? <Button variant="ghost" size="icon" className="size-7" aria-label={t('common.close')} onClick={onClose}><X className="size-4" /></Button> : null}
        </div>
        <div className="mt-4 flex items-center gap-3">
          {automation.sessionId && workspaceId ? (
            <Button variant="outline" size="sm" onClick={() => {
              void window.electronAPI.openUrl(`craftagents://workspace/${encodeURIComponent(workspaceId)}/allSessions/session/${encodeURIComponent(automation.sessionId!)}?window=focused`)
            }}>{t('automations.openSession')}</Button>
          ) : null}
          {editActions}
        </div>
      </header>
      <Info_Page.Content>
        {/* Disabled warning */}
        {!automation.enabled && (
          <Info_Alert variant="warning" icon={<PauseCircle className="h-4 w-4" />}>
            <Info_Alert.Title>{t('automations.pausedTitle')}</Info_Alert.Title>
            <Info_Alert.Description>
              {t('automations.pausedDescription')}
            </Info_Alert.Description>
          </Info_Alert>
        )}

        {/* Section: When */}
        <Info_Section
          title={t('automations.sectionWhen')}
          description={t('automations.sectionWhenDescription')}
          actions={editActions}
        >
          <Info_Table>
            <Info_Table.Row label={t('automations.labelEvent')}>
              <Info_Badge color="default">{getEventDisplayName(automation.event)}</Info_Badge>
            </Info_Table.Row>
            <Info_Table.Row label={t('automations.labelTiming')}>
              <PhaseBadge event={automation.event} />
            </Info_Table.Row>
            {automation.matcher && (
              <Info_Table.Row label={t('automations.labelOnlyWhenMatching')}>
                <code className="text-xs font-mono bg-foreground/5 px-1.5 py-0.5 rounded">
                  {automation.matcher}
                </code>
              </Info_Table.Row>
            )}
            {automation.cron && (
              <>
                <Info_Table.Row label={t('automations.labelRepeats')} value={describeCron(automation.cron)} />
                <Info_Table.Row label={t('automations.labelScheduleExpression')}>
                  <code className="text-xs font-mono bg-foreground/5 px-1.5 py-0.5 rounded">
                    {automation.cron}
                  </code>
                </Info_Table.Row>
                {nextRuns.length > 0 && (
                  <Info_Table.Row label={t('automations.labelNextRuns')}>
                    <div className="flex flex-col gap-0.5">
                      {(() => {
                        const spansYears = nextRuns.length > 1 && nextRuns[0].getFullYear() !== nextRuns[nextRuns.length - 1].getFullYear()
                        return nextRuns.map((date, i) => (
                          <span key={i} className="text-sm text-foreground/70">
                            {date.toLocaleDateString(locale, {
                              month: 'short',
                              day: 'numeric',
                              ...(spansYears && { year: 'numeric' }),
                              ...(automation.timezone ? { timeZone: automation.timezone } : {}),
                            })}{' '}
                            {date.toLocaleTimeString(locale, {
                              hour: '2-digit',
                              minute: '2-digit',
                              hour12: false,
                              ...(automation.timezone ? { timeZone: automation.timezone } : {}),
                            })}
                          </span>
                        ))
                      })()}
                    </div>
                  </Info_Table.Row>
                )}
                <Info_Table.Row label={t('automations.labelTimezone')} value={automation.timezone || t('automations.systemDefault')} />
              </>
            )}
          </Info_Table>
        </Info_Section>

        {/* Section: If (conditions) — hidden when empty */}
        {automation.conditions && automation.conditions.length > 0 && (
          <Info_Section
            title={t('automations.sectionIf')}
            description={t('automations.sectionIfDescription')}
            actions={editActions}
          >
            <Info_Table>
              {flattenConditions(automation.conditions).map((row, i) => (
                <Info_Table.Row key={i} label={row.label}>
                  <span className="text-sm text-foreground/70">
                    {row.description}
                  </span>
                </Info_Table.Row>
              ))}
            </Info_Table>
          </Info_Section>
        )}

        {/* Section: Then */}
        <Info_Section
          title={t('automations.sectionThen')}
          description={t('automations.sectionThenDescription', { count: automation.actions.length })}
          actions={editActions}
        >
          <div className="divide-y divide-border/30">
            {automation.actions.map((action, i) => (
              <AutomationActionRow key={i} action={action} index={i} />
            ))}
          </div>
        </Info_Section>

        {/* Test results (if any) */}
        {testResult && testResult.state !== 'idle' && (
          <AutomationTestPanel result={testResult} />
        )}

        {/* Section: Settings */}
        <Info_Section title={t('automations.sectionSettings')} actions={editActions}>
          <Info_Table>
            <Info_Table.Row label={t('automations.labelAccessLevel')} value={getPermissionDisplayName(automation.permissionMode)} />
            <Info_Table.Row label={t('automations.labelStatus')}>
              <Info_Badge color={automation.enabled ? 'success' : 'muted'}>
                {automation.enabled ? t('automations.statusActive') : t('automations.statusDisabled')}
              </Info_Badge>
            </Info_Table.Row>
            {automation.labels && automation.labels.length > 0 && (
              <Info_Table.Row label={t('automations.labelLabels')}>
                <div className="flex gap-1.5 flex-wrap">
                  {automation.labels.map((l) => (
                    <Info_Badge key={l} color="muted">{l}</Info_Badge>
                  ))}
                </div>
              </Info_Table.Row>
            )}
            {automation.telegramTopic && (
              <Info_Table.Row label={t('automations.labelTelegramTopic')}>
                <div className="flex flex-col gap-1">
                  <div className="inline-flex items-center gap-1.5 text-foreground">
                    <Hash className="size-3.5 text-foreground/50" />
                    <span className="font-mono text-xs">{automation.telegramTopic}</span>
                  </div>
                  <span className="text-xs text-foreground/50">
                    {hasSupergroup === false
                      ? t('automations.telegramTopicHintNoSupergroup')
                      : t('automations.telegramTopicHintBound')}
                  </span>
                </div>
              </Info_Table.Row>
            )}
          </Info_Table>
        </Info_Section>

        {/* Section: Recent Activity */}
        <Info_Section
          title={t('automations.sectionRecentActivity')}
          description={executions.length > 0 ? t('automations.lastNRuns', { count: executions.length }) : undefined}
        >
          <AutomationEventTimeline workspaceId={workspaceId} entries={executions} onReplay={onReplay} />
        </Info_Section>

        {/* Section: Raw config (JSON) */}
        <Info_Section title={t('automations.sectionRawConfig')}>
          <div className="rounded-[8px] shadow-minimal overflow-hidden [&_pre]:!bg-transparent [&_.relative]:!bg-transparent [&_.relative]:!border-0 [&_.relative>div:first-child]:!bg-transparent [&_.relative>div:first-child]:!border-0">
            <Info_Markdown maxHeight={300} fullscreen>
              {`\`\`\`json\n${JSON.stringify({
                event: automation.event,
                matcher: automation.matcher,
                conditions: automation.conditions,
                cron: automation.cron,
                timezone: automation.timezone,
                permissionMode: automation.permissionMode,
                labels: automation.labels,
                telegramTopic: automation.telegramTopic,
                enabled: automation.enabled,
                actions: automation.actions,
              }, null, 2)}\n\`\`\``}
            </Info_Markdown>
          </div>
        </Info_Section>
      </Info_Page.Content>
    </Info_Page>
  )
}
