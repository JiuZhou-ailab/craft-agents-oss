// input: Slash-triggered command, skill, and working-directory choices for chat input
// output: Inline and button slash menus plus helpers for applying selected slash actions
// pos: Command discovery layer for the app-shell composer

import * as React from 'react'
import { useTranslation } from "react-i18next"
import { Command as CommandPrimitive } from 'cmdk'
import { Check, Minimize2, Zap } from 'lucide-react'
import { Icon_Folder } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import { PERMISSION_MODE_CONFIG, PERMISSION_MODE_ORDER, type PermissionMode } from '@craft-agent/shared/agent/modes'
import type { LoadedSkill } from '../../../shared/types'

// ============================================================================
// Types
// ============================================================================

export type SlashCommandId = PermissionMode | 'compact'

/** Union type for all item types in the slash menu */
export type SlashItemType = 'command' | 'skill' | 'folder'

export interface SlashCommand {
  id: SlashCommandId
  label: string
  description: string
  icon: React.ReactNode
  searchText?: string
  shortcut?: string
  /** Optional color for the command (hex color string) */
  color?: string
}

/** Folder item for the slash menu */
export interface SlashFolderItem {
  id: string
  type: 'folder'
  label: string
  description: string
  path: string
  searchText?: string
}

/** Skill item for the slash menu */
export interface SlashSkillItem {
  id: string
  type: 'skill'
  label: string
  description?: string
  searchText?: string
  skill: LoadedSkill
}

type SlashItem = SlashCommand | SlashSkillItem | SlashFolderItem

/** Section with header for the inline slash menu */
export interface SlashSection {
  id: string
  label: string
  items: SlashItem[]
}

export interface CommandGroup {
  id: string
  commands: SlashCommand[]
}

// ============================================================================
// Permission Mode Icon Component
// ============================================================================

interface PermissionModeIconProps {
  mode: PermissionMode
  className?: string
}

function PermissionModeIcon({ mode, className }: PermissionModeIconProps) {
  const config = PERMISSION_MODE_CONFIG[mode]
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={config.svgPath} />
    </svg>
  )
}

// ============================================================================
// Default Commands
// ============================================================================

// Icon size constant
const MENU_ICON_SIZE = 'h-3.5 w-3.5'

// Generate permission mode commands from centralized config
const permissionModeCommands: SlashCommand[] = PERMISSION_MODE_ORDER.map(mode => {
  const config = PERMISSION_MODE_CONFIG[mode]
  return {
    id: mode,
    label: config.displayName,
    description: config.description,
    icon: <PermissionModeIcon mode={mode} className={MENU_ICON_SIZE} />,
  }
})

const compactCommand: SlashCommand = {
  id: 'compact',
  label: 'Compact Context',
  description: 'Summarize conversation context to free up token budget',
  icon: <Minimize2 className={MENU_ICON_SIZE} />,
}

export const DEFAULT_SLASH_COMMANDS: SlashCommand[] = [
  ...permissionModeCommands,
  compactCommand,
]

export const DEFAULT_SLASH_COMMAND_GROUPS: CommandGroup[] = [
  { id: 'modes', commands: permissionModeCommands },
]

function buildSlashItemSearchText(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ').toLowerCase()
}

export function createSlashSkillItems(skills: LoadedSkill[]): SlashSkillItem[] {
  return skills.map(skill => ({
    id: skill.slug,
    type: 'skill' as const,
    label: skill.metadata.displayName ?? skill.metadata.name,
    description: skill.metadata.description,
    searchText: buildSlashItemSearchText(skill.metadata.displayName ?? skill.metadata.name, skill.slug, skill.metadata.description),
    skill,
  }))
}

export function getSlashSkillInsertionText(skill: LoadedSkill): string {
  return `[skill:${skill.slug}] `
}

export function replaceSlashSkillSelection(
  value: string,
  slashStart: number,
  cursorPosition: number,
  skill: LoadedSkill,
): { value: string; cursorPosition: number } {
  const prompt = `${value.slice(0, slashStart)}${value.slice(cursorPosition)}`
    .replace(/\[skill:[^\]]+\]\s*/g, '')
    .trim()
  const nextValue = `${getSlashSkillInsertionText(skill)}${prompt}`
  return { value: nextValue, cursorPosition: nextValue.length }
}

// ============================================================================
// Shared Styles
// ============================================================================

