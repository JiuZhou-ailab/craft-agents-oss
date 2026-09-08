// input: Workspace paths, persisted session JSONL candidates, and session mutations
// output: Workspace-scoped session CRUD with crash-safe recovery and root-locator rebasing
// pos: Shared storage boundary for durable session state and session-owned files

/**
 * Session Storage
 *
 * Workspace-scoped session CRUD operations.
 * Sessions are stored at {workspaceRootPath}/.craft-agent/sessions/{id}/session.jsonl
 * Each session folder contains:
 * - session.jsonl (main data in JSONL format: line 1 = header, lines 2+ = messages)
 * - attachments/ (file attachments)
 * - plans/ (plan files for Safe Mode)
 * - data/ (transform_data tool output: JSON files for datatable/spreadsheet blocks)
 * - long_responses/ (full tool results that were summarized due to size limits)
 * - downloads/ (binary files downloaded from API sources: PDFs, images, archives, etc.)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  renameSync,
} from 'fs';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'node:crypto';
import {
  getLegacyWorkspaceSessionsPath,
  getWorkspaceSessionsPath,
  ensureProjectOwnedDirectory,
  rebasePathWithinProjectRoot,
  resolveProjectOwnedFilePath,
  resolveProjectOwnedPath,
} from '../workspaces/paths.ts';
import { expandPath } from '../utils/paths.ts';
import { sanitizeSessionId } from './validation.ts';
import { perf } from '../utils/perf.ts';
import type {
  SessionConfig,
  StoredSession,
  SessionMetadata,
  SessionHeader,
  SessionStatus,
} from './types.ts';
import { SESSION_SCHEMA_VERSION } from './types.ts';
import { validateSessionStatus } from '../statuses/validation.ts';
import { debug } from '../utils/debug.ts';
import { getStatusCategory } from '../statuses/storage.ts';
import { readSessionHeader, readSessionHeaderAsync, readSessionJsonl } from './jsonl.ts';
import { sessionPersistenceQueue } from './persistence-queue.ts';

// Re-export types for convenience
export type { SessionConfig } from './types.ts';

// ============================================================
// Directory Utilities
// ============================================================

/**
 * Ensure sessions directory exists for a workspace
 */
export function ensureSessionsDir(workspaceRootPath: string): string {
  const dir = getWorkspaceSessionsPath(workspaceRootPath);
  return ensureProjectOwnedDirectory(workspaceRootPath, dir);
}

/**
 * Get path to a session's directory
 *
 * SECURITY: Uses sanitizeSessionId() as defense-in-depth to prevent path traversal.
 * Callers should still validate sessionId before calling this function.
 */
export function getSessionPath(workspaceRootPath: string, sessionId: string): string {
  // Defense-in-depth: strip any path components from sessionId
  const safeSessionId = sanitizeSessionId(sessionId);
  const sessionPath = join(getWorkspaceSessionsPath(workspaceRootPath), safeSessionId);
  if (existsSync(sessionPath)) return resolveProjectOwnedPath(workspaceRootPath, sessionPath);

  const legacySessionPath = join(getLegacyWorkspaceSessionsPath(workspaceRootPath), safeSessionId);
  if (existsSync(legacySessionPath)) return resolveProjectOwnedPath(workspaceRootPath, legacySessionPath);

  return sessionPath;
}

/**
 * Get path to a session's JSONL file (inside session folder)
 */
export function getSessionFilePath(workspaceRootPath: string, sessionId: string): string {
  return join(getSessionPath(workspaceRootPath, sessionId), 'session.jsonl');
}

interface ValidSessionFileCandidate {
  path: string;
  mtimeMs: number;
  priority: number;
}

const activeSessionFileReplacements = new Set<string>();

export function setSessionFileReplacementActive(sessionFile: string, active: boolean): void {
  if (active) activeSessionFileReplacements.add(sessionFile);
  else activeSessionFileReplacements.delete(sessionFile);
}

