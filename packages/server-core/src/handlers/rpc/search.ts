// input: Runtime-scoped search requests and the active transport workspace context
// output: Typed session and document hits owned by that runtime workspace
// pos: Search RPC boundary; prevents application search from crossing runtime domains

import {
  RPC_CHANNELS,
  type WorkspaceSearchRequest,
  type WorkspaceSearchResponse,
} from '@craft-agent/shared/protocol'
import {
  getWorkspaceSessionsPath,
  resolveRuntimeWorkspaceById,
} from '@craft-agent/shared/workspaces'
import {
  SearchUnavailableError,
  searchSessions,
  searchWorkspaceDocuments,
} from '@craft-agent/server-core/services'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { resolveContextWorkspaceId } from './file-workspace-scope'

export const HANDLED_CHANNELS = [RPC_CHANNELS.search.QUERY_WORKSPACE, RPC_CHANNELS.search.CANCEL_WORKSPACE] as const

export function registerSearchHandlers(server: RpcServer, deps: HandlerDeps): void {
  const searches = new Map<string, AbortController>()
  const keyFor = (clientId: string, workspaceId: string, requestId: string) =>
    JSON.stringify([clientId, workspaceId, requestId])
  const validateRequestId = (id: unknown): id is string =>
    typeof id === 'string' && id.length > 0 && id.length <= 256

  server.handle(RPC_CHANNELS.search.CANCEL_WORKSPACE, (ctx, requestId: string) => {
    if (!validateRequestId(requestId)) throw new Error('Invalid search request ID')
    const workspaceId = resolveContextWorkspaceId(ctx, deps)
    if (workspaceId) searches.get(keyFor(ctx.clientId, workspaceId, requestId))?.abort()
  })
  server.handle(
    RPC_CHANNELS.search.QUERY_WORKSPACE,
    async (ctx, request: WorkspaceSearchRequest): Promise<WorkspaceSearchResponse> => {
      if (!request || typeof request.query !== 'string') throw new Error('Search query must be a string')
      if (request.requestId !== undefined && !validateRequestId(request.requestId)) throw new Error('Invalid search request ID')
      const query = request.query.trim()
      if (query.length < 2) return { status: 'complete', hits: [] }

      const workspaceId = resolveContextWorkspaceId(ctx, deps)
      if (!workspaceId) throw new Error('Search requires an active workspace')

      const workspace = deps.resolveRuntimeWorkspaceById?.(workspaceId) ?? resolveRuntimeWorkspaceById(workspaceId)
      if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)

      const searchId = request.requestId ?? crypto.randomUUID()
      const key = keyFor(ctx.clientId, workspaceId, searchId)
      if (searches.has(key)) throw new Error('Search request ID is already active')
      const controller = new AbortController()
      const signal = ctx.workspaceSignal
        ? AbortSignal.any([controller.signal, ctx.workspaceSignal])
        : controller.signal
      searches.set(key, controller)
      const work = [
        searchSessions(query, getWorkspaceSessionsPath(workspace.rootPath), { searchId, signal }),
        searchWorkspaceDocuments(query, workspace.rootPath, { searchId, signal }),
        Promise.resolve().then(() => deps.sessionManager.getSessions(workspace.id)),
      ] as const
      try {
        const [sessionResults, documentResults, sessions] = await Promise.all(work)
        signal.throwIfAborted()
        const hiddenSessionIds = new Set(sessions.filter(session => session.hidden).map(session => session.id))

        return {
          status: 'complete',
          hits: [
            ...sessionResults
              .filter(result => !hiddenSessionIds.has(result.sessionId))
              .map(result => ({
                kind: 'session' as const,
                sessionId: result.sessionId,
                matchCount: result.matchCount,
                snippet: result.matches[0]?.snippet ?? '',
              })),
            ...documentResults.map(result => ({
              kind: 'document' as const,
              path: result.path,
              relativePath: result.relativePath,
              lineNumber: result.matches[0]?.lineNumber ?? 1,
              matchCount: result.matchCount,
              snippet: result.matches[0]?.snippet ?? '',
            })),
          ],
        }
      } catch (error) {
        if (signal.aborted) return { status: 'cancelled', hits: [] }
        if (error instanceof SearchUnavailableError) {
          deps.platform.logger.warn('[search] Workspace search unavailable', {
            workspaceId,
            searchId,
            reason: error.message,
          })
          return { status: 'unavailable', hits: [], message: error.message }
        }
        throw error
      } finally {
        // Stop a sibling scan on failure as well; no scan outlives this request.
        controller.abort()
        await Promise.allSettled(work)
        if (searches.get(key) === controller) searches.delete(key)
      }
    },
  )
}
