// input: Runtime context plus narrow session, navigation, and shell service contracts
// output: Split React providers and hooks for AppShell consumers
// pos: Renderer dependency boundary that avoids broad prop drilling

/**
 * AppShellContext
 *
 * Provides session and workspace data to tab panels without prop drilling.
 * This context is used by ChatTabPanel and other components that need
 * access to the current session, workspace, and callback functions.
 */

import * as React from 'react'
import { createContext, useContext, useCallback } from 'react'
import { useAtomValue } from 'jotai'
import type { ChatDisplayHandle } from '@/components/app-shell/ChatDisplay'
import type { ChatOpeningCommand } from '@/components/app-shell/chat-opening'
import type { MentionFileReference } from '@/components/ui/mention-menu'
import type {
  Session,
  Workspace,
  FileAttachment,
  PermissionRequest,
  CredentialRequest,
  CredentialResponse,
  UserQuestionRequest,
  UserQuestionResponse,
  PermissionMode,
  SessionStatus,
  LoadedSource,
  LoadedSkill,
  NewChatActionParams,
  LlmConnectionWithStatus,
  SendMessageOptions,
  ClientAuthState,
} from '../../shared/types'
import type { SessionStatus as SessionStatusConfig } from '@/config/session-status-config'
import type { SessionOptions, SessionOptionUpdates } from '../hooks/useSessionOptions'
import { sessionOptionsAtomFamily } from '../hooks/useSessionOptions'
import { sessionAtomFamily } from '../atoms/sessions'
import { pendingCredentialAtomFamily, pendingPermissionAtomFamily, pendingUserQuestionAtomFamily } from '../atoms/pending-requests'
import type { FileChange, FileChangeReviewStatus } from '@craft-agent/ui'

export interface AppShellContextType {
  // Data
  // NOTE: sessions is NOT included here - use sessionMetaMapAtom for listing
  // and useSession(id) hook for individual sessions. This prevents closures
  // from retaining the full messages array and causing memory leaks.
  workspaces: Workspace[]
  /** Auth state shown in the account section of App settings. */
  clientAuthState: ClientAuthState | null
  /** Refresh root-owned auth state after an inline sign-in. */
  onClientSignedIn: () => Promise<void>
  /** Sign out and refresh root-owned auth state. */
  onClientSignOut: () => Promise<void>
  /** Concrete hidden or configured workspace used by the Agent runtime. */
  runtimeWorkspace: Workspace | null
  /** Last active project; remains stable while Free Conversations are open. */
  activeProjectId: string | null
  /** All LLM connections with authentication status */
  llmConnections: LlmConnectionWithStatus[]
  /** Default LLM connection slug for the current workspace */
  workspaceDefaultLlmConnection?: string
  /** Refresh LLM connections from config */
  refreshLlmConnections: () => Promise<void>
  /** Get draft input text for a session - reads from ref without triggering re-renders */
  getDraft: (sessionId: string) => string
  /** Get persisted attachment refs (path + name) for a session's draft - no file IO */
  getDraftAttachmentRefs: (sessionId: string) => import('@craft-agent/shared/config').DraftAttachmentRef[]
  /** Hydrate persisted attachment refs into full FileAttachment objects (async, reads files) */
  hydrateDraftAttachments: (sessionId: string) => Promise<FileAttachment[]>
  /** All enabled sources for this workspace - provided by AppShell component */
  enabledSources?: LoadedSource[]
  /** All skills for this workspace - provided by AppShell component (for @mentions) */
  skills?: LoadedSkill[]
  /** Files that can be mentioned by display name while preserving their paths. */
  mentionFiles?: MentionFileReference[]
  /** Working directory of the active session — needed for project-level skill resolution */
  activeSessionWorkingDirectory?: string
  /** Real project content state used by the empty chat opening. */
  openingProjectState?: {
    hasUserContent: boolean
  }
  /** Execute a project command selected from the empty chat opening. */
  onWorkspaceOpeningCommand?: (command: ChatOpeningCommand) => void
  /** All label configs (tree) for label menu and badge display */
  labels?: import('@craft-agent/shared/labels').LabelConfig[]
  /** Callback when session labels change */
  onSessionLabelsChange?: (sessionId: string, labels: string[]) => void
  /** Enabled permission modes for Shift+Tab cycling */
  enabledModes?: PermissionMode[]
  /** Dynamic todo states from workspace config (provided by AppShell, defaults to empty) */
  sessionStatuses?: SessionStatusConfig[]