function getValidSessionFileCandidate(path: string, priority: number): ValidSessionFileCandidate | null {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null;

    const lines = readFileSync(path, 'utf-8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.length === 0 || lines.some(line => line.trim() === '')) return null;
    for (const line of lines) JSON.parse(line);

    const session = readSessionJsonl(path);
    if (!session || typeof session.id !== 'string' || !Array.isArray(session.messages)) return null;

    return { path, mtimeMs: statSync(path).mtimeMs, priority };
  } catch {
    return null;
  }
}

/**
 * Recover an interrupted session replacement from the newest complete JSONL
 * among the committed file, temporary file, and backup.
 *
 * Returns a readable candidate even if promotion fails, so callers never need
 * to discard the only valid copy.
 */
export function recoverSessionFile(sessionFile: string, workspaceRootPath: string): string | null {
  sessionFile = resolveProjectOwnedFilePath(workspaceRootPath, sessionFile);
  const tmpFile = resolveProjectOwnedFilePath(workspaceRootPath, sessionFile + '.tmp');
  const backupFile = resolveProjectOwnedFilePath(workspaceRootPath, sessionFile + '.bak');

  if (activeSessionFileReplacements.has(sessionFile)) {
    return existsSync(sessionFile) ? sessionFile : null;
  }

  if (!existsSync(tmpFile) && !existsSync(backupFile)) {
    return existsSync(sessionFile) ? sessionFile : null;
  }

  const candidates = [
    getValidSessionFileCandidate(sessionFile, 1),
    getValidSessionFileCandidate(tmpFile, 2),
    getValidSessionFileCandidate(backupFile, 0),
  ].filter((candidate): candidate is ValidSessionFileCandidate => candidate !== null);

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.priority - a.priority);
  const newest = candidates[0];
  if (!newest) return null;

  if (newest.path !== sessionFile) {
    try {
      if (existsSync(sessionFile)) unlinkSync(sessionFile);
      renameSync(newest.path, sessionFile);
    } catch (error) {
      debug('[sessions] Failed to promote recovered session candidate:', newest.path, error);
      return newest.path;
    }
  }

  for (const staleFile of [tmpFile, backupFile]) {
    if (staleFile === newest.path) continue;
    try { unlinkSync(staleFile); } catch { /* keep unreadable or concurrently used candidates */ }
  }

  return sessionFile;
}

/**
 * Ensure session directory exists with all subdirectories
 */
export function ensureSessionDir(workspaceRootPath: string, sessionId: string): string {
  const sessionDir = ensureProjectOwnedDirectory(
    workspaceRootPath,
    join(getWorkspaceSessionsPath(workspaceRootPath), sanitizeSessionId(sessionId)),
  );
  // Also create plans, attachments, long_responses, and downloads directories
  const plansDir = join(sessionDir, 'plans');
  ensureProjectOwnedDirectory(workspaceRootPath, plansDir);
  const attachmentsDir = join(sessionDir, 'attachments');
  ensureProjectOwnedDirectory(workspaceRootPath, attachmentsDir);
  const longResponsesDir = join(sessionDir, 'long_responses');
  ensureProjectOwnedDirectory(workspaceRootPath, longResponsesDir);
  // Data directory for transform_data tool output (JSON files for datatable/spreadsheet)
  const dataDir = join(sessionDir, 'data');
  ensureProjectOwnedDirectory(workspaceRootPath, dataDir);
  // Downloads directory for binary files from API responses (PDFs, images, etc.)
  const downloadsDir = join(sessionDir, 'downloads');
  ensureProjectOwnedDirectory(workspaceRootPath, downloadsDir);
  return sessionDir;
}

/**
 * Get the attachments directory for a session
 */
export function getSessionAttachmentsPath(workspaceRootPath: string, sessionId: string): string {
  return join(getSessionPath(workspaceRootPath, sessionId), 'attachments');
}

/**
 * Get the plans directory for a session
 */
export function getSessionPlansPath(workspaceRootPath: string, sessionId: string): string {
  return join(getSessionPath(workspaceRootPath, sessionId), 'plans');
}

/**
 * Get the data directory for a session (transform_data tool output)
 */
export function getSessionDataPath(workspaceRootPath: string, sessionId: string): string {
  return join(getSessionPath(workspaceRootPath, sessionId), 'data');
}

/**
 * Get the downloads directory for a session (binary files from API responses)
 */
