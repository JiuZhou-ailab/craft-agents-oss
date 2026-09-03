// input: Settings registry, selected subpage, and overlay lifecycle callbacks
// output: Compact settings navigation plus the responsive settings dialog
// pos: Renderer utility surface that keeps settings outside the workspace panel stack
// Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, FolderCog, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SettingsSubpage } from '../../../shared/types'
import { SETTINGS_ITEMS } from '../../../shared/menu-schema'
import { SETTINGS_ICONS } from '@/components/icons/SettingsIcons'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { getSettingsPageComponent } from './settings-pages'

interface SettingsNavigatorProps {
  /** Currently selected settings subpage */
  selectedSubpage: SettingsSubpage
  /** Called when a subpage is selected */
  onSelectSubpage: (subpage: SettingsSubpage) => void
  availableSubpages?: readonly SettingsSubpage[]
}

interface SettingsItem {
  id: SettingsSubpage
  label: string
  icon: React.ComponentType<{ className?: string }>
}

interface SettingsItemRowProps {
  item: SettingsItem
  isSelected: boolean
  nested?: boolean
  onSelect: () => void
}

const PRIMARY_SETTINGS_SUBPAGES: readonly SettingsSubpage[] = [
  'app',
  'profile',
  'usage',
  'ai',
  'appearance',
  'input',
  'shortcuts',
  // Experimental app-level remote access; hidden unless its feature flag is enabled.
  'server',
]

export const GLOBAL_SETTINGS_SUBPAGES: readonly SettingsSubpage[] = [
  ...PRIMARY_SETTINGS_SUBPAGES,
]

const PROJECT_SETTINGS_SUBPAGES: readonly SettingsSubpage[] = [
  'workspace',
  'permissions',
  'labels',
  'automations',
  'messaging',
]

function SettingsItemRow({ item, isSelected, nested = false, onSelect }: SettingsItemRowProps) {
  const Icon = item.icon

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={isSelected ? 'page' : undefined}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-[13px] outline-none max-[640px]:justify-center max-[640px]:gap-0 max-[640px]:px-0',
        'transition-colors duration-75 focus-visible:ring-1 focus-visible:ring-ring',
        nested && 'pl-[30px] max-[640px]:pl-0',
        isSelected
          ? 'bg-foreground/[0.07] text-foreground'
          : 'text-foreground/75 hover:bg-foreground/[0.045] hover:text-foreground'
      )}
    >
      <Icon
        className={cn(
          'size-4 shrink-0',
          isSelected ? 'text-foreground' : 'text-muted-foreground'
        )}
      />
      <span
        className={cn(
          'min-w-0 truncate max-[640px]:sr-only',
          isSelected ? 'font-medium' : 'font-normal'
        )}
      >
        {item.label}
      </span>
    </button>
  )
}

