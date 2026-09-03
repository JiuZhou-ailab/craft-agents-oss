// input: Session draft text, attachments, model/source/permission controls, and processing state
// output: Free-form chat composer that submits messages and manages chat input affordances
// pos: Main app-shell message composer above the session transcript

import * as React from 'react'
import { useTranslation } from "react-i18next"
import { toast } from 'sonner'
import { AnimatePresence, motion } from 'motion/react'
import {
  Paperclip,
  ArrowUp,
  Square,
  Check,
  DatabaseZap,
  ChevronDown,
  AlertCircle,
  Image as ImageIcon,
  Plus,
  X,
} from 'lucide-react'
import { Spinner } from '@craft-agent/ui'

import * as storage from '@/lib/local-storage'
import { Button } from '@/components/ui/button'
import {
  InlineSlashCommand,
  useInlineSlashCommand,
  type SlashCommandId,
} from '@/components/ui/slash-command-menu'
import {
  InlineMentionMenu,
  useInlineMention,
  type MentionItem,
  type MentionFileReference,
  type MentionItemType,
} from '@/components/ui/mention-menu'
import {
  InlineLabelMenu,
  useInlineLabelMenu,
} from '@/components/ui/label-menu'
import type { LabelConfig } from '@craft-agent/shared/labels'
import { parseMentions } from '@/lib/mentions'
import { RichTextInput, type RichTextInputChangeMeta, type RichTextInputHandle } from '@/components/ui/rich-text-input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuPortal,
} from '@/components/ui/dropdown-menu'
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
} from '@/components/ui/styled-dropdown'
import { cn } from '@/lib/utils'
import { coerceInputText } from '@/lib/input-text'
import { loadSendMessageKeySetting } from '@/lib/input-settings'
import { isMac } from '@/lib/platform'
import { applySmartTypography } from '@/lib/smart-typography'
import { AttachmentPreview } from '../AttachmentPreview'
import { ImageSupportWarningBanner } from './ImageSupportWarningBanner'
import { ANTHROPIC_MODELS, getModelShortName, getModelDisplayName, getModelContextWindow, type ModelDefinition } from '@config/models'
import { MANAGED_MODEL_CATALOG } from '@config/managed-model-catalog'
import {
  resolveEffectiveConnectionSlug,
  isCompatProvider,
  isLocalConnection,
  isManagedLlmConnectionSlug,
  modelSupportsImages,
  modelSupportsThinking,
  modelSupportsThinkingLevel,
  resolveModelThinkingLevel,
  setModelSupportsImages,
  type LlmConnection,
} from '@config/llm-connections'
import { EditPopover, getEditConfig } from '@/components/ui/EditPopover'
import { SourceAvatar } from '@/components/ui/source-avatar'
import { SourceSelectorPopover } from '@/components/ui/SourceSelectorPopover'
import { ConnectionIcon } from '@/components/icons/ConnectionIcon'
import { FreeFormInputContextBadge } from './FreeFormInputContextBadge'
import type { FileAttachment, LoadedSource, LoadedSkill, LlmConnectionWithStatus } from '../../../../shared/types'
import type { SessionStatus } from '@/config/session-status-config'
import { PERMISSION_MODE_ORDER, type PermissionMode } from '@craft-agent/shared/agent/modes'
import { type ThinkingLevel, THINKING_LEVELS } from '@craft-agent/shared/agent/thinking-levels'
import { useEscapeInterrupt } from '@/context/EscapeInterruptContext'
import { hasOpenOverlay } from '@/lib/overlay-detection'
import { ToolbarStatusSlot } from './ToolbarStatusSlot'
import { buildPlanApprovalMessage } from '../plan-approval-message'
import { shouldHandleScopedInputEvent } from './input-event-guards'
import { clearPendingFocusForSession, consumePendingFocusForSession } from './focus-input-events'
import {
  getRecentWorkingDirs,
  addRecentWorkingDir,
} from './working-directory-history'
import { CompactPermissionModeSelector } from './CompactPermissionModeSelector'
import { DesktopPermissionModeSelector } from './DesktopPermissionModeSelector'
import { WorkingDirectoryBadge } from './WorkingDirectoryBadge'
import { resolveContextUsage } from './context-usage'
import {
  MAX_DROPPED_ATTACHMENT_FILES,
  assignSharedInputHandle,
  getPrimaryInputAction,
  getAttachmentBatchLimitError,
  groupModelMenuOptions,
  isCompositionInput,
  collectDroppedFiles,
  readAttachmentBatch,
  resolveAutoCapitalisedInput,
  shouldShowTextInput,
  type ModelMenuOption,
  type ModelMenuSeries,
} from './free-form-input-behavior'

function stripPiPrefixForDisplay(value: string): string {
  return value.startsWith('pi/') ? value.slice(3) : value
}

function toModelMenuOption(model: ModelDefinition | string): ModelMenuOption {
  if (typeof model === 'string') {
    return {
      id: model,
      name: stripPiPrefixForDisplay(getModelDisplayName(model)),
      series: stripPiPrefixForDisplay(getModelShortName(model)),
    }
  }

  const name = model.name ?? stripPiPrefixForDisplay(model.id)
  return {
    id: model.id,
    name,
    series: model.shortName?.trim() || name,
    description: model.description,
    descriptionKey: model.descriptionKey,
  }
}