export function getSessionDownloadsPath(workspaceRootPath: string, sessionId: string): string {
  return join(getSessionPath(workspaceRootPath, sessionId), 'downloads');
}

// ============================================================
// Session ID Generation
// ============================================================

/**
 * Generate an opaque Host-wide Session ID. Display names remain human-readable;
 * identity must not collide merely because two Projects have different roots.
 */
export function generateSessionId(_workspaceRootPath: string): string {
  return `session_${randomUUID()}`;
}

// ============================================================
// Session CRUD
// ============================================================

/**
 * Create a new session for a workspace
 */
export async function createSession(
  workspaceRootPath: string,
  options?: {
    name?: string;
    workingDirectory?: string;
    permissionMode?: SessionConfig['permissionMode'];
    enabledSourceSlugs?: string[];
    model?: string;
    llmConnection?: string;
    hidden?: boolean;
    sessionStatus?: SessionConfig['sessionStatus'];
    labels?: string[];
    isFlagged?: boolean;
    isPinned?: boolean;
  }
): Promise<SessionConfig> {
  ensureSessionsDir(workspaceRootPath);

  const now = Date.now();
  const sessionId = generateSessionId(workspaceRootPath);

  // Create session directory with all subdirectories (plans, attachments)
  ensureSessionDir(workspaceRootPath, sessionId);

  // Set sdkCwd to initial working directory or session path - this never changes
  // The SDK stores session transcripts at ~/.claude/projects/{cwd-slugified}/
  // If workingDirectory changes later, sdkCwd stays the same to preserve session resumption
  const sdkCwd = options?.workingDirectory ?? getSessionPath(workspaceRootPath, sessionId);

  const session: SessionConfig = {
    id: sessionId,
    schemaVersion: SESSION_SCHEMA_VERSION,
    workspaceRootPath,
    name: options?.name,
    createdAt: now,
    lastUsedAt: now,
    workingDirectory: options?.workingDirectory,
    sdkCwd,
    permissionMode: options?.permissionMode,
    enabledSourceSlugs: options?.enabledSourceSlugs,
    model: options?.model,
    llmConnection: options?.llmConnection,
    hidden: options?.hidden,
    sessionStatus: options?.sessionStatus,
    labels: options?.labels,
    isFlagged: options?.isFlagged,
    isPinned: options?.isPinned,
  };

  // Save empty session
  const storedSession: StoredSession = {
    ...session,
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  };
  await saveSession(storedSession);

  return session;
}

/**
 * Get or create a session with a specific ID
 * Used for --session <id> flag to allow user-defined session IDs
 */
export async function getOrCreateSessionById(
  workspaceRootPath: string,
  sessionId: string
): Promise<SessionConfig> {
  const existing = loadSession(workspaceRootPath, sessionId);
  if (existing) {
    return {
      id: existing.id,
      sdkSessionId: existing.sdkSessionId,
      workspaceRootPath: existing.workspaceRootPath,
      name: existing.name,
      createdAt: existing.createdAt,
      lastUsedAt: existing.lastUsedAt,
      sdkCwd: existing.sdkCwd,
      workingDirectory: existing.workingDirectory,
    };
  }

  // Create new session with the specified ID
  ensureSessionsDir(workspaceRootPath);

  // Create session directory with all subdirectories (plans, attachments)
  ensureSessionDir(workspaceRootPath, sessionId);

  const now = Date.now();
  // Set sdkCwd to session path - this never changes (ensures SDK can find session transcripts)
  const sdkCwd = getSessionPath(workspaceRootPath, sessionId);

  const session: SessionConfig = {
    id: sessionId,
    schemaVersion: SESSION_SCHEMA_VERSION,
    workspaceRootPath,
    sdkCwd,
    createdAt: now,
    lastUsedAt: now,
  };

  const storedSession: StoredSession = {
    ...session,
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  };
  await saveSession(storedSession);

  return session;
}

/**
 * Save session immediately using the persistence queue.
 * Enqueues the session and flushes to ensure immediate write.
 *
 * This unified approach ensures all session writes go through the same
 * async code path, which is more reliable on Windows.
 *
 * Writes in JSONL format: line 1 = header, lines 2+ = messages
 */
