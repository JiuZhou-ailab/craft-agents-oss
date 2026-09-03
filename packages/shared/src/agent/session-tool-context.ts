/**
 * input: Workspace/session paths, callbacks, validators, Sources, and credential adapters
 * output: SessionToolContext backed by shared runtime services
 * pos: Adapter boundary between session-tools-core contracts and shared implementations
 *
 * Gives Pi session tools access to Storyflow-owned files, credentials,
 * validators, and callbacks without moving those capabilities into Pi.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from '../config/paths.ts';
import { getWorkspaceSourcesPath } from '../workspaces/paths.ts';
import type {
  SessionToolContext,
  SessionToolCallbacks,
  UserQuestionRequest,
  UserQuestionResponse,
  FileSystemInterface,
  CredentialManagerInterface,
  ValidatorInterface,
  LoadedSource,
  StdioMcpConfig,
  StdioValidationResult,
  HttpMcpConfig,
  McpValidationResult,
  SourceConfig,
  DeveloperFeedback,
} from '@craft-agent/session-tools-core';
import {
  validateConfig,
  validateSource,
  validateAllSources,
  validateStatuses,
  validatePreferences,
  validateAll,
  validateSourcePermissions,
  validateAllPermissions,
  validateToolIcons,
} from '../config/validators.ts';
import { validateAutomations } from '../automations/index.ts';
import {
  validateMcpConnection as validateMcpConnectionImpl,
  validateStdioMcpConnection as validateStdioMcpConnectionImpl,
} from '../mcp/validation.ts';
import {
  loadSource as loadSourceImpl,
  saveSourceConfig as saveSourceConfigImpl,
  updateSourceConnectionState,
  getSourceDefinitionIdentity,
  isSourceUsable,
} from '../sources/storage.ts';
import type {
  FolderSourceConfig,
  LoadedSource as SharedLoadedSource,
  SourceConnectionStatus,
} from '../sources/types.ts';
import { getSourceCredentialManager } from '../sources/credential-manager.ts';
import { createStoryflowManagedTokenGetter } from '../sources/managed-access.ts';
import { getTrustedManagedSourcePolicy } from '../sources/managed-source-policy.ts';
import { isProjectStdioExecutionAllowed } from '../sources/server-builder.ts';
import { getSourceGrantRef, isSourceHostGranted } from '../sources/grants.ts';
import {
  inferGoogleServiceFromUrl,
  inferSlackServiceFromUrl,
  inferMicrosoftServiceFromUrl,
  type GoogleService,
  type SlackService,
  type MicrosoftService,
} from '../sources/types.ts';
import { isGoogleOAuthConfigured as isGoogleOAuthConfiguredImpl } from '../auth/google-oauth.ts';
import { debug } from '../utils/debug.ts';
import { getSessionPlansPath, getSessionPath, getSessionDataPath } from '../sessions/storage.ts';
import { updatePreferences as updatePreferencesImpl } from '../config/preferences.ts';
import {
  createSkill as createSkillImpl,
  getPiUserSkillsDir,
  loadSkill as loadSkillImpl,
} from '../skills/storage.ts';

// Re-export types that may be needed by consumers
export type { SessionToolContext, SessionToolCallbacks } from '@craft-agent/session-tools-core';

/**
 * Options for creating the Storyflow session-tool context.
 */
export interface SessionToolContextOptions {
  sessionId: string;
  workspacePath: string;
  workspaceId: string;
  onPlanSubmitted: (planPath: string) => void | Promise<void>;
  onAuthRequest: (request: unknown) => void;
  onAskUserQuestion?: (request: UserQuestionRequest) => Promise<UserQuestionResponse>;
  /** null only for the Host-owned Free Conversations application context. */
  getHostGrantedSourceRefs: () => readonly string[] | null;
  /** Read at execution time so a Host revocation applies to an existing Pi context. */
  getHostAllowsProjectStdio: () => boolean;
}

/**
 * Create the host capability context used by Pi session tools.
 *
 * This provides:
 * - Full file system access
 * - Full Zod validators
 * - Credential manager with keychain access
 * - MCP connection validation
 * - Icon management
 */
