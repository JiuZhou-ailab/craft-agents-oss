// input: Active workspace automation state and existing automation management callbacks
// output: Low-frequency settings page for viewing and editing workspace automations
// pos: Settings-level home for automations after removing them from primary workspace chrome

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation, Trans } from 'react-i18next'
import { ExternalLink } from 'lucide-react'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { EditPopover, getEditConfig } from '@/components/ui/EditPopover'
import { AutomationInfoPage } from '@/components/automations/AutomationInfoPage'
import { AutomationsListPanel } from '@/components/automations/AutomationsListPanel'
import type { ExecutionEntry } from '@/components/automations/types'
import { SettingsCard, SettingsCardContent, SettingsRow, SettingsSection } from '@/components/settings'
import { windowWorkspaceIdAtom, windowWorkspacesAtom } from '@/atoms/sessions'
import { useAutomations } from '@/hooks/useAutomations'
import { routes } from '@/lib/navigate'
import { cn } from '@/lib/utils'
import { getDocUrl } from '@craft-agent/shared/docs/doc-links'

export default function AutomationsSettingsPage() {
  const { t } = useTranslation()
  const activeWorkspaceId = useAtomValue(windowWorkspaceIdAtom)
  const workspaces = useAtomValue(windowWorkspacesAtom)
  const {
    automations, automationWorkspace: workspace,
    automationTestResults,
    automationPendingDelete,
    getAutomationHistory,
    handleDeleteAutomation,
    handleDuplicateAutomation,
    handleReplayAutomation,
    handleTestAutomation,
    handleToggleAutomation,
    confirmDeleteAutomation,
    pendingDeleteAutomation,
    setAutomationPendingDelete,
  } = useAutomations(activeWorkspaceId)
  const [selectedAutomationId, setSelectedAutomationId] = React.useState<string | null>(null)
  const [executions, setExecutions] = React.useState<ExecutionEntry[]>([])
  const [executionsLoading, setExecutionsLoading] = React.useState(false)

  const selectedAutomation = React.useMemo(
    () => automations.find((automation) => automation.id === selectedAutomationId),
    [automations, selectedAutomationId]
  )

  React.useEffect(() => {
    if (selectedAutomationId && !selectedAutomation) {
      setSelectedAutomationId(null)
    }
  }, [selectedAutomation, selectedAutomationId])

  React.useEffect(() => {
    if (!selectedAutomationId) {
      setExecutions([])
      setExecutionsLoading(false)
      return
    }

    let cancelled = false
    setExecutionsLoading(true)
    void getAutomationHistory(selectedAutomationId)
      .then((entries) => {
        if (!cancelled) setExecutions(entries)
      })
      .finally(() => {
        if (!cancelled) setExecutionsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [getAutomationHistory, selectedAutomationId])

  const configurationAction = workspace?.rootPath ? (
    <EditPopover
      align="end"
      trigger={
        <Button type="button" size="sm" variant="outline">
          {t('settings.automations.editConfig')}
        </Button>
      }
      {...getEditConfig('automation-config', workspace.rootPath)}
    />
  ) : null

  return (
    <div className="h-full flex flex-col">
      <PanelHeader
        title={t('settings.automations.title')}
        actions={<HeaderMenu route={routes.view.settings('automations')} helpFeature="automations" />}
      />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-5xl mx-auto">
            <div className="space-y-8">
              <SettingsSection title={t('settings.automations.configTitle')}>
                <SettingsCard>
                  <SettingsRow
                    label={t('settings.automations.configTitle')}
                    description={workspace ? t('settings.automations.configDesc') : t('settings.automations.noWorkspace')}
                    action={
                      <div className="flex items-center gap-2">
                        {configurationAction}
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => window.electronAPI.openUrl(getDocUrl('automations'))}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          {t('settings.automations.docs')}
                        </Button>
                      </div>
                    }
                  />
                </SettingsCard>
              </SettingsSection>

              <SettingsSection
                title={t('settings.automations.managerTitle')}
                description={t('settings.automations.managerDesc')}
              >
                {workspace ? (
                  <SettingsCard divided={false} className="overflow-hidden">
                    <div className="grid min-h-[520px] grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)]">
                      <div className="min-h-[320px] border-b border-border/50 lg:border-b-0 lg:border-r">
                        <AutomationsListPanel
                          automations={automations}
                          onAutomationClick={setSelectedAutomationId}
                          onTestAutomation={handleTestAutomation}
                          onToggleAutomation={handleToggleAutomation}
                          onDuplicateAutomation={handleDuplicateAutomation}
                          onDeleteAutomation={handleDeleteAutomation}
                          selectedAutomationId={selectedAutomationId}
                          workspaceRootPath={workspace.rootPath}
                          activeWorkspaceId={activeWorkspaceId}
                          workspaces={workspaces}
                          className="h-[360px] lg:h-[520px]"
                        />
                      </div>
                      <div className="min-h-[360px] bg-muted/20">
                        {selectedAutomation ? (
                          <AutomationInfoPage
                            automation={selectedAutomation}
                            executions={executionsLoading ? [] : executions}
                            testResult={automationTestResults?.[selectedAutomation.id]}
                            onTest={() => handleTestAutomation(selectedAutomation.id)}
                            onToggleEnabled={() => handleToggleAutomation(selectedAutomation.id)}
                            onDuplicate={() => handleDuplicateAutomation(selectedAutomation.id)}
                            onDelete={() => handleDeleteAutomation(selectedAutomation.id)}
                            onReplay={handleReplayAutomation}
                            workspaceId={workspace.id}
                            workspaceRootPath={workspace.rootPath}
                            className="h-full"
                          />
                        ) : (
                          <SettingsCardContent className={cn(
                            'flex min-h-[360px] flex-col items-center justify-center text-center',
                            'text-muted-foreground'
                          )}>
                            <div className="text-sm font-medium text-foreground">
                              {t('settings.automations.emptyDetailTitle')}
                            </div>
                            <div className="mt-1 max-w-sm text-xs">
                              {t('settings.automations.emptyDetailDesc')}
                            </div>
                          </SettingsCardContent>
                        )}
                      </div>
                    </div>
                  </SettingsCard>
                ) : (
                  <SettingsCard>
                    <SettingsCardContent>
                      <div className="text-sm text-muted-foreground">
                        {t('settings.automations.noWorkspace')}
                      </div>
                    </SettingsCardContent>
                  </SettingsCard>
                )}
              </SettingsSection>
            </div>
          </div>
        </ScrollArea>
      </div>
      <Dialog open={!!automationPendingDelete} onOpenChange={(open) => { if (!open) setAutomationPendingDelete(null) }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t('dialog.deleteAutomation.title')}</DialogTitle>
            <DialogDescription>
              <Trans
                i18nKey="dialog.deleteAutomation.description"
                values={{ name: pendingDeleteAutomation?.name }}
                components={{ strong: <strong /> }}
              />
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAutomationPendingDelete(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={confirmDeleteAutomation}>{t('common.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
