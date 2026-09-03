// input: Bundled LLM defaults fixtures and temporary config directories
// output: Regression coverage for managed connection metadata without static credentials
// pos: Tests distribution-provided LLM connection bootstrapping
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { applyBuiltinLlmConnectionDefaults, type StoredConfig } from '../storage.ts'
import type { BuiltinLlmConnectionDefaults, ConfigDefaults } from '../config-defaults-schema.ts'
import { MANAGED_MODEL_CATALOG, cloneManagedModelCatalog } from '../managed-model-catalog.ts'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href
const UTILS_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', '..', 'utils', 'index.ts')).href
const CREDENTIALS_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', '..', 'credentials', 'index.ts')).href
const BUNDLED_DEFAULTS_PATH = join(import.meta.dir, '../../../../../apps/electron/resources/config-defaults.json')
function makeConfig(overrides: Partial<StoredConfig> = {}): StoredConfig {
  return {
    workspaces: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    llmConnections: [],
    ...overrides,
  }
}

function makeDefaults(overrides: Partial<BuiltinLlmConnectionDefaults> = {}): ConfigDefaults {
  return {
    version: 'test',
    description: 'test defaults',
    defaults: {
      notificationsEnabled: true,
      colorTheme: 'default',
      autoCapitalisation: false,
      sendMessageKey: 'enter',
      spellCheck: false,
      keepAwakeWhileRunning: false,
      extendedPromptCache: false,
      browserToolEnabled: true,
    },
    workspaceDefaults: {
      thinkingLevel: 'medium',
      permissionMode: 'ask',
      cyclablePermissionModes: ['safe', 'ask', 'allow-all'],
      localMcpServers: { enabled: true },
    },
    builtinLlmConnections: [{
      enabled: true,
      connection: {
        slug: 'storyflow-managed',
        name: 'Internal Default',
        providerType: 'pi_compat',
        authType: 'api_key_with_endpoint',
        baseUrl: 'https://example.internal/v1',
        defaultModel: 'internal-model',
        models: ['internal-model'],
        modelSelectionMode: 'userDefined3Tier',
        piAuthProvider: 'openai',
        customEndpoint: { api: 'openai-responses' },
        hidden: true,
        managed: true,
        source: 'builtin',
        createdAt: 0,
      },
      ...overrides,
    }],
  }
}

function makePluralDefaults(): ConfigDefaults {
  const managed = makeDefaults().builtinLlmConnections![0]!
  return {
    ...makeDefaults(),
    builtinLlmConnections: [
      {
        ...managed,
        connection: {
          ...managed.connection!,
          models: [
            'gpt-5.5',
            'gpt-5.6-sol',
            'gpt-5.6-terra',
            'gpt-5.6-luna',
            'gemini-3.5-flash',
            'deepseek-v4-pro',
            'deepseek-v4-flash',
          ],
        },
      },
      {
        enabled: true,
        connection: {
          ...managed.connection!,
          slug: 'backup-default',
          name: 'Backup Default',
          baseUrl: 'https://example.internal/backup/v1',
          defaultModel: 'backup-model',
          models: ['backup-model'],
        },
      },
    ],
  } as ConfigDefaults
}

