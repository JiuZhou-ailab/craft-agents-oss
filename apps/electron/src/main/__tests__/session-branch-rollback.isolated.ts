// input: Mocked Electron runtime, shared config/backend stubs, and SessionManager branch operations
// output: Isolated rollback coverage for failed session branch creation
// pos: Guards main-process session branch cleanup without loading real app services

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

const workspaceRootPath = '/tmp/ws-rollback'
const workspace: Record<string, any> = {
  id: 'ws-1',
  name: 'Workspace',
  rootPath: workspaceRootPath,
}

let idCounter = 0
let migrationError: Error | undefined
const storedById = new Map<string, any>()
const deletedIds: string[] = []

function persistSessionShape(session: any) {
  const { agentRuntime: _legacyAgentRuntime, ...persisted } = session
  storedById.set(session.id, persisted)
}

function writeSourceBranchAnchors() {
  const metaDir = join(workspaceRootPath, 'sessions', 'source-1', 'meta')
  mkdirSync(metaDir, { recursive: true })
  writeFileSync(
    join(metaDir, 'pi-turn-anchors.json'),
    JSON.stringify({
      version: 1,
      anchors: {
        m1: 'pi-turn-anchor-1',
      },
    }),
    'utf-8',
  )
}

// Partial-mock baseline: import real modules via file paths (avoids recursive mock imports)
const actualSharedAgentModule = await import('../../../../../packages/shared/src/agent/index.ts')
const actualSharedAgentBackendModule = await import('../../../../../packages/shared/src/agent/backend/index.ts')
const actualSharedConfigModule = await import('../../../../../packages/shared/src/config/index.ts')

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    dock: { setIcon: () => {}, setBadge: () => {} },
    setBadgeCount: () => {},
  },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
    createFromDataURL: () => ({}),
  },
  Notification: class {
    static isSupported() { return false }
    on() {}
    show() {}
  },
  BrowserWindow: {
    getAllWindows: () => [],
    getFocusedWindow: () => null,
  },
}))

mock.module('../logger', () => {
  const stubLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  return {
    mainLog: stubLog,
    sessionLog: stubLog,
    handlerLog: stubLog,
    windowLog: stubLog,
    searchLog: stubLog,
    isDebugMode: false,
    getLogFilePath: () => '/tmp/main.log',
  }
})

mock.module('@craft-agent/shared/config', () => ({
  ...actualSharedConfigModule,
  CONFIG_DIR: '/tmp/craft-agent',
  getWorkspaceById: (id: string) => (id === workspace.id ? workspace : null),
  getWorkspaceByNameOrId: (id: string) => (id === workspace.id ? workspace : null),
  getWorkspaces: () => [workspace],
  loadStoredConfig: () => ({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
    activeSessionId: null,
  }),
  loadConfigDefaults: () => ({
    workspaceDefaults: {
      permissionMode: 'ask',
      thinkingLevel: 'medium',
    },
  }),
  getLlmConnection: () => null,
  getDefaultLlmConnection: () => null,
  MANAGED_LLM_CONNECTION_SLUG: 'storyflow-managed',
  normalizeLlmConnectionSlug: (slug: string) => slug === 'wangsu-default' ? 'storyflow-managed' : slug,
  resolveAuthEnvVars: () => ({}),
  clearClaudeBedrockRoutingEnvVars: () => {},
  resetManagedAnthropicAuthEnvVars: () => {},
  getToolIconsDir: () => '/tmp/tool-icons',
  getMiniModel: () => 'claude-haiku-4-5-20251001',
  getDefaultThinkingLevel: () => 'medium',
  ConfigWatcher: class ConfigWatcher {
    constructor(..._args: unknown[]) {}
    start() {}
    stop() {}
  },
  migrateLegacyCredentials: async () => {},
  migrateLegacyLlmConnectionsConfig: async () => {},
  migrateOrphanedDefaultConnections: async () => {},
  seedBuiltinLlmConnectionFromDefaults: async () => false,
  MODEL_REGISTRY: [],
  // Targeted stubs: prevent SyntaxError in tests that import these from the barrel
  DEFAULT_MODEL: 'claude-sonnet-4-20250514',
  DEFAULT_THEME: { mode: 'system' },
  getDefaultModelsForConnection: () => ({ default: 'claude-sonnet-4-20250514', mini: 'claude-haiku-4-5-20251001' }),
  getDefaultModelForConnection: () => 'claude-sonnet-4-20250514',
  setGitBashPath: () => {},
  clearGitBashPath: () => {},
  setActiveWorkspace: () => {},
  getSummarizationModel: () => 'claude-haiku-4-5-20251001',
  defaultMidStreamBehavior: () => 'queue',
  resolveMidStreamBehavior: () => 'queue',
  modelSupportsImages: () => true,
  ensureConfigDir: () => {},
  ensureConfigDefaults: () => {},
  getAllSessionDrafts: () => [],
  getGitBashPath: () => null,
  // Handler-required stubs: prevent SyntaxError in handler modules loaded by registration test
  getPreferencesPath: () => '/tmp/preferences.json',
  getSessionDraft: () => null,
  setSessionDraft: async () => {},
  deleteSessionDraft: async () => {},
  getLlmConnections: () => [],
  addLlmConnection: async () => null,
  updateLlmConnection: async () => null,
  deleteLlmConnection: async () => {},
  setDefaultLlmConnection: async () => {},
  touchLlmConnection: async () => {},
  isCompatProvider: () => false,
  isAnthropicProvider: () => true,
}))