function formatFollowUpChipText(text: string, fallback: string, maxLength = 50): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return fallback

  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1).trimEnd()}…`
    : normalized
}


/** Platform-specific modifier key for keyboard shortcuts */
const cmdKey = isMac ? '⌘' : 'Ctrl'

/** Default rotating placeholders are now generated inside FreeFormInput via useMemo + t() */

/** Fisher-Yates shuffle — returns a new array in random order */
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

export interface FollowUpInputItem {
  id: string
  messageId: string
  annotationId: string
  index?: number
  noteLabel: string
  selectedText: string
  color?: string
}

export interface FreeFormInputProps {
  /** Placeholder text(s) for the textarea - can be array for rotation */
  placeholder?: string | string[]
  /** Whether input is disabled */
  disabled?: boolean
  /** Whether the session is currently processing */
  isProcessing?: boolean
  /** Callback when message is submitted (skillSlugs from slash-selected skill tokens) */
  onSubmit: (message: string, attachments?: FileAttachment[], skillSlugs?: string[]) => void
  /** Callback to stop processing. Pass silent=true to skip "Response interrupted" message */
  onStop?: (silent?: boolean) => void
  /** External ref for the input */
  inputRef?: React.RefObject<RichTextInputHandle>
  /** Current model ID */
  currentModel: string
  /** Callback when model changes (includes connection slug for proper persistence) */
  onModelChange: (model: string, connection?: string) => void
  // Thinking level (session-level setting)
  /** Current thinking level ('off', 'think', 'max') */
  thinkingLevel?: ThinkingLevel
  /** Callback when thinking level changes */
  onThinkingLevelChange?: (level: ThinkingLevel) => void
  // Advanced options
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  /** Enabled permission modes for Shift+Tab cycling (min 2 modes) */
  enabledModes?: PermissionMode[]
  // Controlled input value (for persisting across mode switches and conversation changes)
  /** Current input value - if provided, component becomes controlled */
  inputValue?: string
  /** Callback when input value changes */
  onInputChange?: (value: string) => void
  /** Persisted attachment draft for this session (seeds local state on session switch) */
  attachmentsValue?: FileAttachment[]
  /** Callback when attachment list changes (add, remove, clear on send) */
  onAttachmentsChange?: (attachments: FileAttachment[]) => void
  /** When true, removes container styling (shadow, bg, rounded) - used when wrapped by InputContainer */
  unstyled?: boolean
  /** Callback when component height changes (for external animation sync) */
  onHeightChange?: (height: number) => void
  /** Callback when focus state changes */
  onFocusChange?: (focused: boolean) => void
  // Source selection
  /** Available sources (enabled only) */
  sources?: LoadedSource[]
  /** Currently enabled source slugs for this session */
  enabledSourceSlugs?: string[]
  /** Callback when source selection changes */
  onSourcesChange?: (slugs: string[]) => void
  // Skill selection (for slash commands)
  /** Available skills for slash command autocomplete */
  skills?: LoadedSkill[]
  /** Files that can be mentioned by display name while preserving their paths. */
  mentionFiles?: MentionFileReference[]
  // Label selection (for #labels)
  /** Available labels for #label autocomplete */
  labels?: LabelConfig[]
  /** Currently applied session labels */
  sessionLabels?: string[]
  /** Callback when a label is added via # menu */
  onLabelAdd?: (labelId: string) => void
  /** Workspace ID for loading skill icons */
  workspaceId?: string
  /** Current working directory path */
  workingDirectory?: string
  /** Callback when working directory changes */
  onWorkingDirectoryChange?: (path: string) => void
  /** Session folder path (for "Reset to Session Root" option) */
  sessionFolderPath?: string
  /** Session ID for scoping events like approve-plan */
  sessionId?: string
  /** Current session status of the session (for # menu state selection) */
  currentSessionStatus?: string
  /** Disable send action (for tutorial guidance) */
  disableSend?: boolean
  /** Whether the session is empty (no messages yet) - affects context badge prominence */
  isEmptySession?: boolean
  /** Context status for showing compaction indicator and token usage */
  contextStatus?: {
    /** True when SDK is actively compacting the conversation */
    isCompacting?: boolean
    /** Context tokens currently occupying the model context window */
    contextTokens?: number
    /** Model's context window size in tokens */
    contextWindow?: number
  }
  /** Follow-up annotations shown as context chips above the input */
  followUpItems?: FollowUpInputItem[]
  /** Callback when user clicks a follow-up chip body */
  onFollowUpClick?: (item: FollowUpInputItem, anchor?: { x: number; y: number }) => void
  /** Callback when user clicks the follow-up index badge */
  onFollowUpIndexClick?: (item: FollowUpInputItem) => void
  /** Enable compact mode - hides attach, sources, working directory for popover embedding */
  compactMode?: boolean
  // Connection selection (hierarchical connection → model selector)
  /** Current LLM connection slug (locked after first message) */
  currentConnection?: string
  /** Callback when connection changes (only works when session is empty) */
  onConnectionChange?: (connectionSlug: string) => void
  /** When true, the session's locked connection has been removed */
  connectionUnavailable?: boolean
  /** All available LLM connections for model and connection controls. */
  llmConnections?: LlmConnectionWithStatus[]
  /** Default LLM connection slug for the current workspace. */
  workspaceDefaultConnection?: string
  /** Refresh connections after editing model capabilities. */
  refreshLlmConnections?: () => Promise<void>
  /** Workflow states available in the # menu. */
  sessionStatuses?: SessionStatus[]
  /** Callback when a state is selected from the # menu. */
  onSessionStatusChange?: (stateId: string) => void
  /** Workspace root path for label-edit actions. */
  workspaceRootPath?: string | null
  /** Whether this input belongs to the focused panel. */
  isFocusedPanel?: boolean
}

/**
 * FreeFormInput - Self-contained textarea input with attachments and controls
 *
 * Features:
 * - Auto-growing textarea
 * - File attachments via button or drag-drop
 * - Slash commands menu
 * - Model selector
 * - Active option badges
 */
export function FreeFormInput({
  placeholder,
  disabled = false,
  isProcessing = false,
  onSubmit,
  onStop,
  inputRef: externalInputRef,
  currentModel,
  onModelChange,
  thinkingLevel = 'medium',
  onThinkingLevelChange,
  permissionMode = 'ask',
  onPermissionModeChange,
  enabledModes = PERMISSION_MODE_ORDER,
  inputValue,
  onInputChange,
  attachmentsValue,
  onAttachmentsChange,
  unstyled = false,
  onHeightChange,
  onFocusChange,
  sources = [],
  enabledSourceSlugs = [],
  onSourcesChange,
  skills = [],
  mentionFiles = [],
  labels = [],
  sessionLabels = [],
  onLabelAdd,
  workspaceId,
  workingDirectory,
  onWorkingDirectoryChange,
  sessionFolderPath,
  sessionId,
  currentSessionStatus,
  disableSend = false,
  isEmptySession = false,
  contextStatus,
  followUpItems = [],
  onFollowUpClick,
  onFollowUpIndexClick,
  compactMode = false,
  currentConnection,
  onConnectionChange,
  connectionUnavailable = false,
  llmConnections = [],
  workspaceDefaultConnection,
  refreshLlmConnections,
  sessionStatuses = [],
  onSessionStatusChange,
  workspaceRootPath = null,
  isFocusedPanel = true,
}: FreeFormInputProps) {
  const { t } = useTranslation()

  // Default rotating placeholders for onboarding/empty state (i18n-aware)
  const defaultPlaceholders = React.useMemo(() => [
    t("chatInput.placeholder.workOn"),
    t("chatInput.placeholder.shiftTab"),
    t("chatInput.placeholder.mention"),
    t("chatInput.placeholder.labels"),
    t("chatInput.placeholder.newLine"),
    t("chatInput.placeholder.sidebar", { key: cmdKey }),
  ], [t])

  const effectivePlaceholderProp = placeholder ?? defaultPlaceholders

  // Derive connectionDefaultModel per-session from the effective connection.
  // Only non-null for user-configured compat providers with fixed models.
  // Managed families always keep the cross-series model picker available.
  const connectionDefaultModel = React.useMemo(() => {
    const effectiveSlug = resolveEffectiveConnectionSlug(currentConnection, workspaceDefaultConnection, llmConnections)
    const conn = llmConnections.find(c => c.slug === effectiveSlug)
    if (!conn) return null
    if (isManagedLlmConnectionSlug(conn.slug)) return null
    if (!isCompatProvider(conn.providerType)) return null
    // Allow model switching when connection has multiple models
    if (conn.models && conn.models.length > 1) return null
    return conn.defaultModel ?? null
  }, [currentConnection, workspaceDefaultConnection, llmConnections])

  // Compute available models from the effective connection.
  // All connections have models populated by backfillAllConnectionModels().
  const availableModels = React.useMemo(() => {
    // Connection removed — don't fall through to another connection's models
    if (connectionUnavailable) return []

    // Determine effective connection using the canonical fallback chain
    const effectiveSlug = resolveEffectiveConnectionSlug(currentConnection, workspaceDefaultConnection, llmConnections)
    const connection = llmConnections.find(c => c.slug === effectiveSlug)

    if (!connection) {
      return ANTHROPIC_MODELS // Safety net — shouldn't happen
    }

    return connection.models || ANTHROPIC_MODELS
  }, [llmConnections, currentConnection, workspaceDefaultConnection, connectionUnavailable])

  const availableModelSeries = React.useMemo(
    () => groupModelMenuOptions(availableModels.map(toModelMenuOption)),
    [availableModels],
  )

  const managedModelSeries = React.useMemo(() => {
    const seriesOrder = [...new Set(MANAGED_MODEL_CATALOG.map(model => model.shortName))]
    return llmConnections
      .filter(connection => isManagedLlmConnectionSlug(connection.slug))
      .flatMap(connection => groupModelMenuOptions(
        (connection.models || []).map(toModelMenuOption),
      ).map(series => ({ connection, series })))
      .sort((left, right) => (
        seriesOrder.indexOf(left.series.name) - seriesOrder.indexOf(right.series.name)
      ))
  }, [llmConnections])

  // Get display name for current model (full name, not short name)
  const currentModelDisplayName = React.useMemo(() => {
    const modelToDisplay = connectionDefaultModel ?? currentModel
    const model = availableModels.find(m =>
      typeof m === 'string' ? m === modelToDisplay : m.id === modelToDisplay
    )
    if (!model) {
      // Fallback: use helper function to format unknown model IDs nicely
      return stripPiPrefixForDisplay(getModelDisplayName(modelToDisplay))
    }
    if (typeof model === 'string') return stripPiPrefixForDisplay(model)
    // Defensive: partial entries (custom-endpoint user-config or vision-toggle
    // promotions) may lack `name`. Fall back to the id so the trigger button
    // never goes blank.
    return model.name ?? stripPiPrefixForDisplay(model.id)
  }, [availableModels, currentModel, connectionDefaultModel])

  const contextUsage = React.useMemo(() => resolveContextUsage({
    contextTokens: contextStatus?.contextTokens,
    contextWindow: contextStatus?.contextWindow || getModelContextWindow(currentModel),
  }), [contextStatus?.contextTokens, contextStatus?.contextWindow, currentModel])

  // Group connections by provider type for hierarchical dropdown
  // Each provider (Anthropic, Pi) can have multiple connections (API Key, OAuth, etc.)
  const customConnectionsByProvider = React.useMemo(() => {
    const groups: Record<string, typeof llmConnections> = {
      'Anthropic': [],
      'Local': [],
      'Storyflow Backend': [],
    }
    for (const conn of llmConnections) {
      if (isManagedLlmConnectionSlug(conn.slug)) continue
      const provider = conn.providerType || 'anthropic'
      // Group by connection/provider identity; all groups execute through Pi.
      if (provider === 'anthropic') {
        groups['Anthropic'].push(conn)
      } else if (provider === 'pi_compat' && isLocalConnection(conn)) {
        groups['Local'].push(conn)
      } else if (provider === 'pi' || provider === 'pi_compat') {
        groups['Storyflow Backend'].push(conn)
      }
    }
    // Return only non-empty groups
    return Object.entries(groups).filter(([, conns]) => conns.length > 0)
  }, [llmConnections])

  // Find current connection details for display
  const currentConnectionDetails = React.useMemo(() => {
    if (!currentConnection) return null
    return llmConnections.find(c => c.slug === currentConnection) ?? null
  }, [llmConnections, currentConnection])

  // Effective connection: canonical fallback chain (session → workspace default → global default → first)
  const effectiveConnection = resolveEffectiveConnectionSlug(currentConnection, workspaceDefaultConnection, llmConnections)
  const isManagedEffectiveConnection = !!effectiveConnection
    && isManagedLlmConnectionSlug(effectiveConnection)

  // Effective connection details (with fallbacks) for model list
  // Unlike currentConnectionDetails which is null when no explicit connection is set,
  // this resolves to the actual connection being used (including workspace default)
  const effectiveConnectionDetails = React.useMemo(() => {
    if (!effectiveConnection) return null
    return llmConnections.find(c => c.slug === effectiveConnection) ?? null
  }, [llmConnections, effectiveConnection])
  const currentModelSupportsThinking = React.useMemo(() => {
    if (effectiveConnectionDetails) {
      return modelSupportsThinking(effectiveConnectionDetails, currentModel)
    }

    const model = availableModels.find(entry =>
      typeof entry === 'string' ? entry === currentModel : entry.id === currentModel
    )
    return !!model && typeof model !== 'string' && model.supportsThinking !== false
  }, [availableModels, currentModel, effectiveConnectionDetails])
  const availableThinkingLevels = React.useMemo(
    () => THINKING_LEVELS.filter(({ id }) =>
      id !== 'off'
      && (
        effectiveConnectionDetails
          ? modelSupportsThinkingLevel(effectiveConnectionDetails, currentModel, id)
          : currentModelSupportsThinking
      )
    ),
    [currentModel, currentModelSupportsThinking, effectiveConnectionDetails],
  )
  const effectiveThinkingLevel = React.useMemo(
    () => thinkingLevel && effectiveConnectionDetails
      ? resolveModelThinkingLevel(effectiveConnectionDetails, currentModel, thinkingLevel)
      : thinkingLevel,
    [currentModel, effectiveConnectionDetails, thinkingLevel],
  )
  const selectedThinkingLevel = THINKING_LEVELS.find(({ id }) => id === effectiveThinkingLevel)
  const currentThinkingLabel = currentModelSupportsThinking && selectedThinkingLevel
    ? t(selectedThinkingLevel.nameKey)
    : t('thinking.off')

  React.useEffect(() => {
    if (
      effectiveThinkingLevel
      && thinkingLevel
      && effectiveThinkingLevel !== thinkingLevel
    ) {
      onThinkingLevelChange?.(effectiveThinkingLevel)
    }
  }, [effectiveThinkingLevel, onThinkingLevelChange, thinkingLevel])

  // Shuffle placeholder order once per mount so each session feels fresh.
  // In compact mode, suppress desktop-keyboard guidance that is noisy or misleading
  // on narrow/mobile-like layouts.
  const placeholderOptions = React.useMemo(() => {
    if (!Array.isArray(placeholder)) return placeholder
    if (!compactMode) return placeholder
    return placeholder.filter((entry) => {
      const lower = entry.toLowerCase()
      return !lower.includes('shift + tab')
        && !lower.includes('shift + return')
        && !lower.includes('toggle the sidebar')
        && !lower.includes('⌘')
        && !lower.includes('ctrl')
    })
  }, [placeholder, compactMode])

  // Hide placeholder entirely when panel is unfocused in multi-panel layout
  const shuffledPlaceholder = React.useMemo(
    () => Array.isArray(effectivePlaceholderProp) ? shuffleArray(effectivePlaceholderProp) : effectivePlaceholderProp,
    [] // eslint-disable-line react-hooks/exhaustive-deps -- intentionally shuffle only on mount
  )
  const effectivePlaceholder = isFocusedPanel ? shuffledPlaceholder : ''

  // Performance optimization: Always use internal state for typing to avoid parent re-renders
  // Sync FROM parent on mount/change (for restoring drafts)
  // Sync TO parent on blur/submit (debounced persistence)
  const [input, setInput] = React.useState(() => coerceInputText(inputValue))
  const [attachments, setAttachments] = React.useState<FileAttachment[]>(attachmentsValue ?? [])

  // Ref to track current attachments for use in event handlers (avoids stale closure issues)
  const attachmentsRef = React.useRef<FileAttachment[]>([])
  React.useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  // Seed from parent when `attachmentsValue` changes (e.g., switching sessions).
  // `skipPersistRef` tells the save effect below that the next `attachments` change
  // is a prop-driven seed, not user intent — otherwise we'd echo the seed back to
  // the parent and risk persisting A's attachments under B's sessionId.
  const attachmentsRefsKey = React.useMemo(() => {
    if (!attachmentsValue) return ''
    return attachmentsValue.map(a => a.path).join('|')
  }, [attachmentsValue])
  const prevAttachmentsRefsKey = React.useRef(attachmentsRefsKey)
  const skipPersistRef = React.useRef(true) // treat initial mount as a prop-seed
  React.useEffect(() => {
    if (attachmentsValue === undefined) return
    if (attachmentsRefsKey === prevAttachmentsRefsKey.current) return
    prevAttachmentsRefsKey.current = attachmentsRefsKey
    skipPersistRef.current = true
    setAttachments(attachmentsValue)
  }, [attachmentsValue, attachmentsRefsKey])

  // Persist user-initiated attachment changes back to the parent. The parent stores
  // refs (path + name) and debounces the disk write, so we fire eagerly on every
  // change — add/remove/send-clear.
  const onAttachmentsChangeRef = React.useRef(onAttachmentsChange)
  onAttachmentsChangeRef.current = onAttachmentsChange
  React.useEffect(() => {
    if (skipPersistRef.current) {
      skipPersistRef.current = false
      return
    }
    onAttachmentsChangeRef.current?.(attachments)
  }, [attachments])

  // Optimistic state for source selection - updates UI immediately before IPC round-trip completes
  const [optimisticSourceSlugs, setOptimisticSourceSlugs] = React.useState(enabledSourceSlugs)

  const skillSlugs = React.useMemo(() => skills.map(s => s.slug), [skills])
  const sourceSlugs = React.useMemo(() => sources.map(s => s.config.slug), [sources])
  const selectedSourceSlugSet = React.useMemo(() => new Set(optimisticSourceSlugs), [optimisticSourceSlugs])
  const selectedSourcesForBadge = React.useMemo(
    () => sources.filter(s => selectedSourceSlugSet.has(s.config.slug)),
    [sources, selectedSourceSlugSet]
  )

  // Sync from prop when server state changes (reconciles after IPC or on external updates)
  // Use content comparison (not reference) to avoid infinite loops with empty arrays
  const prevEnabledSourceSlugsRef = React.useRef(enabledSourceSlugs)
  React.useEffect(() => {
    const prev = prevEnabledSourceSlugsRef.current
    const changed = enabledSourceSlugs.length !== prev.length ||
      enabledSourceSlugs.some((slug, i) => slug !== prev[i])

    if (changed) {
      setOptimisticSourceSlugs(enabledSourceSlugs)
      prevEnabledSourceSlugsRef.current = enabledSourceSlugs
    }
  }, [enabledSourceSlugs])

  // Sync from parent when inputValue changes externally (e.g., switching sessions)
  const prevInputValueRef = React.useRef(coerceInputText(inputValue))
  React.useEffect(() => {
    if (inputValue === undefined) return
    const nextInputValue = coerceInputText(inputValue)
    if (nextInputValue !== prevInputValueRef.current) {
      setInput(nextInputValue)
      prevInputValueRef.current = nextInputValue
    }
  }, [inputValue])

  // Debounced sync to parent (saves draft without blocking typing)
  const syncTimeoutRef = React.useRef<NodeJS.Timeout | null>(null)
  const syncToParent = React.useCallback((value: string) => {
    if (!onInputChange) return
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
    syncTimeoutRef.current = setTimeout(() => {
      onInputChange(value)
      prevInputValueRef.current = value
    }, 300) // Debounce 300ms
  }, [onInputChange])

  // Sync immediately on unmount to preserve input across mode switches
  // Also cleanup any pending debounced sync
  const inputRef = React.useRef(input)
  inputRef.current = input // Keep ref in sync with state
  const onSubmitRef = React.useRef(onSubmit)
  onSubmitRef.current = onSubmit

  React.useEffect(() => {
    return () => {
      // Cancel pending debounced sync
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
      // Immediately sync current value to parent on unmount
      // This preserves input when switching to structured input (e.g., permission request)
      if (onInputChange && inputRef.current !== prevInputValueRef.current) {
        onInputChange(inputRef.current)
      }
    }
  }, [onInputChange])

  const [isDraggingOver, setIsDraggingOver] = React.useState(false)
  const [loadingCount, setLoadingCount] = React.useState(0)
  const [sourceDropdownOpen, setSourceDropdownOpen] = React.useState(false)
  const [isFocused, setIsFocused] = React.useState(false)
  const [inputMaxHeight, setInputMaxHeight] = React.useState(540)
  const [modelDropdownOpen, setModelDropdownOpen] = React.useState(false)

  // Input settings (loaded from config)
  const [autoCapitalisation, setAutoCapitalisation] = React.useState(false)
  const [sendMessageKey, setSendMessageKey] = React.useState<'enter' | 'cmd-enter'>('enter')
  const [spellCheck, setSpellCheck] = React.useState(false)

  // Load input settings on mount
  React.useEffect(() => {
    const loadInputSettings = async () => {
      if (!window.electronAPI) return
      try {
        const [autoCapEnabled, sendKey, spellCheckEnabled] = await Promise.all([
          window.electronAPI.getAutoCapitalisation(),
          loadSendMessageKeySetting(),
          window.electronAPI.getSpellCheck(),
        ])
        setAutoCapitalisation(autoCapEnabled)
        setSendMessageKey(sendKey ?? 'enter')
        setSpellCheck(spellCheckEnabled)
      } catch (error) {
        console.error('Failed to load input settings:', error)
      }
    }
    loadInputSettings()
  }, [])

  // Double-Esc interrupt: show warning overlay on first Esc, interrupt on second
  const { showEscapeOverlay } = useEscapeInterrupt()

  // Calculate max height: min(66% of window height, 540px)
  React.useEffect(() => {
    const updateMaxHeight = () => {
      const maxFromWindow = Math.floor(window.innerHeight * 0.66)
      setInputMaxHeight(Math.min(maxFromWindow, 540))
    }
    updateMaxHeight()
    window.addEventListener('resize', updateMaxHeight)
    return () => window.removeEventListener('resize', updateMaxHeight)
  }, [])

  const dragCounterRef = React.useRef(0)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const sourceButtonRef = React.useRef<HTMLButtonElement>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  // Always keep a local handle for slash/@ caret geometry. Parent may pass a
  // shared textareaRef across session remounts (AnimatePresence mode="sync");
  // writing that shared ref directly would let the exiting instance null the
  // survivor and open menus off-screen at (0, 0).
  const richInputRef = React.useRef<RichTextInputHandle | null>(null)
  const assignRichInputRef = React.useCallback((handle: RichTextInputHandle | null) => {
    assignSharedInputHandle(
      richInputRef,
      externalInputRef as React.MutableRefObject<RichTextInputHandle | null> | undefined,
      handle,
    )
  }, [externalInputRef])

  // Track last caret position for focus restoration (e.g., after permission mode popover closes)
  const lastCaretPositionRef = React.useRef<number | null>(null)

  // Listen for craft:insert-text events (generic mechanism for inserting text into input)
  // Used by components that want to pre-fill the input with text
  React.useEffect(() => {
    const handleInsertText = (e: CustomEvent<{ text: string; sessionId?: string }>) => {
      const targetSessionId = e.detail?.sessionId
      if (!shouldHandleScopedInputEvent({ sessionId, isFocusedPanel, targetSessionId })) return

      const text = coerceInputText(e.detail?.text)
      setInput(text)
      syncToParent(text)
      // Focus the input after inserting
      setTimeout(() => {
        richInputRef.current?.focus()
        // Move cursor to end
        richInputRef.current?.setSelectionRange(text.length, text.length)
      }, 0)
    }

    window.addEventListener('craft:insert-text', handleInsertText as EventListener)
    return () => window.removeEventListener('craft:insert-text', handleInsertText as EventListener)
  }, [sessionId, isFocusedPanel, syncToParent, richInputRef])

  const clearInputDraft = React.useCallback(() => {
    setInput('')
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
    onInputChange?.('')
    prevInputValueRef.current = ''
  }, [onInputChange])

  const handleToggleModelVision = React.useCallback(async (
    connectionSlug: string,
    modelId: string,
    enabled: boolean,
  ) => {
    if (!window.electronAPI) return
    const conn = llmConnections.find(c => c.slug === connectionSlug)
    if (!conn) return
    try {
      // Strip the runtime-only status fields before passing to setModelSupportsImages,
      // so the persisted payload matches the LlmConnection schema.
      const { isAuthenticated: _a, authError: _b, isDefault: _c, ...bare } = conn
      const updated = setModelSupportsImages(bare as LlmConnection, modelId, enabled)
      const result = await window.electronAPI.saveLlmConnection(updated)
      if (!result.success) {
        console.error('Failed to toggle model vision:', result.error)
        toast.error(t('chat.modelPicker.toggleVisionFailed'))
        return
      }
      await refreshLlmConnections?.()
    } catch (error) {
      console.error('Failed to toggle model vision:', error)
      toast.error(t('chat.modelPicker.toggleVisionFailed'))
    }
  }, [llmConnections, refreshLlmConnections, t])

  const consumeInputDraftSnapshot = React.useCallback((): string => {
    const snapshot = inputRef.current.trim()
    clearInputDraft()
    return snapshot
  }, [clearInputDraft])

  type PlanApprovalEventDetail = {
    sessionId?: string
    planPath?: string
    includeDraftInput?: boolean
    source?: string
  }

  // Listen for craft:approve-plan events (used by ResponseCard's Accept Plan button)
  // This disables safe mode AND submits the message in one action
  // Only process events for this session (sessionId must match)
  React.useEffect(() => {
    const handleApprovePlan = (e: CustomEvent<PlanApprovalEventDetail>) => {
      // Only handle if this event is for our session
      if (e.detail?.sessionId && e.detail.sessionId !== sessionId) {
        return
      }

      const shouldIncludeDraft = e.detail?.includeDraftInput !== false
      const draftInput = shouldIncludeDraft ? consumeInputDraftSnapshot() : ''
      const text = buildPlanApprovalMessage({
        planPath: e.detail?.planPath,
        draftInput,
      })

      // Switch to allow-all (Auto) mode if in Explore mode (allow execution without prompts)
      // Only switch if currently in safe mode - if user is in 'ask' mode, respect their choice
      if (permissionMode === 'safe') {
        onPermissionModeChange?.('allow-all')
      }

      onSubmitRef.current(text, undefined)
    }

    window.addEventListener('craft:approve-plan', handleApprovePlan as EventListener)
    return () => window.removeEventListener('craft:approve-plan', handleApprovePlan as EventListener)
  }, [sessionId, permissionMode, onPermissionModeChange, consumeInputDraftSnapshot])

  // Listen for craft:approve-plan-with-compact events (Accept & Compact option)
  // This compacts the conversation first, then executes the plan.
  // The pending state is persisted to survive page reloads (CMD+R).
  React.useEffect(() => {
    const handleApprovePlanWithCompact = async (e: CustomEvent<PlanApprovalEventDetail>) => {
      // Only handle if this event is for our session
      if (e.detail?.sessionId && e.detail.sessionId !== sessionId) {
        return
      }

      const planPath = e.detail?.planPath
      const shouldIncludeDraft = e.detail?.includeDraftInput !== false
      const draftInputSnapshot = shouldIncludeDraft ? consumeInputDraftSnapshot() : ''

      // Switch to allow-all (Auto) mode if in Explore mode
      if (permissionMode === 'safe') {
        onPermissionModeChange?.('allow-all')
      }

      // Persist the pending plan execution state BEFORE sending /compact.
      // This allows reload recovery if CMD+R happens during compaction.
      if (sessionId) {
        await window.electronAPI.sessionCommand(sessionId, {
          type: 'setPendingPlanExecution',
          planPath: planPath ?? '',
          draftInputSnapshot,
        })
      }

      // Send /compact to trigger compaction
      onSubmitRef.current('/compact', undefined)
    }

    window.addEventListener('craft:approve-plan-with-compact', handleApprovePlanWithCompact as unknown as EventListener)
    return () => window.removeEventListener('craft:approve-plan-with-compact', handleApprovePlanWithCompact as unknown as EventListener)
  }, [sessionId, permissionMode, onPermissionModeChange, consumeInputDraftSnapshot])

  // Reload recovery: Check for pending plan execution on mount.
  // If the page reloaded after compaction completed (awaitingCompaction = false),
  // we need to send the plan execution message that was interrupted by the reload.
  // Also listen for compaction-complete in case CMD+R happened during compaction.
  React.useEffect(() => {
    if (!sessionId) return

    let hasExecuted = false

    const isExpectedReconnectError = (error: unknown): boolean => {
      const message = error instanceof Error ? error.message : String(error)
      return message.includes('Connection closed')
        || message.includes('Client disconnected')
        || message.includes('transport')
        || message.includes('socket')
    }

    const executePendingPlan = async () => {
      if (hasExecuted) return

      try {
        const pending = await window.electronAPI.getPendingPlanExecution(sessionId)
        if (!pending || pending.awaitingCompaction || pending.executionDispatched) return

        // Mark dispatched before sending so reload recovery does not double-submit
        // the same plan if onSubmit succeeds but cleanup fails during a reconnect.
        await window.electronAPI.sessionCommand(sessionId, {
          type: 'markPendingPlanExecutionDispatched',
        })

        // Compaction completed but we never sent the execution message (page reloaded).
        // Send it now and clear the pending state.
        hasExecuted = true
        const executionMessage = buildPlanApprovalMessage({
          planPath: pending.planPath,
          draftInput: pending.draftInputSnapshot,
        })
        onSubmitRef.current(executionMessage, undefined)

        await window.electronAPI.sessionCommand(sessionId, {
          type: 'clearPendingPlanExecution',
        })
      } catch (error) {
        if (!isExpectedReconnectError(error)) {
          console.error('[FreeFormInput] Failed to resume pending plan execution:', error)
        }
      }
    }

    // Check immediately on mount (handles case where compaction already completed)
    executePendingPlan()

    // Also listen for compaction-complete in case CMD+R happened during compaction.
    // When compaction finishes after reload, this listener will trigger execution.
    const handleCompactionComplete = async (e: CustomEvent<{ sessionId: string }>) => {
      if (e.detail?.sessionId !== sessionId) return
      await executePendingPlan()
    }

    window.addEventListener('craft:compaction-complete', handleCompactionComplete as unknown as EventListener)
    return () => {
      window.removeEventListener('craft:compaction-complete', handleCompactionComplete as unknown as EventListener)
    }
  }, [sessionId])

  // Listen for craft:focus-input events (restore focus after popover/dropdown closes)
  React.useEffect(() => {
    const handleFocusInput = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string }>).detail
      const targetSessionId = detail?.sessionId
      if (!shouldHandleScopedInputEvent({ sessionId, isFocusedPanel, targetSessionId })) return

      if (targetSessionId) {
        clearPendingFocusForSession(targetSessionId)
      }

      richInputRef.current?.focus()
      // Restore caret position if saved, then clear it (one-shot)
      if (lastCaretPositionRef.current !== null) {
        richInputRef.current?.setSelectionRange(
          lastCaretPositionRef.current,
          lastCaretPositionRef.current
        )
        lastCaretPositionRef.current = null
      }
    }

    window.addEventListener('craft:focus-input', handleFocusInput)
    return () => window.removeEventListener('craft:focus-input', handleFocusInput)
  }, [sessionId, isFocusedPanel, richInputRef])

  // Recover queued focus requests after session switch/mount races.
  React.useEffect(() => {
    if (!consumePendingFocusForSession(sessionId)) return

    const timer = setTimeout(() => {
      richInputRef.current?.focus()
    }, 0)

    return () => clearTimeout(timer)
  }, [sessionId, richInputRef])

  // Get the next available number for a pasted file prefix (e.g., pasted-image-1, pasted-image-2)
  const getNextPastedNumber = (
    prefix: 'image' | 'text' | 'file',
    existingAttachments: FileAttachment[]
  ): number => {
    const pattern = new RegExp(`^pasted-${prefix}-(\\d+)\\.`)
    let maxNum = 0
    for (const att of existingAttachments) {
      const match = att.name.match(pattern)
      if (match) {
        maxNum = Math.max(maxNum, parseInt(match[1], 10))
      }
    }
    return maxNum + 1
  }

  // Listen for craft:paste-files events (for global paste when input not focused)
  React.useEffect(() => {
    const handlePasteFiles = async (e: CustomEvent<{ files: File[]; sessionId?: string }>) => {
      if (disabled) return

      const targetSessionId = e.detail?.sessionId
      if (!shouldHandleScopedInputEvent({ sessionId, isFocusedPanel, targetSessionId })) return

      const { files } = e.detail
      if (!files || files.length === 0) return

      // Pre-assign sequential names using ref to avoid race conditions
      let nextImageNum = getNextPastedNumber('image', attachmentsRef.current)
      const fileNames: string[] = files.map(file => {
        if (!file.name || file.name === 'image.png' || file.name === 'image.jpg' || file.name === 'blob') {
          const ext = file.type.split('/')[1] || 'png'
          return `pasted-image-${nextImageNum++}.${ext}`
        }
        return file.name
      })

      await processFileAttachments(files, fileNames)

      // Focus the input after adding attachments
      richInputRef.current?.focus()
    }

    window.addEventListener('craft:paste-files', handlePasteFiles as unknown as EventListener)
    return () => window.removeEventListener('craft:paste-files', handlePasteFiles as unknown as EventListener)
  }, [disabled, sessionId, isFocusedPanel, richInputRef])

  // Build active commands list for slash command menu
  const activeCommands = React.useMemo(() => {
    const active: SlashCommandId[] = []
    // Add the currently active permission mode
    if (permissionMode === 'safe') active.push('safe')
    else if (permissionMode === 'ask') active.push('ask')
    else if (permissionMode === 'allow-all') active.push('allow-all')
    return active
  }, [permissionMode])

  // Handle slash command selection (mode/feature commands)
  const handleSlashCommand = React.useCallback((commandId: SlashCommandId) => {
    if (commandId === 'safe') onPermissionModeChange?.('safe')
    else if (commandId === 'ask') onPermissionModeChange?.('ask')
    else if (commandId === 'allow-all') onPermissionModeChange?.('allow-all')
    else if (commandId === 'compact' && !isProcessing) onSubmit('/compact', undefined)
  }, [onPermissionModeChange, isProcessing, onSubmit])

  // Handle folder selection from slash command menu
  const handleSlashFolderSelect = React.useCallback((path: string) => {
    if (onWorkingDirectoryChange) {
      setRecentFolders(addRecentWorkingDir(path, workspaceId))
      onWorkingDirectoryChange(path)
    }
  }, [onWorkingDirectoryChange, workspaceId])

  // Get recent folders and home directory for slash menu and mention menu
  const [recentFolders, setRecentFolders] = React.useState<string[]>([])
  const [homeDir, setHomeDir] = React.useState<string>('')

  React.useEffect(() => {
    setRecentFolders(getRecentWorkingDirs(workspaceId))
    window.electronAPI?.getHomeDir?.().then((dir: string) => {
      if (dir) setHomeDir(dir)
    })
  }, [workspaceId])

  // Inline slash command hook (modes, skills, features, and folders)
  const inlineSlash = useInlineSlashCommand({
    inputRef: richInputRef,
    onSelectCommand: handleSlashCommand,
    onSelectFolder: handleSlashFolderSelect,
    activeCommands,
    skills,
    recentFolders,
    homeDir,
  })
  const slashListboxId = React.useId()
  const [activeSlashOptionId, setActiveSlashOptionId] = React.useState<string>()

  // Handle mention selection (sources, skills, files)
  const handleMentionSelect = React.useCallback((item: MentionItem) => {
    // For sources: enable the source immediately
    if (item.type === 'source' && item.source && onSourcesChange) {
      const slug = item.source.config.slug
      if (!optimisticSourceSlugs.includes(slug)) {
        const newSlugs = [...optimisticSourceSlugs, slug]
        setOptimisticSourceSlugs(newSlugs)
        onSourcesChange(newSlugs)
      }
    }

    // Files via @ mention in text are sufficient context for the agent.
  }, [optimisticSourceSlugs, onSourcesChange])

  // Inline mention hook (for sources and files; skills are selected via /)
  const inlineMention = useInlineMention({
    inputRef: richInputRef,
    skills,
    sources,
    files: mentionFiles,
    basePath: workingDirectory,
    onSelect: handleMentionSelect,
  })

  // Inline label menu hook (for #labels)
  const handleLabelSelect = React.useCallback((labelId: string) => {
    onLabelAdd?.(labelId)
  }, [onLabelAdd])

  const inlineLabel = useInlineLabelMenu({
    inputRef: richInputRef,
    labels,
    sessionLabels,
    onSelect: handleLabelSelect,
    sessionStatuses,
    activeStateId: currentSessionStatus,
  })

  // "Add New Label" handler: cleans up the #trigger text and opens a controlled
  // EditPopover so the user can describe the label before the agent creates it.
  const [addLabelPopoverOpen, setAddLabelPopoverOpen] = React.useState(false)
  const [addLabelPrefill, setAddLabelPrefill] = React.useState('')
  const handleAddLabel = React.useCallback((prefill: string) => {
    if (!workspaceRootPath) return

    // Remove the #trigger text from input
    const cleaned = inlineLabel.handleSelect('')
    setInput(cleaned)
    syncToParent(cleaned)
    inlineLabel.close()

    // Store the prefill text (e.g., "Test" from "#Test") to pre-fill the popover
    // Format: "Add new label {prefill}" so user can just press enter or modify
    setAddLabelPrefill(prefill ? t('labels.addNewLabel', { prefill }) : '')

    // Open the EditPopover for label creation
    setAddLabelPopoverOpen(true)
  }, [workspaceRootPath, inlineLabel, syncToParent, t])

  // Memoize the add-label config so the EditPopover doesn't recreate on every render
  const addLabelEditConfig = React.useMemo(() => {
    if (!workspaceRootPath) return null
    return getEditConfig('add-label', workspaceRootPath)
  }, [workspaceRootPath])

  // Report height changes to parent (for external animation sync)
  React.useLayoutEffect(() => {
    if (!onHeightChange || !containerRef.current) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        onHeightChange(entry.contentRect.height)
      }
    })

    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [onHeightChange])

  // In compact mode, immediately report collapsed height when processing state changes
  // This ensures smooth animation timing when input collapses/expands
  React.useEffect(() => {
    if (!onHeightChange || !compactMode) return
    if (isProcessing) {
      // Collapsed state - only bottom bar visible (~44px)
      onHeightChange(44)
    }
    // When not processing, ResizeObserver will report the full height
  }, [compactMode, isProcessing, onHeightChange])

  // Check if running in Electron environment (has electronAPI)
  const hasElectronAPI = typeof window !== 'undefined' && !!window.electronAPI

  // Helper to read a File using FileReader API
  const readFileAsAttachment = async (file: File, overrideName?: string): Promise<FileAttachment | null> => {
    // Capture the absolute OS path at attach time. Works for <input type="file"> and
    // OS drag-drop; returns null for clipboard paste and web-drag (no disk origin).
    // When null, the draft layer falls back to persisting content inline (Track C).
    const realPath = hasElectronAPI ? window.electronAPI.getFilePath?.(file) ?? null : null

    if (realPath) {
      const attachment = await window.electronAPI.readUserAttachment(realPath)
      return attachment && overrideName ? { ...attachment, name: overrideName } : attachment
    }

    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = async () => {
        const result = reader.result as ArrayBuffer
        // Chunked base64 encoding — btoa + reduce fails on large files (>1MB)
        // due to O(n²) string concatenation and browser string-length limits
        const bytes = new Uint8Array(result)
        let binary = ''
        const chunkSize = 8192
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)))
        }
        const base64 = btoa(binary)

        let type: FileAttachment['type'] = 'unknown'
        const fileName = overrideName || file.name
        if (file.type.startsWith('image/')) type = 'image'
        else if (file.type === 'application/pdf') type = 'pdf'
        else if (file.type.includes('text') || fileName.match(/\.(txt|md|json|js|ts|tsx|py|css|html)$/i)) type = 'text'
        else if (file.type.includes('officedocument') || fileName.match(/\.(docx?|xlsx?|pptx?)$/i)) type = 'office'

        const mimeType = file.type || 'application/octet-stream'

        // For text files, decode the ArrayBuffer as UTF-8 text
        let text: string | undefined
        if (type === 'text') {
          text = new TextDecoder('utf-8').decode(new Uint8Array(result))
        }

        let thumbnailBase64: string | undefined
        if (hasElectronAPI) {
          try {
            const thumb = await window.electronAPI.generateThumbnail(base64, mimeType)
            if (thumb) thumbnailBase64 = thumb
          } catch {
            // Thumbnail generation is optional, continue without it
          }
        }

        resolve({
          type,
          path: realPath ?? fileName,
          name: fileName,
          mimeType,
          base64,
          text,
          size: file.size,
          thumbnailBase64,
        })
      }
      reader.onerror = () => resolve(null)
      reader.readAsArrayBuffer(file)
    })
  }

  const processFileAttachments = async (files: File[], overrideNames?: string[]) => {
    if (files.length === 0) return
    const limitError = getAttachmentBatchLimitError(files)
    if (limitError) {
      toast.error(limitError === 'too_many_files'
        ? `You can attach up to ${MAX_DROPPED_ATTACHMENT_FILES} files at once.`
        : 'Attachments can total up to 200 MB at once.')
      return
    }

    setLoadingCount(prev => prev + files.length)
    try {
      const loadedAttachments = await readAttachmentBatch(files, async (file, index) => {
        try {
          return await readFileAsAttachment(file, overrideNames?.[index])
        } catch (error) {
          console.error('[FreeFormInput] Failed to read file:', error)
          return null
        }
      })
      if (loadedAttachments.length > 0) {
        setAttachments(prev => [...prev, ...loadedAttachments])
      }
    } finally {
      setLoadingCount(prev => prev - files.length)
    }
  }

  // File attachment handlers
  const handleAttachClick = () => {
    if (disabled) return
    fileInputRef.current?.click()
  }

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    await processFileAttachments(Array.from(files))

    // Reset input so re-selecting the same file triggers onChange again
    e.target.value = ''
  }

  const handleRemoveAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index))
  }

  // Drag and drop handlers
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) {
      setIsDraggingOver(true)
    }
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setIsDraggingOver(false)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  // Clipboard paste handler for files/images
  const handlePaste = async (e: React.ClipboardEvent) => {
    if (disabled) return

    const clipboardItems = e.clipboardData?.files
    if (!clipboardItems || clipboardItems.length === 0) return

    // We have files to process - prevent default text paste behavior
    e.preventDefault()

    const files = Array.from(clipboardItems)
    // Pre-assign sequential names using ref to avoid race conditions
    let nextImageNum = getNextPastedNumber('image', attachmentsRef.current)
    const fileNames: string[] = files.map(file => {
      if (!file.name || file.name === 'image.png' || file.name === 'image.jpg' || file.name === 'blob') {
        const ext = file.type.split('/')[1] || 'png'
        return `pasted-image-${nextImageNum++}.${ext}`
      }
      return file.name
    })

    await processFileAttachments(files, fileNames)
  }

  // Handle long text paste - convert to file attachment
  const handleLongTextPaste = React.useCallback((text: string) => {
    const nextNum = getNextPastedNumber('text', attachmentsRef.current)
    const fileName = `pasted-text-${nextNum}.txt`
    const attachment: FileAttachment = {
      type: 'text',
      path: fileName,
      name: fileName,
      mimeType: 'text/plain',
      text: text,
      size: new Blob([text]).size,
    }
    setAttachments(prev => [...prev, attachment])
    // Focus input after adding attachment
    richInputRef.current?.focus()
  }, []) // No deps needed - uses ref

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setIsDraggingOver(false)
    if (disabled) return

    try {
      const droppedFiles = await collectDroppedFiles(e.dataTransfer)
      if (droppedFiles.skippedSensitiveFiles > 0) {
        toast.warning(`Skipped ${droppedFiles.skippedSensitiveFiles} sensitive file${droppedFiles.skippedSensitiveFiles === 1 ? '' : 's'}.`)
      }
      const files = droppedFiles.files.map(({ file }) => file)
      const relativePaths = droppedFiles.files.map(({ relativePath }) => relativePath)
      await processFileAttachments(files, relativePaths)
    } catch (error) {
      const limitError = error instanceof Error ? error.message : ''
      toast.error(limitError === 'too_many_files'
        ? `You can attach up to ${MAX_DROPPED_ATTACHMENT_FILES} files at once.`
        : 'Attachments can total up to 200 MB at once.')
    }
  }

  // Submit message - backend handles queueing and interruption
  const submitMessage = React.useCallback(() => {
    const hasContent = input.trim() || attachments.length > 0 || followUpItems.length > 0
    if (!hasContent || disabled || loadingCount > 0) return false

    // Tutorial may disable sending to guide user through specific steps
    if (disableSend) return false

    // Parse all bracket mentions (skills from /, sources and files from @)
    const mentions = parseMentions(input, skillSlugs, sourceSlugs)

    // Enable any mentioned sources that aren't already enabled
    if (mentions.sources.length > 0 && onSourcesChange) {
      const newSlugs = [...new Set([...optimisticSourceSlugs, ...mentions.sources])]
      if (newSlugs.length > optimisticSourceSlugs.length) {
        setOptimisticSourceSlugs(newSlugs)
        onSourcesChange(newSlugs)
      }
    }

    const attachmentSnapshot = attachments

    onSubmit(
      input.trim(),
      attachmentSnapshot.length > 0 ? attachmentSnapshot : undefined,
      mentions.skills.length > 0 ? mentions.skills : undefined
    )
    setInput('')
    setAttachments([])
    // Clear draft immediately (cancel any pending debounced sync)
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
    onInputChange?.('')
    onAttachmentsChange?.([])
    prevInputValueRef.current = ''

    // Restore focus after state updates
    requestAnimationFrame(() => {
      richInputRef.current?.focus()
    })

    return true
  }, [input, attachments, followUpItems, disabled, disableSend, loadingCount, onInputChange, onAttachmentsChange, onSubmit, skillSlugs, sourceSlugs, optimisticSourceSlugs, onSourcesChange, onWorkingDirectoryChange, homeDir])

  // Listen for craft:submit-input events (simulate pressing the Send button)
  React.useEffect(() => {
    const handleSubmitInput = (e: CustomEvent<{ sessionId?: string }>) => {
      const targetSessionId = e.detail?.sessionId
      if (!shouldHandleScopedInputEvent({ sessionId, isFocusedPanel, targetSessionId })) return
      submitMessage()
    }

    window.addEventListener('craft:submit-input', handleSubmitInput as EventListener)
    return () => window.removeEventListener('craft:submit-input', handleSubmitInput as EventListener)
  }, [sessionId, isFocusedPanel, submitMessage])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    submitMessage()
  }

  const handleStop = (silent = false) => {
    onStop?.(silent)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // During IME composition, ESC should cancel composition, not trigger app/menu ESC behavior.
    if (e.key === 'Escape' && e.nativeEvent.isComposing) {
      return
    }

    // Don't submit when mention menu is open AND has visible content
    if (inlineMention.isOpen) {
      // Only intercept navigation/selection keys if menu actually shows items or is loading
      const hasVisibleContent = inlineMention.sections.some(s => s.items.length > 0) || inlineMention.isSearching
      if (hasVisibleContent && (e.key === 'Enter' || e.key === 'Tab' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        // These keys are handled by the InlineMentionMenu component
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        inlineMention.close()
        return
      }
    }

    // Don't submit when slash command menu is open - let it handle the Enter key
    if (inlineSlash.isOpen) {
      if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // These keys are handled by the InlineSlashCommand component
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        inlineSlash.close()
        return
      }
    }

    // Don't submit when label menu is open - let it handle navigation keys
    if (inlineLabel.isOpen) {
      if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        inlineLabel.close()
        return
      }
    }

    // Skip submission during IME composition - user is confirming composed characters, not sending
    // Handle send key based on user preference:
    // - 'enter': Enter sends (Shift+Enter for newline)
    // - 'cmd-enter': ⌘/Ctrl+Enter sends (Enter for newline)
    if (sendMessageKey === 'enter') {
      // Enter sends, Shift+Enter adds newline
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        submitMessage()
      }
      // Also allow Cmd/Ctrl+Enter to send (power user shortcut)
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
        e.preventDefault()
        submitMessage()
      }
    } else {
      // cmd-enter mode: ⌘/Ctrl+Enter sends, plain Enter adds newline
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
        e.preventDefault()
        submitMessage()
      }
      // Plain Enter is allowed to pass through (adds newline)
    }
    if (e.key === 'Escape') {
      // Skip blur if a popover/overlay is open — let the overlay handle ESC instead.
      // This prevents the input from consuming ESC when focus gets pulled back here
      // while a popover is still visible (portal DOM isolation means the event won't
      // reach the popover's DismissableLayer otherwise).
      if (!hasOpenOverlay()) {
        richInputRef.current?.blur()
      }
    }
  }

  // Handle input changes from RichTextInput
  const handleInputChange = React.useCallback((value: string) => {
    const nextValue = coerceInputText(value)
    // Get previous input value before updating state
    const prevValue = inputRef.current

    setInput(nextValue)
    syncToParent(nextValue) // Debounced sync to parent for draft persistence

    // Sync source selection when mentions are removed from input
    const mayHaveSourceMentions = prevValue.includes('[source:') || nextValue.includes('[source:')
    if (onSourcesChange && mayHaveSourceMentions) {
      // Parse mentions from previous and current input
      const prevMentions = parseMentions(prevValue, [], sourceSlugs)
      const currMentions = parseMentions(nextValue, [], sourceSlugs)
      const currentSourceSet = new Set(currMentions.sources)

      // Remove sources that were mentioned before but not anymore
      const removedSources = prevMentions.sources.filter(slug => !currentSourceSet.has(slug))
      if (removedSources.length > 0) {
        const newSlugs = optimisticSourceSlugs.filter(slug => !removedSources.includes(slug))
        setOptimisticSourceSlugs(newSlugs)
        onSourcesChange(newSlugs)
      }
    }
  }, [syncToParent, sourceSlugs, optimisticSourceSlugs, onSourcesChange])

  // Handle input with cursor position (for menu detection)
  const handleRichInput = React.useCallback((value: string, cursorPosition: number, meta?: RichTextInputChangeMeta) => {
    const nextValue = coerceInputText(value)
    const compositionInput = isCompositionInput(meta)
    const textBeforeCursor = nextValue.slice(0, cursorPosition)

    // Update inline slash command state
    if (inlineSlash.isOpen || textBeforeCursor.includes('/')) {
      inlineSlash.handleInputChange(nextValue, cursorPosition)
    }

    // Update inline mention state (for @mentions - sources, files, folders)
    if (inlineMention.isOpen || textBeforeCursor.includes('@')) {
      inlineMention.handleInputChange(nextValue, cursorPosition)
    }

    // Update inline label state (for #labels)
    if (inlineLabel.isOpen || textBeforeCursor.includes('#')) {
      inlineLabel.handleInputChange(nextValue, cursorPosition)
    }

    // Auto-capitalize first letter (but not for slash commands, @mentions, #labels, or IME text)
    let newValue = nextValue
    const capitalised = resolveAutoCapitalisedInput(nextValue, cursorPosition, {
      enabled: autoCapitalisation,
      isCompositionInput: compositionInput,
    })
    if (capitalised) {
      newValue = capitalised.text
      // Set cursor position BEFORE state update so it's used when useEffect syncs the value
      richInputRef.current?.setSelectionRange(capitalised.cursor, capitalised.cursor)
      setInput(newValue)
      syncToParent(newValue)
      return
    }

    if (compositionInput) return

    // Apply smart typography (-> to →, etc.)
    const typography = applySmartTypography(nextValue, cursorPosition)
    if (typography.replaced) {
      newValue = typography.text
      // Set cursor position BEFORE state update so it's used when useEffect syncs the value
      richInputRef.current?.setSelectionRange(typography.cursor, typography.cursor)
      setInput(newValue)
      syncToParent(newValue)
    }
  }, [inlineSlash, inlineMention, inlineLabel, syncToParent, autoCapitalisation])

  // Handle inline slash command selection (removes the /command text)
  const handleInlineSlashCommandSelect = React.useCallback((commandId: SlashCommandId) => {
    const newValue = inlineSlash.handleSelectCommand(commandId)
    setInput(newValue)
    syncToParent(newValue)
    richInputRef.current?.focus()
  }, [inlineSlash, syncToParent])

  // Handle inline slash skill selection (inserts a skill badge token)
  const handleInlineSlashSkillSelect = React.useCallback((skill: LoadedSkill) => {
    const { value: newValue, cursorPosition } = inlineSlash.handleSelectSkill(skill)
    setInput(newValue)
    syncToParent(newValue)
    richInputRef.current?.setSelectionRange(cursorPosition, cursorPosition)
    richInputRef.current?.focus()
  }, [inlineSlash, syncToParent])

  // Handle inline slash folder selection (inserts a directory badge)
  const handleInlineSlashFolderSelect = React.useCallback((path: string) => {
    const newValue = inlineSlash.handleSelectFolder(path)
    setInput(newValue)
    syncToParent(newValue)
    richInputRef.current?.focus()
  }, [inlineSlash, syncToParent])

  // Handle inline mention selection (inserts appropriate mention text)
  const handleInlineMentionSelect = React.useCallback((item: MentionItem) => {
    const { value: newValue, cursorPosition } = inlineMention.handleSelect(item)
    setInput(newValue)
    syncToParent(newValue)
    // Focus input and restore cursor position after badge renders
    setTimeout(() => {
      richInputRef.current?.focus()
      richInputRef.current?.setSelectionRange(cursorPosition, cursorPosition)
    }, 0)
  }, [inlineMention, syncToParent])

  // Handle inline label selection (removes the #label text from input)
  const handleInlineLabelSelect = React.useCallback((labelId: string) => {
    const newValue = inlineLabel.handleSelect(labelId)
    setInput(newValue)
    syncToParent(newValue)
    richInputRef.current?.focus()
  }, [inlineLabel, syncToParent])

  // Handle inline state selection from # menu (removes #text, changes session state)
  const handleInlineStateSelect = React.useCallback((stateId: string) => {
    const newValue = inlineLabel.handleSelect('')
    setInput(newValue)
    syncToParent(newValue)
    onSessionStatusChange?.(stateId)
    richInputRef.current?.focus()
  }, [inlineLabel, syncToParent, onSessionStatusChange])

  const followUpLayoutKey = React.useMemo(
    () => followUpItems.map(item => [
      item.id,
      item.index ?? '',
      item.noteLabel,
      item.selectedText,
      item.color ?? '',
    ].join('::')).join('|'),
    [followUpItems]
  )
  const previousFollowUpLayoutKeyRef = React.useRef<string | null>(null)
  const [animateFollowUpLayout, setAnimateFollowUpLayout] = React.useState(false)

  React.useEffect(() => {
    const previous = previousFollowUpLayoutKeyRef.current
    previousFollowUpLayoutKeyRef.current = followUpLayoutKey

    if (previous == null || previous === followUpLayoutKey) return

    setAnimateFollowUpLayout(true)
    const timer = window.setTimeout(() => {
      setAnimateFollowUpLayout(false)
    }, 220)

    return () => window.clearTimeout(timer)
  }, [followUpLayoutKey])

  const hasContent = input.trim() || attachments.length > 0 || followUpItems.length > 0
  const primaryInputAction = getPrimaryInputAction({
    isProcessing,
    hasContent: Boolean(hasContent),
    disabled,
    disableSend,
  })
  const showTextInput = shouldShowTextInput({ compactMode, isProcessing })

  // Pre-flight image-support check: warn when staged images would be silently
  // stripped by Pi SDK because the active custom-endpoint model is text-only.
  // Gate on pi_compat — built-in catalogs (anthropic/pi) are owned by the SDK
  // and we can't repair them from the UI here.
  const hasStagedImages = attachments.some(a => a.type === 'image' || a.mimeType?.startsWith('image/'))
  const showVisionWarning =
    hasStagedImages
    && !!effectiveConnectionDetails
    && isCompatProvider(effectiveConnectionDetails.providerType)
    && !modelSupportsImages(effectiveConnectionDetails, currentModel)

  const renderModelMenuItem = ({
    modelId,
    modelName,
    description,
    connection,
    selected,
    locked = false,
    selectModel,
  }: {
    modelId: string
    modelName: string
    description?: string
    connection?: LlmConnection
    selected: boolean
    locked?: boolean
    selectModel?: () => void
  }) => {
    const showVisionToggle = !!connection && isCompatProvider(connection.providerType)
    const visionOn = !!connection && showVisionToggle && modelSupportsImages(connection, modelId)

    return (
      <StyledDropdownMenuItem
        key={modelId}
        disabled={locked}
        onSelect={locked ? undefined : selectModel}
        className={cn(
          "flex items-center justify-between rounded-[6px] px-2 py-1.5 hover:bg-foreground/[0.07] focus:bg-foreground/[0.07]",
          !locked && "cursor-pointer",
        )}
      >
        <div className="min-w-0 flex-1 text-left">
          <div className="truncate text-[13px] leading-5">{modelName}</div>
          {description && (
            <div className="truncate text-[11px] leading-4 text-muted-foreground">{description}</div>
          )}
        </div>
        <div className="ml-3 flex shrink-0 items-center gap-1">
          {showVisionToggle && connection && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={visionOn
                    ? t('chat.modelPicker.supportsImagesOn')
                    : t('chat.modelPicker.supportsImagesOff')}
                  className="inline-flex items-center justify-center p-1 rounded hover:bg-foreground/5 cursor-pointer"
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    handleToggleModelVision(connection.slug, modelId, !visionOn)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      event.stopPropagation()
                      handleToggleModelVision(connection.slug, modelId, !visionOn)
                    }
                  }}
                >
                  <ImageIcon className={cn(
                    "h-3.5 w-3.5",
                    visionOn ? "text-foreground/70" : "text-foreground/30"
                  )} />
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {visionOn
                  ? t('chat.modelPicker.supportsImagesOn')
                  : t('chat.modelPicker.supportsImagesOff')}
              </TooltipContent>
            </Tooltip>
          )}
          {selected && <Check className="h-3.5 w-3.5 text-foreground" />}
        </div>
      </StyledDropdownMenuItem>
    )
  }

  const renderModelSeries = ({
    series,
    connection,
    selectedModelId,
    selectModel,
  }: {
    series: ModelMenuSeries
    connection?: LlmConnection
    selectedModelId?: string
    selectModel: (modelId: string) => void
  }) => (
    <DropdownMenuSub key={`${connection?.slug ?? 'models'}:${series.name}`}>
      <StyledDropdownMenuSubTrigger className="rounded-[6px] px-2 py-1.5 hover:bg-foreground/[0.07] focus:bg-foreground/[0.07] data-[state=open]:bg-foreground/[0.07]">
        <span className="min-w-0 flex-1 truncate text-[13px] leading-5">{series.name}</span>
        {series.models.some(model => model.id === selectedModelId) && (
          <Check className="h-3.5 w-3.5 text-foreground" />
        )}
      </StyledDropdownMenuSubTrigger>
      <StyledDropdownMenuSubContent minWidth="min-w-0" className="w-52">
        {series.models.map(model => renderModelMenuItem({
          modelId: model.id,
          modelName: model.name,
          description: model.descriptionKey ? t(model.descriptionKey) : model.description,
          connection,
          selected: model.id === selectedModelId,
          selectModel: () => selectModel(model.id),
        }))}
      </StyledDropdownMenuSubContent>
    </DropdownMenuSub>
  )

  const renderThinkingMenuItem = () => {
    if (!onThinkingLevelChange || connectionUnavailable) return null

    return (
      <DropdownMenuSub>
        <StyledDropdownMenuSubTrigger
          disabled={!currentModelSupportsThinking}
          className="rounded-[6px] px-2 py-1.5 hover:bg-foreground/[0.07] focus:bg-foreground/[0.07] data-[state=open]:bg-foreground/[0.07]"
        >
          <span className="flex-1 text-[13px] leading-5">{t('settings.ai.thinking')}</span>
          <span className="text-[12px] text-muted-foreground">
            {currentModelSupportsThinking && selectedThinkingLevel
              ? t(selectedThinkingLevel.nameKey)
              : t('thinking.notSupported')}
          </span>
        </StyledDropdownMenuSubTrigger>
        <StyledDropdownMenuSubContent minWidth="min-w-32">
          {availableThinkingLevels.map(({ id, nameKey }) => (
            <StyledDropdownMenuItem
              key={id}
              onSelect={() => onThinkingLevelChange(id)}
              className="flex cursor-pointer items-center justify-between rounded-[6px] px-2 py-1.5 hover:bg-foreground/[0.07] focus:bg-foreground/[0.07]"
            >
              <span className="text-[13px] leading-5">{t(nameKey)}</span>
              {effectiveThinkingLevel === id && (
                <Check className="ml-3 h-3.5 w-3.5 shrink-0 text-foreground" />
              )}
            </StyledDropdownMenuItem>
          ))}
        </StyledDropdownMenuSubContent>
      </DropdownMenuSub>
    )
  }

  const renderAttachmentPicker = (isExpanded: boolean) => (
    <FreeFormInputContextBadge
      icon={<Paperclip className="h-4 w-4" />}
      label={attachments.length > 0
        ? t('chat.filesCount', { count: attachments.length })
        : t('chat.attachFiles')
      }
      isExpanded={isExpanded}
      hasSelection={attachments.length > 0}
      onClick={handleAttachClick}
      tooltip={!isExpanded ? t('chat.attachFiles') : undefined}
      disabled={disabled}
    />
  )

  return (
    <form onSubmit={handleSubmit}>
      <div
        ref={containerRef}
        className={cn(
          'overflow-hidden transition-all',
          // Container styling - only when not wrapped by InputContainer
          !unstyled && 'rounded-[16px] shadow-middle',
          !unstyled && 'bg-background',
          isDraggingOver && 'ring-2 ring-foreground ring-offset-2 ring-offset-background bg-foreground/5'
        )}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Inline Slash Command Autocomplete */}
        <InlineSlashCommand
          open={inlineSlash.isOpen}
          onOpenChange={(open) => !open && inlineSlash.close()}
          sections={inlineSlash.sections}
          activeCommands={activeCommands}
          onSelectCommand={handleInlineSlashCommandSelect}
          onSelectSkill={handleInlineSlashSkillSelect}
          onSelectFolder={handleInlineSlashFolderSelect}
          filter={inlineSlash.filter}
          position={inlineSlash.position}
          anchorRef={containerRef}
          listboxId={slashListboxId}
          onActiveDescendantChange={setActiveSlashOptionId}
        />

        {/* Inline Mention Autocomplete (sources, files, folders) */}
        <InlineMentionMenu
          open={inlineMention.isOpen}
          onOpenChange={(open) => !open && inlineMention.close()}
          sections={inlineMention.sections}
          onSelect={handleInlineMentionSelect}
          filter={inlineMention.filter}
          position={inlineMention.position}
          workspaceId={workspaceId}
          maxWidth={280}
          isSearching={inlineMention.isSearching}
        />

        {/* Inline Label & State Autocomplete (#labels / #states) */}
        <InlineLabelMenu
          open={inlineLabel.isOpen}
          onOpenChange={(open) => !open && inlineLabel.close()}
          items={inlineLabel.items}
          onSelect={handleInlineLabelSelect}
          onAddLabel={handleAddLabel}
          filter={inlineLabel.filter}
          position={inlineLabel.position}
          states={inlineLabel.states}
          activeStateId={inlineLabel.activeStateId}
          onSelectState={handleInlineStateSelect}
        />

        {/* Controlled EditPopover for "Add New Label" — opens when user selects
            the option from the # menu with no matches.
            Spread the full config so optional fields like `inlineExecution`,
            `displayLabel`, and `displayLabelKey` reach the popover. The previous
            cherry-pick dropped `inlineExecution: true`, which made the popover
            fall back to the same-window deep-link path; that worked inside
            Electron but launched the desktop app from the WebUI via `craftagents://`.
            Match the AppShell pattern (which already uses spread). */}
        {addLabelEditConfig && (
          <EditPopover
            trigger={<span className="absolute top-0 left-0 w-0 h-0 overflow-hidden" />}
            open={addLabelPopoverOpen}
            onOpenChange={setAddLabelPopoverOpen}
            {...addLabelEditConfig}
            defaultValue={addLabelPrefill}
            secondaryAction={workspaceRootPath ? {
              label: 'Edit File',
              filePath: `${workspaceRootPath}/.craft-agent/labels/config.json`,
            } : undefined}
            side="top"
            align="start"
          />
        )}

        {/* Pre-flight image-support warning — only for pi_compat connections
            where the renderer can both detect text-only models and offer to
            flip the per-model supportsImages override on the spot. */}
        {showVisionWarning && effectiveConnectionDetails && (
          <ImageSupportWarningBanner
            modelName={currentModelDisplayName}
            onEnable={() => handleToggleModelVision(effectiveConnectionDetails.slug, currentModel, true)}
          />
        )}

        {/* Attachment Preview */}
        <AttachmentPreview
          attachments={attachments}
          onRemove={handleRemoveAttachment}
          disabled={disabled}
          loadingCount={loadingCount}
        />

        {/* Follow-up context chips */}
        <AnimatePresence initial={false}>
          {followUpItems.length > 0 && (
            <motion.div
              key="follow-up-chips"
              layout={animateFollowUpLayout}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.18, ease: [0.2, 0, 0.2, 1] }}
              className="overflow-hidden"
            >
              <motion.div layout={animateFollowUpLayout} className="px-3 pt-3.5 pb-0">
                <motion.div layout={animateFollowUpLayout} className="flex flex-wrap gap-1">
                  <AnimatePresence initial={false}>
                    {followUpItems.map((item, idx) => {
                      const chipIndex = item.index ?? idx + 1
                      const tooltipText = item.selectedText.trim() || t('chat.selectedText')
                      const selectedExcerpt = formatFollowUpChipText(item.selectedText, t('chat.selectedText'), 50)
                      const noteExcerpt = formatFollowUpChipText(item.noteLabel, t('chat.followUp'), 50)

                      return (
                        <motion.button
                          key={item.id}
                          type="button"
                          layout={animateFollowUpLayout}
                          initial={{ opacity: 0, y: 6, scale: 0.98 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: -4, scale: 0.98 }}
                          transition={{ duration: 0.16, ease: [0.2, 0, 0.2, 1] }}
                          className="inline-flex max-w-full items-center gap-1.5 overflow-hidden rounded-[6px] bg-foreground/2 pl-1.5 pr-2 py-1 text-[13px] text-foreground/80 select-none transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          onClick={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect()
                            onFollowUpClick?.(item, {
                              x: rect.left + rect.width / 2,
                              y: rect.top - 8,
                            })
                          }}
                        >
                          <Tooltip delayDuration={250}>
                            <TooltipTrigger asChild>
                              <span
                                role="button"
                                tabIndex={0}
                                className="inline-flex h-4 min-w-4 cursor-pointer items-center justify-center rounded-[4px] bg-background px-0.5 text-[10px] font-medium text-foreground shadow-minimal focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                onMouseDown={(event) => {
                                  event.preventDefault()
                                  event.stopPropagation()
                                }}
                                onClick={(event) => {
                                  event.preventDefault()
                                  event.stopPropagation()
                                  onFollowUpIndexClick?.(item)
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    onFollowUpIndexClick?.(item)
                                  }
                                }}
                              >
                                {chipIndex}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-[420px] break-words text-xs">
                              {tooltipText}
                            </TooltipContent>
                          </Tooltip>
                          <span className="min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap pr-0.5 text-left">
                            <span className="italic text-foreground/60">{selectedExcerpt}</span>
                            <span className="mx-1 text-foreground/40">·</span>
                            <span>{noteExcerpt}</span>
                          </span>
                        </motion.button>
                      )
                    })}
                  </AnimatePresence>
                </motion.div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Rich Text Input with inline mention badges */}
        {showTextInput && (
        <RichTextInput
          ref={assignRichInputRef}
          value={input}
          onChange={handleInputChange}
          onInput={handleRichInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onLongTextPaste={handleLongTextPaste}
          onFocus={() => { setIsFocused(true); onFocusChange?.(true) }}
          onBlur={() => {
            // Save caret position before losing focus (for restoration via craft:focus-input)
            lastCaretPositionRef.current = richInputRef.current?.selectionStart ?? null
            setIsFocused(false)
            onFocusChange?.(false)
          }}
          placeholder={effectivePlaceholder}
          disabled={disabled}
          skills={skills}
          sources={sources}
          mentionFiles={mentionFiles}
          workspaceId={workspaceId}
          className="pl-5 pr-4 pt-4 pb-3 overflow-y-auto min-h-[88px]"
          style={{ maxHeight: inputMaxHeight }}
          data-tutorial="chat-input"
          aria-haspopup="listbox"
          aria-expanded={inlineSlash.isOpen}
          aria-controls={inlineSlash.isOpen ? slashListboxId : undefined}
          aria-activedescendant={activeSlashOptionId}
          spellCheck={spellCheck}
          autoCapitalize="off"
        />
        )}

        {/* Bottom Row: Controls - wrapped in relative container for status slot overlay */}
        <div className="relative">
          {/* Status slot overlay - escape interrupt (highest priority), browser status, etc. */}
          <ToolbarStatusSlot
            showEscapeOverlay={isProcessing && showEscapeOverlay}
            sessionId={sessionId}
          />

          <div className={cn("flex min-w-0 items-center gap-1 px-2 py-2", !compactMode && "border-t border-border/50")}>
          {/* Hidden file input for attach button (shared by compact and desktop) */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileInputChange}
          />
          {/* Compact mode: permission mode drawer + standard icon badges for attach/sources/working dir */}
          {compactMode && (
          <>
          {onPermissionModeChange && (
            <CompactPermissionModeSelector
              permissionMode={permissionMode}
              onPermissionModeChange={onPermissionModeChange}
            />
          )}
          {renderAttachmentPicker(false)}
          {onSourcesChange && (
            <div className="relative shrink min-w-0">
              <FreeFormInputContextBadge
                buttonRef={sourceButtonRef}
                icon={
                  optimisticSourceSlugs.length === 0 ? (
                    <DatabaseZap className="h-4 w-4" />
                  ) : (
                    <div className="flex items-center -ml-0.5">
                      {(() => {
                        const displaySources = selectedSourcesForBadge.slice(0, 3)
                        const remainingCount = selectedSourcesForBadge.length - 3
                        return (
                          <>
                            {displaySources.map((source, index) => (
                              <div
                                key={source.config.slug}
                                className={cn("relative h-5 w-5 rounded-[4px] bg-background shadow-minimal flex items-center justify-center", index > 0 && "-ml-1")}
                                style={{ zIndex: index + 1 }}
                              >
                                <SourceAvatar source={source} size="xs" />
                              </div>
                            ))}
                            {remainingCount > 0 && (
                              <div
                                className="-ml-1 h-5 w-5 rounded-[4px] bg-background shadow-minimal flex items-center justify-center text-[8px] font-medium text-muted-foreground"
                                style={{ zIndex: displaySources.length + 1 }}
                              >
                                +{remainingCount}
                              </div>
                            )}
                          </>
                        )
                      })()}
                    </div>
                  )
                }
                label={
                  optimisticSourceSlugs.length === 0
                    ? t("chat.sourcesTooltip")
                    : (() => {
                        if (selectedSourcesForBadge.length === 1) return selectedSourcesForBadge[0].config.name
                        return t("chat.sourcesCount", { count: selectedSourcesForBadge.length })
                      })()
                }
                isExpanded={false}
                hasSelection={optimisticSourceSlugs.length > 0}
                showChevron={false}
                isOpen={sourceDropdownOpen}
                disabled={disabled}
                onClick={() => setSourceDropdownOpen(prev => !prev)}
                tooltip={t("chat.sourcesTooltip")}
              />
              <SourceSelectorPopover
                open={sourceDropdownOpen}
                onOpenChange={setSourceDropdownOpen}
                anchorRef={sourceButtonRef}
                sources={sources}
                selectedSlugs={optimisticSourceSlugs}
                onToggleSlug={(slug) => {
                  const isEnabled = optimisticSourceSlugs.includes(slug)
                  const newSlugs = isEnabled
                    ? optimisticSourceSlugs.filter(currentSlug => currentSlug !== slug)
                    : [...optimisticSourceSlugs, slug]
                  setOptimisticSourceSlugs(newSlugs)
                  onSourcesChange?.(newSlugs)
                }}
              />
            </div>
          )}
          {onWorkingDirectoryChange && (
            <WorkingDirectoryBadge
              workingDirectory={workingDirectory}
              onWorkingDirectoryChange={onWorkingDirectoryChange}
              sessionFolderPath={sessionFolderPath}
              workspaceId={workspaceId}
            />
          )}
          </>
          )}

          {/* Desktop: one add menu for attachments/sources, then permission */}
          {!compactMode && (
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                ref={sourceButtonRef}
                type="button"
                data-tutorial="source-selector-button"
                aria-label={`${t('chat.attachFiles')} / ${t('chat.chooseSources')}`}
                disabled={disabled}
                className="input-toolbar-btn inline-flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-[6px] text-foreground outline-none transition-colors hover:bg-foreground/5 active:bg-foreground/10 focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <StyledDropdownMenuContent side="top" align="start" sideOffset={6} className="min-w-40">
              <StyledDropdownMenuItem onSelect={handleAttachClick}>
                <Paperclip className="h-4 w-4" />
                <span>{t('chat.attachFiles')}</span>
              </StyledDropdownMenuItem>
              {onSourcesChange && (
                <StyledDropdownMenuItem
                  onSelect={() => queueMicrotask(() => setSourceDropdownOpen(true))}
                >
                  <DatabaseZap className="h-4 w-4" />
                  <span>{t('chat.chooseSources')}</span>
                </StyledDropdownMenuItem>
              )}
            </StyledDropdownMenuContent>
          </DropdownMenu>

          {onSourcesChange && (
            <SourceSelectorPopover
              open={sourceDropdownOpen}
              onOpenChange={setSourceDropdownOpen}
              anchorRef={sourceButtonRef}
              sources={sources}
              selectedSlugs={optimisticSourceSlugs}
              onToggleSlug={(slug) => {
                const isEnabled = optimisticSourceSlugs.includes(slug)
                const newSlugs = isEnabled
                  ? optimisticSourceSlugs.filter(currentSlug => currentSlug !== slug)
                  : [...optimisticSourceSlugs, slug]
                setOptimisticSourceSlugs(newSlugs)
                onSourcesChange(newSlugs)
              }}
            />
          )}

          {onPermissionModeChange && (
            <DesktopPermissionModeSelector
              permissionMode={permissionMode}
              onPermissionModeChange={onPermissionModeChange}
              sessionId={sessionId}
            />
          )}

          </div>
          )}

          {/* Right side: keep primary actions visible while truncating long model names. */}
          <div className="flex min-w-0 max-w-[52%] items-center justify-end shrink-0">
          {/* 5. Model/Connection Selector - Hidden in compact mode (EditPopover embedding) */}
          {!compactMode && (
          <DropdownMenu open={modelDropdownOpen} onOpenChange={setModelDropdownOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      "input-toolbar-btn inline-flex !h-7 min-w-0 max-w-[240px] select-none items-center gap-1 rounded-full px-2 text-[12px] transition-colors hover:bg-foreground/[0.07]",
                      modelDropdownOpen && "bg-foreground/[0.07]",
                      connectionUnavailable && "text-destructive",
                    )}
                  >
                    {connectionUnavailable ? (
                      <>
                        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 truncate">{t('common.unavailable')}</span>
                      </>
                    ) : (
                      <>
                        {effectiveConnectionDetails && llmConnections.length > 1 && storage.get(storage.KEYS.showConnectionIcons, true) && <ConnectionIcon connection={effectiveConnectionDetails} size={14} showTooltip />}
                        <span className="min-w-0 truncate">{currentModelDisplayName}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          · {currentThinkingLabel}
                        </span>
                        {!connectionDefaultModel && <ChevronDown className="h-3 w-3 opacity-50 shrink-0" />}
                      </>
                    )}
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top">
                {`${currentModelDisplayName} · ${currentThinkingLabel}`}
              </TooltipContent>
            </Tooltip>
            <StyledDropdownMenuContent side="top" align="end" sideOffset={6} className="min-w-60">
              {/* Connection unavailable message */}
              {connectionUnavailable ? (
                <div className="flex flex-col items-center justify-center py-6 px-4 text-center">
                  <AlertCircle className="h-8 w-8 text-destructive mb-2" />
                  <div className="font-medium text-sm mb-1">{t('chat.connectionUnavailable')}</div>
                  <div className="text-xs text-muted-foreground">
                    {t('chat.connectionUnavailableDescription')}
                  </div>
                </div>
              ) : connectionDefaultModel ? (
                renderModelMenuItem({
                  modelId: connectionDefaultModel,
                  modelName: stripPiPrefixForDisplay(connectionDefaultModel),
                  description: t('chat.connectionDefault'),
                  connection: effectiveConnectionDetails ?? undefined,
                  selected: true,
                  locked: true,
                })
              ) : isEmptySession && llmConnections.length > 1 ? (
                <>
                  {managedModelSeries.map(({ connection, series }) => renderModelSeries({
                    series,
                    connection,
                    selectedModelId: effectiveConnection === connection.slug ? currentModel : undefined,
                    selectModel: modelId => onModelChange(modelId, connection.slug),
                  }))}
                  {managedModelSeries.length > 0 && customConnectionsByProvider.length > 0 && (
                    <StyledDropdownMenuSeparator className="my-1" />
                  )}
                  {/* Hierarchical view for user-configured connections. */}
                  {customConnectionsByProvider.map(([providerName, connections], index) => (
                    <React.Fragment key={providerName}>
                      {/* Provider group label */}
                      <div className="select-none px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {providerName}
                      </div>
                      {connections.map((conn) => {
                        const isCurrentConnection = effectiveConnection === conn.slug
                        const isAuthenticated = conn.isAuthenticated
                        return (
                          <DropdownMenuSub key={conn.slug}>
                            <StyledDropdownMenuSubTrigger
                              disabled={!isAuthenticated}
                              className={cn(
                                "flex items-center justify-between rounded-[6px] px-2 py-1.5 hover:bg-foreground/[0.07] focus:bg-foreground/[0.07] data-[state=open]:bg-foreground/[0.07]",
                                isCurrentConnection && "bg-foreground/5"
                              )}
                            >
                              <div className="text-left flex-1">
                                <div className="flex items-center gap-1.5 text-[13px] leading-5">
                                  <ConnectionIcon connection={conn} size={14} />
                                  {conn.name}
                                  {isCurrentConnection && <Check className="h-3 w-3 text-foreground" />}
                                </div>
                                {!isAuthenticated && (
                                  <div className="text-xs text-muted-foreground">{t('settings.ai.notAuthenticated')}</div>
                                )}
                              </div>
                            </StyledDropdownMenuSubTrigger>
                            {isAuthenticated && (
                              <StyledDropdownMenuSubContent className="min-w-[220px]">
                                {/* Show models for this connection - use provider-specific models as fallback */}
                                {groupModelMenuOptions(
                                  (conn.models || ANTHROPIC_MODELS).map(toModelMenuOption)
                                ).map(series => renderModelSeries({
                                  series,
                                  connection: conn,
                                  selectedModelId: isCurrentConnection ? currentModel : undefined,
                                  selectModel: (modelId) => {
                                    // If selecting a different connection, update both connection and model
                                    if (!isCurrentConnection && onConnectionChange) {
                                      onConnectionChange(conn.slug)
                                    }
                                    // Always pass connection with model for proper persistence
                                    onModelChange(modelId, conn.slug)
                                  },
                                }))}
                              </StyledDropdownMenuSubContent>
                            )}
                          </DropdownMenuSub>
                        )
                      })}
                      {index < customConnectionsByProvider.length - 1 && (
                        <StyledDropdownMenuSeparator className="my-1" />
                      )}
                    </React.Fragment>
                  ))}
                </>
              ) : isEmptySession && isManagedEffectiveConnection ? (
                managedModelSeries.map(({ connection, series }) => renderModelSeries({
                  series,
                  connection,
                  selectedModelId: effectiveConnection === connection.slug ? currentModel : undefined,
                  selectModel: modelId => onModelChange(modelId, connection.slug),
                }))
              ) : (
                /* Flat model list (single connection or session started) */
                <>
                  {/* Indicator showing which connection is being used */}
                  {!isEmptySession && currentConnectionDetails && llmConnections.length > 1 && !isManagedLlmConnectionSlug(currentConnectionDetails.slug) && (
                    <>
                      <div className="flex items-center gap-2 px-2 py-1.5 text-xs select-none text-muted-foreground">
                        <span>{t('chat.usingConnection', { name: currentConnectionDetails.name })}</span>
                      </div>
                      <StyledDropdownMenuSeparator className="my-1" />
                    </>
                  )}
                  {/* Model options based on effective connection's provider type */}
                  {availableModelSeries.map(series => renderModelSeries({
                    series,
                    connection: effectiveConnectionDetails ?? undefined,
                    selectedModelId: currentModel,
                    selectModel: modelId => onModelChange(modelId, effectiveConnection),
                  }))}
                </>
              )}

              {renderThinkingMenuItem()}
            </StyledDropdownMenuContent>
          </DropdownMenu>
          )}

          {/* 5.5 Context Usage */}
          {contextUsage && !compactMode && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "ml-1 inline-flex h-6 w-6 items-center justify-center rounded-full transition-colors select-none",
                    contextUsage.percent >= 80
                      ? "text-info hover:bg-info/10"
                      : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                  )}
                  aria-label={`${t('chat.contextUsage', 'Context usage')}: ${contextUsage.label} (${contextUsage.tokenLabel})`}
                >
                  {contextStatus?.isCompacting ? (
                    <Spinner className="h-3.5 w-3.5" />
                  ) : (
                    <svg aria-hidden="true" className="h-4 w-4 -rotate-90" viewBox="0 0 16 16">
                      <circle
                        className="stroke-current opacity-20"
                        cx="8"
                        cy="8"
                        r="6.5"
                        fill="none"
                        strokeWidth="2"
                      />
                      <circle
                        className="stroke-current"
                        cx="8"
                        cy="8"
                        r="6.5"
                        fill="none"
                        pathLength="100"
                        strokeDasharray="100"
                        strokeDashoffset={100 - contextUsage.percent}
                        strokeLinecap="round"
                        strokeWidth="2"
                      />
                    </svg>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <span className="flex flex-col gap-0.5">
                  <span>{t('chat.contextUsage', 'Context usage')}: {contextUsage.label}</span>
                  <span className="text-xs opacity-70">{contextUsage.tokenLabel}</span>
                </span>
              </TooltipContent>
            </Tooltip>
          )}

          {/* 6. Send/Stop Button - Queue new drafts while processing, otherwise stop */}
          {primaryInputAction === 'stop' ? (
            <Button
              type="button"
              size="icon"
              variant="secondary"
              aria-label={t('chat.stopResponse')}
              className="send-btn h-7 w-7 rounded-full shrink-0 hover:bg-foreground/15 active:bg-foreground/20 ml-2"
              onClick={() => handleStop(false)}
            >
              <Square className="h-3 w-3 fill-current" />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon"
              aria-label={t('shortcuts.sendMessage')}
              className="send-btn h-7 w-7 rounded-full shrink-0 ml-2"
              disabled={!hasContent || disabled || disableSend || loadingCount > 0}
              data-tutorial="send-button"
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
          )}
          </div>
          </div>
        </div>
      </div>
    </form>
  )
}
