// input: Active project sessions and persisted tool activity
// output: Dedicated local usage statistics surface
// pos: Global settings page for current-project usage

import { useTranslation } from 'react-i18next'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { LocalUsageSection } from '@/components/account'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { routes } from '@/lib/navigate'

export default function UsageSettingsPage() {
  const { t } = useTranslation()

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title={t('settings.app.localUsage.title')} actions={<HeaderMenu route={routes.view.settings('usage')} />} />
      <div className="min-h-0 flex-1 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="mx-auto max-w-3xl px-5 py-5">
            <LocalUsageSection />
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
