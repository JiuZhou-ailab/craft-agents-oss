// input: A freshly constructed AgentInstance, its ManagedSession, and the Facade callback bundle
// output: wireAgentCallbacks — post-construction agent event wiring (permission/auth/plan/spawn/self-management/source activation)
// pos: Agent runtime wiring; the only place product callbacks are attached to a live Pi agent

import type { IBrowserPaneManager } from '@craft-agent/server-core/handlers'
import { validateFilePath, getWorkspaceAllowedDirs } from '@craft-agent/server-core/handlers'
import { PrivilegedExecutionBroker } from '@craft-agent/server-core/services'
import {
  getPermissionModeDiagnostics,
  mergeSessionScopedToolCallbacks,
  AbortReason,
  type AuthRequest,
} from '@craft-agent/shared/agent'
import type { UserQuestionRequest, UserQuestionResponse } from '@craft-agent/session-tools-core'
import { getSessionPath as getSessionStoragePath } from '@craft-agent/shared/sessions'
import { getSourcesBySlugs, isSourceUsable } from '@craft-agent/shared/sources'
import { loadLabelConfig } from '@craft-agent/shared/labels/storage'
import { resolveSessionLabels } from '@craft-agent/shared/labels'
import { loadStatusConfig } from '@craft-agent/shared/statuses/storage'
import type { Session, SessionEvent, FileAttachment, CreateSessionOptions } from '@craft-agent/shared/protocol'
import { generateMessageId } from '@craft-agent/shared/protocol'
import type { Message } from '@craft-agent/core/types'
import type { SessionStatus } from '@craft-agent/shared/sessions'
import { readFileAttachment } from '@craft-agent/shared/utils'
import { releaseBrowserOwnershipOnForcedStop } from '@craft-agent/server-core/domain'
import {
  canAutoEnableSource,
  capPermissionMode,
  intersectSourceSlugs,
  type AgentInstance,
  type ManagedSession,
} from './managed-session'
import { getSessionLog, getResourceProjectRoot } from './session-runtime'
import { buildServersFromSources } from './source-bridge'

/** Metadata tracked per in-flight permission request (keyed by requestId). */
export interface PermissionRequestMeta {
  sessionId: string
  type?: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval'
  commandHash?: string
}

/** Callback bundle resolving through the owning SessionManager at call time. */
export interface WireAgentCallbacksDeps {
  sendEvent(event: SessionEvent, workspaceId?: string): void
  persistSession(managed: ManagedSession): void
  monotonic(): number
  setProcessing(managed: ManagedSession, processing: boolean): void
  getBrowserPaneManager(): IBrowserPaneManager | null
  hasActiveAdminRememberApproval(sessionId: string, commandHash: string): boolean
  privilegedExecutionBroker: PrivilegedExecutionBroker
  pendingPermissionRequests: Map<string, PermissionRequestMeta>
  pendingUserQuestions: Map<string, {
    sessionId: string
    request: UserQuestionRequest
    resolve: (response: UserQuestionResponse) => void
  }>
  advanceUserQuestionRevision(): NonNullable<Session['userQuestionRevision']>
  getAuthRequestDescription(request: AuthRequest): string
  handlePlanSubmitted(managed: ManagedSession, planPath: string): Promise<void>
  createSession(workspaceId: string, options?: CreateSessionOptions): Promise<Session>
  sendMessage(sessionId: string, message: string, attachments?: FileAttachment[]): Promise<unknown>
  getSession(id: string): ManagedSession | undefined
  getSessions(workspaceId?: string): Session[]
  setSessionLabels(sessionId: string, labels: string[]): Promise<void>
  setSessionStatus(sessionId: string, status: SessionStatus): Promise<void>
}

/**
 * Attach every post-construction product callback to a live agent:
 * permission requests, permission-mode changes, plan submission, auth
 * requests, spawned sessions, session self-management tools, and source
 * activation. Must be called after postInit(), in creation order.
 */
