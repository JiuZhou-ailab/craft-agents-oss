// input: Persisted connection settings, provider catalogs, and credential metadata
// output: Canonical LLM connection CRUD, model defaults, validation, and provider helpers
// pos: Single source of truth for Storyflow LLM connection behavior

/**
 * LLM Connections
 *
 * Named provider configurations that users can add, configure, and switch between.
 * Each session locks to a specific connection after the first message.
 * Workspaces can set a default connection.
 */

// Import model types and lists from centralized registry
// NOTE: Pi SDK functions (getPiModelsForAuthProvider, getAllPiModels) are NOT imported
// here because @earendil-works/pi-ai transitively pulls in @aws-sdk which uses Node.js
// `stream` module — breaking the Vite renderer build. Instead, Pi model resolution is
// injected at app startup via registerPiModelResolver().
import {
  type ModelDefinition,
  normalizeDeprecatedModelId,
} from './models';
import {
  THINKING_LEVEL_IDS,
  type ThinkingLevel,
} from '../agent/thinking-levels.ts';
import type { CredentialManager } from '../credentials/manager.ts';

// ============================================================
// Pi Model Resolver (dependency injection to avoid Pi SDK in renderer)
// ============================================================

type PiModelResolver = (piAuthProvider?: string) => ModelDefinition[];
let _piModelResolver: PiModelResolver = () => [];

/**
 * Register the Pi model resolver function.
 * Must be called from main process at app startup (before any Pi connections are used).
 * This avoids pulling @earendil-works/pi-ai into the renderer bundle.
 */
export function registerPiModelResolver(resolver: PiModelResolver): void {
  _piModelResolver = resolver;
}

// ============================================================
// Types
// ============================================================

/**
 * Provider type determines model/auth protocol routing inside the Pi runtime.
 * This is separate from auth mechanism - a provider may support multiple auth types.
 *
 * - 'anthropic': Direct Anthropic API (api.anthropic.com) through Pi
 * - 'pi': Pi unified LLM API (20+ providers via @earendil-works/pi-ai)
 * - 'pi_compat': Pi with custom endpoint (Ollama, self-hosted models, Anthropic-compat endpoints)
 *
 * Legacy values (bedrock, vertex, anthropic_compat) are migrated on startup
 * by migrateLegacyProviderTypes() in storage.ts.
 */
export type LlmProviderType =
  | 'anthropic'
  | 'pi'
  | 'pi_compat';

export const MANAGED_LLM_CONNECTION_SLUG = 'storyflow-managed';
export const MANAGED_DEEPSEEK_CONNECTION_SLUG = 'storyflow-managed-deepseek';
export const MANAGED_GEMINI_CONNECTION_SLUG = 'storyflow-managed-gemini';
export const MANAGED_ANTHROPIC_CONNECTION_SLUG = 'storyflow-managed-anthropic';

export const MANAGED_LLM_CONNECTION_SLUGS = [
  MANAGED_LLM_CONNECTION_SLUG,
  MANAGED_DEEPSEEK_CONNECTION_SLUG,
  MANAGED_GEMINI_CONNECTION_SLUG,
  MANAGED_ANTHROPIC_CONNECTION_SLUG,
] as const;

/**
 * Migration-only identifier used by releases before the provider-neutral
 * managed gateway contract. Runtime decisions must use the canonical slug.
 */
export const LEGACY_MANAGED_LLM_CONNECTION_SLUG = 'wangsu-default';

export function normalizeLlmConnectionSlug(slug: string): string {
  return slug === LEGACY_MANAGED_LLM_CONNECTION_SLUG
    ? MANAGED_LLM_CONNECTION_SLUG
    : slug;
}

export function isManagedLlmConnectionSlug(slug: string): boolean {
  const normalized = normalizeLlmConnectionSlug(slug);
  return (MANAGED_LLM_CONNECTION_SLUGS as readonly string[]).includes(normalized);
}

/**
 * @deprecated Use LlmProviderType instead. Kept for migration compatibility.
 */
export type LlmConnectionType = 'anthropic' | 'openai' | 'openai-compat';

/**
 * Authentication mechanism for the connection.
 * Determines the UI pattern, credential storage format, and how credentials are passed.
 *
 * Simple token auth:
 * - 'api_key': Single API key field, fixed endpoint known
 * - 'api_key_with_endpoint': API key + custom endpoint URL fields
 * - 'bearer_token': Single bearer token (different header than API key)
 *
 * OAuth flows (browser redirect):
 * - 'oauth': Browser OAuth flow, provider determined by providerType
 *
 * Cloud provider auth:
 * - 'iam_credentials': AWS-style (Access Key + Secret Key + Region)
 * - 'service_account_file': GCP-style JSON file upload
 * - 'environment': Auto-detect from environment variables
 *
 * No auth:
 * - 'none': No authentication required (local models like Ollama)
 */
export type LlmAuthType =
  | 'api_key'
  | 'api_key_with_endpoint'
  | 'oauth'
  | 'iam_credentials'
  | 'bearer_token'
  | 'service_account_file'
  | 'environment'
  | 'none';

