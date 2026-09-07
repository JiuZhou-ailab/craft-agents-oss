// input: Synthetic session events that may repeat or miss their targets
// output: Regression coverage for session handler no-op state preservation
// pos: Guards renderer event handlers against unnecessary session reference churn

import { describe, expect, it } from 'bun:test'
import {
  handleAsyncOperation,
  handleAuthCompleted,
  handleComplete,
  handleConnectionChanged,
  handleInfo,
  handleLabelsChanged,
  handleMessageAnnotationsUpdated,
  handleNameChanged,
  handleQueuedMessageRemoved,
  handleSessionArchived,
  handleSessionFlagged,
  handleSessionModelChanged,
  handleSessionPinned,
  handleSessionShared,
  handleSessionStatusChanged,
  handleSessionUnarchived,
  handleSessionUnflagged,
  handleSessionUnpinned,
  handleSessionUnshared,
  handleSourcesChanged,
  handleStatus,
  handleTitleGenerated,
  handleUsageUpdate,
  handleWorkingDirectoryChanged,
} from './session'
import type {
  AsyncOperationEvent,
  AuthCompletedEvent,
  CompleteEvent,
  InfoEvent,
  LabelsChangedEvent,
  LLMConnectionChangedEvent,
  MessageAnnotationsUpdatedEvent,
  NameChangedEvent,
  QueuedMessageRemovedEvent,
  SessionArchivedEvent,
  SessionFlaggedEvent,
  SessionModelChangedEvent,
  SessionPinnedEvent,
  SessionSharedEvent,
  SessionStatusChangedEvent,
  SessionState,
  StatusEvent,
  SessionUnarchivedEvent,
  SessionUnflaggedEvent,
  SessionUnpinnedEvent,
  SessionUnsharedEvent,
  SourcesChangedEvent,
  TitleGeneratedEvent,
  UsageUpdateEvent,
  WorkingDirectoryChangedEvent,
} from '../types'

function makeState(sessionFields: Record<string, unknown>): SessionState {
  return {
    session: {
      id: 'session-1',
      messages: [],
      ...sessionFields,
    } as any,
    streaming: null,
  }
}

