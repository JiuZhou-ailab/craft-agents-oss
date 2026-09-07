// input: Stored session snapshots and session JSONL metadata from disk
// output: Debounced, serialized, atomic persistence writes for session state
// pos: Shared persistence queue used by server-core session lifecycle code

import { writeFile as writeFileToDisk, rename, unlink } from 'fs/promises'
import { dirname } from 'path'
import type { StoredSession, SessionHeader } from './types.js'
import {
  getSessionFilePath,
  ensureSessionsDir,
  ensureSessionDir,
  recoverSessionFile,
  setSessionFileReplacementActive,
} from './storage.js'
import { toPortablePath } from '../utils/paths.js'
import { resolveProjectOwnedFilePath } from '../workspaces/paths.js'
import { createSessionHeader, makeSessionPathPortable, readSessionHeader } from './jsonl.js'
import { debug } from '../utils/debug.js'
import { perf } from '../utils/perf.js'

interface PendingWrite {
  data: StoredSession
  timer: ReturnType<typeof setTimeout>
}

interface HeaderMetadataSignature {
  name?: string
  labels?: string[]
  isFlagged?: boolean
  isPinned?: boolean
  sessionStatus?: string
  permissionMode?: string
  hasUnread?: boolean
  lastReadMessageId?: string
}

interface SessionPersistWriteSummary {
  sessionId: string
  messageCount: number
  lineCount: number
  hasExternalMetadataChange: boolean
}

function summarizeSessionPersistWrite(summary: SessionPersistWriteSummary): SessionPersistWriteSummary {
  return summary
}

function shouldLogMetadataMismatch({
  hasMetadataMismatch,
  hasExternalMetadataChange,
}: {
  hasMetadataMismatch: boolean
  hasExternalMetadataChange: boolean
}): boolean {
  return hasMetadataMismatch && hasExternalMetadataChange
}

function getHeaderMetadataSignature(header: SessionHeader): string {
  const signature: HeaderMetadataSignature = {
    name: header.name,
    labels: header.labels,
    isFlagged: header.isFlagged,
    isPinned: header.isPinned,
    sessionStatus: header.sessionStatus,
    permissionMode: header.permissionMode,
    hasUnread: header.hasUnread,
    lastReadMessageId: header.lastReadMessageId,
  }
  return JSON.stringify(signature)
}

