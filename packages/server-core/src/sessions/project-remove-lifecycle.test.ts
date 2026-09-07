// input: A registered Project with idle in-memory and durable Sessions
// output: Runtime teardown before Host-only removal, followed by clean re-registration
// pos: Regression coverage for Project removal without deleting user-owned files

import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runIsolatedJson } from './isolated-test-runner'

const SESSION_MANAGER_MODULE_PATH = pathToFileURL(join(import.meta.dir, 'SessionManager.ts')).href

describe('Project removal lifecycle', () => {
  it('serializes an explicit reload ahead of Session deletion', async () => {
    const managerModule = await import('./SessionManager')
    const manager = new managerModule.SessionManager()
    const events: string[] = []
    let releaseReload!: () => void
    const reloadGate = new Promise<void>(resolve => { releaseReload = resolve })
    ;(manager as any).persistence.loadSessionsFromDisk = async () => {
      events.push('reload:start')
      await reloadGate
      events.push('reload:end')
    }
    ;(manager as any).sessions.set('session-reload-race', {
      id: 'session-reload-race',
      workspace: { id: 'project-reload-race' },
    })
    ;(manager as any).deleteSessionLocked = async () => {
      events.push('delete')
    }

    const reload = manager.reloadSessions('project-reload-race')
    while (!events.includes('reload:start')) await Promise.resolve()
    const deletion = manager.deleteSession('session-reload-race')
    await Promise.resolve()
    expect(events).toEqual(['reload:start'])

    releaseReload()
    await Promise.all([reload, deletion])
    expect(events).toEqual(['reload:start', 'reload:end', 'delete'])
    ;(manager as any).sessions.clear()
    manager.cleanup()
  })

  it('locks the selected target root while a Project relink is in flight', () => {
    const parent = mkdtempSync(join(tmpdir(), 'storyflow-relink-target-lock-'))
    const configDir = join(parent, 'host')
    const previousRoot = join(parent, 'missing-old-root')
    const targetRoot = join(parent, 'target')
    mkdirSync(join(targetRoot, '.craft-agent'), { recursive: true })
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(targetRoot, '.craft-agent', 'config.json'), JSON.stringify({
      id: 'target-directory-id', name: 'Target', slug: 'target', createdAt: 1, updatedAt: 1,
    }))
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      workspaces: [{
        id: 'legacy-project', name: 'Legacy', slug: 'legacy', rootPath: previousRoot,
        createdAt: 1, directoryConfigId: 'target-directory-id',
      }],
      activeWorkspaceId: 'legacy-project', activeSessionId: null,
    }))

    try {
      const result = runIsolatedJson(configDir, 'RELINK_TARGET_LOCK_RESULT', `
          import { SessionManager } from '${SESSION_MANAGER_MODULE_PATH}';
          const manager = new SessionManager();
          const events = [];
          let releaseRelink;
          const relinkGate = new Promise(resolve => { releaseRelink = resolve; });
          manager.rebindWorkspaceRootLocked = async () => {
            events.push('relink:start');
            await relinkGate;
            events.push('relink:end');
            return { id: 'legacy-project', rootPath: ${JSON.stringify(targetRoot)} };
          };
          manager.reloadSessions = async () => { events.push('register:reload'); };
          manager.setupConfigWatcher = () => {};
          const relink = manager.rebindWorkspaceRoot('legacy-project', ${JSON.stringify(targetRoot)});
          while (!events.includes('relink:start')) await Bun.sleep(0);
          const registrationError = await manager.registerProject('Target', ${JSON.stringify(targetRoot)})
            .then(() => null, error => error.message);
          const during = [...events];
          releaseRelink();
          await relink;
          console.log('RELINK_TARGET_LOCK_RESULT=' + JSON.stringify({ during, after: events, registrationError }));
          manager.cleanup();
        `)
      expect(result).toEqual({
        during: ['relink:start'],
        after: ['relink:start', 'relink:end'],
        registrationError: expect.stringContaining('removed or relinked'),
      })
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('fails same-root Project operations fast during removal', () => {
    const parent = mkdtempSync(join(tmpdir(), 'storyflow-register-remove-race-'))
    const configDir = join(parent, 'host')
    const projectRoot = join(parent, 'project')
    mkdirSync(join(projectRoot, '.craft-agent'), { recursive: true })
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(projectRoot, '.craft-agent', 'config.json'), JSON.stringify({
      id: 'directory-id', name: 'Project', slug: 'project', createdAt: 1, updatedAt: 1,
    }))
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      workspaces: [{
        id: 'project-old', name: 'Project', slug: 'project', rootPath: projectRoot,
        createdAt: 1, directoryConfigId: 'directory-id',
      }],
      activeWorkspaceId: 'project-old', activeSessionId: null,
    }))

    try {
      const result = runIsolatedJson(configDir, 'REGISTER_REMOVE_RESULT', `
          import { SessionManager } from '${SESSION_MANAGER_MODULE_PATH}';
          const manager = new SessionManager();
          const events = [];
          let releaseRemoval;
          const removalBlocked = new Promise(resolve => { releaseRemoval = resolve; });
          manager.removeWorkspaceLocked = async () => {
            events.push('remove:start');
            await removalBlocked;
            events.push('remove:end');
            return true;
          };
          manager.reloadSessions = async () => { events.push('register:reload'); };
          let watcherCalls = 0;
          manager.setupConfigWatcher = () => { events.push('watch:' + ++watcherCalls); };
          const removal = manager.removeWorkspace('project-old');
          while (!events.includes('remove:start')) await Bun.sleep(0);
          const [registrationError, activationError] = await Promise.all([
            manager.registerProject('Project', ${JSON.stringify(projectRoot)})
              .then(() => null, error => error.message),
            manager.activateProject('project-old')
              .then(() => null, error => error.message),
          ]);
          const during = [...events];
          releaseRemoval();
          await removal;
          console.log('REGISTER_REMOVE_RESULT=' + JSON.stringify({
            during, after: events, registrationError, activationError,
          }));
          manager.cleanup();
        `)
      expect(result).toEqual({
        during: ['remove:start'],
        after: ['remove:start', 'remove:end'],
        registrationError: expect.stringContaining('removed or relinked'),
        activationError: expect.stringContaining('removed or relinked'),
      })
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('fails remote reconnect fast during Project removal', () => {
    const parent = mkdtempSync(join(tmpdir(), 'storyflow-remote-remove-race-'))
    const configDir = join(parent, 'host')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      workspaces: [{
        id: 'remote-project', name: 'Remote', slug: 'remote', rootPath: join(parent, 'remote'),
        createdAt: 1,
        remoteServer: {
          url: 'wss://old.example.test',
          credentialRef: 'remote_server_token::remote-project',
          remoteWorkspaceId: 'upstream-project',
        },
      }],
      activeWorkspaceId: 'remote-project', activeSessionId: null,
    }))

    try {
      const result = runIsolatedJson(configDir, 'REMOTE_REMOVE_RESULT', `
          import { SessionManager } from '${SESSION_MANAGER_MODULE_PATH}';
          const manager = new SessionManager();
          const events = [];
          let releaseRemoval;
          const removalBlocked = new Promise(resolve => { releaseRemoval = resolve; });
          manager.removeWorkspaceLocked = async () => {
            events.push('remove:start');
            await removalBlocked;
            events.push('remove:end');
            return true;
          };
          manager.updateRemoteProjectLocked = async () => { events.push('remote:update'); };
          const removal = manager.removeWorkspace('remote-project');
          while (!events.includes('remove:start')) await Bun.sleep(0);
          const updateError = await manager.updateRemoteProject('remote-project', {
            url: 'wss://new.example.test', token: 'secret', remoteWorkspaceId: 'upstream-project',
          }).then(() => null, error => error.message);
          const during = [...events];
          releaseRemoval();
          await removal;
          console.log('REMOTE_REMOVE_RESULT=' + JSON.stringify({ during, after: events, updateError }));
          manager.cleanup();
        `)
      expect(result).toEqual({
        during: ['remove:start'],
        after: ['remove:start', 'remove:end'],
        updateError: expect.stringContaining('removed or relinked'),
      })
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('serializes boot observer startup behind Project removal', () => {
    const parent = mkdtempSync(join(tmpdir(), 'storyflow-boot-remove-race-'))
    const configDir = join(parent, 'host')
    const projectRoot = join(parent, 'project')
    mkdirSync(join(projectRoot, '.craft-agent'), { recursive: true })
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(projectRoot, '.craft-agent', 'config.json'), JSON.stringify({
      id: 'directory-id', name: 'Project', slug: 'project', createdAt: 1, updatedAt: 1,
    }))
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      workspaces: [{
        id: 'project-old', name: 'Project', slug: 'project', rootPath: projectRoot,
        createdAt: 1, directoryConfigId: 'directory-id', automationsEnabled: true,
      }],
      activeWorkspaceId: 'project-old', activeSessionId: null,
    }))

    try {
      const run = Bun.spawnSync([
        process.execPath,
        '--eval',
        `
          import { SessionManager } from '${SESSION_MANAGER_MODULE_PATH}';
          const manager = new SessionManager();
          const events = [];
          const bootWorkspaceIds = [];
          let releaseDispose;
          const disposeBlocked = new Promise(resolve => { releaseDispose = resolve; });
          manager.configWatchers.set(${JSON.stringify(projectRoot)}, { stop() { events.push('watcher:stop'); } });
          manager.automationSystems.set(${JSON.stringify(projectRoot)}, {
            async dispose() {
              events.push('automation:dispose-start');
              await disposeBlocked;
              events.push('automation:dispose-end');
            },
          });
          manager.reinitializeAuth = async () => {};
          manager.setupConfigWatcher = (rootPath, projectId) => {
            bootWorkspaceIds.push(projectId);
            if (projectId === 'project-old') events.push('boot:setup');
            manager.configWatchers.set(rootPath, { stop() {} });
            manager.automationSystems.set(rootPath, { async dispose() {} });
          };
          const removal = manager.removeWorkspace('project-old');
          while (!events.includes('automation:dispose-start')) await Bun.sleep(0);
          const boot = manager.persistence.deps.prepareBootServices();
          await Bun.sleep(20);
          const during = [...events];
          releaseDispose();
          const removed = await removal;
          await boot;
          console.log('BOOT_REMOVE_RESULT=' + JSON.stringify({
            removed,
            during,
            after: events,
            bootWorkspaceIds,
            watchers: manager.configWatchers.size,
            automations: manager.automationSystems.size,
            hostCount: manager.getWorkspaces().length,
          }));
          manager.cleanup();
        `,
      ], {
        env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
        stdout: 'pipe', stderr: 'pipe',
      })
      if (run.exitCode !== 0) throw new Error(run.stderr.toString())
      const match = run.stdout.toString().match(/BOOT_REMOVE_RESULT=(\{.*\})/)
      if (!match) throw new Error(`Missing boot/remove result:\n${run.stdout.toString()}`)
      expect(JSON.parse(match[1])).toEqual({
        removed: true,
        during: ['watcher:stop', 'automation:dispose-start'],
        after: ['watcher:stop', 'automation:dispose-start', 'automation:dispose-end'],
        bootWorkspaceIds: ['__storyflow_free__'],
        watchers: 1,
        automations: 1,
        hostCount: 0,
      })
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('clears runtime ownership without deleting the Project directory', () => {
    const parent = mkdtempSync(join(tmpdir(), 'storyflow-remove-project-'))
    const configDir = join(parent, 'host')
    const projectRoot = join(parent, 'project')
    const sessionDir = join(projectRoot, '.craft-agent', 'sessions', 'session-1')
    mkdirSync(sessionDir, { recursive: true })
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(projectRoot, '.craft-agent', 'config.json'), JSON.stringify({
      id: 'directory-id', name: 'Project', slug: 'project', createdAt: 1, updatedAt: 1,
    }))
    writeFileSync(join(sessionDir, 'session.jsonl'), `${JSON.stringify({
      id: 'session-1', createdAt: 1, lastUsedAt: 1, messageCount: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    })}\n`)
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      workspaces: [{
        id: 'project-old', name: 'Project', slug: 'project', rootPath: projectRoot,
        createdAt: 1, directoryConfigId: 'directory-id',
      }],
      activeWorkspaceId: 'project-old', activeSessionId: null,
    }))

    try {
      const result = runIsolatedJson<{
        removed: boolean
        runtimeCountAfterRemove: number
        readdedId: string
        reloadedCount: number
      }>(configDir, 'REMOVE_RESULT', `
          import { SessionManager, createManagedSession } from '${SESSION_MANAGER_MODULE_PATH}';
          import { registerLocalProject } from '@craft-agent/shared/workspaces';
          const manager = new SessionManager();
          const workspace = manager.getWorkspaces()[0];
          const managed = createManagedSession({ id: 'session-1' }, workspace, { messagesLoaded: true });
          manager.sessions.set(managed.id, managed);
          const removed = await manager.removeWorkspace('project-old');
          const runtimeCountAfterRemove = manager.getSessions('project-old').length;
          const readded = registerLocalProject('Project', ${JSON.stringify(projectRoot)});
          await manager.reloadSessions(readded.id);
          console.log('REMOVE_RESULT=' + JSON.stringify({
            removed,
            runtimeCountAfterRemove,
            readdedId: readded.id,
            reloadedCount: manager.getSessions(readded.id).length,
          }));
          manager.cleanup();
        `)
      expect(result).toMatchObject({
        removed: true,
        runtimeCountAfterRemove: 0,
        reloadedCount: 1,
      })
      expect(result.readdedId).not.toBe('project-old')
      expect(existsSync(projectRoot)).toBe(true)
      expect(existsSync(join(sessionDir, 'session.jsonl'))).toBe(true)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('retires writes accepted by a runtime lease before Project removal returns', () => {
    const parent = mkdtempSync(join(tmpdir(), 'storyflow-remove-project-write-barrier-'))
    const configDir = join(parent, 'host')
    const projectRoot = join(parent, 'project')
    const sessionDir = join(projectRoot, '.craft-agent', 'sessions', 'session-1')
    mkdirSync(sessionDir, { recursive: true })
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(projectRoot, '.craft-agent', 'config.json'), JSON.stringify({
      id: 'directory-id', name: 'Project', slug: 'project', createdAt: 1, updatedAt: 1,
    }))
    writeFileSync(join(sessionDir, 'session.jsonl'), `${JSON.stringify({
      id: 'session-1', name: 'Old title', createdAt: 1, lastUsedAt: 1, messageCount: 1,
    })}\n${JSON.stringify({ id: 'message-1', type: 'user', content: 'rename me', timestamp: 1 })}\n`)
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      workspaces: [{
        id: 'project-old', name: 'Project', slug: 'project', rootPath: projectRoot,
        createdAt: 1, directoryConfigId: 'directory-id',
      }],
      activeWorkspaceId: 'project-old', activeSessionId: null,
    }))

    try {
      const result = runIsolatedJson(configDir, 'REMOVE_WRITE_BARRIER_RESULT', `
          import { SessionManager, createManagedSession } from '${SESSION_MANAGER_MODULE_PATH}';
          import { sessionPersistenceQueue } from '@craft-agent/shared/sessions';
          const manager = new SessionManager();
          const workspace = manager.getWorkspaces()[0];
          const managed = createManagedSession({ id: 'session-1', name: 'Old title' }, workspace, { messagesLoaded: true });
          managed.messages = [{ id: 'message-1', role: 'user', content: 'rename me', timestamp: 1 }];
          let markTitleStarted;
          let releaseTitle;
          const titleStarted = new Promise(resolve => { markTitleStarted = resolve; });
          const titleGate = new Promise(resolve => { releaseTitle = resolve; });
          const agent = {
            regenerateTitle: async () => { markTitleStarted(); await titleGate; return 'New title'; },
            dispose: () => {},
          };
          managed.agent = agent;
          manager.sessions.set(managed.id, managed);
          manager.getOrCreateAgentLocked = async () => agent;
          manager.persistSession(managed);
          await manager.flushSession(managed.id);

          const title = manager.refreshTitle(managed.id);
          await titleStarted;
          const originalRuntimeLock = manager.withAgentRuntimeLock.bind(manager);
          let markRuntimeWaitStarted;
          const runtimeWaitStarted = new Promise(resolve => { markRuntimeWaitStarted = resolve; });
          manager.withAgentRuntimeLock = async (...args) => {
            markRuntimeWaitStarted();
            return originalRuntimeLock(...args);
          };
          const removal = manager.removeWorkspace(workspace.id);
          await runtimeWaitStarted;
          releaseTitle();
          const [titleResult, removed] = await Promise.all([title, removal]);
          console.log('REMOVE_WRITE_BARRIER_RESULT=' + JSON.stringify({
            removed,
            title: titleResult.title,
            hasPending: sessionPersistenceQueue.hasPending(managed.id),
          }));
          manager.cleanup();
        `)
      expect(result).toEqual({
        removed: true,
        title: 'New title',
        hasPending: false,
      })
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('removes a recovered Project without losing loaded or cold transcripts', () => {
    const parent = mkdtempSync(join(tmpdir(), 'storyflow-remove-project-recovered-'))
    const configDir = join(parent, 'host')
    const projectRoot = join(parent, 'project')
    const offlineRoot = join(parent, 'project-offline')
    const loadedSessionDir = join(projectRoot, '.craft-agent', 'sessions', 'session-loaded')
    const coldSessionDir = join(projectRoot, '.craft-agent', 'sessions', 'session-cold')
    const openedSessionDir = join(projectRoot, '.craft-agent', 'sessions', 'session-opened')
    mkdirSync(loadedSessionDir, { recursive: true })
    mkdirSync(coldSessionDir, { recursive: true })
    mkdirSync(openedSessionDir, { recursive: true })
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(projectRoot, '.craft-agent', 'config.json'), JSON.stringify({
      id: 'directory-id', name: 'Project', slug: 'project', createdAt: 1, updatedAt: 1,
    }))
    for (const [sessionDir, sessionId, messageId] of [
      [loadedSessionDir, 'session-loaded', 'loaded-message'],
      [coldSessionDir, 'session-cold', 'cold-message'],
      [openedSessionDir, 'session-opened', 'opened-message'],
    ] as const) {
      writeFileSync(join(sessionDir, 'session.jsonl'), [
        JSON.stringify({
          id: sessionId, createdAt: 1, lastUsedAt: 1, messageCount: 1,
          tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
        }),
        JSON.stringify({
          id: messageId,
          type: 'user',
          content: 'disk survives',
          timestamp: 1,
          ...(sessionId === 'session-cold' ? { isQueued: true } : {}),
        }),
        '',
      ].join('\n'))
    }
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      workspaces: [{
        id: 'project-old', name: 'Project', slug: 'project', rootPath: projectRoot,
        createdAt: 1, directoryConfigId: 'directory-id',
      }],
      activeWorkspaceId: 'project-old', activeSessionId: null,
    }))

    try {
      const run = Bun.spawnSync([
        process.execPath,
        '--eval',
        `
          import { readFileSync, renameSync } from 'node:fs';
          import { join } from 'node:path';
          import { SessionManager, createManagedSession } from '${SESSION_MANAGER_MODULE_PATH}';
          const manager = new SessionManager();
          const workspace = manager.getWorkspaces()[0];
          const loaded = createManagedSession({ id: 'session-loaded' }, workspace, { messagesLoaded: true });
          loaded.messages = [{ id: 'loaded-message', role: 'user', content: 'disk survives', timestamp: 1 }];
          const cold = createManagedSession({ id: 'session-cold' }, workspace, { messagesLoaded: false });
          const opened = createManagedSession({ id: 'session-opened' }, workspace, { messagesLoaded: false });
          manager.sessions.set(loaded.id, loaded);
          manager.sessions.set(cold.id, cold);
          manager.sessions.set(opened.id, opened);
          let queuedRecoveryCalls = 0;
          manager.processNextQueuedMessage = () => { queuedRecoveryCalls += 1; };
          renameSync(${JSON.stringify(projectRoot)}, ${JSON.stringify(offlineRoot)});
          const errors = {};
          try { await manager.setSessionLabels('session-loaded', ['latest-loaded']); } catch (error) { errors.loaded = error.message; }
          try { await manager.setSessionLabels('session-cold', ['latest-cold']); } catch (error) { errors.cold = error.message; }
          try { await manager.getSession('session-opened'); } catch (error) { errors.opened = error.message; }
          const coldStayedCold = cold.messagesLoaded === false;
          const openedStayedCold = opened.messagesLoaded === false;
          renameSync(${JSON.stringify(offlineRoot)}, ${JSON.stringify(projectRoot)});
          const removed = await manager.removeWorkspace('project-old');
          await Bun.sleep(0);
          const readSession = path => readFileSync(path, 'utf8').trim().split('\\n').map(line => JSON.parse(line));
          const loadedLines = readSession(join(${JSON.stringify(loadedSessionDir)}, 'session.jsonl'));
          const coldLines = readSession(join(${JSON.stringify(coldSessionDir)}, 'session.jsonl'));
          const openedLines = readSession(join(${JSON.stringify(openedSessionDir)}, 'session.jsonl'));
          console.log('RECOVERED_REMOVE_RESULT=' + JSON.stringify({
            removed,
            errors,
            coldStayedCold,
            openedStayedCold,
            queuedRecoveryCalls,
            loaded: { labels: loadedLines[0].labels, messageIds: loadedLines.slice(1).map(line => line.id) },
            cold: {
              labels: coldLines[0].labels,
              messageIds: coldLines.slice(1).map(line => line.id),
              isQueued: coldLines[1].isQueued,
            },
            opened: { messageIds: openedLines.slice(1).map(line => line.id) },
          }));
          manager.cleanup();
        `,
      ], {
        env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
        stdout: 'pipe', stderr: 'pipe',
      })
      if (run.exitCode !== 0) throw new Error(run.stderr.toString())
      const match = run.stdout.toString().match(/RECOVERED_REMOVE_RESULT=(\{.*\})/)
      if (!match) {
        throw new Error(`Missing recovered remove result:\n${run.stderr.toString()}\n${run.stdout.toString()}`)
      }
      expect(JSON.parse(match[1])).toEqual({
        removed: true,
        errors: {
          loaded: expect.stringContaining('relink Project'),
          cold: expect.stringContaining('relink Project'),
          opened: expect.stringContaining('relink Project'),
        },
        coldStayedCold: true,
        openedStayedCold: true,
        queuedRecoveryCalls: 0,
        loaded: { messageIds: ['loaded-message'] },
        cold: { messageIds: ['cold-message'], isQueued: true },
        opened: { messageIds: ['opened-message'] },
      })
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('keeps Host and in-memory Sessions when the Host commit fails', () => {
    const parent = mkdtempSync(join(tmpdir(), 'storyflow-remove-project-rollback-'))
    const configDir = join(parent, 'host')
    const projectRoot = join(parent, 'project')
    mkdirSync(join(projectRoot, '.craft-agent'), { recursive: true })
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(projectRoot, '.craft-agent', 'config.json'), JSON.stringify({
      id: 'directory-id', name: 'Project', slug: 'project', createdAt: 1, updatedAt: 1,
    }))
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      workspaces: [{
        id: 'project-old', name: 'Project', slug: 'project', rootPath: projectRoot,
        createdAt: 1, directoryConfigId: 'directory-id',
      }],
      activeWorkspaceId: 'project-old', activeSessionId: null,
    }))
    try {
      const run = Bun.spawnSync([
        process.execPath,
        '--eval',
        `
          import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
          import { SessionManager, createManagedSession } from '${SESSION_MANAGER_MODULE_PATH}';
          const manager = new SessionManager();
          const workspace = manager.getWorkspaces()[0];
          const managed = createManagedSession({ id: 'session-1' }, workspace, { messagesLoaded: true });
          manager.sessions.set(managed.id, managed);
          let markFlushEntered;
          const flushEntered = new Promise(resolve => { markFlushEntered = resolve; });
          let releaseFlush;
          manager.flushSession = () => new Promise(resolve => {
            releaseFlush = resolve;
            markFlushEntered();
          });
          const removal = manager.removeWorkspace('project-old');
          await flushEntered;
          const blockedConfigDir = ${JSON.stringify(configDir)} + '.blocked';
          renameSync(${JSON.stringify(configDir)}, blockedConfigDir);
          writeFileSync(${JSON.stringify(configDir)}, 'blocked');
          releaseFlush();
          let error;
          try { await removal; } catch (cause) { error = cause.message; }
          unlinkSync(${JSON.stringify(configDir)});
          renameSync(blockedConfigDir, ${JSON.stringify(configDir)});
          console.log('ROLLBACK_RESULT=' + JSON.stringify({
            error,
            runtimeCount: manager.getSessions('project-old').length,
            hostIds: manager.getWorkspaces().map(candidate => candidate.id),
          }));
          manager.cleanup();
        `,
      ], {
        env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
        stdout: 'pipe', stderr: 'pipe',
      })
      if (run.exitCode !== 0) throw new Error(run.stderr.toString())
      const match = run.stdout.toString().match(/ROLLBACK_RESULT=(\{.*\})/)
      if (!match) throw new Error(`Missing rollback result:\n${run.stdout.toString()}`)
      const result = JSON.parse(match[1])
      expect(result.error).toBeTruthy()
      expect(result.runtimeCount).toBe(1)
      expect(result.hostIds).toEqual(['project-old'])
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('keeps the Session in memory when its durable path escapes through a symlink', () => {
    const parent = mkdtempSync(join(tmpdir(), 'storyflow-delete-session-symlink-'))
    const configDir = join(parent, 'host')
    const projectRoot = join(parent, 'project')
    const externalRoot = join(parent, 'external-sessions')
    const externalSession = join(externalRoot, 'session-1')
    const sentinel = join(externalSession, 'keep.txt')
    mkdirSync(join(projectRoot, '.craft-agent'), { recursive: true })
    mkdirSync(externalSession, { recursive: true })
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(projectRoot, '.craft-agent', 'config.json'), JSON.stringify({
      id: 'directory-id', name: 'Project', slug: 'project', createdAt: 1, updatedAt: 1,
    }))
    writeFileSync(sentinel, 'keep')
    symlinkSync(
      externalRoot,
      join(projectRoot, '.craft-agent', 'sessions'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      workspaces: [{
        id: 'project-old', name: 'Project', slug: 'project', rootPath: projectRoot,
        createdAt: 1, directoryConfigId: 'directory-id',
      }],
      activeWorkspaceId: 'project-old', activeSessionId: null,
    }))

    try {
      const run = Bun.spawnSync([
        process.execPath,
        '--eval',
        `
          import { SessionManager, createManagedSession } from '${SESSION_MANAGER_MODULE_PATH}';
          const manager = new SessionManager();
          const workspace = manager.getWorkspaces()[0];
          const managed = createManagedSession({ id: 'session-1' }, workspace, { messagesLoaded: true });
          manager.sessions.set(managed.id, managed);
          let error;
          try { await manager.deleteSession('session-1'); } catch (cause) { error = cause.message; }
          console.log('DELETE_SYMLINK_RESULT=' + JSON.stringify({
            error,
            retainedInMemory: manager.sessions.has('session-1'),
            runtimeState: manager.sessions.get('session-1')?.runtimeState ?? null,
          }));
          manager.cleanup();
        `,
      ], {
        env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
        stdout: 'pipe', stderr: 'pipe',
      })
      if (run.exitCode !== 0) throw new Error(run.stderr.toString())
      const match = run.stdout.toString().match(/DELETE_SYMLINK_RESULT=(\{.*\})/)
      if (!match) throw new Error(`Missing delete symlink result:\n${run.stdout.toString()}`)
      expect(JSON.parse(match[1])).toMatchObject({
        error: expect.stringContaining('Project-owned storage'),
        retainedInMemory: true,
        runtimeState: null,
      })
      expect(existsSync(sentinel)).toBe(true)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})
