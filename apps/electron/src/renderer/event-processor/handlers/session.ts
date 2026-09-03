// input: Session lifecycle events and immutable renderer session state
// output: Pure state transitions for completion, usage, errors, and metadata
// pos: Canonical renderer projection of main-process session events

/**
 * Session Event Handlers
 *
 * Handles complete, error, sources_changed, etc.
 * Pure functions that return new state - no side effects.
 */

import type {
  SessionState,
  ProcessResult,
  CompleteEvent,
  ErrorEvent,
  TypedErrorEvent,
  SourcesChangedEvent,
  LabelsChangedEvent,
  SessionStatusChangedEvent,
  SessionFlaggedEvent,
  SessionUnflaggedEvent,
  SessionArchivedEvent,
  SessionUnarchivedEvent,
  NameChangedEvent,
  PermissionRequestEvent,
  UserQuestionRequestEvent,
  CredentialRequestEvent,
  PlanSubmittedEvent,
  StatusEvent,
  InfoEvent,
  InterruptedEvent,
  TitleGeneratedEvent,
  AsyncOperationEvent,
  WorkingDirectoryChangedEvent,
  PermissionModeChangedEvent,
  SessionModelChangedEvent,
  LLMConnectionChangedEvent,
  UserMessageEvent,
  MessageAnnotationsUpdatedEvent,
  QueuedMessageRemovedEvent,
  MessagesRewoundEvent,
  SessionSharedEvent,
  SessionUnsharedEvent,
  AuthRequestEvent,
  AuthCompletedEvent,
  UsageUpdateEvent,
  Effect,
} from '../types'
import type { Message } from '../../../shared/types'
import { generateMessageId, appendMessage, updateMessageAt } from '../helpers'

function sameStringList(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return (a?.length ?? 0) === b.length && b.every((value, index) => a?.[index] === value)
}

function isRunningToolMessage(message: Message): boolean {
  return message.role === 'tool'
    && message.toolResult === undefined
    && message.toolStatus !== 'completed'
    && message.toolStatus !== 'error'
}

function appendErrorMessage(messages: Message[], errorMessage: Message): Message[] {
  if (!messages.some(isRunningToolMessage)) {
    return [...messages, errorMessage]
  }

  const nextMessages = messages.map(message =>
    isRunningToolMessage(message)
      ? { ...message, toolStatus: 'error' as const, toolResult: 'Error occurred', isError: true }
      : message
  )
  nextMessages.push(errorMessage)
  return nextMessages
}

/**
 * Handle complete - agent loop finished
 *
 * Sets isProcessing: false, clears streaming state.
 * Also marks any running tools as complete (fail-safe).
 */
