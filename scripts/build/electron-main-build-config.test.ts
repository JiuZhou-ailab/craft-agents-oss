// input: Electron main process build entrypoints
// output: Regression coverage for dependencies that must stay external
// pos: Protects runtime-sensitive Electron main build configuration

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateDesktopAuthBuildEnv } from './desktop-auth-build-config';

const rootDir = join(import.meta.dir, '..', '..');
const AWS_S3_CLIENT_EXTERNAL = '@aws-sdk/client-s3';
const AWS_S3_CLIENT_EXTERNAL_ARG = '--external:@aws-sdk/client-s3';

function readRepoFile(path: string): string {
  return readFileSync(join(rootDir, path), 'utf8');
}

describe('Electron main process build config', () => {
  test('does not require the unused unzipper S3 optional client during main bundling', () => {
    expect(readRepoFile('scripts/electron-build-main.ts')).toContain(AWS_S3_CLIENT_EXTERNAL_ARG);
  });

  test('delegates package build entrypoints to the shared auth-aware main build', () => {
    expect(readRepoFile('scripts/build/win32.ts')).toContain('electron:build:main');
    expect(readRepoFile('scripts/build/common.ts')).toContain('bun run electron:build');
    expect(readRepoFile('apps/electron/package.json')).toContain('"build:main"');
  });

  test('does not require the unused unzipper S3 optional client during dev main bundling', () => {
    expect(readRepoFile('scripts/electron-dev.ts')).toContain(AWS_S3_CLIENT_EXTERNAL);
  });

  test('delegates WhatsApp bundling to the canonical worker build', () => {
    expect(readRepoFile('scripts/build-wa-worker.ts')).toContain('--external:sharp');
    expect(readRepoFile('scripts/electron-build-main.ts')).toContain('"bun", "run", "build:wa-worker"');
  });

  test('stages the freshly built Pi runtime before copying Electron resources', () => {
    const source = readRepoFile('scripts/electron-dev.ts');
    const buildRuntime = source.indexOf('await buildAgentRuntime();');
    const stageRuntime = source.indexOf('stageSubprocessResources({');
    const copyResources = source.indexOf('copyResources();');

    expect(buildRuntime).toBeGreaterThan(-1);
    expect(stageRuntime).toBeGreaterThan(buildRuntime);
    expect(copyResources).toBeGreaterThan(stageRuntime);
  });

  test('puts the packaged Bun runtime on PATH for Pi package installs', () => {
    const source = readRepoFile('apps/electron/src/main/index.ts');

    expect(source).toContain('process.env.CRAFT_BUN = runtimePaths.bunBinary');
    expect(source).toContain('`${dirname(runtimePaths.bunBinary)}${delimiter}${runtimePaths.binDir}');
  });

  test('waits for watcher initial builds before launching Electron', () => {
    const source = readRepoFile('scripts/electron-dev.ts');
    const electronStart = source.indexOf('const electronProc = spawn');

    for (const context of ['mainContext', 'preloadContext', 'toolbarPreloadContext']) {
      const watch = source.indexOf(`await ${context}.watch()`);
      const rebuild = source.indexOf(`await ${context}.rebuild()`);

      expect(watch).toBeGreaterThan(-1);
      expect(rebuild).toBeGreaterThan(watch);
      expect(rebuild).toBeLessThan(electronStart);
    }
  });
});