mock.module('@craft-agent/shared/workspaces', () => ({
  canonicalizeProjectRoot: (rootPath: string) => rootPath,
  getFreeConversationWorkspace: () => workspace,
  isFreeConversationWorkspaceId: () => false,
  listSessionWorkspaces: () => [workspace],
  resolveRuntimeWorkspace: (id: string) => (id === workspace.id ? workspace : null),
  resolveRuntimeWorkspaceById: (id: string) => (id === workspace.id ? workspace : null),
  isWorkspaceRootAvailable: () => true,
  isPathWithinProjectRoot: () => true,
  resolveVerifiedWorkspaceWorkingDirectory: (_workspace: unknown, path: string) => path,
  resolveWorkspaceWorkingDirectory: (_workspace: unknown, path: string) => path,
  grantWorkspaceWorkingDirectory: (_workspaceId: string, path: string) => ({ workspace, workingDirectory: path }),
  migrateLegacyLocalProjectDirectoryIdentity: async () => {
    if (migrationError) throw migrationError
    return { applied: false, restoredDirectoryIdentity: false }
  },
  discoverLegacyWorkingDirectoryRoots: async () => {
    if (migrationError) throw migrationError
    return []
  },
  prepareWorkspaceRootRelink: (_projectId: string, currentRoot: string) => ({
    projectId: workspace.id,
    previousRoot: workspace.rootPath,
    currentRoot,
    directoryConfigId: 'directory-id',
    workspace: { ...workspace, rootPath: currentRoot },
  }),
  commitWorkspaceRootRelink: (plan: { workspace: Record<string, any> }) => {
    Object.assign(workspace, plan.workspace)
    return { ...workspace }
  },
  rebaseWorkspaceDefaultWorkingDirectory: (_workspace: unknown, rootPath: string) => rootPath,
  rebasePathWithinProjectRoot: (candidatePath: string | undefined) => candidatePath,
  registerLocalProject: () => workspace,
  loadWorkspaceConfig: () => ({
    defaults: {
      permissionMode: 'ask',
      thinkingLevel: 'medium',
      defaultLlmConnection: undefined,
    },
  }),
  isLocalMcpEnabled: () => false,
}))

mock.module('@craft-agent/shared/agent', () => ({
  ...actualSharedAgentModule,
  setPermissionMode: () => {},
  getPermissionModeDiagnostics: () => ({ mode: 'ask', source: 'test' }),
  unregisterSessionScopedToolCallbacks: () => {},
  mergeSessionScopedToolCallbacks: () => {},
  hydratePreviousPermissionMode: () => {},
  initializeModeState: () => {},
  cleanupModeState: () => {},
  getPermissionMode: () => 'ask',
  registerSessionScopedToolCallbacks: () => {},
  cleanupSessionScopedTools: () => {},
  getSessionScopedTools: () => [],
  normalizeCanonicalBrowserToolName: (name: string) => name,
}))