const MENU_CONTAINER_STYLE = 'min-w-[200px] overflow-hidden rounded-[8px] bg-foreground-5 text-foreground shadow-modal-small ring-1 ring-foreground/10'
const MENU_LIST_STYLE = 'max-h-[260px] overflow-y-auto py-1'
const MENU_ITEM_STYLE = 'flex cursor-pointer select-none items-center gap-2 rounded-[6px] mx-1 px-2 py-1.5 text-[13px]'
const INLINE_MENU_CONTAINER_STYLE = 'overflow-hidden rounded-[16px] border border-border/70 bg-foreground-5 text-foreground shadow-modal-small'
const INLINE_MENU_LIST_STYLE = 'min-h-0 overflow-y-auto p-2'
const INLINE_MENU_ITEM_STYLE = 'flex min-h-9 cursor-pointer select-none items-center gap-2.5 rounded-[10px] px-3 py-2 text-[13px] leading-5 outline-none'
const INLINE_MENU_ITEM_SELECTED = 'bg-foreground/[0.06]'

// ============================================================================
// Shared: Filter utilities
// ============================================================================

function filterCommands(commands: SlashCommand[], filter: string): SlashCommand[] {
  if (!filter) return commands
  const lowerFilter = filter.toLowerCase()
  return commands.filter(
    cmd =>
      cmd.label.toLowerCase().includes(lowerFilter) ||
      cmd.id.toLowerCase().includes(lowerFilter)
  )
}

/** Check if an item is a folder */
function isFolder(item: SlashItem): item is SlashFolderItem {
  return 'type' in item && item.type === 'folder'
}

function isSkill(item: SlashItem): item is SlashSkillItem {
  return 'type' in item && item.type === 'skill'
}

function slashItemMatchesFilter(item: SlashItem, lowerFilter: string): boolean {
  if (item.searchText) return item.searchText.includes(lowerFilter)
  return buildSlashItemSearchText(item.label, item.id, item.description).includes(lowerFilter)
}

export function hasMatchingSlashItems(sections: SlashSection[], filter: string): boolean {
  if (!filter) return sections.some(section => section.items.length > 0)
  const lowerFilter = filter.toLowerCase()
  return sections.some(section =>
    section.items.some(item => slashItemMatchesFilter(item, lowerFilter))
  )
}

/** Filter sections by label/id, keeping sections grouped */
function filterSections(sections: SlashSection[], filter: string): SlashSection[] {
  if (!filter) return sections
  const lowerFilter = filter.toLowerCase()

  // Filter items within each section, keeping section structure
  return sections
    .map(section => ({
      ...section,
      items: section.items.filter(item => slashItemMatchesFilter(item, lowerFilter)),
    }))
    .filter(section => section.items.length > 0)
}

/** Flatten sections into a single array of items */
function flattenSections(sections: SlashSection[]): SlashItem[] {
  return sections.flatMap(section => section.items)
}

// ============================================================================
// Shared: Command Item Content
// ============================================================================

const MODE_COMMAND_IDS = new Set<string>(['safe', 'ask', 'allow-all'])
const MODE_COMMAND_DESCRIPTION_KEYS: Partial<Record<SlashCommandId, string>> = {
  safe: 'mode.exploreFullDesc',
  ask: 'mode.askFullDesc',
  'allow-all': 'mode.executeFullDesc',
}

function CommandItemContent({
  command,
  isActive,
  showDescription = false,
}: {
  command: SlashCommand
  isActive: boolean
  showDescription?: boolean
}) {
  const { t } = useTranslation()
  const label = MODE_COMMAND_IDS.has(command.id) ? t(`mode.${command.id}`, command.label) : command.label
  const descriptionKey = MODE_COMMAND_DESCRIPTION_KEYS[command.id]
  const description = descriptionKey ? t(descriptionKey, command.description) : command.description
  return (
    <>
      <div className="shrink-0 text-muted-foreground">{command.icon}</div>
      <div className="min-w-0 flex-1 truncate">
        <span className={cn(showDescription && 'font-medium')}>{label}</span>
        {showDescription && (
          <span className="ml-1.5 text-muted-foreground">{description}</span>
        )}
      </div>
      {isActive && (
        <div className="shrink-0 size-3 rounded-full bg-blue-500 flex items-center justify-center">
          <Check className="size-2 text-white" strokeWidth={3} />
        </div>
      )}
    </>
  )
}

