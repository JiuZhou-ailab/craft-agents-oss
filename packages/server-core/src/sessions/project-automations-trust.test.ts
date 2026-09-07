// input: Isolated Host Project registrations with and without an Automations capability grant
// output: Regression coverage that Project files cannot start AutomationSystem by themselves
// pos: Guards the Host-owned execution boundary for project automations

import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getSourceDefinitionIdentity } from '@craft-agent/shared/sources'
import { runIsolatedJson } from './isolated-test-runner'

const SESSION_MANAGER_MODULE_PATH = pathToFileURL(join(import.meta.dir, 'SessionManager.ts')).href
const AUTOMATIONS_HANDLER_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'handlers', 'rpc', 'automations.ts')).href

function automationSystemCount(automationsEnabled?: boolean, remote = false): number {
  const parent = mkdtempSync(join(tmpdir(), 'storyflow-automation-trust-'))
  const configDir = join(parent, 'host')
  const projectRoot = join(parent, 'project')
  mkdirSync(join(projectRoot, '.craft-agent'), { recursive: true })
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(projectRoot, '.craft-agent', 'config.json'), JSON.stringify({
    id: 'directory-metadata-id',
    name: 'Project',
    slug: 'project',
    createdAt: 1,
    updatedAt: 1,
  }))
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    workspaces: [{
      id: 'project-1',
      name: 'Project',
      slug: 'project',
      rootPath: projectRoot,
      createdAt: 1,
      directoryConfigId: 'directory-metadata-id',
      ...(automationsEnabled === undefined ? {} : { automationsEnabled }),
      ...(remote ? { remoteServer: {
        url: 'wss://remote.example.test',
        credentialRef: 'remote_server_token::project-1',
        remoteWorkspaceId: 'remote-project-1',
      } } : {}),
    }],
    activeWorkspaceId: 'project-1',
    activeSessionId: null,
  }))

  try {
    const run = Bun.spawnSync([
      process.execPath,
      '--eval',
      `import { SessionManager } from '${SESSION_MANAGER_MODULE_PATH}'; const manager = new SessionManager(); manager.setupConfigWatcher(${JSON.stringify(projectRoot)}, 'project-1'); console.log('AUTOMATION_COUNT=' + manager['automationSystems'].size); manager.cleanup();`,
    ], {
      env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (run.exitCode !== 0) throw new Error(run.stderr.toString())
    const match = run.stdout.toString().match(/AUTOMATION_COUNT=(\d+)/)
    if (!match) throw new Error(`Missing automation count:\n${run.stdout.toString()}`)
    return Number(match[1])
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

function automationExecutionProbe(automationsEnabled: boolean): {
  directError?: string
  testError?: string
  replayError?: string
  options?: { permissionMode?: string; enabledSourceSlugs?: string[]; isPinned?: boolean }
} {
  const parent = mkdtempSync(join(tmpdir(), 'storyflow-automation-execution-'))
  const configDir = join(parent, 'host')
  const projectRoot = join(parent, 'project')
  mkdirSync(join(projectRoot, '.craft-agent'), { recursive: true })
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(projectRoot, '.craft-agent', 'config.json'), JSON.stringify({
    id: 'directory-metadata-id', name: 'Project', slug: 'project', createdAt: 1, updatedAt: 1,
  }))
  let allowedSourceRef = ''
  for (const slug of ['allowed', 'blocked']) {
    const sourceDir = join(projectRoot, '.craft-agent', 'sources', slug)
    mkdirSync(sourceDir, { recursive: true })
    const config = {
      id: slug,
      slug,
      name: slug,
      type: 'api',
      enabled: true,
      api: { baseUrl: 'https://example.com', authType: 'none' },
    } as const
    writeFileSync(join(sourceDir, 'config.json'), JSON.stringify(config))
    if (slug === 'allowed') {
      allowedSourceRef = `workspace:${slug}:${getSourceDefinitionIdentity(config as any)}`
    }
  }
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    workspaces: [{
      id: 'project-1', name: 'Project', slug: 'project', rootPath: projectRoot, createdAt: 1,
      directoryConfigId: 'directory-metadata-id',
      automationsEnabled,
      defaultPermissionMode: 'ask',
      defaultEnabledSourceRefs: [allowedSourceRef],
    }],
    activeWorkspaceId: 'project-1', activeSessionId: null,
  }))

  try {
    return runIsolatedJson(configDir, 'PROBE', `
        import { SessionManager } from '${SESSION_MANAGER_MODULE_PATH}';
        import { registerAutomationsHandlers } from '${AUTOMATIONS_HANDLER_MODULE_PATH}';
        import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
        const manager = new SessionManager();
        let captured;
        manager.resolveAutomationMentions = async () => ({ sourceSlugs: ['allowed', 'blocked'], skillSlugs: [] });
        const createSession = async (_workspaceId, options) => { captured = options; return { id: 'session-1' }; };
        manager.createSession = createSession;
        manager.createSessionLocked = createSession;
        manager.sendMessage = async () => {};
        let directError;
        try {
          await manager.executePromptAutomation({
            workspaceId: 'project-1',
            workspaceRootPath: ${JSON.stringify(projectRoot)},
            prompt: 'run',
            permissionMode: 'allow-all',
            mentions: ['allowed', 'blocked'],
          });
        } catch (error) { directError = error.message; }

        const handlers = new Map();
        const logger = { info() {}, warn() {}, error() {}, debug() {} };
        registerAutomationsHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
          platform: { logger },
          sessionManager: manager,
        });
        let testError;
        let replayError;
        if (${JSON.stringify(!automationsEnabled)}) {
          try {
            await handlers.get(RPC_CHANNELS.automations.TEST)(null, {
              workspaceId: 'project-1',
              actions: [{ type: 'webhook', url: 'http://127.0.0.1:9' }],
            });
          } catch (error) { testError = error.message; }
          try {
            await handlers.get(RPC_CHANNELS.automations.REPLAY)(null, 'project-1', 'automation-1', 'Manual');
          } catch (error) { replayError = error.message; }
        }
        manager.cleanup();
        console.log('PROBE=' + JSON.stringify({ directError, testError, replayError, options: captured }));
      `)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

function automationDisableRaceProbe(): {
  outcome: string
  promptError?: string
  sessionCount: number
  labelConfigExists: boolean
} {
  const parent = mkdtempSync(join(tmpdir(), 'storyflow-automation-disable-race-'))
  const configDir = join(parent, 'host')
  const projectRoot = join(parent, 'project')
  mkdirSync(join(projectRoot, '.craft-agent'), { recursive: true })
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(projectRoot, '.craft-agent', 'config.json'), JSON.stringify({
    id: 'directory-metadata-id', name: 'Project', slug: 'project', createdAt: 1, updatedAt: 1,
  }))
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    workspaces: [{
      id: 'project-1', name: 'Project', slug: 'project', rootPath: projectRoot, createdAt: 1,
      directoryConfigId: 'directory-metadata-id', automationsEnabled: true,
    }],
    activeWorkspaceId: 'project-1', activeSessionId: null,
  }))

  try {
    return runIsolatedJson(configDir, 'DISABLE_RACE', `
        import { existsSync } from 'node:fs';
        import { SessionManager } from '${SESSION_MANAGER_MODULE_PATH}';
        const manager = new SessionManager();
        let releaseMentions;
        let markMentionsStarted;
        const mentionsStarted = new Promise(resolve => { markMentionsStarted = resolve; });
        manager.resolveAutomationMentions = async () => {
          markMentionsStarted();
          return new Promise(resolve => { releaseMentions = resolve; });
        };
        const prompt = manager.executePromptAutomation({
          workspaceId: 'project-1',
          workspaceRootPath: ${JSON.stringify(projectRoot)},
          prompt: 'run',
          mentions: ['delayed'],
          labels: ['must-not-be-created'],
        }).then(() => ({}), error => ({ error: error.message }));
        await mentionsStarted;
        manager.automationSystems.set(${JSON.stringify(projectRoot)}, {
          dispose() {
            releaseMentions({ sourceSlugs: [], skillSlugs: [] });
            return prompt.then(() => {});
          },
        });
        const outcome = await Promise.race([
          manager.updateProjectHostSetting('project-1', 'automationsEnabled', false).then(() => 'disabled'),
          new Promise(resolve => setTimeout(() => resolve('timeout'), 500)),
        ]);
        const promptResult = await Promise.race([
          prompt,
          new Promise(resolve => setTimeout(() => resolve({ error: 'timeout' }), 500)),
        ]);
        console.log('DISABLE_RACE=' + JSON.stringify({
          outcome,
          promptError: promptResult.error,
          sessionCount: manager.sessions.size,
          labelConfigExists: existsSync(${JSON.stringify(join(projectRoot, '.craft-agent', 'labels', 'config.json'))}),
        }));
        manager.cleanup();
      `)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

describe('Project Automations trust', () => {
  it('does not start Project automations without a Host grant', () => {
    expect(automationSystemCount()).toBe(0)
  })

  it('starts Project automations after an explicit Host grant', () => {
    expect(automationSystemCount(true)).toBe(1)
  })

  it('does not start local automations for a remote-owned Project', () => {
    expect(automationSystemCount(true, true)).toBe(0)
  })

  it('rejects converting an observed local Project into a remote Project', () => {
    const parent = mkdtempSync(join(tmpdir(), 'storyflow-local-remote-conversion-'))
    const configDir = join(parent, 'host')
    const projectRoot = join(parent, 'project')
    mkdirSync(join(projectRoot, '.craft-agent'), { recursive: true })
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(projectRoot, '.craft-agent', 'config.json'), JSON.stringify({
      id: 'directory-metadata-id', name: 'Project', slug: 'project', createdAt: 1, updatedAt: 1,
    }))
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      workspaces: [{
        id: 'project-1', name: 'Project', slug: 'project', rootPath: projectRoot, createdAt: 1,
        directoryConfigId: 'directory-metadata-id', automationsEnabled: true,
      }],
      activeWorkspaceId: 'project-1', activeSessionId: null,
    }))

    try {
      const run = Bun.spawnSync([
        process.execPath,
        '--eval',
        `
          import { SessionManager } from '${SESSION_MANAGER_MODULE_PATH}';
          const manager = new SessionManager();
          manager.setupConfigWatcher(${JSON.stringify(projectRoot)}, 'project-1');
          const before = { watchers: manager.configWatchers.size, automations: manager.automationSystems.size };
          let error;
          try {
            await manager.registerProject('Project', ${JSON.stringify(projectRoot)}, {
              url: 'wss://remote.example.test', token: 'secret', remoteWorkspaceId: 'remote-project',
            });
          } catch (cause) { error = cause.message; }
          const workspace = manager.getWorkspaces()[0];
          console.log('LOCAL_REMOTE_RESULT=' + JSON.stringify({
            error,
            before,
            after: { watchers: manager.configWatchers.size, automations: manager.automationSystems.size },
            becameRemote: Boolean(workspace.remoteServer),
          }));
          manager.cleanup();
        `,
      ], {
        env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
        stdout: 'pipe', stderr: 'pipe',
      })
      if (run.exitCode !== 0) throw new Error(run.stderr.toString())
      const match = run.stdout.toString().match(/LOCAL_REMOTE_RESULT=(\{.*\})/)
      if (!match) throw new Error(`Missing local/remote result:\n${run.stdout.toString()}`)
      expect(JSON.parse(match[1])).toEqual({
        error: expect.stringContaining('cannot be converted'),
        before: { watchers: 1, automations: 1 },
        after: { watchers: 1, automations: 1 },
        becameRemote: false,
      })
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('requires the reconnect path for an existing remote Project', () => {
    const parent = mkdtempSync(join(tmpdir(), 'storyflow-remote-recreate-'))
    const configDir = join(parent, 'host')
    const projectRoot = join(parent, 'project')
    mkdirSync(join(projectRoot, '.craft-agent'), { recursive: true })
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(projectRoot, '.craft-agent', 'config.json'), JSON.stringify({
      id: 'directory-metadata-id', name: 'Remote', slug: 'remote', createdAt: 1, updatedAt: 1,
    }))
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      workspaces: [{
        id: 'project-1', name: 'Remote', slug: 'remote', rootPath: projectRoot, createdAt: 1,
        directoryConfigId: 'directory-metadata-id',
        remoteServer: {
          url: 'wss://old.example.test',
          credentialRef: 'remote_server_token::project-1',
          remoteWorkspaceId: 'remote-project',
        },
      }],
      activeWorkspaceId: 'project-1', activeSessionId: null,
    }))

    try {
      const run = Bun.spawnSync([
        process.execPath,
        '--eval',
        `
          import { getCredentialManager } from '@craft-agent/shared/credentials';
          import { SessionManager } from '${SESSION_MANAGER_MODULE_PATH}';
          const credentials = getCredentialManager();
          await credentials.setRemoteServerToken('project-1', 'old-token');
          const manager = new SessionManager();
          let error;
          try {
            await manager.registerProject('Remote', ${JSON.stringify(projectRoot)}, {
              url: 'wss://new.example.test', token: 'new-token', remoteWorkspaceId: 'remote-project',
            });
          } catch (cause) { error = cause.message; }
          console.log('REMOTE_RECREATE_RESULT=' + JSON.stringify({
            error,
            url: manager.getWorkspaces()[0].remoteServer.url,
            token: await credentials.getRemoteServerToken('project-1'),
          }));
          manager.cleanup();
        `,
      ], {
        env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
        stdout: 'pipe', stderr: 'pipe',
      })
      if (run.exitCode !== 0) throw new Error(run.stderr.toString())
      const match = run.stdout.toString().match(/REMOTE_RECREATE_RESULT=(\{.*\})/)
      if (!match) throw new Error(`Missing remote recreate result:\n${run.stdout.toString()}`)
      expect(JSON.parse(match[1])).toEqual({
        error: expect.stringContaining('reconnect'),
        url: 'wss://old.example.test',
        token: 'old-token',
      })
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('blocks direct, test, and replay execution without a Host grant', () => {
    const probe = automationExecutionProbe(false)
    expect(probe.directError).toContain('disabled by Host settings')
    expect(probe.testError).toContain('disabled by Host settings')
    expect(probe.replayError).toContain('disabled by Host settings')
  })

  it('caps automation capabilities to the Host grants', () => {
    const probe = automationExecutionProbe(true)
    expect(probe.directError).toBeUndefined()
    expect(probe.options?.permissionMode).toBe('ask')
    expect(probe.options?.enabledSourceSlugs).toEqual(['allowed'])
    expect(probe.options?.isPinned).toBe(true)
  })

  it('drains an accepted prompt outside the Project lock and rechecks the Host grant', () => {
    expect(automationDisableRaceProbe()).toEqual({
      outcome: 'disabled',
      promptError: expect.stringContaining('disabled by Host settings'),
      sessionCount: 0,
      labelConfigExists: false,
    })
  })
})