mock.module('@craft-agent/shared/agent/backend', () => ({
  ...actualSharedAgentBackendModule,
  resolveSessionConnection: () => null,
  resolveBackendContext: () => ({
    provider: 'pi',
    resolvedModel: 'pi/gpt-5',
    connection: { providerType: 'pi' },
  }),
  resolveRequiredBackendContext: () => {
    throw new Error('not used in this test')
  },
  resolvePiAgentConfig: () => {
    throw new Error('not used in this test')
  },
  cleanupSourceRuntimeArtifacts: async () => {},
  fetchBackendModels: async () => ({ models: [] }),
  resolveBackendHostTooling: () => ({
    sourceCredentialManager: null,
    sourceServerBuilder: null,
    sourcePoolFactory: null,
    sourcePoolServerFactory: null,
  }),
  testBackendConnection: async () => ({ success: false, error: 'stub' }),
  validateStoredBackendConnection: async () => ({ success: false, error: 'stub' }),
}))

mock.module('@craft-agent/shared/sources', () => ({
  loadWorkspaceSources: () => [],
  loadAllSources: () => [],
  getSourcesBySlugs: () => [],
  resolveHostGrantedSourceSlugs: () => [],
  isSourceHostGranted: () => false,
  createSourceGrantRefs: () => [],
  getSourceGrantRef: () => 'project:test:definition',
  isProjectStdioExecutionAllowed: () => false,
  isSourceUsable: () => true,
  getSourcesNeedingAuth: () => [],
  getSourceCredentialManager: () => ({
    getCredentialStatus: async () => ({ status: 'ready' }),
  }),
  getSourceServerBuilder: () => ({ buildServers: async () => ({ mcpServers: {}, apiServers: {} }) }),
  isApiOAuthProvider: () => false,
  // mcp-pool（server-core）顶层值导入；本测试不触发 API 调用，仅需存在以通过 ESM 链接
  canonicalizeApiPath: (path: string) => path,
  materializeApiOperationRequest: () => ({ url: '', method: 'GET', headers: {} }),
  hasRenewEndpoint: () => false,
  SERVER_BUILD_ERRORS: {},
  TokenRefreshManager: class TokenRefreshManager {
    constructor(_mgr: unknown, _opts: unknown) {}
  },
  createTokenGetter: () => async () => null,
  createStoryflowManagedTokenGetter: () => async () => 'managed-test-token',
  getTrustedManagedSourcePolicy: () => ({ gatewayBaseUrl: 'https://storyflow-model.zjding.com' }),
  // Targeted stubs: prevent SyntaxError in tests that import these from the barrel
  loadSource: () => null,
  API_OAUTH_PROVIDERS: [],
}))

mock.module('@craft-agent/shared/automations', () => ({
  AutomationSystem: class AutomationSystem {
    constructor(..._args: unknown[]) {}
    setInitialSessionMetadata() {}
    reloadConfig() { return { errors: [], automationCount: 0 } }
    emitLabelConfigChange = async () => {}
  },
  validateAutomationsConfig: () => ({ valid: true, errors: [], config: { automations: {} } }),
  validateAutomationsContent: () => ({ valid: true, errors: [], warnings: [] }),
  validateAutomations: () => ({ valid: true, errors: [], warnings: [] }),
  AUTOMATIONS_CONFIG_FILE: 'automations.json',
  AUTOMATIONS_HISTORY_FILE: 'automations.history.jsonl',
}))

