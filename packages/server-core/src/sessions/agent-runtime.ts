// input: Workspace/connection config, Pi backend SDK, and the Facade callback bundle
// output: AgentRuntime — lazy Pi subprocess creation, runtime refresh, bounded idle residency, credential rotation, confirmed disposal
// pos: Owns every reason an agent runtime is created, refreshed, or torn down

import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { randomUUID } from 'node:crypto'
import {
  PiAgent,
  setPermissionMode,
  hydratePreviousPermissionMode,
  getPermissionModeDiagnostics,
  unregisterSessionScopedToolCallbacks,
  AbortReason,
} from '@craft-agent/shared/agent'
import {
  resolveBackendContext,
  resolvePiAgentConfig,
} from '@craft-agent/shared/agent/backend'
import type {
  ConversationRewindRequest,
  ConversationRewindResult,
  ManagedModelAccess,
} from '@craft-agent/shared/agent/backend/types'
import { getEnable1MContext, getExtendedPromptCache, getMiniModel } from '@craft-agent/shared/config'
import {
  isFreeConversationWorkspaceId,
  loadWorkspaceConfig,
  resolveWorkspaceWorkingDirectory,
} from '@craft-agent/shared/workspaces'
import { getSessionPath as getSessionStoragePath, sessionPersistenceQueue } from '@craft-agent/shared/sessions'
import { loadAllSources, isSourceUsable } from '@craft-agent/shared/sources'
import { perf } from '@craft-agent/shared/utils'
import type { AutomationSystem } from '@craft-agent/shared/automations'
import { McpClientPool } from '../mcp'
import { resizeImageForAPI } from '@craft-agent/server-core/services'
import { buildBackendRuntimeSignature, buildRestartRequiredSignature } from './runtime-config'
import {
  consumePendingSdkFork,
  clearSdkForkFields,
  resolveSupportsBranching,
  resolveManagedConnectionSlug,
  type AgentInstance,
  type ManagedSession,
} from './managed-session'
import { buildServersFromSources } from './source-bridge'
import { isManagedDefaultGatewayConnection } from './managed-gateway-auth-error'
import {
  buildBackendHostRuntimeContext,
  getSessionLog,
  getSessionPlatform,
  getSessionRuntimeHooks,
  getResourceProjectRoot,
  hasPersistedPiTranscript,
} from './session-runtime'
import { wireBrowserPaneTools } from './browser-pane-bridge'
import { wireAgentCallbacks, type WireAgentCallbacksDeps } from './wire-agent-callbacks'

/**
 * Feature flags for agent behavior
 */
export const AGENT_FLAGS = {
  /** Default modes enabled for new sessions */
  defaultModesEnabled: true,
} as const

export interface AgentRuntimeDeps extends WireAgentCallbacksDeps {
  /** True when the session is still present in the Facade registry. */
  isSessionTracked(managed: ManagedSession): boolean
  /** Snapshot of every managed session (connection-scoped fan-out). */
  allSessions(): Iterable<ManagedSession>
  hasActiveOperations(sessionId: string): boolean
  hasPendingInteraction(sessionId: string): boolean
  tryWithIdleRuntimeLock(managed: ManagedSession, work: () => Promise<boolean>): Promise<boolean>
  flushSession(sessionId: string): Promise<void>
  /** Workspace automation system lookup (injected into new agents). */
  getAutomationSystem(workspaceRootPath: string): AutomationSystem | undefined
  /** Exclusive-mutation mutex from AgentRuntimeLease, resolved through the Facade. */
  withAgentRuntimeLock<T>(managed: ManagedSession, work: () => Promise<T>, allowClosing?: boolean): Promise<T>
  /** Send-path refresh hook; resolves through the Facade so per-instance test stubs keep working. */
  tryRefreshAgentRuntimeLocked(managed: ManagedSession, reason: string): Promise<void>
  /** Conversation rewind entry point owned by the Facade rewind machinery. */
  handleConversationRewind(managed: ManagedSession, request: ConversationRewindRequest): Promise<ConversationRewindResult>
}

/** Creates, refreshes, and disposes per-session Pi agent runtimes. */
export class AgentRuntime {
  constructor(private deps: AgentRuntimeDeps) {}

  private idleSweepScheduled = false

  scheduleIdleReclaim(): void {
    if (this.idleSweepScheduled) return
    this.idleSweepScheduled = true
    setImmediate(() => {
      this.idleSweepScheduled = false
      void this.reclaimIdleRuntimes().catch(error => getSessionLog().warn('Idle runtime sweep failed:', error))
    })
  }