function mergeHeaderWithExternalMetadata(localHeader: SessionHeader, diskHeader: SessionHeader): SessionHeader {
  return {
    ...localHeader,
    name: diskHeader.name,
    labels: diskHeader.labels,
    isFlagged: diskHeader.isFlagged,
    isPinned: diskHeader.isPinned,
    sessionStatus: diskHeader.sessionStatus,
    permissionMode: diskHeader.permissionMode,
    hasUnread: diskHeader.hasUnread,
    lastReadMessageId: diskHeader.lastReadMessageId,
  }
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * Debounced async session persistence queue.
 * Prevents main thread blocking by using async writes and coalescing
 * rapid successive persist calls into a single write.
 *
 * IMPORTANT: Writes are serialized per-session to prevent race conditions
 * when rapid successive flushes (e.g., clearSessionForRecovery + onSdkSessionIdUpdate)
 * would otherwise write to the same .tmp file concurrently.
 */
class SessionPersistenceQueue {
  private pending = new Map<string, PendingWrite>()
  private writeInProgress = new Map<string, Promise<void>>()
  private lastWrittenHeaderSignature = new Map<string, string>()
  private debounceMs: number

  constructor(
    debounceMs = 500,
    private readonly writeFile: (path: string, data: string, encoding: BufferEncoding) => Promise<void> = writeFileToDisk,
  ) {
    this.debounceMs = debounceMs
  }

  /**
   * Queue a session for persistence. If a write is already pending for this
   * session, it will be replaced with the new data and the timer reset.
   */
  enqueue(session: StoredSession): void {
    const existing = this.pending.get(session.id)
    if (existing) {
      clearTimeout(existing.timer)
    }

    const timer = setTimeout(() => {
      const write = this.scheduleWrite(session.id)
      if (write) {
        void write.catch(error => {
          console.error(`[PersistenceQueue] Failed to write session ${session.id}:`, error)
        })
      }
    }, this.debounceMs)

    this.pending.set(session.id, { data: session, timer })
  }

  private scheduleWrite(sessionId: string): Promise<void> | undefined {
    const entry = this.pending.get(sessionId)
    if (!entry) return undefined

    this.pending.delete(sessionId)

    const previous = this.writeInProgress.get(sessionId)
    const write = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(() => this.write(entry.data))

    this.writeInProgress.set(sessionId, write)
    void write.then(() => {
      if (this.writeInProgress.get(sessionId) === write) {
        this.writeInProgress.delete(sessionId)
      }
    }, () => {
      // Keep the rejected tail so flush/flushAll can report the terminal failure.
    })

    return write
  }

  /**
   * Write a session to disk immediately in JSONL format.
   * Uses atomic write (write-to-temp-then-rename) to prevent corruption on crash.
   */
  private async write(data: StoredSession): Promise<void> {
    const sessionId = data.id
    const persistSpan = perf.span('session.persist.write', { sessionId })
    try {
      ensureSessionsDir(data.workspaceRootPath)
      ensureSessionDir(data.workspaceRootPath, sessionId)

      const filePath = getSessionFilePath(data.workspaceRootPath, sessionId)
      const recoveredFile = recoverSessionFile(filePath, data.workspaceRootPath)
      if (recoveredFile && recoveredFile !== filePath) {
        throw new Error(`Could not promote recovered session file: ${recoveredFile}`)
      }
      const serializeEnd = perf.start('session.persist.serialize', { sessionId })
      let header: SessionHeader
      let hasExternalMetadataChange = false
      let jsonl = ''
      let persistableMessageCount = 0
      let lineCount = 0

      try {
        // Prepare session with portable paths for cross-machine compatibility
        const storageSession: StoredSession = {
          ...data,
          workspaceRootPath: toPortablePath(data.workspaceRootPath),
          workingDirectory: data.workingDirectory ? toPortablePath(data.workingDirectory) : undefined,
          sdkCwd: data.sdkCwd ? toPortablePath(data.sdkCwd) : undefined,
          lastUsedAt: Date.now(),
        }

        // Create JSONL content: header + messages (one per line)
        // Filter out intermediate messages - they're transient streaming status updates
        const localHeader = createSessionHeader(storageSession)
        const localSig = getHeaderMetadataSignature(localHeader)
        const diskHeader = readSessionHeader(filePath)
        const previousSig = this.lastWrittenHeaderSignature.get(sessionId)
        const diskSig = diskHeader ? getHeaderMetadataSignature(diskHeader) : undefined

        // Queue writes should never clobber session metadata changed externally
        // (watcher edits, direct header edits, other instances), but they must
        // still persist local metadata updates (e.g. generated title).
        //
        // Preserve disk metadata only when disk diverged from our last written
        // signature, which indicates an external mutation.
        const hasMetadataMismatch = !!diskHeader && !!diskSig && diskSig !== localSig
        hasExternalMetadataChange = !!diskHeader && !!diskSig && !!previousSig && diskSig !== previousSig
        header = hasExternalMetadataChange && diskHeader
          ? mergeHeaderWithExternalMetadata(localHeader, diskHeader)
          : localHeader

        if (shouldLogMetadataMismatch({ hasMetadataMismatch, hasExternalMetadataChange })) {
          const baseline = previousSig ? `, previousSig=${previousSig.slice(0, 12)}` : ', previousSig=<none>'
          debug(`[PersistenceQueue] Session ${sessionId} metadata mismatch detected (disk preserved${baseline})`)
        }

        const persistableMessages = storageSession.messages
        // Use original absolute sessionDir (before toPortablePath) for path replacement
        const sessionDir = dirname(filePath)
        const lines = [
          makeSessionPathPortable(JSON.stringify(header), sessionDir),
          ...persistableMessages.map(m => makeSessionPathPortable(JSON.stringify(m), sessionDir)),
        ]
        jsonl = lines.join('\n') + '\n'
        persistableMessageCount = persistableMessages.length
        lineCount = lines.length
      } finally {
        serializeEnd()
      }

      const writeSummary = summarizeSessionPersistWrite({
        sessionId,
        messageCount: persistableMessageCount,
        lineCount,
        hasExternalMetadataChange,
      })
      persistSpan.setMetadata('messageCount', writeSummary.messageCount)
      persistSpan.setMetadata('lineCount', writeSummary.lineCount)
      persistSpan.setMetadata('hasExternalMetadataChange', writeSummary.hasExternalMetadataChange)

      // Crash-safe replacement: write .tmp, move the current file to .bak,
      // then promote .tmp. At least one valid candidate survives each step.
      //
      // Update signature BEFORE the write so that fs.watch events fired
      // during unlink/rename are correctly identified as self-writes.
      // Without this, onSessionMetadataChange sees the stale signature
      // and reverts in-memory metadata on idle sessions.
      const finalSignature = getHeaderMetadataSignature(header)
      const previousWrittenSignature = this.lastWrittenHeaderSignature.get(sessionId)
      this.lastWrittenHeaderSignature.set(sessionId, finalSignature)

      const writeEnd = perf.start('session.persist.diskWrite', { sessionId })
      const safeFilePath = resolveProjectOwnedFilePath(data.workspaceRootPath, filePath)
      const tmpFile = resolveProjectOwnedFilePath(data.workspaceRootPath, filePath + '.tmp')
      const backupFile = resolveProjectOwnedFilePath(data.workspaceRootPath, filePath + '.bak')
      let hasBackup = false
      setSessionFileReplacementActive(filePath, true)
      try {
        await this.writeFile(tmpFile, jsonl, 'utf-8')
        try {
          await rename(safeFilePath, backupFile)
          hasBackup = true
        } catch (error) {
          if (!isMissingFileError(error)) throw error
        }
        await rename(tmpFile, safeFilePath)
      } catch (error) {
        if (previousWrittenSignature === undefined) {
          this.lastWrittenHeaderSignature.delete(sessionId)
        } else {
          this.lastWrittenHeaderSignature.set(sessionId, previousWrittenSignature)
        }

        if (hasBackup) {
          try {
            await rename(backupFile, safeFilePath)
          } catch (restoreError) {
            throw new AggregateError(
              [error, restoreError],
              `Failed to replace and restore session ${sessionId}`,
            )
          }
        }
        throw error
      } finally {
        setSessionFileReplacementActive(filePath, false)
        writeEnd()
      }

      if (hasBackup) {
        try { await unlink(backupFile) } catch (error) {
          if (!isMissingFileError(error)) {
            debug(`[PersistenceQueue] Could not remove backup for session ${sessionId}:`, error)
          }
        }
      }
      debug(`[PersistenceQueue] Wrote session ${sessionId}`)
    } finally {
      persistSpan.end()
    }
  }

  /**
   * Immediately flush a specific session if pending.
   * Waits for any in-progress write to complete before starting a new one
   * to prevent race conditions on the shared .tmp file.
   */
  async flush(sessionId: string): Promise<void> {
    const entry = this.pending.get(sessionId)
    if (entry) {
      clearTimeout(entry.timer)
    }

    const write = this.scheduleWrite(sessionId) ?? this.writeInProgress.get(sessionId)
    if (write) await write
  }

  /**
   * Cancel a pending write for a session (e.g., when deleting the session).
   */
  cancel(sessionId: string): void {
    const entry = this.pending.get(sessionId)
    if (entry) {
      clearTimeout(entry.timer)
      this.pending.delete(sessionId)
      debug(`[PersistenceQueue] Cancelled pending write for session ${sessionId}`)
    }
    this.lastWrittenHeaderSignature.delete(sessionId)
  }

  /**
   * Settle and forget a retired locator's pending write, including a rejected
   * terminal tail. Callers must persist their current snapshot elsewhere.
   */
  async retire(sessionId: string): Promise<void> {
    const entry = this.pending.get(sessionId)
    if (entry) {
      clearTimeout(entry.timer)
      this.pending.delete(sessionId)
    }

    const write = this.writeInProgress.get(sessionId)
    if (write) {
      await write.catch(() => undefined)
      if (this.writeInProgress.get(sessionId) === write) {
        this.writeInProgress.delete(sessionId)
      }
    }
    this.lastWrittenHeaderSignature.delete(sessionId)
  }

  /**
   * Flush all pending and timer-started sessions. Call this on app quit.
   */
  async flushAll(): Promise<void> {
    const sessionIds = new Set([
      ...this.pending.keys(),
      ...this.writeInProgress.keys(),
    ])
    const results = await Promise.allSettled([...sessionIds].map(id => this.flush(id)))
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason)

    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Failed to flush all sessions')
    }
  }

  /**
   * Check if a session has a pending write.
   */
  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  /**
   * Get the metadata signature of the last header we wrote for a session.
   * Used by ConfigWatcher to suppress self-triggered metadata change events.
   */
  getLastWrittenSignature(sessionId: string): string | undefined {
    return this.lastWrittenHeaderSignature.get(sessionId)
  }

  /**
   * Get count of pending writes.
   */
  get pendingCount(): number {
    return this.pending.size
  }
}

// Singleton instance
export const sessionPersistenceQueue = new SessionPersistenceQueue()

// Named exports for testing/customization
export {
  SessionPersistenceQueue,
  getHeaderMetadataSignature,
  mergeHeaderWithExternalMetadata,
  shouldLogMetadataMismatch,
  summarizeSessionPersistWrite,
}
