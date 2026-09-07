/**
 * input: API Source configuration, declarative operations, and runtime credentials
 * output: In-process MCP tools and Host permission definitions for their HTTP requests
 * pos: Generic API-to-tool adapter for Storyflow Sources
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiConfig, ApiOperationParameter, ApiToolPermissionDefinition, ApiSourceOperation } from './types.ts';
import { debug } from '../utils/debug.ts';
import { guardLargeResult } from '../utils/large-response.ts';
import { MAX_DOWNLOAD_SIZE, formatBytes } from '../utils/binary-detection.ts';
import type { ApiCredential, BasicAuthCredential } from './credential-manager.ts';
import { isMultiHeaderCredential } from './credential-manager.ts';
import { buildAuthorizationHeader } from './api-auth.ts';
import { canonicalizeApiPath, materializeApiOperationRequest } from './api-path.ts';
export { buildAuthorizationHeader } from './api-auth.ts';

// Re-export for convenience
export type { ApiCredential, BasicAuthCredential } from './credential-manager.ts';

/**
 * Build an Authorization header value for bearer-style authentication.
 *
 * Supports three cases:
 * - `authScheme: undefined` → defaults to "Bearer {token}"
 * - `authScheme: "Token"` → "Token {token}" (custom prefix)
 * - `authScheme: ""` → "{token}" (no prefix, for APIs that expect raw tokens)
 *
 * The empty string case is needed for APIs like some GraphQL endpoints or
 * internal services that expect the raw JWT/token without a "Bearer" prefix.
 *
 * @param authScheme - The auth scheme prefix (undefined defaults to "Bearer", empty string means no prefix)
 * @param token - The authentication token
 * @returns The full Authorization header value
 */
/**
 * API credential source - can be a static credential or a function that returns a token.
 * Token getter functions are used for OAuth sources that need auto-refresh.
 */
export type ApiCredentialSource = ApiCredential | (() => Promise<string>);

/**
 * Type guard to check if credential is BasicAuthCredential
 */
function isBasicAuthCredential(cred: ApiCredential): cred is BasicAuthCredential {
  return typeof cred === 'object' && cred !== null && 'username' in cred && 'password' in cred;
}

/**
 * Type guard to check if credential source is a token getter function
 */
function isTokenGetter(cred: ApiCredentialSource): cred is () => Promise<string> {
  return typeof cred === 'function';
}

/** Summarize callback type — typically agent.runMiniCompletion.bind(agent) */
export type SummarizeCallback = (prompt: string) => Promise<string | null>;


/**
 * Build headers for an API request, injecting authentication and default headers
 */
export function buildHeaders(
  auth: ApiConfig['auth'],
  credential: ApiCredential,
  defaultHeaders?: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Merge default headers (e.g., beta feature flags)
    ...defaultHeaders,
  };

  // No auth needed for type='none' or missing auth
  if (!auth || auth.type === 'none') {
    return headers;
  }

  // Basic auth requires username:password credential
  if (auth.type === 'basic') {
    if (isBasicAuthCredential(credential)) {
      const encoded = Buffer.from(`${credential.username}:${credential.password}`).toString('base64');
      headers['Authorization'] = `Basic ${encoded}`;
    }
    return headers;
  }

  // Handle header auth (supports both single and multi-header)
  if (auth.type === 'header') {
    // Multi-header: credential is { headerName: value, ... }
    if (isMultiHeaderCredential(credential)) {
      Object.assign(headers, credential);
    }
    // Single header: existing behavior
    else if (typeof credential === 'string' && credential) {
      headers[auth.headerName || 'x-api-key'] = credential;
    }
    return headers;
  }

  // Other types use string credential (API key/token)
  const apiKey = typeof credential === 'string' ? credential : '';
  if (!apiKey) {
    return headers;
  }

  if (auth.type === 'bearer') {
    headers['Authorization'] = buildAuthorizationHeader(auth.authScheme, apiKey);
  }
  // Query type is handled in buildUrl

  return headers;
}

/**
 * Build the full URL for an API request
 */