  // Session callbacks
  onCreateSession: (workspaceId: string, options?: import('../../shared/types').CreateSessionOptions) => Promise<Session>
  onSendMessage: (sessionId: string, message: string, attachments?: FileAttachment[], skillSlugs?: string[], badges?: import('@craft-agent/core').ContentBadge[], options?: Pick<SendMessageOptions, 'oneTimeContext' | 'workspaceFreshnessContext' | 'hideUserMessage'> & { forceQueuedUserMessage?: boolean }) => boolean | void | Promise<boolean | void>
  onRenameSession: (sessionId: string, name: string) => void
  onFlagSession: (sessionId: string) => void
  onUnflagSession: (sessionId: string) => void
  onArchiveSession: (sessionId: string) => void
  onUnarchiveSession: (sessionId: string) => void
  onMarkSessionRead: (sessionId: string) => void
  onMarkSessionUnread: (sessionId: string) => void
  /** Track which session user is viewing (for unread state machine) */
  onSetActiveViewingSession: (sessionId: string) => void
  onSessionStatusChange: (sessionId: string, state: SessionStatus) => void
  onDeleteSession: (sessionId: string, skipConfirmation?: boolean) => Promise<boolean>

  // Permission handling
  onRespondToPermission?: (
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: import('../../shared/types').PermissionResponseOptions
  ) => void

  // Credential handling
  onRespondToCredential?: (
    sessionId: string,
    requestId: string,
    response: CredentialResponse
  ) => void

  onRespondToUserQuestion?: (
    sessionId: string,
    requestId: string,
    response: UserQuestionResponse
  ) => void

  // File/URL handlers - these can open in tabs or external apps
  onOpenFile: (path: string) => void
  onOpenUrl: (url: string) => void
  /** Resolve and update review state for file changes shown inside the active conversation. */
  resolveFileChangeReviewStatus?: (sessionId: string, change: FileChange) => FileChangeReviewStatus | undefined
  onAcceptFileChange?: (sessionId: string, change: FileChange) => void
  onRejectFileChange?: (sessionId: string, change: FileChange) => void
  onOpenFileChanges?: (sessionId: string, changes: FileChange[]) => void
  onRevertFileChanges?: (sessionId: string, changes: FileChange[]) => Promise<void> | void

  // Workspace
  onSelectWorkspace: (id: string, openInNewWindow?: boolean) => void | Promise<void>
  /**
   * Activates a project runtime AND deep-links to one of its sessions in a
   * single, explicit step. This is the sanctioned cross-domain jump: the rail
   * may surface project conversations only when selecting one switches the
   * whole runtime (never a silent overlay). See ADR 0006.
   */
  onSelectProjectSession?: (workspaceId: string, sessionId: string) => void | Promise<void>
  onRefreshWorkspaces?: () => void
  onOpenWritingWorkspace: () => void
  onOpenFreeConversations: (options?: { createNew?: boolean }) => void | Promise<void>

  // App actions
  onOpenSettings: () => void
  onOpenKeyboardShortcuts: () => void
  onOpenStoredUserPreferences: () => void
  onReset: () => void

  // Unified session options callback
  onSessionOptionsChange: (sessionId: string, updates: SessionOptionUpdates) => void

  // Input draft callback
  onInputChange: (sessionId: string, value: string) => void

  // Attachment draft callback — persists attachment refs per session
  onAttachmentsChange: (sessionId: string, attachments: FileAttachment[]) => void

  // Source selection callback (per-session) - provided by AppShell component
  onSessionSourcesChange?: (sessionId: string, sourceSlugs: string[]) => void

  // Open a new chat with optional agent, name, and pre-filled input
  openNewChat?: (params?: NewChatActionParams) => Promise<void>

  // Right sidebar button (for page headers)
  rightSidebarButton?: React.ReactNode

  // Leading action button for panel header (e.g., back button in compact mode)
  leadingAction?: React.ReactNode

