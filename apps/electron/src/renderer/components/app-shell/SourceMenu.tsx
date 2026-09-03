// input: Source identity, filesystem actions, and optional mutation callbacks
// output: Shared dropdown/context menu that omits unavailable source mutations
// pos: Renderer action boundary for source list and source detail menus

import { useTranslation } from "react-i18next"
import {
  Trash2,
  FolderOpen,
  AppWindow,
  Send,
} from 'lucide-react'
import { useMenuComponents } from '@/components/ui/menu-context'
import { getFileManagerName } from '@/lib/platform'

export interface SourceMenuProps {
  /** Source slug */
  sourceSlug: string
  /** Source name for display */
  sourceName: string
  /** Callbacks */
  onOpenInNewWindow: () => void
  onShowInFinder: () => void
  /** Omit for externally owned, read-only definitions. */
  onDelete?: () => void
  /** Send to another workspace (omit to hide the option) */
  onSendToWorkspace?: () => void
}

/**
 * SourceMenu - Renders the menu items for source actions
 * This is the content only, not wrapped in a DropdownMenu or ContextMenu
 */
export function SourceMenu({
  sourceSlug,
  sourceName,
  onOpenInNewWindow,
  onShowInFinder,
  onDelete,
  onSendToWorkspace,
}: SourceMenuProps) {
  const { t } = useTranslation()

  // Get menu components from context (works with both DropdownMenu and ContextMenu)
  const { MenuItem, Separator } = useMenuComponents()

  return (
    <>
      {/* Open in New Window */}
      <MenuItem onClick={onOpenInNewWindow}>
        <AppWindow className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sidebarMenu.openInNewWindow")}</span>
      </MenuItem>

      {/* Show in file manager */}
      <MenuItem onClick={onShowInFinder}>
        <FolderOpen className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sessionMenu.showInFileManager", { fileManager: getFileManagerName() })}</span>
      </MenuItem>

      {/* Send to another workspace */}
      {onSendToWorkspace && (
        <MenuItem onClick={onSendToWorkspace}>
          <Send className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sessionMenu.sendToWorkspace")}</span>
        </MenuItem>
      )}

      {onDelete && (
        <>
          <Separator />
          <MenuItem onClick={onDelete} variant="destructive">
            <Trash2 className="h-3.5 w-3.5" />
            <span className="flex-1">{t("sidebarMenu.deleteSource")}</span>
          </MenuItem>
        </>
      )}
    </>
  )
}
