// input: Workspace/session state, navigation state, collapsible rail chrome, file-open intent, and shell callbacks
// output: Desktop app shell with window-pinned title-bar actions, project navigation, and writing panels
// pos: Top-level renderer layout coordinator for workspace navigation

import * as React from "react"
import { useTranslation, Trans } from "react-i18next"
import { useRef, useEffect, useCallback, useMemo } from "react"
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai"
import { selectAtom } from "jotai/utils"
import { motion, AnimatePresence, useReducedMotion } from "motion/react"
import {
  Archive,
  Flag,
  ListFilter,
  Tag,
  Check,
  X,
  Search,
  Plus,
  Trash2,
  Inbox,
  Calendar,
  Layers,
  Info,
  MailOpen,
  History,
  ArrowUpRight,
  FilePlus,
  FileUp,
  FolderOpen,
  FolderPlus,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
} from "lucide-react"
// SessionStatusIcons no longer used - icons come from dynamic sessionStatuses
import {
  ActivityRail,
  ACTIVITY_RAIL_MAX_WIDTH,
  ACTIVITY_RAIL_MIN_WIDTH,
  ACTIVITY_RAIL_WIDTH,
  type ActivityRailItemId,
} from "./ActivityRail"
import { PanelLeftRounded } from "@/components/icons/PanelLeftRounded"
import { FirstRunTour } from "./FirstRunTour"
import { GlobalSearchDialog } from "./GlobalSearchDialog"
import { WhatsNewAnnouncementDialog } from "./WhatsNewAnnouncementDialog"
import { buildWhatsNewAnnouncementCopy, getWhatsNewStartupAction } from "./whats-new-announcement"
import { cn } from "@/lib/utils"
import { getFileManagerName, isMac } from "@/lib/platform"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { RenameDialog } from "@/components/ui/rename-dialog"
import { HeaderIconButton } from "@/components/ui/HeaderIconButton"
import type { MentionFileReference } from "@/components/ui/mention-menu"
import { Tooltip, TooltipTrigger, TooltipContent, DocumentFormattedMarkdownOverlay, MultiDiffPreviewOverlay } from "@craft-agent/ui"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuSub,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
} from "@/components/ui/styled-dropdown"
import { SessionList, type ChatGroupingMode } from "./SessionList"
import { WritingPrimaryContentReadyContext } from "./MainContentPanel"
import { PanelStackContainer } from "./PanelStackContainer"
import { ResizableColumn } from "./ResizableColumn"
import type { ChatDisplayHandle } from "./ChatDisplay"
import { NovelDocumentEditorPanel, type NovelDocumentEditorPanelHandle, type NovelSelectionAiRequest } from "@/components/writing/NovelDocumentEditorPanel"
import { NovelDocumentTabStrip } from "@/components/writing/NovelDocumentTabStrip"
import { FileViewer } from "@/components/files/FileViewer"
import { NovelVersionHistoryDialog } from "@/components/writing/NovelVersionHistoryDialog"
import { formatNovelWorkspaceFileTitle } from "@/components/writing/novel-file-display"
import type {
  WorkspaceFileTreeHandle,
  WorkspaceFileTreeMenuAction,
  WorkspaceFileTreeNode,
} from "@/components/workspace/WorkspaceFileTree"
import { WorkspaceEmptyState } from "@/components/workspace/WorkspaceEmptyState"
import { WorkspaceProjectSidebar } from "@/components/workspace/WorkspaceProjectSidebar"
import {
  useWorkspaceProjectSurface,
  type WorkspaceCreateEntryTarget,
} from "@/components/workspace/useWorkspaceProjectSurface"
import { revealWorkspaceFile } from "@/components/workspace/workspace-file-actions"
import {
  advanceWorkspaceCatalogRevision,
  getDefaultWritingExpandedIds,
  getWorkspaceFileOpenTarget,
  isSameOrChildWorkspacePath,
  readWorkspaceCatalogRevision,
  reduceWorkspaceStateAfterDeletion,
  resolveWorkspaceCreateRelativePath,
  resolveWorkspaceImportRelativePath,
  type WorkspaceCreateEntryKind,
} from "@/components/workspace/workspace-file-tree-model"
import { useSession } from "@/hooks/useSession"
import { AppShellProvider, type AppShellContextType } from "@/context/AppShellContext"
import { sessionOptionsAtomFamily } from "@/hooks/useSessionOptions"
import { EscapeInterruptProvider, useEscapeInterruptActions } from "@/context/EscapeInterruptContext"
import { useTheme } from "@/context/ThemeContext"
import { getResizeGradientStyle } from "@/hooks/useResizeGradient"
import { useAction } from "@/actions"
import { useFocusZone } from "@/hooks/keyboard"
import { useFocusActions } from "@/context/FocusContext"
import { hasSessionHistoryContent } from "@/utils/session"
import type { LoadedSource, LoadedSkill, SourceFilter, AutomationFilter, WorkspaceVersionEntry, WorkspaceVersionFileChange, WhatsNewManifest } from "../../../shared/types"
import {
  ensureSessionMessagesLoadedAtom,
  reconcileSessionTranscriptWorkingSetAtom,
  sessionAtomFamily,
  sessionMetaMapAtom,
  sessionMetaAtomFamily,
  sendToWorkspaceAtom,
} from "@/atoms/sessions"
import { sessionListSearchActiveAtom, sessionListSearchQueryAtom } from "@/atoms/session-list-search"
import { sourcesAtom } from "@/atoms/sources"
import { skillsAtom } from "@/atoms/skills"
import { panelStackAtom, panelCountAtom, focusedPanelIdAtom, focusedSessionIdAtom, focusNextPanelAtom, focusPrevPanelAtom, parseSessionIdFromRoute } from "@/atoms/panel-stack"
import { type SessionStatusId, type SessionStatus, statusConfigsToSessionStatuses } from "@/config/session-status-config"
import { useStatuses } from "@/hooks/useStatuses"
import { useLabels } from "@/hooks/useLabels"
import { useViews } from "@/hooks/useViews"
import { useContainerWidth } from "@/hooks/useContainerWidth"
import { useNovelReviewController } from "@/hooks/useNovelReviewController"
import { invalidateWorkspaceSkillsCache, loadSkillsForWorkspace } from "@/hooks/useWorkspaceSkills"
import { PERMISSION_MODE_ORDER } from "@craft-agent/shared/agent/modes"
import { LabelIcon } from "@/components/ui/label-icon"
import { filterSessionStatuses as filterLabelMenuStates } from "@/components/ui/label-menu"
import { createLabelMenuItems, filterItems as filterLabelMenuItems, type LabelMenuItem } from "@/components/ui/label-menu-utils"
import { getLabelDisplayName, sortLabelsForDisplay } from "@craft-agent/shared/labels"
import type { LabelConfig } from "@craft-agent/shared/labels"
import * as storage from "@/lib/local-storage"
import { toast } from "sonner"
import { navigate, routes } from "@/lib/navigate"
import {
  useNavigationActions,
  useNavigationState,
  isWritingNavigation,
  isSessionsNavigation,
  isSourcesNavigation,
  isSkillsNavigation,
  isAutomationsNavigation,
} from "@/contexts/NavigationContext"
import type { SettingsSubpage } from "../../../shared/types"
import { SourcesListPanel } from "./SourcesListPanel"
import { AutomationsListPanel } from "../automations/AutomationsListPanel"
import { AUTOMATION_TYPE_TO_FILTER_KIND } from "../automations/types"
import { useAutomations } from "@/hooks/useAutomations"
import { useUpdateChecker } from "@/hooks/useUpdateChecker"
import { getUpdateIndicatorState } from "@/lib/update-indicator"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { PanelHeader } from "./PanelHeader"
import { SendToWorkspaceDialog } from "./SendToWorkspaceDialog"
import { MessagingDialogHost } from "@/components/messaging/MessagingDialogHost"
import { EditPopover, getEditConfig, type EditContextKey } from "@/components/ui/EditPopover"
import { GLOBAL_SETTINGS_SUBPAGES, SettingsDialog } from "@/pages/settings/SettingsNavigator"
import {
  PANEL_GAP,
  PANEL_EDGE_INSET,
  PANEL_SASH_HIT_WIDTH,
  PANEL_SASH_LINE_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_SPRING,
} from "./panel-constants"
import {
  DEFAULT_WORKSPACE_WIDTH,
  getNavigatorResizeMaxWidth,
  shouldResolveInitialShellLayoutWidths,
} from "./layout-defaults"
import { WINDOW_TITLE_BAR_HEIGHT } from "./layout-constants"
import { hasOpenOverlay } from "@/lib/overlay-detection"
import { clearSourceIconCaches } from "@/lib/icon-cache"
import { rendererPerf } from "@/lib/perf"
import { dispatchFocusInputEvent } from "./input/focus-input-events"
import { buildRejectFileChangesOperation } from "@/lib/file-change-review"
import {
  buildRevertOperation,
  buildSnapshotRevertPlan,
  getSnapshotChangeKind,
  type FileRevertPlan,
  type FileState,
} from "@/lib/snapshot-revert"
import {
  getNovelReviewChangeKey,
  getNovelReviewStatus,
  normalizeNovelFileChangePaths,
  type NovelReviewStatusMap,
} from "@/lib/novel-review-workflow"
import type { NovelReviewUndoEntry } from "@/lib/novel-review-undo"
import {
  detectNovelProjectFromSearchResults,
  getLatestNovelFileChangesFromMessages,
  getNovelFileChangeActivityKey,
  getNovelWorkspaceRelativePath,
  getNovelWorkspaceCandidateRoots,
  areNovelWorkspaceFilesEqual,
  closeNovelDocumentTab,
  filterNovelDocumentTabs,
  isNovelWorkspaceFilePathInRoot,
  mapNovelDocumentTabs,
  mapNativeWorkspaceCatalog,
  mapSearchResultsToNovelWorkspaceFiles,
  NOVEL_WORKSPACE_DETECTION_QUERIES,
  openNovelDocumentTab,
  shouldUseEmptyProjectStarterLayout,
  type NovelDocumentOpenMode,
  type NovelDocumentTabsState,
  type NativeWorkspaceCatalog,
  type NovelWorkspaceFile,
} from "@/lib/writing-workspace"
import type { FileChange } from "@craft-agent/ui"
import { RPC_CHANNELS, type FileSearchBatchRequest, type FileSearchBatchResult } from "@craft-agent/shared/protocol"
import { FREE_CONVERSATION_WORKSPACE_ID } from "@craft-agent/shared/protocol"

// ponytail: process-local replay guard for passive file-change refreshes; explicit file operations refresh directly.
const completedNovelFileChangeRefreshKeys = new Set<string>()
const pendingNovelFileChangeRefreshKeys = new Set<string>()

/**
 * AppShellProps - Minimal props interface for AppShell component
 *
 * Data and callbacks come via contextValue (AppShellContextType).
 * Only UI-specific state is passed as separate props.
 *
 * Adding new features:
 * 1. Add to AppShellContextType in context/AppShellContext.tsx
 * 2. Update App.tsx to include in contextValue
 * 3. Expose only the needed field through a narrow context or atom
 */
interface AppShellProps {
  /** All data and callbacks - passed directly to AppShellProvider */
  contextValue: AppShellContextType
  /** UI-specific props */
  defaultCollapsed?: boolean
  menuNewChatTrigger?: number
  /** Monotonic signal for opening global search after entering the ready shell */
  openGlobalSearchSignal?: number
  /** Positive one-shot signal for opening release notes after entering the ready shell */
  openWhatsNewSignal?: number
  /** Clears the one-shot release-notes signal before the ready shell can remount. */
  onOpenWhatsNewSignalHandled: () => void
  /** App-owned update manifest shared by every ActivityRail surface. */
  whatsNewManifest: WhatsNewManifest | null
  /** App-owned unread state shared by every ActivityRail surface. */
  hasUnseenReleaseNotes: boolean
  /** Clears the App-owned unread state after release notes are opened. */
  onReleaseNotesSeen: () => void
  /** Current signed-in role shown by the sidebar profile item. */
  profile?: {
    name: string
    detail?: string
  }
  onOpenProjectInNewWindow?: (workspaceId: string) => void
  onRelinkProject?: (workspaceId: string) => void | Promise<void>
  onRenameProject?: (workspaceId: string, name: string) => void | Promise<void>
  onSetProjectArchived?: (workspaceId: string, archived: boolean) => void | Promise<void>
  onRemoveProject?: (workspaceId: string) => void | Promise<void>
  /** Opens the native folder picker and registers the selected local Project. */
  onAddLocalProject?: () => void | Promise<void>
  isAddingLocalProject?: boolean
}

function isNovelReviewUndoShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey)
    && !event.shiftKey
    && !event.altKey
    && event.key.toLowerCase() === 'z'
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false

  const tagName = target.tagName.toLowerCase()
  return tagName === 'input'
    || tagName === 'textarea'
    || target.isContentEditable
    || target.closest('[contenteditable="true"]') != null
}

function hasBlockingFocusDialog(): boolean {
  return document.querySelector(
    '[data-slot="dialog-content"], [role="alertdialog"], [role="dialog"]:not([data-slot="popover-content"])',
  ) !== null
}

/** Filter mode for tri-state filtering: include shows only matching, exclude hides matching */
type FilterMode = 'include' | 'exclude'

interface NovelWorkspaceBriefPreparation {
  shouldSend: boolean
  brief?: string
  checkpoint?: { rootPath: string; commitHash: string }
  agentTouchedPaths?: string[]
}

const altClickTooltipLabel = isMac ? '⌥ click to exclude' : 'Alt click to exclude'
const SESSION_LIST_MIN_WIDTH = 240
const SESSION_LIST_MAX_WIDTH = 480
const NOVEL_WORKSPACE_NAVIGATOR_MIN_WIDTH = 420
const NOVEL_WORKSPACE_NAVIGATOR_DEFAULT_WIDTH = DEFAULT_WORKSPACE_WIDTH
const WRITING_ASSISTANT_MIN_WIDTH = 320
// The directory is the outermost content navigator, so it stays narrow like a
// file tree rather than matching the manuscript's reading width.
const WORKSPACE_DIRECTORY_MIN_WIDTH = 220
const WORKSPACE_DIRECTORY_MAX_WIDTH = 460
const WORKSPACE_DIRECTORY_DEFAULT_WIDTH = WORKSPACE_DIRECTORY_MIN_WIDTH
/** Fraction of the window the manuscript column takes before the user resizes it. */
const DEFAULT_DOCUMENT_DOCK_WIDTH_RATIO = 0.34
const NOVEL_AUTO_VERSION_CHAR_THRESHOLD = 100
const NOVEL_AUTO_VERSION_INTERVAL_MS = 5 * 60 * 1000
const NOVEL_WORKSPACE_BRIEF_CHANGE_LIMIT = 20
function joinWorkspacePath(rootPath: string, relativePath: string): string {
  const root = rootPath.replace(/[\\/]+$/, '')
  const relative = relativePath.replace(/^[\\/]+/, '')
  return relative ? `${root}/${relative}` : root
}

function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function getWorkspaceRelativePathKey(path: string): string {
  return normalizeWorkspacePath(path).replace(/^\/+/, '').toLocaleLowerCase()
}

function remapWorkspacePath(path: string, sourcePath: string, destinationPath: string): string {
  const normalizedPath = normalizeWorkspacePath(path)
  const normalizedSource = normalizeWorkspacePath(sourcePath)
  if (normalizedPath === normalizedSource) return destinationPath
  if (!normalizedPath.startsWith(`${normalizedSource}/`)) return path
  return `${normalizeWorkspacePath(destinationPath)}${normalizedPath.slice(normalizedSource.length)}`
}

function getKnownWorkspaceCommit(rootPath: string, sessionId: string): string | undefined {
  const commits = storage.get<Record<string, string>>(storage.KEYS.workspaceVersionKnownCommit, {}, rootPath)
  return commits[sessionId]
}

function setKnownWorkspaceCommit(rootPath: string, sessionId: string, commitHash: string): void {
  const commits = storage.get<Record<string, string>>(storage.KEYS.workspaceVersionKnownCommit, {}, rootPath)
  storage.set(storage.KEYS.workspaceVersionKnownCommit, {
    ...commits,
    [sessionId]: commitHash,
  }, rootPath)
}

function formatWorkspaceChange(change: WorkspaceVersionFileChange): string {
  if (change.status === 'renamed' && change.previousPath) {
    return `${change.previousPath} -> ${change.path} renamed`
  }
  return `${change.path} ${change.status}`
}

function buildNovelWorkspaceFreshnessBrief(
  changes: WorkspaceVersionFileChange[],
  activeFile?: string | null,
): string | undefined {
  if (changes.length === 0) return undefined

  const visibleChanges = changes.slice(0, NOVEL_WORKSPACE_BRIEF_CHANGE_LIMIT)
  const overflow = changes.length - visibleChanges.length
  const lines = [
    '<workspace-brief>',
    'Workspace files changed since your last known checkpoint in this session.',
    activeFile ? `Active writing file: ${activeFile}` : undefined,
    '',
    'Unknown changes:',
    ...visibleChanges.map(change => `- ${formatWorkspaceChange(change)}`),
    overflow > 0 ? `- ...and ${overflow} more file(s)` : undefined,
    '</workspace-brief>',
  ].filter((line): line is string => line !== undefined)

  return lines.join('\n')
}

function collectAgentTouchedRelativePaths(
  changes: FileChange[],
  rootPath: string,
  files: Pick<NovelWorkspaceFile, 'path' | 'relativePath'>[],
): string[] {
  const relativeByAbsolutePath = new Map(files.map(file => [file.path, file.relativePath]))
  return [...new Set(changes
    .filter(change => !change.error)
    .map(change => relativeByAbsolutePath.get(change.filePath) ?? getNovelWorkspaceRelativePath(change.filePath, rootPath))
    .filter(Boolean))]
}

