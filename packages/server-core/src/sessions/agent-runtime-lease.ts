// input: ManagedSession identity checks and an agent factory callback
// output: Send-admission gates, runtime leases, exclusive locks, and active-operation checks
// pos: Separates atomic message admission from runtime ownership and exclusive mutations

import type { AgentInstance, ManagedSession } from './managed-session'

export interface AgentRuntimeLeaseDeps {
  /** True when the session is still present in the Facade registry (not closing/deleted). */
  isSessionTracked(managed: ManagedSession): boolean
  /** Refresh Host-owned Project identity; true means a live runtime is stale. */
  refreshSessionWorkspace(managed: ManagedSession): boolean
  /** Strictly re-resolve Pi cwd; true means the runtime was built for a stale target. */
  revalidateAgentWorkingDirectory(managed: ManagedSession): boolean
  /** Dispose a runtime after its Project identity or cwd grants change. */
  disposeAgentRuntime(managed: ManagedSession, reason: string): Promise<void>
  /** Resolve or create the session's Pi subprocess. Resolves through the Facade at call time so per-instance stubs keep working. */
  getOrCreateAgent(managed: ManagedSession): Promise<AgentInstance>
  onOperationsDrained?(): void
}

/**
 * Per-session runtime concurrency: a mutex serializes exclusive mutations,
 * and reference-counted leases let compatible operations (chat, one-shot
 * queries) share one stable Pi subprocess while refresh/dispose wait them out.
 */
export class AgentRuntimeLease {
  constructor(private deps: AgentRuntimeLeaseDeps) {}

  private agentRuntimeLocks: Map<string, Promise<void>> = new Map()
  private sendAdmissionTails: Map<string, Promise<void>> = new Map()
  /** Active compatible operations sharing one stable Pi subprocess. */
  private agentRuntimeLeaseCounts: Map<string, number> = new Map()
  /** Exclusive mutations wait here until every active operation releases the subprocess. */
  private agentRuntimeLeaseWaiters: Map<string, Set<() => void>> = new Map()
  /** A short Session operation refreshed Project inputs before the next runtime lease. */
  private workspaceRuntimeRefreshRequired = new Set<string>()

  private assertAgentRuntimeOpen(managed: ManagedSession, expectedEpoch?: number): void {
    if (!this.deps.isSessionTracked(managed) || managed.runtimeState) {
      throw new Error(`Session ${managed.id} is closing`)
    }
    if (expectedEpoch !== undefined && (managed.runtimeEpoch ?? 0) !== expectedEpoch) {
      throw new Error(`Session ${managed.id} runtime was invalidated`)
    }
  }

  private async withAgentRuntimeMutex<T>(
    managed: ManagedSession,
    work: () => Promise<T>,
    notifyOperationsDrained = true,
  ): Promise<T> {
    const previous = this.agentRuntimeLocks.get(managed.id) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const slot = previous.catch(() => undefined).then(() => gate)
    this.agentRuntimeLocks.set(managed.id, slot)
    await previous.catch(() => undefined)
    try {
      return await work()
    } finally {
      release()
      if (this.agentRuntimeLocks.get(managed.id) === slot) {
        this.agentRuntimeLocks.delete(managed.id)
      }
      if (notifyOperationsDrained) this.deps.onOperationsDrained?.()
    }
  }

  private waitForAgentRuntimeLeases(sessionId: string): Promise<void> {
    if ((this.agentRuntimeLeaseCounts.get(sessionId) ?? 0) === 0) return Promise.resolve()
    return new Promise(resolve => {
      const waiters = this.agentRuntimeLeaseWaiters.get(sessionId) ?? new Set<() => void>()
      waiters.add(resolve)
      this.agentRuntimeLeaseWaiters.set(sessionId, waiters)
    })
  }

  private retainAgentRuntimeLease(sessionId: string): void {
    this.agentRuntimeLeaseCounts.set(sessionId, (this.agentRuntimeLeaseCounts.get(sessionId) ?? 0) + 1)
  }

  private releaseAgentRuntimeLease(sessionId: string): void {
    const remaining = (this.agentRuntimeLeaseCounts.get(sessionId) ?? 1) - 1
    if (remaining > 0) {
      this.agentRuntimeLeaseCounts.set(sessionId, remaining)
      return
    }
    this.agentRuntimeLeaseCounts.delete(sessionId)
    const waiters = this.agentRuntimeLeaseWaiters.get(sessionId)
    this.agentRuntimeLeaseWaiters.delete(sessionId)
    for (const resolve of waiters ?? []) resolve()
    this.deps.onOperationsDrained?.()
  }

  /** Synchronous admission check for non-destructive idle cleanup. */
  hasActiveOperations(sessionId: string): boolean {
    return (this.agentRuntimeLeaseCounts.get(sessionId) ?? 0) > 0
  }

  /** Opportunistic eviction never queues behind active work or an exclusive mutation. */
  async tryWithIdleRuntimeLock(managed: ManagedSession, work: () => Promise<boolean>): Promise<boolean> {
    const available = () => this.deps.isSessionTracked(managed) && !managed.runtimeState
      && !this.hasActiveOperations(managed.id) && !this.sendAdmissionTails.has(managed.id)
    if (this.agentRuntimeLocks.has(managed.id) || !available()) return false
    const epoch = managed.runtimeEpoch
    return this.withAgentRuntimeMutex(managed, async () => {
      if (!available() || managed.runtimeEpoch !== epoch) return false
      return work()
    }, false)
  }

