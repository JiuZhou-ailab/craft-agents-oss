// input: Temporary Source definitions and injectable SessionToolContext capabilities
// output: source_test validation, persistence, and activation regression coverage
// pos: Session tool ownership and connection-test contract suite

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleSourceTest } from './source-test.ts';
import type { SessionToolContext } from '../context.ts';
import type { SourceConfig } from '../types.ts';

type ActivateResult = Awaited<
  ReturnType<NonNullable<SessionToolContext['activateSourceInSession']>>
>;

interface CtxOverrides {
  activateSourceInSession?: (slug: string) => Promise<ActivateResult>;
  validateStdioMcpConnection?: SessionToolContext['validateStdioMcpConnection'];
  isStdioMcpExecutionAllowed?: SessionToolContext['isStdioMcpExecutionAllowed'];
  validateMcpConnection?: SessionToolContext['validateMcpConnection'];
  credentialManager?: SessionToolContext['credentialManager'];
  getManagedApiAccessToken?: SessionToolContext['getManagedApiAccessToken'];
  testApiSource?: SessionToolContext['testApiSource'];
  isIconUrl?: SessionToolContext['isIconUrl'];
  isSourceExecutionAllowed?: SessionToolContext['isSourceExecutionAllowed'];
}

function createCtx(workspacePath: string, overrides: CtxOverrides = {}): SessionToolContext {
  const saved: { last?: SourceConfig } = {};
  const ctx = {
    sessionId: 'test-session',
    workspacePath,
    workspaceId: 'project-stable',
    get sourcesPath() {
      return join(workspacePath, 'sources');
    },
    get skillsPath() {
      return join(workspacePath, 'skills');
    },
    plansFolderPath: join(workspacePath, 'plans'),
    callbacks: {
      onPlanSubmitted: () => {},
      onAuthRequest: () => {},
    },
    fs: {
      exists: (path: string) => existsSync(path),
      readFile: (path: string) => readFileSync(path, 'utf-8'),
      readFileBuffer: (path: string) => readFileSync(path),
      writeFile: (path: string, content: string) => writeFileSync(path, content),
      isDirectory: (path: string) => existsSync(path) && statSync(path).isDirectory(),
      readdir: (path: string) => readdirSync(path),
      stat: (path: string) => {
        const s = statSync(path);
        return { size: s.size, isDirectory: () => s.isDirectory() };
      },
    },
    loadSourceConfig: (slug: string) => {
      const configPath = join(workspacePath, 'sources', slug, 'config.json');
      if (!existsSync(configPath)) return null;
      return JSON.parse(readFileSync(configPath, 'utf-8')) as SourceConfig;
    },
    resolveSourcePath: (slug: string) => {
      const sourcePath = join(workspacePath, 'sources', slug);
      return existsSync(sourcePath) ? sourcePath : null;
    },
    saveSourceConfig: (source: SourceConfig) => {
      saved.last = source;
      const configPath = join(workspacePath, 'sources', source.slug, 'config.json');
      writeFileSync(configPath, JSON.stringify(source, null, 2));
    },
    // Stub the MCP validator so connection tests don't hit the network.
    validateStdioMcpConnection: overrides.validateStdioMcpConnection,
    isStdioMcpExecutionAllowed: overrides.isStdioMcpExecutionAllowed,
    validateMcpConnection: overrides.validateMcpConnection,
    credentialManager: overrides.credentialManager,
    getManagedApiAccessToken: overrides.getManagedApiAccessToken,
    testApiSource: overrides.testApiSource,
    isIconUrl: overrides.isIconUrl,
    isSourceExecutionAllowed: overrides.isSourceExecutionAllowed ?? (() => true),
    activateSourceInSession: overrides.activateSourceInSession,
  } as unknown as SessionToolContext;
  // Expose saved for assertions (test-only — not on real ctx).
  (ctx as unknown as { _saved: typeof saved })._saved = saved;
  return ctx;
}

