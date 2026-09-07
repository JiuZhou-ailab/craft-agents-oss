import * as React from "react"
import { MENU_CONTENT_STYLES } from "@craft-agent/ui/styled-dropdown"
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuPortal,
} from "./context-menu"
import { cn } from "@/lib/utils"

/**
 * Styled Context Menu Components
 *
 * Pre-styled context menu components matching the StyledDropdownMenu style.
 * These wrap the base context-menu components with consistent styling.
 */

// Re-export unchanged components
export { ContextMenu, ContextMenuTrigger }

// Styled content - matches StyledDropdownMenuContent
interface StyledContextMenuContentProps
  extends React.ComponentPropsWithoutRef<typeof ContextMenuContent> {
  /** Minimum width - defaults to min-w-[180px] */
  minWidth?: string
}

export const StyledContextMenuContent = React.forwardRef<
  React.ComponentRef<typeof ContextMenuContent>,
  StyledContextMenuContentProps
>(({ className, minWidth, ...props }, ref) => (
  <ContextMenuContent
    ref={ref}
    className={cn(
      minWidth,
      className
    )}
    {...props}
  />
))
StyledContextMenuContent.displayName = "StyledContextMenuContent"

// Styled menu item - matches StyledDropdownMenuItem
interface StyledContextMenuItemProps
  extends React.ComponentPropsWithoutRef<typeof ContextMenuItem> {
  /** Destructive variant - red text */
  variant?: "default" | "destructive"
}

export const StyledContextMenuItem = React.forwardRef<
  React.ComponentRef<typeof ContextMenuItem>,
  StyledContextMenuItemProps
>(({ className, variant = "default", ...props }, ref) => (
  <ContextMenuItem
    ref={ref}
    className={cn(
      variant === "destructive" && "text-destructive focus:text-destructive hover:text-destructive [&_svg]:!text-destructive",
      className
    )}
    {...props}
  />
))
StyledContextMenuItem.displayName = "StyledContextMenuItem"

// Styled separator - matches StyledDropdownMenuSeparator
export const StyledContextMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof ContextMenuSeparator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuSeparator>
>(({ className, ...props }, ref) => (
  <ContextMenuSeparator
    ref={ref}
    className={className}
    {...props}
  />
))
StyledContextMenuSeparator.displayName = "StyledContextMenuSeparator"

// Re-export Sub for submenus
export { ContextMenuSub as StyledContextMenuSub }

// Styled sub-menu trigger - matches StyledDropdownMenuSubTrigger
export const StyledContextMenuSubTrigger = React.forwardRef<
  React.ComponentRef<typeof ContextMenuSubTrigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuSubTrigger>
>(({ className, ...props }, ref) => (
  <ContextMenuSubTrigger
    ref={ref}
    className={cn(
      "pr-[8px]",
      className
    )}
    {...props}
  />
))
StyledContextMenuSubTrigger.displayName = "StyledContextMenuSubTrigger"

// Styled sub-menu content - matches StyledDropdownMenuSubContent
interface StyledContextMenuSubContentProps
  extends React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent> {
  /** Minimum width - defaults to min-w-[180px] */
  minWidth?: string
}

export const StyledContextMenuSubContent = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.SubContent>,
  StyledContextMenuSubContentProps
>(({ className, minWidth, sideOffset = -4, ...props }, ref) => (
  <ContextMenuPortal>
    <ContextMenuPrimitive.SubContent
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "popover-styled z-dropdown overflow-hidden",
        MENU_CONTENT_STYLES,
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        minWidth,
        className
      )}
      {...props}
    />
  </ContextMenuPortal>
))
StyledContextMenuSubContent.displayName = "StyledContextMenuSubContent"