mock.module('@craft-agent/shared/sessions', () => ({
  listSessions: () => [],
  listSessionsAsync: async () => [],
  loadSession: (_root: string, id: string) => storedById.get(id) ?? null,
  saveSession: async (session: any) => {
    persistSessionShape(session)
  },
  createSession: async (_root: string, opts: any) => {
    const id = `child-${++idCounter}`
    const now = Date.now()
    const session = {
      id,
      name: opts?.name ?? null,
      messages: [],
      permissionMode: opts?.permissionMode ?? 'ask',
      workingDirectory: opts?.workingDirectory,
      hidden: !!opts?.hidden,
      labels: [],
      isFlagged: false,
      sessionStatus: opts?.sessionStatus,
      createdAt: now,
      lastUsedAt: now,
      workspaceRootPath: workspaceRootPath,
    }
    storedById.set(id, session)
    return session
  },
  deleteSession: async (_root: string, id: string) => {
    deletedIds.push(id)
    storedById.delete(id)
  },
  updateSessionMetadata: async () => {},
  canUpdateSdkCwd: () => false,
  setPendingPlanExecution: async () => {},
  markCompactionComplete: async () => {},
  markPendingPlanExecutionDispatched: async () => {},
  clearPendingPlanExecution: async () => {},
  getPendingPlanExecution: async () => null,
  getSessionAttachmentsPath: () => '/tmp/attachments',
  getSessionPath: (_root: string, id: string) => `${workspaceRootPath}/sessions/${id}`,
  getSessionFilePath: (_root: string, id: string) => `${workspaceRootPath}/sessions/${id}/session.jsonl`,
  readSessionHeader: () => null,
  generateSessionId: () => 'generated-session',
  ensureSessionDir: (_root: string, id: string) => {
    const path = `${workspaceRootPath}/sessions/${id}`
    mkdirSync(path, { recursive: true })
    return path
  },
  validateBundle: () => true,
  serializeSession: () => null,
  writeSessionJsonl: (_path: string, session: any) => {
    persistSessionShape(session)
  },
  getOrCreateLatestSession: async () => null,
  sessionPersistenceQueue: { flush: async () => {} },
  getHeaderMetadataSignature: () => '',
  pickSessionFields: (s: any) => {
    // Must match SESSION_PERSISTENT_FIELDS to prevent contamination of persistence tests
    const fields = [
      'id','workspaceRootPath','sdkSessionId','sdkCwd',
      'createdAt','lastUsedAt','lastMessageAt',
      'name','isFlagged','sessionStatus','labels','hidden',
      'lastReadMessageId','hasUnread',
      'enabledSourceSlugs','permissionMode','previousPermissionMode','workingDirectory',
      'model','llmConnection','connectionLocked','thinkingLevel',
      'sharedUrl','sharedId','pendingPlanExecution',
      'isArchived','archivedAt',
      'branchFromMessageId','branchFromSdkSessionId','branchFromSessionPath',
    ]
    const result: Record<string, unknown> = {}
    for (const f of fields) if (f in s) result[f] = (s as Record<string, unknown>)[f]
    return result
  },
  validateSessionId: () => true,
}))

const { SessionManager } = await import('@craft-agent/server-core/sessions')

