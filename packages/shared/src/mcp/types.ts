// input: Source/Backend MCP connection configs and the MCP SDK type vocabulary
// output: Pure MCP types plus the minimal pool interface the agent runtime codes against
// pos: Contract layer of the mcp subdomain; runtime pool/clients live in @craft-agent/server-core/mcp

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiToolPermissionDefinition, ApiToolPermission } from '../sources/types.ts';

/**
 * HTTP transport config for remote MCP servers
 */
export interface HttpMcpClientConfig {
  transport: 'http';
  url: string;
  headers?: Record<string, string>;
}

/**
 * Stdio transport config for local MCP servers (spawns subprocess)
 */
export interface StdioMcpClientConfig {
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Unified config supporting both transport types
 */
export type McpClientConfig = HttpMcpClientConfig | StdioMcpClientConfig;

/**
 * Interface for clients managed by McpClientPool.
 * Both CraftMcpClient (remote MCP sources) and ApiSourcePoolClient (API sources) implement this.
 */
export interface PoolClient {
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * SDK-compatible MCP server configuration.
 * Supports HTTP/SSE (remote) and stdio (local subprocess) transports.
 */
export type SdkMcpServerConfig =
  | {
      type: 'http' | 'sse';
      /** Exact Host capability bound to this Source definition. */
      capabilityRef: string;
      url: string;
      headers?: Record<string, string>;
      /** Environment variable name containing bearer token (Codex-specific) */
      bearerTokenEnvVar?: string;
    }
  | {
      type: 'stdio';
      /** Exact Host capability bound to this Source definition. */
      capabilityRef: string;
      command: string;
      args?: string[];
      /** Environment variables to set (literal values) */
      env?: Record<string, string>;
      /** Environment variable names to forward from parent process (Codex-specific) */
      envVars?: string[];
      /** Working directory for the server process (Codex-specific) */
      cwd?: string;
    };

/**
 * Configuration for an in-process API source server.
 * Used by McpClientPool.sync() to connect API sources alongside MCP sources.
 */
export interface ApiServerConfig {
  type: 'sdk';
  /** Exact Host capability bound to this Source definition. */
  capabilityRef: string;
  instance: McpServer;
  toolPermissions?: Record<string, ApiToolPermissionDefinition>;
}

/**
 * Proxy tool definition — the format passed to backends for registration.
 * Uses mcp__{slug}__{toolName} naming convention.
 */
export interface ProxyToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Result of an MCP tool call, matching the subprocess protocol format.
 */
export interface McpToolResult {
  content: string;
  isError: boolean;
  /** Source slug for error attribution (set on failure) */
  sourceSlug?: string;
}

/**
 * Minimal pool surface consumed inside the agent runtime (transport, host, backend types).
 * The concrete McpClientPool lives in @craft-agent/server-core and satisfies this
 * structurally — shared code must not depend on the main-process implementation.
 */
export interface McpClientPoolLike {
  /** Reconcile active sources; returns slugs that failed to connect */
  sync(
    mcpServers: Record<string, SdkMcpServerConfig>,
    apiServers?: Record<string, ApiServerConfig>
  ): Promise<string[]>;
  disconnectAll(): Promise<void>;
  getProxyToolDefs(slugs?: string[]): ProxyToolDef[];
  callTool(proxyName: string, args: Record<string, unknown>): Promise<McpToolResult>;
  /** Resolve the exact Source capability owned by a registered proxy tool. */
  getProxyToolCapability(
    toolName: string
  ): { sourceSlug: string; capabilityRef: string } | undefined;
  getProxyToolPermission(
    toolName: string,
    input: Record<string, unknown>
  ): ApiToolPermission | undefined;
}
