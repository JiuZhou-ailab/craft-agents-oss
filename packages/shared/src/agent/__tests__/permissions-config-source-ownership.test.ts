// input: Active Source owner references plus Host consent for Project-authored grants
// output: Regression coverage for owner-resolved Source permission evaluation
// pos: Security contract separating Source ownership from the consuming workspace

import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

function writePermissions(path: string, pattern: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({
    version: '2026-09-05',
    allowedBashPatterns: [{ pattern }],
  }))
}

describe('Source permission ownership', () => {
  it('applies a Host-owned global Source grant for Free Conversation and Project consumers', () => {
    const parent = mkdtempSync(join(tmpdir(), 'storyflow-source-permission-owner-'))
    const configDir = join(parent, 'config')
    const freeConversationRoot = join(configDir, 'runtime', 'free')
    const projectRoot = join(parent, 'project')
    const globalPattern = '^global-source-owner$'
    const globalSourceRoot = configDir

    writePermissions(
      join(globalSourceRoot, 'sources', 'example', 'permissions.json'),
      globalPattern,
    )
    mkdirSync(freeConversationRoot, { recursive: true })
    mkdirSync(projectRoot, { recursive: true })

    try {
      const run = Bun.spawnSync([
        process.execPath,
        '--eval',
        `
          import { shouldAllowToolInMode } from '${pathToFileURL(join(import.meta.dir, '..', 'mode-manager.ts')).href}';

          const source = {
            slug: 'example',
            ownerRootPath: ${JSON.stringify(globalSourceRoot)},
            grantAuthority: 'host',
          };
          const isAllowed = (workspaceRootPath, allowProjectGrants) =>
            shouldAllowToolInMode(
              'Bash',
              { command: 'global-source-owner' },
              'safe',
              { permissionsContext: { workspaceRootPath, activeSources: [source], allowProjectGrants } },
            ).allowed;

          console.log('SOURCE_OWNER_RESULT=' + JSON.stringify({
            freeConversation: isAllowed(${JSON.stringify(freeConversationRoot)}, true),
            project: isAllowed(${JSON.stringify(projectRoot)}, false),
          }));
        `,
      ], {
        env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      if (run.exitCode !== 0) throw new Error(run.stderr.toString())
      const match = run.stdout.toString().match(/SOURCE_OWNER_RESULT=(\{.*\})/)
      if (!match) throw new Error(`Missing Source owner result:\n${run.stdout.toString()}`)
      const result = JSON.parse(match[1]!)

      expect(result.freeConversation).toBe(true)
      expect(result.project).toBe(true)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('keeps Project Source grants fail-closed until the Host consents', () => {
    const parent = mkdtempSync(join(tmpdir(), 'storyflow-project-source-permission-'))
    const configDir = join(parent, 'config')
    const projectRoot = join(parent, 'project')
    const projectPattern = '^project-source-owner$'

    writePermissions(
      join(projectRoot, '.craft-agent', 'sources', 'example', 'permissions.json'),
      projectPattern,
    )

    try {
      const run = Bun.spawnSync([
        process.execPath,
        '--eval',
        `
          import { shouldAllowToolInMode } from '${pathToFileURL(join(import.meta.dir, '..', 'mode-manager.ts')).href}';

          const source = {
            slug: 'example',
            ownerRootPath: ${JSON.stringify(projectRoot)},
            grantAuthority: 'project',
          };
          const isAllowed = (allowProjectGrants) =>
            shouldAllowToolInMode(
              'Bash',
              { command: 'project-source-owner' },
              'safe',
              {
                permissionsContext: {
                  workspaceRootPath: ${JSON.stringify(projectRoot)},
                  activeSources: [source],
                  allowProjectGrants,
                },
              },
            ).allowed;

          console.log('PROJECT_SOURCE_RESULT=' + JSON.stringify({
            withoutConsent: isAllowed(false),
            withConsent: isAllowed(true),
          }));
        `,
      ], {
        env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      if (run.exitCode !== 0) throw new Error(run.stderr.toString())
      const match = run.stdout.toString().match(/PROJECT_SOURCE_RESULT=(\{.*\})/)
      if (!match) throw new Error(`Missing Project Source result:\n${run.stdout.toString()}`)
      const result = JSON.parse(match[1]!)

      expect(result.withoutConsent).toBe(false)
      expect(result.withConsent).toBe(true)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})