export function createSessionToolContext(options: SessionToolContextOptions): SessionToolContext {
  const { sessionId, workspacePath, workspaceId, onPlanSubmitted, onAuthRequest, onAskUserQuestion } = options;

  const loadVisibleSource = (sourceSlug: string) =>
    loadSourceImpl(workspacePath, sourceSlug, workspaceId);

  const isLoadedSourceHostGranted = (source: SharedLoadedSource): boolean => {
    const refs = options.getHostGrantedSourceRefs();
    return refs === null || isSourceHostGranted(refs, source);
  };

  const isSourceExecutionAllowed = (sourceSlug: string): boolean => {
    const source = loadVisibleSource(sourceSlug);
    return !!source && isLoadedSourceHostGranted(source);
  };

  // File system implementation
  const fs: FileSystemInterface = {
    exists: (path: string) => existsSync(path),
    readFile: (path: string) => readFileSync(path, 'utf-8'),
    readFileBuffer: (path: string) => readFileSync(path),
    writeFile: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
    isDirectory: (path: string) => existsSync(path) && statSync(path).isDirectory(),
    readdir: (path: string) => readdirSync(path),
    stat: (path: string) => {
      const stats = statSync(path);
      return {
        size: stats.size,
        isDirectory: () => stats.isDirectory(),
      };
    },
  };

  // Callbacks implementation
  const callbacks: SessionToolCallbacks = {
    onPlanSubmitted,
    onAuthRequest: (request) => onAuthRequest(request),
    onAskUserQuestion,
  };

  // Validators implementation
  const validators: ValidatorInterface = {
    validateConfig: () => validateConfig(),
    validateSource: (wsPath: string, slug: string) => validateSource(wsPath, slug),
    validateAllSources: (wsPath: string) => validateAllSources(wsPath),
    validateStatuses: (wsPath: string) => validateStatuses(wsPath),
    validatePreferences: () => validatePreferences(),
    validatePermissions: (wsPath: string, sourceSlug?: string) => {
      if (sourceSlug) {
        return validateSourcePermissions(wsPath, sourceSlug);
      }
      return validateAllPermissions(wsPath);
    },
    validateAutomations: (wsPath: string) => validateAutomations(wsPath),
    validateToolIcons: () => validateToolIcons(),
    validateAll: (wsPath: string) => validateAll(wsPath),
  };

  // Credential manager adapter
  const toSharedLoadedSource = (source: LoadedSource): SharedLoadedSource => {
    const resolved = loadVisibleSource(source.config.slug);
    if (!resolved) throw new Error(`Source not found: ${source.config.slug}`);
    return {
      ...resolved,
      config: source.config as unknown as FolderSourceConfig,
      guide: null,
      definitionIdentity: getSourceDefinitionIdentity(source.config as unknown as FolderSourceConfig),
    };
  };

  const normalizeConnectionStatus = (
    status: SourceConfig['connectionStatus'],
  ): SourceConnectionStatus | undefined => {
    switch (status) {
      case 'connected': return 'connected';
      case 'error':
      case 'disconnected': return 'failed';
      case 'unknown': return 'untested';
      default: return undefined;
    }
  };

  const credentialManager: CredentialManagerInterface = {
    hasValidCredentials: async (source: LoadedSource): Promise<boolean> => {
      const mgr = getSourceCredentialManager();
      const token = await mgr.getToken(toSharedLoadedSource(source));
      return !!token;
    },
    getToken: async (source: LoadedSource): Promise<string | null> => {
      const mgr = getSourceCredentialManager();
      return mgr.getToken(toSharedLoadedSource(source));
    },
    refresh: async (source: LoadedSource): Promise<string | null> => {
      const mgr = getSourceCredentialManager();
      return mgr.refresh(toSharedLoadedSource(source));
    },
  };

  // MCP validation
  const validateStdioMcpConnection = async (config: StdioMcpConfig): Promise<StdioValidationResult> => {
    try {
      const result = await validateStdioMcpConnectionImpl(config);
      return {
        success: result.success,
        error: result.error,
        toolCount: result.tools?.length,
        toolNames: result.tools,
        serverName: result.serverInfo?.name,
        serverVersion: result.serverInfo?.version,
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Validation failed' };
    }
  };

  const validateMcpConnection = async (config: HttpMcpConfig): Promise<McpValidationResult> => {
    try {
      const result = await validateMcpConnectionImpl({
        mcpUrl: config.url,
        mcpTransport: config.transport,
        mcpHeaders: config.headers,
      });
      return {
        success: result.success,
        error: result.error,
        needsAuth: result.errorType === 'needs-auth',
        toolCount: result.tools?.length,
        toolNames: result.tools,
        serverName: result.serverInfo?.name,
        serverVersion: result.serverInfo?.version,
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Validation failed' };
    }
  };

  // Build context
  const context: SessionToolContext = {
    sessionId,
    workspacePath,
    workspaceId,
    get sourcesPath() { return getWorkspaceSourcesPath(workspacePath); },
    get skillsPath() { return getPiUserSkillsDir(); },
    plansFolderPath: getSessionPlansPath(workspacePath, sessionId),
    sessionPath: getSessionPath(workspacePath, sessionId),
    dataPath: getSessionDataPath(workspacePath, sessionId),
    callbacks,
    fs,
    validators,
    credentialManager,
    updatePreferences: (updates: Record<string, unknown>) => {
      updatePreferencesImpl(updates as any);
    },
    submitFeedback: (feedback: DeveloperFeedback) => {
      const feedbackDir = join(CONFIG_DIR, 'feedback');
      mkdirSync(feedbackDir, { recursive: true });
      const filePath = join(feedbackDir, `${feedback.id}.json`);
      writeFileSync(filePath, JSON.stringify(feedback, null, 2), 'utf-8');
      debug('session-tool-context', `Developer feedback written to ${filePath}`);
    },
    // Source management
    loadSourceConfig: (sourceSlug: string): SourceConfig | null => {
      const source = loadVisibleSource(sourceSlug);
      return source?.config as unknown as SourceConfig | null;
    },
    createSkillDocument: (skillSlug: string, content: string) => {
      const skill = createSkillImpl(skillSlug, content);
      return { path: skill.filePath, content };
    },
    loadSkillDocument: (skillSlug: string) => {
      const skill = loadSkillImpl(skillSlug);
      if (!skill) return null;
      return { path: skill.filePath, content: readFileSync(skill.filePath, 'utf-8') };
    },
    isSourceDefinitionReadOnly: (sourceSlug: string): boolean => {
      return loadVisibleSource(sourceSlug)?.origin === 'shared-global';
    },
    isSourceExecutionAllowed,
    saveSourceConfig: (source: SourceConfig) => {
      const loaded = loadVisibleSource(source.slug);
      if (!loaded) return;
      if (
        getSourceDefinitionIdentity(source as unknown as FolderSourceConfig)
        !== loaded.definitionIdentity
      ) {
        throw new Error(`Source definition changed while testing: ${source.slug}`);
      }

      const connectionStatus = normalizeConnectionStatus(source.connectionStatus);
      if (loaded.origin === 'shared-global') {
        updateSourceConnectionState(workspacePath, source.slug, {
          connectionStatus,
          connectionError: source.connectionError,
          lastTestedAt: source.lastTestedAt,
        });
        return;
      }

      saveSourceConfigImpl(loaded.workspaceRootPath, {
        ...source,
        connectionStatus,
      } as unknown as FolderSourceConfig);
    },

    // Service inference
    inferGoogleService: (url?: string): GoogleService | undefined => {
      return inferGoogleServiceFromUrl(url);
    },
    inferSlackService: (url?: string): SlackService | undefined => {
      return inferSlackServiceFromUrl(url);
    },
    inferMicrosoftService: (url?: string): MicrosoftService | undefined => {
      return inferMicrosoftServiceFromUrl(url);
    },

    // OAuth config check
    isGoogleOAuthConfigured: (clientId?: string, clientSecret?: string): boolean => {
      return isGoogleOAuthConfiguredImpl(clientId, clientSecret);
    },

    // MCP validation
    isStdioMcpExecutionAllowed: (sourceSlug: string, capabilityRef?: string): boolean => {
      const source = loadVisibleSource(sourceSlug);
      return !!source
        && (capabilityRef === undefined || getSourceGrantRef(source) === capabilityRef)
        && isLoadedSourceHostGranted(source)
        && isSourceUsable(source)
        && isProjectStdioExecutionAllowed(source, options.getHostAllowsProjectStdio());
    },
    validateStdioMcpConnection,
    validateMcpConnection,
    getManagedApiAccessToken: async (source: SourceConfig): Promise<string> => {
      if (source.type !== 'api' || source.api?.authType !== 'managed' || !source.api.baseUrl) {
        throw new Error('Source does not use Storyflow managed API access');
      }
      const loaded = loadVisibleSource(source.slug);
      if (!loaded) throw new Error(`Source not found: ${source.slug}`);
      const policy = getTrustedManagedSourcePolicy(loaded);
      return createStoryflowManagedTokenGetter({
        expectedGatewayBaseUrl: policy.gatewayBaseUrl,
      })();
    },

    // Icon URL validation for source_test reporting.
    isIconUrl: (value: string): boolean => {
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    },

    // Session self-management bindings are attached externally via
    // attachSessionSelfManagementBindings() — not part of the factory.
  };

  return context;
}
