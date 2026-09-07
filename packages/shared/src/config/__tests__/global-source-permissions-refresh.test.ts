// input: A global Source permissions.json mutation after its permission rules were cached
// output: Regression coverage for ConfigWatcher invalidating global Source permission caches
// pos: Guards the global Source watcher permission-refresh boundary

import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ConfigWatcher } from '../watcher.ts'

const WATCHER_PATH = pathToFileURL(join(import.meta.dir, '..', 'watcher.ts')).href

describe('global Source permission refresh', () => {
  it('recognizes Windows paths for every hot-reloaded Source file', () => {
    const shouldRefresh = (ConfigWatcher as unknown as {
      shouldRefreshGlobalSourcePath: (filename: string) => boolean
    }).shouldRefreshGlobalSourcePath

    expect(shouldRefresh('example\\config.json')).toBe(true)
    expect(shouldRefresh('example\\guide.md')).toBe(true)
    expect(shouldRefresh('example\\permissions.json')).toBe(true)
    expect(shouldRefresh('example\\icon.svg')).toBe(true)
    expect(shouldRefresh('example\\cache.json')).toBe(false)
  })

  it('drops cached rules when the global Source tree changes', () => {
    const parent = mkdtempSync(join(tmpdir(), 'storyflow-global-source-permissions-'))
    const configDir = join(parent, 'config')
    const workspaceRoot = join(parent, 'project')
    const sourceDir = join(configDir, 'sources', 'example')
    mkdirSync(sourceDir, { recursive: true })
    mkdirSync(workspaceRoot)
    writeFileSync(join(sourceDir, 'config.json'), JSON.stringify({
      id: 'example', slug: 'example', name: 'Example', type: 'api', enabled: true,
      api: { baseUrl: 'https://example.com', authType: 'none' },
    }))
    writeFileSync(join(sourceDir, 'permissions.json'), JSON.stringify({
      version: '2026-08-27',
      allowedBashPatterns: [{ pattern: '^before$' }],
    }))

    try {
      const run = Bun.spawnSync([
        process.execPath,
        '--eval',
        `
          import { writeFileSync } from 'node:fs';
          import { join } from 'node:path';
          import { ConfigWatcher } from '${WATCHER_PATH}';
          import { CONFIG_DIR } from '@craft-agent/shared/config';
          import { permissionsConfigCache } from '@craft-agent/shared/agent';

          const sourcePath = join(CONFIG_DIR, 'sources', 'example', 'permissions.json');
          const patterns = () => permissionsConfigCache.getMergedConfig({
            workspaceRootPath: ${JSON.stringify(workspaceRoot)},
            activeSources: [{
              slug: 'example',
              ownerRootPath: CONFIG_DIR,
              grantAuthority: 'host',
            }],
          }).readOnlyBashPatterns.map(entry => entry.source);

          const before = patterns();
          writeFileSync(sourcePath, JSON.stringify({
            version: '2026-08-27',
            allowedBashPatterns: [{ pattern: '^after$' }],
          }));
          const watcher = new ConfigWatcher(${JSON.stringify(workspaceRoot)}, {});
          watcher['handleGlobalSourcesChange']();
          const after = patterns();
          console.log('GLOBAL_SOURCE_PERMISSIONS=' + JSON.stringify({ before, after }));
        `,
      ], {
        env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      if (run.exitCode !== 0) throw new Error(run.stderr.toString())
      const match = run.stdout.toString().match(/GLOBAL_SOURCE_PERMISSIONS=(\{.*\})/)
      if (!match) throw new Error(`Missing refresh result:\n${run.stdout.toString()}`)
      const result = JSON.parse(match[1]!)

      expect(result.before).toContain('^before$')
      expect(result.after).toContain('^after$')
      expect(result.after).not.toContain('^before$')
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})