export async function saveSession(session: StoredSession): Promise<void> {
  sessionPersistenceQueue.enqueue(session);
  await sessionPersistenceQueue.flush(session.id);
}

/**
 * Queue session for async persistence with debouncing.
 * Multiple rapid calls are coalesced into a single write.
 * Use this during active sessions to avoid blocking the main thread.
 */
export { sessionPersistenceQueue, getHeaderMetadataSignature } from './persistence-queue.js'

/**
 * Load session by ID
 * Loads session from folder structure in JSONL format.
 */
export function loadSession(workspaceRootPath: string, sessionId: string): StoredSession | null {
  const end = perf.start('session.loadSession', { sessionId });

  const jsonlPath = getSessionFilePath(workspaceRootPath, sessionId);
  const readablePath = recoverSessionFile(jsonlPath, workspaceRootPath);
  if (readablePath) {
    const session = readSessionJsonl(readablePath);
    if (session) {
      const previousRoot = session.workspaceRootPath;
      session.workspaceRootPath = workspaceRootPath;
      session.workingDirectory = rebasePathWithinProjectRoot(
        session.workingDirectory,
        previousRoot,
        workspaceRootPath,
      );
      session.sdkCwd = rebasePathWithinProjectRoot(session.sdkCwd, previousRoot, workspaceRootPath);
      session.branchFromSessionPath = rebasePathWithinProjectRoot(
        session.branchFromSessionPath,
        previousRoot,
        workspaceRootPath,
      );
      session.branchFromSdkCwd = rebasePathWithinProjectRoot(
        session.branchFromSdkCwd,
        previousRoot,
        workspaceRootPath,
      );
      end();
      return session;
    }
  }

  end();
  return null;
}

async function loadSessionForUpdate(workspaceRootPath: string, sessionId: string): Promise<StoredSession | null> {
  await sessionPersistenceQueue.flush(sessionId);
  return loadSession(workspaceRootPath, sessionId);
}

/**
 * List sessions for a workspace
 * Lists sessions from folder structure.
 *
 * Uses JSONL header for fast loading (only reads first line of each file).
 */
export function listSessions(workspaceRootPath: string): SessionMetadata[] {
  const span = perf.span('session.listSessions');
  const sessionDirs = [
    getLegacyWorkspaceSessionsPath(workspaceRootPath),
    getWorkspaceSessionsPath(workspaceRootPath),
  ]
    .filter((sessionsDir, index, dirs) => existsSync(sessionsDir) && dirs.indexOf(sessionsDir) === index)
    .map(sessionsDir => resolveProjectOwnedPath(workspaceRootPath, sessionsDir));
  span.mark('readdir');
  const sessionsById = new Map<string, SessionMetadata>();

  for (const sessionsDir of sessionDirs) {
    const entries = readdirSync(sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const sessionId = entry.name;
        const sessionDir = join(sessionsDir, sessionId);
        const jsonlFile = join(sessionDir, 'session.jsonl');

        const readablePath = recoverSessionFile(jsonlFile, workspaceRootPath);
        if (readablePath) {
          const header = readSessionHeader(readablePath);
          if (header) {
            const metadata = headerToMetadata(header, workspaceRootPath);
            if (metadata) sessionsById.set(metadata.id, metadata);
          }
        }
      }
    }
  }
  span.mark('parsed');
  const sessions = Array.from(sessionsById.values());
  span.setMetadata('count', sessions.length);

  // Sort by lastUsedAt descending (most recent first)
  const sorted = sessions.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  span.end();
  return sorted;
}

/**
 * Non-blocking session listing for startup restoration.
 * Reads headers in bounded batches so large histories do not stall the main thread.
 */