  /** Hold only until a send is durably queued or claims the processing generation. */
  async acquireSendAdmission(sessionId: string): Promise<() => void> {
    const previous = this.sendAdmissionTails.get(sessionId) ?? Promise.resolve()
    let unlock!: () => void
    const gate = new Promise<void>(resolve => { unlock = resolve })
    const tail = previous.then(() => gate)
    this.sendAdmissionTails.set(sessionId, tail)
    await previous
    let released = false
    return () => {
      if (released) return
      released = true
      unlock()
      if (this.sendAdmissionTails.get(sessionId) === tail) this.sendAdmissionTails.delete(sessionId)
    }
  }

  /** Keep short pre-runtime session work ahead of deletion and invalidation. */
  beginSessionOperationLease(managed: ManagedSession): () => void {
    this.assertAgentRuntimeOpen(managed)
    if (this.deps.refreshSessionWorkspace(managed)) {
      this.workspaceRuntimeRefreshRequired.add(managed.id)
    }
    managed.runtimeLastUsedAt = performance.now()
    this.retainAgentRuntimeLease(managed.id)
    let retained = true
    return () => {
      if (!retained) return
      retained = false
      this.releaseAgentRuntimeLease(managed.id)
    }
  }

  async withAgentRuntimeLock<T>(
    managed: ManagedSession,
    work: (getOrCreateAgent: () => Promise<AgentInstance>) => Promise<T>,
    allowClosing = false,
  ): Promise<T> {
    if (!allowClosing) this.assertAgentRuntimeOpen(managed)
    const expectedEpoch = managed.runtimeEpoch ?? 0
    return this.withAgentRuntimeMutex(managed, async () => {
      if (!allowClosing) this.assertAgentRuntimeOpen(managed)
      await this.waitForAgentRuntimeLeases(managed.id)
      if (!allowClosing) this.assertAgentRuntimeOpen(managed)
      if (!allowClosing) {
        const runtimeChanged = this.deps.refreshSessionWorkspace(managed)
          || this.workspaceRuntimeRefreshRequired.has(managed.id)
        if (runtimeChanged && managed.agent) {
          await this.deps.disposeAgentRuntime(managed, 'Project runtime inputs changed')
        }
        this.workspaceRuntimeRefreshRequired.delete(managed.id)
      }
      return work(() => this.getOrCreateValidatedAgentLocked(managed, expectedEpoch))
    })
  }

  /** Resolve Pi while holding the runtime mutex, then recheck Project inputs after async creation. */
  private async getOrCreateValidatedAgentLocked(
    managed: ManagedSession,
    expectedEpoch: number,
  ): Promise<AgentInstance> {
    this.assertAgentRuntimeOpen(managed, expectedEpoch)
    const workspaceChanged = this.deps.refreshSessionWorkspace(managed)
    const workingDirectoryChanged = this.deps.revalidateAgentWorkingDirectory(managed)
    const runtimeChanged = workspaceChanged
      || workingDirectoryChanged
      || this.workspaceRuntimeRefreshRequired.has(managed.id)
    let agent = managed.agent
    if (runtimeChanged && agent) {
      await this.waitForAgentRuntimeLeases(managed.id)
      this.assertAgentRuntimeOpen(managed, expectedEpoch)
      await this.deps.disposeAgentRuntime(managed, 'Project runtime inputs changed')
      agent = null
    }
    if (
      !agent
      || runtimeChanged
      || managed.runtimeCleanupPending
      || managed.credentialRestartRequired
      || (this.agentRuntimeLeaseCounts.get(managed.id) ?? 0) === 0
    ) {
      for (;;) {
        await this.waitForAgentRuntimeLeases(managed.id)
        this.assertAgentRuntimeOpen(managed, expectedEpoch)
        this.workspaceRuntimeRefreshRequired.delete(managed.id)
        agent = await this.deps.getOrCreateAgent(managed)
        this.assertAgentRuntimeOpen(managed, expectedEpoch)

        let changedDuringFactory: boolean
        try {
          const workspaceChangedDuringFactory = this.deps.refreshSessionWorkspace(managed)
          const workingDirectoryChangedDuringFactory = this.deps.revalidateAgentWorkingDirectory(managed)
          changedDuringFactory = workspaceChangedDuringFactory
            || workingDirectoryChangedDuringFactory
            || this.workspaceRuntimeRefreshRequired.has(managed.id)
        } catch (error) {
          if (managed.agent) {
            await this.deps.disposeAgentRuntime(managed, 'Project became unavailable during runtime creation')
          }
          throw error
        }
        if (!changedDuringFactory) break

        await this.waitForAgentRuntimeLeases(managed.id)
        this.assertAgentRuntimeOpen(managed, expectedEpoch)
        if (managed.agent) {
          await this.deps.disposeAgentRuntime(managed, 'Project changed during runtime creation')
        }
        agent = null
      }
    }
    this.workspaceRuntimeRefreshRequired.delete(managed.id)
    return agent
  }

  /**
   * Retain one stable Pi subprocess for a compatible operation. Chat and
   * ephemeral llm_query calls may coexist; refresh, rewind, Source mutation,
   * credential changes, and disposal wait for every retained operation.
   */
  async withAgentRuntimeLease<T>(
    managed: ManagedSession,
    work: (agent: AgentInstance) => Promise<T>,
  ): Promise<T> {
    this.assertAgentRuntimeOpen(managed)
    const expectedEpoch = managed.runtimeEpoch ?? 0
    const agent = await this.withAgentRuntimeMutex(managed, async () => {
      const agent = await this.getOrCreateValidatedAgentLocked(managed, expectedEpoch)
      managed.runtimeLastUsedAt = performance.now()
      this.retainAgentRuntimeLease(managed.id)
      return agent
    })
    try {
      return await work(agent)
    } finally {
      this.releaseAgentRuntimeLease(managed.id)
    }
  }
}
