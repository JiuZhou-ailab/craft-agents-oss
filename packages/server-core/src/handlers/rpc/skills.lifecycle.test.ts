// input: Project Skill deletion concurrent with a Project root relink
// output: Regression coverage for current-root project-scope Skill deletion
// pos: Guards top-level Project Skills from stale locator deletion

import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runIsolatedJson } from '../../sessions/isolated-test-runner'

const SKILLS_HANDLER_PATH = pathToFileURL(join(import.meta.dir, 'skills.ts')).href
const SESSION_MANAGER_PATH = pathToFileURL(join(import.meta.dir, '..', '..', 'sessions', 'SessionManager.ts')).href

function writeProject(rootPath: string): string {
  const skillDir = join(rootPath, '.pi', 'skills', 'project-lifecycle-skill')
  mkdirSync(skillDir, { recursive: true })
  mkdirSync(join(rootPath, '.craft-agent'), { recursive: true })
  writeFileSync(join(rootPath, '.craft-agent', 'config.json'), JSON.stringify({
    id: 'directory-id', name: 'Project', slug: 'project', createdAt: 1, updatedAt: 1,
  }))
  writeFileSync(join(skillDir, 'SKILL.md'), [
    '---',
    'name: project-lifecycle-skill',
    'description: lifecycle test',
    '---',
    '',
    'Test.',
  ].join('\n'))
  return skillDir
}

describe('Project Skill deletion lifecycle', () => {
  it('waits for relink and deletes the top-level Project Skill from the committed root', () => {
    const parent = mkdtempSync(join(tmpdir(), 'storyflow-skill-relink-'))
    const configDir = join(parent, 'host')
    const previousRoot = join(parent, 'previous')
    const currentRoot = join(parent, 'current')
    mkdirSync(configDir, { recursive: true })
    const previousSkillDir = writeProject(previousRoot)
    const currentSkillDir = writeProject(currentRoot)
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      workspaces: [{
        id: 'project-1', name: 'Project', slug: 'project', rootPath: previousRoot,
        createdAt: 1, directoryConfigId: 'directory-id',
      }],
      activeWorkspaceId: 'project-1', activeSessionId: null,
    }))

    try {
      const result = runIsolatedJson(configDir, 'SKILL_RELINK', `
          import { existsSync } from 'node:fs';
          import { registerSkillsHandlers } from '${SKILLS_HANDLER_PATH}';
          import { SessionManager } from '${SESSION_MANAGER_PATH}';
          import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
          import { loadStoredConfig, saveConfig } from '@craft-agent/shared/config';
          const handlers = new Map();
          const server = { handle: (channel, handler) => handlers.set(channel, handler), push() {} };
          const logger = { info() {}, warn() {}, error() {}, debug() {} };
          const manager = new SessionManager();
          registerSkillsHandlers(server, { platform: { logger }, sessionManager: manager });

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

          const deleting = handlers.get(RPC_CHANNELS.skills.DELETE)(
            null, 'project-1', 'project-lifecycle-skill',
          );
          const stateBeforeRelease = await Promise.race([
            deleting.then(() => 'deleted'),
            Bun.sleep(100).then(() => 'blocked'),
          ]);
          finishLifecycle();
          await relocation;
          await deleting;
          manager.cleanup();
          console.log('SKILL_RELINK=' + JSON.stringify({
            stateBeforeRelease,
            activeRoot: loadStoredConfig().workspaces[0].rootPath,
            previousExists: existsSync(${JSON.stringify(previousSkillDir)}),
            currentExists: existsSync(${JSON.stringify(currentSkillDir)}),
          }));
        `)
      expect(result).toEqual({
        stateBeforeRelease: 'blocked',
        activeRoot: currentRoot,
        previousExists: true,
        currentExists: false,
      })
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})