function SkillItemContent({ item }: { item: SlashSkillItem }) {
  return (
    <>
      <div className="shrink-0 text-muted-foreground">
        <Zap className={MENU_ICON_SIZE} strokeWidth={1.75} />
      </div>
      <div className="flex-1 min-w-0 truncate">
        <span className="font-medium">{item.label}</span>
        {item.description && <span className="text-muted-foreground ml-1.5">{item.description}</span>}
      </div>
    </>
  )
}

// ============================================================================
// SlashCommandMenu Component (Button-triggered popup)
// ============================================================================

export interface SlashCommandMenuProps {
  /** Flat list of commands (use this OR commandGroups, not both) */
  commands?: SlashCommand[]
  /** Grouped commands with separators between groups */
  commandGroups?: CommandGroup[]
  activeCommands?: SlashCommandId[]
  onSelect: (commandId: SlashCommandId) => void
  showFilter?: boolean
  filterPlaceholder?: string
  className?: string
}

export function SlashCommandMenu({
  commands,
  commandGroups,
  activeCommands = [],
  onSelect,
  showFilter = false,
  filterPlaceholder,
  className,
}: SlashCommandMenuProps) {
  const { t } = useTranslation()
  const effectiveFilterPlaceholder = filterPlaceholder ?? t("commands.searchCommands")
  const [filter, setFilter] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  // If groups provided, filter within each group; otherwise use flat commands
  const filteredGroups = React.useMemo(() => {
    if (commandGroups) {
      return commandGroups.map(group => ({
        ...group,
        commands: filterCommands(group.commands, filter),
      })).filter(group => group.commands.length > 0)
    }
    return null
  }, [commandGroups, filter])

  const filteredCommands = React.useMemo(() => {
    if (commands && !commandGroups) {
      return filterCommands(commands, filter)
    }
    return null
  }, [commands, commandGroups, filter])

  // Get all commands for defaultValue calculation
  const allFilteredCommands = filteredGroups
    ? filteredGroups.flatMap(g => g.commands)
    : (filteredCommands ?? [])

  // Default to the first active command, or first command if none active
  const defaultValue = activeCommands[0] ?? allFilteredCommands[0]?.id

  React.useEffect(() => {
    // Don't auto-focus the filter on touch devices — it pulls up the virtual keyboard
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0
    if (showFilter && inputRef.current && !isTouchDevice) {
      inputRef.current.focus()
    }
  }, [showFilter])

  if (allFilteredCommands.length === 0 && !showFilter) return null

  // Render a single command item
  const renderCommandItem = (cmd: SlashCommand) => {
    const isActive = activeCommands.includes(cmd.id)
    return (
      <CommandPrimitive.Item
        key={cmd.id}
        value={cmd.id}
        onSelect={() => onSelect(cmd.id)}
        data-tutorial={`permission-mode-${cmd.id}`}
        className={cn(
          MENU_ITEM_STYLE,
          'outline-none',
          'data-[selected=true]:bg-foreground/10'
        )}
      >
        <CommandItemContent command={cmd} isActive={isActive} />
      </CommandPrimitive.Item>
    )
  }

  return (
    <CommandPrimitive
      className={cn(MENU_CONTAINER_STYLE, className)}
      shouldFilter={false}
      defaultValue={defaultValue}
    >
      {showFilter && (
        <div className="border-b border-border/50 px-3 py-2">
          <CommandPrimitive.Input
            ref={inputRef}
            value={filter}
            onValueChange={setFilter}
            placeholder={effectiveFilterPlaceholder}
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      )}
      <CommandPrimitive.List className={MENU_LIST_STYLE}>
        {allFilteredCommands.length === 0 ? (
          <CommandPrimitive.Empty className="py-4 text-center text-sm text-muted-foreground">
            No commands found
          </CommandPrimitive.Empty>
        ) : filteredGroups ? (
          // Group-based rendering with smart separators
          filteredGroups.map((group, groupIndex) => (
            <React.Fragment key={group.id}>
              {group.commands.map(renderCommandItem)}
              {/* Separator: only show if there's another group after this one */}
              {groupIndex < filteredGroups.length - 1 && (
                <div className="h-px bg-border/50 my-1 mx-2" />
              )}
            </React.Fragment>
          ))
        ) : (
          // Flat list rendering
          filteredCommands?.map(renderCommandItem)
        )}
      </CommandPrimitive.List>
    </CommandPrimitive>
  )
}