function writeSource(
  workspacePath: string,
  slug: string,
  overrides: Partial<SourceConfig> = {}
): void {
  const sourcePath = join(workspacePath, 'sources', slug);
  mkdirSync(sourcePath, { recursive: true });
  const config: SourceConfig = {
    id: slug,
    slug,
    name: `Test ${slug}`,
    enabled: true,
    provider: 'test',
    type: 'mcp',
    tagline: 'A test source',
    icon: '🧪',
    mcp: {
      transport: 'stdio',
      command: 'echo',
      args: ['ok'],
    },
    ...overrides,
  } as SourceConfig;
  writeFileSync(join(sourcePath, 'config.json'), JSON.stringify(config, null, 2));
  writeFileSync(
    join(sourcePath, 'guide.md'),
    '# Guide\n\nThis is a longer guide with more than fifty words so the validator does not warn about the guide being too short for the readability criteria the tool enforces when evaluating source completeness for this test suite which is only here to exercise the auto-enable flow and not the completeness check.'
  );
}

function stubMcpOk(): NonNullable<SessionToolContext['validateStdioMcpConnection']> {
  return async () => ({
    success: true,
    toolCount: 1,
    toolNames: ['dummy'],
    serverName: 'stub',
    serverVersion: '0.0.0',
  });
}

function stubMcpFail(): NonNullable<SessionToolContext['validateStdioMcpConnection']> {
  return async () => ({ success: false, error: 'boom' });
}

