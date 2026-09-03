// input: Provider connections, credentials, and host runtime fixtures
// output: Pi configuration resolution, model discovery, and validation assertions
// pos: Regression test for the Storyflow-to-Pi configuration boundary

/**
 * Tests for Pi connection/runtime configuration.
 *
 * Verifies:
 * - Provider detection from auth type
 * - Pi configuration for different providers
 * - LLM connection type mapping
 * - Available providers list
 */
import { describe, it, expect } from 'bun:test';
import {
  fetchBackendModels,
  connectionAuthTypeToBackendAuthType,
  resolveBackendContext,
  resolvePiAgentConfig,
  resolveModelForConnection,
  resolveManagedModelConnection,
  resolveSetupTestConnectionHint,
  testBackendConnection,
  validateStoredBackendConnection,
} from '../connection-runtime.ts';
import type { BackendConfig } from '../types.ts';
import type { Workspace, LlmConnection } from '../../../config/storage.ts';
import type { SessionConfig as Session } from '../../../sessions/storage.ts';
import { PiAgent } from '../../pi-agent.ts';
import { isValidProviderAuthCombination } from '../../../config/llm-connections.ts';

// Test helpers
function createTestWorkspace(): Workspace {
  return {
    id: 'test-workspace',
    name: 'Test Workspace',
    slug: 'workspace',
    rootPath: '/test/workspace',
    createdAt: Date.now(),
  };
}

function createTestSession(): Session {
  return {
    id: 'test-session',
    name: 'Test Session',
    workspaceRootPath: '/test/workspace',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    permissionMode: 'ask',
  };
}

function createTestConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    workspace: createTestWorkspace(),
    session: createTestSession(),
    isHeadless: true, // Prevent config watchers from starting
    ...overrides,
  };
}

describe('connectionAuthTypeToBackendAuthType (legacy)', () => {
  it('should map api_key to api_key', () => {
    expect(connectionAuthTypeToBackendAuthType('api_key')).toBe('api_key');
  });

  it('should pass through oauth', () => {
    expect(connectionAuthTypeToBackendAuthType('oauth')).toBe('oauth');
  });

  it('should map none to undefined', () => {
    expect(connectionAuthTypeToBackendAuthType('none')).toBeUndefined();
  });
});

// ============================================================
// Provider-Auth Validation Tests
// ============================================================

describe('isValidProviderAuthCombination', () => {
  describe('Anthropic provider', () => {
    it('should accept api_key auth', () => {
      expect(isValidProviderAuthCombination('anthropic', 'api_key')).toBe(true);
    });

    it('should accept oauth auth', () => {
      expect(isValidProviderAuthCombination('anthropic', 'oauth')).toBe(true);
    });

    it('should reject api_key_with_endpoint auth', () => {
      expect(isValidProviderAuthCombination('anthropic', 'api_key_with_endpoint')).toBe(false);
    });

    it('should reject none auth', () => {
      expect(isValidProviderAuthCombination('anthropic', 'none')).toBe(false);
    });
  });

  describe('Pi provider', () => {
    it('should accept api_key auth', () => {
      expect(isValidProviderAuthCombination('pi', 'api_key')).toBe(true);
    });

    it('should accept oauth auth', () => {
      expect(isValidProviderAuthCombination('pi', 'oauth')).toBe(true);
    });

    it('should accept none auth', () => {
      expect(isValidProviderAuthCombination('pi', 'none')).toBe(true);
    });
  });

  describe('Pi compat provider', () => {
    it('should accept api_key_with_endpoint auth', () => {
      expect(isValidProviderAuthCombination('pi_compat', 'api_key_with_endpoint')).toBe(true);
    });

    it('should accept none auth (for local models like Ollama)', () => {
      expect(isValidProviderAuthCombination('pi_compat', 'none')).toBe(true);
    });
  });

});

