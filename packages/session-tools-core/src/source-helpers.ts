/**
 * Session Tools Core - Source Helpers
 *
 * input: Source credential metadata and request identifiers
 * output: Credential-mode helpers and unique request IDs
 * pos: Dependency-free helpers for Source-related session tools
 *
 * Utilities for loading and working with source configurations.
 * These are standalone functions that don't depend on the full
 * packages/shared infrastructure.
 */

/**
 * Generate a unique request ID for auth requests
 */
export function generateRequestId(prefix: string = 'req'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================
// Credential Mode Helpers
// ============================================================

import type { CredentialInputMode } from './types.ts';
export type { CredentialInputMode } from './types.ts';

/**
 * Detect the effective credential input mode based on source config and requested mode.
 *
 * Auto-upgrades to 'multi-header' when source has headerNames array, regardless of
 * what mode was explicitly requested. This ensures Datadog-like sources (with
 * headerNames: ["DD-API-KEY", "DD-APPLICATION-KEY"]) always use multi-header UI.
 *
 * @param source - Source configuration (may be null if source not found)
 * @param requestedMode - Mode explicitly requested in tool call
 * @param requestedHeaderNames - Header names explicitly provided in tool call
 * @returns Effective mode to use
 */
export function detectCredentialMode(
  source: { api?: { headerNames?: string[] }; mcp?: { headerNames?: string[] } } | null,
  requestedMode: CredentialInputMode,
  requestedHeaderNames?: string[]
): CredentialInputMode {
  // Use provided headerNames or fall back to source config (API or MCP)
  const effectiveHeaderNames = requestedHeaderNames || source?.api?.headerNames || source?.mcp?.headerNames;

  // If we have headerNames, always use multi-header mode
  if (effectiveHeaderNames && effectiveHeaderNames.length > 0) {
    return 'multi-header';
  }

  return requestedMode;
}

/**
 * Get effective header names from request args or source config.
 *
 * @param source - Source configuration
 * @param requestedHeaderNames - Header names explicitly provided in tool call
 * @returns Array of header names or undefined
 */
export function getEffectiveHeaderNames(
  source: { api?: { headerNames?: string[] }; mcp?: { headerNames?: string[] } } | null,
  requestedHeaderNames?: string[]
): string[] | undefined {
  return requestedHeaderNames || source?.api?.headerNames || source?.mcp?.headerNames;
}