  /** Whether this panel is the focused panel (for multi-panel visual differentiation) */
  isFocusedPanel?: boolean

  /** Whether the shell is currently in compact/narrow mode */
  isCompactMode?: boolean

  // Session list search navigation bridge
  /** Ref to ChatDisplay for navigation between matches */
  chatDisplayRef?: React.RefObject<ChatDisplayHandle>
  /** Callback when ChatDisplay match info changes (for immediate UI updates) */
  onChatMatchInfoChange?: (info: { sessionId: string | null; count: number; index: number; isHighlighting: boolean }) => void

  // Automation management
  /** Test an automation by ID — executes its actions and returns results */
  onTestAutomation?: (automationId: string) => void
  /** Toggle an automation's enabled state by ID */
  onToggleAutomation?: (automationId: string) => void
  /** Duplicate an automation by ID — clones config with " Copy" suffix */
  onDuplicateAutomation?: (automationId: string) => void
  /** Delete an automation by ID — removes from automations config */
  onDeleteAutomation?: (automationId: string) => void
  /** Map of automationId → last test result */
  automationTestResults?: Record<string, import('../components/automations/types').TestResult>
  /** Fetch execution history for an automation by ID */
  getAutomationHistory?: (automationId: string) => Promise<import('../components/automations/types').ExecutionEntry[]>
  /** Replay (re-execute) webhook actions for a failed automation */
  onReplayAutomation?: (automationId: string, event: string) => void
}

interface SessionInteractionActionsContextType {
  onCreateSession: AppShellContextType['onCreateSession']
  onSendMessage: AppShellContextType['onSendMessage']
  onRespondToPermission?: AppShellContextType['onRespondToPermission']
  onRespondToCredential?: AppShellContextType['onRespondToCredential']
  onRespondToUserQuestion?: AppShellContextType['onRespondToUserQuestion']
  resolveFileChangeReviewStatus?: AppShellContextType['resolveFileChangeReviewStatus']
  onAcceptFileChange?: AppShellContextType['onAcceptFileChange']
  onRejectFileChange?: AppShellContextType['onRejectFileChange']
  onOpenFileChanges?: AppShellContextType['onOpenFileChanges']
  onRevertFileChanges?: AppShellContextType['onRevertFileChanges']
}

const SessionInteractionActionsContext = createContext<SessionInteractionActionsContextType | null>(null)

interface SessionReadActionsContextType {
  onMarkSessionRead: AppShellContextType['onMarkSessionRead']
  onMarkSessionUnread: AppShellContextType['onMarkSessionUnread']
  onSetActiveViewingSession: AppShellContextType['onSetActiveViewingSession']
}

const SessionReadActionsContext = createContext<SessionReadActionsContextType | null>(null)

interface SessionDraftActionsContextType {
  getDraft: AppShellContextType['getDraft']
  hydrateDraftAttachments: AppShellContextType['hydrateDraftAttachments']
  onInputChange: AppShellContextType['onInputChange']
  onAttachmentsChange: AppShellContextType['onAttachmentsChange']
}

const SessionDraftActionsContext = createContext<SessionDraftActionsContextType | null>(null)

interface SessionChatResourcesContextType {
  runtimeWorkspace: AppShellContextType['runtimeWorkspace']
  onOpenFreeConversations: AppShellContextType['onOpenFreeConversations']
  enabledSources?: AppShellContextType['enabledSources']
  skills?: AppShellContextType['skills']
  mentionFiles?: AppShellContextType['mentionFiles']
  openingProjectState?: AppShellContextType['openingProjectState']
  onWorkspaceOpeningCommand?: AppShellContextType['onWorkspaceOpeningCommand']
  enabledModes?: AppShellContextType['enabledModes']
  onSessionSourcesChange?: AppShellContextType['onSessionSourcesChange']
}

const SessionChatResourcesContext = createContext<SessionChatResourcesContextType | null>(null)

interface SessionPanelChromeContextType {
  rightSidebarButton?: AppShellContextType['rightSidebarButton']
  leadingAction?: AppShellContextType['leadingAction']
  isCompactMode?: AppShellContextType['isCompactMode']
  chatDisplayRef?: AppShellContextType['chatDisplayRef']
  onChatMatchInfoChange?: AppShellContextType['onChatMatchInfoChange']
  isFocusedPanel?: AppShellContextType['isFocusedPanel']
}