function buildUrl(
  baseUrl: string,
  path: string,
  method: string,
  params: Record<string, unknown> | undefined,
  auth: ApiConfig['auth'],
  credential: ApiCredential
): string {
  // Normalize: remove trailing slash from baseUrl and ensure path starts with /
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedPath = canonicalizeApiPath(path);
  let url = `${normalizedBase}${normalizedPath}`;

  // Handle query param auth (only for string credentials)
  const apiKey = typeof credential === 'string' ? credential : '';
  if (auth?.type === 'query' && auth.queryParam && apiKey) {
    const separator = url.includes('?') ? '&' : '?';
    url += `${separator}${auth.queryParam}=${encodeURIComponent(apiKey)}`;
  }

  // Handle GET params in query string
  if (method === 'GET' && params && Object.keys(params).length > 0) {
    const urlParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        // Handle arrays and objects
        if (typeof value === 'object') {
          urlParams.append(key, JSON.stringify(value));
        } else {
          urlParams.append(key, String(value));
        }
      }
    }
    const queryString = urlParams.toString();
    if (queryString) {
      const separator = url.includes('?') ? '&' : '?';
      url += `${separator}${queryString}`;
    }
  }

  return url;
}

/**
 * Build tool description from API config.
 *
 * The description is sent to the LLM with every request, so we keep it small
 * and point to `sources/{slug}/guide.md` for endpoint-specific detail. The
 * agent's PrerequisiteManager already blocks calls to this tool until the
 * guide has been Read in the current context window, so the guide always
 * lands in conversation history before the model can call anything — making
 * a duplicate copy here pure waste (and the cause of #683-style provider
 * rejections when guide.md is large).
 *
 * Exported only for unit testing; treat as internal.
 */
export function buildToolDescription(config: ApiConfig): string {
  // config.name is the source slug (set by SourceServerBuilder.buildApiConfig).
  let desc = `Make authenticated requests to the ${config.name} API (${config.baseUrl}).\n\n`;
  desc += `Authentication is handled automatically — pass path, method, and params.\n`;
  desc += `For non-JSON request bodies, use params: { _rawBody: "raw content", _contentType: "text/plain" }. The _rawBody value is sent as-is without JSON encoding.\n\n`;
  desc += `**Before the first call, Read the source guide at sources/${config.name}/guide.md** — `;
  desc += `it documents available endpoints, required params, and any quirks. The Read is required before the first call (enforced) and again after compaction.\n\n`;
  desc += `**Binary responses** (PDFs, images, archives) are auto-saved to the session downloads folder; reference the returned path when telling the user about downloaded files.`;

  if (config.docsUrl) {
    desc += `\n\nOfficial docs: ${config.docsUrl}`;
  }

  return desc;
}

/**
 * Create a single flexible MCP tool for an API configuration.
 * The tool accepts { path, method, params } and handles auth automatically.
 *
 * @param config - API configuration with documentation
 * @param credential - API credential source (string for API key/token, BasicAuthCredential for basic auth,
 *                     empty string for public APIs, or async function for OAuth token refresh)
 * @param sessionPath - Optional path to session folder for saving large responses
 * @returns SDK tool that can be included in an MCP server
 */
