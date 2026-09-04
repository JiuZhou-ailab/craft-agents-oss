// input: Custom endpoint model normalization and provider routing helpers.
// output: Regression checks for model capabilities, registration keys, and credential rotation slots.
// pos: Focused contract tests for the Pi custom endpoint policy.

import { describe, expect, it } from 'bun:test'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { clampThinkingLevel, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { cloneManagedModelCatalog } from '../../shared/src/config/managed-model-catalog.ts'
import {
  buildCustomEndpointModelDef,
  normalizeCustomEndpointModelEntry,
  resolveCustomEndpointProviderName,
  resolveRuntimeCredentialProviderNames,
  shouldUseCustomEndpointBearerAuthHeader,
  resolveCustomEndpointProviderApiKey,
  stripPiPrefix,
} from './custom-endpoint-models.ts'

describe('normalizeCustomEndpointModelEntry', () => {
  it('strips pi/ prefixes from string model IDs', () => {
    expect(stripPiPrefix('pi/my-model')).toBe('my-model')
    expect(normalizeCustomEndpointModelEntry('pi/my-model')).toEqual({ id: 'my-model' })
  })

  it('preserves per-model image support when enabled', () => {
    expect(normalizeCustomEndpointModelEntry({
      id: 'pi/vision-model',
      supportsImages: true,
    })).toEqual({
      id: 'vision-model',
      supportsImages: true,
    })
  })

  it('preserves explicit per-model image support when disabled', () => {
    expect(normalizeCustomEndpointModelEntry({
      id: 'pi/text-only-model',
      supportsImages: false,
    })).toEqual({
      id: 'text-only-model',
      supportsImages: false,
    })
  })

  it('preserves context window and image support together', () => {
    const thinkingLevelMap = {
      off: 'none',
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: null,
    } as const
    expect(normalizeCustomEndpointModelEntry({
      id: 'pi/vision-model',
      contextWindow: 262_144,
      supportsImages: true,
      supportsThinking: true,
      thinkingLevelMap,
    })).toEqual({
      id: 'vision-model',
      contextWindow: 262_144,
      supportsImages: true,
      supportsThinking: true,
      thinkingLevelMap,
    })
  })
})

describe('buildCustomEndpointModelDef', () => {
  it('defaults custom endpoint models to text-only input', () => {
    const model = buildCustomEndpointModelDef('my-model')
    expect(model.input).toEqual(['text'])
  })

  it('enables image input when the connection explicitly opts in', () => {
    const model = buildCustomEndpointModelDef('vision-model', { supportsImages: true })
    expect(model.input).toEqual(['text', 'image'])
  })

  it('lets per-model overrides disable image input even when the connection default is enabled', () => {
    const model = buildCustomEndpointModelDef('text-only-model', { supportsImages: true }, { supportsImages: false })
    expect(model.input).toEqual(['text'])
  })

  it('lets per-model overrides enable image input and custom context window', () => {
    const thinkingLevelMap = {
      off: 'none',
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: null,
    } as const
    const model = buildCustomEndpointModelDef('vision-model', undefined, {
      supportsImages: true,
      supportsThinking: true,
      thinkingLevelMap,
      contextWindow: 262_144,
    })
    expect(model.input).toEqual(['text', 'image'])
    expect(model.reasoning).toBe(true)
    expect(model.thinkingLevelMap).toEqual(thinkingLevelMap)
    expect(clampThinkingLevel(model as never, 'minimal')).toBe('low')
    expect(clampThinkingLevel(model as never, 'max')).toBe('xhigh')
    expect(model.contextWindow).toBe(262_144)
  })

  it('carries managed Gemini 3.7/3.8 thinking levels into the Pi runtime model', () => {
    const managedModels = cloneManagedModelCatalog('google-generative-ai')

    for (const modelId of ['gemini-3.8-flash', 'gemini-3.7-flash']) {
      const managed = managedModels.find(model => model.id === modelId)
      expect(managed).toBeDefined()

      const model = buildCustomEndpointModelDef(modelId, undefined, {
        supportsThinking: managed!.supportsThinking,
        thinkingLevelMap: managed!.thinkingLevelMap,
      })
      expect(model.reasoning).toBe(true)
      expect(clampThinkingLevel(model as never, 'medium')).toBe('medium')
      expect(clampThinkingLevel(model as never, 'off')).toBe('minimal')
    }
  })
})

describe('resolveCustomEndpointProviderApiKey', () => {
  it('uses the configured API key when present', () => {
    expect(resolveCustomEndpointProviderApiKey({
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
    })).toBe('sk-test')
  })

  it('uses a placeholder for keyless custom endpoints so Pi can register models', () => {
    expect(resolveCustomEndpointProviderApiKey({
      apiKey: '',
      baseUrl: 'https://keyless.example.com/v1',
      authType: 'none',
    })).toBe('not-needed')
  })

  it('uses a placeholder for local endpoints that do not require auth', () => {
    expect(resolveCustomEndpointProviderApiKey({
      apiKey: '',
      baseUrl: 'http://127.0.0.1:11434/v1',
    })).toBe('not-needed')
  })
})

describe('resolveCustomEndpointProviderName', () => {
  it('uses the normal synthetic provider for generic compatible endpoints', () => {
    expect(resolveCustomEndpointProviderName('openai')).toBe('custom-endpoint')
    expect(resolveCustomEndpointProviderName(undefined)).toBe('custom-endpoint')
  })

  it('keeps Cloudflare AI Gateway models under the Cloudflare provider', () => {
    expect(resolveCustomEndpointProviderName('cloudflare-ai-gateway')).toBe('cloudflare-ai-gateway')
  })
})

describe('resolveRuntimeCredentialProviderNames', () => {
  it('updates both the source and synthetic provider for generic custom endpoints', () => {
    expect(resolveRuntimeCredentialProviderNames('openai', true)).toEqual([
      'openai',
      'custom-endpoint',
    ])
  })

  it('does not duplicate providers with first-class custom endpoint routing', () => {
    expect(resolveRuntimeCredentialProviderNames('cloudflare-ai-gateway', true)).toEqual([
      'cloudflare-ai-gateway',
    ])
  })

  it('only updates the authenticated provider without a custom endpoint', () => {
    expect(resolveRuntimeCredentialProviderNames('openai', false)).toEqual(['openai'])
  })

  it('rotates the credential read by an already-registered synthetic provider', async () => {
    const credentials = new InMemoryCredentialStore()
    await credentials.modify('custom-endpoint', async () => ({ type: 'api_key', key: 'old-token' }))
    const models = await ModelRuntime.create({ credentials, modelsPath: null })
    models.registerProvider('custom-endpoint', {
      baseUrl: 'https://model.example.com/v1',
      apiKey: 'old-token',
      api: 'openai-completions',
      models: [buildCustomEndpointModelDef('test-model')],
    })

    await credentials.modify('openai', async () => ({ type: 'api_key', key: 'new-token' }))
    expect((await models.getAuth('custom-endpoint'))?.auth.apiKey).toBe('old-token')

    for (const provider of resolveRuntimeCredentialProviderNames('openai', true)) {
      await credentials.modify(provider, async () => ({ type: 'api_key', key: 'new-token' }))
    }
    expect((await models.getAuth('custom-endpoint'))?.auth.apiKey).toBe('new-token')
  })
})

describe('shouldUseCustomEndpointBearerAuthHeader', () => {
  it('lets Cloudflare AI Gateway attach cf-aig-authorization itself', () => {
    expect(shouldUseCustomEndpointBearerAuthHeader('cloudflare-ai-gateway')).toBe(false)
  })

  it('keeps Authorization bearer auth for generic compatible endpoints', () => {
    expect(shouldUseCustomEndpointBearerAuthHeader('custom-endpoint')).toBe(true)
  })
})