/**
 * Ownership mode for a connection's model list.
 * - automaticallySyncedFromProvider: provider defaults are synced automatically.
 * - userDefined3Tier: user-picked Best/Balanced/Fast list is preserved.
 */
export type ModelSelectionMode = 'automaticallySyncedFromProvider' | 'userDefined3Tier';

/**
 * Protocol for custom API endpoints.
 * Determines which streaming adapter the Pi SDK uses for requests.
 */
export type CustomEndpointApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai';

/**
 * Custom endpoint protocol config.
 * Set when user configures an arbitrary API endpoint (Ollama, DashScope, vLLM, etc.).
 */
export interface CustomEndpointConfig {
  api: CustomEndpointApi;
  /** Explicit capability hint for arbitrary endpoints — never guessed automatically. */
  supportsImages?: boolean;
}

/**
 * Per-connection behavior when the user sends a message while the agent is
 * still streaming/processing a previous turn.
 *
 * - 'steer': Try to deliver the message into the in-flight turn (Pi's native
 *   `.steer()` or Claude's PreToolUse `additionalContext` hook). Falls back to
 *   abort+queue when the backend can't steer.
 * - 'queue': Hold the message; let the current turn finish naturally; replay
 *   as a new turn afterwards. No abort, no destructive interruption.
 *
 * Default is per-`providerType` via {@link defaultMidStreamBehavior}; reads
 * everywhere should go through {@link resolveMidStreamBehavior} so connections
 * created before this field existed still pick up the right default.
 */
export type MidStreamBehavior = 'steer' | 'queue';

/**
 * LLM Connection configuration.
 * Stored in config.llmConnections array.
 */
export interface LlmConnection {
  /** URL-safe identifier (e.g., 'anthropic-api', 'ollama-local') */
  slug: string;

  /** Display name shown in UI (e.g., 'Anthropic (API Key)', 'Ollama') */
  name: string;

  /** Provider type determines backend/SDK implementation */
  providerType: LlmProviderType;

  /**
   * @deprecated Use providerType instead. Kept for migration compatibility.
   * Will be removed in a future version.
   */
  type?: LlmConnectionType;

  /** Custom base URL (required for *_compat providers, optional override for others) */
  baseUrl?: string;

  /** Authentication mechanism */
  authType: LlmAuthType;

  /** Override available models (for custom endpoints that don't support model listing) */
  models?: Array<ModelDefinition | string>;

  /** Default model for this connection */
  defaultModel?: string;

  /**
   * Ownership mode for the model list.
   * - automaticallySyncedFromProvider: provider defaults are kept in sync.
   * - userDefined3Tier: preserve user-selected Best/Balanced/Fast list.
   */
  modelSelectionMode?: ModelSelectionMode;

  /**
   * Pi auth provider name (e.g., 'anthropic', 'openai', 'github-copilot').
   * Determines which provider credential Pi SDK uses for LLM calls.
   * Only relevant for 'pi' providerType connections.
   */
  piAuthProvider?: string;

  /**
   * Custom endpoint protocol config.
   * Set when user configures an arbitrary API endpoint (Ollama, DashScope, vLLM, etc.).
   * Determines which streaming adapter the Pi SDK uses for requests.
   */
  customEndpoint?: CustomEndpointConfig;

  /**
   * Behavior when the user sends a message while the agent is still streaming.
   * Optional for backward compat with config.json from before this field existed —
   * read via {@link resolveMidStreamBehavior} which falls back to a per-provider
   * default ({@link defaultMidStreamBehavior}).
   */
  midStreamBehavior?: MidStreamBehavior;

  /** Hide this connection from user-facing connection management surfaces. */
  hidden?: boolean;

  /** Marks a connection managed by the app/distribution rather than the user. */
  managed?: boolean;

  /** Optional provenance marker for distribution-provided connections. */
  source?: 'builtin' | string;

  // --- Timestamps ---

  /** Timestamp when connection was created */
  createdAt: number;

  /** Timestamp when connection was last used */
  lastUsedAt?: number;
}

/**
 * LLM Connection with authentication status.
 * Used by UI to show which connections are ready to use.
 */
export interface LlmConnectionWithStatus extends LlmConnection {
  /** Whether the connection has valid credentials */
  isAuthenticated: boolean;

  /** Error message if authentication check failed */
  authError?: string;

  /** Whether this is the global default connection */
  isDefault?: boolean;
}

// ============================================================
// Helpers
// ============================================================

/**
 * Returns true when `modelId` must NOT be used as the mini/summarization model
 * given the current auth flavor.
 *
 * - `codex-mini-latest` is always denied (Pi SDK rejects it outright).
 * - When `piAuthProvider === 'openai-codex'` (ChatGPT Plus/Pro OAuth or
 *   ChatGPT-JWT API key), all `*codex-mini*` variants (e.g. `gpt-5.1-codex-mini`)
 *   are denied — the ChatGPT backend refuses them with: "The '<model>' model is
 *   not supported when using Codex with a ChatGPT account."
 *   A regular OpenAI API key uses provider `'openai'`, which is unaffected.
 */