describe('builtin LLM connection defaults', () => {
  it('ships chat auto capitalisation disabled by default for IME-safe input', () => {
    const defaults = JSON.parse(readFileSync(BUNDLED_DEFAULTS_PATH, 'utf-8')) as ConfigDefaults

    expect(defaults.defaults.autoCapitalisation).toBe(false)
  })

  it('lets interactive sessions execute by default', () => {
    const defaults = JSON.parse(readFileSync(BUNDLED_DEFAULTS_PATH, 'utf-8')) as ConfigDefaults

    expect(defaults.workspaceDefaults.permissionMode).toBe('allow-all')
  })

  it('routes each managed model family through its native protocol', () => {
    const defaults = JSON.parse(readFileSync(BUNDLED_DEFAULTS_PATH, 'utf-8')) as ConfigDefaults
    const builtins = defaults.builtinLlmConnections ?? []
    const connections = builtins.map(entry => entry.connection)

    expect(connections.map(entry => entry?.slug)).toEqual([
      'storyflow-managed-deepseek',
      'storyflow-managed',
      'storyflow-managed-gemini',
      'storyflow-managed-anthropic',
    ])
    expect(builtins.map(entry => entry.enabled)).toEqual([true, true, true, true])
    expect(defaults.builtinLlmConnection).toBeUndefined()
    expect(JSON.stringify(defaults)).not.toContain('JiuZhou')
    expect(JSON.stringify(defaults)).not.toContain('gateway.ai.cloudflare.com')
    expect(JSON.stringify(defaults)).not.toContain('apiKey')
    expect(JSON.stringify(defaults)).not.toContain('revokedApiKeySha256')
    expect(connections).toMatchObject([
      {
        name: 'DeepSeek (Chat Completions)',
        baseUrl: 'https://storyflow-model.zjding.com/v1',
        defaultModel: 'deepseek-v4-flash',
        customEndpoint: { api: 'openai-completions' },
      },
      {
        name: 'GPT (Responses)',
        baseUrl: 'https://storyflow-model.zjding.com/v1',
        defaultModel: 'gpt-5.6-luna',
        customEndpoint: { api: 'openai-responses' },
      },
      {
        name: 'Gemini (GenAI)',
        baseUrl: 'https://storyflow-model.zjding.com/v1beta',
        defaultModel: 'gemini-3.5-flash',
        customEndpoint: { api: 'google-generative-ai' },
      },
      {
        name: 'Anthropic (Messages)',
        baseUrl: 'https://storyflow-model.zjding.com',
        defaultModel: 'claude-sonnet-5',
        customEndpoint: { api: 'anthropic-messages' },
      },
    ])

    const config = makeConfig()
    expect(applyBuiltinLlmConnectionDefaults(config, defaults)).toEqual({ changed: true })
    expect(config.llmConnections?.map(connection => [
      connection.slug,
      connection.models?.map(model => typeof model === 'string' ? model : model.id),
    ])).toEqual([
      ['storyflow-managed-deepseek', ['deepseek-v4-pro', 'deepseek-v4-flash']],
      ['storyflow-managed', ['gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']],
      ['storyflow-managed-gemini', [
        'gemini-3.8-flash',
        'gemini-3.7-flash',
        'gemini-3.6-flash',
        'gemini-3.5-flash',
        'gemini-3.1-pro-preview',
        'gemini-2.5-pro',
        'gemini-2.5-flash',
      ]],
      ['storyflow-managed-anthropic', ['claude-sonnet-5', 'claude-opus-5']],
    ])
    expect(config.defaultLlmConnection).toBe('storyflow-managed')
  })

  it('upgrades persisted managed model IDs to the canonical bundled catalog', () => {
    const defaults = JSON.parse(readFileSync(BUNDLED_DEFAULTS_PATH, 'utf-8')) as ConfigDefaults
    const bundled = defaults.builtinLlmConnections
      ?.find(entry => entry.connection?.slug === 'storyflow-managed')?.connection
    expect(bundled).toBeDefined()

    const config = makeConfig({
      defaultLlmConnection: 'storyflow-managed',
      llmConnections: [{
        ...bundled!,
        models: MANAGED_MODEL_CATALOG.map(model => model.id),
      }],
    })

    const result = applyBuiltinLlmConnectionDefaults(config, defaults)
    const models = config.llmConnections?.[0]?.models

    expect(result.changed).toBe(true)
    expect(models).toEqual(cloneManagedModelCatalog('openai-responses'))
    expect(models?.every(model => typeof model !== 'string')).toBe(true)
    expect(models?.map(model => typeof model === 'string' ? model : model.name))
      .toEqual(['GPT-5.5', 'GPT-5.6 Sol', 'GPT-5.6 Terra', 'GPT-5.6 Luna'])
    expect(models?.map(model => typeof model === 'string' ? model : model.shortName))
      .toEqual(['GPT', 'GPT', 'GPT', 'GPT'])
  })

  it('preserves the previously selected DeepSeek family when splitting the managed connection', () => {
    const defaults = JSON.parse(readFileSync(BUNDLED_DEFAULTS_PATH, 'utf-8')) as ConfigDefaults
    const legacyConnection = defaults.builtinLlmConnections
      ?.find(entry => entry.connection?.slug === 'storyflow-managed')?.connection
    const config = makeConfig({
      defaultLlmConnection: 'storyflow-managed',
      llmConnections: [{
        ...legacyConnection!,
        defaultModel: 'deepseek-v4-flash',
        models: MANAGED_MODEL_CATALOG.map(model => model.id),
      }],
    })

    expect(applyBuiltinLlmConnectionDefaults(config, defaults)).toEqual({ changed: true })
    expect(config.defaultLlmConnection).toBe('storyflow-managed-deepseek')
  })

  it('atomically migrates the legacy managed connection slug to the provider-neutral gateway identity', () => {
    const defaults = makeDefaults({
      connection: {
        ...makeDefaults().builtinLlmConnections![0]!.connection!,
        slug: 'storyflow-managed',
      },
    })
    const config = makeConfig({
      defaultLlmConnection: 'wangsu-default',
      llmConnections: [{
        ...makeDefaults().builtinLlmConnections![0]!.connection!,
        slug: 'wangsu-default',
      }],
    })

    expect(applyBuiltinLlmConnectionDefaults(config, defaults)).toEqual({ changed: true })
    expect(config.defaultLlmConnection).toBe('storyflow-managed')
    expect(config.llmConnections?.map(connection => connection.slug)).toEqual(['storyflow-managed'])
  })

  it('adds multiple bundled managed connections and keeps the first one as the default', () => {
    const config = makeConfig()
    const result = applyBuiltinLlmConnectionDefaults(config, makePluralDefaults())

    expect(result.changed).toBe(true)
    expect(config.defaultLlmConnection).toBe('storyflow-managed')
    expect(config.llmConnections?.map(c => c.slug)).toEqual(['storyflow-managed', 'backup-default'])
    expect(config.llmConnections?.find(c => c.slug === 'storyflow-managed')?.models)
      .toEqual(cloneManagedModelCatalog('openai-responses'))
    expect(config.llmConnections?.find(c => c.slug === 'backup-default')?.models).toEqual(['backup-model'])
  })

  it('adds the bundled managed connection without a credential side channel', () => {
    const config = makeConfig()
    const result = applyBuiltinLlmConnectionDefaults(config, makeDefaults())

    expect(result).toEqual({ changed: true })
    expect(config.defaultLlmConnection).toBe('storyflow-managed')
    expect(config.llmConnections).toHaveLength(1)
    expect(config.llmConnections?.[0]).toMatchObject({
      slug: 'storyflow-managed',
      hidden: true,
      managed: true,
    })
  })

  it('preserves a user-selected default connection when adding the bundled managed connection', () => {
    const config = makeConfig({
      defaultLlmConnection: 'user-default',
      llmConnections: [{
        slug: 'user-default',
        name: 'User Default',
        providerType: 'anthropic',
        authType: 'api_key',
        createdAt: 1,
      }],
    })

    const result = applyBuiltinLlmConnectionDefaults(config, makeDefaults())

    expect(result.changed).toBe(true)
    expect(config.defaultLlmConnection).toBe('user-default')
    expect(config.llmConnections?.map(c => c.slug)).toEqual(['user-default', 'storyflow-managed'])
  })

  it('is idempotent when the bundled connection already exists', () => {
    const config = makeConfig()
    applyBuiltinLlmConnectionDefaults(config, makeDefaults())

    const result = applyBuiltinLlmConnectionDefaults(config, makeDefaults())

    expect(result).toEqual({ changed: false })
    expect(config.llmConnections).toHaveLength(1)
  })

  it('updates existing managed bundled connection metadata', () => {
    const bundled = makeDefaults().builtinLlmConnections![0]!
    const config = makeConfig({
      defaultLlmConnection: 'storyflow-managed',
      llmConnections: [{
        ...bundled.connection!,
        name: '网宿',
        models: ['legacy-model'],
        piAuthProvider: 'anthropic',
        hidden: true,
        managed: true,
        source: 'builtin',
      }],
    })

    const result = applyBuiltinLlmConnectionDefaults(config, makeDefaults({
      connection: {
        ...bundled.connection!,
        name: 'Managed AI',
        hidden: false,
      },
    }))

    expect(result.changed).toBe(true)
    expect(config.llmConnections?.[0]?.name).toBe('Managed AI')
    expect(config.llmConnections?.[0]?.models).toEqual(cloneManagedModelCatalog('openai-responses'))
    expect(config.llmConnections?.[0]?.piAuthProvider).toBe('openai')
    expect(config.llmConnections?.[0]?.hidden).toBe(false)
  })

  it('reclaims a reserved bundled slug whose ownership metadata was tampered with', () => {
    const config = makeConfig({
      defaultLlmConnection: 'storyflow-managed',
      llmConnections: [{
        slug: 'storyflow-managed',
        name: 'User endpoint',
        providerType: 'anthropic',
        authType: 'api_key',
        managed: false,
        source: 'user',
        createdAt: 1,
      }],
    })

    expect(applyBuiltinLlmConnectionDefaults(config, makeDefaults())).toEqual({ changed: true })
    expect(config.llmConnections?.[0]).toMatchObject({
      slug: 'storyflow-managed',
      name: 'Internal Default',
      providerType: 'pi_compat',
      authType: 'api_key_with_endpoint',
      hidden: true,
      managed: true,
      source: 'builtin',
    })
  })

  it('ignores disabled defaults', () => {
    const config = makeConfig()
    const result = applyBuiltinLlmConnectionDefaults(config, makeDefaults({ enabled: false }))

    expect(result.changed).toBe(false)
    expect(config.llmConnections).toEqual([])
  })

  it('ignores legacy bundled and environment API keys', () => {
    const config = makeConfig()
    const defaults = makeDefaults() as ConfigDefaults & {
      builtinLlmConnections: Array<BuiltinLlmConnectionDefaults & { apiKey: string }>
    }
    defaults.builtinLlmConnections[0]!.apiKey = 'legacy-static-secret'
    const result = applyBuiltinLlmConnectionDefaults(config, defaults)

    expect(result).toEqual({ changed: true })
    expect(config.defaultLlmConnection).toBe('storyflow-managed')
    expect(config.llmConnections?.[0]).toMatchObject({
      slug: 'storyflow-managed',
      hidden: true,
      managed: true,
    })
    expect(JSON.stringify(config)).not.toContain('legacy-static-secret')
  })

  it('does not restore a static managed credential from legacy defaults or environment', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'craft-agent-builtin-env-'))
    const bundledRoot = join(configDir, 'bundle')
    const bundledResources = join(bundledRoot, 'resources')
    mkdirSync(bundledResources, { recursive: true })
    const defaults = makeDefaults() as ConfigDefaults & {
      builtinLlmConnections: Array<BuiltinLlmConnectionDefaults & { apiKey: string }>
    }
    defaults.builtinLlmConnections[0]!.apiKey = 'bundled-static-secret'

    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        workspaces: [],
        activeWorkspaceId: null,
        activeSessionId: null,
        llmConnections: [],
      }, null, 2),
      'utf-8',
    )
    writeFileSync(
      join(bundledResources, 'config-defaults.json'),
      JSON.stringify(defaults, null, 2),
      'utf-8',
    )

    const run = Bun.spawnSync([
      process.execPath,
      '--eval',
      `
        import { setBundledAssetsRoot } from '${UTILS_MODULE_PATH}';
        import { seedBuiltinLlmConnectionFromDefaults } from '${STORAGE_MODULE_PATH}';
        import { getCredentialManager } from '${CREDENTIALS_MODULE_PATH}';
        setBundledAssetsRoot(${JSON.stringify(bundledRoot)});
        await seedBuiltinLlmConnectionFromDefaults();
        const key = await getCredentialManager().getLlmApiKey('storyflow-managed');
        console.log(key ?? '');
      `,
    ], {
      env: {
        ...process.env,
        CRAFT_CONFIG_DIR: configDir,
        CRAFT_BUILTIN_LLM_API_KEY: 'env-managed-secret',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    if (run.exitCode !== 0) {
      throw new Error(`metadata sync subprocess failed:\n${run.stderr.toString()}`)
    }

    expect(run.stdout.toString().trim()).toBe('')
    expect(readFileSync(join(configDir, 'config.json'), 'utf-8')).not.toContain('env-managed-secret')
    expect(readFileSync(join(configDir, 'config.json'), 'utf-8')).not.toContain('bundled-static-secret')
  })
})