describe('Pi connection/runtime APIs', () => {
  it('resolves PiAgent configuration without constructing a runtime', () => {
    const connection: LlmConnection = {
      slug: 'openai-direct',
      name: 'OpenAI',
      providerType: 'pi',
      authType: 'oauth',
      piAuthProvider: 'openai-codex',
      defaultModel: 'gpt-5.5',
      createdAt: Date.now(),
    };

    const config = resolvePiAgentConfig({
      context: { connection, authType: 'oauth', resolvedModel: 'gpt-5.5' },
      coreConfig: createTestConfig(),
      hostRuntime: { appRootPath: process.cwd(), isPackaged: false },
    });

    expect(config.providerType).toBe('pi');
    expect(config.connectionSlug).toBe('openai-direct');
    expect(config.model).toBe('gpt-5.5');
    expect(config.runtime?.piAuthProvider).toBe('openai-codex');
  });

  it('resolveBackendContext remains connection-only without a stored connection', () => {
    const context = resolveBackendContext({});
    expect(context).not.toHaveProperty('provider');
    expect(context).not.toHaveProperty('capabilities');
  });

  it('keeps the session model selected for an Anthropic connection running on Pi', () => {
    const connection: LlmConnection = {
      slug: 'anthropic-direct',
      name: 'Anthropic',
      providerType: 'anthropic',
      authType: 'api_key',
      defaultModel: 'claude-sonnet-4-6',
      models: ['claude-sonnet-4-6', 'claude-opus-4-6'],
      createdAt: Date.now(),
    };

    expect(resolveModelForConnection('claude-opus-4-6', connection)).toBe('claude-opus-4-6');
    expect(resolveModelForConnection(undefined, connection)).toBe('claude-sonnet-4-6');
  });

  it('routes a legacy managed session through the connection that owns its model', () => {
    const managedConnection = (slug: string, model: string): LlmConnection => ({
      slug,
      name: slug,
      providerType: 'pi_compat',
      authType: 'api_key_with_endpoint',
      models: [model],
      createdAt: Date.now(),
    });
    const gpt = managedConnection('storyflow-managed', 'gpt-5.5');
    const deepseek = managedConnection('storyflow-managed-deepseek', 'deepseek-v4-flash');

    expect(resolveManagedModelConnection(gpt, 'deepseek-v4-flash', [gpt, deepseek])).toBe(deepseek);
    expect(resolveManagedModelConnection(gpt, 'gpt-5.5', [gpt, deepseek])).toBe(gpt);
  });

  it('resolveSetupTestConnectionHint maps provider/baseUrl/piAuthProvider correctly', () => {
    expect(resolveSetupTestConnectionHint({
      provider: 'anthropic',
      baseUrl: 'https://api.example.com',
    })).toEqual({ providerType: 'pi_compat' });

    expect(resolveSetupTestConnectionHint({
      provider: 'anthropic',
      baseUrl: '',
    })).toEqual({ providerType: 'anthropic' });

    expect(resolveSetupTestConnectionHint({
      provider: 'pi',
      piAuthProvider: 'openai-codex',
    })).toEqual({ providerType: 'pi', piAuthProvider: 'openai-codex' });

    expect(resolveSetupTestConnectionHint({
      provider: 'pi',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      customEndpoint: { api: 'openai-completions' },
    })).toEqual({ providerType: 'pi_compat', piAuthProvider: 'openai', customEndpoint: { api: 'openai-completions' } });

    expect(resolveSetupTestConnectionHint({
      provider: 'pi',
      baseUrl: 'https://my-anthropic-proxy.internal/v1',
      customEndpoint: { api: 'anthropic-messages' },
    })).toEqual({ providerType: 'pi_compat', piAuthProvider: 'anthropic', customEndpoint: { api: 'anthropic-messages' } });

    expect(resolveSetupTestConnectionHint({
      provider: 'pi',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      customEndpoint: { api: 'google-generative-ai' },
    })).toEqual({ providerType: 'pi_compat', piAuthProvider: 'google', customEndpoint: { api: 'google-generative-ai' } });
  });

  it('fetchBackendModels dispatches for pi provider', async () => {
    const connection: LlmConnection = {
      slug: 'pi-test',
      name: 'Pi Test',
      providerType: 'pi',
      authType: 'none',
      createdAt: Date.now(),
    };

    const result = await fetchBackendModels({
      connection,
      credentials: {},
      hostRuntime: {
        appRootPath: process.cwd(),
        isPackaged: false,
      },
    });

    expect(result.models.length).toBeGreaterThan(0);
  });

  it('validateStoredBackendConnection returns not found for unknown slug', async () => {
    const result = await validateStoredBackendConnection({
      slug: '__missing-connection__',
      hostRuntime: {
        appRootPath: process.cwd(),
        isPackaged: false,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Connection not found');
  });

  it('testBackendConnection keeps required model argument and validates key presence', async () => {
    const result = await testBackendConnection({
      provider: 'anthropic',
      apiKey: '   ',
      model: 'claude-sonnet-4-6',
      hostRuntime: {
        appRootPath: process.cwd(),
        isPackaged: false,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('API key is required');
  });

});

describe('PiAgent model switching', () => {
  it('setModel updates getModel (regression: setModel used to write config.model but getModel reads _model)', () => {
    const agent = new PiAgent(createTestConfig({ model: 'claude-opus-4-7' }));

    expect(agent.getModel()).toBe('claude-opus-4-7');

    agent.setModel('claude-sonnet-4-6');

    expect(agent.getModel()).toBe('claude-sonnet-4-6');
  });
});