export function isDeniedMiniModelId(modelId: string, piAuthProvider?: string): boolean {
  const bare = modelId.startsWith('pi/') ? modelId.slice(3) : modelId;
  if (bare === 'codex-mini-latest') return true;
  if (piAuthProvider === 'openai-codex' && bare.includes('codex-mini')) return true;
  return false;
}

/**
 * Get the mini/utility model ID for a connection.
 * Provider-aware search:
 *   - Anthropic: find any model with "haiku" in its id/name
 *   - Pi: find any model with "mini" or "flash" in its id/name
 *   - Otherwise: last model in the list
 *
 * Auth-flavor-aware: skips models that the user's `piAuthProvider` would reject
 * (e.g. `gpt-5.1-codex-mini` under ChatGPT-account auth). See
 * {@link isDeniedMiniModelId}.
 *
 * Used for mini agent, title generation, and mini completions.
 */
export function getMiniModel(
  connection: Pick<LlmConnection, 'models' | 'providerType' | 'piAuthProvider'>,
): string | undefined {
  return findSmallModel(connection);
}

/**
 * Get the summarization model ID for a connection.
 * Same provider-aware logic as getMiniModel(), but separate
 * so summarization and mini agent models can diverge independently.
 *
 * Used for response summarization and API tool summarization.
 */
export function getSummarizationModel(
  connection: Pick<LlmConnection, 'models' | 'providerType' | 'piAuthProvider'>,
): string | undefined {
  return findSmallModel(connection);
}

/**
 * Provider-aware small model resolution.
 * Shared implementation for getMiniModel() and getSummarizationModel().
 *
 *   - Anthropic: find "haiku"
 *   - Pi: find "mini" or "flash"
 *   - Otherwise: last model in the list
 *
 * Skips models denied by {@link isDeniedMiniModelId} for the connection's
 * auth flavor.
 */
function findSmallModel(
  connection: Pick<LlmConnection, 'models' | 'providerType' | 'piAuthProvider'>,
): string | undefined {
  if (!connection.models || connection.models.length === 0) return undefined;

  const toId = (m: ModelDefinition | string) => typeof m === 'string' ? m : m.id;

  const toSearchStr = (m: ModelDefinition | string) =>
    typeof m === 'string' ? m.toLowerCase() : `${m.id} ${m.name} ${m.shortName}`.toLowerCase();

  const isAllowedModel = (m: ModelDefinition | string): boolean =>
    !isDeniedMiniModelId(toId(m), connection.piAuthProvider);

  // Provider-aware keyword search
  const keywords: string[] = [];

  if (isAnthropicProvider(connection.providerType)) {
    keywords.push('haiku');
  } else if (isPiProvider(connection.providerType)) {
    keywords.push('mini', 'flash');
  } else {
    // Aggregator providers (copilot, etc.) — try all common small-model keywords
    keywords.push('mini', 'haiku', 'flash');
  }

  if (keywords.length > 0) {
    const match = connection.models.find(m => {
      if (!isAllowedModel(m)) return false;
      const searchStr = toSearchStr(m);
      return keywords.some(k => searchStr.includes(k));
    });
    if (match) {
      return toId(match);
    }
  }

  // Fallback: last allowed model in the list, otherwise final entry.
  const fallback = [...connection.models].reverse().find(isAllowedModel);
  return fallback ? toId(fallback) : toId(connection.models[connection.models.length - 1]!);
}

/**
 * Generate a URL-safe slug from a display name.
 * @param name - Display name to convert
 * @returns URL-safe slug
 */
export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Check if a provider type is a "compat" provider.
 * Compat providers use custom endpoints and require explicit model lists.
 * @param providerType - Provider type to check
 * @returns true if this is a compat provider (pi_compat)
 */
export function isCompatProvider(providerType: LlmProviderType): boolean {
  return providerType === 'pi_compat';
}

/**
 * Check if a provider type represents a direct Anthropic connection.
 * @param providerType - Provider type to check
 * @returns true if this is direct Anthropic protocol/provider identity
 */
export function isAnthropicProvider(providerType: LlmProviderType): boolean {
  return providerType === 'anthropic';
}

/**
 * Check if a connection points to a local model runtime (loopback URL).
 */