const SessionPanelChromeContext = createContext<SessionPanelChromeContextType | null>(null)

export function SessionPanelChromeProvider({
  children,
  value,
}: {
  children: React.ReactNode
  value: SessionPanelChromeContextType
}) {
  return (
    <SessionPanelChromeContext.Provider value={value}>
      {children}
    </SessionPanelChromeContext.Provider>
  )
}

interface SessionBatchActionsContextType {
  onSessionStatusChange: AppShellContextType['onSessionStatusChange']
  onArchiveSession: AppShellContextType['onArchiveSession']
  onUnarchiveSession: AppShellContextType['onUnarchiveSession']
  onRenameSession: AppShellContextType['onRenameSession']
  onFlagSession: AppShellContextType['onFlagSession']
  onUnflagSession: AppShellContextType['onUnflagSession']
  onDeleteSession: AppShellContextType['onDeleteSession']
  onSessionLabelsChange?: AppShellContextType['onSessionLabelsChange']
  sessionStatuses?: AppShellContextType['sessionStatuses']
  labels?: AppShellContextType['labels']
}

const SessionBatchActionsContext = createContext<SessionBatchActionsContextType | null>(null)

interface SessionOptionsActionsContextType {
  onSessionOptionsChange: AppShellContextType['onSessionOptionsChange']
}

const SessionOptionsActionsContext = createContext<SessionOptionsActionsContextType | null>(null)

export interface AccountSettingsContextType {
  clientAuthState: AppShellContextType['clientAuthState']
  workspaces: AppShellContextType['workspaces']
  runtimeWorkspace: AppShellContextType['runtimeWorkspace']
  onClientSignedIn: AppShellContextType['onClientSignedIn']
}

const AccountSettingsContext = createContext<AccountSettingsContextType | null>(null)

export function AccountSettingsProvider({
  children,
  value,
}: {
  children: React.ReactNode
  value: AccountSettingsContextType
}) {
  return <AccountSettingsContext.Provider value={value}>{children}</AccountSettingsContext.Provider>
}

