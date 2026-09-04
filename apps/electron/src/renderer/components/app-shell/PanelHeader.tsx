// input: Panel title metadata, title alignment, optional title menus, leading controls, and right-side actions
// output: Accessible centered or leading panel header chrome shared by app shell panels
// pos: Common header layout primitive for renderer panels

/**
 * PanelHeader - Standardized header component for panels
 *
 * Provides consistent header styling with:
 * - Fixed 42px height
 * - Title with optional badge
 * - Optional action buttons
 * - Optional title dropdown menu with an independent overflow trigger
 * - Automatic padding compensation for macOS traffic lights (via StoplightContext)
 *
 * Usage:
 * ```tsx
 * <PanelHeader
 *   title="Conversations"
 *   actions={<Button>Add</Button>}
 * />
 *
 * // With interactive title menu:
 * <PanelHeader
 *   title="Chat Name"
 *   titleMenu={<><MenuItem>Rename</MenuItem><MenuItem>Delete</MenuItem></>}
 * />
 * ```
 *
 * The header automatically compensates for macOS traffic lights when rendered
 * inside a StoplightProvider (e.g., in MainContentPanel during focused mode).
 * You can also explicitly control this with the `compensateForStoplight` prop.
 */

import * as React from 'react'
import { useState } from 'react'
import { motion } from 'motion/react'
import { MoreHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCompensateForStoplight } from '@/context/StoplightContext'
import { PANEL_SPRING } from './panel-constants'
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { StyledDropdownMenuContent } from '@/components/ui/styled-dropdown'

// Padding to compensate for macOS traffic lights (stoplight buttons)
// Traffic lights positioned at x:18, ~52px wide = 70px + 14px gap
const STOPLIGHT_PADDING = 84

export interface PanelHeaderProps {
  /** Header title (undefined hides with animation) */
  title?: string
  /** Optional badge element (e.g., agent badge) */
  badge?: React.ReactNode
  /** Optional dropdown menu content rendered from an independent overflow trigger */
  titleMenu?: React.ReactNode
  /** Title alignment; defaults to centered for existing panel layouts */
  titleAlign?: 'start' | 'center'
  /** Optional leading action rendered before the title (e.g., back button in compact mode) */
  leadingAction?: React.ReactNode
  /** Optional center button rendered between title and right actions */
  centerButton?: React.ReactNode
  /** Optional action buttons rendered on the right */
  actions?: React.ReactNode
  /** Optional right sidebar button (rendered after actions) */
  rightSidebarButton?: React.ReactNode
  /** When true, animates left margin to avoid macOS traffic lights (use when this is the first panel on screen) */
  compensateForStoplight?: boolean
  /** Left padding override (e.g., for focused mode with traffic lights) */
  paddingLeft?: string
  /** Optional className for additional styling */
  className?: string
  /** Whether title is being regenerated (shows shimmer effect) */
  isRegeneratingTitle?: boolean
}

/**
 * Standardized panel header with title and actions
 */
export function PanelHeader({
  title,
  badge,
  titleMenu,
  titleAlign = 'center',
  leadingAction,
  centerButton,
  actions,
  rightSidebarButton,
  compensateForStoplight,
  paddingLeft,
  className,
  isRegeneratingTitle,
}: PanelHeaderProps) {
  // Use context as fallback when prop is not explicitly set.
  // Skip stoplight compensation when leadingAction is present — the back button
  // occupies the space where traffic lights would be.
  const contextCompensate = useCompensateForStoplight()
  const shouldCompensate = leadingAction ? false : (compensateForStoplight ?? contextCompensate)

  // Controlled dropdown state keeps the trigger styling in sync with Radix.
  const [dropdownOpen, setDropdownOpen] = useState(false)

  // Shimmer effect shows during title regeneration.
  const titleContent = (
    <motion.div
      initial={false}
      animate={{ opacity: title ? 1 : 0 }}
      transition={{ duration: 0.15 }}
      className={cn(
        'flex min-w-0 items-center gap-1',
        titleAlign === 'start' ? 'justify-start' : 'justify-center',
      )}
    >
      <h1 className={cn(
        'min-w-0 truncate text-[13px] font-medium leading-none',
        titleAlign === 'start' ? 'text-left' : 'text-center',
        isRegeneratingTitle && 'animate-shimmer-text',
      )}>{title}</h1>
      {badge}
    </motion.div>
  )

  const titleBlock = (
    <div className="flex min-w-0 max-w-full items-center select-none">
      {titleContent}
      {titleMenu && (
        <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={title}
              className={cn(
                'titlebar-no-drag ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
                'text-muted-foreground transition-colors hover:bg-foreground/[0.03] hover:text-foreground',
                'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                dropdownOpen && 'bg-foreground/[0.03] text-foreground',
              )}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <StyledDropdownMenuContent align={titleAlign === 'start' ? 'start' : 'center'} sideOffset={8}>
            {titleMenu}
          </StyledDropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )

  const content = (
    <div className={cn(
      'grid w-full min-w-0 items-center gap-1.5',
      titleAlign === 'start'
        ? 'grid-cols-[minmax(0,1fr)_auto]'
        : 'grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(0,1fr)]',
    )}>
      <div className="min-w-0 w-fit justify-self-start flex items-center">
        {leadingAction}
        {titleAlign === 'start' && titleBlock}
      </div>
      {titleAlign === 'center' && (
        <div className="min-w-0 flex items-center justify-center">
          {titleBlock}
        </div>
      )}
      <div className="titlebar-no-drag min-w-0 w-fit justify-self-end flex items-center gap-1">
        {centerButton}
        {actions}
        {rightSidebarButton}
      </div>
    </div>
  )

  // Base padding (16px = pl-4, matches pr-2 when leading action present for symmetry)
  const basePadding = leadingAction ? 8 : 16

  const baseClassName = cn(
    'titlebar-drag-region flex shrink-0 items-center pr-2 min-w-0 gap-1.5 relative z-panel h-[42px] border-b border-foreground/[0.06]',
    // Only use static paddingLeft class when not animating
    !shouldCompensate && (paddingLeft || (leadingAction ? 'pl-2' : 'pl-4')),
    className
  )

  // Use motion.div with animated paddingLeft to shift content while keeping background full-width
  return (
    <motion.div
      initial={false}
      animate={{
        paddingLeft: shouldCompensate
          ? `var(--panel-header-leading-inset, ${STOPLIGHT_PADDING}px)`
          : basePadding,
      }}
      transition={PANEL_SPRING}
      className={baseClassName}
    >
      {content}
    </motion.div>
  )
}