export function isLocalConnection(conn: Pick<LlmConnection, 'baseUrl'>): boolean {
  if (!conn.baseUrl?.trim()) return false;
  try {
    const hostname = new URL(conn.baseUrl.trim()).hostname;
    const h = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch {
    return false;
  }
}

/**
 * Check if a provider type uses Pi unified API.
 * @param providerType - Provider type to check
 * @returns true if this provider uses Pi
 */
export function isPiProvider(providerType: LlmProviderType): boolean {
  return providerType === 'anthropic' || providerType === 'pi' || providerType === 'pi_compat';
}

/**
 * Default mid-stream send behavior for a given provider type.
 *
 * Every current connection executes through Pi, whose native `.steer()` is
 * non-destructive and delivers after the current tool finishes.
 */
export function defaultMidStreamBehavior(providerType: LlmProviderType): MidStreamBehavior {
  void providerType;
  return 'steer';
}

/**
 * Read the effective mid-stream behavior for a connection.
 *
 * Single source of truth — every call site that needs to decide steer-vs-queue
 * should go through here so legacy connections (created before the field
 * existed) and connections with corrupt/unexpected values fall through to the
 * provider-appropriate default.
 */
export function resolveMidStreamBehavior(
  connection: Pick<LlmConnection, 'midStreamBehavior' | 'providerType'>,
): MidStreamBehavior {
  if (connection.midStreamBehavior === 'steer' || connection.midStreamBehavior === 'queue') {
    return connection.midStreamBehavior;
  }
  return defaultMidStreamBehavior(connection.providerType);
}

/**
 * Return a new LlmConnection with the given model's `supportsImages` override set.
 *
 * Centralizes the string-vs-object normalization for `connection.models[]`:
 *   - string entry → promoted to `{ id, name, shortName, supportsImages: enabled }`
 *   - object entry → only `supportsImages` is updated
 *   - model not in array → connection returned unchanged (defensive)
 *
 * Pure function — does not mutate the input. Storage round-trip is handled
 * upstream via `saveLlmConnection`. The stored object form for custom-endpoint
 * models is `{ id, name?, shortName?, contextWindow?, supportsImages? }`
 * (passthrough-validated by the storage schema). `name` and `shortName` default
 * to the model's `id` when promoting so that downstream renderer surfaces that
 * read `m.name` (the trigger button display, picker row labels) keep showing a
 * label after the toggle promotes a string entry. The `ModelDefinition` cast
 * matches the existing shape produced by `ApiKeyInput.tsx` and the Pi driver.
 */
export function setModelSupportsImages(
  connection: LlmConnection,
  modelId: string,
  enabled: boolean,
): LlmConnection {
  if (!connection.models) return connection;
  const idOf = (m: ModelDefinition | string) => (typeof m === 'string' ? m : m.id);
  const idx = connection.models.findIndex(m => idOf(m) === modelId);
  if (idx === -1) return connection;

  const entry = connection.models[idx]!;
  const nextEntry =
    typeof entry === 'string'
      ? { id: entry, name: entry, shortName: entry, supportsImages: enabled }
      : { ...entry, supportsImages: enabled };

  const nextModels = connection.models.slice();
  nextModels[idx] = nextEntry as ModelDefinition;
  return { ...connection, models: nextModels };
}

/**
 * Resolve whether a given model on a connection accepts image input.
 *
 * For `pi_compat` (custom-endpoint) connections this mirrors the precedence used
 * by Pi's `buildCustomEndpointModelDef`:
 *   per-model `supportsImages` override
 *   ?? connection-level `customEndpoint.supportsImages` default
 *   ?? false
 *
 * For non-`pi_compat` connections the renderer doesn't own the catalog — Pi SDK's
 * bundled provider definitions and Anthropic's API do. This helper conservatively
 * returns `true` there (we don't know better; the upstream decides). The
 * pre-flight banner gates on `pi_compat` separately, so this just reports what
 * the renderer can know with confidence.
 */
export function modelSupportsImages(
  connection: Pick<LlmConnection, 'providerType' | 'models' | 'customEndpoint'>,
  modelId: string,
): boolean {
  if (!isCompatProvider(connection.providerType)) return true;

  const entry = connection.models?.find(m =>
    (typeof m === 'string' ? m : m.id) === modelId,
  );
  if (entry && typeof entry !== 'string' && typeof entry.supportsImages === 'boolean') {
    return entry.supportsImages;
  }
  return connection.customEndpoint?.supportsImages ?? false;
}

/**
 * Resolve whether a model exposes configurable thinking effort.
 *
 * Custom endpoints are opt-in because their string-only model lists do not
 * carry capability metadata. SDK-owned catalogs remain opt-out for backwards
 * compatibility with built-in model definitions created before this flag.
 */
export function modelSupportsThinking(
  connection: Pick<LlmConnection, 'providerType' | 'models'>,
  modelId: string,
): boolean {
  const entry = connection.models?.find(m =>
    (typeof m === 'string' ? m : m.id) === modelId,
  );
  if (!entry || typeof entry === 'string') return false;

  return isCompatProvider(connection.providerType)
    ? entry.supportsThinking === true
    : entry.supportsThinking !== false;
}

/** Check one persisted/UI thinking level against the concrete model capability map. */
export function modelSupportsThinkingLevel(
  connection: Pick<LlmConnection, 'providerType' | 'models'>,
  modelId: string,
  level: ThinkingLevel,
): boolean {
  if (!modelSupportsThinking(connection, modelId)) return false;

  const entry = connection.models?.find(model =>
    (typeof model === 'string' ? model : model.id) === modelId,
  );
  return !!entry
    && typeof entry !== 'string'
    && entry.thinkingLevelMap?.[level] !== null;
}

/** Mirror Pi's nearest-level clamp so persisted effort and the model menu stay aligned. */
export function resolveModelThinkingLevel(
  connection: Pick<LlmConnection, 'providerType' | 'models'>,
  modelId: string,
  level: ThinkingLevel,
): ThinkingLevel | undefined {
  if (modelSupportsThinkingLevel(connection, modelId, level)) return level;

  const selectedIndex = THINKING_LEVEL_IDS.indexOf(level);
  for (let distance = 1; distance < THINKING_LEVEL_IDS.length; distance++) {
    const lower = THINKING_LEVEL_IDS[selectedIndex - distance];
    if (lower && modelSupportsThinkingLevel(connection, modelId, lower)) return lower;

    const upper = THINKING_LEVEL_IDS[selectedIndex + distance];
    if (upper && modelSupportsThinkingLevel(connection, modelId, upper)) return upper;
  }
  return undefined;
}

/**
 * Get the default model list for a provider type from the registry.
 * For *_compat providers, returns empty array - those should use connection.models instead.
 *
 * @param providerType - Provider type
 * @param piAuthProvider - Optional Pi auth provider for filtering Pi models
 * @returns Model list from registry, or empty array for compat providers
 */
export function getModelsForProviderType(providerType: LlmProviderType, piAuthProvider?: string): ModelDefinition[] {
  // Compat providers require explicit model lists from the connection
  if (isCompatProvider(providerType)) {
    return [];
  }

  // Pi: fetch models via registered resolver (avoids Pi SDK import in renderer)
  if (providerType === 'pi') {
    return _piModelResolver(piAuthProvider);
  }

  // Direct Anthropic connections retain their product/provider identity, but
  // the executable catalog must come from the Pi runtime to avoid presenting
  // model IDs that the installed Pi SDK cannot resolve.
  return _piModelResolver('anthropic').map(model => ({
    ...model,
    id: model.id.startsWith('pi/') ? model.id.slice(3) : model.id,
    provider: 'anthropic' as const,
  }));
}

/**
 * Get the default model list for a connection's provider type.
 * Unlike getModelsForProviderType(), this handles compat providers by returning
 * the appropriate compat-prefixed model IDs instead of an empty array.
 *
 * Use this whenever you need to populate or backfill a connection's models.
 *
 * @param providerType - Provider type from the connection
 * @param piAuthProvider - Optional Pi auth provider for filtering Pi models
 * @returns Default model list (ModelDefinition[] for standard, string[] for compat)
 */
/**
 * Preferred default model IDs per Pi auth provider.
 * The Pi SDK returns models in arbitrary order (alphabetical by ID), which means
 * deprecated models like claude-3-5-haiku-20241022 can end up first.
 * This map ensures getDefaultModelForConnection() picks a modern, capable model.
 *
 * Format: bare model IDs (without pi/ prefix). Matched against pi/{id} or pi/{id}-*.
 */
export const PI_PREFERRED_DEFAULTS: Record<string, string[]> = {
  anthropic: ['claude-opus-4-8', 'claude-opus-4-7', 'claude-fable-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  openai: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'o4-mini', 'o3', 'gpt-4o'],
  'openai-codex': ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'o4-mini', 'o3', 'gpt-4o'],
  // Stable models first so the connection-setup test (which uses
  // getDefaultModelForConnection) lands on a reliable model.
  // gemini-3-pro-preview and gemini-3.1-pro-preview are intermittently
  // unresponsive on generateContent — verified against the live API in
  // April 2026 — and are deliberately excluded from defaults.
  google: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite-preview'],
  deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  'github-copilot': ['claude-sonnet-4-6', 'gpt-5', 'o4-mini', 'claude-haiku-4-5'],
  'amazon-bedrock': ['claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
};

export function getDefaultModelsForConnection(providerType: LlmProviderType, piAuthProvider?: string): Array<ModelDefinition | string> {
  if (providerType === 'pi') {
    const models = _piModelResolver(piAuthProvider);
    // Sort preferred defaults first so getDefaultModelForConnection picks a modern model.
    // For Bedrock models, the Pi SDK returns IDs like pi/us.anthropic.claude-opus-4-8
    // but preferred defaults use bare IDs (claude-opus-4-8). We match via both direct
    // comparison and reverse Bedrock ID mapping.
    const preferred = (piAuthProvider && PI_PREFERRED_DEFAULTS[piAuthProvider]) || [];
    if (preferred.length > 0) {
      const findPreferredIndex = (id: string): number => {
        const bare = id.startsWith('pi/') ? id.slice(3) : id
        // Try direct match first (works for non-Bedrock providers)
        const direct = preferred.findIndex(p => bare === p || bare.startsWith(`${p}-`))
        if (direct >= 0) return direct
        // For Bedrock: reverse-map native ID to bare, then match
        const isBedrockId = /^(?:us|eu|global)\.anthropic\.|^anthropic\.claude-/.test(bare)
        const reversed = isBedrockId ? fromBedrockNativeId(bare) : bare
        if (isBedrockId && reversed !== bare) {
          return preferred.findIndex(p => reversed === p || reversed.startsWith(`${p}-`))
        }
        return -1
      }
      const ranked = preferred.flatMap((_, preferredIndex) =>
        models.filter(model => findPreferredIndex(model.id) === preferredIndex)
      );
      const unranked = models.filter(model => findPreferredIndex(model.id) < 0);
      return [...ranked, ...unranked];
    }
    return models;
  }
  if (providerType === 'pi_compat') return [];  // Dynamic — user specifies
  // Reuse Pi's sorted Anthropic catalog, then preserve the direct-connection
  // model ID/provider shape expected by existing Storyflow configuration.
  return (getDefaultModelsForConnection('pi', 'anthropic') as ModelDefinition[]).map(model => ({
    ...model,
    id: model.id.startsWith('pi/') ? model.id.slice(3) : model.id,
    provider: 'anthropic' as const,
  }));
}

/**
 * Get the default model ID for a connection's provider type.
 * Derived from the first entry in getDefaultModelsForConnection() — single source of truth.
 *
 * @param providerType - Provider type from the connection
 * @param piAuthProvider - Optional Pi auth provider for filtering Pi models
 * @returns Default model ID string
 */
export function getDefaultModelForConnection(providerType: LlmProviderType, piAuthProvider?: string): string {
  const models = getDefaultModelsForConnection(providerType, piAuthProvider);
  const first = models[0];
  if (!first) return '';  // Dynamic provider — no default
  return typeof first === 'string' ? first : first.id;
}

/**
 * Resolve the effective LLM connection slug from available fallbacks.
 *
 * Single source of truth for the fallback chain used everywhere in the UI:
 *   1. Explicit session connection (locked after first message)
 *   2. Workspace-level default override
 *   3. Global default (isDefault flag on a connection)
 *   4. First available connection
 *
 * @param sessionConnection  - Per-session connection slug (session.llmConnection)
 * @param workspaceDefault   - Workspace-level default connection slug
 * @param connections        - All available connections (with status metadata)
 * @returns The resolved slug, or undefined when no connections exist
 */
export function resolveEffectiveConnectionSlug(
  sessionConnection: string | undefined,
  workspaceDefault: string | undefined,
  connections: Pick<LlmConnectionWithStatus, 'slug' | 'isDefault'>[],
): string | undefined {
  return sessionConnection
    ?? workspaceDefault
    ?? connections.find(c => c.isDefault)?.slug
    ?? connections[0]?.slug
}

/**
 * Check if a session's locked connection is unavailable (deleted/removed).
 * Returns true only when a session has an explicit llmConnection that doesn't
 * match any current connection. Sessions without a stored connection (using
 * the fallback chain) are never "unavailable".
 *
 * @param sessionConnection - Per-session connection slug (session.llmConnection)
 * @param connections - All available connections
 * @returns true if the session's connection no longer exists
 */
export function isSessionConnectionUnavailable(
  sessionConnection: string | undefined,
  connections: Pick<LlmConnectionWithStatus, 'slug'>[],
): boolean {
  if (!sessionConnection) return false
  return !connections.some(c => c.slug === sessionConnection)
}

/**
 * Check if a provider supports a given auth type.
 * Returns valid combinations for the type system.
 *
 * @param providerType - Provider type
 * @param authType - Auth type to check
 * @returns true if this is a valid combination
 */
export function isValidProviderAuthCombination(
  providerType: LlmProviderType,
  authType: LlmAuthType
): boolean {
  const validCombinations: Record<LlmProviderType, LlmAuthType[]> = {
    anthropic: ['api_key', 'oauth'],
    pi: ['api_key', 'oauth', 'iam_credentials', 'environment', 'none'],
    pi_compat: ['api_key_with_endpoint', 'none'],
  };

  return validCombinations[providerType]?.includes(authType) ?? false;
}

/**
 * Maps bare Anthropic model IDs → Bedrock cross-region inference profile IDs.
 * Uses US inference profiles (us.*) — required for on-demand throughput with
 * newer Claude models. Direct model IDs (anthropic.claude-*) are rejected
 * by Bedrock with "Retry your request with the ID or ARN of an inference profile".
 *
 * Source: Pi SDK registry (models.generated.js) — us.* variants
 */
const BEDROCK_MODEL_MAP: Record<string, string> = {
  'claude-opus-4-8': 'us.anthropic.claude-opus-4-8',
  'claude-opus-4-7': 'us.anthropic.claude-opus-4-7',
  'claude-fable-5': 'us.anthropic.claude-fable-5',
  'claude-sonnet-5': 'us.anthropic.claude-sonnet-5',
  'claude-sonnet-4-6': 'us.anthropic.claude-sonnet-4-6',
  'claude-haiku-4-5-20251001': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  // Older models (for migration of existing connections)
  'claude-opus-4-5-20251101': 'us.anthropic.claude-opus-4-5-20251101-v1:0',
  'claude-sonnet-4-5-20250929': 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  // Also map base IDs (without region prefix) to US inference profiles
  'anthropic.claude-opus-4-8': 'us.anthropic.claude-opus-4-8',
  'anthropic.claude-opus-4-7': 'us.anthropic.claude-opus-4-7',
  'anthropic.claude-fable-5': 'us.anthropic.claude-fable-5',
  'anthropic.claude-sonnet-5': 'us.anthropic.claude-sonnet-5',
  'anthropic.claude-sonnet-4-6': 'us.anthropic.claude-sonnet-4-6',
  'anthropic.claude-haiku-4-5-20251001-v1:0': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'anthropic.claude-opus-4-5-20251101-v1:0': 'us.anthropic.claude-opus-4-5-20251101-v1:0',
  'anthropic.claude-sonnet-4-5-20250929-v1:0': 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
}

/** Reverse map: all known Bedrock ID variants → bare Anthropic ID */
const BEDROCK_REVERSE_MAP: Record<string, string> = {
  // US inference profiles
  'us.anthropic.claude-opus-4-8': 'claude-opus-4-8',
  'us.anthropic.claude-fable-5': 'claude-fable-5',
  'us.anthropic.claude-opus-4-7': 'claude-opus-4-7',
  'us.anthropic.claude-opus-4-7-v1': 'claude-opus-4-7',
  'us.anthropic.claude-sonnet-5': 'claude-sonnet-5',
  'us.anthropic.claude-sonnet-4-6': 'claude-sonnet-4-6',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
  'us.anthropic.claude-opus-4-5-20251101-v1:0': 'claude-opus-4-5-20251101',
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0': 'claude-sonnet-4-5-20250929',
  // EU inference profiles
  'eu.anthropic.claude-opus-4-8': 'claude-opus-4-8',
  'eu.anthropic.claude-fable-5': 'claude-fable-5',
  'eu.anthropic.claude-opus-4-7': 'claude-opus-4-7',
  'eu.anthropic.claude-opus-4-7-v1': 'claude-opus-4-7',
  'eu.anthropic.claude-sonnet-5': 'claude-sonnet-5',
  'eu.anthropic.claude-sonnet-4-6': 'claude-sonnet-4-6',
  'eu.anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
  'eu.anthropic.claude-opus-4-5-20251101-v1:0': 'claude-opus-4-5-20251101',
  'eu.anthropic.claude-sonnet-4-5-20250929-v1:0': 'claude-sonnet-4-5-20250929',
  // Global inference profiles
  'global.anthropic.claude-opus-4-8': 'claude-opus-4-8',
  'global.anthropic.claude-fable-5': 'claude-fable-5',
  'global.anthropic.claude-opus-4-7': 'claude-opus-4-7',
  'global.anthropic.claude-opus-4-7-v1': 'claude-opus-4-7',
  'global.anthropic.claude-sonnet-5': 'claude-sonnet-5',
  'global.anthropic.claude-sonnet-4-6': 'claude-sonnet-4-6',
  'global.anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
  // Base IDs (no region prefix)
  'anthropic.claude-opus-4-8': 'claude-opus-4-8',
  'anthropic.claude-fable-5': 'claude-fable-5',
  'anthropic.claude-opus-4-7': 'claude-opus-4-7',
  'anthropic.claude-opus-4-7-v1': 'claude-opus-4-7',
  'anthropic.claude-sonnet-5': 'claude-sonnet-5',
  'anthropic.claude-sonnet-4-6': 'claude-sonnet-4-6',
  'anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
  'anthropic.claude-opus-4-5-20251101-v1:0': 'claude-opus-4-5-20251101',
  'anthropic.claude-sonnet-4-5-20250929-v1:0': 'claude-sonnet-4-5-20250929',
}

/**
 * Derive the Bedrock inference profile region prefix from an AWS region string.
 * Returns 'us', 'eu', or 'us' (default fallback for regions without inference profiles).
 */
export function deriveBedrockRegionPrefix(awsRegion?: string): string {
  if (!awsRegion) return 'us'
  if (awsRegion.startsWith('eu-')) return 'eu'
  // US regions and all others (ap-*, me-*, etc.) use US inference profiles
  return 'us'
}

/**
 * Map a bare Anthropic model ID to its Bedrock-native equivalent.
 * Uses the specified region prefix (default: 'us') for inference profile IDs.
 * Pass-through if already native or unknown.
 */
export function toBedrockNativeId(modelId: string, regionPrefix?: string): string {
  const normalizedModelId = normalizeDeprecatedModelId(modelId)
  const nativeId = BEDROCK_MODEL_MAP[normalizedModelId]
  if (!nativeId) return normalizedModelId
  if (!regionPrefix || regionPrefix === 'us') return nativeId
  // BEDROCK_MODEL_MAP stores us.* variants — swap the region prefix
  return nativeId.replace(/^us\./, `${regionPrefix}.`)
}

/** Map a Bedrock-native model ID back to its bare Anthropic equivalent. Pass-through if already bare or unknown. */
export function fromBedrockNativeId(modelId: string): string {
  const normalizedModelId = normalizeDeprecatedModelId(modelId)
  return BEDROCK_REVERSE_MAP[normalizedModelId] ?? normalizedModelId
}

/**
 * Normalize a model ID for Bedrock storage/usage.
 * Strips pi/ prefix and maps bare Anthropic IDs to Bedrock-native format.
 * Idempotent — already-native IDs pass through unchanged.
 */
export function normalizeBedrockModelId(
  modelId: string | undefined,
  regionPrefix?: string,
): string {
  if (!modelId) return '';
  const bare = modelId.startsWith('pi/') ? modelId.slice(3) : modelId
  return toBedrockNativeId(bare, regionPrefix)
}

// ============================================================
// Migration Helpers
// ============================================================

/**
 * Migrate legacy connection type to new provider type.
 * Used during config migration.
 *
 * @param legacyType - Legacy LlmConnectionType value
 * @returns New LlmProviderType value
 */
export function migrateConnectionType(legacyType: LlmConnectionType): LlmProviderType {
  switch (legacyType) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
      return 'pi';
    case 'openai-compat':
      return 'pi_compat';
  }
}

/**
 * Migrate legacy auth type to new auth type.
 * Determines new auth type based on legacy type + connection context.
 *
 * @param legacyAuthType - Legacy auth type ('api_key' | 'oauth' | 'none')
 * @param hasCustomEndpoint - Whether connection has a custom baseUrl
 * @returns New LlmAuthType value
 */
export function migrateAuthType(
  legacyAuthType: 'api_key' | 'oauth' | 'none',
  hasCustomEndpoint: boolean
): LlmAuthType {
  switch (legacyAuthType) {
    case 'api_key':
      // If has custom endpoint, use api_key_with_endpoint
      return hasCustomEndpoint ? 'api_key_with_endpoint' : 'api_key';
    case 'oauth':
      return 'oauth';
    case 'none':
      return 'none';
  }
}

// ============================================================
// Auth Environment Variable Resolution
// ============================================================

const CLAUDE_BEDROCK_ROUTING_ENV_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_BEDROCK_BASE_URL',
] as const

