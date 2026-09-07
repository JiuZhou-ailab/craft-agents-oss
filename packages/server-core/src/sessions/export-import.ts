// input: Session registry access, createSession/ensureMessagesLoaded/model-access callbacks, bundle persistence API
// output: SessionBundle export/import, remote transfer payload export/import, and compatible-connection resolution
// pos: Transfer subdomain under the SessionManager facade; createSession and message hydration stay in the Facade via injected callbacks

import type { SessionEvent, RemoteSessionTransferPayload } from '@craft-agent/shared/protocol'
import { existsSync } from 'node:fs'
import {
  setPermissionMode,
  hydratePreviousPermissionMode,
  PiAgent,
  generateConversationSummary,
} from '@craft-agent/shared/agent'
import {
  resolveBackendContext,
  resolveSessionConnection,
  resolvePiAgentConfig,
} from '@craft-agent/shared/agent/backend'
import type { ManagedModelAccess } from '@craft-agent/shared/agent/backend/types'
import {
  getLlmConnection,
  getLlmConnections,
  getMiniModel,
  getWorkspaceById,
  getWorkspaces,
} from '@craft-agent/shared/config'
import { getDefaultSummarizationModel } from '@craft-agent/shared/config/models'
import {
  serializeSession,
  validateBundle,
  ensureSessionDir,
  getSessionFilePath,
  getSessionPath as getSessionStoragePath,
  generateSessionId,
  writeSessionJsonl,
  sessionPersistenceQueue,
  type SessionBundle,
  type DispatchMode,
  type StoredSession,
} from '@craft-agent/shared/sessions'
import { loadWorkspaceSources } from '@craft-agent/shared/sources'
import {
  isFreeConversationWorkspaceId,
  isWorkspaceRootAvailable,
  loadWorkspaceConfig,
  resolveRuntimeWorkspaceById,
  resolveWorkspaceWorkingDirectory,
} from '@craft-agent/shared/workspaces'
import type { Workspace } from '@craft-agent/shared/config'
import { restoreFiles } from '@craft-agent/shared/utils/bundle-files'
import { storedToMessage } from '@craft-agent/core/types'
import {
  capPermissionMode,
  createManagedSession,
  DEFAULT_TOKEN_USAGE,
  filterRestoredSourceSlugs,
  type ManagedSession,
} from './managed-session'
import { resetPortableForkRuntime } from './runtime-config'
import { buildBackendHostRuntimeContext, getSessionLog } from './session-runtime'

export interface InitialAutomationMetadata {
  permissionMode?: import('@craft-agent/shared/agent').PermissionMode
  labels?: string[]
  isFlagged?: boolean
  sessionStatus?: import('@craft-agent/shared/sessions').SessionStatus
  sessionName?: string
}

export interface ExportImportDeps {
  /** Registry lookups/mutations over the shared sessions map. */
  getSession: (sessionId: string) => ManagedSession | undefined
  hasSession: (sessionId: string) => boolean
  setSession: (sessionId: string, managed: ManagedSession) => void
  createSessionLocked: (workspaceId: string) => Promise<{ id: string }>
  ensureMessagesLoaded: (managed: ManagedSession) => Promise<void>
  resolveManagedModelAccess: (managed: ManagedSession) => Promise<ManagedModelAccess | undefined>
  persistSession: (managed: ManagedSession) => void
  sendEvent: (event: SessionEvent, workspaceId?: string) => void
  setInitialAutomationMetadata: (workspaceRootPath: string, sessionId: string, metadata: InitialAutomationMetadata) => void
}

export class ExportImport {
  constructor(private deps: ExportImportDeps) {}

