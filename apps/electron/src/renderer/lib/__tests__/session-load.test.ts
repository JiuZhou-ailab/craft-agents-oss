import { describe, expect, it } from 'bun:test'
import { FREE_CONVERSATION_WORKSPACE_ID, type Session, type TransportConnectionState } from '../../../shared/types'
import {
  deriveSessionMessagesLoadState,
  formatSessionLoadFailure,
  shouldApplyCreatedSessionSnapshot,
  shouldAutoCreateBaseSession,
  shouldTreatSessionLoadFailureAsTransportFallback,
} from '../session-load'

function createState(overrides?: Partial<TransportConnectionState>): TransportConnectionState {
  return {
    mode: 'remote',
    status: 'connected',
    url: 'wss://remote.example.test',
    attempt: 0,
    updatedAt: Date.now(),
    ...overrides,
  }
}

function createSession(overrides?: Partial<Session>): Session {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    workspaceName: 'Workspace',
    lastMessageAt: Date.now(),
    messages: [],
    isProcessing: false,
    ...overrides,
  }
}

describe('deriveSessionMessagesLoadState', () => {
  it('loads metadata-only sessions that are not marked loaded', () => {
    const state = deriveSessionMessagesLoadState({
      session: createSession({ messages: [], messageCount: 2 }),
      sessionMeta: { messageCount: 2 },
      messagesLoaded: false,
    })

    expect(state.messagesReady).toBe(false)
    expect(state.messagesLoading).toBe(true)
  })

  it('treats in-memory messages as ready even when the loaded flag is stale', () => {
    const state = deriveSessionMessagesLoadState({
      session: createSession({
        messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: Date.now() }],
        messageCount: 1,
      }),
      sessionMeta: { messageCount: 1 },
      messagesLoaded: false,
    })

    expect(state.hasInMemoryMessages).toBe(true)
    expect(state.messagesReady).toBe(true)
    expect(state.messagesLoading).toBe(false)
  })

  it('treats loaded empty sessions as ready', () => {
    const state = deriveSessionMessagesLoadState({
      session: createSession({ messages: [], messageCount: 0 }),
      sessionMeta: { messageCount: 0 },
      messagesLoaded: true,
    })

    expect(state.messagesReady).toBe(true)
    expect(state.messagesLoading).toBe(false)
  })

  it('treats an empty loaded atom with expected messages as stale', () => {
    const state = deriveSessionMessagesLoadState({
      session: createSession({ messages: [], messageCount: 2 }),
      sessionMeta: { messageCount: 2 },
      messagesLoaded: true,
    })

    expect(state.hasStaleLoadedFlag).toBe(true)
    expect(state.messagesReady).toBe(false)
    expect(state.messagesLoading).toBe(true)
  })

  it('surfaces load errors instead of continuing to load forever', () => {
    const state = deriveSessionMessagesLoadState({
      session: createSession({ messages: [], messageCount: 2 }),
      sessionMeta: { messageCount: 2 },
      messagesLoaded: false,
      loadError: 'boom',
    })

    expect(state.messagesReady).toBe(false)
    expect(state.messagesLoading).toBe(false)
    expect(state.error).toBe('boom')
  })

  it('clears stale load errors once messages are ready', () => {
    const state = deriveSessionMessagesLoadState({
      session: createSession({
        messages: [{ id: 'm1', role: 'assistant', content: 'ready', timestamp: Date.now() }],
        messageCount: 1,
      }),
      sessionMeta: { messageCount: 1 },
      messagesLoaded: false,
      loadError: 'old failure',
    })

    expect(state.messagesReady).toBe(true)
    expect(state.error).toBe(null)
  })
})

describe('shouldApplyCreatedSessionSnapshot', () => {
  it('rejects an empty creation snapshot after the live session already received a user message', () => {
    expect(shouldApplyCreatedSessionSnapshot(
      createSession({
        messages: [{ id: 'user-1', role: 'user', content: 'hello', timestamp: 2 }],
        messageCount: 1,
      }),
      createSession({ messages: [], messageCount: 0, lastMessageAt: 1 }),
    )).toBe(false)
  })

  it('accepts the initial creation snapshot and snapshots that are not older', () => {
    const snapshot = createSession({ messages: [], messageCount: 0 })
    expect(shouldApplyCreatedSessionSnapshot(null, snapshot)).toBe(true)
    expect(shouldApplyCreatedSessionSnapshot(
      createSession({ messages: [], messageCount: 0 }),
      createSession({
        messages: [{ id: 'user-1', role: 'user', content: 'hello', timestamp: 2 }],
        messageCount: 1,
      }),
    )).toBe(true)
  })
})

describe('shouldAutoCreateBaseSession', () => {
  it('keeps Free Conversation immediately usable', () => {
    expect(shouldAutoCreateBaseSession(FREE_CONVERSATION_WORKSPACE_ID, [])).toBe(true)
  })

  it('opens a blank Session when entering a Project without conversations', () => {
    expect(shouldAutoCreateBaseSession('project-1', [])).toBe(true)
  })

  it('does not create a Session without an active workspace', () => {
    expect(shouldAutoCreateBaseSession(null, [])).toBe(false)
    expect(shouldAutoCreateBaseSession('', [])).toBe(false)
  })

  it('does not duplicate an existing renderable Session', () => {
    expect(shouldAutoCreateBaseSession(FREE_CONVERSATION_WORKSPACE_ID, [{ hidden: false, isArchived: false }])).toBe(false)
    expect(shouldAutoCreateBaseSession('project-1', [{ hidden: false, isArchived: false }])).toBe(false)
  })
})

describe('shouldTreatSessionLoadFailureAsTransportFallback', () => {
  it('returns true for remote reconnecting state', () => {
    expect(shouldTreatSessionLoadFailureAsTransportFallback(
      createState({ status: 'reconnecting' }),
    )).toBe(true)
  })

  it('returns true for remote auth/network/timeout failures', () => {
    expect(shouldTreatSessionLoadFailureAsTransportFallback(
      createState({
        status: 'connected',
        lastError: { kind: 'auth', message: 'Bad token' },
      }),
    )).toBe(true)
  })

  it('returns false for remote connected state without transport errors', () => {
    expect(shouldTreatSessionLoadFailureAsTransportFallback(
      createState({ status: 'connected' }),
    )).toBe(false)
  })

  it('returns false for local transport state', () => {
    expect(shouldTreatSessionLoadFailureAsTransportFallback(
      createState({ mode: 'local', status: 'failed' }),
    )).toBe(false)
  })
})

describe('formatSessionLoadFailure', () => {
  it('prefers Error.message', () => {
    expect(formatSessionLoadFailure(new Error('boom'))).toBe('boom')
  })

  it('falls back to a generic message', () => {
    expect(formatSessionLoadFailure(null)).toBe('Unknown error')
  })
})