  private isIdleCandidate(managed: ManagedSession): boolean {
    return !!managed.agent && managed.agent.isIdle?.() === true
      && this.deps.isSessionTracked(managed) && !managed.runtimeState
      && !managed.runtimeCleanupPending && !managed.isProcessing && !managed.messageQueue.length
      && !managed.rewindCommitInProgress && !managed.isAsyncOperationOngoing
      && !managed.pendingAuthRequest && !managed.pendingAuthRequestId
      && !managed.backgroundShellCommands.size && !managed.activeBackgroundTasks?.size
      && !this.deps.hasActiveOperations(managed.id) && !this.deps.hasPendingInteraction(managed.id)
  }

  private async reclaimIdleRuntimes(): Promise<void> {
    // ponytail: scan the Host registry on operation drain; index only if measured at larger scale.
    const candidates = [...this.deps.allSessions()].filter(managed => this.isIdleCandidate(managed))
      .sort((a, b) => (b.runtimeLastUsedAt ?? 0) - (a.runtimeLastUsedAt ?? 0))
    const idleRuntimeLimit = 3
    await Promise.all(candidates.slice(idleRuntimeLimit).map(async managed => {
      try {
        await this.deps.tryWithIdleRuntimeLock(managed, async () => {
          if (!this.isIdleCandidate(managed)) return false
          await this.deps.flushSession(managed.id)
          if (!this.isIdleCandidate(managed)) return false
          await this.disposeManagedAgentRuntime(managed, 'idle runtime limit')
          getSessionLog().info(`Reclaimed idle Pi runtime for ${managed.id}`)
          return true
        })
      } catch (error) {
        getSessionLog().warn(`Idle runtime cleanup failed for ${managed.id}: ${error instanceof Error ? error.message : error}`)
      }
    }))
  }

  async disposeManagedAgentRuntime(managed: ManagedSession, reason: string): Promise<void> {
    const sessionId = managed.id

    managed.runtimeCleanupPending = true
    try {
      if (managed.agent) {
        if (managed.agent.disposeForRestart) await managed.agent.disposeForRestart()
        else managed.agent.dispose()
      }
      if (managed.mcpPool) await managed.mcpPool.disconnectAll()
    } catch (error) {
      getSessionLog().warn(`Runtime cleanup failed for ${sessionId} during ${reason}: ${error instanceof Error ? error.message : error}`)
      throw error
    }

    managed.runtimeCleanupPending = false
    managed.agent = null
    managed.mcpPool = undefined
    managed.envOverrides = undefined
    managed.agentReady = undefined
    managed.agentReadyResolve = undefined
    managed.backendRuntimeSignature = undefined
    managed.backendRestartSignature = undefined
    managed.managedModelAccessToken = undefined
    managed.credentialRestartRequired = false
    unregisterSessionScopedToolCallbacks(sessionId)
  }

  /**
   * Refresh an existing agent's runtime config in place when the session's
   * resolved connection signature has drifted from what the agent was created
   * with. No-ops when the agent doesn't exist, when the signature still
   * matches, or when the agent is mid-stream (the gate is `agent.isProcessing()`
   * — `managed.isProcessing` is not used because `sendMessage` flips it before
   * calling `getOrCreateAgent`, which would make every send-path refresh dead
   * code).
   *
   * Concurrency: per-session serialization via `agentRuntimeLocks`. A second
   * caller (e.g. `sendMessage` arriving mid-`SAVE`-refresh) awaits the
   * in-flight refresh, then re-evaluates from the post-refresh state — so the
   * subsequent `agent.chat()` is sent only after the subprocess has applied
   * the runtime update (or the agent has been disposed for recreation).
   *
   * The helper distinguishes two kinds of drift:
   *   - Restart-required (provider/auth/slug/piAuthProvider): goes straight
   *     to dispose + recreate because `update_runtime_config` cannot fully
   *     re-route credential/provider state in a live subprocess.
   *   - In-place safe (model/baseUrl/customEndpoint/customModels): attempts
   *     `agent.updateRuntimeConfig` and falls back to dispose if the backend
   *     can't apply the update.
   */
  async tryRefreshAgentRuntime(managed: ManagedSession, reason: string): Promise<void> {
    await this.deps.withAgentRuntimeLock(managed, () => this.deps.tryRefreshAgentRuntimeLocked(managed, reason))
  }