describe('desktop auth build config', () => {
  test('documents the production auth broker on a first-party domain', () => {
    const docs = [
      readRepoFile('.env.example'),
      readRepoFile('docs/feishu-desktop-auth.md'),
      readRepoFile('apps/auth-broker-worker/wrangler.toml'),
    ].join('\n');

    expect(docs).toContain('https://storyflow-auth.zjding.com');
    expect(docs).not.toContain('storyflow-auth-broker.d1095245867.workers.dev');
  });

  test('allows builds when desktop client auth is explicitly disabled', () => {
    expect(validateDesktopAuthBuildEnv({
      CRAFT_CLIENT_AUTH_REQUIRED: 'false',
    })).toEqual({ ok: true });
  });

  test('allows local-only packaged builds without a desktop login gate', () => {
    expect(validateDesktopAuthBuildEnv({})).toEqual({ ok: true });
  });

  test('allows localhost brokers only for explicit dev-runtime builds', () => {
    expect(validateDesktopAuthBuildEnv({
      CRAFT_DEV_RUNTIME: '1',
      CRAFT_CLIENT_AUTH_REQUIRED: 'true',
      CRAFT_CLIENT_AUTH_BROKER_URL: 'http://localhost:9100',
    })).toEqual({ ok: true });
  });

  test('accepts Neon-only client auth through the shared broker', () => {
    expect(validateDesktopAuthBuildEnv({
      CRAFT_CLIENT_NEON_AUTH_BASE_URL: 'https://auth.example.com',
      CRAFT_CLIENT_AUTH_BROKER_URL: 'https://auth.storyflow.example.com',
    })).toEqual({ ok: true });
  });

  test('accepts verified-email Neon registration without an organization boundary', () => {
    expect(validateDesktopAuthBuildEnv({
      CRAFT_CLIENT_NEON_AUTH_BASE_URL: 'https://auth.example.com',
      CRAFT_CLIENT_AUTH_BROKER_URL: 'https://auth.storyflow.example.com',
    })).toEqual({ ok: true });
  });

  test('rejects insecure Neon Auth endpoints in packaged builds', () => {
    expect(validateDesktopAuthBuildEnv({
      CRAFT_CLIENT_NEON_AUTH_BASE_URL: 'http://auth.example.com',
      CRAFT_CLIENT_AUTH_BROKER_URL: 'https://auth.storyflow.example.com',
    })).toEqual({
      ok: false,
      message: 'CRAFT_CLIENT_NEON_AUTH_BASE_URL must use https for packaged desktop client auth.',
    });

    expect(validateDesktopAuthBuildEnv({
      CRAFT_CLIENT_NEON_AUTH_BASE_URL: 'https://auth.example.com',
      CRAFT_CLIENT_NEON_AUTH_JWKS_URL: 'http://keys.example.com/jwks.json',
      CRAFT_CLIENT_AUTH_BROKER_URL: 'https://auth.storyflow.example.com',
    })).toEqual({
      ok: false,
      message: 'CRAFT_CLIENT_NEON_AUTH_JWKS_URL must use https for packaged desktop client auth.',
    });
  });

  test('requires a broker for packaged model access', () => {
    expect(validateDesktopAuthBuildEnv({
      CRAFT_CLIENT_AUTH_REQUIRED: 'true',
      CRAFT_CLIENT_FEISHU_APP_ID: 'cli_test',
    })).toEqual({
      ok: false,
      message: 'CRAFT_CLIENT_AUTH_BROKER_URL is required for packaged client auth and model access.',
    });
  });

  test('does not treat a broker URL as a login method', () => {
    expect(validateDesktopAuthBuildEnv({
      CRAFT_CLIENT_AUTH_BROKER_URL: 'https://auth.storyflow.example.com',
    })).toEqual({
      ok: false,
      message: 'Packaged desktop client auth requires CRAFT_CLIENT_FEISHU_APP_ID or CRAFT_CLIENT_NEON_AUTH_BASE_URL.',
    });
  });

  test('rejects localhost brokers for packaged desktop client auth', () => {
    const result = validateDesktopAuthBuildEnv({
      CRAFT_CLIENT_AUTH_REQUIRED: 'true',
      CRAFT_CLIENT_AUTH_BROKER_URL: 'http://localhost:9100',
      CRAFT_CLIENT_FEISHU_APP_ID: 'cli_test',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('localhost broker');
    }
  });

  test('requires https broker URLs for packaged desktop client auth', () => {
    expect(validateDesktopAuthBuildEnv({
      CRAFT_CLIENT_AUTH_REQUIRED: 'true',
      CRAFT_CLIENT_AUTH_BROKER_URL: 'http://auth.storyflow.example.com',
      CRAFT_CLIENT_FEISHU_APP_ID: 'cli_test',
    })).toEqual({
      ok: false,
      message: 'CRAFT_CLIENT_AUTH_BROKER_URL must use https for packaged desktop client auth.',
    });
  });

  test('accepts deployed HTTPS brokers for packaged desktop client auth', () => {
    expect(validateDesktopAuthBuildEnv({
      CRAFT_CLIENT_AUTH_REQUIRED: 'true',
      CRAFT_CLIENT_AUTH_BROKER_URL: ' https://auth.storyflow.example.com/ ',
      CRAFT_CLIENT_FEISHU_APP_ID: 'cli_test',
    })).toEqual({ ok: true });
  });

  test('accepts both Feishu and Neon client auth for packaged builds', () => {
    expect(validateDesktopAuthBuildEnv({
      CRAFT_CLIENT_AUTH_BROKER_URL: 'https://auth.storyflow.example.com',
      CRAFT_CLIENT_FEISHU_APP_ID: 'cli_test',
      CRAFT_CLIENT_NEON_AUTH_BASE_URL: 'https://auth.example.com',
    })).toEqual({ ok: true });
  });
});