const CLAUDE_BEDROCK_ROUTING_ENV_KEY_SET = new Set<string>(
  CLAUDE_BEDROCK_ROUTING_ENV_KEYS,
)

const MANAGED_ANTHROPIC_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  ...CLAUDE_BEDROCK_ROUTING_ENV_KEYS,
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
] as const

function getRuntimeEnvValue(key: string): string | undefined {
  if (typeof process === 'undefined' || !process?.env) {
    return undefined
  }
  return process.env[key]
}

const MANAGED_ANTHROPIC_AUTH_ENV_BASELINE: Record<string, string | undefined> =
  Object.fromEntries(
    MANAGED_ANTHROPIC_AUTH_ENV_KEYS.map((key) => [
      key,
      CLAUDE_BEDROCK_ROUTING_ENV_KEY_SET.has(key)
        ? undefined
        : getRuntimeEnvValue(key),
    ]),
  )

export function clearClaudeBedrockRoutingEnvVars(
  targetEnv: Record<string, string | undefined> = process.env,
): void {
  for (const key of CLAUDE_BEDROCK_ROUTING_ENV_KEYS) {
    delete targetEnv[key]
  }
}

export function resetManagedAnthropicAuthEnvVars(): void {
  if (typeof process === 'undefined' || !process?.env) {
    return
  }

  for (const key of MANAGED_ANTHROPIC_AUTH_ENV_KEYS) {
    const originalValue = MANAGED_ANTHROPIC_AUTH_ENV_BASELINE[key]
    if (originalValue === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = originalValue
    }
  }
}