export function AppShellProvider({
  children,
  value,
}: {
  children: React.ReactNode
  value: AppShellContextType
}) {
  const sessionInteractionActions = React.useMemo<SessionInteractionActionsContextType>(() => ({
    onCreateSession: value.onCreateSession,
    onSendMessage: value.onSendMessage,
    onRespondToPermission: value.onRespondToPermission,
    onRespondToCredential: value.onRespondToCredential,
    onRespondToUserQuestion: value.onRespondToUserQuestion,
    resolveFileChangeReviewStatus: value.resolveFileChangeReviewStatus,
    onAcceptFileChange: value.onAcceptFileChange,
    onRejectFileChange: value.onRejectFileChange,
    onOpenFileChanges: value.onOpenFileChanges,
    onRevertFileChanges: value.onRevertFileChanges,
  }), [
    value.onCreateSession,
    value.onSendMessage,
    value.onRespondToPermission,
    value.onRespondToCredential,
    value.onRespondToUserQuestion,
    value.resolveFileChangeReviewStatus,
    value.onAcceptFileChange,
    value.onRejectFileChange,
    value.onOpenFileChanges,
    value.onRevertFileChanges,
  ])

  const sessionReadActions = React.useMemo<SessionReadActionsContextType>(() => ({
    onMarkSessionRead: value.onMarkSessionRead,
    onMarkSessionUnread: value.onMarkSessionUnread,
    onSetActiveViewingSession: value.onSetActiveViewingSession,
  }), [
    value.onMarkSessionRead,
    value.onMarkSessionUnread,
    value.onSetActiveViewingSession,
  ])

  const sessionDraftActions = React.useMemo<SessionDraftActionsContextType>(() => ({
    getDraft: value.getDraft,
    hydrateDraftAttachments: value.hydrateDraftAttachments,
    onInputChange: value.onInputChange,
    onAttachmentsChange: value.onAttachmentsChange,
  }), [
    value.getDraft,
    value.hydrateDraftAttachments,
    value.onInputChange,
    value.onAttachmentsChange,
  ])

  const sessionChatResources = React.useMemo<SessionChatResourcesContextType>(() => ({
    runtimeWorkspace: value.runtimeWorkspace,
    onOpenFreeConversations: value.onOpenFreeConversations,
    enabledSources: value.enabledSources,
    skills: value.skills,
    mentionFiles: value.mentionFiles,
    openingProjectState: value.openingProjectState,
    onWorkspaceOpeningCommand: value.onWorkspaceOpeningCommand,
    enabledModes: value.enabledModes,
    onSessionSourcesChange: value.onSessionSourcesChange,
  }), [
    value.runtimeWorkspace,
    value.onOpenFreeConversations,
    value.enabledSources,
    value.skills,
    value.mentionFiles,
    value.openingProjectState,
    value.onWorkspaceOpeningCommand,
    value.enabledModes,
    value.onSessionSourcesChange,
  ])

  const sessionPanelChrome = React.useMemo<SessionPanelChromeContextType>(() => ({
    rightSidebarButton: value.rightSidebarButton,
    leadingAction: value.leadingAction,
    isCompactMode: value.isCompactMode,
    chatDisplayRef: value.chatDisplayRef,
    onChatMatchInfoChange: value.onChatMatchInfoChange,
    isFocusedPanel: value.isFocusedPanel,
  }), [
    value.rightSidebarButton,
    value.leadingAction,
    value.isCompactMode,
    value.chatDisplayRef,
    value.onChatMatchInfoChange,
    value.isFocusedPanel,
  ])

  const sessionBatchActions = React.useMemo<SessionBatchActionsContextType>(() => ({
    onSessionStatusChange: value.onSessionStatusChange,
    onArchiveSession: value.onArchiveSession,
    onUnarchiveSession: value.onUnarchiveSession,
    onRenameSession: value.onRenameSession,
    onFlagSession: value.onFlagSession,
    onUnflagSession: value.onUnflagSession,
    onDeleteSession: value.onDeleteSession,
    onSessionLabelsChange: value.onSessionLabelsChange,
    sessionStatuses: value.sessionStatuses,
    labels: value.labels,
  }), [
    value.onSessionStatusChange,
    value.onArchiveSession,
    value.onUnarchiveSession,
    value.onRenameSession,
    value.onFlagSession,
    value.onUnflagSession,
    value.onDeleteSession,
    value.onSessionLabelsChange,
    value.sessionStatuses,
    value.labels,
  ])

  const sessionOptionsActions = React.useMemo<SessionOptionsActionsContextType>(() => ({
    onSessionOptionsChange: value.onSessionOptionsChange,
  }), [value.onSessionOptionsChange])

  const accountSettings = React.useMemo<AccountSettingsContextType>(() => ({
    clientAuthState: value.clientAuthState,
    workspaces: value.workspaces,
    runtimeWorkspace: value.runtimeWorkspace,
    onClientSignedIn: value.onClientSignedIn,
  }), [
    value.clientAuthState,
    value.workspaces,
    value.runtimeWorkspace,
    value.onClientSignedIn,
  ])

  return (
    <AccountSettingsProvider value={accountSettings}>
      <SessionReadActionsContext.Provider value={sessionReadActions}>
        <SessionDraftActionsContext.Provider value={sessionDraftActions}>
          <SessionChatResourcesContext.Provider value={sessionChatResources}>
            <SessionPanelChromeContext.Provider value={sessionPanelChrome}>
              <SessionInteractionActionsContext.Provider value={sessionInteractionActions}>
                <SessionBatchActionsContext.Provider value={sessionBatchActions}>
                  <SessionOptionsActionsContext.Provider value={sessionOptionsActions}>
                    {children}
                  </SessionOptionsActionsContext.Provider>
                </SessionBatchActionsContext.Provider>
              </SessionInteractionActionsContext.Provider>
            </SessionPanelChromeContext.Provider>
          </SessionChatResourcesContext.Provider>
        </SessionDraftActionsContext.Provider>
      </SessionReadActionsContext.Provider>
    </AccountSettingsProvider>
  )
}

export function useAccountSettings(): AccountSettingsContextType {
  const context = useContext(AccountSettingsContext)
  if (!context) {
    throw new Error('useAccountSettings must be used within an AccountSettingsProvider')
  }
  return context
}