describe('source_test auto-enable', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-auto-enable-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not spawn a project stdio Source without Host consent', async () => {
    writeSource(tempDir, 'project-local');
    let validated = false;
    const ctx = createCtx(tempDir, {
      isStdioMcpExecutionAllowed: () => false,
      validateStdioMcpConnection: async () => {
        validated = true;
        return { success: true };
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'project-local' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('disabled by Host settings');
    expect(validated).toBe(false);
  });

  it('reports a configured icon URL without downloading it', async () => {
    writeSource(tempDir, 'url-icon', { icon: 'https://example.test/icon.png' });
    const ctx = createCtx(tempDir, {
      isIconUrl: (value) => value.startsWith('https://'),
      validateStdioMcpConnection: stubMcpOk(),
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'url-icon' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('✓ Icon URL configured: https://example.test/icon.png');
    expect(text).not.toContain('No icon configured');
  });

  it('does not test an API or read credentials without an exact Host grant', async () => {
    writeSource(tempDir, 'project-api', {
      type: 'api',
      api: { baseUrl: 'https://replacement.example', authType: 'bearer' },
      isAuthenticated: true,
      mcp: undefined,
    });
    let tested = false;
    let credentialRead = false;
    const ctx = createCtx(tempDir, {
      isSourceExecutionAllowed: () => false,
      testApiSource: async () => {
        tested = true;
        return { success: true };
      },
      credentialManager: {
        hasValidCredentials: async () => true,
        getToken: async () => {
          credentialRead = true;
          return 'secret';
        },
        refresh: async () => null,
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'project-api' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not enabled by Host settings');
    expect(tested).toBe(false);
    expect(credentialRead).toBe(false);
  });

  it('flips enabled: false → true and calls activation callback on clean run', async () => {
    writeSource(tempDir, 'craft-kb', { enabled: false });

    let activated: string | null = null as string | null;
    const ctx = createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpOk(),
      activateSourceInSession: async (slug) => {
        activated = slug;
        return { ok: true, availability: 'next-turn' };
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'craft-kb' });

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Source auto-enabled in config');
    expect(text).toContain('available on your next message');
    expect(text).not.toContain('auto-restart');
    expect(activated).toBe('craft-kb');

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'craft-kb', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.enabled).toBe(true);
  });

  it('already-enabled source still calls activation callback (session may be stale)', async () => {
    writeSource(tempDir, 'craft-kb', { enabled: true });

    let activated: string | null = null as string | null;
    const ctx = createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpOk(),
      activateSourceInSession: async (slug) => {
        activated = slug;
        return { ok: true, availability: 'next-turn' };
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'craft-kb' });
    const text = result.content[0]?.text ?? '';

    // No "auto-enabled in config" line because enabled was already true.
    expect(text).not.toContain('auto-enabled in config');
    expect(activated).toBe('craft-kb');
    expect(text).toContain('available on your next message');
    expect(text).not.toContain('auto-restart');
  });

  it('autoEnable: false skips both the flag flip and the activation callback', async () => {
    writeSource(tempDir, 'craft-kb', { enabled: false });

    let activated = false;
    const ctx = createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpOk(),
      activateSourceInSession: async () => {
        activated = true;
        return { ok: true };
      },
    });

    await handleSourceTest(ctx, { sourceSlug: 'craft-kb', autoEnable: false });

    expect(activated).toBe(false);
    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'craft-kb', 'config.json'), 'utf-8')
    ) as SourceConfig;
    // saveSourceConfig still runs (metadata update), but enabled flag must remain false.
    expect(persisted.enabled).toBe(false);
  });

  it('validation errors skip auto-enable entirely (even when autoEnable is default)', async () => {
    writeSource(tempDir, 'broken', { enabled: false });

    let activated = false;
    const ctx = createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpFail(),
      activateSourceInSession: async () => {
        activated = true;
        return { ok: true };
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'broken' });
    const text = result.content[0]?.text ?? '';

    expect(result.isError).toBe(true);
    expect(activated).toBe(false);
    expect(text).not.toContain('auto-enabled in config');

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'broken', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.enabled).toBe(false);
  });

  it('without activateSourceInSession, flag flip still happens with restart hint', async () => {
    writeSource(tempDir, 'craft-kb', { enabled: false });

    const ctx = createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpOk(),
      // activateSourceInSession intentionally undefined
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'craft-kb' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('auto-enabled in config');
    expect(text).toContain('Restart session to load tools');

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'craft-kb', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.enabled).toBe(true);
  });

  it('activation failure shows warning but still persists enabled flag', async () => {
    writeSource(tempDir, 'craft-kb', { enabled: false });

    const ctx = createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpOk(),
      activateSourceInSession: async () => ({ ok: false, reason: 'build failed' }),
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'craft-kb' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('session activation failed: build failed');

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'craft-kb', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.enabled).toBe(true);
  });

  it('successful activation reports next-turn availability without replay', async () => {
    writeSource(tempDir, 'craft-kb', { enabled: true });

    const ctx = createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpOk(),
      activateSourceInSession: async () => ({ ok: true, availability: 'next-turn' }),
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'craft-kb' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('available on your next message');
    expect(text).not.toContain('tools available now');
    expect(text).not.toContain('auto-restart');
  });
});