  private async generateRemoteTransferSummary(managed: ManagedSession): Promise<string | null> {
    await this.deps.ensureMessagesLoaded(managed)

    const messages = managed.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .filter(m => !m.isIntermediate)
      .map(m => ({
        type: m.role as 'user' | 'assistant',
        content: m.content,
      }))

    if (messages.length === 0) return null
    const managedModelAccess = await this.deps.resolveManagedModelAccess(managed)

    const workspace = resolveRuntimeWorkspaceById(managed.workspace.id)
    if (!workspace) throw new Error(`Project ${managed.workspace.id} is unavailable`)
    const workspaceRootPath = workspace.rootPath
    const wsConfig = loadWorkspaceConfig(workspaceRootPath)
    const defaultModel = wsConfig?.defaults?.model
    const backendContext = resolveBackendContext({
      sessionConnectionSlug: managed.llmConnection,
      workspaceDefaultConnectionSlug: wsConfig?.defaults?.defaultLlmConnection,
      managedModel: managed.model || defaultModel,
    })

    const miniModel = backendContext.connection
      ? (getMiniModel(backendContext.connection) ?? backendContext.connection.defaultModel ?? getDefaultSummarizationModel())
      : getDefaultSummarizationModel()

    const envOverrides: Record<string, string> = {
      CRAFT_WORKSPACE_PATH: workspaceRootPath,
      ...(miniModel ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: miniModel } : {}),
    }

    const agent = new PiAgent(resolvePiAgentConfig({
      context: backendContext,
      hostRuntime: buildBackendHostRuntimeContext(),
      coreConfig: {
        workspace,
        session: {
          id: `${managed.id}-remote-transfer-summary`,
          workspaceRootPath,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          workingDirectory: workspaceRootPath,
          sdkCwd: undefined,
          model: managed.model,
          llmConnection: managed.llmConnection,
          permissionMode: managed.permissionMode,
          previousPermissionMode: managed.previousPermissionMode,
        },
        miniModel,
        managedModelAccess,
        envOverrides,
        isHeadless: true,
      },
      providerOptions: { piAuthProvider: backendContext.connection?.piAuthProvider },
    }))