export function useSessionInteractionActions(): SessionInteractionActionsContextType {
  const context = useContext(SessionInteractionActionsContext)
  if (!context) {
    throw new Error('useSessionInteractionActions must be used within an AppShellProvider')
  }
  return context
}

export function useSessionReadActions(): SessionReadActionsContextType {
  const context = useContext(SessionReadActionsContext)
  if (!context) {
    throw new Error('useSessionReadActions must be used within an AppShellProvider')
  }
  return context
}

export function useSessionDraftActions(): SessionDraftActionsContextType {
  const context = useContext(SessionDraftActionsContext)
  if (!context) {
    throw new Error('useSessionDraftActions must be used within an AppShellProvider')
  }
  return context
}

export function useSessionChatResources(): SessionChatResourcesContextType {
  const context = useContext(SessionChatResourcesContext)
  if (!context) {
    throw new Error('useSessionChatResources must be used within an AppShellProvider')
  }
  return context
}

export function useSessionPanelChrome(): SessionPanelChromeContextType {
  const context = useContext(SessionPanelChromeContext)
  if (!context) {
    throw new Error('useSessionPanelChrome must be used within an AppShellProvider')
  }
  return context
}

export function useSessionBatchActions(): SessionBatchActionsContextType {
  const context = useContext(SessionBatchActionsContext)
  if (!context) {
    throw new Error('useSessionBatchActions must be used within an AppShellProvider')
  }
  return context
}

export function useSessionOptionsActions(): SessionOptionsActionsContextType {
  const context = useContext(SessionOptionsActionsContext)
  if (!context) {
    throw new Error('useSessionOptionsActions must be used within an AppShellProvider')
  }
  return context
}

/**
 * Get a specific session by ID using per-session atoms
 * This hook only re-renders when the specific session changes,
 * not when other sessions change (solves streaming isolation)
 */
export function useSession(sessionId: string): Session | null {
  // Use per-session atom for isolated updates
  return useAtomValue(sessionAtomFamily(sessionId))
}

/**
 * Get pending permission for a session (first in queue)
 */
export function usePendingPermission(sessionId: string): PermissionRequest | undefined {
  return useAtomValue(pendingPermissionAtomFamily(sessionId))
}

/**
 * Get pending credential request for a session (first in queue)
 */
export function usePendingCredential(sessionId: string): CredentialRequest | undefined {
  return useAtomValue(pendingCredentialAtomFamily(sessionId))
}

export function usePendingUserQuestion(sessionId: string): UserQuestionRequest | undefined {
  return useAtomValue(pendingUserQuestionAtomFamily(sessionId))
}

/**
 * Hook to get and update session options for a specific session.
 * This is the primary way components should access session options.
 *
 * Usage:
 *   const { options, setPermissionMode } = useSessionOptionsFor(sessionId)
 *   setPermissionMode('safe')
 */
export function useSessionOptionsFor(sessionId: string): {
  options: SessionOptions
  setOption: <K extends keyof SessionOptions>(key: K, value: SessionOptions[K]) => void
  setOptions: (updates: SessionOptionUpdates) => void
  setPermissionMode: (mode: PermissionMode) => void
  isSafeModeActive: () => boolean
} {
  const { onSessionOptionsChange } = useSessionOptionsActions()
  const options = useAtomValue(sessionOptionsAtomFamily(sessionId))

  const setOption = useCallback(<K extends keyof SessionOptions>(
    key: K,
    value: SessionOptions[K]
  ) => {
    onSessionOptionsChange(sessionId, { [key]: value })
  }, [sessionId, onSessionOptionsChange])

  const setOptions = useCallback((updates: SessionOptionUpdates) => {
    onSessionOptionsChange(sessionId, updates)
  }, [sessionId, onSessionOptionsChange])

  const setPermissionMode = useCallback((mode: PermissionMode) => {
    setOption('permissionMode', mode)
  }, [setOption])

  const isSafeModeActive = useCallback(() => {
    return options.permissionMode === 'safe'
  }, [options.permissionMode])

  return {
    options,
    setOption,
    setOptions,
    setPermissionMode,
    isSafeModeActive,
  }
}