describe('session event no-op guards', () => {
  it('keeps the original state for duplicate complete events with no session changes', () => {
    const state = makeState({
      isProcessing: false,
      currentStatus: undefined,
      messages: [
        { id: 'msg-1', role: 'assistant', content: 'done', toolStatus: 'completed' },
      ],
    })
    const event: CompleteEvent = {
      type: 'complete',
      sessionId: 'session-1',
    }

    expect(handleComplete(state, event).state).toBe(state)
  })

  it('keeps the original state for duplicate async operation status', () => {
    const state = makeState({ isAsyncOperationOngoing: true })
    const event: AsyncOperationEvent = {
      type: 'async_operation',
      sessionId: 'session-1',
      isOngoing: true,
    }

    expect(handleAsyncOperation(state, event).state).toBe(state)
  })

  it('keeps the original state for duplicate session model', () => {
    const state = makeState({ model: 'gpt-5' })
    const event: SessionModelChangedEvent = {
      type: 'session_model_changed',
      sessionId: 'session-1',
      model: 'gpt-5',
    }

    expect(handleSessionModelChanged(state, event).state).toBe(state)
  })

  it('keeps the original state for duplicate connection capabilities', () => {
    const state = makeState({ llmConnection: 'codex', supportsBranching: true })
    const event: LLMConnectionChangedEvent = {
      type: 'connection_changed',
      sessionId: 'session-1',
      connectionSlug: 'codex',
      supportsBranching: true,
    }

    expect(handleConnectionChanged(state, event).state).toBe(state)
  })

  it('keeps the original state for duplicate session status', () => {
    const state = makeState({ sessionStatus: 'drafting' })
    const event: SessionStatusChangedEvent = {
      type: 'session_status_changed',
      sessionId: 'session-1',
      sessionStatus: 'drafting',
    }

    expect(handleSessionStatusChanged(state, event).state).toBe(state)
  })

  it('keeps the original state for duplicate labels', () => {
    const state = makeState({ labels: ['draft', 'urgent'] })
    const event: LabelsChangedEvent = {
      type: 'labels_changed',
      sessionId: 'session-1',
      labels: ['draft', 'urgent'],
    }

    expect(handleLabelsChanged(state, event).state).toBe(state)
  })

  it('keeps the original state for duplicate enabled sources', () => {
    const state = makeState({ enabledSourceSlugs: ['github', 'docs'] })
    const event: SourcesChangedEvent = {
      type: 'sources_changed',
      sessionId: 'session-1',
      enabledSourceSlugs: ['github', 'docs'],
    }

    expect(handleSourcesChanged(state, event).state).toBe(state)
  })

  it('keeps the original state for duplicate session name', () => {
    const state = makeState({ name: 'Draft title' })
    const event: NameChangedEvent = {
      type: 'name_changed',
      sessionId: 'session-1',
      name: 'Draft title',
    }

    expect(handleNameChanged(state, event).state).toBe(state)
  })

  it('keeps the original state for a duplicate generated title', () => {
    const state = makeState({ name: 'Draft title' })
    const event: TitleGeneratedEvent = {
      type: 'title_generated',
      sessionId: 'session-1',
      title: 'Draft title',
    }

    expect(handleTitleGenerated(state, event).state).toBe(state)
  })

  it('keeps the original state for duplicate working directory', () => {
    const state = makeState({ workingDirectory: '/repo/project' })
    const event: WorkingDirectoryChangedEvent = {
      type: 'working_directory_changed',
      sessionId: 'session-1',
      workingDirectory: '/repo/project',
    }

    expect(handleWorkingDirectoryChanged(state, event).state).toBe(state)
  })

  it('keeps the original state for duplicate flagged status', () => {
    const state = makeState({ isFlagged: true })
    const event: SessionFlaggedEvent = {
      type: 'session_flagged',
      sessionId: 'session-1',
    }

    expect(handleSessionFlagged(state, event).state).toBe(state)
  })

  it('keeps the original state for duplicate unflagged status', () => {
    const state = makeState({ isFlagged: false })
    const event: SessionUnflaggedEvent = {
      type: 'session_unflagged',
      sessionId: 'session-1',
    }

    expect(handleSessionUnflagged(state, event).state).toBe(state)
  })

  it('keeps the original state for duplicate pinned status', () => {
    const state = makeState({ isPinned: true })
    const event: SessionPinnedEvent = {
      type: 'session_pinned',
      sessionId: 'session-1',
    }

    expect(handleSessionPinned(state, event).state).toBe(state)
  })

  it('keeps the original state for duplicate unpinned status', () => {
    const state = makeState({ isPinned: false })
    const event: SessionUnpinnedEvent = {
      type: 'session_unpinned',
      sessionId: 'session-1',
    }

    expect(handleSessionUnpinned(state, event).state).toBe(state)
  })

  it('keeps the original state for duplicate archived status', () => {
    const state = makeState({ isArchived: true, archivedAt: 123 })
    const event: SessionArchivedEvent = {
      type: 'session_archived',
      sessionId: 'session-1',
    }

    expect(handleSessionArchived(state, event).state).toBe(state)
  })

  it('keeps the original state for duplicate unarchived status', () => {
    const state = makeState({ isArchived: false, archivedAt: undefined })
    const event: SessionUnarchivedEvent = {
      type: 'session_unarchived',
      sessionId: 'session-1',
    }

    expect(handleSessionUnarchived(state, event).state).toBe(state)
  })

  it('keeps the original state for duplicate shared URL', () => {
    const state = makeState({ sharedUrl: 'https://viewer.example/s/session-1' })
    const event: SessionSharedEvent = {
      type: 'session_shared',
      sessionId: 'session-1',
      sharedUrl: 'https://viewer.example/s/session-1',
    }

    expect(handleSessionShared(state, event).state).toBe(state)
  })

  it('keeps the original state for duplicate unshared status', () => {
    const state = makeState({ sharedUrl: undefined, sharedId: undefined })
    const event: SessionUnsharedEvent = {
      type: 'session_unshared',
      sessionId: 'session-1',
    }

    expect(handleSessionUnshared(state, event).state).toBe(state)
  })

  it('keeps the original state when auth completion target is missing', () => {
    const state = makeState({
      messages: [
        { id: 'msg-1', role: 'assistant', content: 'hello' },
      ],
    })
    const event: AuthCompletedEvent = {
      type: 'auth_completed',
      sessionId: 'session-1',
      requestId: 'missing',
      success: true,
    }

    expect(handleAuthCompleted(state, event).state).toBe(state)
  })

  it('keeps the original state for duplicate auth completion status', () => {
    const state = makeState({
      messages: [
        {
          id: 'auth-1',
          role: 'auth-request',
          content: 'Authorize',
          authRequestId: 'auth-1',
          authStatus: 'completed',
        },
      ],
    })
    const event: AuthCompletedEvent = {
      type: 'auth_completed',
      sessionId: 'session-1',
      requestId: 'auth-1',
      success: true,
    }

    expect(handleAuthCompleted(state, event).state).toBe(state)
  })

  it('keeps the original state for duplicate usage update', () => {
    const state = makeState({
      tokenUsage: {
        inputTokens: 1200,
        outputTokens: 80,
        totalTokens: 1280,
        contextTokens: 1200,
        costUsd: 0.01,
        contextWindow: 200000,
      },
    })
    const event: UsageUpdateEvent = {
      type: 'usage_update',
      sessionId: 'session-1',
      tokenUsage: {
        contextTokens: 1200,
        contextWindow: 200000,
      },
    }

    expect(handleUsageUpdate(state, event).state).toBe(state)
  })

  it('keeps the original state when queued removal target is missing', () => {
    const state = makeState({
      messages: [
        { id: 'msg-1', role: 'user', content: 'first' },
        { id: 'msg-3', role: 'user', content: 'queued two', isQueued: true },
      ],
    })
    const event: QueuedMessageRemovedEvent = {
      type: 'queued_message_removed',
      sessionId: 'session-1',
      messageId: 'msg-2',
    }

    expect(handleQueuedMessageRemoved(state, event).state).toBe(state)
  })

  it('keeps the original state when annotation update target is missing', () => {
    const state = makeState({
      messages: [
        { id: 'msg-1', role: 'assistant', content: 'alpha' },
        { id: 'msg-2', role: 'assistant', content: 'beta' },
      ],
    })
    const event: MessageAnnotationsUpdatedEvent = {
      type: 'message_annotations_updated',
      sessionId: 'session-1',
      messageId: 'missing',
      annotations: [],
    }

    expect(handleMessageAnnotationsUpdated(state, event).state).toBe(state)
  })

  it('keeps the original state when compaction completion has no compacting message', () => {
    const state = makeState({
      messages: [
        { id: 'msg-1', role: 'user', content: 'hello' },
        { id: 'info-1', role: 'info', content: 'done' },
      ],
      currentStatus: undefined,
    })
    const event: InfoEvent = {
      type: 'info',
      sessionId: 'session-1',
      message: 'Compaction complete',
      statusType: 'compaction_complete',
      level: 'success',
    }

    expect(handleInfo(state, event).state).toBe(state)
  })

  it('keeps retry status ephemeral and overwrites the current status', () => {
    const state = makeState({
      messages: [{ id: 'msg-1', role: 'user', content: 'hello' }],
      currentStatus: undefined,
    })
    const firstEvent = {
      type: 'status',
      sessionId: 'session-1',
      message: 'Retrying (attempt 1/3)...',
      statusType: 'retrying',
    } satisfies StatusEvent
    const secondEvent = {
      ...firstEvent,
      message: 'Retrying (attempt 2/3)...',
    }

    const first = handleStatus(state, firstEvent)
    const second = handleStatus(first.state, secondEvent)

    expect(first.state.session.messages).toBe(state.session.messages)
    expect(second.state.session.messages).toBe(state.session.messages)
    expect(second.state.session.currentStatus).toEqual({
      message: 'Retrying (attempt 2/3)...',
      statusType: 'retrying',
    })
  })
})