export async function listSessionsAsync(
  workspaceRootPath: string,
  includeLegacyRoot = true,
): Promise<SessionMetadata[]> {
  const span = perf.span('session.listSessionsAsync');
  const sessionDirs = [
    ...(includeLegacyRoot ? [getLegacyWorkspaceSessionsPath(workspaceRootPath)] : []),
    getWorkspaceSessionsPath(workspaceRootPath),
  ]
    .filter((sessionsDir, index, dirs) => existsSync(sessionsDir) && dirs.indexOf(sessionsDir) === index)
    .map(sessionsDir => resolveProjectOwnedPath(workspaceRootPath, sessionsDir));
  span.mark('readdir');
  const sessionsById = new Map<string, SessionMetadata>();

  for (const sessionsDir of sessionDirs) {
    const entries = (await readdir(sessionsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory());

    for (let index = 0; index < entries.length; index += 32) {
      const batch = entries.slice(index, index + 32);
      const metadataBatch = await Promise.all(batch.map(async (entry) => {
        const jsonlFile = join(sessionsDir, entry.name, 'session.jsonl');
        const readablePath = recoverSessionFile(jsonlFile, workspaceRootPath);
        if (!readablePath) return null;

        const header = await readSessionHeaderAsync(readablePath);
        return header ? headerToMetadata(header, workspaceRootPath) : null;
      }));

      for (const metadata of metadataBatch) {
        if (metadata) sessionsById.set(metadata.id, metadata);
      }
    }
  }

  span.mark('parsed');
  const sessions = Array.from(sessionsById.values());
  span.setMetadata('count', sessions.length);
  const sorted = sessions.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  span.end();
  return sorted;
}

/**
 * Convert SessionHeader to SessionMetadata
 * Used for fast session list loading from JSONL format.
 */
function headerToMetadata(header: SessionHeader, workspaceRootPath: string): SessionMetadata | null {
  try {
    // Migration: accept old 'todoState' field from pre-rename session files
    // SAFETY: legacy headers persisted todoState before the sessionStatus rename;
    // the cast only widens the read and validateSessionStatus gates the value.
    const rawStatus = header.sessionStatus ?? (header as unknown as { todoState?: string }).todoState;
    // Validate sessionStatus against workspace status config
    const validatedStatus = validateSessionStatus(workspaceRootPath, rawStatus);

    // Count plan files for this session
    const planCount = countPlanFiles(workspaceRootPath, header.id);

    // Migration: For sessions created before sdkCwd was added, use workingDirectory as fallback.
    const previousRoot = expandPath(header.workspaceRootPath);
    const workingDir = rebasePathWithinProjectRoot(
      header.workingDirectory ? expandPath(header.workingDirectory) : undefined,
      previousRoot,
      workspaceRootPath,
    );
    const sdkCwd = rebasePathWithinProjectRoot(
      header.sdkCwd ? expandPath(header.sdkCwd) : workingDir,
      previousRoot,
      workspaceRootPath,
    );
    const branchFromSessionPath = rebasePathWithinProjectRoot(
      header.branchFromSessionPath ? expandPath(header.branchFromSessionPath) : undefined,
      previousRoot,
      workspaceRootPath,
    );
    const branchFromSdkCwd = rebasePathWithinProjectRoot(
      header.branchFromSdkCwd ? expandPath(header.branchFromSdkCwd) : undefined,
      previousRoot,
      workspaceRootPath,
    );

    // Destructure fields that don't exist on SessionMetadata or need overrides
    const {
      enabledSourceSlugs: _es, pendingPlanExecution: _pp,
      sessionStatus: _ss, workingDirectory: _wd, sdkCwd: _sc,
      workspaceRootPath: _wrp, agentRuntime: legacyAgentRuntime, ...headerFields
    } = header;

    return {
      ...headerFields,
      workspaceRootPath,
      sessionStatus: validatedStatus,
      planCount: planCount > 0 ? planCount : undefined,
      workingDirectory: workingDir,
      sdkCwd,
      branchFromSessionPath,
      branchFromSdkCwd,
      legacyAgentRuntime,
    } as SessionMetadata;
  } catch (error) {
    debug(`[sessions] Failed to convert header to metadata for session "${header?.id}" in ${workspaceRootPath}:`, error);
    return null;
  }
}

/**
 * Delete a session and its associated files
 * Deletes session folder and all associated files
 */
export function deleteSession(workspaceRootPath: string, sessionId: string): boolean {
  try {
    // Delete session directory (includes session.json, attachments, plans)
    const safeSessionId = sanitizeSessionId(sessionId);
    for (const sessionDir of [
      join(getWorkspaceSessionsPath(workspaceRootPath), safeSessionId),
      join(getLegacyWorkspaceSessionsPath(workspaceRootPath), safeSessionId),
    ]) {
      if (existsSync(sessionDir)) {
        rmSync(resolveProjectOwnedPath(workspaceRootPath, sessionDir), { recursive: true });
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Clear messages from a session while preserving metadata.
 * Used for /clear command to reset conversation without creating a new session.
 * Also clears the SDK session ID to start a fresh Claude conversation.
 */
export async function clearSessionMessages(workspaceRootPath: string, sessionId: string): Promise<void> {
  const session = await loadSessionForUpdate(workspaceRootPath, sessionId);
  if (session) {
    // Clear messages and SDK session ID but preserve metadata
    session.messages = [];
    session.sdkSessionId = undefined;
    // Reset token usage to zero
    session.tokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    };
    await saveSession(session);
  }
}

/**
 * Get or create the latest session for a workspace
 * Uses listActiveSessions to exclude archived sessions
 */
export async function getOrCreateLatestSession(workspaceRootPath: string): Promise<SessionConfig> {
  const sessions = listActiveSessions(workspaceRootPath);
  if (sessions.length > 0 && sessions[0]) {
    const latest = sessions[0];
    return {
      id: latest.id,
      sdkSessionId: latest.sdkSessionId,
      workspaceRootPath: latest.workspaceRootPath,
      name: latest.name,
      createdAt: latest.createdAt,
      lastUsedAt: latest.lastUsedAt,
    };
  }
  return createSession(workspaceRootPath);
}

// ============================================================
// Session Metadata Updates
// ============================================================

/**
 * Update SDK session ID for a session
 */
export async function updateSessionSdkId(
  workspaceRootPath: string,
  sessionId: string,
  sdkSessionId: string
): Promise<void> {
  const session = await loadSessionForUpdate(workspaceRootPath, sessionId);
  if (session) {
    session.sdkSessionId = sdkSessionId;
    await saveSession(session);
  }
}

/**
 * Check if sdkCwd can be safely updated for a session.
 *
 * sdkCwd is normally immutable because the SDK stores session transcripts at
 * ~/.claude/projects/{cwd-slugified}/. However, it's safe to update sdkCwd if
 * no SDK interaction has occurred yet (no transcripts to preserve).
 *
 * @returns true if sdkCwd can be updated (no messages and no SDK session ID)
 */
export function canUpdateSdkCwd(session: StoredSession): boolean {
  // Safe to update if:
  // 1. No messages have been sent yet (no conversation to preserve)
  // 2. No SDK session ID (no transcript exists at the sdkCwd path)
  return session.messages.length === 0 && !session.sdkSessionId;
}

/**
 * Update session metadata
 */
export async function updateSessionMetadata(
  workspaceRootPath: string,
  sessionId: string,
  updates: Partial<Pick<SessionConfig,
    | 'isFlagged'
    | 'isPinned'
    | 'name'
    | 'sessionStatus'
    | 'labels'
    | 'lastReadMessageId'
    | 'hasUnread'
    | 'enabledSourceSlugs'
    | 'workingDirectory'
    | 'sdkCwd'
    | 'permissionMode'
    | 'sharedUrl'
    | 'sharedId'
    | 'model'
    | 'llmConnection'
    | 'isArchived'
    | 'archivedAt'
  >>
): Promise<void> {
  const session = await loadSessionForUpdate(workspaceRootPath, sessionId);
  if (!session) return;

  if (updates.isFlagged !== undefined) session.isFlagged = updates.isFlagged;
  if (updates.isPinned !== undefined) session.isPinned = updates.isPinned;
  if (updates.name !== undefined) session.name = updates.name;
  if (updates.sessionStatus !== undefined) session.sessionStatus = updates.sessionStatus;
  if (updates.labels !== undefined) session.labels = updates.labels;
  if (updates.enabledSourceSlugs !== undefined) session.enabledSourceSlugs = updates.enabledSourceSlugs;
  if (updates.workingDirectory !== undefined) session.workingDirectory = updates.workingDirectory;
  if (updates.sdkCwd !== undefined) session.sdkCwd = updates.sdkCwd;
  if (updates.permissionMode !== undefined) session.permissionMode = updates.permissionMode;
  if ('lastReadMessageId' in updates) session.lastReadMessageId = updates.lastReadMessageId;
  if ('hasUnread' in updates) session.hasUnread = updates.hasUnread;
  if ('sharedUrl' in updates) session.sharedUrl = updates.sharedUrl;
  if ('sharedId' in updates) session.sharedId = updates.sharedId;
  if (updates.model !== undefined) session.model = updates.model;
  if (updates.llmConnection !== undefined) session.llmConnection = updates.llmConnection;
  if (updates.isArchived !== undefined) session.isArchived = updates.isArchived;
  if ('archivedAt' in updates) session.archivedAt = updates.archivedAt;

  await saveSession(session);
}

/**
 * Flag a session
 */
export async function flagSession(workspaceRootPath: string, sessionId: string): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, { isFlagged: true });
}

/**
 * Unflag a session
 */
export async function unflagSession(workspaceRootPath: string, sessionId: string): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, { isFlagged: false });
}