// ============================================================================
// InlineSlashCommand - Autocomplete that follows cursor
// ============================================================================

export interface InlineSlashCommandProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sections: SlashSection[]
  activeCommands?: SlashCommandId[]
  onSelectCommand: (commandId: SlashCommandId) => void
  onSelectSkill: (skill: LoadedSkill) => void
  onSelectFolder: (path: string) => void
  filter?: string
  position: { x: number; y: number }
  anchorRef?: React.RefObject<HTMLElement | null>
  listboxId: string
  onActiveDescendantChange?: (id: string | undefined) => void
  className?: string
}

export function InlineSlashCommand({
  open,
  onOpenChange,
  sections,
  activeCommands = [],
  onSelectCommand,
  onSelectSkill,
  onSelectFolder,
  filter = '',
  position,
  anchorRef,
  listboxId,
  onActiveDescendantChange,
  className,
}: InlineSlashCommandProps) {
  const menuRef = React.useRef<HTMLDivElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const filteredSections = React.useMemo(
    () => filterSections(sections, filter),
    [sections, filter]
  )
  const flatItems = React.useMemo(
    () => flattenSections(filteredSections),
    [filteredSections]
  )

  // Reset selection when filter changes
  React.useEffect(() => {
    setSelectedIndex(0)
  }, [filter])

  // Scroll selected item into view
  React.useEffect(() => {
    if (!listRef.current) return
    const selectedEl = listRef.current.querySelector('[data-selected="true"]')
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  React.useEffect(() => {
    onActiveDescendantChange?.(
      open && flatItems[selectedIndex] ? `${listboxId}-option-${selectedIndex}` : undefined,
    )
  }, [flatItems, listboxId, onActiveDescendantChange, open, selectedIndex])

  // Handle item selection
  const handleSelect = React.useCallback((item: SlashItem) => {
    if (isFolder(item)) {
      onSelectFolder(item.path)
    } else if (isSkill(item)) {
      onSelectSkill(item.skill)
    } else {
      onSelectCommand(item.id)
    }
    onOpenChange(false)
  }, [onSelectCommand, onSelectSkill, onSelectFolder, onOpenChange])

  // Keyboard navigation
  // Don't attach listener when no items - allows Enter to propagate to input handler
  React.useEffect(() => {
    if (!open || flatItems.length === 0) return

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex(prev => (prev < flatItems.length - 1 ? prev + 1 : 0))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex(prev => (prev > 0 ? prev - 1 : flatItems.length - 1))
          break
        case 'Enter':
        case 'Tab':
          e.preventDefault()
          if (flatItems[selectedIndex]) {
            handleSelect(flatItems[selectedIndex])
          }
          break
        case 'Escape':
          e.preventDefault()
          onOpenChange(false)
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, flatItems, selectedIndex, handleSelect, onOpenChange])

  // Close on click outside
  React.useEffect(() => {
    if (!open) return

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onOpenChange(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open, onOpenChange])

  // Hide if no results or not open
  if (!open || flatItems.length === 0) return null

  const anchorRect = anchorRef?.current?.getBoundingClientRect()
  const bottomPosition = typeof window !== 'undefined'
    ? window.innerHeight - Math.round(anchorRect?.top ?? position.y) + 8
    : 0

  return (
    <div
      ref={menuRef}
      data-inline-menu
      className={cn('fixed z-dropdown flex flex-col', INLINE_MENU_CONTAINER_STYLE, className)}
      style={anchorRect ? {
        left: Math.round(anchorRect.left),
        bottom: bottomPosition,
        width: Math.round(anchorRect.width),
        maxHeight: Math.min(560, Math.max(160, Math.round(anchorRect.top) - 16)),
      } : {
        left: Math.round(position.x) - 10,
        bottom: bottomPosition,
        minWidth: 220,
        maxWidth: 260,
      }}
    >
      <div id={listboxId} ref={listRef} className={INLINE_MENU_LIST_STYLE} role="listbox">
        {flatItems.map((item, itemIndex) => {
          const isSelected = itemIndex === selectedIndex
          return (
            <div
              key={`${isFolder(item) ? 'folder' : isSkill(item) ? 'skill' : 'command'}:${item.id}`}
              id={`${listboxId}-option-${itemIndex}`}
              role="option"
              aria-selected={isSelected}
              data-selected={isSelected}
              onClick={() => handleSelect(item)}
              onMouseEnter={() => setSelectedIndex(itemIndex)}
              className={cn(
                INLINE_MENU_ITEM_STYLE,
                isSelected && INLINE_MENU_ITEM_SELECTED,
              )}
            >
              {isFolder(item) ? (
                <>
                  <div className="shrink-0 text-muted-foreground">
                    <Icon_Folder className={MENU_ICON_SIZE} strokeWidth={1.75} />
                  </div>
                  <div className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{item.label}</span>
                    <span className="ml-1.5 text-muted-foreground">{item.description}</span>
                  </div>
                </>
              ) : isSkill(item) ? (
                <SkillItemContent item={item} />
              ) : (
                <CommandItemContent
                  command={item}
                  isActive={activeCommands.includes(item.id)}
                  showDescription
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ============================================================================
// Hook for managing inline slash command state
// ============================================================================

/** Interface for elements that can be used with useInlineSlashCommand */
export interface SlashCommandInputElement {
  getBoundingClientRect: () => DOMRect
  getCaretRect?: () => DOMRect | null
  value: string
  selectionStart: number
}

/**
 * Format path for display, shortening home directory
 */
function formatPathForDisplay(path: string, homeDir?: string): string {
  if (homeDir && path.startsWith(homeDir)) {
    return '~' + path.slice(homeDir.length)
  }
  return path
}

/**
 * Get folder name from path
 */
function getFolderName(path: string): string {
  return path.split('/').pop() || path
}

export function createSlashFolderItems(recentFolders: string[], homeDir?: string): SlashFolderItem[] {
  return recentFolders
    .map(path => {
      const label = getFolderName(path)
      const description = formatPathForDisplay(path, homeDir)
      return {
        item: {
          id: path,
          type: 'folder' as const,
          label,
          description,
          path,
          searchText: buildSlashItemSearchText(label, path, description),
        },
        sortLabel: label.toLowerCase(),
      }
    })
    .sort((a, b) => a.sortLabel.localeCompare(b.sortLabel))
    .map(({ item }) => item)
}

export function parseInlineSlashCommandQuery(textBeforeCursor: string): { start: number; filter: string } | null {
  const slashMatch = textBeforeCursor.match(/(?:^|\s|[^\x00-\x7F])\/([\p{L}\p{N}\p{M}_\-.]{0,100})$/u)
  if (!slashMatch) return null

  return {
    start: textBeforeCursor.lastIndexOf('/'),
    filter: slashMatch[1] || '',
  }
}

export interface UseInlineSlashCommandOptions {
  /** Ref to input element (textarea or RichTextInput handle) */
  inputRef: React.RefObject<SlashCommandInputElement | null>
  onSelectCommand: (commandId: SlashCommandId) => void
  onSelectSkill?: (skill: LoadedSkill) => void
  onSelectFolder: (path: string) => void
  activeCommands?: SlashCommandId[]
  skills?: LoadedSkill[]
  recentFolders?: string[]
  homeDir?: string
}

export interface UseInlineSlashCommandReturn {
  isOpen: boolean
  filter: string
  position: { x: number; y: number }
  sections: SlashSection[]
  handleInputChange: (value: string, cursorPosition: number) => void
  close: () => void
  activeCommands: SlashCommandId[]
  handleSelectCommand: (commandId: SlashCommandId) => string
  handleSelectSkill: (skill: LoadedSkill) => { value: string; cursorPosition: number }
  handleSelectFolder: (path: string) => string
}

export function useInlineSlashCommand({
  inputRef,
  onSelectCommand,
  onSelectSkill,
  onSelectFolder,
  activeCommands = [],
  skills = [],
  recentFolders = [],
  homeDir,
}: UseInlineSlashCommandOptions): UseInlineSlashCommandReturn {
  const [isOpen, setIsOpen] = React.useState(false)
  const [filter, setFilter] = React.useState('')
  const [position, setPosition] = React.useState({ x: 0, y: 0 })
  const [slashStart, setSlashStart] = React.useState(-1)
  // Store current input state for handleSelect
  const currentInputRef = React.useRef({ value: '', cursorPosition: 0 })

  // Build sections from commands and folders
  const sections = React.useMemo((): SlashSection[] => {
    const result: SlashSection[] = []

    // Modes section
    result.push({
      id: 'modes',
      label: 'Modes',
      items: permissionModeCommands,
    })

    // Commands section
    result.push({
      id: 'commands',
      label: 'Commands',
      items: [compactCommand],
    })

    const skillItems = createSlashSkillItems(skills)
    if (skillItems.length > 0) {
      result.push({
        id: 'skills',
        label: 'Skills',
        items: skillItems,
      })
    }

    // Recent folders section - sorted alphabetically by folder name, show all
    if (recentFolders.length > 0) {
      result.push({
        id: 'folders',
        label: 'Recent Working Directories',
        items: createSlashFolderItems(recentFolders, homeDir),
      })
    }

    return result
  }, [skills, recentFolders, homeDir])

  const handleInputChange = React.useCallback((value: string, cursorPosition: number) => {
    // Store current state for handleSelect
    currentInputRef.current = { value, cursorPosition }

    const textBeforeCursor = value.slice(0, cursorPosition)
    const slashQuery = parseInlineSlashCommandQuery(textBeforeCursor)

    if (slashQuery) {
      const filterText = slashQuery.filter
      // Check if there are any filtered results before opening menu
      // This ensures Enter key works normally when no matches exist
      if (!hasMatchingSlashItems(sections, filterText)) {
        // No results after filtering - close menu to allow normal Enter handling
        setIsOpen(false)
        setFilter('')
        setSlashStart(-1)
        return
      }

      setSlashStart(slashQuery.start)
      setFilter(filterText)

      if (inputRef.current) {
        // Try to get actual caret position from the input element
        const caretRect = inputRef.current.getCaretRect?.()

        if (caretRect && caretRect.x > 0) {
          // Use actual caret position
          setPosition({
            x: caretRect.x,
            y: caretRect.y,
          })
        } else {
          // Fallback: position at input element's left edge
          const rect = inputRef.current.getBoundingClientRect()
          const lineHeight = 20
          const linesBeforeCursor = textBeforeCursor.split('\n').length - 1
          setPosition({
            x: rect.left,
            y: rect.top + (linesBeforeCursor + 1) * lineHeight,
          })
        }
      }

      setIsOpen(true)
    } else {
      setIsOpen(false)
      setFilter('')
      setSlashStart(-1)
    }
  }, [inputRef, sections])

  const handleSelectCommand = React.useCallback((commandId: SlashCommandId): string => {
    // Capture values BEFORE any state changes to avoid race conditions
    let result = ''
    if (slashStart >= 0) {
      const { value: currentValue, cursorPosition } = currentInputRef.current
      const before = currentValue.slice(0, slashStart)
      const after = currentValue.slice(cursorPosition)
      result = (before + after).trim()
    }

    // Now safe to trigger state changes
    onSelectCommand(commandId)
    setIsOpen(false)

    return result
  }, [onSelectCommand, slashStart])

  const handleSelectSkill = React.useCallback((skill: LoadedSkill): { value: string; cursorPosition: number } => {
    let result = { value: '', cursorPosition: 0 }
    if (slashStart >= 0) {
      const { value: currentValue, cursorPosition } = currentInputRef.current
      result = replaceSlashSkillSelection(currentValue, slashStart, cursorPosition, skill)
    }

    onSelectSkill?.(skill)
    setIsOpen(false)

    return result
  }, [onSelectSkill, slashStart])

  const handleSelectFolder = React.useCallback((path: string): string => {
    // Capture values BEFORE any state changes to avoid race conditions
    // Folder selection directly changes working directory, doesn't insert text
    let result = ''
    if (slashStart >= 0) {
      const { value: currentValue, cursorPosition } = currentInputRef.current
      const before = currentValue.slice(0, slashStart)
      const after = currentValue.slice(cursorPosition)
      // Just remove the /command text, no badge insertion
      result = (before + after).trim()
    }

    // Trigger working directory change
    onSelectFolder(path)
    setIsOpen(false)

    return result
  }, [onSelectFolder, slashStart])

  const close = React.useCallback(() => {
    setIsOpen(false)
    setFilter('')
    setSlashStart(-1)
  }, [])

  return {
    isOpen,
    filter,
    position,
    sections,
    handleInputChange,
    close,
    activeCommands,
    handleSelectCommand,
    handleSelectSkill,
    handleSelectFolder,
  }
}