export function createApiTool(
  config: ApiConfig,
  credential: ApiCredentialSource,
  sessionPath?: string,
  summarize?: SummarizeCallback
) {
  const toolName = `api_${config.name}`;
  debug(`[api-tools] Creating flexible tool: ${toolName}`);

  const description = buildToolDescription(config);

  const inputSchema = {
      path: z.string().describe('API endpoint path, e.g., "/search" or "/v1/completions"'),
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).describe('HTTP method - check documentation for correct method per endpoint'),
      params: z.record(z.string(), z.unknown()).optional().describe('Request body (POST/PUT/PATCH) or query parameters (GET). For non-JSON bodies, pass { _rawBody: "raw string content", _contentType: "text/plain" } — _rawBody is sent as-is without JSON encoding, _contentType defaults to text/plain if omitted'),
  };

  return {
    name: toolName,
    description,
    inputSchema,
    handler: async (args: z.infer<z.ZodObject<typeof inputSchema>>) => {
      const { path, method, params } = args;

      try {
        // Resolve credential - if it's a token getter function, call it to get fresh token
        const resolvedCredential: ApiCredential = isTokenGetter(credential)
          ? await credential()
          : credential;

        const url = buildUrl(config.baseUrl, path, method, params, config.auth, resolvedCredential);
        const headers = buildHeaders(config.auth, resolvedCredential, config.defaultHeaders);

        const debugUrl = new URL(url);
        debug(`[api-tools] ${config.name}: ${method} ${debugUrl.origin}${debugUrl.pathname}`);

        const fetchOptions: RequestInit = {
          method,
          headers,
        };

        // Add body for non-GET requests
        if (method !== 'GET' && params && Object.keys(params).length > 0) {
          // Support raw text bodies via _rawBody param (e.g., for endpoints expecting plain text)
          if (typeof params._rawBody === 'string') {
            fetchOptions.body = params._rawBody;
            (fetchOptions.headers as Record<string, string>)['Content-Type'] =
              typeof params._contentType === 'string' ? params._contentType : 'text/plain';
            debug(`[api-tools] ${config.name}: raw body (${(fetchOptions.headers as Record<string, string>)['Content-Type']}): ${params._rawBody.substring(0, 200)}`);
          } else {
            fetchOptions.body = JSON.stringify(params);
          }
        }

        const headerNames = Object.keys(fetchOptions.headers as Record<string, string>).sort();
        debug(`[api-tools] ${config.name}: headerNames=${headerNames.join(',')}, bodyLength=${fetchOptions.body ? String(fetchOptions.body).length : 0}`);

        const response = await fetch(url, fetchOptions);

        // OOM safety: reject before loading into memory
        const contentLength = response.headers.get('content-length');
        if (contentLength) {
          const size = parseInt(contentLength, 10);
          if (!isNaN(size) && size > MAX_DOWNLOAD_SIZE) {
            return {
              content: [{
                type: 'text' as const,
                text: `Response too large: ${formatBytes(size)} exceeds ${formatBytes(MAX_DOWNLOAD_SIZE)} limit. Use a streaming download tool for large files.`,
              }],
              isError: true,
            };
          }
        }

        // Load response as raw buffer — guardLargeResult handles binary detection
        const buffer = Buffer.from(await response.arrayBuffer());

        // Check for error responses first (errors are always text)
        if (!response.ok) {
          const text = buffer.toString('utf-8');
          debug(`[api-tools] ${config.name} error ${response.status}: ${text.substring(0, 200)}`);
          return {
            content: [{
              type: 'text' as const,
              text: `API Error ${response.status}: ${text}`,
            }],
            isError: true,
          };
        }

        // Centralized binary detection + large response handling
        if (sessionPath) {
          const guarded = await guardLargeResult(buffer, {
            sessionPath,
            toolName: `api_${config.name}`,
            input: { path, method, params },
            summarize,
          });
          if (guarded) {
            return { content: [{ type: 'text' as const, text: guarded }] };
          }
        }

        return { content: [{ type: 'text' as const, text: buffer.toString('utf-8') }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        debug(`[api-tools] ${config.name} request failed: ${message}`);
        return {
          content: [{ type: 'text' as const, text: `Request failed: ${message}` }],
          isError: true,
        };
      }
    },
  };
}

function operationParameterSchema(parameter: ApiOperationParameter): z.ZodTypeAny {
  let schema: z.ZodTypeAny;
  switch (parameter.type) {
    case 'integer':
      schema = z.number().int();
      break;
    case 'number':
      schema = z.number();
      break;
    case 'boolean':
      schema = z.boolean();
      break;
    case 'string':
    default:
      schema = z.string();
  }

  if (parameter.enum?.length) {
    const allowed = new Set(parameter.enum);
    schema = schema.refine(value => allowed.has(String(value)), {
      message: `Expected one of: ${parameter.enum.join(', ')}`,
    });
  }
  if (parameter.minimum !== undefined && (parameter.type === 'integer' || parameter.type === 'number')) {
    schema = schema.refine(value => typeof value === 'number' && value >= parameter.minimum!, {
      message: `Expected a value greater than or equal to ${parameter.minimum}`,
    });
  }
  if (parameter.maximum !== undefined && (parameter.type === 'integer' || parameter.type === 'number')) {
    schema = schema.refine(value => typeof value === 'number' && value <= parameter.maximum!, {
      message: `Expected a value less than or equal to ${parameter.maximum}`,
    });
  }
  if (parameter.description) schema = schema.describe(parameter.description);
  if (parameter.default !== undefined) {
    schema = schema.default(parameter.default);
  } else if (!parameter.required) {
    schema = schema.optional();
  }
  return schema;
}

function operationInputSchema(operation: ApiSourceOperation): Record<string, z.ZodTypeAny> {
  return Object.fromEntries(
    (operation.parameters ?? []).map(parameter => [parameter.name, operationParameterSchema(parameter)]),
  );
}

function operationRequest(
  operation: ApiSourceOperation,
  args: Record<string, unknown>,
): { path: string; method: ApiSourceOperation['method']; params?: Record<string, unknown> } {
  const { path, params } = materializeApiOperationRequest(
    operation.path,
    operation.parameters,
    args,
  );
  return {
    path,
    method: operation.method,
    ...(Object.keys(params).length > 0 ? { params } : {}),
  };
}

/** Build one stable domain tool backed by the generic authenticated API executor. */
export function createApiOperationTool(
  config: ApiConfig,
  operation: ApiSourceOperation,
  credential: ApiCredentialSource,
  sessionPath?: string,
  summarize?: SummarizeCallback,
) {
  const executor = createApiTool(config, credential, sessionPath, summarize);
  const inputSchema = operationInputSchema(operation);
  return {
    name: operation.name,
    description: operation.description,
    inputSchema,
    handler: async (args: Record<string, unknown>) => {
      try {
        return await executor.handler(operationRequest(operation, args));
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: error instanceof Error ? error.message : 'Invalid API operation input',
          }],
          isError: true,
        };
      }
    },
  };
}

