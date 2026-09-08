// input: Session storage APIs and temporary workspace session files
// output: Regression coverage for pending-plan transitions and queue-safe session updates
// pos: Guards read-modify-write persistence at the shared session storage boundary

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { StoredSession } from '../types.ts'
import { clearMetrics, configurePerfTracking } from '../../utils/perf.ts'
import {
  clearPendingPlanExecution,
  getPendingPlanExecution,
  countPlanFiles,
  loadSession,
  markCompactionComplete,
  markPendingPlanExecutionDispatched,
  saveSession,
  sessionPersistenceQueue,
  setPendingPlanExecution,
  updateSessionMetadata,
} from '../storage.ts'

function makeTmpDir(): string {
  const dir = join(tmpdir(), `pending-plan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeStoredSession(workspaceRootPath: string): StoredSession {
  return {
    id: 'session-1',
    workspaceRootPath,
    createdAt: 1000,
    lastUsedAt: 1000,
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  } as StoredSession
}

describe('pending plan execution persistence', () => {
  let workspaceRoot: string

  beforeEach(async () => {
    workspaceRoot = makeTmpDir()
    await saveSession(makeStoredSession(workspaceRoot))
  })

  afterEach(() => {
    configurePerfTracking({ enabled: false, onMetric: undefined })
    clearMetrics()
    if (existsSync(workspaceRoot)) {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('defaults executionDispatched to false and persists transitions', async () => {
    await setPendingPlanExecution(workspaceRoot, 'session-1', '/tmp/plan.md', 'draft snapshot')

    expect(getPendingPlanExecution(workspaceRoot, 'session-1')).toEqual({
      planPath: '/tmp/plan.md',
      draftInputSnapshot: 'draft snapshot',
      awaitingCompaction: true,
      executionDispatched: false,
    })

    await markCompactionComplete(workspaceRoot, 'session-1')
    await markPendingPlanExecutionDispatched(workspaceRoot, 'session-1')

    expect(getPendingPlanExecution(workspaceRoot, 'session-1')).toEqual({
      planPath: '/tmp/plan.md',
      draftInputSnapshot: 'draft snapshot',
      awaitingCompaction: false,
      executionDispatched: true,
    })
  })

  it('does not rewrite a session that has no pending plan execution', async () => {
    const persistedMetrics: string[] = []
    clearMetrics()
    configurePerfTracking({
      enabled: true,
      onMetric: metric => persistedMetrics.push(metric.name),
    })

    await clearPendingPlanExecution(workspaceRoot, 'session-1')

    expect(persistedMetrics).not.toContain('session.persist.write')
    expect(persistedMetrics).not.toContain('session.loadSession')
  })

  it('reads only bounded metadata for a 30MiB transcript without a plan', async () => {
    const session = makeStoredSession(workspaceRoot)
    session.messages = [{ id: 'large', type: 'assistant', content: 'x'.repeat(30 * 1024 * 1024) }]
    await saveSession(session)
    const originalRead = fs.readSync
    let bytes = 0
    const read = spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const count = originalRead(...args)
      bytes += count
      return count
    }) as typeof fs.readSync)
    const fullRead = spyOn(fs, 'readFileSync')
    try {
      await clearPendingPlanExecution(workspaceRoot, session.id)
      expect(bytes).toBeLessThanOrEqual(8192)
      expect(bytes).toBeGreaterThan(0)
      expect(fullRead).not.toHaveBeenCalled()
    } finally {
      read.mockRestore()
      fullRead.mockRestore()
    }
  })

  it('flushes a queued plan before clearing it and preserves queued messages', async () => {
    const pending = makeStoredSession(workspaceRoot)
    pending.pendingPlanExecution = { planPath: '/tmp/plan.md', draftInputSnapshot: 'draft', awaitingCompaction: true }
    pending.messages = [{ id: 'queued', type: 'user', content: 'durable' }]
    sessionPersistenceQueue.enqueue(pending)
    await clearPendingPlanExecution(workspaceRoot, pending.id)
    expect(loadSession(workspaceRoot, pending.id)?.pendingPlanExecution).toBeUndefined()
    expect(loadSession(workspaceRoot, pending.id)?.messages[0]?.content).toBe('durable')
  })

  it('falls back for headers exceeding the bounded read', async () => {
    const pending = makeStoredSession(workspaceRoot)
    pending.name = 'x'.repeat(9000)
    pending.pendingPlanExecution = { planPath: '/tmp/plan.md', draftInputSnapshot: 'draft', awaitingCompaction: true }
    await saveSession(pending)
    await clearPendingPlanExecution(workspaceRoot, pending.id)
    const stored = loadSession(workspaceRoot, pending.id)
    expect(stored?.pendingPlanExecution).toBeUndefined()
    expect(stored?.name).toBe(pending.name)
  })

  it('applies metadata to the latest queued session snapshot', async () => {
    const pending = makeStoredSession(workspaceRoot)
    pending.messages = [{ id: 'assistant-1', type: 'assistant', content: 'done' }]
    sessionPersistenceQueue.enqueue(pending)

    await updateSessionMetadata(workspaceRoot, 'session-1', { hasUnread: true })

    const persisted = loadSession(workspaceRoot, 'session-1')
    expect(persisted?.messages.map(message => message.id)).toEqual(['assistant-1'])
    expect(persisted?.hasUnread).toBe(true)
  })

  it('counts markdown plan files without loading plan metadata', () => {
    const plansDir = join(workspaceRoot, '.craft-agent', 'sessions', 'session-1', 'plans')
    mkdirSync(plansDir, { recursive: true })
    writeFileSync(join(plansDir, 'first.md'), '# First')
    writeFileSync(join(plansDir, 'second.md'), '# Second')
    writeFileSync(join(plansDir, 'notes.txt'), 'not a plan')

    expect(countPlanFiles(workspaceRoot, 'session-1')).toBe(2)
  })
})