  async tryRefreshAgentRuntimeLocked(managed: ManagedSession, reason: string): Promise<void> {
    if (!managed.agent) return

    const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath)
    const backendContext = resolveBackendContext({
      sessionConnectionSlug: managed.llmConnection,
      workspaceDefaultConnectionSlug: workspaceConfig?.defaults?.defaultLlmConnection,
      managedModel: managed.model,
    })
    const connection = backendContext.connection
    const sigInput = {
      connection,
      authType: backendContext.authType,
      resolvedModel: backendContext.resolvedModel,
      enable1MContext: getEnable1MContext(),
      extendedPromptCache: getExtendedPromptCache(),
    }
    const runtimeSignature = buildBackendRuntimeSignature(sigInput)
    const restartSignature = buildRestartRequiredSignature(sigInput)

    if (!managed.backendRuntimeSignature || !managed.backendRestartSignature) {
      managed.backendRuntimeSignature = runtimeSignature
      managed.backendRestartSignature = restartSignature
      return
    }

    const restartRequired = managed.backendRestartSignature !== restartSignature
    const runtimeChanged = managed.backendRuntimeSignature !== runtimeSignature

    if (!restartRequired && !runtimeChanged) return

    if (managed.agent.isProcessing()) {
      getSessionLog().info(`Runtime config changed for ${managed.id}; deferring refresh until session is idle (${reason})`)
      return
    }

