// input: Accepted and rejected sends for a newly-created Session
// output: Regression coverage for create-and-send rollback semantics
// pos: Prevents login preflight failures from leaving orphan fixed Sessions

import { describe, expect, it } from 'bun:test'
import { commitCreatedSessionSend } from './session-creation-transaction'

describe('commitCreatedSessionSend', () => {
  it('keeps the Session when the canonical send path accepts the message', async () => {
    let rolledBack = false

    expect(await commitCreatedSessionSend(
      async () => 'accepted' as const,
      async () => { rolledBack = true },
    )).toBe(true)
    expect(rolledBack).toBe(false)
  })

  it('deletes the empty Session when login preflight rejects the send', async () => {
    let rolledBack = false

    expect(await commitCreatedSessionSend(
      async () => 'rejected' as const,
      async () => { rolledBack = true },
    )).toBe(false)
    expect(rolledBack).toBe(true)
  })

  it('preserves the Session when send acceptance is unknown or throws', async () => {
    let rolledBack = false
    const rollback = async () => { rolledBack = true }
    expect(await commitCreatedSessionSend(async () => 'unknown' as const, rollback)).toBe(false)
    await expect(commitCreatedSessionSend(async () => { throw new Error('Connection lost') }, rollback)).rejects.toThrow('Connection lost')
    expect(rolledBack).toBe(false)
  })
})
