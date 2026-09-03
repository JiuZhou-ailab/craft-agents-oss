// input: LLM connection model entries with explicit or implicit thinking metadata
// output: Regression coverage for capability-driven thinking controls
// pos: Shared model capability policy tests

import { describe, expect, it } from 'bun:test'
import {
  modelSupportsThinking,
  modelSupportsThinkingLevel,
  resolveModelThinkingLevel,
  type LlmConnection,
} from '../llm-connections.ts'
import { cloneManagedModelCatalog } from '../managed-model-catalog.ts'

function connection(
  providerType: LlmConnection['providerType'],
  models: LlmConnection['models'],
): Pick<LlmConnection, 'providerType' | 'models'> {
  return { providerType, models }
}

describe('modelSupportsThinking', () => {
  it('requires custom endpoints to opt in per model', () => {
    expect(modelSupportsThinking(connection('pi_compat', ['unknown-model']), 'unknown-model')).toBe(false)
    expect(modelSupportsThinking(connection('pi_compat', [
      { id: 'reasoning-model', supportsThinking: true } as never,
      { id: 'plain-model', supportsThinking: false } as never,
    ]), 'reasoning-model')).toBe(true)
    expect(modelSupportsThinking(connection('pi_compat', [
      { id: 'reasoning-model', supportsThinking: true } as never,
      { id: 'plain-model', supportsThinking: false } as never,
    ]), 'plain-model')).toBe(false)
  })

  it('keeps SDK-owned model definitions opt-out', () => {
    expect(modelSupportsThinking(connection('pi', [
      { id: 'legacy-model' } as never,
      { id: 'plain-model', supportsThinking: false } as never,
    ]), 'legacy-model')).toBe(true)
    expect(modelSupportsThinking(connection('pi', [
      { id: 'plain-model', supportsThinking: false } as never,
    ]), 'plain-model')).toBe(false)
  })
})

describe('model thinking levels', () => {
  const managedConnection = connection('pi_compat', [
    {
      id: 'gpt-5.6-sol',
      supportsThinking: true,
      thinkingLevelMap: { max: 'max' },
    } as never,
    {
      id: 'gpt-5.6-luna',
      supportsThinking: true,
      thinkingLevelMap: { xhigh: 'xhigh', max: null },
    } as never,
  ])

  it('exposes only levels supported by the concrete model', () => {
    expect(modelSupportsThinkingLevel(managedConnection, 'gpt-5.6-sol', 'max')).toBe(true)
    expect(modelSupportsThinkingLevel(managedConnection, 'gpt-5.6-luna', 'xhigh')).toBe(true)
    expect(modelSupportsThinkingLevel(managedConnection, 'gpt-5.6-luna', 'max')).toBe(false)
  })

  it('resolves an unsupported persisted level to the nearest supported level', () => {
    expect(resolveModelThinkingLevel(managedConnection, 'gpt-5.6-sol', 'max')).toBe('max')
    expect(resolveModelThinkingLevel(managedConnection, 'gpt-5.6-luna', 'max')).toBe('xhigh')
  })

  it('exposes supported Gemini thinking levels without offering invalid 3.7/3.8 minimal mode', () => {
    const geminiConnection = connection('pi_compat', cloneManagedModelCatalog('google-generative-ai'))

    for (const modelId of ['gemini-3.8-flash', 'gemini-3.7-flash']) {
      expect(modelSupportsThinking(geminiConnection, modelId)).toBe(true)
      expect(modelSupportsThinkingLevel(geminiConnection, modelId, 'off')).toBe(false)
      expect(modelSupportsThinkingLevel(geminiConnection, modelId, 'medium')).toBe(true)
      expect(modelSupportsThinkingLevel(geminiConnection, modelId, 'xhigh')).toBe(false)
    }
  })
})
