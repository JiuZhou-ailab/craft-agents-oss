// input: Source RPC reads/mutations concurrent with Project relink/remove lifecycles
// output: Regression coverage for Source IO lifecycle serialization and MCP cleanup
// pos: Guards Source handlers from stale Project locators, removal races, and leaked clients

import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runIsolatedJson } from '../../sessions/isolated-test-runner'

const SOURCES_HANDLER_PATH = pathToFileURL(join(import.meta.dir, 'sources.ts')).href
const SESSION_MANAGER_PATH = pathToFileURL(join(import.meta.dir, '..', '..', 'sessions', 'SessionManager.ts')).href

function writeProjectConfig(rootPath: string): void {
  mkdirSync(join(rootPath, '.craft-agent'), { recursive: true })
  writeFileSync(join(rootPath, '.craft-agent', 'config.json'), JSON.stringify({
    id: 'directory-id', name: 'Project', slug: 'project', createdAt: 1, updatedAt: 1,
  }))
}

describe('Source mutation lifecycle', () => {
  it('waits for an earlier Project relink and resolves Source mutations from its committed locator', () => {
    const parent = mkdtempSync(join(tmpdir(), 'storyflow-source-create-lifecycle-'))
    const configDir = join(parent, 'host')
    const previousRoot = join(parent, 'previous')
    const currentRoot = join(parent, 'current')
    mkdirSync(configDir, { recursive: true })
    for (const rootPath of [previousRoot, currentRoot]) {
      const sourceDir = join(rootPath, '.craft-agent', 'sources', 'foo')
      writeProjectConfig(rootPath)
      mkdirSync(sourceDir, { recursive: true })
      writeFileSync(join(sourceDir, 'config.json'), JSON.stringify({
        id: 'foo-old', slug: 'foo', name: 'Foo', provider: 'custom', type: 'api', enabled: true,
        api: { baseUrl: 'https://old.example', authType: 'none' }, createdAt: 1, updatedAt: 1,
      }))
    }
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      workspaces: [{
        id: 'project-1', name: 'Project', slug: 'project', rootPath: previousRoot,
        createdAt: 1, directoryConfigId: 'directory-id',
      }],
      activeWorkspaceId: 'project-1', activeSessionId: null,
    }))

    try {
      const result = runIsolatedJson(configDir, 'SOURCE_RELINK_LIFECYCLE', `
          import { existsSync } from 'node:fs';
          import { join } from 'node:path';
          import { registerSourcesHandlers } from '${SOURCES_HANDLER_PATH}';
          import { SessionManager } from '${SESSION_MANAGER_PATH}';
          import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
          import { loadStoredConfig, saveConfig } from '@craft-agent/shared/config';
          const handlers = new Map();
          const server = { handle: (channel, handler) => handlers.set(channel, handler), push() {} };
          const logger = { info() {}, warn() {}, error() {}, debug() {} };
          const manager = new SessionManager();
          registerSourcesHandlers(server, { platform: { logger }, sessionManager: manager });

          let markLifecycleStarted;
          let finishLifecycle;
          const lifecycleStarted = new Promise(resolve => { markLifecycleStarted = resolve; });
          const lifecycleGate = new Promise(resolve => { finishLifecycle = resolve; });
          const relocation = manager.withProjectLifecycle('project-1', async () => {
            markLifecycleStarted();
            await lifecycleGate;
            const config = loadStoredConfig();
            config.workspaces[0].rootPath = ${JSON.stringify(currentRoot)};
            saveConfig(config);
          });
          await lifecycleStarted;

          const creating = handlers.get(RPC_CHANNELS.sources.CREATE)(null, 'project-1', {
            name: 'New Source', provider: 'custom', type: 'api', enabled: true,
            api: { baseUrl: 'https://example.test', authType: 'none' },
          });
          const deleting = handlers.get(RPC_CHANNELS.sources.DELETE)(null, 'project-1', 'foo');
          const stateBeforeRelease = await Promise.race([
            Promise.all([creating, deleting]).then(() => 'mutated'),
            Bun.sleep(100).then(() => 'blocked'),
          ]);
          finishLifecycle();
          await relocation;
          const source = await creating;
          await deleting;
          manager.cleanup();
          console.log('SOURCE_RELINK_LIFECYCLE=' + JSON.stringify({
            stateBeforeRelease,
            activeRoot: loadStoredConfig().workspaces[0].rootPath,
            sourceExists: existsSync(join(${JSON.stringify(configDir)}, 'sources', source.slug, 'config.json')),
            previousSourceExists: existsSync(join(${JSON.stringify(previousRoot)}, '.craft-agent', 'sources', 'foo', 'config.json')),
            currentSourceExists: existsSync(join(${JSON.stringify(currentRoot)}, '.craft-agent', 'sources', 'foo', 'config.json')),
          }));
        `)
      expect(result).toEqual({
        stateBeforeRelease: 'blocked',
        activeRoot: currentRoot,
        sourceExists: true,
        previousSourceExists: true,
        currentSourceExists: false,
      })
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('finishes an in-flight Source deletion before removing its Project', () => {
    const parent = mkdtempSync(join(tmpdir(), 'storyflow-source-delete-lifecycle-'))
    const configDir = join(parent, 'host')
    const projectRoot = join(parent, 'project')
    const sourceDir = join(projectRoot, '.craft-agent', 'sources', 'foo')
    mkdirSync(sourceDir, { recursive: true })
    mkdirSync(configDir, { recursive: true })
    writeProjectConfig(projectRoot)
    writeFileSync(join(sourceDir, 'config.json'), JSON.stringify({
      id: 'foo-old', slug: 'foo', name: 'Foo', provider: 'custom', type: 'api', enabled: true,
      api: { baseUrl: 'https://old.example', authType: 'none' }, createdAt: 1, updatedAt: 1,
    }))
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      workspaces: [{
        id: 'project-1', name: 'Project', slug: 'project', rootPath: projectRoot,
        createdAt: 1, directoryConfigId: 'directory-id',
        defaultEnabledSourceRefs: ['workspace:foo'],
      }],
      activeWorkspaceId: 'project-1', activeSessionId: null,
    }))

    try {
      const result = runIsolatedJson(configDir, 'SOURCE_DELETE_LIFECYCLE', `
          import { existsSync } from 'node:fs';
          import { join } from 'node:path';
          import { registerSourcesHandlers } from '${SOURCES_HANDLER_PATH}';
          import { SessionManager } from '${SESSION_MANAGER_PATH}';
          import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
          import { getSourceCredentialManager } from '@craft-agent/shared/sources';
          const handlers = new Map();
          const server = { handle: (channel, handler) => handlers.set(channel, handler), push() {} };
          const logger = { info() {}, warn() {}, error() {}, debug() {} };
          const manager = new SessionManager();
          registerSourcesHandlers(server, { platform: { logger }, sessionManager: manager });

          const credentialManager = getSourceCredentialManager();
          const originalDeleteAll = credentialManager.deleteAll.bind(credentialManager);
          let markCredentialCleanupStarted;
          let finishCredentialCleanup;
          const credentialCleanupStarted = new Promise(resolve => { markCredentialCleanupStarted = resolve; });
          const credentialCleanupGate = new Promise(resolve => { finishCredentialCleanup = resolve; });
          credentialManager.deleteAll = async () => {
            markCredentialCleanupStarted();
            await credentialCleanupGate;
          };

          const deleting = handlers.get(RPC_CHANNELS.sources.DELETE)(null, 'project-1', 'foo');
          await credentialCleanupStarted;
          const removal = manager.removeWorkspace('project-1');
          const stateBeforeRelease = await Promise.race([
            removal.then(() => 'removed'),
            Bun.sleep(100).then(() => 'blocked'),
          ]);
          finishCredentialCleanup();
          await deleting;
          await removal;
          credentialManager.deleteAll = originalDeleteAll;
          manager.cleanup();
          console.log('SOURCE_DELETE_LIFECYCLE=' + JSON.stringify({
            stateBeforeRelease,
            sourceExists: existsSync(join(${JSON.stringify(sourceDir)}, 'config.json')),
          }));
        `)
      expect(result).toEqual({
        stateBeforeRelease: 'blocked',
        sourceExists: false,
      })
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('resolves Source reads and credential saves after an earlier Project relink', () => {
    const parent = mkdtempSync(join(tmpdir(), 'storyflow-source-read-relink-'))
    const configDir = join(parent, 'host')
    const previousRoot = join(parent, 'previous')
    const currentRoot = join(parent, 'current')
    mkdirSync(configDir, { recursive: true })
    for (const [rootPath, marker] of [[previousRoot, 'old'], [currentRoot, 'current']] as const) {
      const sourceDir = join(rootPath, '.craft-agent', 'sources', 'foo')
      writeProjectConfig(rootPath)
      mkdirSync(sourceDir, { recursive: true })
      writeFileSync(join(sourceDir, 'config.json'), JSON.stringify({
        id: `foo-${marker}`, slug: 'foo', name: marker, provider: 'custom', type: 'api', enabled: true,
        api: { baseUrl: `https://${marker}.example`, authType: 'none' }, createdAt: 1, updatedAt: 1,
      }))
      writeFileSync(join(sourceDir, 'permissions.json'), JSON.stringify({
        version: '2026-08-27', allowedMcpPatterns: [`${marker}-source`],
      }))
      writeFileSync(join(rootPath, 'permissions.json'), JSON.stringify({
        version: '2026-08-27', allowedMcpPatterns: [`${marker}-workspace`],
      }))
    }
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      workspaces: [{
        id: 'project-1', name: 'Project', slug: 'project', rootPath: previousRoot,
        createdAt: 1, directoryConfigId: 'directory-id',
      }],
      activeWorkspaceId: 'project-1', activeSessionId: null,
    }))

    try {
      const result = runIsolatedJson(configDir, 'SOURCE_READ_RELINK', `
          import { registerSourcesHandlers } from '${SOURCES_HANDLER_PATH}';
          import { SessionManager } from '${SESSION_MANAGER_PATH}';
          import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
          import { loadStoredConfig, saveConfig } from '@craft-agent/shared/config';
          import { getSourceCredentialManager } from '@craft-agent/shared/sources';
          const handlers = new Map();
          const server = { handle: (channel, handler) => handlers.set(channel, handler), push() {} };
          const logger = { info() {}, warn() {}, error() {}, debug() {} };
          const manager = new SessionManager();
          registerSourcesHandlers(server, { platform: { logger }, sessionManager: manager });

          const credentialManager = getSourceCredentialManager();
          const originalSave = credentialManager.save.bind(credentialManager);
          let savedRoot = null;
          credentialManager.save = async source => { savedRoot = source.workspaceRootPath; };

          let markLifecycleStarted;
          let finishLifecycle;
          const lifecycleStarted = new Promise(resolve => { markLifecycleStarted = resolve; });
          const lifecycleGate = new Promise(resolve => { finishLifecycle = resolve; });
          const relocation = manager.withProjectLifecycle('project-1', async () => {
            markLifecycleStarted();
            await lifecycleGate;
            const config = loadStoredConfig();
            config.workspaces[0].rootPath = ${JSON.stringify(currentRoot)};
            saveConfig(config);
          });
          await lifecycleStarted;

          const operations = Promise.all([
            handlers.get(RPC_CHANNELS.sources.GET)(null, 'project-1'),
            handlers.get(RPC_CHANNELS.sources.SAVE_CREDENTIALS)(null, 'project-1', 'foo', 'secret'),
            handlers.get(RPC_CHANNELS.sources.GET_PERMISSIONS)(null, 'project-1', 'foo'),
            handlers.get(RPC_CHANNELS.workspace.GET_PERMISSIONS)(null, 'project-1'),
          ]);
          const stateBeforeRelease = await Promise.race([
            operations.then(() => 'completed'),
            Bun.sleep(100).then(() => 'blocked'),
          ]);
          finishLifecycle();
          await relocation;
          const [sources, , sourcePermissions, workspacePermissions] = await operations;
          credentialManager.save = originalSave;
          manager.cleanup();
          console.log('SOURCE_READ_RELINK=' + JSON.stringify({
            stateBeforeRelease,
            activeRoot: loadStoredConfig().workspaces[0].rootPath,
            sourceName: sources.find(source => source.config.slug === 'foo')?.config.name,
            savedRoot,
            sourcePermission: sourcePermissions?.allowedMcpPatterns?.[0],
            workspacePermission: workspacePermissions?.allowedMcpPatterns?.[0],
          }));
        `)
      expect(result).toEqual({
        stateBeforeRelease: 'blocked',
        activeRoot: currentRoot,
        sourceName: 'current',
        savedRoot: currentRoot,
        sourcePermission: 'current-source',
        workspacePermission: 'current-workspace',
      })
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('drains MCP discovery and closes its client before removing the Project', () => {
    const parent = mkdtempSync(join(tmpdir(), 'storyflow-source-mcp-lock-'))
    const configDir = join(parent, 'host')
    const projectRoot = join(parent, 'project')
    const sourceDir = join(projectRoot, '.craft-agent', 'sources', 'foo')
    mkdirSync(sourceDir, { recursive: true })
    mkdirSync(configDir, { recursive: true })
    writeProjectConfig(projectRoot)
    writeFileSync(join(sourceDir, 'config.json'), JSON.stringify({
      id: 'foo-mcp', slug: 'foo', name: 'Foo', provider: 'custom', type: 'mcp', enabled: true,
      mcp: { transport: 'http', url: 'https://mcp.example', authType: 'none' },
      connectionStatus: 'connected', createdAt: 1, updatedAt: 1,
    }))
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      workspaces: [{
        id: 'project-1', name: 'Project', slug: 'project', rootPath: projectRoot,
        createdAt: 1, directoryConfigId: 'directory-id',
      }],
      activeWorkspaceId: 'project-1', activeSessionId: null,
    }))

    try {
      const result = runIsolatedJson(configDir, 'SOURCE_MCP_LOCK', `
          import { registerSourcesHandlers } from '${SOURCES_HANDLER_PATH}';
          import { SessionManager } from '${SESSION_MANAGER_PATH}';
          import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
          import { loadStoredConfig, saveConfig } from '@craft-agent/shared/config';
          import { getSourceGrantRef, loadSource } from '@craft-agent/shared/sources';
          import { CraftMcpClient } from '@craft-agent/server-core/mcp';

          const source = loadSource(${JSON.stringify(projectRoot)}, 'foo', 'project-1');
          const hostConfig = loadStoredConfig();
          hostConfig.workspaces[0].defaultEnabledSourceRefs = [getSourceGrantRef(source)];
          saveConfig(hostConfig);

          let markListStarted;
          let finishList;
          const listStarted = new Promise(resolve => { markListStarted = resolve; });
          const listGate = new Promise(resolve => { finishList = resolve; });
          let closeCount = 0;
          const originalListTools = CraftMcpClient.prototype.listTools;
          const originalClose = CraftMcpClient.prototype.close;
          CraftMcpClient.prototype.listTools = async function () {
            markListStarted();
            await listGate;
            throw new Error('discovery failed');
          };
          CraftMcpClient.prototype.close = async function () { closeCount++; };

          const handlers = new Map();
          const server = { handle: (channel, handler) => handlers.set(channel, handler), push() {} };
          const logger = { info() {}, warn() {}, error() {}, debug() {} };
          const manager = new SessionManager();
          registerSourcesHandlers(server, { platform: { logger }, sessionManager: manager });
          const fetching = handlers.get(RPC_CHANNELS.sources.GET_MCP_TOOLS)(null, 'project-1', 'foo');
          await listStarted;
          const removal = manager.removeWorkspace('project-1');
          const removalState = await Promise.race([
            removal.then(() => 'removed'),
            Bun.sleep(100).then(() => 'blocked'),
          ]);
          finishList();
          const result = await fetching;
          await removal;
          CraftMcpClient.prototype.listTools = originalListTools;
          CraftMcpClient.prototype.close = originalClose;
          manager.cleanup();
          console.log('SOURCE_MCP_LOCK=' + JSON.stringify({
            removalState,
            success: result.success,
            error: result.error,
            closeCount,
          }));
        `)
      expect(result).toEqual({
        removalState: 'blocked',
        success: false,
        error: 'discovery failed',
        closeCount: 1,
      })
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})
