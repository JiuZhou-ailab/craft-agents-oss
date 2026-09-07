// input: Managed Session pin mutations and persistence outcomes
// output: Regression coverage for durable pin state and failure rollback
// pos: Guards the fixed-navigation transaction independently from business flags

import { describe, expect, it } from 'bun:test'
import type { SessionEvent } from '@craft-agent/shared/protocol'
import { SessionCrudMetadata } from './session-crud-metadata'
import type { ManagedSession } from './managed-session'

function setup(options?: { failFlush?: boolean }) {
  const managed = {
    id: 'session-1',
    isPinned: false,
    isFlagged: false,
    workspace: { id: 'workspace-1', rootPath: '/workspace' },
  } as ManagedSession
  const events: SessionEvent[] = []
  const persisted: boolean[] = []
  const crud = new SessionCrudMetadata({
    getSession: id => id === managed.id ? managed : undefined,
    allSessions: () => [managed],
    persistSession: session => { persisted.push(session.isPinned) },
    flushSession: async () => {
      if (options?.failFlush) throw new Error('disk unavailable')
    },
    sendEvent: event => { events.push(event) },
    emitUnreadSummaryChanged: () => {},
    setMetadataWriteGuard: () => {},
    notifyFileChange: () => {},
  })
  return { crud, events, managed, persisted }
}

describe('SessionCrudMetadata pin state', () => {
  it('persists and announces pinning without changing the business flag', async () => {
    const { crud, events, managed, persisted } = setup()

    await crud.pinSession(managed.id)

    expect(managed.isPinned).toBe(true)
    expect(managed.isFlagged).toBe(false)
    expect(persisted).toEqual([true])
    expect(events).toEqual([{ type: 'session_pinned', sessionId: managed.id }])
  })

  it('restores in-memory state and emits no event when persistence fails', async () => {
    const { crud, events, managed, persisted } = setup({ failFlush: true })

    await expect(crud.pinSession(managed.id)).rejects.toThrow('disk unavailable')

    expect(managed.isPinned).toBe(false)
    expect(persisted).toEqual([true, false])
    expect(events).toEqual([])
  })
})
