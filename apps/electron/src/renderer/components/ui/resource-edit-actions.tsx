// input: File-backed resource edit targets and AI edit popover config
// output: Manual file edit and AI edit actions rendered as separate controls
// pos: Shared action surface for skills, sources, and other config-backed resource pages

import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from './button'
import { EditPopover, type EditPopoverProps } from './EditPopover'
import { ManualEditButton } from './manual-edit-button'
export { ManualEditButton } from './manual-edit-button'

export interface ResourceEditActionsProps extends Omit<EditPopoverProps, 'trigger' | 'secondaryAction'> {
  filePath: string
  canEditFile?: boolean
  /** Prefer opening in the system/project editor over preview. */
  onOpenFile?: (filePath: string) => void | Promise<void>
}

export function ResourceEditActions({
  filePath,
  canEditFile = true,
  onOpenFile,
  ...editPopoverProps
}: ResourceEditActionsProps) {
  const { t } = useTranslation()
  const editFileLabel = t('common.editFile')
  const editWithAiLabel = t('common.editWithAi')

  return (
    <div className="flex items-center gap-1.5">
      <ManualEditButton
        label={editFileLabel}
        filePath={filePath}
        disabled={!canEditFile}
        onOpenFile={onOpenFile}
      />
      <EditPopover
        {...editPopoverProps}
        trigger={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            title={editWithAiLabel}
            aria-label={editWithAiLabel}
            className="h-8 px-3 rounded-[6px] bg-background shadow-minimal text-foreground/70 hover:text-foreground"
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span>{editWithAiLabel}</span>
          </Button>
        }
      />
    </div>
  )
}
