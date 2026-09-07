// input: An isolated Host with no Projects, persisted free conversations, and scheduled prompts
// output: Boot, RPC, and repeated-run coverage for conversation-bound standalone tasks
// pos: Regression guard for scheduler scope and stable conversation ownership

import { expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runIsolatedJson } from './isolated-test-runner'

it('runs a bound automation through the real send path after restart without retaining its admission lease', () => {
  const root = mkdtempSync(join(tmpdir(), 'storyflow-bound-cold-'))
  writeFileSync(join(root, 'config.json'), JSON.stringify({ workspaces: [], activeWorkspaceId: null, activeSessionId: null }))
  try {
    const result = runIsolatedJson<any>(root, 'COLD_RUN', `
      import { SessionManager } from ${JSON.stringify(join(import.meta.dir, 'SessionManager.ts'))};
      import { getFreeConversationWorkspace } from '@craft-agent/shared/workspaces';
      const workspace = getFreeConversationWorkspace();
      const first = new SessionManager();
      first.reinitializeAuth = async () => {};
      await first.initialize();
      const session = await first.createSession(workspace.id, { name: 'Persisted scheduled conversation' });
      await first.cleanup();
      const manager = new SessionManager();
      manager.reinitializeAuth = async () => {};
      await manager.initialize();
      const managed = manager.sessions.get(session.id);
      const cold = managed.agent === null;
      let factoryCalls = 0;
      manager.getOrCreateAgentLocked = async () => {
        factoryCalls++;
        return {
          getModel: () => 'local-test', setAllSources() {}, getSessionId: () => undefined, dispose() {},
          async *chat() { yield { type: 'text_complete', text: 'Scheduled response' }; yield { type: 'complete' }; },
        };
      };
      const outcome = await Promise.race([
        manager.executePromptAutomation({ workspaceId: workspace.id, workspaceRootPath: workspace.rootPath, sessionId: session.id, prompt: 'Run scheduled work' }).then(() => 'completed'),
        Bun.sleep(500).then(() => 'timeout'),
      ]);
      console.log('COLD_RUN=' + JSON.stringify({ cold, outcome, factoryCalls, reply: managed.messages.some(message => message.content === 'Scheduled response') }));
      if (outcome === 'completed') await manager.cleanup();
      process.exit(0);
    `)
    expect(result).toEqual({ cold: true, outcome: 'completed', factoryCalls: 1, reply: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

it('boots without projects and reuses the persisted bound session for scheduled and manual runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'storyflow-standalone-automation-'))
  writeFileSync(join(root, 'config.json'), JSON.stringify({ workspaces: [], activeWorkspaceId: null, activeSessionId: null }))
  try {
    const result = runIsolatedJson<any>(root, 'STANDALONE', `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { SessionManager } from ${JSON.stringify(join(import.meta.dir, 'SessionManager.ts'))};
      import { getFreeConversationWorkspace } from '@craft-agent/shared/workspaces';
      import { registerAutomationsHandlers } from ${JSON.stringify(join(import.meta.dir, '../handlers/rpc/automations.ts'))};
      import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
      const workspace = getFreeConversationWorkspace();
      const first = new SessionManager();
      first.reinitializeAuth = async () => {};
      await first.initialize();
      const session = await first.createSession(workspace.id, { name: 'Daily task', permissionMode: 'safe', isPinned: true });
      await first.cleanup();
      const config = { version: 2, automations: { SchedulerTick: [{
        id: 'daily', sessionId: session.id, name: 'Daily task', cron: '* * * * *', permissionMode: 'allow-all',
        actions: [{ type: 'prompt', prompt: 'Review the outline' }]
      }] } };
      writeFileSync(join(workspace.rootPath, 'automations.json'), JSON.stringify(config));
      const manager = new SessionManager();
      manager.reinitializeAuth = async () => {};
      const sent = [];
      // Exercise scheduler/dispatch/persistence; stop at the model execution boundary.
      manager.sendMessage = async (id, prompt) => { sent.push({ id, prompt }); };
      await manager.initialize();
      const system = manager.automationSystems.get(workspace.rootPath);
      const schedulerStarted = system?.isSchedulerRunning();
      for (let i = 0; i < 2; i++) {
        await system.emit('SchedulerTick', { workspaceId: workspace.id, timestamp: Date.now(), localTime: new Date().toISOString(), utcTime: new Date().toISOString() });
      }
      const handlers = new Map();
      const logger = { info() {}, warn() {}, error() {}, debug() {} };
      registerAutomationsHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, { platform: { logger }, sessionManager: manager });
      const loaded = await handlers.get(RPC_CHANNELS.automations.GET)(null, workspace.id);
      const tested = await handlers.get(RPC_CHANNELS.automations.TEST)(null, {
        workspaceId: workspace.id, sessionId: session.id, automationId: 'daily',
        actions: [{ type: 'prompt', prompt: 'Manual check' }],
      });
      const run = target => manager.executePromptAutomation({ workspaceId: workspace.id, workspaceRootPath: workspace.rootPath, sessionId: target, prompt: 'Run' });
      const errors = [];
      try { await run('missing'); } catch (error) { errors.push(error.message); }
      manager.sessions.get(session.id).isArchived = true;
      try { await run(session.id); } catch (error) { errors.push(error.message); }
      manager.sessions.get(session.id).isArchived = false;
      const originalWorkspace = manager.sessions.get(session.id).workspace;
      manager.sessions.get(session.id).workspace = { ...originalWorkspace, id: 'foreign-project' };
      try { await run(session.id); } catch (error) { errors.push(error.message); }
      manager.sessions.get(session.id).workspace = originalWorkspace;
      const sessionCount = manager.sessions.size;
      const mode = manager.sessions.get(session.id).permissionMode;
      await manager.cleanup();
      console.log('STANDALONE=' + JSON.stringify({ schedulerStarted, sent, sessionId: session.id, sessionCount, mode, loaded, tested, errors }));
    `)
    expect(result.schedulerStarted).toBe(true)
    expect(result.sent).toHaveLength(3)
    expect(result.sent.every((entry: any) => entry.id === result.sessionId)).toBe(true)
    expect(result.sessionCount).toBe(1)
    expect(result.mode).toBe('safe')
    expect(result.loaded.automations.SchedulerTick[0].sessionId).toBe(result.sessionId)
    expect(result.tested.actions[0].sessionId).toBe(result.sessionId)
    expect(result.errors).toHaveLength(3)
    expect(result.errors[0]).toContain('not found')
    expect(result.errors[1]).toContain('archived')
    expect(result.errors[2]).toMatch(/another workspace|unavailable/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