function buildWorkspaceVersionReviewChanges(
  changes: WorkspaceVersionFileChange[],
  rootPath: string,
): FileChange[] {
  const normalizedRoot = rootPath.replace(/\/+$/, '')
  return changes
    .filter(change => change.unifiedDiff?.trim())
    .map((change): FileChange => ({
      id: `workspace-version:${change.path}`,
      filePath: `${normalizedRoot}/${change.path}`,
      toolType: 'Edit',
      changeKind: getSnapshotChangeKind(change.status),
      original: '',
      modified: '',
      unifiedDiff: change.unifiedDiff,
    }))
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error(`Operation timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    operation.then(
      (value) => {
        window.clearTimeout(timeoutId)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timeoutId)
        reject(error)
      }
    )
  })
}

async function readCurrentFileState(filePath: string): Promise<FileState> {
  try {
    return await window.electronAPI.readFile(filePath)
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error
      ? String(error.code)
      : ''
    const message = error instanceof Error ? error.message : String(error)
    if (code === 'ENOENT' || message.includes('ENOENT') || message.includes('no such file')) {
      return null
    }
    throw error
  }
}

async function searchNovelWorkspaceFiles(
  rootPath: string,
  requests: FileSearchBatchRequest[]
): Promise<FileSearchBatchResult[]> {
  const canUseBatchSearch = typeof window.electronAPI.searchFilesBatch === 'function'
    && window.electronAPI.isChannelAvailable(RPC_CHANNELS.fs.SEARCH_BATCH)

  if (canUseBatchSearch) {
    try {
      return await window.electronAPI.searchFilesBatch(rootPath, requests)
    } catch (error) {
      console.warn('[AppShell] Falling back to single file searches:', error)
    }
  }

  return Promise.all(
    requests.map(async (request) => {
      try {
        return {
          query: request.query,
          results: await withTimeout(
            window.electronAPI.searchFiles(rootPath, request.query, request.options),
            1000
          ),
        }
      } catch {
        return {
          query: request.query,
          results: [],
        }
      }
    })
  )
}

/** Sidebar is the real project folder: list disk, skip noise dirs server-side, no catalog filter. */
async function loadNovelWorkspaceFileTree(rootPath: string): Promise<NativeWorkspaceCatalog> {
  const results = await window.electronAPI.listWorkspaceFiles(rootPath, [])
  return mapNativeWorkspaceCatalog(results)
}

function getParentRelativePath(relativePath: string): string {
  const segments = relativePath.split('/')
  segments.pop()
  return segments.join('/')
}

function getMarkdownTitleFromRelativePath(relativePath: string): string {
  const fileName = relativePath.split('/').pop() ?? ''
  return fileName.replace(/\.[^/.]+$/, '').replace(/-/g, ' ').trim()
}

function shouldCreateMarkdownStarter(relativePath: string): boolean {
  return relativePath.toLowerCase().endsWith('.md')
}

function getContentChangeSize(previous: string, next: string): number {
  if (previous === next) return 0

  let prefixLength = 0
  const minLength = Math.min(previous.length, next.length)
  while (prefixLength < minLength && previous[prefixLength] === next[prefixLength]) {
    prefixLength += 1
  }

  let suffixLength = 0
  while (
    suffixLength < minLength - prefixLength
    && previous[previous.length - 1 - suffixLength] === next[next.length - 1 - suffixLength]
  ) {
    suffixLength += 1
  }

  const previousChanged = previous.length - prefixLength - suffixLength
  const nextChanged = next.length - prefixLength - suffixLength
  return Math.max(previousChanged, nextChanged)
}

function isSuspiciousEmptyNovelSnapshot(
  contentToSave: string,
  savedContent: string,
  lastLoadedContent: string,
): boolean {
  return contentToSave.length === 0
    && savedContent.length > 0
    && lastLoadedContent === savedContent
}

/** Wraps children in a Tooltip that shows instantly on hover — only rendered when `show` is true. */
function AltExcludeTooltip({ show, children }: { show: boolean; children: React.ReactNode }) {
  if (!show) return children
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" className="text-xs">{altClickTooltipLabel}</TooltipContent>
    </Tooltip>
  )
}

/**
 * FilterModeBadge - Display-only badge showing the current filter mode.
 * Shows a checkmark for 'include' and an X for 'exclude'. Used as a visual
 * indicator inside DropdownMenuSubTrigger rows (the actual mode switching
 * happens via the sub-menu content, not this badge).
 */
function FilterModeBadge({ mode }: { mode: FilterMode }) {
  return (
    <span
      className={cn(
        "flex items-center justify-center h-5 w-5 rounded-[4px] -mr-1",
        mode === 'include'
          ? "bg-background text-foreground shadow-minimal"
          : "bg-destructive/10 text-destructive shadow-tinted",
      )}
      style={mode === 'exclude' ? { '--shadow-color': 'var(--destructive-rgb)' } as React.CSSProperties : undefined}
    >
      {mode === 'include' ? <Check className="!h-2.5 !w-2.5" /> : <X className="!h-2.5 !w-2.5" />}
    </span>
  )
}

/**
 * FilterModeSubMenuItems - Shared sub-menu content for switching filter mode.
 * Renders Include / Exclude / Remove options using StyledDropdownMenuItem for
 * consistent styling. Used inside StyledDropdownMenuSubContent by both leaf
 * and group label items when they have an active filter mode.
 */
function FilterModeSubMenuItems({
  mode,
  onChangeMode,
  onRemove,
}: {
  mode: FilterMode
  onChangeMode: (mode: FilterMode) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  return (
    <>
      <StyledDropdownMenuItem
        onClick={(e) => { e.preventDefault(); onChangeMode('include') }}
        className={cn(mode === 'include' && "bg-foreground/[0.03]")}
      >
        <Check className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">{t("filter.include")}</span>
      </StyledDropdownMenuItem>
      <StyledDropdownMenuItem
        onClick={(e) => { e.preventDefault(); onChangeMode('exclude') }}
        className={cn(mode === 'exclude' && "bg-foreground/[0.03]")}
      >
        <X className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">{t("filter.exclude")}</span>
      </StyledDropdownMenuItem>
      <StyledDropdownMenuSeparator />
      <StyledDropdownMenuItem
        onClick={(e) => { e.preventDefault(); onRemove() }}
      >
        <Trash2 className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">{t("common.clear")}</span>
      </StyledDropdownMenuItem>
    </>
  )
}

/**
 * FilterMenuRow - Consistent layout for filter menu items.
 * Enforces: [icon 14px box] [label flex] [accessory 12px box]
 */
function FilterMenuRow({
  icon,
  label,
  accessory,
  iconClassName,
  iconStyle,
  noIconContainer,
}: {
  icon: React.ReactNode
  label: React.ReactNode
  accessory?: React.ReactNode
  /** Additional classes for icon container (e.g., for status icon scaling) */
  iconClassName?: string
  /** Style for icon container (e.g., for status icon color) */
  iconStyle?: React.CSSProperties
  /** When true, skip the icon container (for icons that have their own container) */
  noIconContainer?: boolean
}) {
  return (
    <>
      {noIconContainer ? (
        // Wrapper for color inheritance. Clone icon to add bare prop (removes EntityIcon container).
        <span style={iconStyle}>
          {React.isValidElement(icon) ? React.cloneElement(icon as React.ReactElement<{ bare?: boolean }>, { bare: true }) : icon}
        </span>
      ) : (
        <span
          className={cn("h-3.5 w-3.5 flex items-center justify-center shrink-0", iconClassName)}
          style={iconStyle}
        >
          {icon}
        </span>
      )}
      <span className="flex-1">{label}</span>
      <span className="shrink-0">{accessory}</span>
    </>
  )
}

/**
 * FilterLabelItems - Recursive component for rendering label tree in the filter dropdown.
 *
 * Rendering rules by label state:
 * - **Inactive leaf**: StyledDropdownMenuItem — click to add as 'include'
 * - **Active leaf**: DropdownMenuSub — SubTrigger shows label + mode badge, SubContent
 *   has Include/Exclude/Remove options (uses Radix's built-in safe-triangle hover)
 * - **Group (with children)**: Always a DropdownMenuSub. When active, SubContent shows
 *   mode options first, then separator, then children. When inactive, shows a self-toggle
 *   item, then separator, then children.
 * - **Pinned labels**: Shown with a check mark, non-interactive (no toggle/sub-menu).
 */
function FilterLabelItems({
  labels,
  labelFilter,
  setLabelFilter,
  pinnedLabelId,
  altHeld,
}: {
  labels: LabelConfig[]
  labelFilter: Map<string, FilterMode>
  setLabelFilter: (updater: Map<string, FilterMode> | ((prev: Map<string, FilterMode>) => Map<string, FilterMode>)) => void
  /** Label ID pinned by the current route (non-removable, shown as checked+disabled) */
  pinnedLabelId?: string | null
  altHeld?: boolean
}) {
  /** Toggle a label filter: if active → remove, if inactive → add as 'include' (or 'exclude' with Alt) */
  const toggleLabel = (id: string, altKey = false) => {
    setLabelFilter(prev => {
      const next = new Map(prev)
      if (next.has(id)) next.delete(id)
      else next.set(id, altKey ? 'exclude' : 'include')
      return next
    })
  }

  /** Build callbacks for changing/removing a label's filter mode */
  const makeModeCallbacks = (id: string) => ({
    onChangeMode: (newMode: FilterMode) => setLabelFilter(prev => {
      const next = new Map(prev)
      next.set(id, newMode)
      return next
    }),
    onRemove: () => setLabelFilter(prev => {
      const next = new Map(prev)
      next.delete(id)
      return next
    }),
  })

  return (
    <>
      {labels.map(label => {
        const hasChildren = label.children && label.children.length > 0
        const isPinned = label.id === pinnedLabelId
        const mode = labelFilter.get(label.id)
        const isActive = !!mode && !isPinned

        // --- Group labels (have children) → always DropdownMenuSub ---
        if (hasChildren) {
          // Check if any child has an active filter (to show indicator on parent)
          const hasActiveChild = label.children!.some(child => {
            const childMode = labelFilter.get(child.id)
            return !!childMode && child.id !== pinnedLabelId
          })
          const showIndicator = isActive || hasActiveChild || isPinned

          return (
            <DropdownMenuSub key={label.id}>
              <StyledDropdownMenuSubTrigger>
                <FilterMenuRow
                  icon={<LabelIcon label={label} size="lg" hasChildren />}
                  label={label.name}
                  accessory={
                    showIndicator ? <Check className="h-3 w-3 text-muted-foreground" /> : undefined
                  }
                />
              </StyledDropdownMenuSubTrigger>
              <StyledDropdownMenuSubContent minWidth="min-w-[160px]">
                {isActive ? (
                  // Active group: group title as nested sub-trigger for mode options, then children
                  <>
                    <DropdownMenuSub>
                      {/* Click the group title to clear, hover to open mode submenu */}
                      <StyledDropdownMenuSubTrigger onClick={(e) => { e.preventDefault(); toggleLabel(label.id, e.altKey) }}>
                        <FilterMenuRow
                          icon={<LabelIcon label={label} size="lg" hasChildren />}
                          label={label.name}
                          accessory={<FilterModeBadge mode={mode} />}
                        />
                      </StyledDropdownMenuSubTrigger>
                      <StyledDropdownMenuSubContent minWidth="min-w-[140px]">
                        <FilterModeSubMenuItems mode={mode} {...makeModeCallbacks(label.id)} />
                      </StyledDropdownMenuSubContent>
                    </DropdownMenuSub>
                    <StyledDropdownMenuSeparator />
                    <FilterLabelItems
                      labels={label.children!}
                      labelFilter={labelFilter}
                      setLabelFilter={setLabelFilter}
                      pinnedLabelId={pinnedLabelId}
                      altHeld={altHeld}
                    />
                  </>
                ) : (
                  // Inactive group: self-toggle item, then children
                  <>
                    <AltExcludeTooltip show={!!altHeld && !isPinned}>
                      <StyledDropdownMenuItem
                        disabled={isPinned}
                        onClick={(e) => {
                          if (isPinned) return
                          e.preventDefault()
                          toggleLabel(label.id, e.altKey)
                        }}
                      >
                        <FilterMenuRow
                          icon={<LabelIcon label={label} size="lg" hasChildren />}
                          label={label.name}
                          accessory={isPinned ? <Check className="h-3 w-3 text-muted-foreground" /> : undefined}
                        />
                      </StyledDropdownMenuItem>
                    </AltExcludeTooltip>
                    <StyledDropdownMenuSeparator />
                    <FilterLabelItems
                      labels={label.children!}
                      labelFilter={labelFilter}
                      setLabelFilter={setLabelFilter}
                      pinnedLabelId={pinnedLabelId}
                      altHeld={altHeld}
                    />
                  </>
                )}
              </StyledDropdownMenuSubContent>
            </DropdownMenuSub>
          )
        }

        // --- Active leaf label → DropdownMenuSub with mode options ---
        if (isActive) {
          return (
            <DropdownMenuSub key={label.id}>
              {/* Click the item itself to clear, hover to open mode submenu */}
              <StyledDropdownMenuSubTrigger onClick={(e) => { e.preventDefault(); toggleLabel(label.id, e.altKey) }}>
                <FilterMenuRow
                  icon={<LabelIcon label={label} size="lg" />}
                  label={label.name}
                  accessory={<FilterModeBadge mode={mode} />}
                />
              </StyledDropdownMenuSubTrigger>
              <StyledDropdownMenuSubContent minWidth="min-w-[140px]">
                <FilterModeSubMenuItems mode={mode} {...makeModeCallbacks(label.id)} />
              </StyledDropdownMenuSubContent>
            </DropdownMenuSub>
          )
        }

        // --- Inactive / pinned leaf label → simple toggleable item ---
        return (
          <AltExcludeTooltip key={label.id} show={!!altHeld && !isPinned}>
            <StyledDropdownMenuItem
              disabled={isPinned}
              onClick={(e) => {
                if (isPinned) return
                e.preventDefault()
                toggleLabel(label.id, e.altKey)
              }}
            >
              <FilterMenuRow
                icon={<LabelIcon label={label} size="lg" />}
                label={label.name}
                accessory={isPinned ? <Check className="h-3 w-3 text-muted-foreground" /> : undefined}
              />
            </StyledDropdownMenuItem>
          </AltExcludeTooltip>
        )
      })}
    </>
  )
}


/**
 * AppShell - Main 3-panel layout container
 *
 * Layout: [LeftSidebar 20%] | [Workspace 50%] | [Assistant 30%]
 *
 * Session Filters:
 * - 'allSessions': Shows all sessions
 * - 'flagged': Shows flagged sessions
 * - 'state': Shows sessions with a specific todo state
 */
export function AppShell(props: AppShellProps) {
  // Wrap with EscapeInterruptProvider so AppShellContent can use useEscapeInterrupt
  return (
    <EscapeInterruptProvider>
      <AppShellContent {...props} />
    </EscapeInterruptProvider>
  )
}

/**
 * AppShellContent - Inner component that contains all the AppShell logic
 * Separated to allow useEscapeInterrupt hook to work (must be inside provider)
 */
function AppShellContent({
  contextValue,
  defaultCollapsed = false,
  menuNewChatTrigger,
  openGlobalSearchSignal = 0,
  openWhatsNewSignal = 0,
  onOpenWhatsNewSignalHandled,
  whatsNewManifest,
  hasUnseenReleaseNotes,
  onReleaseNotesSeen,
  profile,
  onOpenProjectInNewWindow,
  onRelinkProject,
  onRenameProject,
  onSetProjectArchived,
  onRemoveProject,
  onAddLocalProject,
  isAddingLocalProject = false,
}: AppShellProps) {
  // Destructure commonly used values from context
  // Note: sessions is NOT destructured here - shell leaves metadata list subscriptions to leaf views.
  // to prevent closures from retaining the full messages array
  const {
    workspaces,
    runtimeWorkspace,
    activeProjectId,
    onSelectWorkspace,
    onSelectProjectSession,
    onOpenWritingWorkspace,
    onOpenFreeConversations,
    onDeleteSession,
    onFlagSession,
    onUnflagSession,
    onArchiveSession,
    onUnarchiveSession,
    onSessionStatusChange,
    onRenameSession,
    onCreateSession,
    onOpenSettings,
    onOpenKeyboardShortcuts,
    onSendMessage,
    onOpenFile,
    onInputChange,
    getDraft,
  } = contextValue
  const activeWorkspace = runtimeWorkspace
  const activeWorkspaceId = runtimeWorkspace?.id ?? null
  const isProjectRuntime = activeWorkspaceId !== null
    && activeWorkspaceId !== FREE_CONVERSATION_WORKSPACE_ID
  const projectWorkspaceId = isProjectRuntime ? activeWorkspaceId : null
  const remoteWorkspaceId = runtimeWorkspace?.remoteServer?.remoteWorkspaceId

  const { t } = useTranslation()
  const updateChecker = useUpdateChecker()
  const updateIndicator = getUpdateIndicatorState(updateChecker.updateInfo)

  // Get hotkey labels from centralized action registry

  const [isSidebarVisible, setIsSidebarVisible] = React.useState(() => {
    return storage.get(storage.KEYS.sidebarVisible, !defaultCollapsed)
  })
  const [isActivityRailVisible, setIsActivityRailVisible] = React.useState(() => {
    return storage.get(storage.KEYS.activityRailVisible, true)
  })
  const [activityRailWidth, setActivityRailWidth] = React.useState(() => {
    const storedWidth = storage.get(storage.KEYS.activityRailWidth, ACTIVITY_RAIL_WIDTH)
    return Math.min(ACTIVITY_RAIL_MAX_WIDTH, Math.max(ACTIVITY_RAIL_MIN_WIDTH, storedWidth))
  })
  const shouldReduceMotion = useReducedMotion()
  // Session list width in pixels (min 240, max 480)
  const [sessionListWidth, setSessionListWidth] = React.useState(() => {
    return storage.get(storage.KEYS.sessionListWidth, DEFAULT_WORKSPACE_WIDTH)
  })
  const [novelWorkspaceNavigatorWidth, setNovelWorkspaceNavigatorWidth] = React.useState(() => {
    return storage.get(storage.KEYS.novelWorkspaceNavigatorWidth, NOVEL_WORKSPACE_NAVIGATOR_DEFAULT_WIDTH)
  })
  const [workspaceDirectoryWidth, setWorkspaceDirectoryWidth] = React.useState(() => {
    return storage.get(storage.KEYS.workspaceDirectoryWidth, WORKSPACE_DIRECTORY_DEFAULT_WIDTH)
  })
  const [rightWorkspaceVisible, setRightWorkspaceVisible] = React.useState(() => {
    return storage.get(storage.KEYS.writingWorkspaceVisible, false)
  })
  const [workspaceDirectoryVisible, setWorkspaceDirectoryVisible] = React.useState(() => {
    // Before independent directory folding existed, workspaceDirectoryVisible
    // controlled the complete writing workspace. Keep that legacy value as the
    // group preference above, then start the directory itself expanded.
    if (storage.getRaw(storage.KEYS.writingWorkspaceVisible) === null) return true
    return storage.get(storage.KEYS.workspaceDirectoryVisible, true)
  })
  const writingWorkspaceDockWidth = novelWorkspaceNavigatorWidth + workspaceDirectoryWidth
  React.useEffect(() => {
    storage.remove(storage.KEYS.focusModeEnabled)
  }, [])

  // Auto-compact mode: shell width below mobile threshold hides sidebar/navigator
  // and switches to single-panel mode. Works in both webui (narrow viewport) and
  // desktop (narrow window or small screen).
  const shellRef = useRef<HTMLDivElement>(null)
  const shellWidth = useContainerWidth(shellRef)
  const MOBILE_THRESHOLD = 768
  const isAutoCompact = shellWidth > 0 && shellWidth < MOBILE_THRESHOLD

  const effectiveSidebarAndNavigatorHidden = isAutoCompact
  // Foundation layer: activity rail is always available (not tied to sidebar/navigator chrome).
  const showActivityRail = true
  const activityRailOffset = isActivityRailVisible ? activityRailWidth : 0


  // What's New overlay
  const [showWhatsNew, setShowWhatsNew] = React.useState(false)
  const [showWhatsNewAnnouncement, setShowWhatsNewAnnouncement] = React.useState(false)
  const [releaseNotesContent, setReleaseNotesContent] = React.useState('')
  const whatsNewAnnouncementCopy = React.useMemo(
    () => whatsNewManifest ? buildWhatsNewAnnouncementCopy(whatsNewManifest) : null,
    [whatsNewManifest],
  )

  // The root App loads one manifest for every shell surface; this leaf owns only its dialog.
  useEffect(() => {
    if (whatsNewManifest) {
      const lastSeenDigest = storage.get(storage.KEYS.whatsNewLastSeenDigest, '')
      const lastSeenVersion = storage.get(storage.KEYS.whatsNewLastSeenVersion, '')
      const startupAction = getWhatsNewStartupAction({
        manifest: whatsNewManifest,
        lastSeenDigest,
        lastSeenVersion,
      })
      setShowWhatsNewAnnouncement(startupAction.shouldOpenDialog)
    }
  }, [whatsNewManifest])

  const [isResizing, setIsResizing] = React.useState<'session-list' | 'novel-workspace-navigator' | 'document-dock' | 'directory-dock' | null>(null)
  const [sessionListHandleY, setSessionListHandleY] = React.useState<number | null>(null)
  const sessionListHandleRef = React.useRef<HTMLDivElement>(null)
  const navigatorPanelRef = React.useRef<HTMLDivElement>(null)
  const sessionListPanelRef = React.useRef<HTMLDivElement>(null)
  const latestSessionListWidthRef = React.useRef(sessionListWidth)
  const latestNovelWorkspaceNavigatorWidthRef = React.useRef(novelWorkspaceNavigatorWidth)
  const latestWorkspaceDirectoryWidthRef = React.useRef(workspaceDirectoryWidth)
  // Delta-based resize baselines: once the directory anchors the window's right
  // edge, the manuscript column no longer touches any edge, so its width is
  // tracked as an offset from where the drag started rather than from a wall.
  const resizeStartXRef = React.useRef(0)
  const resizeStartWidthRef = React.useRef(0)

  const [session, setSession] = useSession()
  const { resolvedMode, isDark, setMode } = useTheme()
  const {
    goBack,
    goForward,
    navigateToSource,
    navigateToSession,
    settingsSubpage,
    closeSettings,
  } = useNavigationActions()

  // Double-Esc interrupt feature: first Esc shows warning, second Esc interrupts
  const { handleEscapePress } = useEscapeInterruptActions()

  // UNIFIED NAVIGATION STATE - single source of truth from NavigationContext
  // Derived from focused panel's route — all panels are peers
  const navState = useNavigationState()
  // Skills now owns a full-width Hub. Conversation views use the Activity Rail,
  // so neither surface should keep the legacy navigator consuming content width.
  const hideSessionListNavigator = isSkillsNavigation(navState)
    || (
      showActivityRail
      && !isAutoCompact
      && (
        isSessionsNavigation(navState)
        || (isProjectRuntime && isWritingNavigation(navState))
      )
    )
  const contentNeedsStoplightCompensation = isAutoCompact
    || (!isActivityRailVisible && hideSessionListNavigator)
  const contentHeaderLeadingInset = !isAutoCompact && !isActivityRailVisible && hideSessionListNavigator
    ? activityRailWidth + 16
    : null
  const visibleSessionListWidth = hideSessionListNavigator ? 0 : sessionListWidth

  const store = useStore()
  const panelStack = useAtomValue(panelStackAtom)
  const panelCount = useAtomValue(panelCountAtom)
  const focusedSessionId = useAtomValue(focusedSessionIdAtom)

  // Navigate the focused panel to a session.
  // If the session is already open in another panel, focus that panel instead.
  const setFocusedPanel = useSetAtom(focusedPanelIdAtom)
  const navigateToSessionInPanel = useCallback((sessionId: string) => {
    // Check if the session is already open in any panel — focus it instead of navigating
    const stack = store.get(panelStackAtom)
    for (const entry of stack) {
      if (parseSessionIdFromRoute(entry.route) === sessionId) {
        setFocusedPanel(entry.id)
        return
      }
    }

    // Not open in any panel — navigate() updates the focused panel
    navigateToSession(sessionId)
  }, [store, setFocusedPanel, navigateToSession])

  const sessionsContext = React.useMemo(() => {
    if (isSessionsNavigation(navState)) {
      return {
        filter: navState.filter,
        sessionId: navState.details?.sessionId ?? null,
      }
    }
    return null
  }, [navState])

  const sessionFilter = sessionsContext?.filter ?? null

  // Derive source filter from navigation state (only when in sources navigator)
  const sourceFilter: SourceFilter | null = isSourcesNavigation(navState) ? navState.filter ?? null : null

  // Derive automation filter from navigation state (only when in automations navigator)
  const automationFilter: AutomationFilter | null = isAutomationsNavigation(navState) ? navState.filter ?? null : null
  const automationFilterType = automationFilter?.automationType
  const automationListFilter = useMemo(() => {
    if (!automationFilterType) return undefined
    return { kind: AUTOMATION_TYPE_TO_FILTER_KIND[automationFilterType] ?? 'all' }
  }, [automationFilterType])

  // Per-view filter storage: each session list view (allSessions, flagged, state:X, label:X, view:X)
  // has its own independent set of status and label filters.
  // Each filter entry stores a mode ('include' or 'exclude') for tri-state filtering.
  type FilterEntry = Record<string, FilterMode> // id → mode
  type ViewFiltersMap = Record<string, { statuses: FilterEntry, labels: FilterEntry, groupingMode?: ChatGroupingMode }>

  // Compute a stable key for the current chat filter view
  const sessionFilterKey = useMemo(() => {
    if (!sessionFilter) return null
    switch (sessionFilter.kind) {
      case 'allSessions': return 'allSessions'
      case 'flagged': return 'flagged'
      case 'archived': return 'archived'
      case 'state': return `state:${sessionFilter.stateId}`
      case 'label': return `label:${sessionFilter.labelId}`
      case 'view': return `view:${sessionFilter.viewId}`
      default: return 'allSessions'
    }
  }, [sessionFilter])

  const [viewFiltersMap, setViewFiltersMap] = React.useState<ViewFiltersMap>(() => {
    const saved = storage.get<ViewFiltersMap>(storage.KEYS.viewFilters, {})
    // Backward compat: migrate old format (arrays) into new format (Record<string, FilterMode>)
    if (saved.allSessions && Array.isArray((saved.allSessions as any).statuses)) {
      // Old format: { statuses: string[], labels: string[] } → new: { statuses: Record, labels: Record }
      for (const key of Object.keys(saved)) {
        const entry = saved[key] as any
        if (Array.isArray(entry.statuses)) {
          const newStatuses: FilterEntry = {}
          for (const id of entry.statuses) newStatuses[id] = 'include'
          const newLabels: FilterEntry = {}
          for (const id of entry.labels) newLabels[id] = 'include'
          saved[key] = { statuses: newStatuses, labels: newLabels }
        }
      }
    }
    // Also migrate legacy global filters if no allSessions entry exists
    if (!saved.allSessions) {
      const oldStatuses = storage.get<SessionStatusId[]>(storage.KEYS.listFilter, [])
      const oldLabels = storage.get<string[]>(storage.KEYS.labelFilter, [])
      if (oldStatuses.length > 0 || oldLabels.length > 0) {
        const statuses: FilterEntry = {}
        for (const id of oldStatuses) statuses[id] = 'include'
        const labels: FilterEntry = {}
        for (const id of oldLabels) labels[id] = 'include'
        saved.allSessions = { statuses, labels }
      }
    }
    return saved
  })

  // Derive current view's status filter as a Map<SessionStatusId, FilterMode>
  const listFilter = useMemo(() => {
    if (!sessionFilterKey) return new Map<SessionStatusId, FilterMode>()
    const entry = viewFiltersMap[sessionFilterKey]?.statuses ?? {}
    return new Map<SessionStatusId, FilterMode>(Object.entries(entry) as [SessionStatusId, FilterMode][])
  }, [viewFiltersMap, sessionFilterKey])

  // Derive current view's label filter as a Map<string, FilterMode>
  const labelFilter = useMemo(() => {
    if (!sessionFilterKey) return new Map<string, FilterMode>()
    const entry = viewFiltersMap[sessionFilterKey]?.labels ?? {}
    return new Map<string, FilterMode>(Object.entries(entry) as [string, FilterMode][])
  }, [viewFiltersMap, sessionFilterKey])

  // Setter for status filter — updates only the current view's entry in the map
  const setListFilter = useCallback((updater: Map<SessionStatusId, FilterMode> | ((prev: Map<SessionStatusId, FilterMode>) => Map<SessionStatusId, FilterMode>)) => {
    setViewFiltersMap(prev => {
      if (!sessionFilterKey) return prev
      const current = new Map<SessionStatusId, FilterMode>(Object.entries(prev[sessionFilterKey]?.statuses ?? {}) as [SessionStatusId, FilterMode][])
      const next = typeof updater === 'function' ? updater(current) : updater
      return {
        ...prev,
        [sessionFilterKey]: { statuses: Object.fromEntries(next), labels: prev[sessionFilterKey]?.labels ?? {} }
      }
    })
  }, [sessionFilterKey])

  // Setter for label filter — updates only the current view's entry in the map
  const setLabelFilter = useCallback((updater: Map<string, FilterMode> | ((prev: Map<string, FilterMode>) => Map<string, FilterMode>)) => {
    setViewFiltersMap(prev => {
      if (!sessionFilterKey) return prev
      const current = new Map<string, FilterMode>(Object.entries(prev[sessionFilterKey]?.labels ?? {}) as [string, FilterMode][])
      const next = typeof updater === 'function' ? updater(current) : updater
      return {
        ...prev,
        [sessionFilterKey]: { statuses: prev[sessionFilterKey]?.statuses ?? {}, labels: Object.fromEntries(next) }
      }
    })
  }, [sessionFilterKey])
  // Search state for session list
  const [searchActive, setSearchActive] = useAtom(sessionListSearchActiveAtom)
  const [searchQuery, setSearchQuery] = useAtom(sessionListSearchQueryAtom)
  const [globalSearchOpen, setGlobalSearchOpen] = React.useState(false)
  React.useEffect(() => {
    if (openGlobalSearchSignal > 0) {
      setGlobalSearchOpen(true)
    }
  }, [openGlobalSearchSignal])

  // Grouping mode for chat list: per-view (stored in viewFiltersMap), forced to 'date' for state sub-views
  const isStateSubView = sessionFilter?.kind === 'state'

  const chatGroupingMode: ChatGroupingMode = isStateSubView
    ? 'date'
    : (viewFiltersMap[sessionFilterKey ?? '']?.groupingMode ?? 'date')

  const setChatGroupingMode = useCallback((mode: ChatGroupingMode) => {
    setViewFiltersMap(prev => {
      if (!sessionFilterKey) return prev
      const existing = prev[sessionFilterKey] ?? { statuses: {}, labels: {} }
      return {
        ...prev,
        [sessionFilterKey]: { ...existing, groupingMode: mode }
      }
    })
  }, [sessionFilterKey])

  // Ref for ChatDisplay navigation (exposed via forwardRef)
  const chatDisplayRef = React.useRef<ChatDisplayHandle>(null)
  // Track match count and index from ChatDisplay (for SessionList navigation UI)
  const [chatMatchInfo, setChatMatchInfo] = React.useState<{ sessionId: string | null; count: number; index: number; isHighlighting?: boolean }>({ sessionId: null, count: 0, index: 0 })

  // Callback for immediate match info updates from ChatDisplay
  // Memo guard prevents render feedback loops from identical updates
  const handleChatMatchInfoChange = React.useCallback((info: { sessionId: string | null; count: number; index: number; isHighlighting: boolean }) => {
    setChatMatchInfo(prev => {
      if (prev.sessionId === info.sessionId && prev.count === info.count && prev.isHighlighting === info.isHighlighting) {
        return prev
      }
      return info
    })
  }, [])

  // Reset match info when search is deactivated
  React.useEffect(() => {
    if (!searchActive || !searchQuery) {
      setChatMatchInfo(prev => {
        if (prev.sessionId === null && prev.count === 0 && prev.index === 0) {
          return prev
        }
        return { sessionId: null, count: 0, index: 0 }
      })
    }
  }, [searchActive, searchQuery])

  // Filter dropdown: inline search query for filtering statuses/labels in a flat list.
  // When empty, the dropdown shows hierarchical submenus. When typing, shows a flat filtered list.
  const [filterDropdownQuery, setFilterDropdownQuery] = React.useState('')
  const [filterAltHeld, setFilterAltHeld] = React.useState(false)

  // Reset search only when navigator or filter changes (not when selecting sessions)
  const navFilterKey = React.useMemo(() => {
    if (isSessionsNavigation(navState)) {
      const filter = navState.filter
      return `chats:${filter.kind}:${filter.kind === 'state' ? filter.stateId : ''}`
    }
    return navState.navigator
  }, [navState])

  React.useEffect(() => {
    setSearchActive(false)
    setSearchQuery('')
  }, [navFilterKey])

  // Cmd+F opens the global search surface; the sidebar menu still owns local list search.
  useAction('app.search', () => setGlobalSearchOpen(true))

  // Unified sidebar keyboard navigation state. Expansion uses one positive,
  // workspace-scoped set so persisted state and rendered state cannot diverge.
  const [expandedFolders, setExpandedFolders] = React.useState<Set<string>>(() => {
    const persistedExpandedFolders = activeWorkspaceId
      ? storage.get<string[] | null>(storage.KEYS.expandedFolders, null, activeWorkspaceId)
      : null
    return new Set(persistedExpandedFolders ?? (activeWorkspaceId ? getDefaultWritingExpandedIds(activeWorkspaceId) : []))
  })
  const workspaceFileTreeRef = React.useRef<WorkspaceFileTreeHandle>(null)
  const handleWorkspaceTreeExpandedChange = React.useCallback((id: string, expanded: boolean) => {
    setExpandedFolders(prev => {
      if (prev.has(id) === expanded) return prev
      const next = new Set(prev)
      if (expanded) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  // Sources state (workspace-scoped)
  const [sources, setSources] = React.useState<LoadedSource[]>([])
  // Sync sources to atom for NavigationContext auto-selection
  const setSourcesAtom = useSetAtom(sourcesAtom)
  React.useEffect(() => {
    setSourcesAtom(sources)
  }, [sources, setSourcesAtom])

  // Skills state (workspace-scoped)
  const [skills, setSkills] = React.useState<LoadedSkill[]>([])
  // Sync skills to atom for NavigationContext auto-selection
  const setSkillsAtom = useSetAtom(skillsAtom)
  React.useEffect(() => {
    setSkillsAtom(skills)
  }, [skills, setSkillsAtom])
  // Automations — state, handlers, loading, subscriptions
  // Send to Workspace dialog state (driven by sendToWorkspaceAtom set from SessionMenu/BatchSessionMenu)
  const sendToWorkspaceIds = useAtomValue(sendToWorkspaceAtom)
  const setSendToWorkspaceIds = useSetAtom(sendToWorkspaceAtom)
  const handleTransferComplete = useCallback((targetWorkspaceId: string, _newSessionIds: string[]) => {
    if (targetWorkspaceId === FREE_CONVERSATION_WORKSPACE_ID) {
      onOpenFreeConversations()
      return
    }
    onSelectWorkspace(targetWorkspaceId)
  }, [onOpenFreeConversations, onSelectWorkspace])
  const {
    automations, automationTestResults,
    automationPendingDelete, pendingDeleteAutomation, setAutomationPendingDelete,
    handleTestAutomation, handleToggleAutomation, handleDuplicateAutomation, handleDeleteAutomation, confirmDeleteAutomation,
    getAutomationHistory, handleReplayAutomation,
  } = useAutomations(projectWorkspaceId)

  // Whether local MCP servers are enabled (affects stdio source status)
  const [localMcpEnabled, setLocalMcpEnabled] = React.useState(false)

  const enabledModes = PERMISSION_MODE_ORDER

  // Load workspace settings on workspace change
  React.useEffect(() => {
    if (!projectWorkspaceId) {
      setLocalMcpEnabled(true)
      return
    }
    let cancelled = false
    window.electronAPI.getWorkspaceSettings(projectWorkspaceId).then((settings) => {
      if (!cancelled && settings) {
        setLocalMcpEnabled(settings.localMcpEnabled ?? false)
      }
    }).catch((err) => {
      console.error('[Chat] Failed to load workspace settings:', err)
    })
    return () => { cancelled = true }
  }, [projectWorkspaceId])

  // Reset UI state when workspace changes
  // This prevents stale search queries, focused items, and filter state from persisting
  const previousWorkspaceRef = React.useRef<string | null>(null)
  const skillDiscoveryCwdRef = React.useRef<string | undefined>(undefined)
  React.useEffect(() => {
    if (!activeWorkspaceId) return

    const previousWorkspaceId = previousWorkspaceRef.current

    // Clear transient UI state only on workspace SWITCH (not initial mount)
    if (previousWorkspaceId !== null && previousWorkspaceId !== activeWorkspaceId) {
      setSources([])
      setSkills([])

      // Clear search state
      setSearchActive(false)
      setSearchQuery('')

      // Clear filter dropdown state
      setFilterDropdownQuery('')
      setFilterDropdownSelectedIdx(0)

    }

    // Load workspace-scoped state on BOTH initial mount AND workspace switch
    // This fixes CMD+R losing filters - previously only ran on workspace switch
    if (previousWorkspaceId !== activeWorkspaceId) {
      const newViewFilters = storage.get<ViewFiltersMap>(storage.KEYS.viewFilters, {}, activeWorkspaceId)
      setViewFiltersMap(newViewFilters)

      const persistedExpandedFolders = storage.get<string[] | null>(storage.KEYS.expandedFolders, null, activeWorkspaceId)
      setExpandedFolders(new Set(persistedExpandedFolders ?? getDefaultWritingExpandedIds(activeWorkspaceId)))

    }

    previousWorkspaceRef.current = activeWorkspaceId
  }, [activeWorkspaceId])

  // Load sources from backend on mount
  React.useEffect(() => {
    if (!activeWorkspaceId) return
    let cancelled = false
    window.electronAPI.getSources(activeWorkspaceId).then((loaded) => {
      if (!cancelled) setSources(loaded || [])
    }).catch(err => {
      console.error('[Chat] Failed to load sources:', err)
    })
    return () => { cancelled = true }
  }, [activeWorkspaceId])

  // Subscribe to live source updates (when sources are added/removed dynamically)
  React.useEffect(() => {
    const cleanup = window.electronAPI.onSourcesChanged((workspaceId, updatedSources) => {
      if (workspaceId !== activeWorkspaceId) return
      // Clear icon cache so updated source icons are re-fetched on render
      clearSourceIconCaches()
      setSources(updatedSources || [])
    })
    return cleanup
  }, [activeWorkspaceId])

  // Subscribe to live skill updates (when skills are added/removed dynamically)
  React.useEffect(() => {
    let cancelled = false
    const cleanup = window.electronAPI.onSkillsChanged((workspaceId) => {
      if (!activeWorkspaceId || workspaceId !== activeWorkspaceId) return
      invalidateWorkspaceSkillsCache(workspaceId)
      loadSkillsForWorkspace(workspaceId, skillDiscoveryCwdRef.current).then((loaded) => {
        if (!cancelled) setSkills(loaded || [])
      }).catch(err => {
        if (cancelled) return
        console.error('[Chat] Failed to refresh skills:', err)
      })
    })
    return () => {
      cancelled = true
      cleanup()
    }
  }, [activeWorkspaceId])

  // Handle session source selection changes
  const handleSessionSourcesChange = React.useCallback(async (sessionId: string, sourceSlugs: string[]) => {
    try {
      await window.electronAPI.sessionCommand(sessionId, { type: 'setSources', sourceSlugs })
      // Session will emit a 'sources_changed' event that updates the session state
    } catch (err) {
      console.error('[Chat] Failed to set session sources:', err)
    }
  }, [])

  // Handle session label changes (add/remove via # menu or badge X)
  const handleSessionLabelsChange = React.useCallback(async (sessionId: string, labels: string[]) => {
    try {
      await window.electronAPI.sessionCommand(sessionId, { type: 'setLabels', labels })
      // Session will emit a 'labels_changed' event that updates the session state
    } catch (err) {
      console.error('[Chat] Failed to set session labels:', err)
    }
  }, [])


  // Load dynamic statuses from workspace config
  const { statuses: statusConfigs } = useStatuses(projectWorkspaceId)

  // Convert StatusConfig to SessionStatus with resolved icons
  const sessionStatuses = React.useMemo(() => {
    if (!projectWorkspaceId || statusConfigs.length === 0) {
      return []
    }

    return statusConfigsToSessionStatuses(statusConfigs, projectWorkspaceId, isDark)
  }, [statusConfigs, projectWorkspaceId, isDark])

  // Load labels from workspace config
  const { labels: labelConfigs } = useLabels(projectWorkspaceId)
  const displayLabelConfigs = useMemo(() => sortLabelsForDisplay(labelConfigs), [labelConfigs])

  // Views: compiled once on config load, evaluated per session in list/chat
  const { evaluateSession: evaluateViews, viewConfigs } = useViews(projectWorkspaceId)

  // Build flat LabelMenuItem[] from hierarchical labels for the filter dropdown's search mode.
  // Uses the same structure as the # inline menu so the two search surfaces stay aligned.
  const flatLabelMenuItems = useMemo(
    (): LabelMenuItem[] => createLabelMenuItems(displayLabelConfigs),
    [displayLabelConfigs],
  )
  const labelConfigById = useMemo(
    () => new Map(flatLabelMenuItems.map(item => [item.id, item.config])),
    [flatLabelMenuItems],
  )
  const activeStatusFilters = useMemo(() => {
    const filters: { state: SessionStatus; mode: FilterMode }[] = []
    for (const state of sessionStatuses) {
      const mode = listFilter.get(state.id)
      if (mode) filters.push({ state, mode })
    }
    return filters
  }, [sessionStatuses, listFilter])
  const activeLabelFilters = useMemo(() => {
    const filters: { label: LabelConfig; mode: FilterMode }[] = []
    for (const [labelId, mode] of labelFilter) {
      const label = labelConfigById.get(labelId)
      if (label) filters.push({ label, mode })
    }
    return filters
  }, [labelFilter, labelConfigById])

  // Filter dropdown keyboard navigation: tracks highlighted item index in flat search mode.
  // Unified index: [0..matchedStates-1] = statuses, [matchedStates..total-1] = labels.
  const [filterDropdownSelectedIdx, setFilterDropdownSelectedIdx] = React.useState(0)
  const filterDropdownListRef = React.useRef<HTMLDivElement>(null)
  const filterDropdownInputRef = React.useRef<HTMLInputElement>(null)

  // Compute filtered results for the dropdown's search mode (memoized for use in both
  // the keyboard handler and the JSX render).
  const filterDropdownResults = useMemo(() => {
    if (!filterDropdownQuery.trim()) return { states: [] as SessionStatus[], labels: [] as LabelMenuItem[] }
    return {
      states: filterLabelMenuStates(sessionStatuses, filterDropdownQuery),
      labels: filterLabelMenuItems(flatLabelMenuItems, filterDropdownQuery),
    }
  }, [filterDropdownQuery, sessionStatuses, flatLabelMenuItems])

  // Reset selected index when query changes
  React.useEffect(() => {
    setFilterDropdownSelectedIdx(0)
  }, [filterDropdownQuery])

  // Scroll keyboard-highlighted item into view
  React.useEffect(() => {
    if (!filterDropdownListRef.current) return
    const el = filterDropdownListRef.current.querySelector('[data-filter-selected="true"]')
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [filterDropdownSelectedIdx])

  // Ensure session messages are loaded when selected; evict out-of-working-set transcripts.
  const ensureMessagesLoaded = useSetAtom(ensureSessionMessagesLoadedAtom)
  const reconcileSessionTranscriptWorkingSet = useSetAtom(reconcileSessionTranscriptWorkingSetAtom)

  // Handle selecting a source from the list (preserves current filter type)
  const handleSourceSelect = React.useCallback((source: LoadedSource) => {
    if (!activeWorkspaceId) return
    navigateToSource(source.config.slug)
  }, [activeWorkspaceId, navigateToSource])

  // Handle selecting an automation from the list
  const handleAutomationSelect = React.useCallback((automationId: string) => {
    // Preserve current automation filter when selecting an automation
    const type = isAutomationsNavigation(navState) ? navState.filter?.automationType : undefined
    navigate(routes.view.automations({ automationId, type }))
  }, [navState, navigate])

  // Focus zone management
  const { focusZone, focusNextZone, focusPreviousZone } = useFocusActions()

  // Register focus zones
  const { zoneRef: sidebarRef, isFocused: sidebarFocused } = useFocusZone({ zoneId: 'sidebar' })

  // Global keyboard shortcuts using centralized action registry
  // Actions are defined in @/actions/definitions.ts

  // Zone navigation - explicit keyboard intent, always move DOM focus
  useAction('nav.focusSidebar', () => focusZone('sidebar', { intent: 'keyboard' }))
  useAction('nav.focusNavigator', () => focusZone('navigator', { intent: 'keyboard' }))
  useAction('nav.focusChat', () => focusZone('chat', { intent: 'keyboard' }))

  // Tab navigation between zones
  useAction('nav.nextZone', () => {
    focusNextZone()
  }, { enabled: () => !hasBlockingFocusDialog() })

  useAction('nav.previousZone', () => {
    focusPreviousZone()
  }, { enabled: () => !hasBlockingFocusDialog() })

  // Shift+Tab cycles permission mode through enabled modes (textarea handles its own, this handles when focus is elsewhere)
  // In multi-panel, targets the focused panel's session
  const rawEffectiveSessionId = focusedSessionId ?? session.selected
  const rawEffectiveSessionMeta = useAtomValue(sessionMetaAtomFamily(rawEffectiveSessionId ?? '__missing__'))
  const rawEffectiveSessionBelongsToWorkspace = !!rawEffectiveSessionMeta && (
    rawEffectiveSessionMeta?.workspaceId === activeWorkspaceId
    || (!!remoteWorkspaceId && rawEffectiveSessionMeta?.workspaceId === remoteWorkspaceId)
  )
  const effectiveSessionId = rawEffectiveSessionBelongsToWorkspace ? rawEffectiveSessionId : null

  // Focus chat input for the target session only (multi-panel safe).
  const focusChatInputForSession = useCallback((targetSessionId?: string | null) => {
    if (!targetSessionId) return
    dispatchFocusInputEvent({ sessionId: targetSessionId })
  }, [])

  useAction('chat.cyclePermissionMode', () => {
    if (effectiveSessionId) {
      const currentOptions = store.get(sessionOptionsAtomFamily(effectiveSessionId))
      const currentMode = currentOptions.permissionMode
      // Cycle through enabled permission modes
      const modes = enabledModes
      const currentIndex = modes.indexOf(currentMode)
      // If current mode not in enabled list, jump to first enabled mode
      const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % modes.length
      const nextMode = modes[nextIndex]
      contextValue.onSessionOptionsChange(effectiveSessionId, { permissionMode: nextMode })
    }
  })

  const handleToggleSidebar = useCallback(() => {
    // With the foundation activity rail owning conversation navigation, ⌘B
    // collapses that rail. Writing catalog chrome still uses isSidebarVisible.
    if (showActivityRail && hideSessionListNavigator) {
      setIsActivityRailVisible(v => !v)
      return
    }
    setIsSidebarVisible(v => !v)
  }, [hideSessionListNavigator, showActivityRail])

  // Sidebar toggle (CMD+B)
  useAction('view.toggleSidebar', handleToggleSidebar)

  // Panel focus navigation (CMD+SHIFT+[ / ])
  const focusNextPanel = useSetAtom(focusNextPanelAtom)
  const focusPrevPanel = useSetAtom(focusPrevPanelAtom)
  useAction('panel.focusNext', focusNextPanel, { enabled: () => panelCount > 1 })
  useAction('panel.focusPrev', focusPrevPanel, { enabled: () => panelCount > 1 })

  const cycleSession = useCallback((direction: 1 | -1) => {
    if (!activeWorkspaceId) return

    const sessionIds = [...store.get(sessionMetaMapAtom).values()]
      .filter(meta => meta.workspaceId === activeWorkspaceId
        && !meta.hidden
        && meta.isArchived !== true
        && hasSessionHistoryContent(meta))
      .sort((left, right) => (right.lastMessageAt ?? right.createdAt ?? 0) - (left.lastMessageAt ?? left.createdAt ?? 0))
      .map(meta => meta.id)

    if (sessionIds.length < 2) return

    const currentSessionId = focusedSessionId ?? session.selected
    const currentIndex = currentSessionId ? sessionIds.indexOf(currentSessionId) : -1
    const nextIndex = currentIndex === -1
      ? direction === 1 ? 0 : sessionIds.length - 1
      : (currentIndex + direction + sessionIds.length) % sessionIds.length
    const nextSessionId = sessionIds[nextIndex]
    if (nextSessionId) {
      navigateToSessionInPanel(nextSessionId)
      requestAnimationFrame(() => focusChatInputForSession(nextSessionId))
    }
  }, [activeWorkspaceId, focusChatInputForSession, focusedSessionId, navigateToSessionInPanel, session.selected, store])

  useAction('nav.nextSession', () => cycleSession(1))
  useAction('nav.previousSession', () => cycleSession(-1))

  // New chat
  useAction('app.newChat', () => handleNewChat())
  useAction('app.newChatInPanel', () => handleNewChat(true))

  // Settings
  useAction('app.settings', onOpenSettings)

  // Keyboard shortcuts
  useAction('app.keyboardShortcuts', onOpenKeyboardShortcuts)

  // New window
  useAction('app.newWindow', () => window.electronAPI.menuNewWindow())

  // Quit (note: also handled by native menu on macOS)
  useAction('app.quit', () => window.electronAPI.menuQuit())

  // History navigation
  useAction('nav.goBack', goBack)
  useAction('nav.goForward', goForward)

  // History navigation (arrow key alternatives)
  useAction('nav.goBackAlt', goBack)
  useAction('nav.goForwardAlt', goForward)

  // Search match navigation (CMD+G next, CMD+SHIFT+G prev)
  useAction('chat.nextSearchMatch', () => chatDisplayRef.current?.goToNextMatch(), {
    enabled: () => searchActive && (chatMatchInfo.count ?? 0) > 0
  })
  useAction('chat.prevSearchMatch', () => chatDisplayRef.current?.goToPrevMatch(), {
    enabled: () => searchActive && (chatMatchInfo.count ?? 0) > 0
  })

  // ESC to stop processing - requires double-press within 1 second
  // First press shows warning overlay, second press interrupts
  // In multi-panel, targets the focused panel's session
  useAction('chat.stopProcessing', () => {
    if (effectiveSessionId && rawEffectiveSessionMeta?.isProcessing) {
      // handleEscapePress returns true on second press (within timeout)
      const shouldInterrupt = handleEscapePress()
      if (shouldInterrupt) {
        window.electronAPI.cancelProcessing(effectiveSessionId, false).catch(err => {
          console.error('[AppShell] Failed to cancel processing:', err)
        })
      }
    }
  }, {
    // Only active when no overlay is open and session is processing
    // Overlays (dialogs, menus, popovers, etc.) should handle their own Escape
    enabled: () => {
      if (hasOpenOverlay()) return false
      if (!effectiveSessionId) return false
      return rawEffectiveSessionMeta?.isProcessing ?? false
    }
  }, [effectiveSessionId, handleEscapePress, rawEffectiveSessionMeta?.isProcessing])

  // Theme toggle (CMD+SHIFT+A)
  useAction('app.toggleTheme', () => setMode(resolvedMode === 'dark' ? 'light' : 'dark'))

  // Global paste listener for file attachments
  // Fires when Cmd+V is pressed anywhere in the app (not just textarea)
  React.useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
      // Skip if a dialog or menu is open
      if (document.querySelector('[role="dialog"], [role="menu"]')) {
        return
      }

      // Skip if there are no files in the clipboard
      const files = e.clipboardData?.files
      if (!files || files.length === 0) return

      // Skip if the active element is an input/textarea/contenteditable (let it handle paste directly)
      const activeElement = document.activeElement as HTMLElement | null
      if (
        activeElement?.tagName === 'TEXTAREA' ||
        activeElement?.tagName === 'INPUT' ||
        activeElement?.isContentEditable
      ) {
        return
      }

      // Prevent default paste behavior
      e.preventDefault()

      // Dispatch custom event for FreeFormInput to handle (target focused session only)
      const filesArray = Array.from(files)
      const targetSessionId = focusedSessionId ?? session.selected
      if (!targetSessionId) return
      window.dispatchEvent(new CustomEvent('craft:paste-files', {
        detail: { files: filesArray, sessionId: targetSessionId }
      }))
    }

    document.addEventListener('paste', handleGlobalPaste)
    return () => document.removeEventListener('paste', handleGlobalPaste)
  }, [focusedSessionId, session.selected])

  React.useEffect(() => {
    latestSessionListWidthRef.current = sessionListWidth
  }, [sessionListWidth])

  React.useEffect(() => {
    latestNovelWorkspaceNavigatorWidthRef.current = novelWorkspaceNavigatorWidth
  }, [novelWorkspaceNavigatorWidth])

  React.useEffect(() => {
    latestWorkspaceDirectoryWidthRef.current = workspaceDirectoryWidth
  }, [workspaceDirectoryWidth])

  React.useEffect(() => {
    storage.set(storage.KEYS.writingWorkspaceVisible, rightWorkspaceVisible)
  }, [rightWorkspaceVisible])

  React.useEffect(() => {
    storage.set(storage.KEYS.workspaceDirectoryVisible, workspaceDirectoryVisible)
  }, [workspaceDirectoryVisible])

  const beginResize = React.useCallback((
    mode: 'session-list' | 'novel-workspace-navigator' | 'document-dock' | 'directory-dock',
    e: React.MouseEvent<HTMLDivElement>
  ) => {
    e.preventDefault()
    e.stopPropagation()
    setIsResizing(mode)

    // Capture the drag baseline for delta-based columns. Both the manuscript and
    // the directory carry their resize handle on the left edge and grow as it
    // moves left, so width = startWidth + (startX - clientX).
    resizeStartXRef.current = e.clientX
    resizeStartWidthRef.current = mode === 'directory-dock'
      ? latestWorkspaceDirectoryWidthRef.current
      : latestNovelWorkspaceNavigatorWidthRef.current

    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const updateHandleY = (clientY: number) => {
      const handle = sessionListHandleRef.current
      if (!handle) return
      const rect = handle.getBoundingClientRect()
      setSessionListHandleY(clientY - rect.top)
    }

    const updateWidth = (clientX: number) => {
      // Both right-side columns carry their handle on the left edge and grow as
      // it moves left, so they share one delta rule (width = start + drag). The
      // math is position-independent, so it works whether the column hugs the
      // window edge (directory) or floats between chat and directory (manuscript).
      // Only the bounds and the target state differ, so they live in a per-mode
      // config rather than a second branch.
      if (mode === 'directory-dock' || mode === 'document-dock') {
        const delta = resizeStartXRef.current - clientX
        const raw = resizeStartWidthRef.current + delta
        if (mode === 'directory-dock') {
          const nextWidth = Math.min(Math.max(raw, WORKSPACE_DIRECTORY_MIN_WIDTH), WORKSPACE_DIRECTORY_MAX_WIDTH)
          latestWorkspaceDirectoryWidthRef.current = nextWidth
          setWorkspaceDirectoryWidth(nextWidth)
          return
        }
        const directoryReserve = rightWorkspaceVisible
          ? workspaceDirectoryWidth + PANEL_GAP
          : 0
        const maxDocumentWidth = Math.max(
          NOVEL_WORKSPACE_NAVIGATOR_MIN_WIDTH,
          shellWidth - activityRailOffset - visibleSessionListWidth - WRITING_ASSISTANT_MIN_WIDTH - directoryReserve - (PANEL_GAP * 2) - PANEL_EDGE_INSET,
        )
        const nextWidth = Math.min(Math.max(raw, NOVEL_WORKSPACE_NAVIGATOR_MIN_WIDTH), maxDocumentWidth)
        latestNovelWorkspaceNavigatorWidthRef.current = nextWidth
        setNovelWorkspaceNavigatorWidth(nextWidth)
        return
      }

      const minWidth = mode === 'novel-workspace-navigator'
        ? NOVEL_WORKSPACE_NAVIGATOR_MIN_WIDTH
        : SESSION_LIST_MIN_WIDTH
      const maxWidth = mode === 'novel-workspace-navigator'
        ? Number.POSITIVE_INFINITY
        : SESSION_LIST_MAX_WIDTH
      const fallbackNavigatorStartX = activityRailOffset + PANEL_EDGE_INSET
      const navigatorStartX = navigatorPanelRef.current?.getBoundingClientRect().left ?? fallbackNavigatorStartX
      const effectiveMaxWidth = mode === 'novel-workspace-navigator'
        ? Math.max(
          minWidth,
          getNavigatorResizeMaxWidth({
            shellWidth,
            navigatorStartX,
            edgeInset: PANEL_EDGE_INSET,
            panelGap: PANEL_GAP,
            assistantMinWidth: PANEL_MIN_WIDTH,
          })
        )
        : maxWidth
      const newWidth = Math.min(
        Math.max(clientX - navigatorStartX - (PANEL_GAP / 2), minWidth),
        effectiveMaxWidth
      )
      if (mode === 'novel-workspace-navigator') {
        latestNovelWorkspaceNavigatorWidthRef.current = newWidth
        setNovelWorkspaceNavigatorWidth(newWidth)
        return
      }

      latestSessionListWidthRef.current = newWidth
      setSessionListWidth(newWidth)
    }

    const handleMouseMove = (event: MouseEvent) => {
      event.preventDefault()
      updateWidth(event.clientX)
      updateHandleY(event.clientY)
    }

    const handleMouseUp = () => {
      if (mode === 'directory-dock') {
        storage.set(storage.KEYS.workspaceDirectoryWidth, latestWorkspaceDirectoryWidthRef.current)
        setSessionListHandleY(null)
      } else if (mode === 'novel-workspace-navigator' || mode === 'document-dock') {
        storage.set(storage.KEYS.novelWorkspaceNavigatorWidth, latestNovelWorkspaceNavigatorWidthRef.current)
        setSessionListHandleY(null)
      } else {
        storage.set(storage.KEYS.sessionListWidth, latestSessionListWidthRef.current)
        setSessionListHandleY(null)
      }

      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      setIsResizing(null)
      document.removeEventListener('mousemove', handleMouseMove, true)
      document.removeEventListener('mouseup', handleMouseUp, true)
    }

    updateHandleY(e.clientY)
    document.addEventListener('mousemove', handleMouseMove, true)
    document.addEventListener('mouseup', handleMouseUp, true)
  }, [activityRailOffset, rightWorkspaceVisible, shellWidth, visibleSessionListWidth, workspaceDirectoryWidth])

  const effectiveSessionAtom = React.useMemo(
    () => sessionAtomFamily(effectiveSessionId ?? '__missing__'),
    [effectiveSessionId]
  )
  const effectiveSessionProcessingAtom = React.useMemo(
    () => selectAtom(effectiveSessionAtom, session => session?.isProcessing === true, Object.is),
    [effectiveSessionAtom]
  )
  const effectiveSessionFolderPathAtom = React.useMemo(
    () => selectAtom(effectiveSessionAtom, session => session?.sessionFolderPath, Object.is),
    [effectiveSessionAtom]
  )
  const effectiveSessionFileChangeKeyAtom = React.useMemo(
    () => selectAtom(effectiveSessionAtom, getNovelFileChangeActivityKey, Object.is),
    [effectiveSessionAtom]
  )
  const effectiveSessionMessageCountAtom = React.useMemo(
    () => selectAtom(effectiveSessionAtom, session => session?.messages?.length ?? 0, Object.is),
    [effectiveSessionAtom]
  )
  const effectiveSessionIsProcessing = useAtomValue(effectiveSessionProcessingAtom)
  const effectiveSessionFolderPath = useAtomValue(effectiveSessionFolderPathAtom)
  const novelFileChangeActivityKey = useAtomValue(effectiveSessionFileChangeKeyAtom)
  const effectiveSessionMessageCount = useAtomValue(effectiveSessionMessageCountAtom)
  const [snapshotNovelFileChanges, setSnapshotNovelFileChanges] = React.useState<FileChange[]>([])
  const [snapshotNovelRevert, setSnapshotNovelRevert] = React.useState<{
    sessionId: string
    changePaths: string[]
    plans: FileRevertPlan[]
  } | null>(null)
  const [conversationDiffReview, setConversationDiffReview] = React.useState<{
    sessionId: string
    changes: FileChange[]
  } | null>(null)

  // The working directory anchors file changes and Pi project Skill discovery.
  const activeSessionWorkingDirectory = effectiveSessionId
    ? rawEffectiveSessionMeta?.workingDirectory
    : undefined
  skillDiscoveryCwdRef.current = activeSessionWorkingDirectory || activeWorkspace?.rootPath
  const activeWritingWorkspaceRoot = isProjectRuntime
    && activeWorkspace
    ? activeWorkspace.rootPath
    : null

  const latestNovelFileChanges = React.useMemo<FileChange[]>(() => {
    const effectiveSession = store.get(effectiveSessionAtom)
    if (!effectiveSession?.messages?.length) return []

    return getLatestNovelFileChangesFromMessages({
      messages: effectiveSession.messages,
      basePath: activeSessionWorkingDirectory || effectiveSessionFolderPath,
      fallbackChanges: snapshotNovelFileChanges,
    })
  }, [activeSessionWorkingDirectory, effectiveSessionAtom, effectiveSessionFolderPath, novelFileChangeActivityKey, snapshotNovelFileChanges, store])
  const latestNovelFileChangesSignature = React.useMemo(
    () => latestNovelFileChanges
      .map(change => `${change.id}:${change.filePath}:${change.changeKind}:${change.error ?? ''}`)
      .join('\n'),
    [latestNovelFileChanges]
  )

  const novelWorkspaceCandidateRoots = React.useMemo(
    () => getNovelWorkspaceCandidateRoots({
      activeWorkspaceRootPath: activeWritingWorkspaceRoot ?? undefined,
      sessionWorkingDirectory: undefined,
    }),
    [activeWritingWorkspaceRoot]
  )
  const novelWorkspaceCandidateKey = React.useMemo(
    () => novelWorkspaceCandidateRoots.join('\0'),
    [novelWorkspaceCandidateRoots]
  )
  const [novelWorkspaceRoot, setNovelWorkspaceRoot] = React.useState<string | null>(null)
  const [novelWorkspaceFiles, setNovelWorkspaceFiles] = React.useState<NovelWorkspaceFile[]>([])
  const [novelWorkspaceDirectories, setNovelWorkspaceDirectories] = React.useState<string[]>([])
  const setNovelWorkspaceCatalogIfChanged = React.useCallback((catalog: NativeWorkspaceCatalog) => {
    setNovelWorkspaceFiles((previous) => areNovelWorkspaceFilesEqual(previous, catalog.files) ? previous : catalog.files)
    setNovelWorkspaceDirectories((previous) => (
      previous.length === catalog.directories.length
      && previous.every((directory, index) => directory === catalog.directories[index])
    ) ? previous : catalog.directories)
  }, [])
  const [novelWorkspaceDetecting, setNovelWorkspaceDetecting] = React.useState(false)
  const [novelWorkspaceDetectionSettledKey, setNovelWorkspaceDetectionSettledKey] = React.useState<string | null>(null)
  const novelWorkspaceRootRef = React.useRef<string | null>(null)
  const novelWorkspaceCatalogCacheRef = React.useRef<Map<string, NativeWorkspaceCatalog>>(new Map())
  const novelWorkspaceLoadInFlightRef = React.useRef<Map<string, Promise<NativeWorkspaceCatalog | null>>>(new Map())
  const novelWorkspaceRefreshInFlightRef = React.useRef<Map<string, Promise<boolean>>>(new Map())
  const novelWorkspaceCatalogRevisionRef = React.useRef<Map<string, number>>(new Map())
  const novelWorkspaceLastRefreshKeyRef = React.useRef<string | null>(null)
  const ensureNovelDocumentSavedRef = React.useRef<() => Promise<boolean>>(async () => true)
  const latestNovelFileChangesSignatureRef = React.useRef('')
  latestNovelFileChangesSignatureRef.current = latestNovelFileChangesSignature
  const [workspaceCreateEntryTarget, setWorkspaceCreateEntryTarget] = React.useState<WorkspaceCreateEntryTarget | null>(null)
  const [workspaceCreateEntryValue, setWorkspaceCreateEntryValue] = React.useState('')
  const [workspaceCreatingEntry, setWorkspaceCreatingEntry] = React.useState(false)
  const [novelProjectRenameOpen, setNovelProjectRenameOpen] = React.useState(false)
  const [novelProjectRenameValue, setNovelProjectRenameValue] = React.useState('')

  React.useEffect(() => {
    novelWorkspaceRootRef.current = novelWorkspaceRoot
  }, [novelWorkspaceRoot])

  const markNovelWorkspaceFileChangesCovered = React.useCallback((rootPath: string, signature = latestNovelFileChangesSignatureRef.current) => {
    if (!signature) return
    const refreshKey = `${rootPath}\n${signature}`
    novelWorkspaceLastRefreshKeyRef.current = refreshKey
    completedNovelFileChangeRefreshKeys.add(refreshKey)
  }, [])

  const invalidateNovelWorkspaceCatalogRequests = React.useCallback((rootPath: string) => {
    advanceWorkspaceCatalogRevision(novelWorkspaceCatalogRevisionRef.current, rootPath)
    novelWorkspaceCatalogCacheRef.current.delete(rootPath)
    novelWorkspaceRefreshInFlightRef.current.delete(rootPath)
    for (const loadKey of novelWorkspaceLoadInFlightRef.current.keys()) {
      if (loadKey.startsWith(`${rootPath}\n`)) {
        novelWorkspaceLoadInFlightRef.current.delete(loadKey)
      }
    }
  }, [])

  const loadNovelWorkspaceFiles = React.useCallback(async (
    rootPath: string,
    onDetected?: (files: NovelWorkspaceFile[]) => void,
    knownNovelWorkspace = false
  ): Promise<NativeWorkspaceCatalog | null> => {
    const loadKey = `${rootPath}\n${knownNovelWorkspace ? 'known' : 'detect'}`
    const inFlight = novelWorkspaceLoadInFlightRef.current.get(loadKey)
    if (inFlight) return inFlight

    const requestRevision = readWorkspaceCatalogRevision(
      novelWorkspaceCatalogRevisionRef.current,
      rootPath,
    )
    const loadPromise = (async (): Promise<NativeWorkspaceCatalog | null> => {
      if (knownNovelWorkspace) {
        const catalog = await loadNovelWorkspaceFileTree(rootPath)
        if (readWorkspaceCatalogRevision(novelWorkspaceCatalogRevisionRef.current, rootPath) !== requestRevision) {
          return null
        }
        novelWorkspaceCatalogCacheRef.current.set(rootPath, catalog)
        return catalog
      }

      const probeResultSets = await searchNovelWorkspaceFiles(rootPath,
        NOVEL_WORKSPACE_DETECTION_QUERIES.map((query) => ({
          query,
          options: { mode: 'path' as const, includeDescendants: false },
        }))
      )
      const probeResults = probeResultSets.flatMap(resultSet => resultSet.results)
      if (readWorkspaceCatalogRevision(novelWorkspaceCatalogRevisionRef.current, rootPath) !== requestRevision) {
        return null
      }
      if (!detectNovelProjectFromSearchResults(probeResults)) return null
      const probeFiles = mapSearchResultsToNovelWorkspaceFiles(probeResults)
      onDetected?.(probeFiles)

      const catalog = await loadNovelWorkspaceFileTree(rootPath)
      if (readWorkspaceCatalogRevision(novelWorkspaceCatalogRevisionRef.current, rootPath) !== requestRevision) {
        return null
      }
      novelWorkspaceCatalogCacheRef.current.set(rootPath, catalog)
      return catalog
    })()

    novelWorkspaceLoadInFlightRef.current.set(loadKey, loadPromise)
    loadPromise.finally(() => {
      if (novelWorkspaceLoadInFlightRef.current.get(loadKey) === loadPromise) {
        novelWorkspaceLoadInFlightRef.current.delete(loadKey)
      }
    })
    return loadPromise
  }, [])

  const refreshNovelWorkspaceFiles = React.useCallback(async (rootPath: string): Promise<boolean> => {
    const inFlight = novelWorkspaceRefreshInFlightRef.current.get(rootPath)
    if (inFlight) return inFlight

    const requestRevision = readWorkspaceCatalogRevision(
      novelWorkspaceCatalogRevisionRef.current,
      rootPath,
    )
    const refreshPromise = (async (): Promise<boolean> => {
      const detectLoadKey = `${rootPath}\ndetect`
      const detectInFlight = novelWorkspaceLoadInFlightRef.current.get(detectLoadKey)
      let catalog = detectInFlight
        ? await detectInFlight
        : await loadNovelWorkspaceFiles(
            rootPath,
            undefined,
            rootPath === novelWorkspaceRootRef.current || novelWorkspaceCatalogCacheRef.current.has(rootPath)
          )
      if (!catalog && detectInFlight) {
        catalog = await loadNovelWorkspaceFiles(rootPath, undefined, true)
      }
      if (!catalog) return false
      if (readWorkspaceCatalogRevision(novelWorkspaceCatalogRevisionRef.current, rootPath) !== requestRevision) {
        return false
      }
      if (novelWorkspaceRootRef.current && rootPath !== novelWorkspaceRootRef.current) return false

      setNovelWorkspaceRoot(rootPath)
      setNovelWorkspaceCatalogIfChanged(catalog)
      return true
    })()

    novelWorkspaceRefreshInFlightRef.current.set(rootPath, refreshPromise)
    refreshPromise.finally(() => {
      if (novelWorkspaceRefreshInFlightRef.current.get(rootPath) === refreshPromise) {
        novelWorkspaceRefreshInFlightRef.current.delete(rootPath)
      }
    })
    return refreshPromise
  }, [loadNovelWorkspaceFiles, setNovelWorkspaceCatalogIfChanged])

  const refreshNovelWorkspaceFilesAfterMutation = React.useCallback((rootPath: string): Promise<boolean> => {
    invalidateNovelWorkspaceCatalogRequests(rootPath)
    return refreshNovelWorkspaceFiles(rootPath).catch((error) => {
      console.warn('[AppShell] Failed to refresh workspace catalog after a confirmed mutation:', error)
      return false
    })
  }, [invalidateNovelWorkspaceCatalogRequests, refreshNovelWorkspaceFiles])

  const openWorkspaceCreateEntryDialog = React.useCallback((target: WorkspaceCreateEntryTarget) => {
    setWorkspaceCreateEntryTarget(target)
    setWorkspaceCreateEntryValue('')
  }, [])

  const expandWorkspaceTreeDirectory = React.useCallback((relativePath: string) => {
    const id = relativePath
      ? `writing:folder:${relativePath}`
      : `writing:project:${activeWorkspaceId}`
    setExpandedFolders(previous => {
      if (previous.has(id)) return previous
      const next = new Set(previous)
      next.add(id)
      return next
    })
    requestAnimationFrame(() => workspaceFileTreeRef.current?.open(id))
  }, [activeWorkspaceId])

  const handleSubmitWorkspaceCreateEntry = React.useCallback(async () => {
    if (!novelWorkspaceRoot || !workspaceCreateEntryTarget) return

    const relativePath = resolveWorkspaceCreateRelativePath(
      workspaceCreateEntryTarget.parentRelativePath,
      workspaceCreateEntryValue,
      workspaceCreateEntryTarget.kind,
    )
    if (!relativePath) {
      toast.error(workspaceCreateEntryTarget.kind === 'file'
        ? t('writing.createFile.invalidName', '请输入有效文件名')
        : t('writing.createFolder.invalidName', '请输入有效文件夹名称'))
      return
    }
    const relativePathKey = getWorkspaceRelativePathKey(relativePath)
    const entryExists = novelWorkspaceFiles.some(file => getWorkspaceRelativePathKey(file.relativePath) === relativePathKey)
      || novelWorkspaceDirectories.some(directory => getWorkspaceRelativePathKey(directory) === relativePathKey)
    if (entryExists) {
      toast.error(workspaceCreateEntryTarget.kind === 'file'
        ? t('writing.createFile.exists', '文件已存在')
        : t('writing.createFolder.exists', '同名文件或文件夹已存在'))
      return
    }

    const targetPath = joinWorkspacePath(novelWorkspaceRoot, relativePath)
    if (workspaceCreateEntryTarget.kind === 'file' && !await ensureNovelDocumentSavedRef.current()) return
    setWorkspaceCreatingEntry(true)
    try {
      if (workspaceCreateEntryTarget.kind === 'directory') {
        await window.electronAPI.createDirectory(targetPath)
      } else {
        const parentRelativePath = getParentRelativePath(relativePath)
        const parentPath = joinWorkspacePath(novelWorkspaceRoot, parentRelativePath)
        const title = getMarkdownTitleFromRelativePath(relativePath)
        const initialContent = shouldCreateMarkdownStarter(relativePath) && title ? `# ${title}\n\n` : ''
        await window.electronAPI.createDirectory(parentPath)
        await window.electronAPI.writeFile(targetPath, initialContent)
      }
      await refreshNovelWorkspaceFilesAfterMutation(novelWorkspaceRoot)
      expandWorkspaceTreeDirectory(workspaceCreateEntryTarget.parentRelativePath)
      if (workspaceCreateEntryTarget.kind === 'file') {
        setNovelDocumentTabs(current => openNovelDocumentTab(current, novelWorkspaceRoot, targetPath))
        navigate(routes.view.writing())
      }
      setWorkspaceCreateEntryTarget(null)
      setWorkspaceCreateEntryValue('')
    } catch (error) {
      console.error('[AppShell] Failed to create workspace entry:', error)
      toast.error(workspaceCreateEntryTarget.kind === 'file'
        ? t('writing.createFile.failed', '创建文件失败')
        : t('writing.createFolder.failed', '创建文件夹失败'))
    } finally {
      setWorkspaceCreatingEntry(false)
    }
  }, [
    expandWorkspaceTreeDirectory,
    novelWorkspaceDirectories,
    novelWorkspaceFiles,
    novelWorkspaceRoot,
    refreshNovelWorkspaceFilesAfterMutation,
    t,
    workspaceCreateEntryTarget,
    workspaceCreateEntryValue,
  ])

  const handleSubmitNovelProjectRename = React.useCallback(() => {
    const nextName = novelProjectRenameValue.trim()
    if (!activeProjectId || !onRenameProject || !nextName) return
    setNovelProjectRenameOpen(false)
    void onRenameProject(activeProjectId, nextName)
  }, [activeProjectId, novelProjectRenameValue, onRenameProject])

  const handleImportNovelFiles = React.useCallback(async (parentRelativePath: string) => {
    if (!novelWorkspaceRoot) return

    const sourcePaths = await window.electronAPI.openFileDialog()
    if (sourcePaths.length === 0) return
    if (!await ensureNovelDocumentSavedRef.current()) return

    let importedCount = 0
    let skippedCount = 0
    let lastImportedPath: string | null = null
    const reservedRelativePathKeys = new Set([
      ...novelWorkspaceFiles.map(file => getWorkspaceRelativePathKey(file.relativePath)),
      ...novelWorkspaceDirectories.map(getWorkspaceRelativePathKey),
    ])

    for (const sourcePath of sourcePaths) {
      const relativePath = resolveWorkspaceImportRelativePath(parentRelativePath, sourcePath)
      const relativePathKey = relativePath ? getWorkspaceRelativePathKey(relativePath) : null
      if (!relativePath || !relativePathKey || reservedRelativePathKeys.has(relativePathKey)) {
        skippedCount += 1
        continue
      }

      try {
        const attachment = await window.electronAPI.readUserAttachment(sourcePath)
        if (!attachment || attachment.text === undefined) {
          skippedCount += 1
          continue
        }

        const targetPath = joinWorkspacePath(novelWorkspaceRoot, relativePath)
        const parentRelativePath = getParentRelativePath(relativePath)
        const parentPath = joinWorkspacePath(novelWorkspaceRoot, parentRelativePath)

        await window.electronAPI.createDirectory(parentPath)
        await window.electronAPI.writeFile(targetPath, attachment.text)
        importedCount += 1
        reservedRelativePathKeys.add(relativePathKey)
        lastImportedPath = targetPath
      } catch (error) {
        console.error('[AppShell] Failed to import writing file:', error)
        skippedCount += 1
      }
    }

    if (importedCount > 0) {
      await refreshNovelWorkspaceFilesAfterMutation(novelWorkspaceRoot)
      expandWorkspaceTreeDirectory(parentRelativePath)
      if (lastImportedPath) {
        setNovelDocumentTabs(current => openNovelDocumentTab(current, novelWorkspaceRoot, lastImportedPath))
        navigate(routes.view.writing())
      }
      toast.success(t('writing.importFile.success', '已导入文件'))
    }
    if (skippedCount > 0) {
      toast.error(t('writing.importFile.skipped', '部分文件未导入，仅支持不重名的 md/txt 文件'))
    }
  }, [
    expandWorkspaceTreeDirectory,
    novelWorkspaceDirectories,
    novelWorkspaceFiles,
    novelWorkspaceRoot,
    refreshNovelWorkspaceFilesAfterMutation,
    t,
  ])

  React.useEffect(() => {
    if (novelWorkspaceCandidateRoots.length === 0) {
      setNovelWorkspaceDetecting(false)
      setNovelWorkspaceDetectionSettledKey(null)
      setNovelWorkspaceRoot(null)
      setNovelWorkspaceFiles([])
      setNovelWorkspaceDirectories([])
      return
    }

    const nextCandidateRoots = new Set(novelWorkspaceCandidateRoots)
    const currentNovelWorkspaceRoot = novelWorkspaceRootRef.current
    const shouldKeepWorkspaceChromeWhileDetecting = !currentNovelWorkspaceRoot || !nextCandidateRoots.has(currentNovelWorkspaceRoot)
    setNovelWorkspaceDetecting(shouldKeepWorkspaceChromeWhileDetecting)

    if (currentNovelWorkspaceRoot && !nextCandidateRoots.has(currentNovelWorkspaceRoot)) {
      setNovelWorkspaceRoot(null)
      setNovelWorkspaceFiles([])
      setNovelWorkspaceDirectories([])
    }

    if (!rightWorkspaceVisible) {
      setNovelWorkspaceDetecting(false)
      return
    }

    let cancelled = false

    async function detectNovelWorkspace(): Promise<void> {
      for (const rootPath of novelWorkspaceCandidateRoots) {
        const cachedNovelWorkspaceCatalog = novelWorkspaceCatalogCacheRef.current.get(rootPath)
        const knownWritingWorkspaceRoot = rootPath === activeWritingWorkspaceRoot
        if (cachedNovelWorkspaceCatalog) {
          setNovelWorkspaceRoot(rootPath)
          setNovelWorkspaceCatalogIfChanged(cachedNovelWorkspaceCatalog)
          setNovelWorkspaceDetectionSettledKey(novelWorkspaceCandidateKey)
          setNovelWorkspaceDetecting(false)
          markNovelWorkspaceFileChangesCovered(rootPath)
          return
        }

        try {
          const detectionRevision = readWorkspaceCatalogRevision(
            novelWorkspaceCatalogRevisionRef.current,
            rootPath,
          )
          const catalog = await loadNovelWorkspaceFiles(
            rootPath,
            cachedNovelWorkspaceCatalog
              ? undefined
              : (probeFiles) => {
                  if (cancelled) return
                  setNovelWorkspaceRoot(rootPath)
                  setNovelWorkspaceCatalogIfChanged({ files: probeFiles, directories: [] })
                  setNovelWorkspaceDetectionSettledKey(novelWorkspaceCandidateKey)
                  setNovelWorkspaceDetecting(false)
                },
            knownWritingWorkspaceRoot || Boolean(cachedNovelWorkspaceCatalog)
          )
          if (cancelled) return
          if (readWorkspaceCatalogRevision(novelWorkspaceCatalogRevisionRef.current, rootPath) !== detectionRevision) {
            setNovelWorkspaceDetectionSettledKey(novelWorkspaceCandidateKey)
            setNovelWorkspaceDetecting(false)
            return
          }

          if (catalog) {
            setNovelWorkspaceRoot(rootPath)
            setNovelWorkspaceCatalogIfChanged(catalog)
            setNovelWorkspaceDetectionSettledKey(novelWorkspaceCandidateKey)
            setNovelWorkspaceDetecting(false)
            markNovelWorkspaceFileChangesCovered(rootPath)
            return
          }
        } catch {
          if (cancelled) return
        }
      }

      setNovelWorkspaceRoot(null)
      setNovelWorkspaceFiles([])
      setNovelWorkspaceDirectories([])
      setNovelWorkspaceDetectionSettledKey(novelWorkspaceCandidateKey)
      setNovelWorkspaceDetecting(false)
    }

    void detectNovelWorkspace()

    return () => {
      cancelled = true
    }
  }, [activeWritingWorkspaceRoot, loadNovelWorkspaceFiles, markNovelWorkspaceFileChangesCovered, novelWorkspaceCandidateKey, novelWorkspaceCandidateRoots, rightWorkspaceVisible, setNovelWorkspaceCatalogIfChanged])

  React.useEffect(() => {
    if (!novelWorkspaceRoot || !latestNovelFileChangesSignature) return
    if (effectiveSessionIsProcessing) return

    const refreshKey = `${novelWorkspaceRoot}\n${latestNovelFileChangesSignature}`
    if (novelWorkspaceLastRefreshKeyRef.current === refreshKey) return
    if (completedNovelFileChangeRefreshKeys.has(refreshKey)) return
    if (pendingNovelFileChangeRefreshKeys.has(refreshKey)) return

    const sessionWasProcessing = effectiveSessionId
      ? novelSessionProcessingRef.current[effectiveSessionId] === true
      : false
    if (!sessionWasProcessing && novelWorkspaceCatalogCacheRef.current.has(novelWorkspaceRoot)) {
      markNovelWorkspaceFileChangesCovered(novelWorkspaceRoot, latestNovelFileChangesSignature)
      return
    }

    const timeoutId = window.setTimeout(() => {
      if (completedNovelFileChangeRefreshKeys.has(refreshKey)) return
      if (pendingNovelFileChangeRefreshKeys.has(refreshKey)) return
      void refreshNovelWorkspaceFilesAfterMutation(novelWorkspaceRoot).then((refreshed) => {
        if (refreshed) {
          markNovelWorkspaceFileChangesCovered(novelWorkspaceRoot, latestNovelFileChangesSignature)
        }
      })
    }, 250)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [
    effectiveSessionIsProcessing,
    effectiveSessionId,
    latestNovelFileChangesSignature,
    markNovelWorkspaceFileChangesCovered,
    novelWorkspaceRoot,
    refreshNovelWorkspaceFilesAfterMutation,
  ])

  const novelWorkspaceCandidateRootSet = React.useMemo(
    () => new Set(novelWorkspaceCandidateRoots),
    [novelWorkspaceCandidateRoots]
  )
  const novelWorkspaceRootMatchesCandidates = !!novelWorkspaceRoot && novelWorkspaceCandidateRootSet.has(novelWorkspaceRoot)
  const hasStaleNovelWorkspaceRoot = !!novelWorkspaceRoot && novelWorkspaceCandidateRoots.length > 0 && !novelWorkspaceRootMatchesCandidates
  const hasUnsettledNovelWorkspaceCandidates = novelWorkspaceCandidateRoots.length > 0 && novelWorkspaceDetectionSettledKey !== novelWorkspaceCandidateKey
  // Project chats retain the project navigator; Free Conversations never mount project chrome.
  const showWritingWorkspaceShell = isProjectRuntime
    && (isWritingNavigation(navState) || isSessionsNavigation(navState))
  // The manuscript is a column of its own, not a surface the navigator lends out.
  // Gating it on the writing route made opening a new conversation replace the
  // document with the conversation list — the one thing a writing session cannot
  // afford to lose. Presence follows the workspace, never the route; the route
  // only decides what is shown *inside* each column.
  const showWritingDocumentSurface = showWritingWorkspaceShell
  const showEmptyProjectSession = shouldUseEmptyProjectStarterLayout({
    isSessionsRoute: isSessionsNavigation(navState),
    fileCount: novelWorkspaceFiles.length,
    directoryCount: novelWorkspaceDirectories.length,
    loadedMessageCount: effectiveSessionMessageCount,
    persistedMessageCount: rawEffectiveSessionMeta?.messageCount,
    lastFinalMessageId: rawEffectiveSessionMeta?.lastFinalMessageId,
  })
  // Optional callbacks are capability contracts: only claim the embedded review
  // when this shell can actually render it. ChatDisplay owns the fullscreen fallback.
  const canPresentConversationDiffInWorkspace = showWritingDocumentSurface && !isAutoCompact && !showEmptyProjectSession
  const showNovelWorkspaceSidebar = novelWorkspaceRootMatchesCandidates
  const showNovelDocumentNavigator = showWritingDocumentSurface && showNovelWorkspaceSidebar
  const showNovelWorkspacePending = showWritingDocumentSurface && (
    novelWorkspaceDetecting
    || hasStaleNovelWorkspaceRoot
    || (!showNovelWorkspaceSidebar && hasUnsettledNovelWorkspaceCandidates)
  )
  const showNovelWorkspaceUnavailable = showWritingDocumentSurface
    && activeWritingWorkspaceRoot !== null
    && !showNovelWorkspaceSidebar
    && !showNovelWorkspacePending
  const reviewableNovelFileChanges = React.useMemo(
    () => normalizeNovelFileChangePaths(latestNovelFileChanges, novelWorkspaceRoot, novelWorkspaceFiles),
    [latestNovelFileChanges, novelWorkspaceFiles, novelWorkspaceRoot]
  )
  const novelWorkspaceFileByPath = React.useMemo(
    () => new Map(novelWorkspaceFiles.map(file => [file.path, file])),
    [novelWorkspaceFiles]
  )
  const [novelDocumentTabs, setNovelDocumentTabs] = React.useState<NovelDocumentTabsState>({
    workspaceRoot: null,
    paths: [],
    activePath: null,
  })
  const selectedNovelFilePath = novelDocumentTabs.activePath

  React.useEffect(() => {
    if (!novelWorkspaceRoot) return

    const syncWorkspaceTreeFromDisk = (): void => {
      novelWorkspaceCatalogCacheRef.current.delete(novelWorkspaceRoot)
      void refreshNovelWorkspaceFiles(novelWorkspaceRoot)
        .then((refreshed) => {
          if (!refreshed) return
          const catalog = novelWorkspaceCatalogCacheRef.current.get(novelWorkspaceRoot)
          if (!catalog) return

          // A transiently incomplete catalog must not discard an open editor.
          // Explicit move/delete actions below reconcile tabs with confirmed disk mutations.
        })
        .catch((error) => {
          if (!(error instanceof Error) || !error.message.includes('Workspace not found')) {
            console.warn('[AppShell] Failed to sync workspace tree from disk:', error)
            return
          }

          const emptyCatalog: NativeWorkspaceCatalog = { files: [], directories: [] }
          novelWorkspaceCatalogCacheRef.current.set(novelWorkspaceRoot, emptyCatalog)
          setNovelWorkspaceCatalogIfChanged(emptyCatalog)
        })
    }
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') syncWorkspaceTreeFromDisk()
    }

    window.addEventListener('focus', syncWorkspaceTreeFromDisk)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('focus', syncWorkspaceTreeFromDisk)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [novelWorkspaceRoot, refreshNovelWorkspaceFiles, setNovelWorkspaceCatalogIfChanged])

  const selectedNovelFile = React.useMemo(() => {
    const canResolveSelectedNovelFile = showNovelWorkspaceSidebar || showNovelWorkspacePending
    if (!canResolveSelectedNovelFile) return undefined
    if (!selectedNovelFilePath) return undefined

    const listedFile = novelWorkspaceFileByPath.get(selectedNovelFilePath)
    if (listedFile) return listedFile

    if (novelWorkspaceRoot && isNovelWorkspaceFilePathInRoot(selectedNovelFilePath, novelWorkspaceRoot)) {
      return {
        path: selectedNovelFilePath,
        relativePath: getNovelWorkspaceRelativePath(selectedNovelFilePath, novelWorkspaceRoot),
      }
    }

    return undefined
  }, [novelWorkspaceFileByPath, novelWorkspaceRoot, selectedNovelFilePath, showNovelWorkspacePending, showNovelWorkspaceSidebar])

  React.useEffect(() => {
    if (!showNovelWorkspaceSidebar) {
      if (novelWorkspaceCandidateRoots.length === 0) {
        setNovelDocumentTabs({ workspaceRoot: null, paths: [], activePath: null })
      }
      return
    }

    if (!novelWorkspaceRoot || novelDocumentTabs.workspaceRoot === novelWorkspaceRoot) return
    // Project entry is metadata-only; content loading starts from an explicit file selection.
    setNovelDocumentTabs({
      workspaceRoot: novelWorkspaceRoot,
      paths: [],
      activePath: null,
    })
  }, [
    novelWorkspaceCandidateRoots.length,
    novelWorkspaceRoot,
    novelDocumentTabs.workspaceRoot,
    showNovelWorkspaceSidebar,
  ])

  const openNovelFiles = React.useMemo(
    () => novelDocumentTabs.paths.flatMap((path): NovelWorkspaceFile[] => {
      const listedFile = novelWorkspaceFileByPath.get(path)
      if (listedFile) return [listedFile]
      if (!novelWorkspaceRoot || !isNovelWorkspaceFilePathInRoot(path, novelWorkspaceRoot)) return []
      return [{
        path,
        relativePath: getNovelWorkspaceRelativePath(path, novelWorkspaceRoot),
      }]
    }),
    [novelDocumentTabs.paths, novelWorkspaceFileByPath, novelWorkspaceRoot],
  )

  const [novelDocumentContent, setNovelDocumentContent] = React.useState('')
  const [savedNovelDocumentContent, setSavedNovelDocumentContent] = React.useState('')
  const [novelDocumentChangeVersion, setNovelDocumentChangeVersion] = React.useState(0)
  const [savedNovelDocumentChangeVersion, setSavedNovelDocumentChangeVersion] = React.useState(0)
  const novelDocumentChangeVersionRef = React.useRef(0)
  const savedNovelDocumentChangeVersionRef = React.useRef(0)
  const novelDocumentChangeVersionFlushRef = React.useRef<number | null>(null)
  const [novelDocumentLoading, setNovelDocumentLoading] = React.useState(false)
  const [loadedNovelDocumentPath, setLoadedNovelDocumentPath] = React.useState<string | null>(null)
  const [novelDocumentSaving, setNovelDocumentSaving] = React.useState(false)
  const [novelDocumentError, setNovelDocumentError] = React.useState<string | null>(null)
  const [novelVersionDialogOpen, setNovelVersionDialogOpen] = React.useState(false)
  const [novelVersions, setNovelVersions] = React.useState<WorkspaceVersionEntry[]>([])
  const [novelVersionsLoading, setNovelVersionsLoading] = React.useState(false)
  const [novelVersionSaving, setNovelVersionSaving] = React.useState(false)
  const [novelVersionRestoringHash, setNovelVersionRestoringHash] = React.useState<string | null>(null)
  const selectedNovelFileOpenTarget = selectedNovelFile
    ? getWorkspaceFileOpenTarget(selectedNovelFile.path)
    : null
  const selectedNovelDocumentPath = selectedNovelFileOpenTarget === 'editor'
    ? selectedNovelFile?.path ?? null
    : null
  const novelDocumentEditorRef = React.useRef<NovelDocumentEditorPanelHandle>(null)
  const latestNovelDocumentPathRef = React.useRef<string | null>(null)
  const novelDocumentSwitchStartRef = React.useRef<{ filePath: string; startedAt: number } | null>(null)
  const novelDocumentSaveSeqRef = React.useRef(0)
  const novelVersionBaselinesRef = React.useRef<Record<string, { content: string; timestamp: number }>>({})
  const novelAutoVersionInFlightRef = React.useRef(false)
  const novelAutoVersionTimerRef = React.useRef<number | null>(null)
  const novelAgentTurnCheckpointInFlightRef = React.useRef(false)
  const novelSessionProcessingRef = React.useRef<Record<string, boolean>>({})
  const novelAgentTouchedPathsRef = React.useRef<Record<string, string[]>>({})

  // Bound auto-version baselines to a small working set. Unbounded path→content
  // retention was the root cause of document open/close heap growth in the perf
  // harness (every chapter open kept a full string copy forever).
  const NOVEL_VERSION_BASELINE_WORKING_SET = 3
  const pruneNovelVersionBaselines = React.useCallback((preferPath?: string | null) => {
    const entries = Object.entries(novelVersionBaselinesRef.current)
    if (entries.length <= NOVEL_VERSION_BASELINE_WORKING_SET) return
    entries.sort((a, b) => b[1].timestamp - a[1].timestamp)
    const ordered: Array<[string, { content: string; timestamp: number }]> = []
    if (preferPath && novelVersionBaselinesRef.current[preferPath]) {
      ordered.push([preferPath, novelVersionBaselinesRef.current[preferPath]])
    }
    for (const entry of entries) {
      if (entry[0] === preferPath) continue
      ordered.push(entry)
    }
    novelVersionBaselinesRef.current = Object.fromEntries(
      ordered.slice(0, NOVEL_VERSION_BASELINE_WORKING_SET),
    )
  }, [])
  const rememberNovelVersionBaseline = React.useCallback((
    filePath: string,
    content: string,
    mode: 'set' | 'ensure' = 'set',
  ) => {
    if (mode === 'ensure' && novelVersionBaselinesRef.current[filePath]) {
      novelVersionBaselinesRef.current[filePath] = {
        ...novelVersionBaselinesRef.current[filePath],
        timestamp: Date.now(),
      }
    } else {
      novelVersionBaselinesRef.current[filePath] = { content, timestamp: Date.now() }
    }
    pruneNovelVersionBaselines(filePath)
  }, [pruneNovelVersionBaselines])

  React.useEffect(() => {
    latestNovelDocumentPathRef.current = selectedNovelDocumentPath
  }, [selectedNovelDocumentPath])

  const flushNovelDocumentChangeVersion = React.useCallback(() => {
    if (novelDocumentChangeVersionFlushRef.current != null) {
      window.clearTimeout(novelDocumentChangeVersionFlushRef.current)
      novelDocumentChangeVersionFlushRef.current = null
    }
    setNovelDocumentChangeVersion(novelDocumentChangeVersionRef.current)
  }, [])

  const markSavedNovelDocumentChangeVersion = React.useCallback((version: number) => {
    savedNovelDocumentChangeVersionRef.current = version
    setSavedNovelDocumentChangeVersion(version)
  }, [])

  React.useEffect(() => () => {
    if (novelDocumentChangeVersionFlushRef.current != null) {
      window.clearTimeout(novelDocumentChangeVersionFlushRef.current)
      novelDocumentChangeVersionFlushRef.current = null
    }
  }, [])

  const replaceNovelDocumentContent = React.useCallback((content: string) => {
    setNovelDocumentContent(content)
    setSavedNovelDocumentContent(content)
    novelDocumentChangeVersionRef.current = 0
    setNovelDocumentChangeVersion(0)
    markSavedNovelDocumentChangeVersion(0)
  }, [markSavedNovelDocumentChangeVersion])

  const handleNovelDocumentChanged = React.useCallback(() => {
    novelDocumentChangeVersionRef.current += 1
    if (novelDocumentChangeVersionFlushRef.current != null) {
      window.clearTimeout(novelDocumentChangeVersionFlushRef.current)
    }
    novelDocumentChangeVersionFlushRef.current = window.setTimeout(() => {
      novelDocumentChangeVersionFlushRef.current = null
      setNovelDocumentChangeVersion(novelDocumentChangeVersionRef.current)
    }, 200)
  }, [])

  const getCurrentNovelDocumentContent = React.useCallback(() => (
    novelDocumentEditorRef.current?.getMarkdownSnapshot() ?? novelDocumentContent
  ), [novelDocumentContent])

  const isCurrentNovelDocumentDirty = React.useCallback(() => (
    latestNovelDocumentPathRef.current != null
    && (
      novelDocumentContent !== savedNovelDocumentContent
      || novelDocumentChangeVersionRef.current !== savedNovelDocumentChangeVersionRef.current
    )
  ), [novelDocumentContent, savedNovelDocumentContent])

  React.useEffect(() => {
    novelVersionBaselinesRef.current = {}
    setNovelVersions([])
    if (novelAutoVersionTimerRef.current != null) {
      window.clearTimeout(novelAutoVersionTimerRef.current)
      novelAutoVersionTimerRef.current = null
    }
  }, [novelWorkspaceRoot])

  React.useEffect(() => {
    if (!selectedNovelDocumentPath) {
      replaceNovelDocumentContent('')
      setNovelDocumentLoading(false)
      setLoadedNovelDocumentPath(null)
      setNovelDocumentError(null)
      return
    }

    let cancelled = false
    const readStartedAt = performance.now()
    setNovelDocumentLoading(true)
    setLoadedNovelDocumentPath(null)
    setNovelDocumentError(null)

    window.electronAPI.readFile(selectedNovelDocumentPath)
      .then((content) => {
        if (cancelled) return
        rendererPerf.recordNovelDocumentEvent({
          filePath: selectedNovelDocumentPath,
          phase: 'readFile',
          durationMs: performance.now() - readStartedAt,
          contentLength: content.length,
        })
        replaceNovelDocumentContent(content)
        rememberNovelVersionBaseline(selectedNovelDocumentPath, content, 'ensure')
      })
      .catch((error) => {
        if (cancelled) return
        rendererPerf.recordNovelDocumentEvent({
          filePath: selectedNovelDocumentPath,
          phase: 'readFile.error',
          durationMs: performance.now() - readStartedAt,
        })
        replaceNovelDocumentContent('')
        setNovelDocumentError(error instanceof Error ? error.message : 'Failed to load document')
      })
      .finally(() => {
        if (!cancelled) {
          setNovelDocumentLoading(false)
          setLoadedNovelDocumentPath(selectedNovelDocumentPath)

          const switchStart = novelDocumentSwitchStartRef.current
          if (switchStart?.filePath === selectedNovelDocumentPath) {
            rendererPerf.recordNovelDocumentEvent({
              filePath: selectedNovelDocumentPath,
              phase: 'readyAfterRead',
              durationMs: performance.now() - switchStart.startedAt,
            })
            window.requestAnimationFrame(() => {
              if (latestNovelDocumentPathRef.current !== selectedNovelDocumentPath) return
              rendererPerf.recordNovelDocumentEvent({
                filePath: selectedNovelDocumentPath,
                phase: 'paintAfterRead',
                durationMs: performance.now() - switchStart.startedAt,
              })
            })
            novelDocumentSwitchStartRef.current = null
          }
        }
      })

    return () => {
      cancelled = true
    }
  }, [rememberNovelVersionBaseline, replaceNovelDocumentContent, selectedNovelDocumentPath])

  const novelDocumentDirty = !!selectedNovelFile && (
    novelDocumentContent !== savedNovelDocumentContent
    || novelDocumentChangeVersion !== savedNovelDocumentChangeVersion
  )
  const writingPrimaryContentReady = showNovelWorkspaceSidebar && (
    !selectedNovelDocumentPath || loadedNovelDocumentPath === selectedNovelDocumentPath
  )
  const handleMoveNovelWorkspaceEntry = React.useCallback(async (
    entry: WorkspaceFileTreeNode,
    destinationDirectory: WorkspaceFileTreeNode,
    newName?: string,
  ) => {
    if (!novelWorkspaceRoot || entry.type === 'root' || destinationDirectory.type === 'file') return
    if (isSameOrChildWorkspacePath(selectedNovelFilePath, entry.path) && isCurrentNovelDocumentDirty()) {
      toast.error(t('writing.moveFile.unsaved', '当前文件有未保存修改，请先保存后再移动或重命名'))
      return
    }

    try {
      const result = await window.electronAPI.moveWorkspaceEntry({
        sourcePath: entry.path,
        destinationDirectoryPath: destinationDirectory.path,
        newName,
      })
      if (result.sourcePath === result.destinationPath) return

      const destinationName = newName ?? entry.name
      const destinationRelativePath = destinationDirectory.relativePath
        ? `${destinationDirectory.relativePath}/${destinationName}`
        : destinationName

      invalidateNovelWorkspaceCatalogRequests(novelWorkspaceRoot)
      setNovelWorkspaceFiles(previous => previous.map(file => (
        isSameOrChildWorkspacePath(file.path, result.sourcePath)
          ? {
              ...file,
              path: remapWorkspacePath(file.path, result.sourcePath, result.destinationPath),
              relativePath: remapWorkspacePath(file.relativePath, entry.relativePath, destinationRelativePath),
            }
          : file
      )))
      if (entry.type === 'directory') {
        setNovelWorkspaceDirectories(previous => previous.map(directory => (
          isSameOrChildWorkspacePath(directory, entry.relativePath)
            ? remapWorkspacePath(directory, entry.relativePath, destinationRelativePath)
            : directory
        )))
        const sourceFolderId = `writing:folder:${entry.relativePath}`
        const destinationFolderId = `writing:folder:${destinationRelativePath}`
        setExpandedFolders(previous => {
          let changed = false
          const next = new Set<string>()
          for (const id of previous) {
            if (id === sourceFolderId || id.startsWith(`${sourceFolderId}/`)) {
              next.add(`${destinationFolderId}${id.slice(sourceFolderId.length)}`)
              changed = true
            } else {
              next.add(id)
            }
          }
          return changed ? next : previous
        })
      }
      setNovelDocumentTabs(current => mapNovelDocumentTabs(
        current,
        path => isSameOrChildWorkspacePath(path, result.sourcePath)
          ? remapWorkspacePath(path, result.sourcePath, result.destinationPath)
          : path,
      ))

      toast.success(newName
        ? t('writing.renameFile.success', '已重命名')
        : t('writing.moveFile.success', '已移动'))
    } catch (error) {
      console.error('[AppShell] Failed to move workspace entry:', error)
      toast.error(newName
        ? t('writing.renameFile.failed', '重命名失败')
        : t('writing.moveFile.failed', '移动失败'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }, [
    invalidateNovelWorkspaceCatalogRequests,
    isCurrentNovelDocumentDirty,
    novelWorkspaceRoot,
    selectedNovelFilePath,
    t,
  ])

  const handleRenameNovelWorkspaceEntry = React.useCallback((entry: WorkspaceFileTreeNode, newName: string) => {
    if (!novelWorkspaceRoot) return
    const parentRelativePath = getParentRelativePath(entry.relativePath)
    const destinationDirectory: WorkspaceFileTreeNode = {
      id: parentRelativePath ? `writing:folder:${parentRelativePath}` : `writing:project:${activeWorkspaceId}`,
      name: '',
      path: joinWorkspacePath(novelWorkspaceRoot, parentRelativePath),
      relativePath: parentRelativePath,
      type: parentRelativePath ? 'directory' : 'root',
      fileCount: 0,
      children: [],
    }
    return handleMoveNovelWorkspaceEntry(entry, destinationDirectory, newName)
  }, [activeWorkspaceId, handleMoveNovelWorkspaceEntry, novelWorkspaceRoot])

  const handleDeleteNovelWorkspaceEntry = React.useCallback(async (entry: WorkspaceFileTreeNode) => {
    if (!novelWorkspaceRoot || entry.type === 'root') return
    if (isSameOrChildWorkspacePath(selectedNovelFilePath, entry.path) && isCurrentNovelDocumentDirty()) {
      toast.error(t('writing.deleteFile.unsaved', '当前文件有未保存修改，请先保存或切换文件'))
      return
    }

    const confirmed = window.confirm(t(
      entry.type === 'directory' ? 'writing.deleteFolder.confirm' : 'writing.deleteFile.confirm',
      entry.type === 'directory'
        ? '删除文件夹「{{name}}」及其中全部内容？此操作无法撤销。'
        : '删除「{{name}}」？此操作无法撤销。',
      { name: entry.name },
    ))
    if (!confirmed) return

    try {
      await window.electronAPI.deleteWorkspaceEntry({
        path: entry.path,
        recursive: entry.type === 'directory',
      })
      const nextState = reduceWorkspaceStateAfterDeletion({
        files: novelWorkspaceFiles,
        directories: novelWorkspaceDirectories,
        expandedIds: expandedFolders,
        selectedPath: selectedNovelFilePath,
        entry: {
          path: entry.path,
          relativePath: entry.relativePath,
          type: entry.type,
        },
      })

      invalidateNovelWorkspaceCatalogRequests(novelWorkspaceRoot)
      setNovelWorkspaceFiles(nextState.files)
      setNovelWorkspaceDirectories(nextState.directories)
      setExpandedFolders(nextState.expandedIds)
      setNovelDocumentTabs(current => filterNovelDocumentTabs(
        current,
        path => !isSameOrChildWorkspacePath(path, entry.path),
      ))
      toast.success(t('writing.deleteFile.success', '已删除'))
    } catch (error) {
      console.error('[AppShell] Failed to delete workspace entry:', error)
      toast.error(t('writing.deleteFile.failed', '删除失败'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }, [
    invalidateNovelWorkspaceCatalogRequests,
    isCurrentNovelDocumentDirty,
    expandedFolders,
    novelWorkspaceDirectories,
    novelWorkspaceFiles,
    novelWorkspaceRoot,
    selectedNovelFilePath,
    t,
  ])

  const refreshNovelVersions = React.useCallback(async () => {
    if (!novelWorkspaceRoot) {
      setNovelVersions([])
      return
    }
    setNovelVersionsLoading(true)
    try {
      setNovelVersions(await window.electronAPI.listWorkspaceVersions(novelWorkspaceRoot, 30))
    } catch (error) {
      toast.error(t('writing.version.loadFailed', '加载版本历史失败'), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setNovelVersionsLoading(false)
    }
  }, [novelWorkspaceRoot, t])

  const maybeCreateNovelAutoVersion = React.useCallback(async (filePath: string, content: string) => {
    if (!novelWorkspaceRoot || novelAutoVersionInFlightRef.current) return

    const now = Date.now()
    const baseline = novelVersionBaselinesRef.current[filePath] ?? { content, timestamp: now }
    if (content === baseline.content) return

    const charDelta = getContentChangeSize(baseline.content, content)
    const elapsed = now - baseline.timestamp
    if (charDelta < NOVEL_AUTO_VERSION_CHAR_THRESHOLD && elapsed < NOVEL_AUTO_VERSION_INTERVAL_MS) {
      if (novelAutoVersionTimerRef.current == null) {
        novelAutoVersionTimerRef.current = window.setTimeout(async () => {
          novelAutoVersionTimerRef.current = null
          try {
            const latestContent = await window.electronAPI.readFile(filePath)
            await maybeCreateNovelAutoVersion(filePath, latestContent)
          } catch (error) {
            console.warn('[writing] Failed to create scheduled auto version:', error)
          }
        }, NOVEL_AUTO_VERSION_INTERVAL_MS - elapsed)
      }
      return
    }

    if (novelAutoVersionTimerRef.current != null) {
      window.clearTimeout(novelAutoVersionTimerRef.current)
      novelAutoVersionTimerRef.current = null
    }

    novelAutoVersionInFlightRef.current = true
    try {
      await window.electronAPI.createWorkspaceVersion(novelWorkspaceRoot, { reason: 'auto' })
      rememberNovelVersionBaseline(filePath, content, 'set')
      if (novelVersionDialogOpen) {
        await refreshNovelVersions()
      }
    } catch (error) {
      console.warn('[writing] Failed to create auto version:', error)
    } finally {
      novelAutoVersionInFlightRef.current = false
    }
  }, [novelVersionDialogOpen, novelWorkspaceRoot, refreshNovelVersions, rememberNovelVersionBaseline])

  React.useEffect(() => {
    if (!selectedNovelDocumentPath || !novelDocumentDirty || novelDocumentLoading) return

    const pathToSave = selectedNovelDocumentPath
    const versionToSave = novelDocumentChangeVersion
    const timeoutId = window.setTimeout(() => {
      const contentToSave = getCurrentNovelDocumentContent()
      if (contentToSave === savedNovelDocumentContent) {
        setNovelDocumentContent(contentToSave)
        markSavedNovelDocumentChangeVersion(versionToSave)
        return
      }
      if (isSuspiciousEmptyNovelSnapshot(contentToSave, savedNovelDocumentContent, novelDocumentContent)) {
        setNovelDocumentError(t(
          'writing.emptySnapshotSaveBlocked',
          '已阻止一次空内容覆盖。请重新打开该文件后再保存。'
        ))
        markSavedNovelDocumentChangeVersion(versionToSave)
        return
      }

      const saveSeq = ++novelDocumentSaveSeqRef.current
      setNovelDocumentSaving(true)
      setNovelDocumentError(null)

      window.electronAPI.writeFile(pathToSave, contentToSave)
        .then(() => {
          if (
            novelDocumentSaveSeqRef.current === saveSeq
            && latestNovelDocumentPathRef.current === pathToSave
            && novelDocumentChangeVersionRef.current === versionToSave
          ) {
            setNovelDocumentContent(contentToSave)
            setSavedNovelDocumentContent(contentToSave)
            markSavedNovelDocumentChangeVersion(versionToSave)
          }
          void maybeCreateNovelAutoVersion(pathToSave, contentToSave)
        })
        .catch((error) => {
          if (novelDocumentSaveSeqRef.current !== saveSeq || latestNovelDocumentPathRef.current !== pathToSave) return
          setNovelDocumentError(error instanceof Error ? error.message : 'Failed to save document')
        })
        .finally(() => {
          if (novelDocumentSaveSeqRef.current === saveSeq) {
            setNovelDocumentSaving(false)
          }
        })
    }, 800)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [getCurrentNovelDocumentContent, markSavedNovelDocumentChangeVersion, maybeCreateNovelAutoVersion, novelDocumentChangeVersion, novelDocumentContent, novelDocumentDirty, novelDocumentLoading, savedNovelDocumentContent, selectedNovelDocumentPath, t])

  const ensureNovelDocumentSaved = React.useCallback(async (): Promise<boolean> => {
    if (!selectedNovelDocumentPath || !isCurrentNovelDocumentDirty()) return true

    flushNovelDocumentChangeVersion()
    const contentToSave = getCurrentNovelDocumentContent()
    const versionToSave = novelDocumentChangeVersionRef.current
    if (contentToSave === savedNovelDocumentContent) {
      setNovelDocumentContent(contentToSave)
      markSavedNovelDocumentChangeVersion(versionToSave)
      return true
    }
    if (isSuspiciousEmptyNovelSnapshot(contentToSave, savedNovelDocumentContent, novelDocumentContent)) {
      const message = t(
        'writing.emptySnapshotSaveBlocked',
        '已阻止一次空内容覆盖。请重新打开该文件后再保存。'
      )
      setNovelDocumentError(message)
      markSavedNovelDocumentChangeVersion(versionToSave)
      toast.error(message)
      return false
    }

    const saveSeq = ++novelDocumentSaveSeqRef.current
    setNovelDocumentSaving(true)
    setNovelDocumentError(null)
    try {
      await window.electronAPI.writeFile(selectedNovelDocumentPath, contentToSave)
      if (
        novelDocumentSaveSeqRef.current === saveSeq
        && latestNovelDocumentPathRef.current === selectedNovelDocumentPath
        && novelDocumentChangeVersionRef.current === versionToSave
      ) {
        setNovelDocumentContent(contentToSave)
        setSavedNovelDocumentContent(contentToSave)
        markSavedNovelDocumentChangeVersion(versionToSave)
      }
      void maybeCreateNovelAutoVersion(selectedNovelDocumentPath, contentToSave)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save document'
      setNovelDocumentError(message)
      toast.error(t('writing.autoSaveFailed', 'Failed to save document'), { description: message })
      return false
    } finally {
      if (novelDocumentSaveSeqRef.current === saveSeq) {
        setNovelDocumentSaving(false)
      }
    }
  }, [flushNovelDocumentChangeVersion, getCurrentNovelDocumentContent, isCurrentNovelDocumentDirty, markSavedNovelDocumentChangeVersion, maybeCreateNovelAutoVersion, novelDocumentContent, savedNovelDocumentContent, selectedNovelDocumentPath, t])
  ensureNovelDocumentSavedRef.current = ensureNovelDocumentSaved

  const handleSelectNovelFile = React.useCallback(async (
    file: NovelWorkspaceFile,
    openMode: NovelDocumentOpenMode = 'append',
  ): Promise<boolean> => {
    if (file.path === selectedNovelFilePath) {
      return true
    }

    const switchStartedAt = performance.now()
    const saveStartedAt = performance.now()
    const saved = await ensureNovelDocumentSaved()
    rendererPerf.recordNovelDocumentEvent({
      filePath: selectedNovelFilePath ?? file.path,
      phase: 'saveBeforeSwitch',
      durationMs: performance.now() - saveStartedAt,
    })
    if (!saved) return false

    novelDocumentSwitchStartRef.current = {
      filePath: file.path,
      startedAt: switchStartedAt,
    }
    if (novelWorkspaceRoot) {
      setNovelDocumentTabs(current => openNovelDocumentTab(
        current,
        novelWorkspaceRoot,
        file.path,
        openMode,
      ))
    }
    rendererPerf.recordNovelDocumentEvent({
      filePath: file.path,
      phase: 'select',
      durationMs: performance.now() - switchStartedAt,
    })
    return true
  }, [ensureNovelDocumentSaved, novelWorkspaceRoot, selectedNovelFilePath])

  const handleSelectNovelFileByPath = React.useCallback(async (filePath: string | null) => {
    if (!filePath) return
    const file = novelWorkspaceFileByPath.get(filePath)
    if (!file) {
      onOpenFile(filePath)
      return
    }
    const selected = await handleSelectNovelFile(file)
    if (selected && !isWritingNavigation(navState) && !isSessionsNavigation(navState)) {
      onOpenWritingWorkspace()
    }
  }, [handleSelectNovelFile, navState, novelWorkspaceFileByPath, onOpenFile, onOpenWritingWorkspace])

  const handleOpenNovelWorkspaceStart = React.useCallback(async () => {
    if (!selectedNovelFilePath) return
    if (!await ensureNovelDocumentSaved()) return
    setNovelDocumentTabs(current => ({ ...current, activePath: null }))
  }, [ensureNovelDocumentSaved, selectedNovelFilePath])

  const handleCloseNovelFileTab = React.useCallback(async (filePath: string) => {
    if (filePath !== selectedNovelFilePath) {
      setNovelDocumentTabs(current => closeNovelDocumentTab(current, filePath))
      return
    }

    if (!await ensureNovelDocumentSaved()) return
    const nextTabs = closeNovelDocumentTab(novelDocumentTabs, filePath)
    if (nextTabs.activePath) {
      novelDocumentSwitchStartRef.current = {
        filePath: nextTabs.activePath,
        startedAt: performance.now(),
      }
    }
    setNovelDocumentTabs(nextTabs)
  }, [ensureNovelDocumentSaved, novelDocumentTabs, selectedNovelFilePath])

  const prepareNovelWorkspaceBriefForSend = React.useCallback(async (sessionId: string): Promise<NovelWorkspaceBriefPreparation> => {
    if (!novelWorkspaceRoot) return { shouldSend: true }

    const saved = await ensureNovelDocumentSaved()
    if (!saved) return { shouldSend: false }

    try {
      const snapshot = await window.electronAPI.createWorkspaceVersion(novelWorkspaceRoot, { reason: 'user-preprompt' })
      const headCommit = snapshot.commitHash
      if (!headCommit) return { shouldSend: true }

      const previousCommit = getKnownWorkspaceCommit(novelWorkspaceRoot, sessionId)
      const checkpoint = { rootPath: novelWorkspaceRoot, commitHash: headCommit }
      const agentTouchedPaths = novelAgentTouchedPathsRef.current[sessionId] ?? []
      if (!previousCommit || previousCommit === headCommit) {
        return { shouldSend: true, checkpoint, agentTouchedPaths }
      }

      const changedFiles = await window.electronAPI.compareWorkspaceVersions(novelWorkspaceRoot, previousCommit, headCommit)
      const agentTouchedPathSet = new Set(agentTouchedPaths)

      const unknownChanges = changedFiles.filter(change => !agentTouchedPathSet.has(change.path))

      return {
        shouldSend: true,
        brief: buildNovelWorkspaceFreshnessBrief(unknownChanges, selectedNovelFile?.relativePath),
        checkpoint,
        agentTouchedPaths,
      }
    } catch (error) {
      console.warn('[writing] Failed to prepare workspace freshness brief:', error)
      return { shouldSend: true }
    }
  }, [ensureNovelDocumentSaved, novelWorkspaceRoot, selectedNovelFile?.relativePath])

  const checkpointNovelWorkspaceAgentTurn = React.useCallback(async (sessionId: string): Promise<void> => {
    if (!novelWorkspaceRoot || novelAgentTurnCheckpointInFlightRef.current) return

    const previousCommit = getKnownWorkspaceCommit(novelWorkspaceRoot, sessionId)
    novelAgentTouchedPathsRef.current[sessionId] = collectAgentTouchedRelativePaths(
      reviewableNovelFileChanges,
      novelWorkspaceRoot,
      novelWorkspaceFiles,
    )

    novelAgentTurnCheckpointInFlightRef.current = true
    try {
      const snapshot = await window.electronAPI.createWorkspaceVersion(novelWorkspaceRoot, { reason: 'agent-turn' })
      const headCommit = snapshot.commitHash
      if (previousCommit && headCommit && previousCommit !== headCommit) {
        const changedFiles = await window.electronAPI.compareWorkspaceVersions(novelWorkspaceRoot, previousCommit, headCommit)
        const snapshotChanges = buildWorkspaceVersionReviewChanges(changedFiles, novelWorkspaceRoot)
        const relativePaths = [...new Set(changedFiles.flatMap(change => (
          change.status === 'renamed' && change.previousPath
            ? [change.previousPath, change.path]
            : [change.path]
        )))]
        const normalizedRoot = novelWorkspaceRoot.replace(/\/+$/, '')
        const plans = await Promise.all(relativePaths.map(async relativePath => buildSnapshotRevertPlan({
          filePath: `${normalizedRoot}/${relativePath}`,
          baseContent: await window.electronAPI.readWorkspaceFileAtVersion(
            novelWorkspaceRoot,
            previousCommit,
            relativePath,
          ),
          headContent: await window.electronAPI.readWorkspaceFileAtVersion(
            novelWorkspaceRoot,
            headCommit,
            relativePath,
          ),
        })))
        setSnapshotNovelFileChanges(snapshotChanges)
        setSnapshotNovelRevert({
          sessionId,
          changePaths: snapshotChanges.map(change => change.filePath),
          plans,
        })
        novelAgentTouchedPathsRef.current[sessionId] = collectAgentTouchedRelativePaths(
          snapshotChanges.length > 0 ? snapshotChanges : reviewableNovelFileChanges,
          novelWorkspaceRoot,
          novelWorkspaceFiles,
        )
        setKnownWorkspaceCommit(novelWorkspaceRoot, sessionId, headCommit)
        const refreshSignature = latestNovelFileChangesSignatureRef.current
        const refreshKey = refreshSignature ? `${novelWorkspaceRoot}\n${refreshSignature}` : null
        if (refreshKey) pendingNovelFileChangeRefreshKeys.add(refreshKey)
        void refreshNovelWorkspaceFilesAfterMutation(novelWorkspaceRoot).then((refreshed) => {
          if (refreshed) markNovelWorkspaceFileChangesCovered(novelWorkspaceRoot)
        }).finally(() => {
          if (refreshKey) pendingNovelFileChangeRefreshKeys.delete(refreshKey)
        })
      }
      if (novelVersionDialogOpen) {
        await refreshNovelVersions()
      }
    } catch (error) {
      console.warn('[writing] Failed to create agent turn workspace version:', error)
    } finally {
      novelAgentTurnCheckpointInFlightRef.current = false
    }
  }, [markNovelWorkspaceFileChangesCovered, novelVersionDialogOpen, novelWorkspaceFiles, novelWorkspaceRoot, refreshNovelVersions, refreshNovelWorkspaceFilesAfterMutation, reviewableNovelFileChanges])

  React.useEffect(() => {
    if (!effectiveSessionId || !novelWorkspaceRoot) return

    const isProcessing = effectiveSessionIsProcessing
    const wasProcessing = novelSessionProcessingRef.current[effectiveSessionId] === true
    novelSessionProcessingRef.current[effectiveSessionId] = isProcessing

    if (!wasProcessing && isProcessing) {
      setSnapshotNovelFileChanges([])
      setSnapshotNovelRevert(null)
    }

    if (wasProcessing && !isProcessing) {
      void checkpointNovelWorkspaceAgentTurn(effectiveSessionId)
    }
  }, [checkpointNovelWorkspaceAgentTurn, effectiveSessionIsProcessing, effectiveSessionId, novelWorkspaceRoot])

  const syncSelectedNovelDocumentFromDisk = React.useCallback(async (filePath: string): Promise<boolean> => {
    if (selectedNovelFile?.path !== filePath) return true

    if (isCurrentNovelDocumentDirty()) {
      toast.error(t(
        'writing.review.acceptBlockedByUnsavedEdits',
        'Save or discard your current edits before accepting this change.'
      ))
      return false
    }

    try {
      const content = await window.electronAPI.readFile(filePath)
      if (latestNovelDocumentPathRef.current !== filePath) return true

      replaceNovelDocumentContent(content)
      rememberNovelVersionBaseline(filePath, content, 'ensure')
      return true
    } catch (error) {
      toast.error(t('writing.review.acceptFailed', 'Failed to accept this change'), {
        description: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }, [isCurrentNovelDocumentDirty, rememberNovelVersionBaseline, replaceNovelDocumentContent, selectedNovelFile?.path, t])

  React.useEffect(() => {
    if (!selectedNovelDocumentPath || novelDocumentDirty || latestNovelFileChanges.length === 0) return

    const hasSelectedFileChange = reviewableNovelFileChanges.some(change =>
      !change.error && change.filePath === selectedNovelDocumentPath
    )
    if (!hasSelectedFileChange) return

    const timeoutId = window.setTimeout(() => {
      void syncSelectedNovelDocumentFromDisk(selectedNovelDocumentPath)
    }, 250)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [
    latestNovelFileChanges.length,
    novelDocumentDirty,
    reviewableNovelFileChanges,
    selectedNovelDocumentPath,
    syncSelectedNovelDocumentFromDisk,
  ])

  const handleCreateNovelVersion = React.useCallback(async () => {
    if (!novelWorkspaceRoot) return
    const saved = await ensureNovelDocumentSaved()
    if (!saved) return

    setNovelVersionSaving(true)
    try {
      const result = await window.electronAPI.createWorkspaceVersion(novelWorkspaceRoot, { reason: 'manual' })
      if (selectedNovelDocumentPath) {
        const content = getCurrentNovelDocumentContent()
        rememberNovelVersionBaseline(selectedNovelDocumentPath, content, 'set')
      }
      await refreshNovelVersions()
      toast.success(
        result.created
          ? t('writing.version.saved', '已保存当前版本')
          : t('writing.version.noChanges', '没有新的改动需要保存')
      )
    } catch (error) {
      toast.error(t('writing.version.saveFailed', '保存版本失败'), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setNovelVersionSaving(false)
    }
  }, [ensureNovelDocumentSaved, getCurrentNovelDocumentContent, novelWorkspaceRoot, refreshNovelVersions, rememberNovelVersionBaseline, selectedNovelDocumentPath, t])

  const handleRestoreNovelVersion = React.useCallback(async (commitHash: string) => {
    if (!novelWorkspaceRoot) return
    const saved = await ensureNovelDocumentSaved()
    if (!saved) return

    setNovelVersionRestoringHash(commitHash)
    try {
      await window.electronAPI.restoreWorkspaceVersion(novelWorkspaceRoot, commitHash)
      novelVersionBaselinesRef.current = {}
      if (selectedNovelDocumentPath) {
        const content = await window.electronAPI.readFile(selectedNovelDocumentPath)
        replaceNovelDocumentContent(content)
        rememberNovelVersionBaseline(selectedNovelDocumentPath, content, 'set')
      }
      await refreshNovelVersions()
      await refreshNovelWorkspaceFilesAfterMutation(novelWorkspaceRoot)
      toast.success(t('writing.version.restored', '已恢复到所选版本'))
    } catch (error) {
      toast.error(t('writing.version.restoreFailed', '恢复版本失败'), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setNovelVersionRestoringHash(null)
    }
  }, [ensureNovelDocumentSaved, novelWorkspaceRoot, refreshNovelVersions, refreshNovelWorkspaceFilesAfterMutation, rememberNovelVersionBaseline, replaceNovelDocumentContent, selectedNovelDocumentPath, t])

  const novelReviewUndoStackRef = React.useRef<NovelReviewUndoEntry[]>([])

  const {
    novelChangeReviewStatus,
    persistNovelChangeReviewStatus,
    selectedNovelPendingChanges,
  } = useNovelReviewController({
    novelWorkspaceRoot,
    reviewableNovelFileChanges,
    selectedNovelFilePath: selectedNovelFile?.path,
  })

  React.useEffect(() => {
    novelReviewUndoStackRef.current = []
  }, [novelWorkspaceRoot])

  const pushNovelReviewUndoEntry = React.useCallback((entry: NovelReviewUndoEntry | null | undefined) => {
    if (!entry || (entry.writes.length === 0 && entry.deletes.length === 0 && Object.keys(entry.status).length === 0)) return

    novelReviewUndoStackRef.current.push(entry)
    if (novelReviewUndoStackRef.current.length > 20) {
      novelReviewUndoStackRef.current.shift()
    }
  }, [])

  const handleUndoNovelReviewAction = React.useCallback(async () => {
    const entry = novelReviewUndoStackRef.current.pop()
    if (!entry) return false

    if (novelDocumentDirty) {
      novelReviewUndoStackRef.current.push(entry)
      toast.error(t(
        'writing.review.undoBlockedByUnsavedEdits',
        'Save or discard your current edits before undoing the review action.'
      ))
      return true
    }

    try {
      for (const deleted of entry.deletes) {
        await window.electronAPI.deleteFile(deleted.filePath)
      }

      for (const write of entry.writes) {
        await window.electronAPI.writeFile(write.filePath, write.content)
      }

      persistNovelChangeReviewStatus(entry.status)

      const selectedWrite = selectedNovelFile?.path
        ? entry.writes.find(write => write.filePath === selectedNovelFile.path)
        : undefined
      if (selectedWrite) {
        replaceNovelDocumentContent(selectedWrite.content)
      }
      if (selectedNovelFile?.path && entry.deletes.some(deleted => deleted.filePath === selectedNovelFile.path)) {
        replaceNovelDocumentContent('')
      }
      if (novelWorkspaceRoot) {
        void refreshNovelWorkspaceFilesAfterMutation(novelWorkspaceRoot)
      }

      toast.success(t('writing.review.undone', 'Review action undone'))
      return true
    } catch (error) {
      novelReviewUndoStackRef.current.push(entry)
      toast.error(t('writing.review.undoFailed', 'Failed to undo review action'), {
        description: error instanceof Error ? error.message : String(error),
      })
      return true
    }
  }, [
    novelDocumentDirty,
    novelWorkspaceRoot,
    persistNovelChangeReviewStatus,
    refreshNovelWorkspaceFilesAfterMutation,
    replaceNovelDocumentContent,
    selectedNovelFile?.path,
    t,
  ])

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isNovelReviewUndoShortcut(event)) return
      if (novelReviewUndoStackRef.current.length === 0) return
      if (isTextEditingTarget(event.target)) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      void handleUndoNovelReviewAction()
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [handleUndoNovelReviewAction])

  const [dismissedNovelReviewDotKeys, setDismissedNovelReviewDotKeys] = React.useState<Set<string>>(() => new Set())
  const pendingNovelReviewDotKeysByPath = React.useMemo(() => {
    const keysByPath = new Map<string, string[]>()

    for (const change of reviewableNovelFileChanges) {
      if (change.error) continue
      const changeKey = getNovelReviewChangeKey(change)
      if (novelChangeReviewStatus[changeKey]) continue

      const keys = keysByPath.get(change.filePath) ?? []
      keys.push(changeKey)
      keysByPath.set(change.filePath, keys)
    }

    return keysByPath
  }, [novelChangeReviewStatus, reviewableNovelFileChanges])

  React.useEffect(() => {
    const pendingKeys = new Set<string>()
    for (const keys of pendingNovelReviewDotKeysByPath.values()) {
      for (const key of keys) pendingKeys.add(key)
    }

    setDismissedNovelReviewDotKeys((current) => {
      let changed = false
      const next = new Set<string>()
      for (const key of current) {
        if (pendingKeys.has(key)) {
          next.add(key)
        } else {
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [pendingNovelReviewDotKeysByPath])

  const hasNovelReviewDot = React.useCallback((filePath: string): boolean => {
    const keys = pendingNovelReviewDotKeysByPath.get(filePath)
    return !!keys?.some(key => !dismissedNovelReviewDotKeys.has(key))
  }, [dismissedNovelReviewDotKeys, pendingNovelReviewDotKeysByPath])

  const handleDismissNovelReviewDot = React.useCallback((filePath: string) => {
    const keys = pendingNovelReviewDotKeysByPath.get(filePath)
    if (!keys || keys.length === 0) return

    setDismissedNovelReviewDotKeys((current) => {
      const next = new Set(current)
      for (const key of keys) next.add(key)
      return next
    })
  }, [pendingNovelReviewDotKeysByPath])

  const handleAskAiForNovelSelection = React.useCallback(async ({ selectedText, instruction }: NovelSelectionAiRequest) => {
    if (!selectedNovelFile || !effectiveSessionId) {
      throw new Error('No active writing document or session')
    }
    const saved = await ensureNovelDocumentSaved()
    if (!saved) {
      throw new Error('Document was not saved')
    }

    try {
      const request = {
        filePath: selectedNovelFile.path,
        relativePath: selectedNovelFile.relativePath,
        selectedText,
        instruction,
      }
      if (typeof window.electronAPI.rewriteNovelSelection !== 'function') {
        const message = t(
          'writing.selectionRewrite.runtimeReloadRequired',
          'The selection rewrite runtime is out of date. Restarting the app to load the update.'
        )
        if (typeof window.electronAPI.relaunchApp === 'function') {
          toast.info(message)
          await window.electronAPI.relaunchApp()
        }
        throw new Error(message)
      }

      const result = await window.electronAPI.rewriteNovelSelection(effectiveSessionId, request)
      return result.replacement
    } catch (error) {
      toast.error(t('writing.selectionRewrite.failed', '改写选中文本失败'), {
        description: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }, [effectiveSessionId, ensureNovelDocumentSaved, selectedNovelFile, t])

  const handleAddNovelSelectionToChat = React.useCallback((message: string) => {
    if (!effectiveSessionId) return

    const currentDraft = getDraft(effectiveSessionId)
    const nextDraft = currentDraft.trim()
      ? `${currentDraft.trimEnd()}\n\n${message}`
      : message

    onInputChange(effectiveSessionId, nextDraft)
    window.dispatchEvent(new CustomEvent('craft:restore-input', {
      detail: { sessionId: effectiveSessionId, text: nextDraft },
    }))
    toast.success(t('writing.selectionContext.addedToChat', '已添加到对话框'))
  }, [effectiveSessionId, getDraft, onInputChange, t])

  const handleNovelWorkspaceSendMessage = React.useCallback<AppShellContextType['onSendMessage']>(async (
    sessionId,
    message,
    attachments,
    skillSlugs,
    badges,
    options,
  ) => {
    const preparation = sessionId === effectiveSessionId
      ? await prepareNovelWorkspaceBriefForSend(sessionId)
      : { shouldSend: true }
    if (!preparation.shouldSend) return

    const accepted = await onSendMessage(sessionId, message, attachments, skillSlugs, badges, {
      ...options,
      workspaceFreshnessContext: preparation.brief,
    })
    if (accepted === true && preparation.checkpoint) {
      setKnownWorkspaceCommit(
        preparation.checkpoint.rootPath,
        sessionId,
        preparation.checkpoint.commitHash,
      )
      if (novelAgentTouchedPathsRef.current[sessionId] === preparation.agentTouchedPaths) {
        novelAgentTouchedPathsRef.current[sessionId] = []
      }
    }
    return accepted
  }, [effectiveSessionId, onSendMessage, prepareNovelWorkspaceBriefForSend])

  const handleSendNovelSelectionToChat = React.useCallback(async (message: string) => {
    if (!effectiveSessionId) return
    const saved = await ensureNovelDocumentSaved()
    if (!saved) return
    await handleNovelWorkspaceSendMessage(effectiveSessionId, message)
  }, [effectiveSessionId, ensureNovelDocumentSaved, handleNovelWorkspaceSendMessage])

  // The navigator column now holds exactly one role — the conversation list —
  // so its width no longer flips meaning with the route.
  const navigatorPanelWidth = sessionListWidth
  const isNovelWorkspaceNavigatorActive = showNovelDocumentNavigator || showNovelWorkspacePending || showNovelWorkspaceUnavailable
  const rightWorkspaceToggleButton = React.useMemo(() => {
    if (!isNovelWorkspaceNavigatorActive || isAutoCompact) return null

    const label = rightWorkspaceVisible ? '收起右侧栏' : '展开右侧栏'
    return (
      <HeaderIconButton
        icon={rightWorkspaceVisible
          ? <PanelRightClose className="h-4 w-4" strokeWidth={1.7} />
          : <PanelRightOpen className="h-4 w-4" strokeWidth={1.7} />}
        tooltip={label}
        aria-label={label}
        aria-expanded={rightWorkspaceVisible}
        onClick={() => setRightWorkspaceVisible((visible) => !visible)}
        className="h-[26px] w-[26px] rounded-lg"
      />
    )
  }, [isAutoCompact, isNovelWorkspaceNavigatorActive, rightWorkspaceVisible])
  const directoryToggleLabel = workspaceDirectoryVisible
    ? t('writing.directory.collapse', '收起目录')
    : t('writing.directory.expand', '展开目录')
  const directoryToggleButton = showNovelWorkspaceSidebar
    ? (
      <HeaderIconButton
        icon={<FolderOpen className="h-4 w-4" strokeWidth={1.7} />}
        tooltip={directoryToggleLabel}
        aria-label={directoryToggleLabel}
        aria-expanded={workspaceDirectoryVisible}
        data-state={workspaceDirectoryVisible ? 'open' : 'closed'}
        onClick={() => setWorkspaceDirectoryVisible((visible) => !visible)}
        className="h-[26px] w-[26px] rounded-lg"
      />
    )
    : null

  // The document dock is anchored to the right edge at a width the user owns.
  // Window resizing must therefore leave it alone and let the conversation absorb
  // the difference; only the clamp applies, so the dock can never squeeze the
  // conversation below its minimum. The previous pair of effects grew the column
  // with the window, which is correct for a middle column and wrong for this one.
  React.useEffect(() => {
    if (!shouldResolveInitialShellLayoutWidths(shellWidth, MOBILE_THRESHOLD)) return
    if (!isNovelWorkspaceNavigatorActive) return

    const directoryReserve = rightWorkspaceVisible
      ? workspaceDirectoryWidth + PANEL_GAP
      : 0
    const available = shellWidth
      - activityRailOffset
      - visibleSessionListWidth
      - WRITING_ASSISTANT_MIN_WIDTH
      - directoryReserve
      - (PANEL_GAP * 2)
      - PANEL_EDGE_INSET
    const maxWidth = Math.max(NOVEL_WORKSPACE_NAVIGATOR_MIN_WIDTH, available)

    const persisted = storage.getRaw(storage.KEYS.novelWorkspaceNavigatorWidth) !== null
    const desired = persisted
      ? latestNovelWorkspaceNavigatorWidthRef.current
      : Math.round(shellWidth * DEFAULT_DOCUMENT_DOCK_WIDTH_RATIO)

    const nextWidth = Math.min(Math.max(desired, NOVEL_WORKSPACE_NAVIGATOR_MIN_WIDTH), maxWidth)
    if (nextWidth === latestNovelWorkspaceNavigatorWidthRef.current) return
    latestNovelWorkspaceNavigatorWidthRef.current = nextWidth
    setNovelWorkspaceNavigatorWidth(nextWidth)
  }, [
    activityRailOffset,
    isNovelWorkspaceNavigatorActive,
    rightWorkspaceVisible,
    shellWidth,
    visibleSessionListWidth,
    workspaceDirectoryWidth,
  ])

  React.useEffect(() => {
    if (!activeWorkspaceId) return
    const skillsCwd = activeSessionWorkingDirectory || activeWorkspace?.rootPath
    let cancelled = false
    loadSkillsForWorkspace(activeWorkspaceId, skillsCwd).then((loaded) => {
      if (!cancelled) setSkills(loaded || [])
    }).catch(err => {
      console.error('[Chat] Failed to load skills:', err)
    })
    return () => { cancelled = true }
  }, [activeSessionWorkingDirectory, activeWorkspace?.rootPath, activeWorkspaceId])

  // Derive "pinned" (non-removable) filters from the current sessionFilter path.
  // These represent filters that are implicit in the current deeplink/route and
  // should be displayed as fixed chips in the filter bar that users cannot remove.
  const pinnedFilters = useMemo(() => {
    if (!sessionFilter) return { pinnedStatusId: null as string | null, pinnedLabelId: null as string | null, pinnedFlagged: false }
    switch (sessionFilter.kind) {
      case 'state':
        return { pinnedStatusId: sessionFilter.stateId, pinnedLabelId: null, pinnedFlagged: false }
      case 'label':
        // Don't pin the __all__ pseudo-label — that just means "any label"
        return { pinnedStatusId: null, pinnedLabelId: sessionFilter.labelId !== '__all__' ? sessionFilter.labelId : null, pinnedFlagged: false }
      case 'flagged':
        return { pinnedStatusId: null, pinnedLabelId: null, pinnedFlagged: true }
      default:
        return { pinnedStatusId: null, pinnedLabelId: null, pinnedFlagged: false }
    }
  }, [sessionFilter])

  const formatGlobalSearchNovelFileTitle = useCallback(
    (file: NovelWorkspaceFile) => formatNovelWorkspaceFileTitle(file, t),
    [t],
  )
  const hasRemoteWorkspaces = useMemo(
    () => workspaces.some(workspace => workspace.remoteServer),
    [workspaces],
  )

  // Load the selected session transcript and keep only the working-set of full
  // transcripts (open panels + small recency buffer). The loader re-reads these
  // hard pins when async IPC completes, so stale loads cannot escape eviction.
  React.useEffect(() => {
    const openIds = panelStack
      .map((entry) => parseSessionIdFromRoute(entry.route))
      .filter((id): id is string => !!id)
    if (session.selected && !openIds.includes(session.selected)) {
      openIds.push(session.selected)
    }
    reconcileSessionTranscriptWorkingSet(openIds)
    if (session.selected) {
      void ensureMessagesLoaded(session.selected)
    }
  }, [session.selected, panelStack, ensureMessagesLoaded, reconcileSessionTranscriptWorkingSet])

  // Wrap delete handler to clear selection when deleting the currently selected session
  // This prevents stale state during re-renders that could cause crashes
  const handleDeleteSession = useCallback(async (sessionId: string, skipConfirmation?: boolean): Promise<boolean> => {
    // Clear selection first if this is the selected session
    if (session.selected === sessionId) {
      setSession({ selected: null })
    }
    return onDeleteSession(sessionId, skipConfirmation)
  }, [session.selected, setSession, onDeleteSession])

  const mentionFiles = React.useMemo<MentionFileReference[]>(() => {
    return novelWorkspaceFiles.map(file => ({
      path: file.path,
      relativePath: file.relativePath,
      label: formatNovelWorkspaceFileTitle(file, t),
      type: 'file',
      description: file.relativePath,
    }))
  }, [novelWorkspaceFiles, t])

  const handleOpenProjectSkills = React.useCallback(() => {
    navigate(routes.view.skills())
  }, [])
  const {
    openingProjectState,
    handleOpeningCommand: handleWorkspaceOpeningCommand,
  } = useWorkspaceProjectSurface({
    isProjectRuntime,
    fileCount: novelWorkspaceFiles.length,
    directoryCount: novelWorkspaceDirectories.length,
    createFileTitle: t('writing.createFile.menu', '新建文件'),
    createFilePlaceholder: t('writing.createFile.placeholder', '文件名，例如 新章节.md'),
    openCreateEntryDialog: openWorkspaceCreateEntryDialog,
    importFiles: handleImportNovelFiles,
    openSkills: handleOpenProjectSkills,
  })

  // Extend context value with local overrides for workspace-specific chat resources.
  const appShellContextValue = React.useMemo<AppShellContextType>(() => ({
    ...contextValue,
    onDeleteSession: handleDeleteSession,
    onSendMessage: handleNovelWorkspaceSendMessage,
    enabledSources: sources,
    skills,
    mentionFiles,
    activeSessionWorkingDirectory,
    openingProjectState,
    onWorkspaceOpeningCommand: handleWorkspaceOpeningCommand,
    labels: displayLabelConfigs,
    onSessionLabelsChange: handleSessionLabelsChange,
    enabledModes,
    sessionStatuses,
    onSessionSourcesChange: handleSessionSourcesChange,
    rightSidebarButton: null,
    isCompactMode: isAutoCompact,
    chatDisplayRef,
    onChatMatchInfoChange: handleChatMatchInfoChange,
    onTestAutomation: handleTestAutomation,
    onToggleAutomation: handleToggleAutomation,
    onDuplicateAutomation: handleDuplicateAutomation,
    onDeleteAutomation: handleDeleteAutomation,
    automationTestResults,
    getAutomationHistory,
    onReplayAutomation: handleReplayAutomation,
  }), [contextValue, handleDeleteSession, handleNovelWorkspaceSendMessage, sources, skills, mentionFiles, activeSessionWorkingDirectory, openingProjectState, handleWorkspaceOpeningCommand, displayLabelConfigs, handleSessionLabelsChange, enabledModes, sessionStatuses, handleSessionSourcesChange, isAutoCompact, handleChatMatchInfoChange, handleTestAutomation, handleToggleAutomation, handleDuplicateAutomation, handleDeleteAutomation, automationTestResults, getAutomationHistory, handleReplayAutomation])

  // Persist expanded folders to localStorage (workspace-scoped)
  React.useEffect(() => {
    if (!activeWorkspaceId) return
    storage.set(storage.KEYS.expandedFolders, [...expandedFolders], activeWorkspaceId)
  }, [expandedFolders, activeWorkspaceId])

  // Persist sidebar visibility to localStorage
  React.useEffect(() => {
    storage.set(storage.KEYS.sidebarVisible, isSidebarVisible)
  }, [isSidebarVisible])

  React.useEffect(() => {
    storage.set(storage.KEYS.activityRailVisible, isActivityRailVisible)
  }, [isActivityRailVisible])

  // Listen for sidebar toggle from menu (View → Toggle Sidebar)
  React.useEffect(() => {
    const cleanup = window.electronAPI.onMenuToggleSidebar?.(() => {
      handleToggleSidebar()
    })
    return cleanup
  }, [handleToggleSidebar])

  // Persist per-view filter map to localStorage (workspace-scoped)
  React.useEffect(() => {
    if (!activeWorkspaceId) return
    storage.set(storage.KEYS.viewFilters, viewFiltersMap, activeWorkspaceId)
  }, [viewFiltersMap, activeWorkspaceId])

  const handleAcceptNovelFileChanges = React.useCallback(async (changes: FileChange[]) => {
    const reviewableChanges = changes.filter(change => !change.error)
    const filePath = reviewableChanges[0]?.filePath
    if (!filePath || reviewableChanges.length === 0) {
      toast.error(t('writing.review.acceptUnavailable', 'Cannot accept a failed change.'))
      return
    }
    if (reviewableChanges.some(change => change.filePath !== filePath)) {
      toast.error(t('writing.review.acceptUnavailable', 'Cannot accept changes from multiple files here.'))
      return
    }

    if (selectedNovelFile?.path === filePath) {
      const saved = await ensureNovelDocumentSaved()
      if (!saved) return
    }

    let undoEntry: NovelReviewUndoEntry | undefined
    try {
      const currentContent = await window.electronAPI.readFile(filePath)
      const rejected = buildRejectFileChangesOperation(reviewableChanges, currentContent)
      if (rejected.ok) {
        const undoStatus: NovelReviewStatusMap = { ...novelChangeReviewStatus }
        for (const change of reviewableChanges) {
          undoStatus[getNovelReviewChangeKey(change)] = 'rejected'
        }
        undoEntry = {
          status: undoStatus,
          writes: rejected.operation === 'write' ? [{ filePath, content: rejected.content }] : [],
          deletes: rejected.operation === 'delete' ? [{ filePath }] : [],
        }
      }
    } catch (error) {
      console.warn('[writing] Failed to capture accept undo entry:', error)
    }

    const nextStatus: NovelReviewStatusMap = { ...novelChangeReviewStatus }
    for (const change of reviewableChanges) {
      nextStatus[getNovelReviewChangeKey(change)] = 'accepted'
    }
    persistNovelChangeReviewStatus(nextStatus)
    pushNovelReviewUndoEntry(undoEntry)
    toast.success(t('writing.review.fileAccepted', 'File changes accepted'), undoEntry ? {
      action: {
        label: t('common.undo', 'Undo'),
        onClick: () => { void handleUndoNovelReviewAction() },
      },
    } : undefined)
  }, [
    ensureNovelDocumentSaved,
    handleUndoNovelReviewAction,
    novelChangeReviewStatus,
    persistNovelChangeReviewStatus,
    pushNovelReviewUndoEntry,
    selectedNovelFile?.path,
    t,
  ])

  const handleRejectNovelFileChanges = React.useCallback(async (changes: FileChange[]) => {
    const reviewableChanges = changes.filter(change => !change.error)
    const filePath = reviewableChanges[0]?.filePath
    if (!filePath || reviewableChanges.length === 0) {
      toast.error(t('writing.review.rejectUnavailable', 'Cannot safely reject this change'))
      return
    }
    if (reviewableChanges.some(change => change.filePath !== filePath)) {
      toast.error(t('writing.review.rejectUnavailable', 'Cannot safely reject changes from multiple files here.'))
      return
    }

    if (selectedNovelFile?.path === filePath) {
      const saved = await ensureNovelDocumentSaved()
      if (!saved) return
    }

    try {
      const currentContent = await window.electronAPI.readFile(filePath)
      const rejected = buildRejectFileChangesOperation(reviewableChanges, currentContent)
      if (!rejected.ok) {
        toast.error(t('writing.review.rejectUnavailable', 'Cannot safely reject this change'), {
          description: rejected.reason,
        })
        return
      }

      const undoEntry: NovelReviewUndoEntry = {
        status: novelChangeReviewStatus,
        writes: [{ filePath, content: currentContent }],
        deletes: [],
      }
      if (rejected.operation === 'write') {
        await window.electronAPI.writeFile(filePath, rejected.content)
      } else {
        await window.electronAPI.deleteFile(filePath)
      }
      const nextStatus: NovelReviewStatusMap = {
        ...novelChangeReviewStatus,
      }
      for (const change of reviewableChanges) {
        nextStatus[getNovelReviewChangeKey(change)] = 'rejected'
      }
      persistNovelChangeReviewStatus(nextStatus)
      pushNovelReviewUndoEntry(undoEntry)

      if (selectedNovelFile?.path === filePath) {
        const nextContent = rejected.operation === 'write' ? rejected.content : ''
        replaceNovelDocumentContent(nextContent)
      }
      if (novelWorkspaceRoot) {
        void refreshNovelWorkspaceFilesAfterMutation(novelWorkspaceRoot)
      }

      toast.success(t('writing.review.fileRejected', 'File changes rejected'), {
        action: {
          label: t('common.undo', 'Undo'),
          onClick: () => { void handleUndoNovelReviewAction() },
        },
      })
    } catch (error) {
      toast.error(t('writing.review.rejectFailed', 'Failed to reject this change'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }, [
    ensureNovelDocumentSaved,
    handleUndoNovelReviewAction,
    novelChangeReviewStatus,
    novelWorkspaceRoot,
    persistNovelChangeReviewStatus,
    replaceNovelDocumentContent,
    pushNovelReviewUndoEntry,
    refreshNovelWorkspaceFilesAfterMutation,
    selectedNovelFile?.path,
    t,
  ])

  const reviewableNovelFileChangeByKey = React.useMemo(
    () => new Map(reviewableNovelFileChanges.map(change => [getNovelReviewChangeKey(change), change])),
    [reviewableNovelFileChanges]
  )
  const resolveFileChangeReviewStatus = React.useCallback<NonNullable<AppShellContextType['resolveFileChangeReviewStatus']>>(
    (sessionId, change) => {
      if (sessionId !== effectiveSessionId) return undefined
      const reviewableChange = reviewableNovelFileChangeByKey.get(getNovelReviewChangeKey(change))
      if (!reviewableChange) return undefined
      return getNovelReviewStatus(novelChangeReviewStatus, reviewableChange) ?? 'pending'
    },
    [effectiveSessionId, novelChangeReviewStatus, reviewableNovelFileChangeByKey]
  )
  const handleAcceptConversationFileChange = React.useCallback<NonNullable<AppShellContextType['onAcceptFileChange']>>(
    (sessionId, change) => {
      if (sessionId !== effectiveSessionId) return
      const reviewableChange = reviewableNovelFileChangeByKey.get(getNovelReviewChangeKey(change))
      if (reviewableChange) void handleAcceptNovelFileChanges([reviewableChange])
    },
    [effectiveSessionId, handleAcceptNovelFileChanges, reviewableNovelFileChangeByKey]
  )
  const handleRejectConversationFileChange = React.useCallback<NonNullable<AppShellContextType['onRejectFileChange']>>(
    (sessionId, change) => {
      if (sessionId !== effectiveSessionId) return
      const reviewableChange = reviewableNovelFileChangeByKey.get(getNovelReviewChangeKey(change))
      if (reviewableChange) void handleRejectNovelFileChanges([reviewableChange])
    },
    [effectiveSessionId, handleRejectNovelFileChanges, reviewableNovelFileChangeByKey]
  )
  const handleOpenConversationFileChanges = React.useCallback<NonNullable<AppShellContextType['onOpenFileChanges']>>(
    (sessionId, changes) => {
      if (sessionId !== effectiveSessionId) return
      const reviewableChanges = changes.filter(change => !change.error)
      if (reviewableChanges.length === 0) return
      setConversationDiffReview({ sessionId, changes: reviewableChanges })
      setRightWorkspaceVisible(true)
    },
    [effectiveSessionId]
  )
  const handleRevertConversationFileChanges = React.useCallback<NonNullable<AppShellContextType['onRevertFileChanges']>>(
    async (sessionId, changes) => {
      if (sessionId !== effectiveSessionId) return
      const reviewableChanges = changes.filter(change => !change.error)
      const requestedPaths = [...new Set(reviewableChanges.map(change => change.filePath))]
      if (requestedPaths.length === 0) return

      if (selectedNovelFile?.path && requestedPaths.includes(selectedNovelFile.path)) {
        const saved = await ensureNovelDocumentSaved()
        if (!saved) return
      }

      try {
        const snapshotMatches = snapshotNovelRevert?.sessionId === sessionId
          && requestedPaths.length === snapshotNovelRevert.changePaths.length
          && requestedPaths.every(path => snapshotNovelRevert.changePaths.includes(path))
        const planned: Array<{
          plan: FileRevertPlan
          current: FileState
          operation: ReturnType<typeof buildRevertOperation>
        }> = []

        if (snapshotMatches && snapshotNovelRevert) {
          for (const plan of snapshotNovelRevert.plans) {
            const current = await readCurrentFileState(plan.filePath)
            const operation = buildRevertOperation(plan, current)
            if (!operation.ok) {
              throw new Error(t(
                'writing.review.revertConflict',
                '文件已被后续编辑，无法安全撤回本轮修改。'
              ))
            }
            planned.push({ plan, current, operation })
          }
        } else {
          const changesByPath = new Map<string, FileChange[]>()
          for (const change of reviewableChanges) {
            changesByPath.set(change.filePath, [
              ...(changesByPath.get(change.filePath) ?? []),
              change,
            ])
          }
          for (const [filePath, fileChanges] of changesByPath) {
            const current = await window.electronAPI.readFile(filePath)
            const rejected = buildRejectFileChangesOperation(fileChanges, current)
            if (!rejected.ok) throw new Error(rejected.reason)
            const plan = buildSnapshotRevertPlan({
              filePath,
              baseContent: rejected.operation === 'delete' ? null : rejected.content,
              headContent: current,
            })
            planned.push({ plan, current, operation: buildRevertOperation(plan, current) })
          }
        }

        const undoEntry: NovelReviewUndoEntry = {
          status: novelChangeReviewStatus,
          writes: planned.flatMap(({ plan, current }) => (
            current == null ? [] : [{ filePath: plan.filePath, content: current }]
          )),
          deletes: planned.flatMap(({ plan, current }) => (
            current == null ? [{ filePath: plan.filePath }] : []
          )),
        }
        for (const { plan, operation } of planned) {
          if (!operation.ok || operation.operation === 'noop') continue
          if (operation.operation === 'write') {
            await window.electronAPI.writeFile(plan.filePath, operation.content)
          } else {
            await window.electronAPI.deleteFile(plan.filePath)
          }
        }

        const revertedPaths = new Set(planned.map(({ plan }) => plan.filePath))
        const nextStatus = { ...novelChangeReviewStatus }
        for (const change of [...reviewableChanges, ...reviewableNovelFileChanges]) {
          if (revertedPaths.has(change.filePath)) {
            nextStatus[getNovelReviewChangeKey(change)] = 'rejected'
          }
        }
        persistNovelChangeReviewStatus(nextStatus)
        pushNovelReviewUndoEntry(undoEntry)

        if (selectedNovelFile?.path) {
          const selectedOperation = planned.find(({ plan }) => plan.filePath === selectedNovelFile.path)
          if (selectedOperation?.operation.ok) {
            replaceNovelDocumentContent(
              selectedOperation.operation.operation === 'write'
                ? selectedOperation.operation.content
                : selectedOperation.operation.operation === 'noop'
                  ? selectedOperation.current ?? ''
                  : ''
            )
          }
        }
        if (novelWorkspaceRoot) {
          await refreshNovelWorkspaceFilesAfterMutation(novelWorkspaceRoot)
        }
        toast.success(t('writing.review.turnReverted', '已撤回本轮文件修改'), {
          action: {
            label: t('common.undo', 'Undo'),
            onClick: () => { void handleUndoNovelReviewAction() },
          },
        })
      } catch (error) {
        toast.error(t('writing.review.rejectFailed', 'Failed to reject this change'), {
          description: error instanceof Error ? error.message : String(error),
        })
      }
    },
    [
      effectiveSessionId,
      ensureNovelDocumentSaved,
      handleUndoNovelReviewAction,
      novelChangeReviewStatus,
      novelWorkspaceRoot,
      persistNovelChangeReviewStatus,
      pushNovelReviewUndoEntry,
      refreshNovelWorkspaceFilesAfterMutation,
      replaceNovelDocumentContent,
      reviewableNovelFileChanges,
      selectedNovelFile?.path,
      snapshotNovelRevert,
      t,
    ]
  )
  const appShellContextValueWithReview = React.useMemo<AppShellContextType>(() => ({
    ...appShellContextValue,
    resolveFileChangeReviewStatus,
    onAcceptFileChange: handleAcceptConversationFileChange,
    onRejectFileChange: handleRejectConversationFileChange,
    onOpenFileChanges: canPresentConversationDiffInWorkspace ? handleOpenConversationFileChanges : undefined,
    onRevertFileChanges: handleRevertConversationFileChanges,
  }), [
    appShellContextValue,
    canPresentConversationDiffInWorkspace,
    handleAcceptConversationFileChange,
    handleOpenConversationFileChanges,
    handleRejectConversationFileChange,
    handleRevertConversationFileChanges,
    resolveFileChangeReviewStatus,
  ])

  // Handler for sources view (all sources)
  const handleSourcesClick = useCallback(() => {
    navigate(routes.view.sources())
  }, [])

  // Handler for skills view
  const handleSkillsClick = useCallback(() => {
    navigate(routes.view.skills())
  }, [])

  // Handler for settings view
  const handleSettingsClick = useCallback((subpage: SettingsSubpage = 'app') => {
    navigate(routes.view.settings(subpage))
  }, [])

  const markWhatsNewSeen = useCallback(async (manifestOverride?: WhatsNewManifest | null) => {
    const manifest = manifestOverride ?? whatsNewManifest ?? await window.electronAPI.getWhatsNewManifest()
    onReleaseNotesSeen()

    if (manifest) {
      storage.set(storage.KEYS.whatsNewLastSeenDigest, manifest.digest)
      storage.set(storage.KEYS.whatsNewLastSeenVersion, manifest.version)
    } else {
      const latestVersion = await window.electronAPI.getLatestReleaseVersion()
      if (latestVersion) {
        storage.set(storage.KEYS.whatsNewLastSeenVersion, latestVersion)
      }
    }
  }, [onReleaseNotesSeen, whatsNewManifest])

  const handleWhatsNewAnnouncementOpenChange = useCallback((open: boolean) => {
    setShowWhatsNewAnnouncement(open)
    if (!open) {
      void markWhatsNewSeen()
    }
  }, [markWhatsNewSeen])

  // Handler for full release-notes history overlay (versioned, newest first)
  const handleWhatsNewClick = useCallback(async () => {
    setShowWhatsNewAnnouncement(false)
    try {
      const content = await window.electronAPI.getReleaseNotes()
      setReleaseNotesContent(
        content?.trim()
          ? content
          : '# 暂无更新记录\n\n当前安装包未附带历史 release notes。',
      )
      setShowWhatsNew(true)
      await markWhatsNewSeen()
    } catch (error) {
      console.warn('[whats-new] Failed to load release notes history:', error)
      setReleaseNotesContent(
        `# 无法加载更新记录\n\n${error instanceof Error ? error.message : 'Unknown error'}`,
      )
      setShowWhatsNew(true)
    }
  }, [markWhatsNewSeen])

  useEffect(() => {
    if (openWhatsNewSignal <= 0) return
    onOpenWhatsNewSignalHandled()
    void handleWhatsNewClick()
  }, [handleWhatsNewClick, onOpenWhatsNewSignalHandled, openWhatsNewSignal])

  const handleWhatsNewAnnouncementDetailsClick = useCallback(() => {
    setShowWhatsNewAnnouncement(false)
    void handleWhatsNewClick()
  }, [handleWhatsNewClick])

  // Create a new chat and select it
  const handleNewChat = useCallback((newPanel: boolean = false) => {
    if (!activeWorkspace) return

    // Exit search mode and switch to All Sessions
    setSearchActive(false)
    setSearchQuery('')

    // Delegate to NavigationContext which handles session creation
    navigate(
      routes.action.newSession(),
      newPanel ? { newPanel: true } : undefined
    )

    // Focus the chat input after navigation completes
    setTimeout(() => focusZone('chat', { intent: 'programmatic' }), 50)
  }, [activeWorkspace, focusZone, navigate])

  // Delete Source - simplified since agents system is removed
  const handleDeleteSource = useCallback(async (sourceSlug: string) => {
    if (!activeWorkspace) return
    try {
      await window.electronAPI.deleteSource(activeWorkspace.id, sourceSlug)
      toast.success(t('toast.deletedSource'))
    } catch (error) {
      console.error('[Chat] Failed to delete source:', error)
      toast.error(t('toast.failedToDeleteSource'))
    }
  }, [activeWorkspace])

  // Respond to menu bar "New Chat" trigger
  const menuTriggerRef = useRef(menuNewChatTrigger)
  useEffect(() => {
    // Skip initial render
    if (menuTriggerRef.current === menuNewChatTrigger) return
    menuTriggerRef.current = menuNewChatTrigger
    handleNewChat()
  }, [menuNewChatTrigger, handleNewChat])

  const getNovelWorkspaceTreeMenuActions = React.useCallback((
    entry: WorkspaceFileTreeNode,
  ): readonly WorkspaceFileTreeMenuAction[] => {
    const createEntryAction = (
      id: string,
      kind: WorkspaceCreateEntryKind,
      parentRelativePath: string,
    ): WorkspaceFileTreeMenuAction => ({
      id,
      label: kind === 'file'
        ? t('writing.createFile.menu', '新建文件')
        : t('writing.createFolder.menu', '新建文件夹'),
      icon: kind === 'file'
        ? <FilePlus className="h-3.5 w-3.5" />
        : <FolderPlus className="h-3.5 w-3.5" />,
      onSelect: () => openWorkspaceCreateEntryDialog({
        kind,
        parentRelativePath,
        title: kind === 'file'
          ? t('writing.createFile.menu', '新建文件')
          : t('writing.createFolder.menu', '新建文件夹'),
        placeholder: kind === 'file'
          ? t('writing.createFile.placeholder', '文件名，例如 新章节.md')
          : t('writing.createFolder.placeholder', '文件夹名称'),
      }),
    })
    const importAction = (
      id: string,
      parentRelativePath: string,
    ): WorkspaceFileTreeMenuAction => ({
      id,
      label: t('writing.importFile.menu', '导入文件'),
      icon: <FileUp className="h-3.5 w-3.5" />,
      onSelect: () => void handleImportNovelFiles(parentRelativePath),
    })
    const createActions = (parentRelativePath: string): WorkspaceFileTreeMenuAction[] => [
      createEntryAction(`create-file:${parentRelativePath}`, 'file', parentRelativePath),
      createEntryAction(`create-folder:${parentRelativePath}`, 'directory', parentRelativePath),
      importAction(`import-file:${parentRelativePath}`, parentRelativePath),
    ]
    const fileManagerName = getFileManagerName()

    if (entry.type === 'root') {
      return [
        ...createActions(''),
        {
          id: 'reveal-root',
          label: t('sessionMenu.showInFileManager', { fileManager: fileManagerName }),
          icon: <FolderOpen className="h-3.5 w-3.5" />,
          onSelect: () => {
            void window.electronAPI.showInFolder(entry.path)
          },
        },
        ...(activeProjectId && onOpenProjectInNewWindow ? [{
          id: 'open-project-in-new-window',
          label: t('sidebarMenu.openInNewWindow'),
          icon: <ArrowUpRight className="h-3.5 w-3.5" />,
          onSelect: () => onOpenProjectInNewWindow(activeProjectId),
        }] satisfies readonly WorkspaceFileTreeMenuAction[] : []),
        ...(activeWorkspace && onRenameProject ? [{
          id: 'rename-project',
          label: t('common.rename'),
          icon: <Pencil className="h-3.5 w-3.5" />,
          onSelect: () => {
            setNovelProjectRenameValue(activeWorkspace.name)
            setNovelProjectRenameOpen(true)
          },
        }] satisfies readonly WorkspaceFileTreeMenuAction[] : []),
        ...(activeProjectId && onSetProjectArchived ? [{
          id: 'archive-project',
          label: '归档项目',
          icon: <Archive className="h-3.5 w-3.5" />,
          onSelect: () => void onSetProjectArchived(activeProjectId, true),
        }] satisfies readonly WorkspaceFileTreeMenuAction[] : []),
        ...(activeProjectId && activeWorkspace && onRemoveProject ? [{
          id: 'remove-project',
          label: t('workspace.removeWorkspace'),
          icon: <Trash2 className="h-3.5 w-3.5" />,
          separatorBefore: true,
          variant: 'destructive' as const,
          onSelect: () => {
            const confirmed = window.confirm(
              `从列表中移除「${activeWorkspace.name}」？不会删除磁盘文件。`
            )
            if (confirmed) void onRemoveProject(activeProjectId)
          },
        }] satisfies readonly WorkspaceFileTreeMenuAction[] : []),
      ]
    }

    if (entry.type === 'file') {
      return [{
        id: `reveal:${entry.relativePath}`,
        label: t('sessionMenu.showInFileManager', { fileManager: fileManagerName }),
        icon: <FolderOpen className="h-3.5 w-3.5" />,
        onSelect: () => {
          void revealWorkspaceFile({
            path: entry.path,
            showInFolder: path => window.electronAPI.showInFolder(path),
            onError: (error) => {
              toast.error(t('toast.failedToReveal', { fileManager: fileManagerName }), {
                description: error instanceof Error ? error.message : String(error),
              })
            },
          })
        },
      }]
    }

    return [
      ...createActions(entry.relativePath),
      {
        id: `reveal:${entry.relativePath}`,
        label: t('sessionMenu.showInFileManager', { fileManager: fileManagerName }),
        icon: <FolderOpen className="h-3.5 w-3.5" />,
        onSelect: () => {
          void revealWorkspaceFile({
            path: entry.path,
            showInFolder: path => window.electronAPI.showInFolder(path),
            onError: (error) => {
              toast.error(t('toast.failedToReveal', { fileManager: fileManagerName }), {
                description: error instanceof Error ? error.message : String(error),
              })
            },
          })
        },
      },
    ]
  }, [
    activeProjectId,
    activeWorkspace,
    handleImportNovelFiles,
    onOpenProjectInNewWindow,
    onRemoveProject,
    onRenameProject,
    onSetProjectArchived,
    openWorkspaceCreateEntryDialog,
    t,
  ])

  const workspaceFileTreeLabels = React.useMemo(() => ({
    rename: t('writing.renameFile.title', '重命名'),
    delete: t('writing.deleteFile.title', '删除'),
    reviewChanged: t('writing.review.changedFile', 'Changed file'),
  }), [t])

  const hasPrimarySidebar = showNovelWorkspaceSidebar || showNovelWorkspacePending || showNovelWorkspaceUnavailable
  const showPrimarySidebar = hasPrimarySidebar && showWritingWorkspaceShell
  const activeActivityRailItem = React.useMemo<ActivityRailItemId>(() => {
    if (globalSearchOpen) return 'search'
    if (settingsSubpage) return 'settings'
    if (isAutomationsNavigation(navState)) return 'automations'
    if (isSourcesNavigation(navState)) return 'sources'
    if (isSkillsNavigation(navState)) return 'skills'
    if (isSessionsNavigation(navState)) return 'recent'
    return 'writing'
  }, [globalSearchOpen, navState, settingsSubpage])
  const activityRailControls = (
    <div
      data-testid="activity-rail-titlebar-actions"
      className="pointer-events-none fixed left-0 top-0 z-overlay flex shrink-0 translate-y-0.5 items-center justify-end gap-0.5 px-2"
      style={{ width: activityRailWidth, height: WINDOW_TITLE_BAR_HEIGHT }}
    >
      <button
        type="button"
        aria-label={isActivityRailVisible ? '收起侧边栏' : '展开侧边栏'}
        aria-expanded={isActivityRailVisible}
        title={isActivityRailVisible ? '收起侧边栏' : '展开侧边栏'}
        className="titlebar-no-drag pointer-events-auto flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-[7px] text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => setIsActivityRailVisible((visible) => !visible)}
      >
        <PanelLeftRounded className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label="搜索"
        title="搜索"
        data-tutorial="activity-search"
        className={cn(
          'titlebar-no-drag pointer-events-auto flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-[7px] text-muted-foreground outline-none transition-colors',
          'hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
          activeActivityRailItem === 'search' && 'bg-foreground/[0.07] text-foreground',
        )}
        onClick={() => setGlobalSearchOpen(true)}
      >
        <Search className="h-4 w-4" />
      </button>
    </div>
  )

  // One rail callback for every conversation, free or project. The domain rule
  // lives here, not in two parallel handlers: if the session already belongs to
  // the active runtime, just focus it in place; otherwise perform the EXPLICIT
  // cross-domain switch (activate the owning runtime, deep-link to the session).
  // Activating the runtime IS the visible whole-runtime move the ADR requires —
  // never a silent overlay — so this stays inside ADR 0006's boundary.
  const handleActivitySessionSelect = React.useCallback(async (
    sessionId: string,
    workspaceId: string,
  ) => {
    if (workspaceId === activeWorkspaceId) {
      navigateToSessionInPanel(sessionId)
    } else if (onSelectProjectSession) {
      await onSelectProjectSession(workspaceId, sessionId)
    }
    requestAnimationFrame(() => focusChatInputForSession(sessionId))
  }, [activeWorkspaceId, focusChatInputForSession, navigateToSessionInPanel, onSelectProjectSession])

  const handleActivityProjectSessionCreate = React.useCallback(async (workspaceId: string) => {
    if (workspaceId === activeWorkspaceId) {
      const session = await onCreateSession(workspaceId)
      navigateToSessionInPanel(session.id)
      return
    }

    await onSelectWorkspace(workspaceId)
    const session = await onCreateSession(workspaceId)
    if (onSelectProjectSession) {
      await onSelectProjectSession(workspaceId, session.id)
    } else {
      navigateToSessionInPanel(session.id)
    }
  }, [activeWorkspaceId, navigateToSessionInPanel, onCreateSession, onSelectProjectSession, onSelectWorkspace])

  const handleSidebarFocus = React.useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    requestAnimationFrame(() => workspaceFileTreeRef.current?.focusSelected())
  }, [])

  // Get title based on navigation state
  const listTitle = React.useMemo(() => {
    // Sources navigator
    if (isSourcesNavigation(navState)) {
      return t("sidebar.sources")
    }

    // Skills navigator
    if (isSkillsNavigation(navState)) {
      return t("sidebar.allSkills")
    }

    // Automations navigator
    if (isAutomationsNavigation(navState)) {
      if (!automationFilter) return t("sidebar.allAutomations")
      switch (automationFilter.automationType) {
        case 'scheduled': return t("sidebar.scheduled")
        case 'event': return t("sidebar.eventBased")
        case 'agentic': return t("sidebar.agentic")
        default: return t("sidebar.allAutomations")
      }
    }

    // Sessions navigator - use sessionFilter
    if (!sessionFilter) return t("sidebar.allSessions")

    switch (sessionFilter.kind) {
      case 'flagged':
        return t("sidebar.flagged")
      case 'state': {
        const state = sessionStatuses.find(s => s.id === sessionFilter.stateId)
        return state ? t(`status.${state.id}`, state.label) : t("sidebar.allSessions")
      }
      case 'label':
        return sessionFilter.labelId === '__all__' ? t("sidebar.labels") : getLabelDisplayName(labelConfigs, sessionFilter.labelId)
      case 'view':
        return sessionFilter.viewId === '__all__' ? t("sidebar.views") : viewConfigs.find(v => v.id === sessionFilter.viewId)?.name || t("sidebar.views")
      default:
        return t("sidebar.allSessions")
    }
  }, [navState, t, sessionFilter, automationFilter, labelConfigs, viewConfigs, sessionStatuses])

  const activityWorkspaceDirectory = showPrimarySidebar
    && showNovelWorkspaceSidebar
    && workspaceDirectoryVisible
    && novelWorkspaceRoot
    && activeWorkspaceId
    ? (
      <WorkspaceProjectSidebar
        sidebarRef={sidebarRef}
        treeRef={workspaceFileTreeRef}
        focused={sidebarFocused}
        onFocus={handleSidebarFocus}
        loadingLabel={t('writing.loadingWorkspace', '正在加载项目目录...')}
        emptyHint={t('chatOpening.project.emptyHint', '先说目标即可；Storyflow 不会预先创建目录。')}
        treeProps={{
          workspaceId: activeWorkspaceId,
          workspaceName: activeWorkspace?.name ?? t('writing.workspace'),
          rootPath: novelWorkspaceRoot,
          files: novelWorkspaceFiles,
          directories: novelWorkspaceDirectories,
          selectedPath: selectedNovelFile?.path,
          expandedIds: expandedFolders,
          labels: workspaceFileTreeLabels,
          onExpandedChange: handleWorkspaceTreeExpandedChange,
          onSelectFile: handleSelectNovelFile,
          onMoveEntry: handleMoveNovelWorkspaceEntry,
          onRenameEntry: handleRenameNovelWorkspaceEntry,
          onDeleteEntry: handleDeleteNovelWorkspaceEntry,
          getMenuActions: getNovelWorkspaceTreeMenuActions,
          hasReviewDot: hasNovelReviewDot,
          onDismissReviewDot: handleDismissNovelReviewDot,
        }}
      />
    )
    : undefined

  // The document and the conversation list are distinct roles and therefore own
  // distinct columns. Sharing one slot is what let a route change (opening a new
  // conversation) silently replace the manuscript.
  const writingDocumentSurface = showNovelDocumentNavigator && novelWorkspaceRoot ? (
              selectedNovelFile ? selectedNovelFileOpenTarget === 'editor' ? (
                <NovelDocumentEditorPanel
                  ref={novelDocumentEditorRef}
                  file={selectedNovelFile}
                  content={novelDocumentContent}
                  loading={novelDocumentLoading}
                  saving={novelDocumentSaving}
                  error={novelDocumentError}
                  onDocumentChanged={handleNovelDocumentChanged}
                  onAskAiForSelection={handleAskAiForNovelSelection}
                  onAddSelectionToChat={handleAddNovelSelectionToChat}
                  onSendSelectionToChat={handleSendNovelSelectionToChat}
                  reviewChanges={selectedNovelPendingChanges}
                  toolbarAccessory={(
                    <HeaderIconButton
                      icon={<History className="h-4 w-4" strokeWidth={1.7} />}
                      tooltip={t('writing.version.title', '版本管理')}
                      disabled={!novelWorkspaceRoot}
                      onClick={() => setNovelVersionDialogOpen(true)}
                      className="h-[26px] w-[26px] rounded-lg"
                    />
                  )}
                />
              ) : (
                <FileViewer
                  path={selectedNovelFile.path}
                  onClose={() => { void handleCloseNovelFileTab(selectedNovelFile.path) }}
                />
              ) : (
                <WorkspaceEmptyState
                  workspaceName={activeWorkspace?.name ?? t('writing.workspace')}
                  rootPath={novelWorkspaceRoot}
                  onCreateFile={() => handleWorkspaceOpeningCommand('create-file')}
                  onImportFiles={() => handleWorkspaceOpeningCommand('import-files')}
                  onOpenSkills={() => handleWorkspaceOpeningCommand('open-skills')}
                />
              )
            ) : showNovelWorkspacePending ? (
              <div className="flex h-full flex-col">
                <PanelHeader
                  title={isSidebarVisible ? t('writing.workspace') : undefined}
                  compensateForStoplight={!isSidebarVisible}
                  actions={(
                    <>
                      {rightWorkspaceToggleButton}
                    </>
                  )}
                />
                <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
                  {t('writing.loadingWorkspace', '正在加载项目目录...')}
                </div>
              </div>
            ) : showNovelWorkspaceUnavailable ? (
              <div className="flex h-full flex-col">
                <PanelHeader
                  title={isSidebarVisible ? t('writing.workspace') : undefined}
                  compensateForStoplight={!isSidebarVisible}
                  actions={(
                    <>
                      {rightWorkspaceToggleButton}
                    </>
                  )}
                />
                <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
                  {t('writing.workspaceUnavailable', '未检测到项目目录')}
                </div>
              </div>
            ) : null

  const writingWorkspaceHeader = showNovelDocumentNavigator && novelWorkspaceRoot ? (
    <NovelDocumentTabStrip
      files={openNovelFiles}
      activePath={selectedNovelFilePath}
      onActivate={(file) => { void handleSelectNovelFile(file) }}
      onClose={(filePath) => { void handleCloseNovelFileTab(filePath) }}
      onOpenStart={() => { void handleOpenNovelWorkspaceStart() }}
      trailingActions={(
        <>
          {directoryToggleButton}
          {rightWorkspaceToggleButton}
        </>
      )}
    />
  ) : null

  const conversationDiffSurface = conversationDiffReview?.sessionId === effectiveSessionId ? (
    <MultiDiffPreviewOverlay
      isOpen
      embedded
      consolidated
      changes={conversationDiffReview.changes}
      onClose={() => setConversationDiffReview(null)}
      reviewStatusByChangeId={Object.fromEntries(conversationDiffReview.changes.map(change => [
        change.id,
        resolveFileChangeReviewStatus(effectiveSessionId, change) ?? 'pending',
      ]))}
      onAcceptChange={change => handleAcceptConversationFileChange(effectiveSessionId, change)}
      onRejectChange={change => handleRejectConversationFileChange(effectiveSessionId, change)}
    />
  ) : null
  const activeWritingDocumentSurface = conversationDiffSurface ?? writingDocumentSurface
  const activeWritingWorkspaceHeader = conversationDiffSurface ? null : writingWorkspaceHeader
  const showWritingDocumentColumn = Boolean(
    activeWritingDocumentSurface && rightWorkspaceVisible && canPresentConversationDiffInWorkspace,
  )
  const showWorkspaceDirectoryColumn = Boolean(
    activityWorkspaceDirectory
      && rightWorkspaceVisible
      && !isAutoCompact
      && !showEmptyProjectSession,
  )
  return (
    <AppShellProvider value={appShellContextValueWithReview}>
      {/* === OUTER LAYOUT: Unified Panel Stack | Right Sidebar === */}
      <div
        ref={shellRef}
        className="flex items-stretch relative"
        style={{
          height: '100%',
          paddingRight: PANEL_EDGE_INSET,
          paddingLeft: 0,
          gap: showActivityRail ? 0 : PANEL_GAP,
          ...(contentHeaderLeadingInset !== null
            ? { '--panel-header-leading-inset': `${contentHeaderLeadingInset}px` }
            : {}),
        } as React.CSSProperties}
      >
        <AnimatePresence initial={false}>
          {showActivityRail && isActivityRailVisible ? (
            <motion.div
              key="activity-rail"
              data-testid="activity-rail-motion"
              initial={{ width: 0 }}
              animate={{ width: activityRailWidth }}
              exit={{ width: 0 }}
              transition={shouldReduceMotion ? { duration: 0 } : PANEL_SPRING}
              className="h-full min-w-0 shrink-0 overflow-hidden border-r border-border"
            >
              <ActivityRail
                activeItem={activeActivityRailItem}
                width={activityRailWidth}
                onWidthChange={setActivityRailWidth}
                workspaces={workspaces}
                runtimeWorkspaceId={activeWorkspaceId}
                activeWorkspaceId={projectWorkspaceId}
                activeSessionId={panelCount > 1 ? focusedSessionId : session.selected}
                onSelectSession={handleActivitySessionSelect}
                onCreateConversationInProject={handleActivityProjectSessionCreate}
                activeProjectSessionId={projectWorkspaceId
                  ? (panelCount > 1 ? focusedSessionId : session.selected)
                  : null}
                onAddLocalProject={onAddLocalProject}
                isAddingLocalProject={isAddingLocalProject}
                onOpenProjectInNewWindow={onOpenProjectInNewWindow}
                onRelinkProject={onRelinkProject}
                onRenameProject={onRenameProject}
                onSetProjectArchived={onSetProjectArchived}
                onRemoveProject={onRemoveProject}
                onOpenFreeConversations={onOpenFreeConversations}
                onOpenSources={handleSourcesClick}
                onOpenSkills={handleSkillsClick}
                onOpenAutomations={() => navigate(routes.view.automationsScheduled())}
                onOpenSettings={handleSettingsClick}
                onSignOut={contextValue.clientAuthState?.user ? contextValue.onClientSignOut : undefined}
                profile={profile}
                onOpenWhatsNew={handleWhatsNewClick}
                sessionActions={{
                  onRename: onRenameSession,
                  onArchive: onArchiveSession,
                  onDelete: (sessionId) => { void handleDeleteSession(sessionId) },
                }}
                whatsNew={{
                  unseen: hasUnseenReleaseNotes,
                }}
                updateIndicator={updateIndicator}
                onInstallUpdate={updateChecker.installUpdate}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>

        <div
          data-testid="panel-stack-inset"
          className="flex min-w-0 flex-1"
          style={{ paddingBottom: PANEL_EDGE_INSET, gap: PANEL_GAP }}
        >
          <WritingPrimaryContentReadyContext.Provider value={writingPrimaryContentReady}>
          <PanelStackContainer
          sidebarSlot={null}
          sidebarWidth={0}
          navigatorSlot={
            <div
              ref={sessionListPanelRef}
              style={{ width: isAutoCompact ? '100%' : navigatorPanelWidth }}
              className="h-full flex flex-col min-w-0 relative z-panel"
            >
            {(
              <>
            <PanelHeader
              title={isSidebarVisible ? listTitle : undefined}
              compensateForStoplight={!isActivityRailVisible}
              badge={automationFilter?.automationType === 'scheduled' ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-muted-foreground/50 cursor-default flex items-center titlebar-no-drag">
                      <Info className="h-3 w-3" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-[220px]">
                    Scheduling requires your machine to be running. It can be locked, but must be powered on.
                  </TooltipContent>
                </Tooltip>
              ) : undefined}
              actions={
                <>
                  {/* Filter dropdown - available in ALL chat views.
                      Shows user-added filters (removable) and pinned filters (non-removable, derived from route).
                      Pinned filters: state views pin a status, label views pin a label, flagged pins the flag. */}
                  {isSessionsNavigation(navState) && (
                    <DropdownMenu onOpenChange={(open) => { if (!open) { setFilterDropdownQuery(''); setFilterAltHeld(false) } }}>
                      <DropdownMenuTrigger asChild>
                        <HeaderIconButton
                          icon={<ListFilter className="h-4 w-4" />}
                          className={(listFilter.size > 0 || labelFilter.size > 0) ? "bg-accent/5 text-accent rounded-[8px] shadow-tinted" : "rounded-[8px]"}
                          style={(listFilter.size > 0 || labelFilter.size > 0) ? { '--shadow-color': 'var(--accent-rgb)' } as React.CSSProperties : undefined}
                        />
                      </DropdownMenuTrigger>
                      <StyledDropdownMenuContent
                        align="end"
                        light
                        minWidth="min-w-[200px]"
                        onKeyDown={(e: React.KeyboardEvent) => {
                          if (e.key === 'Alt') setFilterAltHeld(true)
                          // When on the first menu item and pressing Up, refocus the search input
                          if (e.key === 'ArrowUp' && !filterDropdownQuery.trim()) {
                            const menu = (e.target as HTMLElement).closest('[role="menu"]')
                            const items = menu?.querySelectorAll('[role="menuitem"]')
                            if (items && items.length > 0 && document.activeElement === items[0]) {
                              e.preventDefault()
                              e.stopPropagation()
                              filterDropdownInputRef.current?.focus()
                            }
                          }
                        }}
                        onKeyUp={(e: React.KeyboardEvent) => {
                          if (e.key === 'Alt') setFilterAltHeld(false)
                        }}
                      >
                        {/* Header with title and clear button (only clears user-added filters, never pinned) */}
                        <div className="flex items-center justify-between px-2 py-1.5">
                          <span className="text-xs font-medium text-muted-foreground">{t("sidebar.filterChats")}</span>
                          {(listFilter.size > 0 || labelFilter.size > 0) && (
                            <button
                              onClick={(e) => {
                                e.preventDefault()
                                setListFilter(new Map())
                                setLabelFilter(new Map())
                              }}
                              className="text-xs text-muted-foreground hover:text-foreground"
                            >
                              Clear
                            </button>
                          )}
                        </div>

                        {/* Search input — typing switches from hierarchical submenus to a flat filtered list.
                            stopPropagation prevents Radix from intercepting keys. Arrow/Enter handled for navigation. */}
                        <div className="px-1 pb-3 border-b border-foreground/5">
                          <div className="bg-background rounded-[6px] shadow-minimal px-2 py-1.5">
                            <input
                              ref={filterDropdownInputRef}
                              type="text"
                              value={filterDropdownQuery}
                              onChange={(e) => setFilterDropdownQuery(e.target.value)}
                              onKeyDown={(e) => {
                                // When input is empty, let ArrowDown/ArrowUp blur the input
                                // so Radix's native menu keyboard navigation takes over
                                if (!filterDropdownQuery.trim() && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                                  e.preventDefault()
                                  ;(e.target as HTMLInputElement).blur()
                                  // Focus the first menu item so Radix's keyboard navigation activates
                                  const menu = (e.target as HTMLElement).closest('[role="menu"]')
                                  const firstItem = menu?.querySelector('[role="menuitem"]') as HTMLElement | null
                                  firstItem?.focus()
                                  return
                                }
                                e.stopPropagation()
                                const { states: ms, labels: ml } = filterDropdownResults
                                const total = ms.length + ml.length
                                if (total === 0) return
                                switch (e.key) {
                                  case 'ArrowDown':
                                    e.preventDefault()
                                    setFilterDropdownSelectedIdx(prev => (prev < total - 1 ? prev + 1 : 0))
                                    break
                                  case 'ArrowUp':
                                    e.preventDefault()
                                    setFilterDropdownSelectedIdx(prev => (prev > 0 ? prev - 1 : total - 1))
                                    break
                                  case 'Enter': {
                                    e.preventDefault()
                                    const mode: FilterMode = e.altKey ? 'exclude' : 'include'
                                    const idx = filterDropdownSelectedIdx
                                    if (idx < ms.length) {
                                      // Toggle a status filter
                                      const state = ms[idx]
                                      if (state.id !== pinnedFilters.pinnedStatusId) {
                                        setListFilter(prev => {
                                          const next = new Map(prev)
                                          if (next.has(state.id)) next.delete(state.id)
                                          else next.set(state.id, mode)
                                          return next
                                        })
                                      }
                                    } else {
                                      // Toggle a label filter
                                      const item = ml[idx - ms.length]
                                      if (item && item.id !== pinnedFilters.pinnedLabelId) {
                                        setLabelFilter(prev => {
                                          const next = new Map(prev)
                                          if (next.has(item.id)) next.delete(item.id)
                                          else next.set(item.id, mode)
                                          return next
                                        })
                                      }
                                    }
                                    break
                                  }
                                }
                              }}
                              placeholder={t("sidebar.searchStatusesLabels")}
                              className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
                              autoFocus
                            />
                          </div>
                        </div>

                        {/* ── Conditional body: hierarchical (no query) vs flat filtered list (has query) ── */}
                        {filterDropdownQuery.trim() === '' ? (
                          <>
                            {/* === HIERARCHICAL MODE (default) === */}

                            {/* Active filter chips: pinned (non-removable) + user-added (removable) */}
                            {(pinnedFilters.pinnedFlagged || pinnedFilters.pinnedStatusId || pinnedFilters.pinnedLabelId || listFilter.size > 0 || labelFilter.size > 0) && (
                              <>
                                {/* Pinned: flagged */}
                                {pinnedFilters.pinnedFlagged && (
                                  <StyledDropdownMenuItem disabled>
                                    <FilterMenuRow
                                      icon={<Flag className="h-3.5 w-3.5" />}
                                      label={t("sidebar.flagged")}
                                      accessory={<Check className="h-3 w-3 text-muted-foreground" />}
                                    />
                                  </StyledDropdownMenuItem>
                                )}
                                {/* Pinned: status from state view */}
                                {(() => {
                                  if (!pinnedFilters.pinnedStatusId) return null
                                  const state = sessionStatuses.find(s => s.id === pinnedFilters.pinnedStatusId)
                                  if (!state) return null
                                  return (
                                    <StyledDropdownMenuItem disabled key={`pinned-status-${state.id}`}>
                                      <FilterMenuRow
                                        icon={state.icon}
                                        label={state.label}
                                        accessory={<Check className="h-3 w-3 text-muted-foreground" />}
                                        iconStyle={state.iconColorable ? { color: state.resolvedColor } : undefined}
                                        noIconContainer
                                      />
                                    </StyledDropdownMenuItem>
                                  )
                                })()}
                                {/* Pinned: label from label view */}
                                {(() => {
                                  if (!pinnedFilters.pinnedLabelId) return null
                                  const label = labelConfigById.get(pinnedFilters.pinnedLabelId)
                                  if (!label) return null
                                  return (
                                    <StyledDropdownMenuItem disabled key={`pinned-label-${label.id}`}>
                                      <FilterMenuRow
                                        icon={<LabelIcon label={label} size="lg" />}
                                        label={label.name}
                                        accessory={<Check className="h-3 w-3 text-muted-foreground" />}
                                      />
                                    </StyledDropdownMenuItem>
                                  )
                                })()}
                                {/* User-added: selected statuses with mode pill (include/exclude) */}
                                {activeStatusFilters.map(({ state, mode }) => {
                                  const applyColor = state.iconColorable
                                  return (
                                    <DropdownMenuSub key={`sel-status-${state.id}`}>
                                      <StyledDropdownMenuSubTrigger onClick={(e) => { e.preventDefault(); setListFilter(prev => { const next = new Map(prev); next.delete(state.id); return next }) }}>
                                        <FilterMenuRow
                                          icon={state.icon}
                                          label={state.label}
                                          accessory={<FilterModeBadge mode={mode} />}
                                          iconStyle={applyColor ? { color: state.resolvedColor } : undefined}
                                          noIconContainer
                                        />
                                      </StyledDropdownMenuSubTrigger>
                                      <StyledDropdownMenuSubContent minWidth="min-w-[140px]">
                                        <FilterModeSubMenuItems
                                          mode={mode}
                                          onChangeMode={(newMode) => setListFilter(prev => {
                                            const next = new Map(prev)
                                            next.set(state.id, newMode)
                                            return next
                                          })}
                                          onRemove={() => setListFilter(prev => {
                                            const next = new Map(prev)
                                            next.delete(state.id)
                                            return next
                                          })}
                                        />
                                      </StyledDropdownMenuSubContent>
                                    </DropdownMenuSub>
                                  )
                                })}
                                {/* User-added: selected labels with mode pill (include/exclude) */}
                                {activeLabelFilters.map(({ label, mode }) => {
                                  return (
                                    <DropdownMenuSub key={`sel-label-${label.id}`}>
                                      <StyledDropdownMenuSubTrigger onClick={(e) => { e.preventDefault(); setLabelFilter(prev => { const next = new Map(prev); next.delete(label.id); return next }) }}>
                                        <FilterMenuRow
                                          icon={<LabelIcon label={label} size="lg" />}
                                          label={label.name}
                                          accessory={<FilterModeBadge mode={mode} />}
                                        />
                                      </StyledDropdownMenuSubTrigger>
                                      <StyledDropdownMenuSubContent minWidth="min-w-[140px]">
                                        <FilterModeSubMenuItems
                                          mode={mode}
                                          onChangeMode={(newMode) => setLabelFilter(prev => {
                                            const next = new Map(prev)
                                            next.set(label.id, newMode)
                                            return next
                                          })}
                                          onRemove={() => setLabelFilter(prev => {
                                            const next = new Map(prev)
                                            next.delete(label.id)
                                            return next
                                          })}
                                        />
                                      </StyledDropdownMenuSubContent>
                                    </DropdownMenuSub>
                                  )
                                })}
                                <StyledDropdownMenuSeparator />
                              </>
                            )}

                            {/* Statuses submenu - hierarchical with toggle selection */}
                            <DropdownMenuSub>
                              <StyledDropdownMenuSubTrigger>
                                <Inbox className="h-3.5 w-3.5" />
                                <span className="flex-1">{t("sidebar.statuses")}</span>
                              </StyledDropdownMenuSubTrigger>
                              <StyledDropdownMenuSubContent minWidth="min-w-[180px]">
                                {sessionStatuses.map(state => {
                                  const applyColor = state.iconColorable
                                  const isPinned = state.id === pinnedFilters.pinnedStatusId
                                  const currentMode = listFilter.get(state.id)
                                  const isActive = !!currentMode && !isPinned
                                  // Active status → DropdownMenuSub with mode options (Radix safe-triangle hover)
                                  if (isActive) {
                                    return (
                                      <DropdownMenuSub key={state.id}>
                                        <StyledDropdownMenuSubTrigger onClick={(e) => { e.preventDefault(); setListFilter(prev => { const next = new Map(prev); next.delete(state.id); return next }) }}>
                                          <FilterMenuRow
                                            icon={state.icon}
                                            label={state.label}
                                            accessory={<FilterModeBadge mode={currentMode} />}
                                            iconStyle={applyColor ? { color: state.resolvedColor } : undefined}
                                            noIconContainer
                                          />
                                        </StyledDropdownMenuSubTrigger>
                                        <StyledDropdownMenuSubContent minWidth="min-w-[140px]">
                                          <FilterModeSubMenuItems
                                            mode={currentMode}
                                            onChangeMode={(newMode) => setListFilter(prev => {
                                              const next = new Map(prev)
                                              next.set(state.id, newMode)
                                              return next
                                            })}
                                            onRemove={() => setListFilter(prev => {
                                              const next = new Map(prev)
                                              next.delete(state.id)
                                              return next
                                            })}
                                          />
                                        </StyledDropdownMenuSubContent>
                                      </DropdownMenuSub>
                                    )
                                  }
                                  // Inactive / pinned status → simple toggleable item
                                  return (
                                    <AltExcludeTooltip key={state.id} show={filterAltHeld && !isPinned}>
                                      <StyledDropdownMenuItem
                                        disabled={isPinned}
                                        onClick={(e) => {
                                          if (isPinned) return
                                          e.preventDefault()
                                          setListFilter(prev => {
                                            const next = new Map(prev)
                                            if (next.has(state.id)) next.delete(state.id)
                                            else next.set(state.id, e.altKey ? 'exclude' : 'include')
                                            return next
                                          })
                                        }}
                                      >
                                        <FilterMenuRow
                                          icon={state.icon}
                                          label={state.label}
                                          accessory={isPinned ? <Check className="h-3 w-3 text-muted-foreground" /> : null}
                                          iconStyle={applyColor ? { color: state.resolvedColor } : undefined}
                                          noIconContainer
                                        />
                                      </StyledDropdownMenuItem>
                                    </AltExcludeTooltip>
                                  )
                                })}
                              </StyledDropdownMenuSubContent>
                            </DropdownMenuSub>

                            {/* Labels submenu - hierarchical tree with recursive submenus */}
                            <DropdownMenuSub>
                              <StyledDropdownMenuSubTrigger>
                                <Tag className="h-3.5 w-3.5" />
                                <span className="flex-1">{t("sidebar.labels")}</span>
                              </StyledDropdownMenuSubTrigger>
                              <StyledDropdownMenuSubContent minWidth="min-w-[180px]">
                                {labelConfigs.length === 0 ? (
                                  <StyledDropdownMenuItem disabled>
                                    <span className="text-muted-foreground">{t("table.noLabelsConfigured")}</span>
                                  </StyledDropdownMenuItem>
                                ) : (
                                  <FilterLabelItems
                                    labels={displayLabelConfigs}
                                    labelFilter={labelFilter}
                                    setLabelFilter={setLabelFilter}
                                    pinnedLabelId={pinnedFilters.pinnedLabelId}
                                    altHeld={filterAltHeld}
                                  />
                                )}
                              </StyledDropdownMenuSubContent>
                            </DropdownMenuSub>

                            {/* Group by submenu - hidden in state sub-views (always date there) */}
                            {!isStateSubView && (
                              <>
                                <StyledDropdownMenuSeparator />
                                <DropdownMenuSub>
                                  <StyledDropdownMenuSubTrigger>
                                    <Layers className="h-3.5 w-3.5" />
                                    <span className="flex-1">{t("sidebar.group")}</span>
                                  </StyledDropdownMenuSubTrigger>
                                  <StyledDropdownMenuSubContent minWidth="min-w-[140px]">
                                    <StyledDropdownMenuItem onClick={() => setChatGroupingMode('date')}>
                                      <Calendar className="h-3.5 w-3.5" />
                                      <span className="flex-1">{t("sidebar.groupByDate")}</span>
                                      {chatGroupingMode === 'date' && <Check className="h-3 w-3 text-muted-foreground" />}
                                    </StyledDropdownMenuItem>
                                    <StyledDropdownMenuItem onClick={() => setChatGroupingMode('status')}>
                                      <Inbox className="h-3.5 w-3.5" />
                                      <span className="flex-1">{t("sidebar.groupByStatus")}</span>
                                      {chatGroupingMode === 'status' && <Check className="h-3 w-3 text-muted-foreground" />}
                                    </StyledDropdownMenuItem>
                                    <StyledDropdownMenuItem onClick={() => setChatGroupingMode('unread')}>
                                      <MailOpen className="h-3.5 w-3.5" />
                                      <span className="flex-1">{t("sidebar.groupByUnread")}</span>
                                      {chatGroupingMode === 'unread' && <Check className="h-3 w-3 text-muted-foreground" />}
                                    </StyledDropdownMenuItem>
                                  </StyledDropdownMenuSubContent>
                                </DropdownMenuSub>
                              </>
                            )}

                            <StyledDropdownMenuSeparator />
                            <StyledDropdownMenuItem
                              onClick={() => {
                                setSearchActive(true)
                              }}
                            >
                              <Search className="h-3.5 w-3.5" />
                              <span className="flex-1">{t("sidebar.search")}</span>
                            </StyledDropdownMenuItem>
                          </>
                        ) : (
                          <>
                            {/* === FLAT FILTERED MODE (has query) ===
                                Uses the same filter/score logic as the # inline menu.
                                Shows matching statuses and labels in a single flat list.
                                Supports keyboard navigation (ArrowUp/Down/Enter in input). */}
                            {filterDropdownResults.states.length === 0 && filterDropdownResults.labels.length === 0 ? (
                              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                                No matching statuses or labels
                              </div>
                            ) : (
                              <div ref={filterDropdownListRef} className="max-h-[240px] overflow-y-auto py-1">
                                {/* Matched statuses */}
                                {filterDropdownResults.states.length > 0 && (
                                  <>
                                    <div className="px-3 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                                      Statuses
                                    </div>
                                    {filterDropdownResults.states.map((state, index) => {
                                      const applyColor = state.iconColorable
                                      const isPinned = state.id === pinnedFilters.pinnedStatusId
                                      const currentMode = listFilter.get(state.id)
                                      const isHighlighted = index === filterDropdownSelectedIdx
                                      const isActive = !!currentMode && !isPinned
                                      // Active status → DropdownMenuSub with mode options
                                      if (isActive) {
                                        return (
                                          <DropdownMenuSub key={`flat-status-${state.id}`}>
                                            <StyledDropdownMenuSubTrigger
                                              data-filter-selected={isHighlighted}
                                              onMouseEnter={() => setFilterDropdownSelectedIdx(index)}
                                              className={cn("mx-1", isHighlighted && "bg-foreground/5")}
                                              onClick={(e) => { e.preventDefault(); setListFilter(prev => { const next = new Map(prev); next.delete(state.id); return next }) }}
                                            >
                                              <FilterMenuRow
                                                icon={state.icon}
                                                label={state.label}
                                                accessory={<FilterModeBadge mode={currentMode} />}
                                                iconStyle={applyColor ? { color: state.resolvedColor } : undefined}
                                                noIconContainer
                                              />
                                            </StyledDropdownMenuSubTrigger>
                                            <StyledDropdownMenuSubContent minWidth="min-w-[140px]">
                                              <FilterModeSubMenuItems
                                                mode={currentMode}
                                                onChangeMode={(newMode) => setListFilter(prev => {
                                                  const next = new Map(prev)
                                                  next.set(state.id, newMode)
                                                  return next
                                                })}
                                                onRemove={() => setListFilter(prev => {
                                                  const next = new Map(prev)
                                                  next.delete(state.id)
                                                  return next
                                                })}
                                              />
                                            </StyledDropdownMenuSubContent>
                                          </DropdownMenuSub>
                                        )
                                      }
                                      // Inactive / pinned status → plain div with click-to-toggle
                                      return (
                                        <AltExcludeTooltip key={`flat-status-${state.id}`} show={filterAltHeld && !isPinned}>
                                          <div
                                            data-filter-selected={isHighlighted}
                                            onMouseEnter={() => setFilterDropdownSelectedIdx(index)}
                                            onClick={(e) => {
                                              if (isPinned) return
                                              e.preventDefault()
                                              setListFilter(prev => {
                                                const next = new Map(prev)
                                                if (next.has(state.id)) next.delete(state.id)
                                                else next.set(state.id, e.altKey ? 'exclude' : 'include')
                                                return next
                                              })
                                            }}
                                            className={cn(
                                              // SVG sizing matches StyledDropdownMenuSubTrigger so icons render at the same size
                                              "flex cursor-pointer select-none items-center gap-2 rounded-[4px] mx-1 px-2 py-1.5 text-sm [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
                                              isHighlighted && "bg-foreground/5",
                                              isPinned && "opacity-50 pointer-events-none",
                                            )}
                                          >
                                            <FilterMenuRow
                                              icon={state.icon}
                                              label={state.label}
                                              accessory={isPinned ? <Check className="h-3 w-3 text-muted-foreground" /> : null}
                                              iconStyle={applyColor ? { color: state.resolvedColor } : undefined}
                                              noIconContainer
                                            />
                                          </div>
                                        </AltExcludeTooltip>
                                      )
                                    })}
                                  </>
                                )}
                                {/* Separator between sections */}
                                {filterDropdownResults.states.length > 0 && filterDropdownResults.labels.length > 0 && (
                                  <div className="my-1 mx-2 border-t border-border/40" />
                                )}
                                {/* Matched labels — flat list with parent breadcrumbs */}
                                {filterDropdownResults.labels.length > 0 && (
                                  <>
                                    <div className="px-3 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                                      Labels
                                    </div>
                                    {filterDropdownResults.labels.map((item, index) => {
                                      // Offset by state count for unified index
                                      const flatIndex = filterDropdownResults.states.length + index
                                      const isPinned = item.id === pinnedFilters.pinnedLabelId
                                      const currentMode = labelFilter.get(item.id)
                                      const isHighlighted = flatIndex === filterDropdownSelectedIdx
                                      const isActive = !!currentMode && !isPinned
                                      const labelDisplay = item.parentPath
                                        ? <><span className="text-muted-foreground">{item.parentPath}</span>{item.label}</>
                                        : item.label
                                      // Active label → DropdownMenuSub with mode options
                                      if (isActive) {
                                        return (
                                          <DropdownMenuSub key={`flat-label-${item.id}`}>
                                            <StyledDropdownMenuSubTrigger
                                              data-filter-selected={isHighlighted}
                                              onMouseEnter={() => setFilterDropdownSelectedIdx(flatIndex)}
                                              className={cn("mx-1", isHighlighted && "bg-foreground/5")}
                                              onClick={(e) => { e.preventDefault(); setLabelFilter(prev => { const next = new Map(prev); next.delete(item.id); return next }) }}
                                            >
                                              <FilterMenuRow
                                                icon={<LabelIcon label={item.config} size="lg" />}
                                                label={labelDisplay}
                                                accessory={<FilterModeBadge mode={currentMode} />}
                                              />
                                            </StyledDropdownMenuSubTrigger>
                                            <StyledDropdownMenuSubContent minWidth="min-w-[140px]">
                                              <FilterModeSubMenuItems
                                                mode={currentMode}
                                                onChangeMode={(newMode) => setLabelFilter(prev => {
                                                  const next = new Map(prev)
                                                  next.set(item.id, newMode)
                                                  return next
                                                })}
                                                onRemove={() => setLabelFilter(prev => {
                                                  const next = new Map(prev)
                                                  next.delete(item.id)
                                                  return next
                                                })}
                                              />
                                            </StyledDropdownMenuSubContent>
                                          </DropdownMenuSub>
                                        )
                                      }
                                      // Inactive / pinned label → plain div with click-to-toggle
                                      return (
                                        <AltExcludeTooltip key={`flat-label-${item.id}`} show={filterAltHeld && !isPinned}>
                                          <div
                                            data-filter-selected={isHighlighted}
                                            onMouseEnter={() => setFilterDropdownSelectedIdx(flatIndex)}
                                            onClick={(e) => {
                                              if (isPinned) return
                                              e.preventDefault()
                                              setLabelFilter(prev => {
                                                const next = new Map(prev)
                                                if (next.has(item.id)) next.delete(item.id)
                                                else next.set(item.id, e.altKey ? 'exclude' : 'include')
                                                return next
                                              })
                                            }}
                                            className={cn(
                                              // SVG sizing matches StyledDropdownMenuSubTrigger so icons render at the same size
                                              "flex cursor-pointer select-none items-center gap-2 rounded-[4px] mx-1 px-2 py-1.5 text-sm [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
                                              isHighlighted && "bg-foreground/5",
                                              isPinned && "opacity-50 pointer-events-none",
                                            )}
                                          >
                                            <FilterMenuRow
                                              icon={<LabelIcon label={item.config} size="lg" />}
                                              label={labelDisplay}
                                              accessory={isPinned ? <Check className="h-3 w-3 text-muted-foreground" /> : null}
                                            />
                                          </div>
                                        </AltExcludeTooltip>
                                      )
                                    })}
                                  </>
                                )}
                              </div>
                            )}
                          </>
                        )}
                      </StyledDropdownMenuContent>
                    </DropdownMenu>
                  )}
                  {/* Add Source button (only for sources mode) - uses filter-aware edit config */}
                  {isSourcesNavigation(navState) && activeWorkspace && (
                    <EditPopover
                      trigger={
                        <HeaderIconButton
                          icon={<Plus className="h-4 w-4" />}
                          tooltip={t("sidebarMenu.addSource")}
                          data-tutorial="add-source-button"
                        />
                      }
                      {...getEditConfig(
                        sourceFilter?.kind === 'type' ? `add-source-${sourceFilter.sourceType}` as EditContextKey : 'add-source',
                        activeWorkspace.rootPath
                      )}
                    />
                  )}
                  {/* Add Automation button (only for automations mode) */}
                  {isAutomationsNavigation(navState) && isProjectRuntime && activeWorkspace && (
                    <EditPopover
                      trigger={
                        <HeaderIconButton
                          icon={<Plus className="h-4 w-4" />}
                          tooltip={t("sidebarMenu.addAutomation")}
                        />
                      }
                      {...getEditConfig('automation-config', activeWorkspace.rootPath)}
                    />
                  )}
                </>
              }
            />
            {/* Content: SessionList, SourcesListPanel, or SettingsNavigator based on navigation state */}
            {isSourcesNavigation(navState) && (
              /* Sources List - filtered by type if sourceFilter is active */
              <SourcesListPanel
                sources={sources}
                sourceFilter={sourceFilter}
                workspaceId={activeWorkspaceId ?? undefined}
                workspaceRootPath={activeWorkspace?.rootPath}
                activeWorkspaceId={activeWorkspaceId}
                workspaces={workspaces}
                onDeleteSource={handleDeleteSource}
                onSourceClick={handleSourceSelect}
                onDiscoverMcp={() => navigate(routes.view.mcpMarket())}
                selectedSourceSlug={isSourcesNavigation(navState) && navState.details?.type === 'source' ? navState.details.sourceSlug : null}
                localMcpEnabled={localMcpEnabled}
              />
            )}
            {isAutomationsNavigation(navState) && isProjectRuntime && (
              /* Automations List - filtered by type if automationFilter is active */
              <AutomationsListPanel
                automations={automations}
                automationFilter={automationListFilter}
                onAutomationClick={handleAutomationSelect}
                onTestAutomation={handleTestAutomation}
                onToggleAutomation={handleToggleAutomation}
                onDuplicateAutomation={handleDuplicateAutomation}
                onDeleteAutomation={handleDeleteAutomation}
                selectedAutomationId={isAutomationsNavigation(navState) && navState.details ? navState.details.automationId : null}
                workspaceRootPath={activeWorkspace?.rootPath}
                activeWorkspaceId={activeWorkspaceId}
                workspaces={workspaces}
              />
            )}
            {isSessionsNavigation(navState) && (!showActivityRail || isAutoCompact) && (
              /* Sessions List */
              <>
                {/* SessionList: Scrollable list of session cards */}
                {/* Key on sidebarMode forces full remount when switching views, skipping animations */}
                <SessionList
                  key={sessionFilter?.kind}
                  onDelete={handleDeleteSession}
                  onFlag={onFlagSession}
                  onUnflag={onUnflagSession}
                  onArchive={onArchiveSession}
                  onUnarchive={onUnarchiveSession}
                  onSessionStatusChange={onSessionStatusChange}
                  onRename={onRenameSession}
                  onFocusChatInput={(targetSessionId) => {
                    focusChatInputForSession(targetSessionId ?? focusedSessionId ?? session.selected)
                  }}
                  onNavigateToView={(view) => {
                    if (view === 'allSessions') {
                      navigate(routes.view.allSessions())
                    } else if (view === 'flagged') {
                      navigate(routes.view.flagged())
                    }
                  }}
                  searchActive={searchActive}
                  searchQuery={searchQuery}
                  onSearchChange={setSearchQuery}
                  onSearchClose={() => {
                    setSearchActive(false)
                    setSearchQuery('')
                  }}
                  sessionStatuses={sessionStatuses}
                  evaluateViews={evaluateViews}
                  labels={displayLabelConfigs}
                  onLabelsChange={handleSessionLabelsChange}
                  groupingMode={chatGroupingMode}
                  workspaceId={activeWorkspaceId ?? undefined}
                  remoteWorkspaceId={remoteWorkspaceId}
                  statusFilter={listFilter}
                  labelFilterMap={labelFilter}
                  focusedSessionId={panelCount === 0 ? null : panelCount > 1 ? focusedSessionId : undefined}
                  onNavigateToSession={panelCount > 1 ? navigateToSessionInPanel : undefined}
                  activeChatMatchInfo={chatMatchInfo}
                  hasRemoteWorkspaces={hasRemoteWorkspaces}
                  isCompactMode={isAutoCompact}
                />
              </>
            )}
              </>
            )}
            </div>
          }
          navigatorWidth={hideSessionListNavigator
            ? 0
            : isAutoCompact
              ? navigatorPanelWidth
              : (effectiveSidebarAndNavigatorHidden ? 0 : visibleSessionListWidth)}
          navigatorResizeSash={!effectiveSidebarAndNavigatorHidden && !hideSessionListNavigator ? (
            <div
              ref={sessionListHandleRef}
              data-panel-role="navigator-resize-sash"
              role="separator"
              aria-orientation="vertical"
              aria-label={isNovelWorkspaceNavigatorActive ? t('writing.workspace') : t('sidebar.allSessions')}
              onMouseDown={(e) => { beginResize('session-list', e) }}
              onMouseMove={(e) => {
                if (sessionListHandleRef.current) {
                  const rect = sessionListHandleRef.current.getBoundingClientRect()
                  setSessionListHandleY(e.clientY - rect.top)
                }
              }}
              onMouseLeave={() => {
                if (isResizing !== 'session-list' && isResizing !== 'novel-workspace-navigator') {
                  setSessionListHandleY(null)
                }
              }}
              className="relative h-full cursor-col-resize flex justify-center shrink-0 z-dropdown"
              style={{ width: 0 }}
            >
              <div
                className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 flex justify-center cursor-col-resize"
                style={{ width: PANEL_SASH_HIT_WIDTH }}
              >
                <div
                  className="absolute inset-y-0 left-1/2 -translate-x-1/2"
                  style={{
                    ...getResizeGradientStyle(sessionListHandleY, sessionListHandleRef.current?.clientHeight ?? null),
                    width: PANEL_SASH_LINE_WIDTH,
                  }}
                />
              </div>
            </div>
          ) : null}
          isSidebarAndNavigatorHidden={contentNeedsStoplightCompensation}
          isCompact={isAutoCompact}
          isResizing={!!isResizing}
          hidePanelCloseButton={showPrimarySidebar}
          rightSidebarButton={!rightWorkspaceVisible ? rightWorkspaceToggleButton : undefined}
          contentPanelMinWidth={showWritingDocumentColumn ? WRITING_ASSISTANT_MIN_WIDTH : PANEL_MIN_WIDTH}
        />
        <AnimatePresence initial={false}>
          {/* Tabs and the directory toggle belong to one stable workspace header.
              Folding the directory only reallocates the body below that header. */}
          {showWritingDocumentColumn ? (
            <ResizableColumn
              key="writing-workspace"
              mode="document-dock"
              role="document"
              sashLabel={t('writing.workspace')}
              onResizeStart={beginResize}
              width={writingWorkspaceDockWidth}
              panelRef={navigatorPanelRef}
              disableAnimation={isResizing === 'document-dock'}
            >
              <div className="flex h-full min-w-0 flex-col">
                {activeWritingWorkspaceHeader}
                <div className="flex min-h-0 flex-1">
                  <div className="min-w-0 flex-1">
                    {activeWritingDocumentSurface}
                  </div>
                  <AnimatePresence initial={false}>
                    {showWorkspaceDirectoryColumn ? (
                      <ResizableColumn
                        key="workspace-directory"
                        mode="directory-dock"
                        role="directory"
                        sashLabel={t('writing.directory.title', '目录')}
                        onResizeStart={beginResize}
                        width={workspaceDirectoryWidth}
                        disableAnimation={isResizing === 'directory-dock'}
                      >
                        {activityWorkspaceDirectory}
                      </ResizableColumn>
                    ) : null}
                  </AnimatePresence>
                </div>
              </div>
            </ResizableColumn>
          ) : null}
        </AnimatePresence>
          </WritingPrimaryContentReadyContext.Provider>
        </div>

        {showActivityRail ? activityRailControls : null}
      </div>

      <WhatsNewAnnouncementDialog
        open={showWhatsNewAnnouncement}
        copy={whatsNewAnnouncementCopy}
        accentColor={whatsNewManifest?.accentColor}
        onOpenChange={handleWhatsNewAnnouncementOpenChange}
        onShowDetails={handleWhatsNewAnnouncementDetailsClick}
      />

      <SettingsDialog
        open={settingsSubpage !== null}
        selectedSubpage={settingsSubpage ?? 'app'}
        availableSubpages={isProjectRuntime ? undefined : GLOBAL_SETTINGS_SUBPAGES}
        onSelectSubpage={handleSettingsClick}
        onClose={closeSettings}
      />

      {/* What's New overlay */}
      <DocumentFormattedMarkdownOverlay
        isOpen={showWhatsNew}
        onClose={() => setShowWhatsNew(false)}
        content={releaseNotesContent}
        onOpenUrl={(url) => window.electronAPI.openUrl(url)}
      />

      <GlobalSearchDialog
        open={globalSearchOpen}
        onOpenChange={setGlobalSearchOpen}
        workspaceId={activeWorkspaceId ?? undefined}
        workspaceLabel={activeWorkspace?.name}
        remoteWorkspaceId={remoteWorkspaceId}
        workspaces={workspaces}
        novelFiles={novelWorkspaceFiles}
        formatNovelFileTitle={formatGlobalSearchNovelFileTitle}
        onOpenWorkspace={onSelectWorkspace}
        onOpenSession={(workspaceId, sessionId, query) => {
          setSearchActive(true)
          setSearchQuery(query)
          void handleActivitySessionSelect(sessionId, workspaceId)
        }}
        onOpenNovelFile={(path) => {
          void handleSelectNovelFileByPath(path)
        }}
      />

      {/* Delete automation confirmation dialog */}
      <Dialog open={!!automationPendingDelete} onOpenChange={(open) => { if (!open) setAutomationPendingDelete(null) }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("dialog.deleteAutomation.title")}</DialogTitle>
            <DialogDescription>
              <Trans
                i18nKey="dialog.deleteAutomation.description"
                values={{ name: pendingDeleteAutomation?.name }}
                components={{ strong: <strong /> }}
              />
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAutomationPendingDelete(null)}>{t("common.cancel")}</Button>
            <Button variant="destructive" onClick={confirmDeleteAutomation}>{t("common.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Send to Workspace dialog (driven by sendToWorkspaceAtom) */}
      {sendToWorkspaceIds.length > 0 ? (
        <SendToWorkspaceDialog
          open={true}
          onOpenChange={(open) => { if (!open) setSendToWorkspaceIds([]) }}
          sessionIds={sendToWorkspaceIds}
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          onTransferComplete={handleTransferComplete}
        />
      ) : null}

      <NovelVersionHistoryDialog
        open={novelVersionDialogOpen}
        versions={novelVersions}
        loading={novelVersionsLoading}
        saving={novelVersionSaving}
        restoringHash={novelVersionRestoringHash}
        onOpenChange={setNovelVersionDialogOpen}
        onCreateVersion={handleCreateNovelVersion}
        onRefresh={refreshNovelVersions}
        onRestore={handleRestoreNovelVersion}
      />

      <Dialog
        open={!!workspaceCreateEntryTarget}
        busy={workspaceCreatingEntry}
        onOpenChange={(open) => {
          if (!open) {
            setWorkspaceCreateEntryTarget(null)
            setWorkspaceCreateEntryValue('')
          }
        }}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{workspaceCreateEntryTarget?.title}</DialogTitle>
          </DialogHeader>
          <div className="py-3">
            <Input
              value={workspaceCreateEntryValue}
              onChange={(event) => setWorkspaceCreateEntryValue(event.target.value)}
              placeholder={workspaceCreateEntryTarget?.placeholder}
              disabled={workspaceCreatingEntry}
              autoFocus
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void handleSubmitWorkspaceCreateEntry()
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={workspaceCreatingEntry}
              onClick={() => {
                setWorkspaceCreateEntryTarget(null)
                setWorkspaceCreateEntryValue('')
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              disabled={workspaceCreatingEntry || !workspaceCreateEntryValue.trim()}
              onClick={() => void handleSubmitWorkspaceCreateEntry()}
            >
              {t('common.create', '创建')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RenameDialog
        open={novelProjectRenameOpen}
        onOpenChange={setNovelProjectRenameOpen}
        title={t('common.rename')}
        value={novelProjectRenameValue}
        onValueChange={setNovelProjectRenameValue}
        onSubmit={handleSubmitNovelProjectRename}
      />

      {/* Messaging dialogs (pairing-code + WA connect) — driven by messagingDialogAtom.
          Mounted here so they survive context-menu / dropdown close. */}
      <MessagingDialogHost />
      <FirstRunTour />

    </AppShellProvider>
  )
}