/**
 * Result of resolving auth env vars for an LLM connection.
 */
export interface ResolvedAuthEnvVars {
  /** Environment variables to set (e.g., ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN) */
  envVars: Record<string, string>;
  /** Whether credentials were successfully resolved */
  success: boolean;
  /** Warning message if auth resolution encountered issues */
  warning?: string;
}

/**
 * Resolve authentication environment variables for an LLM connection.
 *
 * This only supplies process-level compatibility variables. Pi ModelRuntime
 * owns every credential consumed by the agent runtime.
 *
 * @param connection - The LLM connection config
 * @param connectionSlug - Connection slug for credential lookup
 * @param credentialManager - Credential manager instance
 * @returns Resolved env vars and status
 */
export async function resolveAuthEnvVars(
  connection: LlmConnection,
  connectionSlug: string,
  credentialManager: CredentialManager,
): Promise<ResolvedAuthEnvVars> {
  const envVars: Record<string, string> = {};

  // Only Anthropic-compatible API-key endpoints use process env compatibility.
  if (!isAnthropicProvider(connection.providerType)) {
    return { envVars, success: true };
  }

  // Set base URL if configured
  if (connection.baseUrl) {
    envVars.ANTHROPIC_BASE_URL = connection.baseUrl;
  }

  const authType = connection.authType;

  if (authType === 'api_key' || authType === 'api_key_with_endpoint' || authType === 'bearer_token') {
    const apiKey = await credentialManager.getLlmApiKey(connectionSlug);
    if (apiKey) {
      envVars.ANTHROPIC_API_KEY = apiKey;
    } else if (connection.baseUrl) {
      // Keyless provider (e.g. Ollama)
      envVars.ANTHROPIC_API_KEY = 'not-needed';
    } else {
      return { envVars, success: false, warning: `No API key found for: ${connectionSlug}` };
    }
  } else if (authType === 'oauth') {
    // ADR 0018: Pi ModelRuntime owns OAuth token resolution and refresh; CredentialStore owns locking.
    // Projecting OAuth into process.env would create a second stale credential source.
    return { envVars, success: true };
  } else if (authType === 'environment') {
    // Environment auth — credentials come from process.env, nothing to inject
    return { envVars, success: true };
  }

  return { envVars, success: true };
}