describe('session branch rollback on preflight failure', () => {
  beforeEach(() => {
    idCounter = 0
    migrationError = undefined
    workspace.rootPath = workspaceRootPath
    delete workspace.grantedWorkingDirectoryRoots
    storedById.clear()
    deletedIds.length = 0
    rmSync(workspaceRootPath, { recursive: true, force: true })
    writeSourceBranchAnchors()

    storedById.set('source-1', {
      id: 'source-1',
      workspaceRootPath,
      llmConnection: undefined,
      model: 'pi/gpt-5',
      sdkSessionId: 'sdk-parent',
      messages: [
        { id: 'm1', type: 'user', content: 'hello', timestamp: Date.now() - 10 },
        { id: 'm2', type: 'assistant', content: 'hi', timestamp: Date.now() - 5 },
      ],
      createdAt: Date.now() - 20,
      lastUsedAt: Date.now() - 5,
    })
  })

  it('deletes newly created child session when ensureBranchReady throws', async () => {
    const manager = new SessionManager()

    let destroyCalled = false
    let poolStopCalled = false

    ;(manager as any).ensureMessagesLoaded = async (_managed: any) => {}
    ;(manager as any).getOrCreateAgentLocked = async (managed: any) => {
      managed.poolServer = { stop: () => { poolStopCalled = true } }
      managed.agent = {
        supportsBranching: true,
        ensureBranchReady: async () => {
          throw new Error('preflight boom')
        },
        destroy: () => {
          destroyCalled = true
        },
      }
      return managed.agent
    }

    await expect(
      manager.createSession('ws-1', {
        branchFromSessionId: 'source-1',
        branchFromMessageId: 'm1',
      } as any)
    ).rejects.toThrow('Could not create branch: preflight boom')

    expect(deletedIds).toEqual(['child-1'])
    expect(storedById.has('child-1')).toBe(false)
    expect((manager as any).sessions.has('child-1')).toBe(false)
    expect(destroyCalled).toBe(true)
    expect(poolStopCalled).toBe(true)
  })

  it('fails branch creation when parent Pi session id is missing', async () => {
    const source = storedById.get('source-1')
    source.sdkSessionId = undefined
    storedById.set('source-1', source)

    const manager = new SessionManager()

    await expect(
      manager.createSession('ws-1', {
        branchFromSessionId: 'source-1',
        branchFromMessageId: 'm1',
      } as any)
    ).rejects.toThrow('parent session SDK context is not initialized')

    expect(deletedIds).toEqual([])
    expect(storedById.has('child-1')).toBe(false)
  })

  it('runs backend preflight for pi branches and rolls back on failure', async () => {
    const manager = new SessionManager()
    let getOrCreateAgentLockedCalled = false

    ;(manager as any).ensureMessagesLoaded = async (_managed: any) => {}
    ;(manager as any).getOrCreateAgentLocked = async (managed: any) => {
      getOrCreateAgentLockedCalled = true
      managed.poolServer = { stop: () => {} }
      managed.agent = {
        supportsBranching: true,
        ensureBranchReady: async () => {
          throw new Error('pi preflight boom')
        },
        destroy: () => {},
      }
      return managed.agent
    }

    await expect(
      manager.createSession('ws-1', {
        branchFromSessionId: 'source-1',
        branchFromMessageId: 'm1',
      } as any)
    ).rejects.toThrow('Could not create branch: pi preflight boom')

    expect(getOrCreateAgentLockedCalled).toBe(true)
    expect(deletedIds).toEqual(['child-1'])
    expect(storedById.has('child-1')).toBe(false)
  })

  it('does not persist runtime ownership for a pending Pi branch', async () => {
    const manager = new SessionManager()
    ;(manager as any).ensureMessagesLoaded = async (_managed: any) => {}
    ;(manager as any).getOrCreateAgentLocked = async (managed: any) => {
      managed.agent = {
        supportsBranching: true,
        ensureBranchReady: async () => {},
        destroy: () => {},
      }
      return managed.agent
    }

    const session = await manager.createSession('ws-1', {
      branchFromSessionId: 'source-1',
      branchFromMessageId: 'm1',
    } as any)

    expect((manager as any).sessions.get(session.id)?.agentRuntime).toBeUndefined()
    expect((manager as any).sessions.get(session.id)?.needsPiMigrationSeed).toBe(false)
    expect(storedById.get('child-1')?.agentRuntime).toBeUndefined()
  })

  it('consumes legacy runtime ownership without persisting it again', async () => {
    const manager = new SessionManager()

    await manager.importSession('ws-1', {
      version: 1,
      session: {
        header: {
          id: 'legacy-import',
          workspaceRootPath: '/source',
          agentRuntime: 'claude-sdk',
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
        },
        messages: [],
      },
      files: [],
    } as any, 'move')

    expect(storedById.get('legacy-import')?.agentRuntime).toBeUndefined()
    expect((manager as any).sessions.get('legacy-import')?.agentRuntime).toBeUndefined()
    expect((manager as any).sessions.get('legacy-import')?.needsPiMigrationSeed).toBe(true)
  })

  it('does not commit a relink when legacy grant discovery fails', async () => {
    const manager = new SessionManager()
    const currentRoot = '/tmp/ws-relinked'
    migrationError = new Error('grant discovery failed')
    ;(manager as any).setupConfigWatcher = () => {}

    await expect(manager.rebindWorkspaceRoot(workspace.id, currentRoot))
      .rejects.toThrow('grant discovery failed')

    expect(workspace.rootPath).toBe(workspaceRootPath)
  })
})