export default function SettingsNavigator({
  selectedSubpage,
  onSelectSubpage,
  availableSubpages,
}: SettingsNavigatorProps) {
  const { t } = useTranslation()
  const [isProjectGroupExpanded, setIsProjectGroupExpanded] = useState(false)

  const settingsItems: SettingsItem[] = useMemo(() =>
    SETTINGS_ITEMS
      .filter(item => !availableSubpages || availableSubpages.includes(item.id))
      .map((item) => ({
      id: item.id,
      label: t(item.labelKey),
      icon: SETTINGS_ICONS[item.id],
    })),
    [availableSubpages, t]
  )

  const settingsItemsById = useMemo(
    () => new Map(settingsItems.map(item => [item.id, item])),
    [settingsItems]
  )
  const primaryItems = PRIMARY_SETTINGS_SUBPAGES.flatMap(id => {
    const item = settingsItemsById.get(id)
    return item ? [item] : []
  })
  const projectItems = PROJECT_SETTINGS_SUBPAGES.flatMap(id => {
    const item = settingsItemsById.get(id)
    return item ? [item] : []
  })
  const hasSelectedProjectItem = projectItems.some(item => item.id === selectedSubpage)
  const isProjectGroupOpen = isProjectGroupExpanded || hasSelectedProjectItem

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto">
        <div className="space-y-0.5 p-2">
          {primaryItems.map((item) => (
            <SettingsItemRow
              key={item.id}
              item={item}
              isSelected={
                selectedSubpage === item.id
                || (item.id === 'ai' && selectedSubpage === 'preferences')
              }
              onSelect={() => onSelectSubpage(item.id)}
            />
          ))}
          {projectItems.length > 0 && (
            <div className="pt-2">
              <button
                type="button"
                className={cn(
                  'flex h-8 w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-[13px] outline-none max-[640px]:justify-center max-[640px]:gap-0 max-[640px]:px-0',
                  'text-foreground/75 transition-colors duration-75 hover:bg-foreground/[0.045] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring active:bg-foreground/[0.07]',
                  hasSelectedProjectItem && 'text-foreground'
                )}
                aria-expanded={isProjectGroupOpen}
                onClick={() => setIsProjectGroupExpanded(expanded => !expanded)}
              >
                <FolderCog className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate max-[640px]:sr-only">
                  {t('settings.navigation.currentProject')}
                </span>
                {isProjectGroupOpen
                  ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground max-[640px]:hidden" />
                  : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground max-[640px]:hidden" />}
              </button>
              {isProjectGroupOpen && (
                <div className="mt-0.5 space-y-0.5">
                  {projectItems.map((item) => (
                    <SettingsItemRow
                      key={item.id}
                      item={item}
                      nested
                      isSelected={selectedSubpage === item.id}
                      onSelect={() => onSelectSubpage(item.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

interface SettingsDialogProps {
  open: boolean
  selectedSubpage: SettingsSubpage
  onSelectSubpage: (subpage: SettingsSubpage) => void
  onClose: () => void
  availableSubpages?: readonly SettingsSubpage[]
}

export function SettingsDialog({
  open,
  selectedSubpage,
  onSelectSubpage,
  onClose,
  availableSubpages,
}: SettingsDialogProps) {
  const { t } = useTranslation()
  const SettingsPageComponent = getSettingsPageComponent(selectedSubpage)

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }}>
      <DialogContent
        showCloseButton={false}
        onPointerDownOutside={(event) => event.preventDefault()}
        className="h-[85vh] max-h-[900px] w-[min(960px,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden p-0 sm:max-w-none max-[1023px]:left-0 max-[1023px]:top-0 max-[1023px]:h-full max-[1023px]:max-h-none max-[1023px]:w-full max-[1023px]:max-w-none max-[1023px]:translate-x-0 max-[1023px]:translate-y-0 max-[1023px]:rounded-none"
      >
        <DialogTitle className="sr-only">{t('sidebar.settings')}</DialogTitle>
        <DialogDescription className="sr-only">配置 Storyflow 应用与工作区偏好</DialogDescription>
        <div className="flex h-full min-h-0">
          <aside className="flex w-[160px] shrink-0 flex-col border-r border-border/60 bg-foreground-1.5 max-[640px]:w-14">
            <div className="flex h-12 shrink-0 items-center border-b border-border/60 px-4">
              <h2 className="text-[14px] font-semibold text-foreground max-[640px]:sr-only">{t('sidebar.settings')}</h2>
            </div>
            <div className="min-h-0 flex-1">
              <SettingsNavigator
                selectedSubpage={selectedSubpage}
                onSelectSubpage={onSelectSubpage}
                availableSubpages={availableSubpages}
              />
            </div>
          </aside>
          <main className="relative min-w-0 flex-1 bg-background [&_.titlebar-drag-region]:pr-12">
            <SettingsPageComponent />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-settings-dialog-close
              className="titlebar-no-drag absolute right-2 top-[5px] z-panel size-8 rounded-lg max-[640px]:right-0 max-[640px]:top-0 max-[640px]:size-11"
              onClick={onClose}
              aria-label={t('common.close')}
            >
              <X className="size-4" />
            </Button>
          </main>
        </div>
      </DialogContent>
    </Dialog>
  )
}