/**
 * Pin a session in navigation without changing automation-visible flags.
 */
export async function pinSession(workspaceRootPath: string, sessionId: string): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, { isPinned: true });
}

/**
 * Unpin a session in navigation without changing automation-visible flags.
 */
export async function unpinSession(workspaceRootPath: string, sessionId: string): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, { isPinned: false });
}

/**
 * Set session status
 */
export async function setSessionStatus(
  workspaceRootPath: string,
  sessionId: string,
  sessionStatus: SessionStatus
): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, { sessionStatus });
}

/**
 * Set labels for a session
 */
export async function setSessionLabels(
  workspaceRootPath: string,
  sessionId: string,
  labels: string[]
): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, { labels });
}

/**
 * Archive a session
 */
export async function archiveSession(workspaceRootPath: string, sessionId: string): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, {
    isArchived: true,
    archivedAt: Date.now(),
  });
}

/**
 * Unarchive a session
 */
export async function unarchiveSession(workspaceRootPath: string, sessionId: string): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, {
    isArchived: false,
    archivedAt: undefined,
  });
}

// ============================================================
// Pending Plan Execution (Accept & Compact flow)
// ============================================================

/**
 * Set pending plan execution state.
 * Called when user clicks "Accept & Compact" - stores the plan path
 * so it can be executed after compaction, even if the page reloads.
 */
