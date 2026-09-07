// input: Pinned shell columns, content panel state, title inset, optional shell action, minimum width, and resize sash
// output: Continuous horizontal workbench with one scrollable content lane
// pos: Parent layout owner for navigator, content panes, and their shared seams

/**
 * PanelStackContainer
 *
 * Horizontal layout container for shell columns and content panels:
 * Sidebar → Navigator → horizontally scrollable Content Panel(s).
 *
 * Content panels use CSS flex-grow with their proportions as weights:
 * - Each panel gets `flex: <proportion> 1 0px` with the layout's content minimum
 * - Flex distributes available space proportionally — panels fill the viewport
 * - When panels hit min-width, overflow-x: auto kicks in naturally
 *
 * Sidebar and Navigator are NOT part of the proportional or horizontal-scroll layout.
 * They have fixed/user-resizable widths managed by AppShell and stay pinned while
 * the content panel lane scrolls.
 *
 * The right sidebar stays OUTSIDE this container.
 */

import { useRef, useEffect } from 'react'
import { useAtomValue } from 'jotai'
import { motion } from 'motion/react'
import { panelStackAtom, focusedPanelIdAtom, focusedRouteHasSelectedContentAtom } from '@/atoms/panel-stack'
import { PanelSlot } from './PanelSlot'
import { PanelResizeSash } from './PanelResizeSash'
import {
  PANEL_GAP,
  PANEL_SPRING,
} from './panel-constants'

interface PanelStackContainerProps {
  sidebarSlot: React.ReactNode
  sidebarWidth: number
  navigatorSlot: React.ReactNode
  navigatorWidth: number
  navigatorResizeSash?: React.ReactNode
  isSidebarAndNavigatorHidden: boolean
  stoplightLeadingInset?: number
  /** Compact mode: single-panel, list/content toggle (mobile or narrow window) */
  isCompact?: boolean
  isResizing?: boolean
  hidePanelCloseButton?: boolean
  rightSidebarButton?: React.ReactNode
  contentPanelMinWidth?: number
}

export function PanelStackContainer({
  sidebarSlot,
  sidebarWidth,
  navigatorSlot,
  navigatorWidth,
  navigatorResizeSash,
  isSidebarAndNavigatorHidden,
  stoplightLeadingInset,
  isCompact = false,
  isResizing,
  hidePanelCloseButton,
  rightSidebarButton,
  contentPanelMinWidth,
}: PanelStackContainerProps) {
  const panelStack = useAtomValue(panelStackAtom)
  const focusedPanelId = useAtomValue(focusedPanelIdAtom)
  const focusedRouteHasSelectedContent = useAtomValue(focusedRouteHasSelectedContentAtom)

  const contentPanels = panelStack

  // Compact mode: show list OR content based on the focused panel's ROUTE,
  // not just whether a panel exists. When the route has a session selected
  // (e.g., allSessions/session/abc), show content. When on a list view
  // (e.g., allSessions), show navigator. This allows back-navigation to
  // return to the session list.
  const hasSelectedContent = isCompact && focusedRouteHasSelectedContent
  const visiblePanels = isCompact
    ? contentPanels.filter(e => e.id === focusedPanelId).slice(0, 1)
    : contentPanels

  const scrollRef = useRef<HTMLDivElement>(null)
  const prevCountRef = useRef(contentPanels.length)

  const hasSidebar = sidebarWidth > 0
  // In compact mode, hide navigator when content is selected (show list OR content, not both)
  const hasNavigator = isCompact ? (navigatorWidth > 0 && !hasSelectedContent) : navigatorWidth > 0
  const isMultiPanel = visiblePanels.length > 1

  // Auto-scroll to newly pushed content panel
  useEffect(() => {
    if (contentPanels.length > prevCountRef.current && scrollRef.current) {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({
          left: scrollRef.current.scrollWidth,
          behavior: isCompact ? 'instant' : 'smooth',
        })
      })
    }
    prevCountRef.current = contentPanels.length
  }, [contentPanels.length, isCompact])

  const transition = (isResizing || isCompact) ? { duration: 0 } : PANEL_SPRING

  return (
    <div
      className="flex-1 min-w-0 flex relative z-panel @container/shell"
      style={{
        overflowX: 'hidden',
        overflowY: 'hidden',
      }}
    >
      {/* Inner flex container keeps shell columns pinned. Only the content lane scrolls. */}
      <div
        className="flex h-full min-w-0 flex-1"
        style={{ gap: PANEL_GAP, flexGrow: 1, minWidth: 0 }}
      >
        {/* === SIDEBAR SLOT === */}
        <motion.div
          data-panel-role="sidebar"
          initial={false}
          animate={{
            width: hasSidebar ? sidebarWidth : 0,
            opacity: hasSidebar ? 1 : 0,
          }}
          transition={transition}
          className="h-full relative shrink-0"
          style={{ overflowX: 'clip', overflowY: 'visible' }}
        >
          <div className="h-full" style={{ width: sidebarWidth }}>
            {sidebarSlot}
          </div>
        </motion.div>

        {/* === NAVIGATOR SLOT === */}
        <motion.div
          data-panel-role="navigator"
          initial={false}
          animate={{
            width: hasNavigator ? navigatorWidth : 0,
            opacity: hasNavigator ? 1 : 0,
          }}
          transition={transition}
          className="h-full overflow-hidden relative shrink-0 z-[2] bg-background"
          style={{
            // In compact mode (no content selected), navigator fills available space
            ...(isCompact && hasNavigator && !hasSelectedContent ? { flex: '1 1 auto' } : {}),
          }}
        >
          <div className="h-full" style={{ width: isCompact && hasNavigator && !hasSelectedContent ? '100%' : navigatorWidth }}>
            {navigatorSlot}
          </div>
        </motion.div>

        {hasNavigator ? navigatorResizeSash : null}

        <div
          data-panel-role="content-scroll"
          ref={scrollRef}
          className="min-w-0 flex-1 flex panel-scroll"
          style={{
            overflowX: 'auto',
            overflowY: 'hidden',
          }}
        >
          <div className="flex h-full min-w-full" style={{ gap: PANEL_GAP, flexGrow: 1, minWidth: 0 }}>
            {/* === CONTENT PANELS WITH SASHES === */}
            {visiblePanels.length === 0 ? (
              // Only show empty placeholder when not in compact mode (compact shows navigator instead)
              isCompact ? null : <div className="flex-1 flex items-center justify-center" />
            ) : (
              visiblePanels.map((entry, index) => (
                <PanelSlot
                  key={entry.id}
                  entry={entry}
                  isOnly={visiblePanels.length === 1}
                  isFocusedPanel={isMultiPanel ? entry.id === focusedPanelId : true}
                  isSidebarAndNavigatorHidden={isSidebarAndNavigatorHidden && index === 0}
                  stoplightLeadingInset={index === 0 ? stoplightLeadingInset : undefined}
                  proportion={entry.proportion}
                  isCompact={isCompact}
                  hideCloseButton={hidePanelCloseButton}
                  rightSidebarButton={index === visiblePanels.length - 1 ? rightSidebarButton : undefined}
                  minWidth={contentPanelMinWidth}
                  sash={index > 0 ? (
                    <PanelResizeSash
                      leftIndex={index - 1}
                      rightIndex={index}
                    />
                  ) : undefined}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
