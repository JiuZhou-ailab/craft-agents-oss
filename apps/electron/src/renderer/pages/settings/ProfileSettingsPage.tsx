// input: Account context and client authentication state
// output: Dedicated profile settings surface
// pos: Global settings page for the signed-in user identity

import { useTranslation } from 'react-i18next'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { AccountSettingsSection } from '@/components/account'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { routes } from '@/lib/navigate'

export default function ProfileSettingsPage() {
  const { t } = useTranslation()

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title={t('settings.profile.title')} actions={<HeaderMenu route={routes.view.settings('profile')} />} />
      <div className="min-h-0 flex-1 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="mx-auto max-w-3xl px-5 py-5">
            <AccountSettingsSection />
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
