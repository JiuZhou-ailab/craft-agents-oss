// input: Product-managed model capabilities shared by desktop bootstrap and gateway
// output: Canonical managed model definitions and safe mutable copies
// pos: Single source of truth for the Storyflow managed model catalog

import type { ModelDefinition } from './models.ts';
import type { CustomEndpointApi } from './llm-connections.ts';

export interface ManagedModelDefinition extends ModelDefinition {
  api: CustomEndpointApi;
}

export const MANAGED_MODEL_CATALOG: readonly ManagedModelDefinition[] = [
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    shortName: 'GPT',
    description: '',
    provider: 'pi',
    contextWindow: 262_144,
    supportsThinking: true,
    thinkingLevelMap: {
      off: 'none',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: null,
    },
    supportsImages: true,
    api: 'openai-responses',
  },
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    shortName: 'GPT',
    description: '',
    provider: 'pi',
    contextWindow: 262_144,
    supportsThinking: true,
    thinkingLevelMap: {
      off: 'none',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    },
    supportsImages: true,
    api: 'openai-responses',
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    shortName: 'GPT',
    description: '',
    provider: 'pi',
    contextWindow: 262_144,
    supportsThinking: true,
    thinkingLevelMap: {
      off: 'none',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    },
    supportsImages: true,
    api: 'openai-responses',
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    shortName: 'GPT',
    description: '',
    provider: 'pi',
    contextWindow: 262_144,
    supportsThinking: true,
    thinkingLevelMap: {
      off: 'none',
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: null,
    },
    supportsImages: true,
    api: 'openai-responses',
  },
  {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    shortName: 'Claude',
    description: '',
    provider: 'anthropic',
    contextWindow: 1_000_000,
    supportsThinking: true,
    supportsImages: true,
    api: 'anthropic-messages',
  },
  {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    shortName: 'Claude',
    description: '',
    provider: 'anthropic',
    contextWindow: 1_000_000,
    supportsThinking: true,
    supportsImages: true,
    api: 'anthropic-messages',
  },
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    shortName: 'Gemini',
    description: '',
    provider: 'pi',
    contextWindow: 1_000_000,
    supportsThinking: true,
    thinkingLevelMap: {
      off: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: null,
      max: null,
    },
    supportsImages: true,
    api: 'google-generative-ai',
  },
  {
    id: 'gemini-3.7-flash',
    name: 'Gemini 3.7 Flash',
    shortName: 'Gemini',
    description: '',
    provider: 'pi',
    contextWindow: 1_000_000,
    supportsThinking: true,
    thinkingLevelMap: {
      off: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: null,
      max: null,
    },
    supportsImages: true,
    api: 'google-generative-ai',
  },
  {
    id: 'gemini-3.6-flash',
    name: 'Gemini 3.6 Flash',
    shortName: 'Gemini',
    description: '',
    provider: 'pi',
    contextWindow: 1_000_000,
    supportsThinking: true,
    thinkingLevelMap: {
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: null,
      max: null,
    },
    supportsImages: true,
    api: 'google-generative-ai',
  },
  {
    id: 'gemini-3.5-flash',
    name: 'Gemini 3.5 Flash',
    shortName: 'Gemini',
    description: '',
    provider: 'pi',
    contextWindow: 1_000_000,
    supportsThinking: true,
    thinkingLevelMap: {
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: null,
      max: null,
    },
    supportsImages: true,
    api: 'google-generative-ai',
  },
  {
    id: 'gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro Preview',
    shortName: 'Gemini',
    description: '',
    provider: 'pi',
    contextWindow: 1_000_000,
    supportsThinking: true,
    thinkingLevelMap: {
      off: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: null,
      max: null,
    },
    supportsImages: true,
    api: 'google-generative-ai',
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    shortName: 'Gemini',
    description: '',
    provider: 'pi',
    contextWindow: 1_000_000,
    supportsThinking: true,
    thinkingLevelMap: {
      off: null,
      xhigh: null,
      max: null,
    },
    supportsImages: true,
    api: 'google-generative-ai',
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    shortName: 'Gemini',
    description: '',
    provider: 'pi',
    contextWindow: 1_000_000,
    supportsThinking: true,
    thinkingLevelMap: {
      xhigh: null,
      max: null,
    },
    supportsImages: true,
    api: 'google-generative-ai',
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    shortName: 'DeepSeek',
    description: '',
    provider: 'pi',
    contextWindow: 1_000_000,
    supportsThinking: false,
    supportsImages: false,
    api: 'openai-completions',
  },
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    shortName: 'DeepSeek',
    description: '',
    provider: 'pi',
    contextWindow: 1_000_000,
    supportsThinking: false,
    supportsImages: false,
    api: 'openai-completions',
  },
];

export function getManagedDynamicModel(id: string): ManagedModelDefinition | null {
  if (!/^gemini-3\.6-[a-z0-9._-]+$/i.test(id)) return null;

  // ponytail: JZ inventory exposes IDs only; use conservative Gemini-family
  // capabilities until its model metadata includes per-model capability fields.
  const name = id
    .split('-')
    .map(part => part === 'gemini' ? 'Gemini' : part.replace(/^\w/, char => char.toUpperCase()))
    .join(' ');

  return {
    id,
    name,
    shortName: 'Gemini',
    description: '',
    provider: 'pi',
    contextWindow: 1_000_000,
    supportsThinking: true,
    thinkingLevelMap: {
      off: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: null,
      max: null,
    },
    supportsImages: true,
    api: 'google-generative-ai',
  };
}

export function mergeManagedModelCatalog(upstreamModelIds: Iterable<string>): ManagedModelDefinition[] {
  const catalog = MANAGED_MODEL_CATALOG.map(model => ({ ...model }));
  const knownIds = new Set(catalog.map(model => model.id));

  for (const id of upstreamModelIds) {
    if (knownIds.has(id)) continue;
    const model = getManagedDynamicModel(id);
    if (!model) continue;
    catalog.push(model);
    knownIds.add(id);
  }

  return catalog;
}

export function isManagedModelAllowed(id: string, api: CustomEndpointApi): boolean {
  return MANAGED_MODEL_CATALOG.some(model => model.id === id && model.api === api)
    || getManagedDynamicModel(id)?.api === api;
}

export function cloneManagedModelCatalog(api?: CustomEndpointApi): ModelDefinition[] {
  return MANAGED_MODEL_CATALOG
    .filter(model => !api || model.api === api)
    .map(({ api: _api, ...model }) => ({
      ...model,
      ...(model.thinkingLevelMap
        ? { thinkingLevelMap: { ...model.thinkingLevelMap } }
        : {}),
    }));
}