export function handleComplete(
  state: SessionState,
  event: CompleteEvent
): ProcessResult {
  const { session } = state

  // Fail-safe: mark any non-terminal tools as complete.
  // Catches 'executing' (normal) and 'backgrounded' (spurious — e.g. foreground Agent
  // whose result contained agentId:). Genuinely backgrounded tasks have isBackground=true
  // AND a taskId, so they're excluded — task_completed will finalize them.
  let updatedMessages = session.messages

  // Clear isQueued from any user messages once the turn completes. Pi's steer
  // path never emits a 'processing' status update to clear it (the message is
  // injected mid-stream and absorbed into the current response), so this is
  // the natural place to drop the indicator. Claude's queued path has already
  // cleared via the 'processing' status update before this fires; this is
  // a safe no-op for that case.
  const turnMetricsByMessageId = event.turnMetrics?.length
    ? new Map(event.turnMetrics.map(({ messageId, metrics }) => [messageId, metrics]))
    : undefined
  for (let index = 0; index < session.messages.length; index++) {
    const message = session.messages[index]
    const shouldCompleteTool = message.role === 'tool'
      && message.toolStatus !== 'completed'
      && message.toolStatus !== 'error'
      && !(message.isBackground && message.taskId)  // Don't force-complete genuine background tasks
    const shouldClearQueuedUser = message.role === 'user' && message.isQueued
    const turnMetrics = turnMetricsByMessageId?.get(message.id)
    const shouldUpdateTurnMetrics = turnMetrics !== undefined && message.turnMetrics !== turnMetrics

    if (!shouldCompleteTool && !shouldClearQueuedUser && !shouldUpdateTurnMetrics) continue
    if (updatedMessages === session.messages) updatedMessages = [...session.messages]
    let updatedMessage: Message = shouldCompleteTool
      ? { ...message, toolStatus: 'completed' as const, toolResult: message.toolResult ?? '' }
      : shouldClearQueuedUser
        ? { ...message, isQueued: false }
        : message
    if (shouldUpdateTurnMetrics) {
      updatedMessage = { ...updatedMessage, turnMetrics }
    }
    updatedMessages[index] = updatedMessage
  }

  const nextTokenUsage = event.tokenUsage ?? session.tokenUsage
  const nextHasUnread = event.hasUnread ?? session.hasUnread
  if (
    updatedMessages === session.messages &&
    session.isProcessing === false &&
    session.currentStatus === undefined &&
    state.streaming === null &&
    Object.is(session.tokenUsage, nextTokenUsage) &&
    Object.is(session.hasUnread, nextHasUnread)
  ) {
    return { state, effects: [] }
  }

  return {
    state: {
      session: {
        ...session,
        messages: updatedMessages,
        isProcessing: false,
        currentStatus: undefined,  // Clear any lingering status
        // Update tokenUsage from complete event (for real-time context counter updates)
        tokenUsage: nextTokenUsage,
        // Update hasUnread flag from main process (state machine for NEW badge)
        // Only update if explicitly provided - undefined means "don't change"
        ...(event.hasUnread !== undefined && { hasUnread: event.hasUnread }),
      },
      streaming: null,
    },
    effects: [],
  }
}

/**
 * Handle error - simple error event
 */
export function handleError(
  state: SessionState,
  event: ErrorEvent
): ProcessResult {
  const { session } = state

  const errorMessage: Message = {
    id: generateMessageId(),
    role: 'error',
    content: event.error,
    timestamp: event.timestamp ?? Date.now(),
  }

  return {
    state: {
      session: {
        ...session,
        messages: appendErrorMessage(session.messages, errorMessage),
        isProcessing: false,
        currentStatus: undefined,  // Clear any lingering status
      },
      streaming: null,
    },
    effects: [],
  }
}

/**
 * Handle typed_error - error with structured details
 */
export function handleTypedError(
  state: SessionState,
  event: TypedErrorEvent
): ProcessResult {
  const { session } = state

  const errorMessage: Message = {
    id: generateMessageId(),
    role: 'error',
    content: event.error.message,
    timestamp: event.timestamp ?? Date.now(),
    errorCode: event.error.code,
    errorTitle: event.error.title,
    errorDetails: event.error.details,
    errorOriginal: event.error.originalError,
    errorCanRetry: event.error.canRetry,
    errorActions: event.error.actions?.map(a => ({
      key: a.key,
      label: a.label,
      action: a.action,
      url: a.url,
      sourceSlug: a.sourceSlug,
    })),
  }

  return {
    state: {
      session: {
        ...session,
        messages: appendErrorMessage(session.messages, errorMessage),
        isProcessing: false,
        currentStatus: undefined,  // Clear any lingering status
      },
      streaming: null,
    },
    effects: [],
  }
}

/**
 * Handle status - status message (e.g., compacting)
 * Stores on session for ProcessingIndicator AND appends as message for TurnCard activity
 */
