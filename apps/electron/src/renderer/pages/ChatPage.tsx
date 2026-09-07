/**
 * ChatPage
 *
 * input: Session state, workspace state, chat actions, and renderer IPC APIs
 * output: Chat view for the selected session with leading task title chrome
 * pos: Primary session page inside the Electron app shell
 *
 * Displays a single session's chat with a consistent PanelHeader.
 * Extracted from MainContentPanel for consistency with other pages.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue, useSetAtom } from 'jotai'
import { AlertCircle, Info } from 'lucide-react'
import { usePlatform } from '@craft-agent/ui'
import { ChatDisplay } from '@/components/app-shell/ChatDisplay'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { SessionMenu } from '@/components/app-shell/SessionMenu'
import { SessionInfoPopover } from '@/components/app-shell/SessionInfoPopover'
import { RenameDialog } from '@/components/ui/rename-dialog'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import { usePendingPermission, usePendingCredential, usePendingUserQuestion, useSessionBatchActions, useSessionChatResources, useSessionDraftActions, useSessionInteractionActions, useSessionPanelChrome, useSessionReadActions, useSessionOptionsFor, useSession as useSessionData } from '@/context/AppShellContext'
import { rendererPerf } from '@/lib/perf'
import { resolveFileLinkTarget } from '@/lib/platform'
import { coerceInputText } from '@/lib/input-text'
import { deriveSessionMessagesLoadState, formatSessionLoadFailure } from '@/lib/session-load'
import { ensureSessionMessagesLoadedAtom, forceSessionMessagesReloadAtom, sessionMessagesLoadedAtomFamily, sessionMetaAtomFamily, updateSessionAtom } from '@/atoms/sessions'
import { activeSessionListSearchQueryAtom, sessionListSearchActiveAtom } from '@/atoms/session-list-search'
import { llmConnectionsAtom, refreshLlmConnectionsAtom, workspaceDefaultLlmConnectionAtom } from '@/atoms/llm-connections'
import { getSessionTitle } from '@/utils/session'
// Model resolution: connection.defaultModel (no hardcoded defaults)
import { resolveEffectiveConnectionSlug, isSessionConnectionUnavailable } from '@config/llm-connections'
import { resolveChatOpeningPrompt } from '@/components/app-shell/chat-opening'
import { FREE_CONVERSATION_WORKSPACE_ID } from '../../shared/types'

export interface ChatPageProps {
  sessionId: string
}

const noopOpenFile = (_path: string) => {}
const noopOpenUrl = (_url: string) => {}

const ChatPage = React.memo(function ChatPage({ sessionId }: ChatPageProps) {
  const { t } = useTranslation()
  // List/history clicks own the interaction start. This idempotent fallback covers
  // direct navigation without overwriting that earlier timestamp.
  React.useLayoutEffect(() => {
    rendererPerf.startSessionSwitch(sessionId)
    rendererPerf.markSessionSwitch(sessionId, 'panel.mounted')
  }, [sessionId])

  const {
    rightSidebarButton,
    leadingAction,
    isCompactMode,
    chatDisplayRef,
    onChatMatchInfoChange,
    isFocusedPanel,
  } = useSessionPanelChrome()
  const {
    runtimeWorkspace,
    enabledSources,
    skills,
    mentionFiles,
    openingProjectState,
    onWorkspaceOpeningCommand,
    enabledModes,
    onSessionSourcesChange,
  } = useSessionChatResources()
  const {
    getDraft,
    hydrateDraftAttachments,
    onInputChange,
    onAttachmentsChange,
  } = useSessionDraftActions()
  const { onSetActiveViewingSession } = useSessionReadActions()
  const {
    onOpenFile = noopOpenFile,
    onOpenUrl = noopOpenUrl,
  } = usePlatform()
  const {
    onCreateSession,
    onSendMessage,
    onRespondToPermission,
    onRespondToCredential,
    onRespondToUserQuestion,
    resolveFileChangeReviewStatus,
    onAcceptFileChange,
    onRejectFileChange,
    onOpenFileChanges,
    onRevertFileChanges,
  } = useSessionInteractionActions()
  const {
    labels,
    onSessionLabelsChange,
    sessionStatuses,
    onArchiveSession,
    onUnarchiveSession,
    onRenameSession,
    onDeleteSession,
    onSessionStatusChange,
  } = useSessionBatchActions()

  // Use the unified session options hook for clean access
  const {
    options: sessionOpts,
    setOption,
    setPermissionMode,
  } = useSessionOptionsFor(sessionId)

  // Use per-session atom for isolated updates
  const session = useSessionData(sessionId)
  const activeWorkspaceId = runtimeWorkspace?.id ?? null
  const chatWorkspace = runtimeWorkspace
  const llmConnections = useAtomValue(llmConnectionsAtom)
  const workspaceDefaultLlmConnection = useAtomValue(workspaceDefaultLlmConnectionAtom)
  const refreshLlmConnections = useSetAtom(refreshLlmConnectionsAtom)
  const updateSession = useSetAtom(updateSessionAtom)
  const sessionListSearchQuery = useAtomValue(activeSessionListSearchQueryAtom)
  const isSearchModeActive = useAtomValue(sessionListSearchActiveAtom)

  // Track if messages are loaded for this session (for lazy loading)
  const messagesLoaded = useAtomValue(sessionMessagesLoadedAtomFamily(sessionId))

  // Check if session exists in metadata (for loading state detection)
  const sessionMeta = useAtomValue(sessionMetaAtomFamily(sessionId))
  const conversationStarted = Math.max(
    session?.messageCount ?? 0,
    sessionMeta?.messageCount ?? 0,
    session?.messages?.length ?? 0,
  ) > 0 || !!session?.lastFinalMessageId || !!sessionMeta?.lastFinalMessageId
  const canChangeWorkingDirectory = activeWorkspaceId !== null
    && activeWorkspaceId !== FREE_CONVERSATION_WORKSPACE_ID
    && !conversationStarted

  // Fallback: ensure messages are loaded when session is viewed
  const ensureMessagesLoaded = useSetAtom(ensureSessionMessagesLoadedAtom)
  const forceMessagesReload = useSetAtom(forceSessionMessagesReloadAtom)
  const [messagesLoadError, setMessagesLoadError] = React.useState<string | null>(null)
  const [messagesRetrying, setMessagesRetrying] = React.useState(false)
  const autoForcedReloadSessionRef = React.useRef<string | null>(null)
  const shouldForceInitialMessagesReload = React.useMemo(() => {
    const expectedMessageCount = session?.messageCount ?? sessionMeta?.messageCount ?? 0
    return messagesLoaded
      && !!session
      && (session.messages?.length ?? 0) === 0
      && (expectedMessageCount > 0 || !!session.lastFinalMessageId || !!sessionMeta?.lastFinalMessageId)
  }, [messagesLoaded, session, sessionMeta])

  React.useEffect(() => {
    let cancelled = false
    setMessagesLoadError(null)
    setMessagesRetrying(false)

    if (shouldForceInitialMessagesReload && autoForcedReloadSessionRef.current === sessionId) {
      setMessagesLoadError('Session messages are not available')
      return () => {
        cancelled = true
      }
    }

    const useForceReload = shouldForceInitialMessagesReload
    if (useForceReload) {
      autoForcedReloadSessionRef.current = sessionId
    }

    const loadPromise = useForceReload
      ? forceMessagesReload(sessionId)
      : ensureMessagesLoaded(sessionId)

    loadPromise
      .then((loadedSession) => {
        if (!cancelled && !loadedSession) {
          setMessagesLoadError('Session messages are not available')
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMessagesLoadError(formatSessionLoadFailure(error))
        }
      })

    return () => {
      cancelled = true
    }
  }, [sessionId, ensureMessagesLoaded, forceMessagesReload, shouldForceInitialMessagesReload])

  const handleRetryMessagesLoad = React.useCallback(async () => {
    setMessagesLoadError(null)
    setMessagesRetrying(true)

    try {
      const loadedSession = await forceMessagesReload(sessionId)
      if (!loadedSession) {
        setMessagesLoadError('Session messages are not available')
      }
    } catch (error) {
      setMessagesLoadError(formatSessionLoadFailure(error))
    } finally {
      setMessagesRetrying(false)
    }
  }, [forceMessagesReload, sessionId])

  const messageLoadState = React.useMemo(() => deriveSessionMessagesLoadState({
    session,
    sessionMeta,
    messagesLoaded,
    loadError: messagesLoadError,
  }), [session, sessionMeta, messagesLoaded, messagesLoadError])

  // Perf: Mark when session data is available
  const sessionLoadedMarkedRef = React.useRef<string | null>(null)
  React.useLayoutEffect(() => {
    if (session && sessionLoadedMarkedRef.current !== sessionId) {
      sessionLoadedMarkedRef.current = sessionId
      rendererPerf.markSessionSwitch(sessionId, 'session.loaded')
    }
  }, [sessionId, session])

  // Track window focus state for marking session as read when app regains focus
  const [isWindowFocused, setIsWindowFocused] = React.useState(true)
  React.useEffect(() => {
    window.electronAPI.getWindowFocusState().then(setIsWindowFocused)
    const cleanup = window.electronAPI.onWindowFocusChange(setIsWindowFocused)
    return cleanup
  }, [])

  // Track which session user is viewing (for unread state machine).
  // This tells main process user is looking at this session, so:
  // 1. If not processing → clear hasUnread immediately
  // 2. If processing → when it completes, main process will clear hasUnread
  // The main process handles all the logic; we just report viewing state.
  React.useEffect(() => {
    if (session && isWindowFocused && isFocusedPanel !== false) {
      onSetActiveViewingSession(session.id)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, isWindowFocused, isFocusedPanel, onSetActiveViewingSession])

  // Get pending permission and credential for this session
  const pendingPermission = usePendingPermission(sessionId)
  const pendingCredential = usePendingCredential(sessionId)
  const pendingUserQuestion = usePendingUserQuestion(sessionId)

  // Track draft value for this session
  const [inputValue, setInputValue] = React.useState(() => coerceInputText(getDraft(sessionId)))
  const inputValueRef = React.useRef(inputValue)
  inputValueRef.current = inputValue

  // Re-sync from parent when session changes
  React.useEffect(() => {
    setInputValue(coerceInputText(getDraft(sessionId)))
  }, [getDraft, sessionId])

  // Explicit draft injections (rewind, deep link, queued-message restore).
  React.useEffect(() => {
    const handler = (e: Event) => {
      const { sessionId: targetId, text } = (e as CustomEvent).detail ?? {}
      if (targetId === sessionId) {
        const nextText = coerceInputText(text)
        setInputValue(nextText)
        inputValueRef.current = nextText
      }
    }
    window.addEventListener('craft:restore-input', handler)
    return () => window.removeEventListener('craft:restore-input', handler)
  }, [sessionId])

  const handleInputChange = React.useCallback((value: string) => {
    const nextText = coerceInputText(value)
    setInputValue(nextText)
    inputValueRef.current = nextText
    onInputChange(sessionId, nextText)
  }, [sessionId, onInputChange])

  // Attachments draft state — hydrated async from persisted refs on session switch.
  // `[]` is the safe default while hydration is in flight; FreeFormInput seeds its
  // local state from this prop and swaps in the restored list when ready.
  const [attachmentsValue, setAttachmentsValue] = React.useState<import('../../shared/types').FileAttachment[]>([])

  React.useEffect(() => {
    let cancelled = false
    setAttachmentsValue([])
    hydrateDraftAttachments(sessionId).then((atts) => {
      if (!cancelled) setAttachmentsValue(atts)
    })
    return () => { cancelled = true }
  }, [sessionId, hydrateDraftAttachments])

  const handleAttachmentsChange = React.useCallback((attachments: import('../../shared/types').FileAttachment[]) => {
    setAttachmentsValue(attachments)
    onAttachmentsChange(sessionId, attachments)
  }, [sessionId, onAttachmentsChange])

  // Persist the session selection and the global default used by new sessions.
  // ConfigWatcher owns refreshing the shared connection catalog after persistence.
  const handleModelChange = React.useCallback(async (model: string, connection?: string) => {
    if (activeWorkspaceId) {
      try {
        await window.electronAPI.setSessionModel(sessionId, activeWorkspaceId, model, connection)
        updateSession(sessionId, current => current && {
          ...current,
          model,
          ...(connection ? { llmConnection: connection } : {}),
        })
      } catch (error) {
        console.error('Failed to change model:', error)
      }
    }
  }, [sessionId, activeWorkspaceId, updateSession])

  // Session connection change handler - can only change before first message
  const handleConnectionChange = React.useCallback(async (connectionSlug: string) => {
    try {
      await window.electronAPI.sessionCommand(sessionId, { type: 'setConnection', connectionSlug })
    } catch (error) {
      // Connection change may fail if session already started or connection is invalid
      console.error('Failed to change connection:', error)
    }
  }, [sessionId])

  // Check if session's locked connection has been removed
  const connectionUnavailable = React.useMemo(() =>
    isSessionConnectionUnavailable(session?.llmConnection, llmConnections),
    [session?.llmConnection, llmConnections]
  )

  // Effective model for this session (session-specific or global fallback)
  const effectiveModel = React.useMemo(() => {
    if (session?.model) return session.model

    // When connection is unavailable, don't resolve through a different connection
    if (connectionUnavailable) return session?.model ?? ''

    const connectionSlug = resolveEffectiveConnectionSlug(
      session?.llmConnection, workspaceDefaultLlmConnection, llmConnections
    )
    const connection = connectionSlug ? llmConnections.find(c => c.slug === connectionSlug) : null

    return connection?.defaultModel ?? ''
  }, [session?.id, session?.model, session?.llmConnection, workspaceDefaultLlmConnection, llmConnections, connectionUnavailable])

  const chatOpening = React.useMemo(() => resolveChatOpeningPrompt({
    workspaceName: chatWorkspace?.name,
    isProject: openingProjectState !== undefined,
    hasUserContent: openingProjectState?.hasUserContent,
  }), [
    chatWorkspace?.name,
    openingProjectState,
  ])

  // Working directory for this session
  const workingDirectory = session?.workingDirectory

  const handleWorkingDirectoryChange = React.useCallback(async (path: string) => {
    if (!session) return
    await window.electronAPI.sessionCommand(session.id, { type: 'updateWorkingDirectory', dir: path })
  }, [session])

  const handleOpenFile = React.useCallback(
    (path: string) => {
      onOpenFile(resolveFileLinkTarget(path, workingDirectory || chatWorkspace?.rootPath))
    },
    [onOpenFile, workingDirectory, chatWorkspace?.rootPath]
  )

  const handleOpenUrl = React.useCallback(
    (url: string) => {
      onOpenUrl(url)
    },
    [onOpenUrl]
  )

  // Perf: Mark when data is ready
  const dataReadyMarkedRef = React.useRef<string | null>(null)
  React.useLayoutEffect(() => {
    if (messageLoadState.messagesReady && session && dataReadyMarkedRef.current !== sessionId) {
      dataReadyMarkedRef.current = sessionId
      rendererPerf.markSessionSwitch(sessionId, 'data.ready')
    }
  }, [sessionId, messageLoadState.messagesReady, session])

  // Perf: Mark render complete after paint
  React.useEffect(() => {
    if (messageLoadState.error) {
      rendererPerf.cancelSessionSwitch(sessionId)
      return
    }
    if (!session || !messageLoadState.messagesReady) return

    const rafId = requestAnimationFrame(() => {
      rendererPerf.endSessionSwitch(sessionId)
    })
    return () => cancelAnimationFrame(rafId)
  }, [sessionId, session, messageLoadState.error, messageLoadState.messagesReady])

  // Get display title for header - use getSessionTitle for consistent fallback logic with SessionList
  // Priority: name > first user message > preview > "New chat"
  const displayTitle = session ? getSessionTitle(session) : (sessionMeta ? getSessionTitle(sessionMeta) : t('chat.session'))
  // Use isAsyncOperationOngoing for shimmer effect (sharing, updating share, revoking, title regeneration)
  const isAsyncOperationOngoing = session?.isAsyncOperationOngoing || sessionMeta?.isAsyncOperationOngoing || false

  // Rename dialog state
  const [renameDialogOpen, setRenameDialogOpen] = React.useState(false)
  const [renameName, setRenameName] = React.useState('')

  // Session action handlers
  const handleRename = React.useCallback(() => {
    setRenameName(displayTitle)
    setRenameDialogOpen(true)
  }, [displayTitle])

  const handleRenameSubmit = React.useCallback(() => {
    if (renameName.trim() && renameName.trim() !== displayTitle) {
      onRenameSession(sessionId, renameName.trim())
    }
    setRenameDialogOpen(false)
  }, [sessionId, renameName, displayTitle, onRenameSession])

  const handleArchive = React.useCallback(() => {
    onArchiveSession(sessionId)
  }, [sessionId, onArchiveSession])

  const handleUnarchive = React.useCallback(() => {
    onUnarchiveSession(sessionId)
  }, [sessionId, onUnarchiveSession])

  const handleSessionStatusChange = React.useCallback((state: string) => {
    onSessionStatusChange(sessionId, state)
  }, [sessionId, onSessionStatusChange])

  const handleDelete = React.useCallback(async () => {
    await onDeleteSession(sessionId)
  }, [sessionId, onDeleteSession])

  const compactInfoButton = React.useMemo(() => {
    if (!isCompactMode || !sessionMeta) return undefined

    return (
      <SessionInfoPopover
        sessionId={sessionId}
        sessionFolderPath={session?.sessionFolderPath}
        presentation="drawer"
        onRenameSession={onRenameSession}
        onOpenFile={handleOpenFile}
        trigger={(
          <PanelHeaderCenterButton
            icon={<Info className="h-4 w-4" />}
            aria-label={t("chat.sessionInfo")}
          />
        )}
      />
    )
  }, [handleOpenFile, isCompactMode, onRenameSession, sessionId, session?.sessionFolderPath, sessionMeta])

  const headerLeadingAction = React.useMemo(() => leadingAction, [leadingAction])
  const headerActions = isCompactMode ? compactInfoButton : undefined

  // Build title menu content for chat sessions using shared SessionMenu
  const titleMenu = React.useMemo(() => sessionMeta ? (
    <SessionMenu
      item={sessionMeta}
      onRename={handleRename}
      onArchive={handleArchive}
      onUnarchive={handleUnarchive}
      onDelete={handleDelete}
    />
  ) : null, [
    sessionMeta,
    handleRename,
    handleArchive,
    handleUnarchive,
    handleDelete,
  ])

  // Handle missing session - loading or deleted
  if (!session) {
    if (sessionMeta || (!messagesLoaded && !messagesLoadError)) {
      // Session metadata or the direct session payload is still loading.
      const loadingSessionMeta = sessionMeta ?? {
        id: sessionId,
        workspaceId: activeWorkspaceId || '',
        lastMessageAt: 0,
      }
      const skeletonSession = {
        id: loadingSessionMeta.id,
        workspaceId: loadingSessionMeta.workspaceId,
        workspaceName: '',
        name: loadingSessionMeta.name,
        preview: loadingSessionMeta.preview,
        lastMessageAt: loadingSessionMeta.lastMessageAt || 0,
        messages: [],
        isProcessing: loadingSessionMeta.isProcessing || false,
        isFlagged: loadingSessionMeta.isFlagged,
        isPinned: loadingSessionMeta.isPinned,
        workingDirectory: loadingSessionMeta.workingDirectory,
        enabledSourceSlugs: loadingSessionMeta.enabledSourceSlugs,
      }

      return (
        <>
          <div className="relative h-full flex flex-col">
            <PanelHeader className="absolute inset-x-0 top-0 border-b-0 bg-gradient-to-b from-background via-background/95 to-transparent" titleAlign="start" title={displayTitle} titleMenu={titleMenu} leadingAction={headerLeadingAction} actions={headerActions} rightSidebarButton={rightSidebarButton} isRegeneratingTitle={isAsyncOperationOngoing} />
            <div className="flex-1 flex flex-col min-h-0">
              <ChatDisplay
                ref={chatDisplayRef}
                session={skeletonSession}
                onSendMessage={() => {}}
                onOpenFile={handleOpenFile}
                onOpenUrl={handleOpenUrl}
                currentModel={effectiveModel}
                onModelChange={handleModelChange}
                llmConnections={llmConnections}
                workspaceDefaultLlmConnection={workspaceDefaultLlmConnection}
                refreshLlmConnections={refreshLlmConnections}
                workspaceRootPath={chatWorkspace?.rootPath ?? null}
                onCreateSession={onCreateSession}
                onDraftInputChange={onInputChange}
                onConnectionChange={handleConnectionChange}
                pendingPermission={undefined}
                onRespondToPermission={onRespondToPermission}
                pendingCredential={undefined}
                pendingUserQuestion={undefined}
                onRespondToCredential={onRespondToCredential}
                thinkingLevel={sessionOpts.thinkingLevel}
                onThinkingLevelChange={(level) => setOption('thinkingLevel', level)}
                permissionMode={sessionOpts.permissionMode}
                onPermissionModeChange={setPermissionMode}
                enabledModes={enabledModes}
                inputValue={inputValue}
                onInputChange={handleInputChange}
                attachmentsValue={attachmentsValue}
                onAttachmentsChange={handleAttachmentsChange}
                sources={enabledSources}
                skills={skills}
                mentionFiles={mentionFiles}
                sessionStatuses={sessionStatuses}
                onSessionStatusChange={handleSessionStatusChange}
                workspaceId={activeWorkspaceId || undefined}
                onSourcesChange={(slugs) => onSessionSourcesChange?.(sessionId, slugs)}
                workingDirectory={loadingSessionMeta.workingDirectory}
                onWorkingDirectoryChange={canChangeWorkingDirectory ? handleWorkingDirectoryChange : undefined}
                messagesLoading={messageLoadState.messagesLoading || (messagesRetrying && !messageLoadState.messagesReady)}
                messagesLoadError={messageLoadState.error}
                messagesRetrying={messagesRetrying}
                onRetryMessagesLoad={handleRetryMessagesLoad}
                searchQuery={sessionListSearchQuery}
                isSearchModeActive={isSearchModeActive}
                onMatchInfoChange={onChatMatchInfoChange}
                connectionUnavailable={connectionUnavailable}
                compactMode={!!isCompactMode}
                chatOpening={chatOpening}
                onChatOpeningCommand={onWorkspaceOpeningCommand}
                isFocusedPanel={isFocusedPanel ?? true}
              />
            </div>
          </div>
          <RenameDialog
            open={renameDialogOpen}
            onOpenChange={setRenameDialogOpen}
            title={t('chat.renameSession')}
            value={renameName}
            onValueChange={setRenameName}
            onSubmit={handleRenameSubmit}
            placeholder={t('chat.enterSessionName')}
          />
        </>
      )
    }

    // Session truly doesn't exist
    return (
      <div className="relative h-full flex flex-col">
        <PanelHeader className="absolute inset-x-0 top-0 border-b-0 bg-gradient-to-b from-background via-background/95 to-transparent" titleAlign="start" title={t('chat.session')} leadingAction={headerLeadingAction} actions={headerActions} rightSidebarButton={rightSidebarButton} />
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
          <AlertCircle className="h-10 w-10" />
          <p className="text-sm">{t('chat.sessionNoLongerExists')}</p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="relative h-full flex flex-col">
        <PanelHeader className="absolute inset-x-0 top-0 border-b-0 bg-gradient-to-b from-background via-background/95 to-transparent" titleAlign="start" title={displayTitle} titleMenu={titleMenu} leadingAction={headerLeadingAction} actions={headerActions} rightSidebarButton={rightSidebarButton} isRegeneratingTitle={isAsyncOperationOngoing} />
        <div className="flex-1 flex flex-col min-h-0">
          <ChatDisplay
            ref={chatDisplayRef}
            session={session}
            onSendMessage={(message, attachments, skillSlugs, runtimeOptions) => {
              if (session) {
                onSendMessage(
                  session.id,
                  message,
                  attachments,
                  skillSlugs,
                  undefined,
                  runtimeOptions?.forceQueuePreview ? { forceQueuedUserMessage: true } : undefined,
                )
              }
            }}
            onOpenFile={handleOpenFile}
            onOpenUrl={handleOpenUrl}
            resolveFileChangeReviewStatus={resolveFileChangeReviewStatus
              ? change => resolveFileChangeReviewStatus(sessionId, change)
              : undefined}
            onAcceptFileChange={onAcceptFileChange
              ? change => onAcceptFileChange(sessionId, change)
              : undefined}
            onRejectFileChange={onRejectFileChange
              ? change => onRejectFileChange(sessionId, change)
              : undefined}
            onOpenFileChanges={onOpenFileChanges
              ? changes => onOpenFileChanges(sessionId, changes)
              : undefined}
            onRevertFileChanges={onRevertFileChanges
              ? changes => onRevertFileChanges(sessionId, changes)
              : undefined}
            currentModel={effectiveModel}
            onModelChange={handleModelChange}
            llmConnections={llmConnections}
            workspaceDefaultLlmConnection={workspaceDefaultLlmConnection}
            refreshLlmConnections={refreshLlmConnections}
            workspaceRootPath={chatWorkspace?.rootPath ?? null}
            onCreateSession={onCreateSession}
            onDraftInputChange={onInputChange}
            onConnectionChange={handleConnectionChange}
            pendingPermission={pendingPermission}
            onRespondToPermission={onRespondToPermission}
            pendingCredential={pendingCredential}
            pendingUserQuestion={pendingUserQuestion}
            onRespondToUserQuestion={onRespondToUserQuestion}
            onRespondToCredential={onRespondToCredential}
            thinkingLevel={sessionOpts.thinkingLevel}
            onThinkingLevelChange={(level) => setOption('thinkingLevel', level)}
            permissionMode={sessionOpts.permissionMode}
            onPermissionModeChange={setPermissionMode}
            enabledModes={enabledModes}
            inputValue={inputValue}
            onInputChange={handleInputChange}
            attachmentsValue={attachmentsValue}
            onAttachmentsChange={handleAttachmentsChange}
            sources={enabledSources}
            skills={skills}
            mentionFiles={mentionFiles}
            labels={labels}
            onLabelsChange={(newLabels) => onSessionLabelsChange?.(sessionId, newLabels)}
            sessionStatuses={sessionStatuses}
            onSessionStatusChange={handleSessionStatusChange}
            workspaceId={activeWorkspaceId || undefined}
            onSourcesChange={(slugs) => onSessionSourcesChange?.(sessionId, slugs)}
            workingDirectory={workingDirectory}
            onWorkingDirectoryChange={canChangeWorkingDirectory ? handleWorkingDirectoryChange : undefined}
            sessionFolderPath={session?.sessionFolderPath}
            messagesLoading={messageLoadState.messagesLoading || (messagesRetrying && !messageLoadState.messagesReady)}
            messagesLoadError={messageLoadState.error}
            messagesRetrying={messagesRetrying}
            onRetryMessagesLoad={handleRetryMessagesLoad}
            searchQuery={sessionListSearchQuery}
            isSearchModeActive={isSearchModeActive}
            onMatchInfoChange={onChatMatchInfoChange}
            connectionUnavailable={connectionUnavailable}
            compactMode={!!isCompactMode}
            chatOpening={chatOpening}
            onChatOpeningCommand={onWorkspaceOpeningCommand}
            isFocusedPanel={isFocusedPanel ?? true}
          />
        </div>
      </div>
      <RenameDialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        title={t('chat.renameSession')}
        value={renameName}
        onValueChange={setRenameName}
        onSubmit={handleRenameSubmit}
        placeholder={t('chat.enterSessionName')}
      />
    </>
  )
})

export default ChatPage