export function wireAgentCallbacks(
  agent: AgentInstance,
  managed: ManagedSession,
  deps: WireAgentCallbacksDeps,
): void {
  // Set up permission handler to forward requests to renderer
  agent.onPermissionRequest = (request: {
    requestId: string;
    toolName: string;
    command?: string;
    description: string;
    type?: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval';
    appName?: string;
    reason?: string;
    impact?: string;
    requiresSystemPrompt?: boolean;
    rememberForMinutes?: number;
    commandHash?: string;
    approvalTtlSeconds?: number;
  }) => {
    getSessionLog().info(`Permission request for session ${managed.id}:`, request.command)
    let brokerMetadata: {
      commandHash?: string
      approvalTtlSeconds?: number
    } = {}

    if (request.type === 'admin_approval' && request.command) {
      const brokerRequest = deps.privilegedExecutionBroker.createRequest({
        requestId: request.requestId,
        sessionId: managed.id,
        command: request.command,
        reason: request.reason,
        impact: request.impact,
        approvalTtlSeconds: request.approvalTtlSeconds,
      })

      brokerMetadata = {
        commandHash: brokerRequest.commandHash,
        approvalTtlSeconds: brokerRequest.approvalTtlSeconds,
      }
    }

    const effectiveCommandHash = brokerMetadata.commandHash ?? request.commandHash

    deps.pendingPermissionRequests.set(request.requestId, {
      sessionId: managed.id,
      type: request.type,
      commandHash: effectiveCommandHash,
    })

    if (request.type === 'admin_approval' && effectiveCommandHash && deps.hasActiveAdminRememberApproval(managed.id, effectiveCommandHash)) {
      const brokerResult = deps.privilegedExecutionBroker.resolveApproval(request.requestId, true, {
        expectedCommandHash: effectiveCommandHash,
      })

      deps.pendingPermissionRequests.delete(request.requestId)

      if (brokerResult.ok) {
        deps.privilegedExecutionBroker.auditEvent('privileged_auto_approved_remember_window', {
          sessionId: managed.id,
          requestId: request.requestId,
          commandHash: effectiveCommandHash,
        })
        const liveAgent = managed.agent
        if (liveAgent) {
          liveAgent.respondToPermission(request.requestId, true, false)
          return
        }
      }

      getSessionLog().warn(`Remember-window auto-approval skipped for ${request.requestId}: ${brokerResult.reason}`)
    }

    deps.sendEvent({
      type: 'permission_request',
      sessionId: managed.id,
      request: {
        ...request,
        ...brokerMetadata,
        sessionId: managed.id,
      }
    }, managed.workspace.id)
  }

  // Set up mode change handlers
  agent.onPermissionModeChange = (mode) => {
    if (managed.permissionMode === mode) {
      return
    }

    managed.permissionMode = mode
    const diagnostics = getPermissionModeDiagnostics(managed.id)
    managed.previousPermissionMode = diagnostics.previousPermissionMode
    getSessionLog().info('Permission mode changed (agent callback)', {
      sessionId: managed.id,
      permissionMode: mode,
      modeVersion: diagnostics.modeVersion,
      changedBy: diagnostics.lastChangedBy,
      changedAt: diagnostics.lastChangedAt,
    })
    deps.sendEvent({
      type: 'permission_mode_changed',
      sessionId: managed.id,
      permissionMode: managed.permissionMode,
      modeVersion: diagnostics.modeVersion,
      changedBy: diagnostics.lastChangedBy,
      changedAt: diagnostics.lastChangedAt,
      previousPermissionMode: diagnostics.previousPermissionMode,
      transitionDisplay: diagnostics.transitionDisplay,
    }, managed.workspace.id)
  }

  // Wire up onPlanSubmitted to add plan message to conversation
  agent.onPlanSubmitted = async (planPath) => {
    await deps.handlePlanSubmitted(managed, planPath)
  }

  // Wire up onAuthRequest to add auth message to conversation and pause execution
  agent.onAuthRequest = (request) => {
    getSessionLog().info(`Auth request for session ${managed.id}:`, request.type, request.sourceSlug)

    // Create auth-request message
    const authMessage: Message = {
      id: generateMessageId(),
      role: 'auth-request',
      content: deps.getAuthRequestDescription(request),
      timestamp: deps.monotonic(),
      authRequestId: request.requestId,
      authRequestType: request.type,
      authSourceSlug: request.sourceSlug,
      authSourceName: request.sourceName,
      authStatus: 'pending',
      // Copy type-specific fields for credentials
      ...(request.type === 'credential' && {
        authCredentialMode: request.mode,
        authLabels: request.labels,
        authDescription: request.description,
        authHint: request.hint,
        authHeaderName: request.headerName,
        authHeaderNames: request.headerNames,
        authSourceUrl: request.sourceUrl,
        authPasswordRequired: request.passwordRequired,
      }),
    }

    // Add to session messages
    managed.messages.push(authMessage)

    // Store pending auth request for later resolution
    managed.pendingAuthRequestId = request.requestId
    managed.pendingAuthRequest = request

    // Interrupt execution (like SubmitPlan)
    if (managed.isProcessing && managed.agent) {
      getSessionLog().info(`Interrupting for auth request in session ${managed.id}`)
      managed.agent.interruptForHandoff(AbortReason.AuthRequest)
      deps.setProcessing(managed, false)

      // Release browser overlay + session binding because the agent is paused awaiting user auth.
      void releaseBrowserOwnershipOnForcedStop(deps.getBrowserPaneManager(), managed.id)

      // Send complete event so renderer knows processing stopped (include tokenUsage for real-time updates)
      deps.sendEvent({ type: 'complete', sessionId: managed.id, tokenUsage: managed.tokenUsage }, managed.workspace.id)
    }

    // Emit auth_request event to renderer
    deps.sendEvent({
      type: 'auth_request',
      sessionId: managed.id,
      message: authMessage,
      request: request,
    }, managed.workspace.id)

    // Persist session state
    deps.persistSession(managed)

    // OAuth flow is client-driven via performOAuth() (preload).
    // The UI calls window.electronAPI.performOAuth() when user clicks "Sign in".
  }

  // Wire up onSpawnSession to create independent sessions from agent tool calls
  agent.onSpawnSession = async (request) => {
    getSessionLog().info(`Spawn session request from session ${managed.id}:`, request.name || '(unnamed)')

    const session = await deps.createSession(managed.workspace.id, {
      name: request.name,
      llmConnection: request.llmConnection ?? managed.llmConnection,
      model: request.model ?? managed.model,
      enabledSourceSlugs: request.enabledSourceSlugs
        ? intersectSourceSlugs(request.enabledSourceSlugs, managed.enabledSourceSlugs)
        : managed.enabledSourceSlugs,
      permissionMode: capPermissionMode(
        request.permissionMode,
        managed.permissionMode,
        managed.permissionMode ?? 'ask',
      ),
      thinkingLevel: request.thinkingLevel ?? managed.thinkingLevel,
      labels: request.labels ?? managed.labels,
      workingDirectory: request.workingDirectory,
    })

    // Build FileAttachment[] from paths (if any)
    let fileAttachments: FileAttachment[] | undefined
    if (request.attachments?.length) {
      const attachments: FileAttachment[] = []
      for (const a of request.attachments) {
        try {
          const extraDirs = getWorkspaceAllowedDirs(managed.workspace.id)
          if (request.workingDirectory) extraDirs.push(request.workingDirectory)
          const safePath = await validateFilePath(a.path, extraDirs)
          const attachment = readFileAttachment(safePath)
          if (attachment) {
            if (a.name) attachment.name = a.name
            attachments.push(attachment)
          } else {
            getSessionLog().warn(`Spawn session: attachment not found: ${a.path}`)
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          getSessionLog().warn(`Spawn session: blocked attachment path ${a.path}: ${message}`)
        }
      }
      if (attachments.length > 0) fileAttachments = attachments
    }

    // Notify renderer to hydrate full session metadata (including name)
    // before streaming events arrive. Without this, the renderer creates
    // a synthetic empty session and shows "New Chat" in the sidebar.
    deps.sendEvent({ type: 'session_created', sessionId: session.id }, managed.workspace.id)

    // Fire and forget — send the message but don't await completion
    deps.sendMessage(session.id, request.prompt, fileAttachments).catch(err => {
      getSessionLog().error(`Failed to send message to spawned session ${session.id}:`, err)
    })

    return {
      sessionId: session.id,
      name: session.name || request.name || session.id,
      status: 'started' as const,
      connection: session.llmConnection,
      model: session.model,
    }
  }

  // Wire up session self-management tools (set_session_labels, set_session_status, etc.)
  mergeSessionScopedToolCallbacks(managed.id, {
    askUserQuestionFn: (request: UserQuestionRequest) => new Promise<UserQuestionResponse>((resolve) => {
      deps.pendingUserQuestions.set(request.requestId, {
        sessionId: managed.id,
        request,
        resolve,
      })
      deps.sendEvent({
        type: 'user_question_request',
        revision: deps.advanceUserQuestionRevision(),
        sessionId: managed.id,
        request,
      }, managed.workspace.id)
    }),
    setSessionLabelsFn: async (sessionId: string | undefined, labels: string[]) => {
      await deps.setSessionLabels(sessionId ?? managed.id, labels)
    },
    setSessionStatusFn: async (sessionId: string | undefined, status: string) => {
      await deps.setSessionStatus(sessionId ?? managed.id, status as SessionStatus)
    },
    getSessionInfoFn: (sessionId?: string) => {
      const targetId = sessionId ?? managed.id
      const session = deps.getSession(targetId)
      if (!session) return null
      return {
        id: session.id,
        name: session.name ?? session.id,
        labels: session.labels ?? [],
        status: session.sessionStatus ?? 'todo',
        permissionMode: session.permissionMode ?? 'ask',
        createdAt: session.createdAt ?? 0,
        workingDirectory: session.workingDirectory,
        llmConnection: session.llmConnection,
        model: session.model,
        isActive: session.agent != null,
      }
    },
    listSessionsFn: (options) => {
      const DEFAULT_LIMIT = 20
      const MAX_LIMIT = 100
      const limit = Math.min(options?.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
      const offset = options?.offset ?? 0

      let sessions = deps.getSessions(managed.workspace.id)

      // Filter
      if (options?.status) {
        sessions = sessions.filter(s => s.sessionStatus === options.status)
      }
      if (options?.label) {
        sessions = sessions.filter(s => s.labels?.includes(options.label!))
      }
      if (options?.search) {
        const needle = options.search.toLowerCase()
        sessions = sessions.filter(s => s.name?.toLowerCase().includes(needle))
      }

      // Sort
      const sortBy = options?.sortBy ?? 'recent'
      if (sortBy === 'recent') {
        sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      } else if (sortBy === 'name') {
        sessions.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
      } else if (sortBy === 'status') {
        sessions.sort((a, b) => (a.sessionStatus ?? '').localeCompare(b.sessionStatus ?? ''))
      }

      const total = sessions.length

      // Paginate
      const page = sessions.slice(offset, offset + limit)

      return {
        total,
        returned: page.length,
        sessions: page.map(s => ({
          id: s.id,
          name: s.name ?? s.id,
          labels: s.labels ?? [],
          status: s.sessionStatus ?? 'todo',
          createdAt: s.createdAt ?? 0,
        })),
      }
    },
    resolveLabelsFn: (labels: string[]) => {
      const labelConfig = loadLabelConfig(managed.workspace.rootPath)
      return resolveSessionLabels(labels, labelConfig.labels)
    },
    resolveStatusFn: (status: string) => {
      const statusConfig = loadStatusConfig(managed.workspace.rootPath)
      const allStatuses = statusConfig.statuses
      const available = allStatuses.map(s => s.id)

      // Exact ID match
      const byId = allStatuses.find(s => s.id === status)
      if (byId) return { resolved: byId.id, available }
      // Case-insensitive label → ID
      const byLabel = allStatuses.find(s => s.label.toLowerCase() === status.toLowerCase())
      if (byLabel) return { resolved: byLabel.id, available }

      return { resolved: null, available }
    },
    sendAgentMessageFn: async (sessionId: string, message: string, attachments?: Array<{ path: string; name?: string }>) => {
      // Build FileAttachment[] from paths (same pattern as spawn_session)
      let fileAttachments: FileAttachment[] | undefined
      if (attachments?.length) {
        const builtAttachments: FileAttachment[] = []
        for (const a of attachments) {
          try {
            const extraDirs = getWorkspaceAllowedDirs(managed.workspace.id)
            const safePath = await validateFilePath(a.path, extraDirs)
            const attachment = readFileAttachment(safePath)
            if (attachment) {
              if (a.name) attachment.name = a.name
              builtAttachments.push(attachment)
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            getSessionLog().warn(`send_agent_message: blocked attachment path ${a.path}: ${msg}`)
          }
        }
        if (builtAttachments.length > 0) fileAttachments = builtAttachments
      }

      await deps.sendMessage(sessionId, message, fileAttachments)
    },
    activateSourceInSessionFn: async (sourceSlug: string) => {
      const cb = managed.agent?.onSourceActivationRequest
      if (!cb) {
        return { ok: false, reason: 'Agent has no activation callback wired' }
      }
      const ok = await cb(sourceSlug)
      if (!ok) {
        return {
          ok: false,
          reason: 'Activation failed — source may be unusable (disabled/unauthenticated) or server build failed. Check session logs.',
        }
      }
      return { ok: true, availability: 'next-turn' as const }
    },
  })

  // Wire up onSourceActivationRequest to auto-enable sources when agent tries to use them
  agent.onSourceActivationRequest = async (sourceSlug: string): Promise<boolean> => {
    getSessionLog().info(`Source activation request for session ${managed.id}:`, sourceSlug)

    const workspaceRootPath = managed.workspace.rootPath
    const projectRoot = getResourceProjectRoot(managed.workspace)

    // Check if source is already enabled
    if (managed.enabledSourceSlugs?.includes(sourceSlug)) {
      getSessionLog().info(`Source ${sourceSlug} already in enabledSourceSlugs, checking server status`)
      // Source is in the list but server might not be active (e.g., build failed previously)
    }

    // Load the source to check if it exists and is ready
    const sources = getSourcesBySlugs(projectRoot, [sourceSlug], managed.workspace.id)
    if (sources.length === 0) {
      getSessionLog().warn(`Source ${sourceSlug} not found in workspace`)
      return false
    }

    const source = sources[0]

    // Check if source is usable (enabled and authenticated if auth is required)
    if (!isSourceUsable(source)) {
      getSessionLog().warn(`Source ${sourceSlug} is not usable (disabled or requires authentication)`)
      return false
    }

    // Track whether we added this slug (for rollback on failure)
    const slugSet = new Set(managed.enabledSourceSlugs || [])
    const wasAlreadyEnabled = slugSet.has(sourceSlug)
    if (
      !wasAlreadyEnabled
      && !canAutoEnableSource(managed.workspace, managed.enabledSourceSlugs ?? [], source)
    ) {
      getSessionLog().warn(`Source ${sourceSlug} was not granted for automatic activation by the Host`)
      return false
    }

    // Add to enabled sources if not already there
    if (!wasAlreadyEnabled) {
      slugSet.add(sourceSlug)
      managed.enabledSourceSlugs = Array.from(slugSet)
      getSessionLog().info(`Added source ${sourceSlug} to session enabled sources`)
    }

    // Build server configs for all enabled sources
    const allEnabledSources = getSourcesBySlugs(
      projectRoot,
      managed.enabledSourceSlugs || [],
      managed.workspace.id,
    )
    // Pass session path so large API responses can be saved to session folder
    const sessionPath = getSessionStoragePath(workspaceRootPath, managed.id)
    const { mcpServers, apiServers, errors, resolvedSources } = await buildServersFromSources(
      allEnabledSources,
      sessionPath,
      managed.tokenRefreshManager,
      managed.agent?.getSummarizeCallback(),
      managed.workspace,
    )

    if (errors.length > 0) {
      getSessionLog().warn(`Source build errors during auto-enable:`, errors)
    }

    // Check if our target source was built successfully
    const sourceBuilt = sourceSlug in mcpServers || sourceSlug in apiServers
    if (!sourceBuilt) {
      getSessionLog().warn(`Source ${sourceSlug} failed to build`)
      // Only remove if WE added it (not if it was already there)
      if (!wasAlreadyEnabled) {
        slugSet.delete(sourceSlug)
        managed.enabledSourceSlugs = Array.from(slugSet)
      }
      return false
    }

    // Apply source servers to the agent
    const intendedSlugs = resolvedSources
      .filter(isSourceUsable)
      .map(s => s.config.slug)

    // Update source runtime config/credentials for backends that need it
    await managed.agent!.applyBridgeUpdates({ sessionPath, enabledSources: resolvedSources, mcpServers, sessionId: managed.id, workspaceRootPath, context: 'source enable' })

    await managed.agent!.setSourceServers(mcpServers, apiServers, intendedSlugs)

    getSessionLog().info(`Auto-enabled source ${sourceSlug} for session ${managed.id}`)

    // Persist session with updated enabled sources
    deps.persistSession(managed)

    // Notify renderer of source change
    deps.sendEvent({
      type: 'sources_changed',
      sessionId: managed.id,
      enabledSourceSlugs: managed.enabledSourceSlugs || [],
    }, managed.workspace.id)

    return true
  }
}