export async function setPendingPlanExecution(
  workspaceRootPath: string,
  sessionId: string,
  planPath: string,
  draftInputSnapshot?: string,
): Promise<void> {
  const session = await loadSessionForUpdate(workspaceRootPath, sessionId);
  if (!session) return;

  session.pendingPlanExecution = {
    planPath,
    draftInputSnapshot,
    awaitingCompaction: true,
    executionDispatched: false,
  };
  await saveSession(session);
}

/**
 * Mark compaction as complete for pending plan execution.
 * Called when compaction_complete event fires - sets awaitingCompaction to false
 * so reload recovery knows compaction finished and can trigger execution.
 */
export async function markCompactionComplete(
  workspaceRootPath: string,
  sessionId: string
): Promise<void> {
  const session = await loadSessionForUpdate(workspaceRootPath, sessionId);
  if (!session?.pendingPlanExecution) return;

  session.pendingPlanExecution.awaitingCompaction = false;
  await saveSession(session);
}

/**
 * Mark pending plan execution as already dispatched from the UI.
 * This prevents reload recovery from sending the same approval message twice
 * if cleanup fails after the send has already been kicked off.
 */
export async function markPendingPlanExecutionDispatched(
  workspaceRootPath: string,
  sessionId: string
): Promise<void> {
  const session = await loadSessionForUpdate(workspaceRootPath, sessionId);
  if (!session?.pendingPlanExecution) return;

  session.pendingPlanExecution.executionDispatched = true;
  await saveSession(session);
}

/**
 * Clear pending plan execution state.
 * Called after plan execution is sent, on new user message, or when
 * the pending execution is no longer relevant.
 */
