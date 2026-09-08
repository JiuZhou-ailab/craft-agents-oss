// input: Session metadata snapshots and session-scoped option updates
// output: Per-session option state preserving events received during initial loading
// pos: Renderer session option atom and snapshot boundary

/**
 * Session Options Types
 *
 * Type definitions and helpers for session-scoped settings.
 * The actual hook is in AppShellContext.tsx as useSessionOptionsFor().
 *
 * ADDING A NEW SESSION OPTION:
 * 1. Add field to SessionOptions interface below
 * 2. Update defaultSessionOptions
 * 3. Add UI control in FreeFormInput.tsx (or wherever needed)
 */

import type { PermissionMode, Session } from '../../shared/types'
import type { ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import { DEFAULT_THINKING_LEVEL } from '@craft-agent/shared/agent/thinking-levels'
import { atom } from 'jotai'
import { atomFamily } from 'jotai-family'

/**
 * All session-scoped options in one place.
 */
export interface SessionOptions {
  /** Permission mode ('safe', 'ask', 'allow-all') */
  permissionMode: PermissionMode
  /** Monotonic version from backend permission mode state (used to ignore stale events) */
  permissionModeVersion?: number
  /** Session-level thinking level — sticky, persisted. See {@link ThinkingLevel}. */
  thinkingLevel: ThinkingLevel
}

/** Default values for new sessions */
export const defaultSessionOptions: SessionOptions = {
  permissionMode: 'ask', // Default to ask mode (prompt for permissions)
  thinkingLevel: DEFAULT_THINKING_LEVEL, // Default to 'medium' level
}

export const sessionOptionsAtom = atom<Map<string, SessionOptions>>(new Map())

export const sessionOptionsAtomFamily = atomFamily(
  (sessionId: string) => atom((get) => get(sessionOptionsAtom).get(sessionId) ?? defaultSessionOptions)
)

/** Type for partial updates to session options */
export type SessionOptionUpdates = Partial<SessionOptions>

/** Helper to merge session options with updates */
export function mergeSessionOptions(
  current: SessionOptions | undefined,
  updates: SessionOptionUpdates
): SessionOptions {
  return {
    ...defaultSessionOptions,
    ...current,
    ...updates,
  }
}

function isDefaultStoredSessionOptions(options: SessionOptions): boolean {
  return options.permissionMode === defaultSessionOptions.permissionMode
    && options.thinkingLevel === defaultSessionOptions.thinkingLevel
    && options.permissionModeVersion == null
}

function areSessionOptionsEqual(a: SessionOptions, b: SessionOptions): boolean {
  return a.permissionMode === b.permissionMode
    && a.thinkingLevel === b.thinkingLevel
    && a.permissionModeVersion === b.permissionModeVersion
}

export function updateSessionOptionsMap(
  options: Map<string, SessionOptions>,
  sessionId: string,
  updates: SessionOptionUpdates
): Map<string, SessionOptions> {
  const current = options.get(sessionId)
  const nextOptions = mergeSessionOptions(current, updates)

  if (isDefaultStoredSessionOptions(nextOptions)) {
    if (!current) return options
    const next = new Map(options)
    next.delete(sessionId)
    return next
  }

  if (current && areSessionOptionsEqual(current, nextOptions)) return options

  const next = new Map(options)
  next.set(sessionId, nextOptions)
  return next
}


/** Start from the authoritative list, preserving only newer events from this load. */
export function initializeSessionOptionsMap(
  sessions: ReadonlyArray<Pick<Session, 'id' | 'permissionMode' | 'permissionModeVersion' | 'thinkingLevel'>>,
  beforeLoad: Map<string, SessionOptions>,
  current: Map<string, SessionOptions>,
): Map<string, SessionOptions> {
  const options = new Map<string, SessionOptions>()
  for (const session of sessions) {
    const latest = current.get(session.id)
    // Versions are Host-local. An unchanged option from before this load must
    // not reject a lower version after a Host restart.
    const hasNewerEvent = latest?.permissionModeVersion !== beforeLoad.get(session.id)?.permissionModeVersion
      && (latest?.permissionModeVersion ?? -1) > (session.permissionModeVersion ?? -1)
    const value: SessionOptions = {
      permissionMode: hasNewerEvent ? latest!.permissionMode : session.permissionMode ?? defaultSessionOptions.permissionMode,
      permissionModeVersion: hasNewerEvent ? latest!.permissionModeVersion : session.permissionModeVersion,
      thinkingLevel: session.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
    }
    if (!isDefaultStoredSessionOptions(value)) options.set(session.id, value)
  }
  return options
}
