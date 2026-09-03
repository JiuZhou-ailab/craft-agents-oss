// input: Root-owned client authentication state exposed through AppShell context
// output: Account identity facts or managed-model sign-in inside App settings
// pos: Account section of the global application settings page

import { ClientSignInForm } from '@/components/auth/ClientSignInForm'
import { useTranslation } from 'react-i18next'
import {
  SettingsCard,
  SettingsCardContent,
  SettingsSection,
} from '@/components/settings'
import { CrossfadeAvatar } from '@/components/ui/avatar'
import { useAccountSettings } from '@/context/AppShellContext'
import type { ClientAuthUser } from '../../../shared/types'

export function AccountSettingsSection() {
  const {
    clientAuthState,
    onClientSignedIn,
  } = useAccountSettings()
  const { t } = useTranslation()
  const user = clientAuthState?.user
  const displayName = user ? getDisplayName(user) : ''

  return (
    <SettingsSection title={t('settings.app.account.title')}>
      {!user ? (
        clientAuthState?.configured ? (
          <ClientSignInForm
            emailPasswordEnabled={clientAuthState.emailPasswordEnabled}
            emailSignUpEnabled={clientAuthState.emailSignUpEnabled}
            feishuLoginEnabled={clientAuthState.feishuLoginEnabled}
            usernameLoginEnabled={clientAuthState.usernameLoginEnabled === true}
            onSignedIn={onClientSignedIn}
          />
        ) : (
          <SettingsCard divided={false}>
            <SettingsCardContent className="p-5">
              <h2 className="text-[15px] font-semibold text-foreground">{t('settings.app.account.unconfiguredTitle')}</h2>
              <p className="mt-2 text-[13px] leading-5 text-muted-foreground">
                {t('settings.app.account.unconfiguredDescription')}
              </p>
            </SettingsCardContent>
          </SettingsCard>
        )
      ) : (
        <SettingsCard divided={false}>
          <SettingsCardContent className="flex items-center gap-3.5 p-4">
            <CrossfadeAvatar
              src={user.avatarUrl}
              alt={`${displayName}的头像`}
              className="size-11 rounded-full ring-1 ring-border/60"
              fallbackClassName="rounded-full bg-foreground/10 text-sm font-semibold text-foreground/80"
              fallback={displayName.slice(0, 1).toUpperCase()}
            />
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[15px] font-semibold leading-6 text-foreground">
                {displayName}
              </h2>
              {user.email ? (
                <p className="truncate text-[12px] leading-5 text-muted-foreground">
                  {user.email}
                </p>
              ) : null}
            </div>
          </SettingsCardContent>
        </SettingsCard>
      )}
    </SettingsSection>
  )
}

function getDisplayName(user: ClientAuthUser): string {
  return user.name?.trim() || user.email?.trim() || user.userId || '本地用户'
}