/**
 * Create an in-process MCP server with a single flexible API tool.
 *
 * @param config - API configuration
 * @param credential - API credential source (string for API key/token, BasicAuthCredential for basic auth,
 *                     empty string for public APIs, or async function for OAuth token refresh)
 * @param sessionPath - Optional path to session folder for saving large responses
 * @returns In-process MCP server config consumed by the shared MCP pool
 */
export function createApiServer(
  config: ApiConfig,
  credential: ApiCredentialSource,
  sessionPath?: string,
  summarize?: SummarizeCallback
): {
  type: 'sdk';
  name: string;
  instance: McpServer;
  toolPermissions: Record<string, ApiToolPermissionDefinition>;
} {
  debug(`[api-tools] Creating server for ${config.name}${sessionPath ? ` (session: ${sessionPath})` : ''}`);

  const name = `api_${config.name}`;
  const instance = new McpServer({ name, version: '1.0.0' });
  const toolPermissions: Record<string, ApiToolPermissionDefinition> = {};
  if (config.operations?.length) {
    for (const operation of config.operations) {
      const tool = createApiOperationTool(config, operation, credential, sessionPath, summarize);
      toolPermissions[tool.name] = {
        method: operation.method,
        path: operation.path,
        ...(operation.parameters ? { parameters: operation.parameters } : {}),
      };
      instance.registerTool(tool.name, {
        description: tool.description,
        inputSchema: tool.inputSchema,
      }, tool.handler);
    }
  } else {
    const apiTool = createApiTool(config, credential, sessionPath, summarize);
    toolPermissions[apiTool.name] = { kind: 'flexible' };
    instance.registerTool(apiTool.name, {
      description: apiTool.description,
      inputSchema: apiTool.inputSchema,
    }, apiTool.handler);
  }

  return {
    type: 'sdk',
    name,
    instance,
    toolPermissions,
  };
}
