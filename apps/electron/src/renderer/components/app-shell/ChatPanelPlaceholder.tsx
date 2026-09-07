// input: Whether a conversation is unavailable or still loading, and existing session navigation
// output: Chat placeholder chrome with a visible loading or actionable empty state
// pos: Shared fallback surface for base, writing, and lazily loaded session panels

import { useTranslation } from 'react-i18next'
import { LoaderCircle } from 'lucide-react'
import { useNavigationActions } from '@/contexts/NavigationContext'
import { useSessionPanelChrome } from '@/context/AppShellContext'
import { Button } from '@/components/ui/button'
import { routes } from '@/lib/navigate'
import { PanelHeader } from './PanelHeader'

export function ChatPanelPlaceholder({ empty = false }: { empty?: boolean }) {
  const { t } = useTranslation()
  const { navigate } = useNavigationActions()
  const { rightSidebarButton } = useSessionPanelChrome()
  const startConversation = () => navigate(routes.action.newSession())

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="writing-chat-placeholder">
      <PanelHeader
        className="border-b-0"
        title={t('chat.session')}
        rightSidebarButton={rightSidebarButton}
        actions={(
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={startConversation}
          >
            {t('session.newSession')}
          </Button>
        )}
      />
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-8 text-muted-foreground">
        {empty ? (
          <div className="max-w-sm text-center">
            <h2 className="text-xl font-medium text-foreground">{t('chatOpening.general.title')}</h2>
            <p className="mt-2 text-sm leading-relaxed">{t('session.noSessionsYetDesc')}</p>
            <Button className="mt-5" data-testid="start-conversation" onClick={startConversation}>
              {t('session.newSession')}
            </Button>
          </div>
        ) : (
          <div role="status" className="flex items-center gap-2 text-sm">
            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {t('common.loading')}
          </div>
        )}
      </div>
    </div>
  )
}