export function handleStatus(
  state: SessionState,
  event: StatusEvent
): ProcessResult {
  const { session, streaming } = state

  if (event.statusType === 'retrying') {
    return {
      state: {
        session: {
          ...session,
          currentStatus: {
            message: event.message,
            statusType: event.statusType,
          },
        },
        streaming,
      },
      effects: [],
    }
  }

  const statusMessage: Message = {
    id: generateMessageId(),
    role: 'status',
    content: event.message,
    timestamp: event.timestamp ?? Date.now(),
    statusType: event.statusType,
  }

  const updatedSession = appendMessage(session, statusMessage, false, false)

  return {
    state: {
      session: {
        ...updatedSession,
        // Also store on session for ProcessingIndicator
        currentStatus: {
          message: event.message,
          statusType: event.statusType,
        },
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle info - info message (may update existing compacting message)
 */
export function handleInfo(
  state: SessionState,
  event: InfoEvent
): ProcessResult {
  const { session, streaming } = state

  // If this is a compaction complete, update the existing compacting message and clear currentStatus
  if (event.statusType === 'compaction_complete') {
    let updatedMessages: Message[] | null = null
    for (let index = 0; index < session.messages.length; index++) {
      const message = session.messages[index]
      if (message.role !== 'status' || message.statusType !== 'compacting') continue
      updatedMessages ??= [...session.messages]
      updatedMessages[index] = {
        ...message,
        role: 'info',
        content: event.message,
        statusType: 'compaction_complete',
        infoLevel: event.level,
      }
    }

    if (!updatedMessages) return { state, effects: [] }

    return {
      state: {
        session: {
          ...session,
          messages: updatedMessages,
          currentStatus: undefined,  // Clear status from ProcessingIndicator
        },
        streaming,
      },
      effects: [],
    }
  }

  // Otherwise, add as new info message
  const infoMessage: Message = {
    id: generateMessageId(),
    role: 'info',
    content: event.message,
    timestamp: event.timestamp ?? Date.now(),
    infoLevel: event.level,
  }

  return {
    state: {
      session: appendMessage(session, infoMessage, false, false),
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle interrupted - agent was interrupted.
 *
 * Two distinct shapes:
 * - **User-initiated stop** (`event.message` present): user clicked the Stop
 *   button. We render the "Response interrupted" notice, drop queued user
 *   bubbles, and restore their text to the input field so the user can edit
 *   and re-send.
 * - **Silent redirect** (`event.message` absent): the agent aborted internally
 *   so a new message could be processed. The backend's `processNextQueuedMessage`
 *   will auto-replay queued messages — we must NOT remove the queued bubbles
 *   nor restore them to the input, otherwise the user perceives a silent drop
 *   (#616).
 */
export function handleInterrupted(
  state: SessionState,
  event: InterruptedEvent
): ProcessResult {
  const { session } = state
  const effects: Effect[] = []
  const isUserInitiated = !!event.message

  // Clear transient streaming state (isPending, isStreaming) and mark running tools as interrupted
  // These fields are not persisted, so this matches the state after a reload
  // Also filter out status messages - they are transient UI state that shouldn't persist after interruption
  const updatedMessages: Message[] = []
  for (const message of session.messages) {
    if (message.role === 'status') continue
    // Only drop queued bubbles when the user explicitly stopped — silent
    // redirects auto-replay them so they must remain visible (#616).
    if (isUserInitiated && message.isQueued) continue
    // Mark running tools as interrupted
    if (isRunningToolMessage(message)) {
      updatedMessages.push({ ...message, toolStatus: 'error' as const, toolResult: 'Interrupted', isError: true })
      continue
    }
    // Clear pending state on assistant messages (transient streaming state)
    if (message.role === 'assistant' && message.isPending) {
      updatedMessages.push({ ...message, isPending: false, isStreaming: false })
      continue
    }
    updatedMessages.push(message)
  }

  // Only add the "Response interrupted" message if provided (not a silent redirect)
  const messages = event.message
    ? [...updatedMessages, event.message]
    : updatedMessages

  // Restore queued message text to the input field — only on user-initiated
  // stops. Silent redirects keep the bubble in chat and rely on the backend's
  // auto-replay (#616).
  if (isUserInitiated && event.queuedMessages && event.queuedMessages.length > 0) {
    effects.push({
      type: 'restore_input',
      text: event.queuedMessages.join('\n\n'),
    })
  }

  return {
    state: {
      session: {
        ...session,
        isProcessing: event.reason === 'queued_handoff' ? true : false,
        messages,
        currentStatus: undefined,  // Clear any lingering status
      },
      streaming: null,
    },
    effects,
  }
}

/**
 * Handle title_generated - update session title and clear regenerating state
 */
export function handleTitleGenerated(
  state: SessionState,
  event: TitleGeneratedEvent
): ProcessResult {
  const { session, streaming } = state
  if (session.name === event.title) {
    return { state, effects: [] }
  }

  return {
    state: {
      session: {
        ...session,
        name: event.title,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle async_operation - set async operation state for shimmer effect
 * Generic handler for any async operation (sharing, updating share, revoking, title regeneration)
 */
export function handleAsyncOperation(
  state: SessionState,
  event: AsyncOperationEvent
): ProcessResult {
  const { session, streaming } = state
  if (session.isAsyncOperationOngoing === event.isOngoing) {
    return { state, effects: [] }
  }

  return {
    state: {
      session: {
        ...session,
        isAsyncOperationOngoing: event.isOngoing,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle working_directory_changed - update session working directory (user-initiated via UI)
 */
export function handleWorkingDirectoryChanged(
  state: SessionState,
  event: WorkingDirectoryChangedEvent
): ProcessResult {
  const { session, streaming } = state
  if (session.workingDirectory === event.workingDirectory) {
    return { state, effects: [] }
  }

  return {
    state: {
      session: { ...session, workingDirectory: event.workingDirectory },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle permission_mode_changed - return effect for parent to handle session options
 */
export function handlePermissionModeChanged(
  state: SessionState,
  event: PermissionModeChangedEvent
): ProcessResult {
  return {
    state,
    effects: [{
      type: 'permission_mode_changed',
      sessionId: event.sessionId,
      permissionMode: event.permissionMode,
      previousPermissionMode: event.previousPermissionMode,
      transitionDisplay: event.transitionDisplay,
      modeVersion: event.modeVersion,
      changedAt: event.changedAt,
      changedBy: event.changedBy,
    }],
  }
}

/**
 * Handle session_model_changed - update session model
 */
export function handleSessionModelChanged(
  state: SessionState,
  event: SessionModelChangedEvent
): ProcessResult {
  const { session, streaming } = state
  const model = event.model ?? undefined
  if (session.model === model) {
    return { state, effects: [] }
  }

  return {
    state: {
      session: { ...session, model },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle connection_changed - sync session.llmConnection to renderer state
 */
export function handleConnectionChanged(
  state: SessionState,
  event: LLMConnectionChangedEvent
): ProcessResult {
  const { session, streaming } = state
  const supportsBranchingChanged = event.supportsBranching !== undefined
    && session.supportsBranching !== event.supportsBranching
  if (session.llmConnection === event.connectionSlug && !supportsBranchingChanged) {
    return { state, effects: [] }
  }

  return {
    state: {
      session: {
        ...session,
        llmConnection: event.connectionSlug,
        ...(event.supportsBranching !== undefined && { supportsBranching: event.supportsBranching }),
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle user_message - confirms optimistic user message from backend
 *
 * Three statuses:
 * - 'accepted': Message is being processed (confirms optimistic message)
 * - 'queued': Message was queued during ongoing response (adds if not present, marks as queued)
 * - 'processing': Queued message is now being processed (updates status)
 */
export function handleUserMessage(
  state: SessionState,
  event: UserMessageEvent
): ProcessResult {
  const { session, streaming } = state
  const { message, status } = event
  const nextIsQueued = status === 'queued'
  const nextIsProcessing = nextIsQueued
    ? session.isProcessing
    : status === 'accepted' || status === 'processing'

  // Find existing message by ID match (backend ID, optimistic ID, or content+timestamp fallback)
  const existingIndex = session.messages.findIndex(m =>
    m.role === 'user' && (
      m.id === message.id ||
      (event.optimisticMessageId && m.id === event.optimisticMessageId) ||
      (m.content === message.content && Math.abs(m.timestamp - message.timestamp) < 5000)
    )
  )

  let updatedMessages: Message[]

  if (existingIndex >= 0) {
    const existingMessage = session.messages[existingIndex]

    // Event sequence protection: don't regress from 'processing' back to 'queued'
    // This handles out-of-order events (e.g., 'processing' arrives before 'queued')
    if (status === 'queued' && existingMessage.isQueued === false && !existingMessage.isPending) {
      // Already progressed past queued state, ignore this late 'queued' event
      return { state, effects: [] }
    }

    if (
      existingMessage.isPending === false &&
      existingMessage.isQueued === nextIsQueued &&
      session.isProcessing === nextIsProcessing &&
      session.lastMessageRole === 'user'
    ) {
      return { state, effects: [] }
    }

    // Update existing message — clear isPending, set isQueued based on status.
    //
    // - 'queued'     → isQueued = true  (backend queued for re-send)
    // - 'processing' → isQueued = false (queued message is now actually running)
    // - 'accepted'   → isQueued = false (agent has the message)
    //
    // Keep the optimistic id while queued so the chip/timer bubble is not remounted.
    // Once accepted/processing, adopt the server id so rewind and other RPCs that
    // key by message id hit the same record (server now prefers optimistic ids too).
    updatedMessages = [...session.messages]
    updatedMessages[existingIndex] = {
      ...existingMessage,
      ...(!nextIsQueued && message.id !== existingMessage.id ? { id: message.id } : {}),
      ...(status === 'processing' ? { timestamp: message.timestamp } : {}),
      isPending: false,
      isQueued: nextIsQueued,
    }
  } else {
    // Message not found (e.g., queued message from backend) - add it
    const newMessage: Message = {
      ...message,
      isPending: false,
      isQueued: nextIsQueued,
    }
    updatedMessages = [...session.messages, newMessage]
  }

  return {
    state: {
      session: {
        ...session,
        messages: updatedMessages,
        lastMessageAt: Date.now(),
        lastMessageRole: 'user',  // Clear plan badge when user responds
        // Queued messages wait behind the active turn; do not mark the session idle.
        isProcessing: nextIsProcessing,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle message_annotations_updated - update annotations on a specific message.
 */
export function handleMessageAnnotationsUpdated(
  state: SessionState,
  event: MessageAnnotationsUpdatedEvent
): ProcessResult {
  const { session, streaming } = state
  const messageIndex = session.messages.findIndex(message => message.id === event.messageId)
  if (messageIndex === -1) {
    return { state, effects: [] }
  }

  const updatedSession = updateMessageAt(session, messageIndex, {
    annotations: event.annotations,
  })
  if (updatedSession === session) {
    return { state, effects: [] }
  }

  return {
    state: {
      session: updatedSession,
      streaming,
    },
    effects: [],
  }
}

export function handleQueuedMessageRemoved(
  state: SessionState,
  event: QueuedMessageRemovedEvent
): ProcessResult {
  const { session, streaming } = state
  const messageIndex = session.messages.findIndex(message => message.id === event.messageId)
  if (messageIndex === -1) {
    return { state, effects: [] }
  }
  const messages = [...session.messages]
  messages.splice(messageIndex, 1)

  return {
    state: {
      session: {
        ...session,
        messages,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle sources_changed - update session's enabled sources
 */
export function handleSourcesChanged(
  state: SessionState,
  event: SourcesChangedEvent
): ProcessResult {
  const { session, streaming } = state
  if (sameStringList(session.enabledSourceSlugs, event.enabledSourceSlugs)) {
    return { state, effects: [] }
  }

  return {
    state: {
      session: {
        ...session,
        enabledSourceSlugs: event.enabledSourceSlugs,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle labels_changed - update session's labels
 */
export function handleLabelsChanged(
  state: SessionState,
  event: LabelsChangedEvent
): ProcessResult {
  const { session, streaming } = state
  if (sameStringList(session.labels, event.labels)) {
    return { state, effects: [] }
  }

  return {
    state: {
      session: {
        ...session,
        labels: event.labels,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_status_changed - update session's sessionStatus (external metadata change or agent tool)
 */
export function handleSessionStatusChanged(
  state: SessionState,
  event: SessionStatusChangedEvent
): ProcessResult {
  const { session, streaming } = state
  if (session.sessionStatus === event.sessionStatus) {
    return { state, effects: [] }
  }
  return {
    state: {
      session: { ...session, sessionStatus: event.sessionStatus },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_flagged - mark session as flagged
 */
export function handleSessionFlagged(
  state: SessionState,
  _event: SessionFlaggedEvent
): ProcessResult {
  const { session, streaming } = state
  if (session.isFlagged === true) {
    return { state, effects: [] }
  }

  return {
    state: {
      session: { ...session, isFlagged: true },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_unflagged - mark session as unflagged
 */
export function handleSessionUnflagged(
  state: SessionState,
  _event: SessionUnflaggedEvent
): ProcessResult {
  const { session, streaming } = state
  if (session.isFlagged === false) {
    return { state, effects: [] }
  }

  return {
    state: {
      session: { ...session, isFlagged: false },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_archived - mark session as archived
 */
export function handleSessionArchived(
  state: SessionState,
  _event: SessionArchivedEvent
): ProcessResult {
  const { session, streaming } = state
  if (session.isArchived === true && session.archivedAt !== undefined) {
    return { state, effects: [] }
  }

  return {
    state: {
      session: { ...session, isArchived: true, archivedAt: Date.now() },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_unarchived - mark session as unarchived
 */
export function handleSessionUnarchived(
  state: SessionState,
  _event: SessionUnarchivedEvent
): ProcessResult {
  const { session, streaming } = state
  if (session.isArchived !== true && session.archivedAt === undefined) {
    return { state, effects: [] }
  }

  return {
    state: {
      session: { ...session, isArchived: false, archivedAt: undefined },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle name_changed - update session name (external metadata change)
 */
export function handleNameChanged(
  state: SessionState,
  event: NameChangedEvent
): ProcessResult {
  const { session, streaming } = state
  if (session.name === event.name) {
    return { state, effects: [] }
  }

  return {
    state: {
      session: { ...session, name: event.name },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle permission_request - return effect for parent to handle
 */
export function handlePermissionRequest(
  state: SessionState,
  event: PermissionRequestEvent
): ProcessResult {
  return {
    state,
    effects: [{
      type: 'permission_request',
      request: event.request,
    }]
  }
}

export function handleUserQuestionRequest(
  state: SessionState,
  event: UserQuestionRequestEvent
): ProcessResult {
  return {
    state,
    effects: [{
      type: 'user_question_request',
      request: event.request,
    }],
  }
}

/**
 * Handle credential_request - return effect for parent to handle
 */
export function handleCredentialRequest(
  state: SessionState,
  event: CredentialRequestEvent
): ProcessResult {
  return {
    state,
    effects: [{
      type: 'credential_request',
      request: event.request,
    }]
  }
}

/**
 * Handle plan_submitted - add plan message to session
 */
export function handlePlanSubmitted(
  state: SessionState,
  event: PlanSubmittedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: appendMessage(session, event.message),
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_shared - session was shared to viewer
 */
export function handleSessionShared(
  state: SessionState,
  event: SessionSharedEvent
): ProcessResult {
  const { session, streaming } = state
  if (session.sharedUrl === event.sharedUrl) {
    return { state, effects: [] }
  }

  return {
    state: {
      session: {
        ...session,
        sharedUrl: event.sharedUrl,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_unshared - session share was revoked
 */
export function handleSessionUnshared(
  state: SessionState,
  _event: SessionUnsharedEvent
): ProcessResult {
  const { session, streaming } = state
  if (session.sharedUrl === undefined && session.sharedId === undefined) {
    return { state, effects: [] }
  }

  return {
    state: {
      session: {
        ...session,
        sharedUrl: undefined,
        sharedId: undefined,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle auth_request - add auth-request message to session
 * This is the unified auth flow - execution is paused until auth completes
 */
export function handleAuthRequest(
  state: SessionState,
  event: AuthRequestEvent
): ProcessResult {
  const { session } = state

  // Add auth-request message to session
  return {
    state: {
      session: {
        ...appendMessage(session, event.message),
        isProcessing: false,  // Agent execution is paused
      },
      streaming: null,  // Clear any streaming state
    },
    effects: [],
  }
}

/**
 * Handle auth_completed - update auth-request message status
 * The agent will resume via a new user message (sent by session manager)
 */
export function handleAuthCompleted(
  state: SessionState,
  event: AuthCompletedEvent
): ProcessResult {
  const { session, streaming } = state

  // Update the auth-request message status
  const messageIndex = session.messages.findIndex(m => (
    m.role === 'auth-request' &&
    m.authRequestId === event.requestId &&
    m.authStatus === 'pending'
  ))
  if (messageIndex === -1) return { state, effects: [] }

  const updatedMessages = [...session.messages]
  updatedMessages[messageIndex] = {
    ...updatedMessages[messageIndex],
    authStatus: event.success
      ? ('completed' as const)
      : event.cancelled
        ? ('cancelled' as const)
        : ('failed' as const),
    authError: event.error,
  }

  return {
    state: {
      session: {
        ...session,
        messages: updatedMessages,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle messages_rewound — replace transcript with the truncated active path.
 */
export function handleMessagesRewound(
  state: SessionState,
  event: MessagesRewoundEvent,
): ProcessResult {
  const { session } = state
  const lastUser = [...event.messages].reverse().find(m => m.role === 'user')
  const lastFinalAssistant = [...event.messages].reverse().find(
    m => m.role === 'assistant' && !m.isIntermediate,
  )
  return {
    state: {
      session: {
        ...session,
        messages: event.messages,
        messageCount: event.messages.length,
        lastFinalMessageId: lastFinalAssistant?.id,
        lastMessageRole: lastFinalAssistant ? 'assistant' : lastUser ? 'user' : undefined,
        preview: typeof lastUser?.content === 'string'
          ? lastUser.content.slice(0, 200)
          : session.preview,
        isProcessing: false,
      },
      streaming: null,
    },
    effects: event.draftText !== undefined
      ? [{ type: 'restore_input', text: event.draftText }]
      : [],
  }
}

/**
 * Handle usage_update - real-time context usage during processing
 * Merges usage update into existing tokenUsage (preserves outputTokens, costUsd, etc.)
 */
export function handleUsageUpdate(
  state: SessionState,
  event: UsageUpdateEvent
): ProcessResult {
  const { session, streaming } = state
  const currentTokenUsage = session.tokenUsage
  if (
    currentTokenUsage !== undefined
    && currentTokenUsage.contextTokens === event.tokenUsage.contextTokens
    && currentTokenUsage.contextWindow === event.tokenUsage.contextWindow
  ) {
    return { state, effects: [] }
  }

  // Merge usage update into existing tokenUsage, providing defaults for required fields
  const updatedTokenUsage = {
    inputTokens: session.tokenUsage?.inputTokens ?? 0,
    outputTokens: session.tokenUsage?.outputTokens ?? 0,
    totalTokens: session.tokenUsage?.totalTokens ?? 0,
    contextTokens: event.tokenUsage.contextTokens,
    costUsd: session.tokenUsage?.costUsd ?? 0,
    ...(session.tokenUsage?.cacheReadTokens !== undefined && { cacheReadTokens: session.tokenUsage.cacheReadTokens }),
    ...(session.tokenUsage?.cacheCreationTokens !== undefined && { cacheCreationTokens: session.tokenUsage.cacheCreationTokens }),
    ...(event.tokenUsage.contextWindow && { contextWindow: event.tokenUsage.contextWindow }),
  }

  return {
    state: {
      session: {
        ...session,
        tokenUsage: updatedTokenUsage,
      },
      streaming,
    },
    effects: [],
  }
}
