// input: Source filesystem changes observed while a Session owns its Pi runtime lease
// output: Regression coverage for deferred Source runtime refresh after the active turn settles
// pos: Guards the ConfigWatcher-to-SessionManager hot-refresh handoff

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagedSession, SessionManager } from './SessionManager.ts'

describe('Session Source hot refresh', () => {
  it('reloads a Source change after a processing Session settles', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'storyflow-source-hot-refresh-'))
    const workspace = {
      id: 'project-source-hot-refresh',
      name: 'Source Hot Refresh',
      rootPath,
      createdAt: Date.now(),
    }
    const managed = createManagedSession({ id: 'session-source-hot-refresh' }, workspace as any)
    const manager = new SessionManager((_workspaceId, current) => current.workspace)
    const reloadedSessions: string[] = []
    let resolveReload!: () => void
    const reloaded = new Promise<void>(resolve => { resolveReload = resolve })

    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(managed.id, managed)
    ;(manager as unknown as {
      reloadSessionSources: (current: typeof managed) => Promise<void>
    }).reloadSessionSources = async current => {
      reloadedSessions.push(current.id)
      resolveReload()
    }

    try {
      ;(manager as unknown as {
        setProcessing: (current: typeof managed, processing: boolean) => void
      }).setProcessing(managed, true)

      await (manager as unknown as {
        reloadSourcesForWorkspace: (workspaceRootPath: string) => Promise<void>
      }).reloadSourcesForWorkspace(rootPath)

      expect(reloadedSessions).toEqual([])
      expect(managed.pendingSourceReload).toBe(true)

      ;(manager as unknown as {
        setProcessing: (current: typeof managed, processing: boolean) => void
      }).setProcessing(managed, false)

      const outcome = await Promise.race([
        reloaded.then(() => 'reloaded' as const),
        Bun.sleep(500).then(() => 'timeout' as const),
      ])

      expect(outcome).toBe('reloaded')
      expect(reloadedSessions).toEqual([managed.id])
      expect(managed.pendingSourceReload).toBe(false)
    } finally {
      manager.cleanup()
      rmSync(rootPath, { recursive: true, force: true })
    }
  })
})
