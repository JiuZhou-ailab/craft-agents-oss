// input: Label/status RPCs concurrent with Project relink/remove lifecycles
// output: Regression coverage for Project-root config IO serialization
// pos: Guards self-healing reads and mutations from using stale Project locators

import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runIsolatedJson } from '../../sessions/isolated-test-runner'

const LABELS_HANDLER_PATH = pathToFileURL(join(import.meta.dir, 'labels.ts')).href
const STATUSES_HANDLER_PATH = pathToFileURL(join(import.meta.dir, 'statuses.ts')).href
const SESSION_MANAGER_PATH = pathToFileURL(join(import.meta.dir, '..', '..', 'sessions', 'SessionManager.ts')).href

function writeProjectConfig(rootPath: string): void {
  mkdirSync(join(rootPath, '.craft-agent'), { recursive: true })
  writeFileSync(join(rootPath, '.craft-agent', 'config.json'), JSON.stringify({
    id: 'directory-id', name: 'Project', slug: 'project', createdAt: 1, updatedAt: 1,
  }))
}

describe('Project-root config RPC lifecycle', () => {
  it('serializes stable Project ID config IO with relink', () => {
    const parent = mkdtempSync(join(tmpdir(), 'storyflow-config-rpc-relink-'))
    const configDir = join(parent, 'host')
    const previousRoot = join(parent, 'previous')
    const currentRoot = join(parent, 'current')
    mkdirSync(configDir, { recursive: true })
    writeProjectConfig(previousRoot)
    writeProjectConfig(currentRoot)
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      workspaces: [{
        id: 'project-1', name: 'Project', slug: 'project', rootPath: previousRoot,
        createdAt: 1, directoryConfigId: 'directory-id',
      }],
      activeWorkspaceId: 'project-1', activeSessionId: null,
    }))

    try {
      const result = runIsolatedJson(configDir, 'CONFIG_RPC_RELINK', `
          import { existsSync } from 'node:fs';
          import { join } from 'node:path';
          import { registerLabelsHandlers } from '${LABELS_HANDLER_PATH}';
          import { registerStatusesHandlers } from '${STATUSES_HANDLER_PATH}';
          import { SessionManager } from '${SESSION_MANAGER_PATH}';
          import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
          import { loadStoredConfig, saveConfig } from '@craft-agent/shared/config';
          const handlers = new Map();
          const server = { handle: (channel, handler) => handlers.set(channel, handler), push() {} };
          const logger = { info() {}, warn() {}, error() {}, debug() {} };
          const manager = new SessionManager();
          const deps = { platform: { logger }, sessionManager: manager };
          registerLabelsHandlers(server, deps);
          registerStatusesHandlers(server, deps);

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
            handlers.get(RPC_CHANNELS.labels.LIST)(null, 'project-1'),
            handlers.get(RPC_CHANNELS.labels.CREATE)(null, 'project-1', {
              name: 'Release', color: 'foreground/50',
            }),
            handlers.get(RPC_CHANNELS.labels.DELETE)(null, 'project-1', 'bug'),
            handlers.get(RPC_CHANNELS.statuses.LIST)(null, 'project-1'),
            handlers.get(RPC_CHANNELS.statuses.REORDER)(null, 'project-1', [
              'todo', 'backlog', 'needs-review', 'done', 'cancelled',
            ]),
          ]);
          const stateBeforeRelease = await Promise.race([
            operations.then(() => 'completed'),
            Bun.sleep(100).then(() => 'blocked'),
          ]);
          finishLifecycle();
          await relocation;
          await operations;
          manager.cleanup();

          const hasProjectConfigWrites = rootPath =>
            existsSync(join(rootPath, '.craft-agent', 'labels', 'config.json'))
            || existsSync(join(rootPath, '.craft-agent', 'statuses', 'config.json'))
            || existsSync(join(rootPath, '.craft-agent', 'statuses', 'icons'));
          console.log('CONFIG_RPC_RELINK=' + JSON.stringify({
            stateBeforeRelease,
            activeRoot: loadStoredConfig().workspaces[0].rootPath,
            previousRootWritten: hasProjectConfigWrites(${JSON.stringify(previousRoot)}),
            currentRootWritten: hasProjectConfigWrites(${JSON.stringify(currentRoot)}),
          }));
        `)
      expect(result).toEqual({
        stateBeforeRelease: 'blocked',
        activeRoot: currentRoot,
        previousRootWritten: false,
        currentRootWritten: true,
      })
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('finishes an accepted self-healing read before Project removal', () => {
    const parent = mkdtempSync(join(tmpdir(), 'storyflow-config-rpc-remove-'))
    const configDir = join(parent, 'host')
    const projectRoot = join(parent, 'project')
    mkdirSync(configDir, { recursive: true })
    writeProjectConfig(projectRoot)
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      workspaces: [{
        id: 'project-1', name: 'Project', slug: 'project', rootPath: projectRoot,
        createdAt: 1, directoryConfigId: 'directory-id',
      }],
      activeWorkspaceId: 'project-1', activeSessionId: null,
    }))

    try {
      const result = runIsolatedJson(configDir, 'CONFIG_RPC_REMOVE', `
          import { existsSync } from 'node:fs';
          import { join } from 'node:path';
          import { registerStatusesHandlers } from '${STATUSES_HANDLER_PATH}';
          import { SessionManager } from '${SESSION_MANAGER_PATH}';
          import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
          import { loadStoredConfig } from '@craft-agent/shared/config';
          const handlers = new Map();
          const server = { handle: (channel, handler) => handlers.set(channel, handler), push() {} };
          const logger = { info() {}, warn() {}, error() {}, debug() {} };
          const manager = new SessionManager();
          const originalWithProjectLifecycle = manager.withProjectLifecycle.bind(manager);
          let markReadStarted;
          let finishRead;
          const readStarted = new Promise(resolve => { markReadStarted = resolve; });
          const readGate = new Promise(resolve => { finishRead = resolve; });
          manager.withProjectLifecycle = (projectId, work) => originalWithProjectLifecycle(
            projectId,
            async workspace => {
              markReadStarted();
              await readGate;
              return work(workspace);
            },
          );
          registerStatusesHandlers(server, { platform: { logger }, sessionManager: manager });

          const reading = handlers.get(RPC_CHANNELS.statuses.LIST)(null, 'project-1');
          const lifecycleEntered = await Promise.race([
            readStarted.then(() => true),
            reading.then(() => false),
            Bun.sleep(100).then(() => false),
          ]);
          if (!lifecycleEntered) {
            await reading;
            manager.cleanup();
            console.log('CONFIG_RPC_REMOVE=' + JSON.stringify({ lifecycleEntered }));
          } else {
            const removal = manager.removeWorkspace('project-1');
            const stateBeforeRelease = await Promise.race([
              removal.then(() => 'removed'),
              Bun.sleep(100).then(() => 'blocked'),
            ]);
            finishRead();
            await reading;
            await removal;
            manager.cleanup();
            console.log('CONFIG_RPC_REMOVE=' + JSON.stringify({
              lifecycleEntered,
              stateBeforeRelease,
              projectRemoved: loadStoredConfig().workspaces.length === 0,
              iconsWritten: existsSync(join(${JSON.stringify(projectRoot)}, '.craft-agent', 'statuses', 'icons')),
            }));
          }
        `)
      expect(result).toEqual({
        lifecycleEntered: true,
        stateBeforeRelease: 'blocked',
        projectRemoved: true,
        iconsWritten: true,
      })
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})