    try {
      return await generateConversationSummary(messages, agent.runMiniCompletion.bind(agent))
    } finally {
      agent.destroy()
    }
  }

  async exportRemoteSessionTransfer(sessionId: string, workspaceId: string): Promise<RemoteSessionTransferPayload | null> {
    const managed = this.deps.getSession(sessionId)
    if (!managed) {
      getSessionLog().warn(`[dispatch] Cannot export remote transfer: ${sessionId} not found`)
      return null
    }

    if (managed.workspace.id !== workspaceId) {
      getSessionLog().warn(`[dispatch] Session ${sessionId} does not belong to workspace ${workspaceId}`)
      return null
    }

    if (managed.isProcessing) {
      getSessionLog().warn(`[dispatch] Cannot export remote transfer ${sessionId}: still processing`)
      return null
    }

    this.deps.persistSession(managed)
    await sessionPersistenceQueue.flush(sessionId)

    const summary = await this.generateRemoteTransferSummary(managed)
    if (!summary) {
      getSessionLog().warn(`[dispatch] Failed to generate remote transfer summary for ${sessionId}`)
      return null
    }

    return { summary }
  }

  async importRemoteSessionTransfer(
    workspaceId: string,
    payload: RemoteSessionTransferPayload,
  ): Promise<{ sessionId: string }> {
    if (!payload || typeof payload !== 'object' || typeof payload.summary !== 'string' || !payload.summary.trim()) {
      throw new Error('Invalid remote session transfer payload')
    }

    // The target session starts with target-domain defaults. Operational state
    // such as permission mode, labels, and status must never cross domains.
    const session = await this.deps.createSessionLocked(workspaceId)

    const managed = this.deps.getSession(session.id)
    if (!managed) {
      throw new Error(`Transferred session ${session.id} was not created`)
    }

    managed.transferredSessionSummary = payload.summary.trim()
    managed.transferredSessionSummaryApplied = false
    this.deps.persistSession(managed)
    await sessionPersistenceQueue.flush(session.id)

    return { sessionId: session.id }
  }

  /**
   * Export a session as a portable SessionBundle.
   *
   * Steps:
   * 1. Validate session exists and resolve its workspace
   * 2. If session is processing, refuse (caller must stop it first)
   * 3. Flush pending persistence writes
   * 4. Serialize session directory into a bundle
   */
  async exportSession(sessionId: string, workspaceId: string): Promise<SessionBundle | null> {
    const managed = this.deps.getSession(sessionId)
    if (!managed) {
      getSessionLog().warn(`[dispatch] Cannot export session: ${sessionId} not found`)
      return null
    }

    if (managed.workspace.id !== workspaceId) {
      getSessionLog().warn(`[dispatch] Session ${sessionId} does not belong to workspace ${workspaceId}`)
      return null
    }

    if (managed.isProcessing) {
      getSessionLog().warn(`[dispatch] Cannot export session ${sessionId}: still processing`)
      return null
    }

    // Flush pending writes to ensure JSONL is up to date
    this.deps.persistSession(managed)
    await sessionPersistenceQueue.flush(sessionId)

    const bundle = serializeSession(managed.workspace.rootPath, sessionId)
    if (!bundle) {
      getSessionLog().error(`[dispatch] Failed to serialize session ${sessionId}`)
      return null
    }

    return bundle
  }

  /**
   * Import a session bundle into a target workspace.
   *
   * Steps:
   * 1. Validate bundle structure and target workspace
   * 2. Generate new session ID (fork) or use original (move)
   * 3. Create session directory and write JSONL + files
   * 4. Register session in-memory
   * 5. Emit session_created event
   * 6. Return new session ID and compatibility warnings
   */
  async importSession(
    workspaceId: string,
    bundle: SessionBundle,
    mode: DispatchMode,
  ): Promise<{ sessionId: string; warnings?: string[] }> {
    getSessionLog().info(`[import] Starting import: workspaceId=${workspaceId}, mode=${mode}, bundleSessionId=${bundle?.session?.header?.id ?? 'unknown'}, files=${bundle?.files?.length ?? 0}`)

    if (!validateBundle(bundle)) {
      throw new Error('Invalid session bundle')
    }

    const workspace = getWorkspaceById(workspaceId)
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`)
    }

    getSessionLog().info(`[import] Target workspace: "${workspace.name}" at ${workspace.rootPath}`)

    const warnings: string[] = []
    const workspaceRootPath = workspace.rootPath

    // Determine session ID
    let sessionId = mode === 'move'
      ? bundle.session.header.id
      : generateSessionId(workspaceRootPath)

    // Check for ID collision on move
    if (
      mode === 'move'
      && (
        this.deps.hasSession(sessionId)
        || existsSync(getSessionStoragePath(workspaceRootPath, sessionId))
      )
    ) {
      throw new Error(`Session ${sessionId} already exists in target workspace`)
    }

    if (mode === 'move') {
      const sourceIdIsHostUnique = getWorkspaces().every(candidate => (
        candidate.id === workspace.id
        || candidate.remoteServer
        || (
          isWorkspaceRootAvailable(candidate)
          && !existsSync(getSessionStoragePath(candidate.rootPath, sessionId))
        )
      ))
      if (!sourceIdIsHostUnique) {
        sessionId = generateSessionId(workspaceRootPath)
        warnings.push('Session ID was remapped because the source ID could not be proven unique on this Host.')
      }
    }

    // Build the stored session from bundle data
    const header = bundle.session.header
    let importedLegacyAgentRuntime = header.agentRuntime
    const storedSession: StoredSession = {
      id: sessionId,
      workspaceRootPath,
      sdkSessionId: header.sdkSessionId, // Preserved initially; fork logic below may clear it
      // Always regenerate sdkCwd for the target workspace.
      // The source sdkCwd points to a path on the originating server
      // which doesn't exist here (cross-server transfer).
      sdkCwd: getSessionStoragePath(workspaceRootPath, sessionId),
      name: header.name,
      createdAt: header.createdAt,
      lastUsedAt: Date.now(),
      lastMessageAt: header.lastMessageAt,
      isFlagged: header.isFlagged,
      isPinned: header.isPinned,
      permissionMode: header.permissionMode,
      previousPermissionMode: header.previousPermissionMode,
      sessionStatus: header.sessionStatus,
      labels: header.labels,
      enabledSourceSlugs: header.enabledSourceSlugs,
      workingDirectory: header.workingDirectory,
      model: header.model,
      llmConnection: header.llmConnection,
      connectionLocked: header.connectionLocked,
      thinkingLevel: header.thinkingLevel,
      hidden: header.hidden,
      transferredSessionSummary: header.transferredSessionSummary,
      transferredSessionSummaryApplied: header.transferredSessionSummaryApplied,
      messages: bundle.session.messages,
      tokenUsage: header.tokenUsage ?? DEFAULT_TOKEN_USAGE,
    }

    if (!isFreeConversationWorkspaceId(workspace.id)) {
      storedSession.permissionMode = capPermissionMode(
        storedSession.permissionMode,
        workspace.defaultPermissionMode,
        'ask',
      )
      if (storedSession.permissionMode !== header.permissionMode) {
        storedSession.previousPermissionMode = undefined
      }
    }

    // Portable bundles intentionally omit hidden provider transcripts. A fork
    // must therefore seed one fresh runtime from product messages; preserving
    // native IDs would point at state that was never transferred.
    if (mode === 'fork') {
      importedLegacyAgentRuntime = undefined
      storedSession.sharedUrl = undefined
      storedSession.sharedId = undefined
      resetPortableForkRuntime(storedSession)

      // Credentials are target-local. Rebind to a compatible connection when
      // available, but never treat that as proof the source transcript exists.
      const sourceProviderType = header.llmConnection
        ? getLlmConnection(header.llmConnection)?.providerType
        : undefined
      const compatibleConnection = sourceProviderType
        ? this.findCompatibleLlmConnection(workspaceRootPath, sourceProviderType)
        : null

      if (compatibleConnection) {
        getSessionLog().info(`[import] Fork: compatible ${sourceProviderType} connection "${compatibleConnection}" found — seeding a fresh runtime`)
        storedSession.llmConnection = compatibleConnection
        storedSession.connectionLocked = false
      } else {
        if (storedSession.llmConnection) {
          getSessionLog().info(`[import] Fork: no compatible ${sourceProviderType ?? 'unknown'} connection — clearing for target default`)
        }
        storedSession.llmConnection = undefined
        storedSession.connectionLocked = false
      }
      // Clear thinking level so the session inherits the workspace default
      storedSession.thinkingLevel = undefined
      // Clear working directory — the source path won't exist on a different server.
      // The user can set a new cwd after the session is transferred.
      storedSession.workingDirectory = undefined
    }

    if (!isFreeConversationWorkspaceId(workspace.id)) {
      try {
        storedSession.workingDirectory = resolveWorkspaceWorkingDirectory(
          workspace,
          storedSession.workingDirectory ?? workspaceRootPath,
          true,
        )
      } catch {
        storedSession.workingDirectory = resolveWorkspaceWorkingDirectory(workspace, workspaceRootPath)
        if (mode === 'move' && header.workingDirectory) {
          warnings.push('Working directory is not granted by the target Host; using the target Project root.')
        }
      }
    }

    // Check source compatibility (before writing JSONL so fixes are persisted)
    if (storedSession.enabledSourceSlugs?.length) {
      const requestedSourceSlugs = storedSession.enabledSourceSlugs
      const availableSources = loadWorkspaceSources(workspaceRootPath, workspace.id)
      const availableSlugs = new Set(availableSources.map(s => s.config.slug))
      const missingSources = requestedSourceSlugs.filter(s => !availableSlugs.has(s))
      if (missingSources.length > 0) {
        getSessionLog().warn(`[import] Sources not available: ${missingSources.join(', ')}`)
        warnings.push(`Sources not available in target workspace: ${missingSources.join(', ')}`)
      }
      storedSession.enabledSourceSlugs = filterRestoredSourceSlugs(
        workspace,
        requestedSourceSlugs,
        availableSources,
      )
      const deniedSources = requestedSourceSlugs.filter(
        slug => !missingSources.includes(slug) && !storedSession.enabledSourceSlugs?.includes(slug),
      )
      if (deniedSources.length > 0) {
        warnings.push(`Sources not granted by the target Host: ${deniedSources.join(', ')}`)
      }
    }

    // Check LLM connection compatibility for move mode (fork already cleared above)
    if (mode === 'move' && storedSession.llmConnection) {
      getSessionLog().info(`[import] Checking LLM connection: "${storedSession.llmConnection}"`)
      const conn = resolveSessionConnection(storedSession.llmConnection, undefined)
      if (!conn) {
        getSessionLog().warn(`[import] LLM connection "${storedSession.llmConnection}" not found — clearing to use default`)
        warnings.push(`LLM connection "${storedSession.llmConnection}" not found in target — session will use default`)
        storedSession.llmConnection = undefined
        storedSession.connectionLocked = false
      } else {
        getSessionLog().info(`[import] LLM connection "${storedSession.llmConnection}" resolved OK`)
      }
    } else if (mode === 'move' && !storedSession.llmConnection) {
      getSessionLog().info('[import] No LLM connection in bundle — will use default')
    }

    // Create only after all target-Host compatibility checks have succeeded.
    const sessionDir = ensureSessionDir(workspaceRootPath, sessionId)

    // Write JSONL file (after compatibility checks so remapped values are persisted)
    const sessionFile = getSessionFilePath(workspaceRootPath, sessionId)
    getSessionLog().info(`[import] Writing JSONL: ${sessionFile} (llmConnection=${storedSession.llmConnection ?? 'default'}, messages=${storedSession.messages.length})`)
    writeSessionJsonl(sessionFile, storedSession, workspaceRootPath)

    // Write all bundle files (attachments, plans, data, downloads, etc.)
    // Uses restoreFiles() for path traversal, size, and base64 validation.
    restoreFiles(sessionDir, bundle.files)

    // Register in-memory — pass session metadata without messages to avoid
    // StoredMessage[] vs Message[] type mismatch, then convert messages separately
    const { messages: bundleMessages, ...sessionMeta } = storedSession
    const managed = createManagedSession({ ...sessionMeta, legacyAgentRuntime: importedLegacyAgentRuntime }, workspace as Workspace, {
      messagesLoaded: true,
      workingDirectory: storedSession.workingDirectory,
    })
    managed.messages = bundleMessages.map(storedToMessage)

    setPermissionMode(sessionId, managed.permissionMode ?? 'ask', { changedBy: 'restore' })
    if (managed.previousPermissionMode) {
      hydratePreviousPermissionMode(sessionId, managed.previousPermissionMode)
    }

    this.deps.setSession(sessionId, managed)

    // Initialize automation metadata
    this.deps.setInitialAutomationMetadata(workspaceRootPath, sessionId, {
      permissionMode: storedSession.permissionMode,
      labels: storedSession.labels,
      isFlagged: storedSession.isFlagged,
      sessionStatus: storedSession.sessionStatus,
      sessionName: managed.name,
    })

    // Emit session_created so renderer picks it up
    this.deps.sendEvent({ type: 'session_created', sessionId }, workspaceId)

    getSessionLog().info(`[import] Complete: sessionId=${sessionId}, transferredSummary=${managed.transferredSessionSummary ? `${managed.transferredSessionSummary.length} chars` : 'none'}, applied=${managed.transferredSessionSummaryApplied}, warnings=${warnings.length > 0 ? warnings.join('; ') : 'none'}`)
    return { sessionId, warnings: warnings.length > 0 ? warnings : undefined }
  }

  /**
   * Find an LLM connection on this server that matches the given provider type.
   * Checks workspace default first, then falls back to any matching connection.
   */
  private findCompatibleLlmConnection(workspaceRootPath: string, providerType: string): string | null {
    const wsConfig = loadWorkspaceConfig(workspaceRootPath)
    const defaultSlug = wsConfig?.defaults?.defaultLlmConnection
    if (defaultSlug) {
      const conn = getLlmConnection(defaultSlug)
      if (conn?.providerType === providerType) return defaultSlug
    }
    // Fall back: any connection with matching provider type
    const connections = getLlmConnections()
    const match = connections.find(c => c.providerType === providerType)
    return match?.slug ?? null
  }
}