// ============================================================
// API connection-branch coverage (regression for #683)
// ============================================================
//
// These tests exercise the built-in fetch-based connection probe and the
// auto-enable gate that depends on its result. They drive global fetch via
// a swap-in stub so no network IO happens.

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function installFetchStub(
  responder: (call: FetchCall) => Response | Promise<Response>
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : String(input);
    const call: FetchCall = { url, init };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function writeApiSource(
  workspacePath: string,
  slug: string,
  overrides: Partial<SourceConfig> = {}
): void {
  const sourcePath = join(workspacePath, 'sources', slug);
  mkdirSync(sourcePath, { recursive: true });
  const config: SourceConfig = {
    id: slug,
    slug,
    name: slug,
    enabled: false,
    provider: 'test',
    type: 'api',
    tagline: 'A test API source',
    icon: '🧪',
    api: {
      baseUrl: 'https://api.example.test',
      authType: 'none',
    },
    ...overrides,
  } as SourceConfig;
  writeFileSync(join(sourcePath, 'config.json'), JSON.stringify(config, null, 2));
  writeFileSync(
    join(sourcePath, 'guide.md'),
    '# Guide\n\nThis is a longer guide with more than fifty words so the validator does not warn about the guide being too short for the readability criteria the tool enforces when evaluating source completeness for this test suite which is only here to exercise the connection-branch behavior.'
  );
}

describe('source_test API connection branches', () => {
  let tempDir: string;
  let restoreFetch: () => void = () => {};

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-api-conn-'));
  });

  afterEach(() => {
    restoreFetch();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('200 → connected, source auto-enabled, activation called', async () => {
    writeApiSource(tempDir, 'good-api');
    ({ restore: restoreFetch } = installFetchStub(() => new Response(null, { status: 200 })));

    let activated: string | null = null as string | null;
    const ctx = createCtx(tempDir, {
      activateSourceInSession: async (slug) => {
        activated = slug;
        return { ok: true, availability: 'next-turn' };
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'good-api' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('Validation passed');
    expect(text).not.toContain('Skipping activation');
    expect(activated).toBe('good-api');

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'good-api', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.enabled).toBe(true);
    expect(persisted.connectionStatus).toBe('connected');
  });

  it('500 → disconnected, NOT auto-enabled, activation NOT called', async () => {
    writeApiSource(tempDir, 'flaky-api');
    ({ restore: restoreFetch } = installFetchStub(() => new Response(null, { status: 500 })));

    let activated = false;
    const ctx = createCtx(tempDir, {
      activateSourceInSession: async () => {
        activated = true;
        return { ok: true };
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'flaky-api' });
    const text = result.content[0]?.text ?? '';

    // The summary line must not be "✓ Validation passed" alone — it must be
    // the warnings variant, because the probe got a non-2xx the probe couldn't
    // classify as healthy.
    expect(text).toContain('Validation passed with warnings');
    expect(text).toContain('API returned 500');
    expect(text).toContain('Skipping activation');

    expect(activated).toBe(false);

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'flaky-api', 'config.json'), 'utf-8')
    ) as SourceConfig;
    // The enabled flag must not be flipped on a failed probe.
    expect(persisted.enabled).toBe(false);
    expect(persisted.connectionStatus).toBe('disconnected');
  });

  it('404 → disconnected, NOT auto-enabled, activation NOT called', async () => {
    writeApiSource(tempDir, 'wrong-path-api');
    ({ restore: restoreFetch } = installFetchStub(() => new Response(null, { status: 404 })));

    let activated = false;
    const ctx = createCtx(tempDir, {
      activateSourceInSession: async () => {
        activated = true;
        return { ok: true };
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'wrong-path-api' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('Validation passed with warnings');
    expect(text).toContain('API returned 404');
    expect(text).toContain('Skipping activation');
    expect(activated).toBe(false);
  });

  it('401 → connected (auth-required), auto-enabled (refresh path runs)', async () => {
    // 401 from an unauthenticated probe is mapped to "reachable, needs auth".
    // The token-refresh case in checkAuthStatus relies on this — gating on
    // connectionStatus must not break it.
    writeApiSource(tempDir, 'auth-needed-api');
    ({ restore: restoreFetch } = installFetchStub(() => new Response(null, { status: 401 })));

    let activated: string | null = null as string | null;
    const ctx = createCtx(tempDir, {
      activateSourceInSession: async (slug) => {
        activated = slug;
        return { ok: true, availability: 'next-turn' };
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'auth-needed-api' });
    const text = result.content[0]?.text ?? '';

    expect(text).not.toContain('Skipping activation');
    expect(activated).toBe('auth-needed-api');

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'auth-needed-api', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.enabled).toBe(true);
    expect(persisted.connectionStatus).toBe('connected');
  });

  it('basic probe honors testEndpoint.method (no HEAD→GET fallback dance)', async () => {
    // Regression for the HEAD→GET-on-405 fallback that silently passed POST-only
    // endpoints. With a configured method, the basic probe must call it directly.
    writeApiSource(tempDir, 'post-only-api', {
      api: {
        baseUrl: 'https://api.example.test',
        authType: 'none',
        testEndpoint: { method: 'POST', path: '/v1/things' },
      },
    } as Partial<SourceConfig>);

    let stub: ReturnType<typeof installFetchStub>;
    stub = installFetchStub(() => new Response(null, { status: 200 }));
    restoreFetch = stub.restore;

    await handleSourceTest(ctx_for(tempDir), { sourceSlug: 'post-only-api' });

    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0]?.init?.method).toBe('POST');
    expect(stub.calls[0]?.url).toBe('https://api.example.test/v1/things');
  });

  it('basic auth JSON credential is base64 encoded for authenticated probe', async () => {
    writeApiSource(tempDir, 'basic-auth-api', {
      isAuthenticated: true,
      api: {
        baseUrl: 'https://api.example.test',
        authType: 'basic',
        testEndpoint: { method: 'GET', path: '/ping' },
      },
    });

    let stub: ReturnType<typeof installFetchStub>;
    stub = installFetchStub(() => new Response(null, { status: 200 }));
    restoreFetch = stub.restore;

    const ctx = createCtx(tempDir, {
      credentialManager: {
        getToken: async () => JSON.stringify({ username: 'u', password: 'p' }),
        refresh: async () => null,
        hasValidCredentials: async () => true,
      },
    });

    await handleSourceTest(ctx, { sourceSlug: 'basic-auth-api', autoEnable: false });

    expect(stub.calls[0]?.init?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('u:p').toString('base64')}`,
    });
  });

  it('basic auth legacy string credential is passed through unchanged', async () => {
    writeApiSource(tempDir, 'legacy-basic-auth-api', {
      isAuthenticated: true,
      api: {
        baseUrl: 'https://api.example.test',
        authType: 'basic',
        testEndpoint: { method: 'GET', path: '/ping' },
      },
    });

    let stub: ReturnType<typeof installFetchStub>;
    stub = installFetchStub(() => new Response(null, { status: 200 }));
    restoreFetch = stub.restore;

    const ctx = createCtx(tempDir, {
      credentialManager: {
        getToken: async () => 'legacy-token',
        refresh: async () => null,
        hasValidCredentials: async () => true,
      },
    });

    await handleSourceTest(ctx, { sourceSlug: 'legacy-basic-auth-api', autoEnable: false });

    expect(stub.calls[0]?.init?.headers).toMatchObject({
      Authorization: 'Basic legacy-token',
    });
  });

  it('managed auth probes with the active Storyflow login token', async () => {
    writeApiSource(tempDir, 'storyflow-catalog', {
      provider: 'storyflow',
      api: {
        baseUrl: 'https://storyflow-model.zjding.com',
        authType: 'managed',
        testEndpoint: { method: 'GET', path: '/v2/catalog/sources' },
      },
    });
    let stub: ReturnType<typeof installFetchStub>;
    stub = installFetchStub(() => Response.json({ version: 2, sources: [] }));
    restoreFetch = stub.restore;

    const result = await handleSourceTest(createCtx(tempDir, {
      getManagedApiAccessToken: async () => 'storyflow-token',
    }), { sourceSlug: 'storyflow-catalog', autoEnable: false });
    const text = result.content[0]?.text ?? '';

    expect(stub.calls[0]?.url).toBe('https://storyflow-model.zjding.com/v2/catalog/sources');
    expect(stub.calls[0]?.init?.headers).toMatchObject({
      Authorization: 'Bearer storyflow-token',
    });
    expect(text).toContain('API connection successful (authenticated)');
    expect(text).toContain('Authentication is provided by the active Storyflow login');
  });

  it('managed auth fails closed when the Storyflow login is unavailable', async () => {
    writeApiSource(tempDir, 'storyflow-catalog', {
      provider: 'storyflow',
      api: {
        baseUrl: 'https://storyflow-model.zjding.com',
        authType: 'managed',
        testEndpoint: { method: 'GET', path: '/v2/catalog/sources' },
      },
    });
    const stub = installFetchStub(() => Response.json({ version: 2, sources: [] }));
    restoreFetch = stub.restore;

    const result = await handleSourceTest(createCtx(tempDir, {
      getManagedApiAccessToken: async () => {
        throw new Error('Storyflow login is required for this managed Source');
      },
    }), { sourceSlug: 'storyflow-catalog' });
    const text = result.content[0]?.text ?? '';

    expect(stub.calls).toHaveLength(0);
    expect(text).toContain('Storyflow login is required for this managed Source');
    expect(text).toContain('Validation failed with errors');
    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'storyflow-catalog', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.enabled).toBe(false);
    expect(persisted.connectionStatus).toBe('error');
  });
});

type ValidateMcpCall = Parameters<NonNullable<SessionToolContext['validateMcpConnection']>>[0];

function writeHttpMcpSource(
  workspacePath: string,
  slug: string,
  overrides: Partial<SourceConfig> = {},
): void {
  writeSource(workspacePath, slug, {
    type: 'mcp',
    mcp: {
      transport: 'http',
      url: 'https://mcp.example.test',
      authType: 'oauth',
    },
    ...overrides,
  });
}

function credentialManagerStub(cachedToken?: string | null, refreshedToken?: string | null) {
  let getTokenCalls = 0;
  let refreshCalls = 0;
  const workspaceIds: string[] = [];
  return {
    manager: {
      hasValidCredentials: async () => true,
      getToken: async (source) => {
        getTokenCalls += 1;
        workspaceIds.push(source.workspaceId);
        return cachedToken ?? null;
      },
      refresh: async (source) => {
        refreshCalls += 1;
        workspaceIds.push(source.workspaceId);
        return refreshedToken ?? null;
      },
    } satisfies NonNullable<SessionToolContext['credentialManager']>,
    getTokenCalls: () => getTokenCalls,
    refreshCalls: () => refreshCalls,
    workspaceIds: () => workspaceIds,
  };
}

describe('source_test HTTP MCP credential forwarding', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-http-mcp-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('forwards cached OAuth token to the MCP probe without refresh', async () => {
    writeHttpMcpSource(tempDir, 'oauth-cached');
    const cred = credentialManagerStub('cached-tok');
    const calls: ValidateMcpCall[] = [];

    await handleSourceTest(createCtx(tempDir, {
      credentialManager: cred.manager,
      validateMcpConnection: async (config) => {
        calls.push(config);
        return { success: true };
      },
    }), { sourceSlug: 'oauth-cached', autoEnable: false });

    expect(calls[0]?.accessToken).toBe('cached-tok');
    expect(cred.getTokenCalls()).toBe(1);
    expect(cred.refreshCalls()).toBe(0);
  });

  it('refreshes OAuth token on cache miss before probing MCP', async () => {
    writeHttpMcpSource(tempDir, 'oauth-refresh');
    const cred = credentialManagerStub(null, 'fresh-tok');
    const calls: ValidateMcpCall[] = [];

    await handleSourceTest(createCtx(tempDir, {
      credentialManager: cred.manager,
      validateMcpConnection: async (config) => {
        calls.push(config);
        return { success: true };
      },
    }), { sourceSlug: 'oauth-refresh', autoEnable: false });

    expect(calls[0]?.accessToken).toBe('fresh-tok');
    expect(cred.getTokenCalls()).toBe(1);
    expect(cred.refreshCalls()).toBe(1);
  });

  it('uses the stable Project id for the MCP probe and auth status', async () => {
    writeHttpMcpSource(tempDir, 'oauth-stable-owner', { isAuthenticated: true });
    const cred = credentialManagerStub('cached-tok');

    await handleSourceTest(createCtx(tempDir, {
      credentialManager: cred.manager,
      validateMcpConnection: async () => ({ success: true }),
    }), { sourceSlug: 'oauth-stable-owner', autoEnable: false });

    expect(cred.workspaceIds()).toEqual(['project-stable', 'project-stable']);
  });
});

// Tiny helper to build a no-callback ctx for tests that don't care about activation.
function ctx_for(workspacePath: string) {
  return createCtx(workspacePath, {
    activateSourceInSession: async () => ({ ok: true }),
  });
}