    await this.runAgentRuntimeRefresh(
      managed,
      backendContext,
      runtimeSignature,
      restartSignature,
      restartRequired,
      reason,
    )
  }

  async runAgentRuntimeRefresh(
    managed: ManagedSession,
    backendContext: ReturnType<typeof resolveBackendContext>,
    runtimeSignature: string,
    restartSignature: string,
    restartRequired: boolean,
    reason: string,
  ): Promise<void> {
    if (restartRequired) {
      getSessionLog().info(`Restart-required field changed for session ${managed.id}; recreating backend runtime (${reason})`)
      await this.disposeManagedAgentRuntime(managed, 'restart-required runtime change')
      return
    }

    const connection = backendContext.connection
    let refreshed = false
    if (managed.agent?.updateRuntimeConfig) {
      try {
        refreshed = await managed.agent.updateRuntimeConfig({
          model: backendContext.resolvedModel,
          providerType: connection?.providerType,
          authType: backendContext.authType,
          runtime: connection ? {
            baseUrl: connection.baseUrl,
            piAuthProvider: connection.piAuthProvider,
            customEndpoint: connection.customEndpoint,
            customModels: connection.models?.map(model => {
              if (typeof model === 'string') return model
              const supportsImages = typeof model.supportsImages === 'boolean' ? model.supportsImages : undefined
              const supportsThinking = typeof model.supportsThinking === 'boolean' ? model.supportsThinking : undefined
              const thinkingLevelMap = model.thinkingLevelMap
              if (
                model.contextWindow
                || supportsImages !== undefined
                || supportsThinking !== undefined
                || thinkingLevelMap !== undefined
              ) {
                return {
                  id: model.id,
                  ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
                  ...(supportsImages !== undefined ? { supportsImages } : {}),
                  ...(supportsThinking !== undefined ? { supportsThinking } : {}),
                  ...(thinkingLevelMap !== undefined ? { thinkingLevelMap } : {}),
                }
              }
              return model.id
            }),
          } : undefined,
        })
      } catch (error) {
        getSessionLog().warn(`Runtime config in-place refresh failed for ${managed.id}: ${error instanceof Error ? error.message : error}`)
      }
    }

    if (refreshed) {
      managed.backendRuntimeSignature = runtimeSignature
      managed.backendRestartSignature = restartSignature
      getSessionLog().info(`Refreshed runtime config for session ${managed.id} (${reason})`)
    } else {
      getSessionLog().info(`Recreating backend runtime for session ${managed.id} after config change (${reason})`)
      await this.disposeManagedAgentRuntime(managed, 'runtime config refresh')
    }
  }

  /**
   * Push a connection's runtime updates (e.g. `supportsImages` toggle) to every
   * active session that uses it. Called from the `llmConnections.SAVE` handler
   * so capability changes reach live Pi subprocesses immediately instead of
   * waiting for the next send to lazily notice the signature drift.
   */
  async refreshConnectionRuntime(connectionSlug: string): Promise<void> {
    for (const managed of this.deps.allSessions()) {
      if (managed.llmConnection !== connectionSlug) continue
      try {
        await this.tryRefreshAgentRuntime(managed, 'connection update')
      } catch (error) {
        getSessionLog().warn(`refreshConnectionRuntime failed for ${managed.id}: ${error instanceof Error ? error.message : error}`)
      }
    }
  }

  /**
   * Push a rotated credential into every live backend using this connection.
   * Pi supports this in-place through its existing `token_update` protocol.
   */
  async reloadConnectionCredentials(
    connectionSlug: string,
    managedModelAccess?: ManagedModelAccess,
  ): Promise<void> {
    for (const managed of this.deps.allSessions()) {
      if (managed.llmConnection !== connectionSlug) continue
      try {
        await this.deps.withAgentRuntimeLock(managed, async () => {
          if (!managed.agent) return
          const reloaded = await managed.agent.reloadCredentials?.(managedModelAccess) ?? false
          if (!reloaded) {
            if (managed.agent.isProcessing()) managed.credentialRestartRequired = true
            else await this.disposeManagedAgentRuntime(managed, 'credential reload')
          } else if (managedModelAccess) {
            managed.managedModelAccessToken = managedModelAccess.token
          }
        })
      } catch (error) {
        getSessionLog().warn(`reloadConnectionCredentials failed for ${managed.id}: ${error instanceof Error ? error.message : error}`)
        try {
          await this.deps.withAgentRuntimeLock(managed, async () => {
            if (managed.agent?.isProcessing()) managed.credentialRestartRequired = true
            else await this.disposeManagedAgentRuntime(managed, 'failed credential reload')
          })
        } catch (recoveryError) {
          getSessionLog().warn(`credential reload recovery skipped for ${managed.id}: ${recoveryError instanceof Error ? recoveryError.message : recoveryError}`)
        }
      }
    }
  }

  /** Revoke all live runtimes that still hold credentials for this connection. */
  async disposeConnectionRuntimes(connectionSlug: string): Promise<void> {
    const targets = [...this.deps.allSessions()]
      .filter(managed => managed.llmConnection === connectionSlug && !managed.runtimeState)
      .map(managed => {
        const invalidationEpoch = (managed.runtimeEpoch ?? 0) + 1
        managed.runtimeEpoch = invalidationEpoch
        managed.runtimeState = 'invalidating'
        if (managed.agent && (managed.isProcessing || managed.agent.isProcessing())) {
          managed.agent.forceAbort?.(AbortReason.UserStop)
        }
        return { managed, invalidationEpoch }
      })

    const results = await Promise.allSettled(targets.map(async ({ managed, invalidationEpoch }) => {
      try {
        await this.deps.withAgentRuntimeLock(
          managed,
          () => this.disposeManagedAgentRuntime(managed, 'connection sign-out'),
          true,
        )
      } finally {
        if (
          this.deps.isSessionTracked(managed)
          && managed.runtimeEpoch === invalidationEpoch
          && managed.runtimeState === 'invalidating'
        ) managed.runtimeState = undefined
      }
    }))
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Connection runtime cleanup failed')

  }
  async ensureManagedCredentialForSessionLocked(
    managed: ManagedSession,
    forceRefresh = false,
  ): Promise<ManagedModelAccess | undefined> {
    return this.resolveManagedModelAccess(managed, forceRefresh)
  }

  /** Resolve managed access without returning or mutating a live runtime. */
  async resolveManagedModelAccess(
    managed: ManagedSession,
    forceRefresh = false,
  ): Promise<ManagedModelAccess | undefined> {
    const connectionSlug = resolveManagedConnectionSlug(managed)
    if (!isManagedDefaultGatewayConnection(connectionSlug)) return undefined

    const modelAccess = await getSessionRuntimeHooks().ensureManagedModelAccessToken(forceRefresh)
    return { token: modelAccess.token }
  }

  /** Renew a rejected capability without mutating the runtime that reported it. */
  async refreshManagedCredentialForNextTurn(managed: ManagedSession): Promise<void> {
    try {
      await this.ensureManagedCredentialForSessionLocked(managed, true)
    } catch (error) {
      getSessionLog().warn(`[managed-access] Credential refresh failed for ${managed.id}: ${error instanceof Error ? error.message : error}`)
    }
  }

  /**
   * Get or create agent for a session (lazy loading)
   * Creates the appropriate backend agent based on LLM connection.
   *
   * Provider resolution order:
   * 1. session.llmConnection (locked after first message)
   * 2. workspace.defaults.defaultLlmConnection
   * 3. global defaultLlmConnection
  * 4. fallback: no connection configured
  */
  async getOrCreateAgentLocked(managed: ManagedSession): Promise<AgentInstance> {
    if (managed.runtimeCleanupPending) await this.disposeManagedAgentRuntime(managed, 'retry unfinished cleanup')
    if (!isFreeConversationWorkspaceId(managed.workspace.id)) {
      managed.workingDirectory = resolveWorkspaceWorkingDirectory(
        managed.workspace,
        managed.workingDirectory,
      )
    }
    if (managed.credentialRestartRequired && managed.agent && !managed.agent.isProcessing()) {
      await this.disposeManagedAgentRuntime(managed, 'deferred credential reload')
    }

    // Refresh runtime config in-place when the connection has drifted since
    // the agent was created. May null out `managed.agent` if the in-place
    // refresh fails, in which case the create branch below rebuilds it.
    await this.deps.tryRefreshAgentRuntimeLocked(managed, 'send-path refresh')

    const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath)
    const backendContext = resolveBackendContext({
      sessionConnectionSlug: managed.llmConnection,
      workspaceDefaultConnectionSlug: workspaceConfig?.defaults?.defaultLlmConnection,
      managedModel: managed.model,
    })
    const connection = backendContext.connection
    const sigInput = {
      connection,
      authType: backendContext.authType,
      resolvedModel: backendContext.resolvedModel,
      enable1MContext: getEnable1MContext(),
      extendedPromptCache: getExtendedPromptCache(),
    }
    const runtimeSignature = buildBackendRuntimeSignature(sigInput)
    const restartSignature = buildRestartRequiredSignature(sigInput)
    const managedModelAccess = await this.ensureManagedCredentialForSessionLocked(managed)

    if (
      managed.agent
      && managedModelAccess
      && managed.managedModelAccessToken !== managedModelAccess.token
    ) {
      let reloaded = false
      try {
        reloaded = await managed.agent.reloadCredentials?.(managedModelAccess) ?? false
      } catch (error) {
        getSessionLog().warn(`[managed-access] Credential preflight failed for ${managed.id}: ${error instanceof Error ? error.message : error}`)
      }
      if (reloaded) {
        managed.managedModelAccessToken = managedModelAccess.token
      } else {
        await this.disposeManagedAgentRuntime(managed, 'managed credential preflight')
      }
    }

    if (!managed.agent) {
      const end = perf.start('agent.create', { sessionId: managed.id })

      // The agent spawns subprocesses that resolve tools from PATH, so this is
      // where the host's shell-environment discovery must have landed.
      await getSessionRuntimeHooks().whenSubprocessEnvReady()

      // Lock the connection after first resolution
      // This ensures the session always uses the same provider
      if (connection && !managed.connectionLocked) {
        managed.llmConnection = connection.slug
        managed.connectionLocked = true
        getSessionLog().info(`Locked session ${managed.id} to connection "${connection.slug}"`)
        this.deps.persistSession(managed)

        // Keep renderer session capabilities in sync when auto-locking the connection.
        this.deps.sendEvent({
          type: 'connection_changed',
          sessionId: managed.id,
          connectionSlug: connection.slug,
          supportsBranching: resolveSupportsBranching(managed),
        }, managed.workspace.id)
      }

      if (connection) {
        getSessionLog().info(`Using LLM connection "${connection.slug}" (${connection.providerType}) for session ${managed.id}`)
      } else {
        getSessionLog().warn(`No LLM connection found for session ${managed.id}, using default anthropic provider`)
      }

      // Set up agentReady promise so title generation can await agent creation
      managed.agentReady = new Promise<void>(r => { managed.agentReadyResolve = r })

      // ============================================================
      // Common setup: sources, MCP pool, session config
      // ============================================================

      const sessionPath = getSessionStoragePath(managed.workspace.rootPath, managed.id)
      const hasPiTranscript = hasPersistedPiTranscript(sessionPath)
      const needsRuntimeMigration = !hasPiTranscript && managed.needsPiMigrationSeed
      if (hasPiTranscript) managed.needsPiMigrationSeed = false
      let seedFreshSessionFromRecovery = false

      if (needsRuntimeMigration) {
        // Legacy and Pi session IDs/transcripts are not interchangeable.
        // Retire only the stale runtime pointers; persisted Storyflow messages
        // remain the source for a one-shot seeded Pi start.
        managed.sdkSessionId = undefined
        managed.branchFromSdkSessionId = undefined
        managed.branchFromSessionPath = undefined
        managed.branchFromSdkCwd = undefined
        managed.branchFromSdkTurnId = undefined

        if (managed.branchFromMessageId) {
          managed.branchContextStrategy = 'seeded-fresh-session'
          managed.branchSeedApplied = false
        } else {
          seedFreshSessionFromRecovery = true
        }
        this.deps.persistSession(managed)
        getSessionLog().info(`Migrating session ${managed.id} to a fresh Pi transcript with persisted context`)
      }

      const enabledSlugs = managed.enabledSourceSlugs || []
      const allSources = loadAllSources(
        getResourceProjectRoot(managed.workspace),
        managed.workspace.id,
      )
      const enabledSources = allSources.filter(s =>
        enabledSlugs.includes(s.config.slug) && isSourceUsable(s)
      )

      // Build server configs for enabled sources
      const { mcpServers, apiServers, resolvedSources } = await buildServersFromSources(
        enabledSources,
        sessionPath,
        managed.tokenRefreshManager,
        undefined,
        managed.workspace,
      )

      // Create centralized MCP client pool (all backends use it)
      managed.mcpPool = new McpClientPool({
        debug: (msg) => getSessionLog().debug(msg),
        sessionPath,
      })

      // Per-session env overrides
      const miniModel = connection ? (getMiniModel(connection) ?? connection.defaultModel) : undefined
      const envOverrides: Record<string, string> = {
        CRAFT_WORKSPACE_PATH: managed.workspace.rootPath,
        // Pass mini model to SDK subprocess so built-in tools like WebFetch
        // use the correct model for summarization (instead of hardcoded Haiku)
        ...(miniModel ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: miniModel } : {}),
      }
      managed.envOverrides = envOverrides

      // ============================================================
      // Common session + callback config (identical for all backends)
      // ============================================================

      const sessionConfig = {
        id: managed.id,
        workspaceRootPath: managed.workspace.rootPath,
        sdkSessionId: managed.sdkSessionId,
        branchFromSdkSessionId: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSdkSessionId : undefined,
        branchFromSessionPath: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSessionPath : undefined,
        branchFromSdkCwd: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSdkCwd : undefined,
        branchFromSdkTurnId: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSdkTurnId : undefined,
        branchFromMessageId: managed.branchFromMessageId,
        createdAt: managed.lastMessageAt,
        lastUsedAt: managed.lastMessageAt,
        workingDirectory: managed.workingDirectory,
        sdkCwd: managed.sdkCwd,
        model: managed.model,
        llmConnection: managed.llmConnection,
        permissionMode: managed.permissionMode,
        previousPermissionMode: managed.previousPermissionMode,
      }

      const onSdkSessionIdUpdate = (sdkSessionId: string) => {
        managed.sdkSessionId = sdkSessionId
        managed.needsPiMigrationSeed = false
        // Retire branch-only fork metadata now that child session is established
        const parentSdkSessionId = managed.branchFromSdkSessionId
        if (consumePendingSdkFork(managed)) {
          getSessionLog().info(`Branch fork established for ${managed.id}: child=${sdkSessionId}, retiring parent fork metadata (parent=${parentSdkSessionId ?? 'unknown'})`)
        } else {
          getSessionLog().info(`SDK session ID captured for ${managed.id}: ${sdkSessionId}`)
        }
        this.deps.persistSession(managed)
        sessionPersistenceQueue.flush(managed.id)
      }

      const onSdkSessionIdCleared = () => {
        managed.sdkSessionId = undefined
        getSessionLog().info(`SDK session ID cleared for ${managed.id} (resume recovery)`)
        this.deps.persistSession(managed)
        sessionPersistenceQueue.flush(managed.id)
      }

      const onBranchForkInvalidated = () => {
        managed.sdkSessionId = undefined
        clearSdkForkFields(managed)
        getSessionLog().info(`Branch fork invalidated for ${managed.id}: cleared all fork metadata`)
        this.deps.persistSession(managed)
        sessionPersistenceQueue.flush(managed.id)
      }

      const getRecoveryMessages = () => {
        let relevantMessages = managed.messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .filter(m => !m.isIntermediate)
          .slice(-6)
        // The current user message has already been persisted before lazy agent
        // creation; exclude it from the migration context because chatImpl sends
        // it separately as the active prompt.
        if (seedFreshSessionFromRecovery && relevantMessages.at(-1)?.role === 'user') {
          relevantMessages = relevantMessages.slice(0, -1)
        }
        return relevantMessages.map(m => ({
          type: m.role as 'user' | 'assistant',
          content: m.content,
        }))
      }

      const getBranchFallbackMessages = () => {
        if (!managed.branchFromMessageId) return []
        return managed.messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .filter(m => !m.isIntermediate)
          .map(m => ({
            type: m.role as 'user' | 'assistant',
            content: m.content,
          }))
      }

      const getBranchSeedMessages = () => {
        if (managed.branchContextStrategy !== 'seeded-fresh-session') return []
        if (managed.branchSeedApplied) return []

        const seedMessages = managed.messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .filter(m => !m.isIntermediate)

        return seedMessages.map(m => ({
          type: m.role as 'user' | 'assistant',
          content: m.content,
        }))
      }

      const markBranchSeedApplied = () => {
        if (managed.branchContextStrategy !== 'seeded-fresh-session') return
        if (managed.branchSeedApplied) return
        managed.branchSeedApplied = true
        getSessionLog().info('Branch seed context applied', {
          sessionId: managed.id,
          strategy: managed.branchContextStrategy,
        })
      }

      const getTransferredSessionSummary = () => {
        const summary = managed.transferredSessionSummaryApplied ? null : (managed.transferredSessionSummary ?? null)
        getSessionLog().info(`[transfer-context] getTransferredSessionSummary for ${managed.id}: applied=${managed.transferredSessionSummaryApplied}, has_summary=${!!managed.transferredSessionSummary}, returning=${summary ? `${summary.length} chars` : 'null'}`)
        return summary
      }

      const markTransferredSessionSummaryApplied = () => {
        if (managed.transferredSessionSummaryApplied || !managed.transferredSessionSummary) return
        managed.transferredSessionSummaryApplied = true
        this.deps.persistSession(managed)
        getSessionLog().info('Transferred session summary applied', {
          sessionId: managed.id,
        })
      }

      managed.agent = new PiAgent(resolvePiAgentConfig({
        context: backendContext,
        hostRuntime: buildBackendHostRuntimeContext(),
        coreConfig: {
          workspace: managed.workspace,
          projectRoot: getResourceProjectRoot(managed.workspace),
          validateWorkingDirectory: path => {
            if (isFreeConversationWorkspaceId(managed.workspace.id)) return path
            const resolved = resolveWorkspaceWorkingDirectory(managed.workspace, path)
            managed.workingDirectory = resolved
            return resolved
          },
          miniModel,
          thinkingLevel: managed.thinkingLevel,
          managedModelAccess,
          session: sessionConfig,
          onSdkSessionIdUpdate,
          onSdkSessionIdCleared,
          onBranchForkInvalidated,
          onConversationRewind: request => this.deps.handleConversationRewind(managed, request),
          onCredentialRotated: async () => {
            // Pi already owns the rotated credential for this turn. Queue the
            // cross-session reload after this runtime lease is released.
            void this.reloadConnectionCredentials(
              managed.llmConnection || connection?.slug || 'pi',
            ).catch(error => {
              getSessionLog().warn(`Failed to propagate rotated credential: ${error instanceof Error ? error.message : error}`)
            })
          },
          getRecoveryMessages,
          seedFreshSessionFromRecovery,
          getBranchFallbackMessages,
          getBranchSeedMessages,
          markBranchSeedApplied,
          getTransferredSessionSummary,
          markTransferredSessionSummaryApplied,
          mcpPool: managed.mcpPool,
          envOverrides,
          isHeadless: !AGENT_FLAGS.defaultModesEnabled,
          automationSystem: this.deps.getAutomationSystem(managed.workspace.rootPath),
          systemPromptPreset: managed.systemPromptPreset,
          debugMode: getSessionPlatform()?.isDebugMode ? { enabled: true, logFilePath: getSessionPlatform()?.getLogFilePath?.() } : undefined,
          enable1MContext: getEnable1MContext(),
          // Image resize callback — prevents oversized images from entering conversation history
          onImageResize: async (filePath: string, maxSizeBytes: number): Promise<string | null> => {
            try {
              const buffer = await readFile(filePath)
              const result = await resizeImageForAPI(buffer, { maxSizeBytes })
              if (!result) return null

              // Write to session tmp directory (cleaned up with session)
              const sessionTmpDir = join(sessionPath, 'tmp')
              await mkdir(sessionTmpDir, { recursive: true })
              const ext = result.format === 'jpeg' ? 'jpg' : 'png'
              const outPath = join(sessionTmpDir, `resized-${randomUUID()}.${ext}`)
              await writeFile(outPath, result.buffer)

              getSessionLog().info(`Image resized for Read: ${(buffer.length / 1024 / 1024).toFixed(1)}MB → ${(result.buffer.length / 1024 / 1024).toFixed(1)}MB (→ ${result.width}×${result.height})`)
              return outPath
            } catch (err) {
              getSessionLog().error('Image resize failed:', err)
              return null
            }
          },
          // Source configs for postInit() — backends set up their own runtime state
          initialSources: {
            enabledSources: resolvedSources,
            mcpServers,
            apiServers,
            enabledSlugs: resolvedSources.map(source => source.config.slug),
          },
        },
      }))

      getSessionLog().info(`Created Pi agent for session ${managed.id} (model: ${backendContext.resolvedModel})${managed.sdkSessionId ? ' (resuming)' : ''}`)

      // ============================================================
      // Post-construction: debug callback, auth callback, postInit()
      // ============================================================

      managed.agent.onDebug = (msg: string) => {
        const marker = '__PERMISSION_BLOCK__'
        if (msg.includes(marker)) {
          const idx = msg.indexOf(marker)
          const payloadRaw = msg.slice(idx + marker.length)
          try {
            const payload = JSON.parse(payloadRaw) as {
              sessionId: string
              toolName: string
              effectiveMode: string
              modeVersion: number
              changedBy: string
              changedAt: string
              reason: string
            }
            getSessionLog().info('Tool blocked by permission mode', payload)
            return
          } catch {
            // fall through to plain logging when payload parsing fails
          }
        }

        getSessionLog().info(msg)
      }

      // Unified auth callback — replaces per-backend onChatGptAuthRequired/onGithubAuthRequired
      managed.agent.onBackendAuthRequired = (reason: string) => {
        getSessionLog().warn(`Backend auth required for session ${managed.id}: ${reason}`)
        this.deps.sendEvent({
          type: 'info',
          sessionId: managed.id,
          message: `Authentication required: ${reason}`,
          level: 'error',
        }, managed.workspace.id)
      }

      // Run post-init (auth injection) — each backend handles its own
      const postInitResult = await managed.agent.postInit()
      managed.managedModelAccessToken = managedModelAccess?.token
      if (postInitResult.authWarning) {
        getSessionLog().warn(`Auth warning for session ${managed.id}: ${postInitResult.authWarning}`)
        this.deps.sendEvent({
          type: 'info',
          sessionId: managed.id,
          message: postInitResult.authWarning,
          level: postInitResult.authWarningLevel || 'error',
        }, managed.workspace.id)
      }

      // Wire up large response handling in the MCP pool (all backends)
      if (managed.mcpPool && managed.agent) {
        managed.mcpPool.setSummarizeCallback(managed.agent.getSummarizeCallback())
      }

      // Wire up browser pane tools — merge BrowserPaneFns into session callbacks
      // so browser_* tools can delegate to BrowserPaneManager. (Extracted verbatim
      // into browser-pane-bridge.ts.)
      wireBrowserPaneTools(this.deps.getBrowserPaneManager(), managed)

      // Signal that the agent instance is ready (unblocks title generation)
      managed.agentReadyResolve?.()

      // Wire product callbacks (permission/auth/plan/spawn/self-management/
      // source activation). Extracted verbatim into wire-agent-callbacks.ts.
      managed.agent.onNativeTurnSettled = () => this.scheduleIdleReclaim()
      wireAgentCallbacks(managed.agent, managed, this.deps)

      // NOTE: Source reloading is now handled by ConfigWatcher callbacks
      // which detect filesystem changes and update all affected sessions.
      // See setupConfigWatcher() for the full reload logic.

      // Apply session-scoped permission mode to the newly created agent
      // This ensures the UI toggle state is reflected in the agent before first message
      if (managed.permissionMode) {
        setPermissionMode(managed.id, managed.permissionMode, { changedBy: 'restore' })
        if (managed.previousPermissionMode) {
          hydratePreviousPermissionMode(managed.id, managed.previousPermissionMode)
        }
        managed.agent!.setPermissionMode(managed.permissionMode)
        const diagnostics = getPermissionModeDiagnostics(managed.id)
        getSessionLog().info('Applied permission mode to agent', {
          sessionId: managed.id,
          permissionMode: managed.permissionMode,
          modeVersion: diagnostics.modeVersion,
          changedBy: diagnostics.lastChangedBy,
          changedAt: diagnostics.lastChangedAt,
        })
      }
      managed.backendRuntimeSignature = runtimeSignature
      managed.backendRestartSignature = restartSignature
      end()
    }
    return managed.agent
  }
}