export async function clearPendingPlanExecution(
  workspaceRootPath: string,
  sessionId: string
): Promise<void> {
  await sessionPersistenceQueue.flush(sessionId);
  const readablePath = recoverSessionFile(getSessionFilePath(workspaceRootPath, sessionId), workspaceRootPath);
  const header = readablePath ? readSessionHeader(readablePath) : null;
  // A valid header answers the common no-op without parsing the transcript.
  // Incomplete headers and interrupted replacements retain the full recovery path.
  if (header?.id === sessionId && typeof header.workspaceRootPath === 'string' && !header.pendingPlanExecution) return;

  const session = loadSession(workspaceRootPath, sessionId);
  if (!session?.pendingPlanExecution) return;

  delete session.pendingPlanExecution;
  await saveSession(session);
}

/**
 * Get pending plan execution state for a session.
 * Used on reload to check if we need to resume plan execution.
 */
export function getPendingPlanExecution(
  workspaceRootPath: string,
  sessionId: string
): { planPath: string; draftInputSnapshot?: string; awaitingCompaction: boolean; executionDispatched: boolean } | null {
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session?.pendingPlanExecution) return null;
  return {
    ...session.pendingPlanExecution,
    executionDispatched: session.pendingPlanExecution.executionDispatched === true,
  };
}

// ============================================================
// Session Filtering
// ============================================================

/**
 * List flagged sessions (excludes archived)
 */
export function listFlaggedSessions(workspaceRootPath: string): SessionMetadata[] {
  return listActiveSessions(workspaceRootPath).filter(s => s.isFlagged === true);
}

/**
 * List completed sessions (category: closed)
 * Includes done, cancelled, and any custom "closed" statuses
 * Excludes archived sessions
 */
export function listCompletedSessions(workspaceRootPath: string): SessionMetadata[] {
  return listActiveSessions(workspaceRootPath).filter(s => {
    const category = getStatusCategory(workspaceRootPath, s.sessionStatus || 'todo');
    return category === 'closed';
  });
}

/**
 * List inbox sessions (category: open)
 * Includes todo, in-progress, needs-review, and any custom "open" statuses
 * Excludes archived sessions
 */
export function listInboxSessions(workspaceRootPath: string): SessionMetadata[] {
  return listActiveSessions(workspaceRootPath).filter(s => {
    const category = getStatusCategory(workspaceRootPath, s.sessionStatus || 'todo');
    return category === 'open';
  });
}

/**
 * List archived sessions
 */
export function listArchivedSessions(workspaceRootPath: string): SessionMetadata[] {
  return listSessions(workspaceRootPath).filter(s => s.isArchived === true);
}

/**
 * List active (non-archived) sessions
 */
export function listActiveSessions(workspaceRootPath: string): SessionMetadata[] {
  return listSessions(workspaceRootPath).filter(s => s.isArchived !== true);
}

/**
 * Delete archived sessions older than the specified number of days
 * Returns the number of sessions deleted
 */
export function deleteOldArchivedSessions(workspaceRootPath: string, retentionDays: number): number {
  const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
  const archivedSessions = listArchivedSessions(workspaceRootPath);
  let deletedCount = 0;

  for (const session of archivedSessions) {
    // Use archivedAt if available, otherwise fall back to lastUsedAt
    const archiveTime = session.archivedAt ?? session.lastUsedAt;
    if (archiveTime < cutoffTime) {
      if (deleteSession(workspaceRootPath, session.id)) {
        deletedCount++;
      }
    }
  }

  return deletedCount;
}

// Plan contents are owned by Pi; session metadata only derives their count.
export function countPlanFiles(
  workspaceRootPath: string,
  sessionId: string
): number {
  const plansDir = getSessionPlansPath(workspaceRootPath, sessionId);
  if (!existsSync(plansDir)) {
    return 0;
  }

  try {
    return readdirSync(plansDir).filter(f => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}
// ============================================================
// Attachments Directory
// ============================================================

/**
 * Ensure attachments directory exists
 */
export function ensureAttachmentsDir(workspaceRootPath: string, sessionId: string): string {
  const dir = getSessionAttachmentsPath(workspaceRootPath, sessionId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}
