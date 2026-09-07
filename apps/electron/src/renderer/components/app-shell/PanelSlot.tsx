// input: One panel-stack entry, focus state, title inset, proportional sizing, optional shell action, and minimum width
// output: One flat content pane with panel-specific chrome
// pos: Content pane renderer inside the continuous app workbench

/**
 * PanelSlot
 *
 * Renders a single content panel within the PanelStackContainer.
 *
 * When a panel is the only one (isOnly), it flex-grows to fill available space.
 * When multiple panels exist, each uses flex-grow with its proportion as the weight,
 * combined with a layout-owned minimum width.
 *
 * Multi-panel slots inject a close button into PanelHeader's rightSidebarButton
 * slot. The sole panel stays open; compact layouts use the back button instead.
 */

import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useSetAtom } from 'jotai'
import { X, ChevronLeft } from 'lucide-react'
import { parseRouteToNavigationState } from '../../../shared/route-parser'
import { closePanelAtom, focusedPanelIdAtom, type PanelStackEntry } from '@/atoms/panel-stack'
import { SessionPanelChromeProvider } from '@/context/AppShellContext'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import { MainContentPanel } from './MainContentPanel'
import { PANEL_MIN_WIDTH } from './panel-constants'

interface PanelSlotProps {
  entry: PanelStackEntry
  isOnly: boolean
  /** Whether this panel is the focused panel in a multi-panel layout */
  isFocusedPanel: boolean
  isSidebarAndNavigatorHidden: boolean
  stoplightLeadingInset?: number
  /** Flex-grow weight for proportional sizing */
  proportion: number
  /** Optional sash element rendered before this panel */
  sash?: React.ReactNode
  /** Compact (mobile) mode — shows back button in panel header */
  isCompact?: boolean
  /** Hide the per-panel close button when the surrounding workspace owns navigation. */
  hideCloseButton?: boolean
  /** Optional shell action shown at the right edge of the rightmost content panel. */
  rightSidebarButton?: React.ReactNode
  /** Per-layout minimum; defaults to the shared desktop content minimum. */
  minWidth?: number
}

export function PanelSlot({
  entry,
  isOnly,
  isFocusedPanel,
  isSidebarAndNavigatorHidden,
  stoplightLeadingInset,
  proportion,
  sash,
  isCompact,
  hideCloseButton,
  rightSidebarButton,
  minWidth = PANEL_MIN_WIDTH,
}: PanelSlotProps) {
  const { t } = useTranslation()
  const closePanel = useSetAtom(closePanelAtom)
  const setFocusedPanel = useSetAtom(focusedPanelIdAtom)
  const navState = parseRouteToNavigationState(entry.route)

  const handleClose = useCallback(() => {
    closePanel(entry.id)
  }, [closePanel, entry.id])

  // Build close button for PanelHeader (via context override)
  const closeButton = useMemo(() => {
    if (hideCloseButton || isOnly) return undefined
    return (
      <PanelHeaderCenterButton
        icon={<X className="h-4 w-4" />}
        onClick={handleClose}
        tooltip={t("common.close")}
      />
    )
  }, [handleClose, hideCloseButton, isOnly])

  // Build back button for compact mode — closes the panel to reveal the session list.
  // Same PanelHeaderCenterButton style as X and share, just on the left side.
  const backButton = useMemo(() => {
    if (!isCompact) return undefined
    return (
      <PanelHeaderCenterButton
        icon={<ChevronLeft className="h-4 w-4" />}
        onClick={handleClose}
        tooltip={t("common.backToList")}
      />
    )
  }, [isCompact, handleClose])

  // Override panel chrome so ChatPage/PanelHeader gets our per-panel close button,
  // back button (compact mode), and isFocusedPanel for input field appearance
  const panelChrome = useMemo(() => ({
    rightSidebarButton: rightSidebarButton ?? closeButton,
    leadingAction: backButton,
    isFocusedPanel,
  }), [backButton, closeButton, isFocusedPanel, rightSidebarButton])

  const handlePointerDown = useCallback(() => {
    if (!isFocusedPanel) {
      setFocusedPanel(entry.id)
    }
  }, [isFocusedPanel, setFocusedPanel, entry.id])

  return (
    <>
      {sash}
      <div
        onPointerDown={handlePointerDown}
        data-panel-role="content"
        data-compact={isCompact || undefined}
        className="h-full overflow-hidden relative @container/panel bg-background"
        style={{
          // Keep focus feedback local to controls instead of tinting the whole pane.
          ...(!isFocusedPanel && !isOnly
            ? {
                '--shadow-minimal': 'var(--shadow-minimal-flat)',
                '--user-message-bubble': 'var(--user-message-bubble-dimmed)',
              } as React.CSSProperties
            : {}
          ),
          ...(isOnly
            ? { flexGrow: 1, minWidth: isCompact ? 0 : minWidth }
            : { flexGrow: proportion, flexShrink: 1, flexBasis: 0, minWidth }
          ),
        }}
      >
        <div className="h-full flex flex-col">
          <SessionPanelChromeProvider value={panelChrome}>
            <MainContentPanel
              navStateOverride={navState}
              isSidebarAndNavigatorHidden={isSidebarAndNavigatorHidden}
              stoplightLeadingInset={stoplightLeadingInset}
            />
          </SessionPanelChromeProvider>
        </div>
      </div>
    </>
  )
}
