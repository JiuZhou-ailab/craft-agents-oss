// input: Plain-text queries and workspace/session filesystem roots
// output: Bounded session and document content hits via ripgrep
// pos: Shared full-text search engine for workspace-owned RPC handlers

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { relative } from 'path'
import { resolveBackendHostTooling } from '@craft-agent/shared/agent/backend'
import { createScopedLogger, CONSOLE_LOGGER, type PlatformServices, type Logger } from '../runtime/platform'

export class SearchUnavailableError extends Error {
  constructor(reason: string) {
    super(`SearchUnavailableError: ${reason}`)
    this.name = 'SearchUnavailableError'
  }
}

let platform: PlatformServices | null = null
let handlerLog: Logger = createScopedLogger(CONSOLE_LOGGER, 'handler')
let searchLog: Logger = createScopedLogger(CONSOLE_LOGGER, 'search')

export function setSearchPlatform(nextPlatform: PlatformServices): void {
  platform = nextPlatform
  handlerLog = createScopedLogger(nextPlatform.logger, 'handler')
  searchLog = createScopedLogger(nextPlatform.logger, 'search')
}

export interface SearchMatch {
  sessionId: string
  lineNumber: number
  snippet: string
  matchText: string
}

export interface SessionSearchResult {
  sessionId: string
  matchCount: number
  matches: SearchMatch[]
}

export interface SearchOptions {
  timeout?: number
  maxMatchesPerSession?: number
  maxSessions?: number
  ignoreCase?: boolean
  signal?: AbortSignal
  searchId?: string
}

export interface DocumentSearchMatch {
  lineNumber: number
  snippet: string
}

export interface WorkspaceDocumentSearchResult {
  path: string
  relativePath: string
  matchCount: number
  matches: DocumentSearchMatch[]
}

export interface DocumentSearchOptions {
  timeout?: number
  maxMatchesPerFile?: number
  maxFiles?: number
  ignoreCase?: boolean
  signal?: AbortSignal
  searchId?: string
}

interface RipgrepMatchData {
  path?: { text?: string }
  lines?: { text?: string }
  line_number?: number
  submatches?: Array<{ match?: { text?: string } }>
}

function normalizeSearchQuery(query: string): string {
  const normalized = query.trim().replace(/\s+/g, ' ')
  if (normalized.length > 256) throw new Error('Search query must be 256 characters or fewer')
  return normalized
}

function getRipgrepPath(): string | undefined {
  if (!platform) throw new Error('setSearchPlatform() must be called before search')
  return resolveBackendHostTooling({
    hostRuntime: {
      appRootPath: platform.appRootPath,
      resourcesPath: platform.resourcesPath,
      isPackaged: platform.isPackaged,
    },
  }).ripgrepPath
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractSnippetFast(rawLine: string, matchText: string, maxLength = 150): string {
  try {
    const contentMatch = rawLine.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    if (contentMatch) {
      const content = contentMatch[1]
        .replace(/\\n/g, ' ')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
      return extractTextWindow(content, matchText, maxLength)
    }

    const textBlockMatch = rawLine.match(/"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    if (textBlockMatch) {
      return extractTextWindow(
        textBlockMatch[1]
          .replace(/\\n/g, ' ')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\'),
        matchText,
        maxLength,
      )
    }

    return extractTextWindow(rawLine.replace(/\\n/g, ' '), matchText, maxLength)
  } catch {
    return ''
  }
}

function extractTextWindow(text: string, matchText: string, maxLength: number): string {
  const matchPosition = text.toLowerCase().indexOf(matchText.toLowerCase())
  const start = Math.max(0, matchPosition < 0 ? 0 : matchPosition - Math.floor(maxLength / 2))
  const end = Math.min(text.length, start + maxLength)
  return `${start > 0 ? '...' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '...' : ''}`
}

async function runRipgrep(
  args: string[],
  timeout: number,
  onMatch: (data: RipgrepMatchData) => void,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const rgPath = getRipgrepPath()
  if (!rgPath || !existsSync(rgPath)) {
    throw new SearchUnavailableError(`ripgrep binary not found: ${rgPath ?? 'undefined'}`)
  }

  handlerLog.debug('[search] Running ripgrep', { rgPath, argumentCount: args.length })

  await new Promise<void>((resolve, reject) => {
    const child = spawn(rgPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let buffer = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let killHandle: ReturnType<typeof setTimeout> | undefined
    const terminate = () => {
      child.kill()
      killHandle ??= setTimeout(() => child.kill('SIGKILL'), 250)
    }

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutHandle)
      clearTimeout(killHandle)
      signal?.removeEventListener('abort', terminate)
      if (error) reject(error)
      else resolve()
    }

    const consumeLines = (flush = false) => {
      const lines = buffer.split('\n')
      buffer = flush ? '' : (lines.pop() ?? '')
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as { type?: string; data?: RipgrepMatchData }
          if (event.type === 'match' && event.data) onMatch(event.data)
        } catch (error) {
          handlerLog.debug('[search] Failed to parse ripgrep output:', error)
        }
      }
    }

    const timeoutHandle = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeout)

    signal?.addEventListener('abort', terminate, { once: true })
    if (signal?.aborted) terminate()

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      consumeLines()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', error => {
      finish(new SearchUnavailableError(`ripgrep failed to start: ${error.message}`))
    })
    child.on('close', code => {
      consumeLines(true)
      if (signal?.aborted) {
        finish(signal.reason)
      } else if (timedOut) {
        finish(new SearchUnavailableError(`Search timed out after ${timeout}ms`))
      } else if (code === 0 || code === 1) {
        finish()
      } else {
        finish(new SearchUnavailableError(
          `ripgrep exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
        ))
      }
    })
  })
}

export async function searchSessions(
  query: string,
  sessionsDir: string,
  options: SearchOptions = {},
): Promise<SessionSearchResult[]> {
  const trimmedQuery = normalizeSearchQuery(query)
  if (!trimmedQuery || !existsSync(sessionsDir)) return []

  const {
    timeout = 5000,
    maxMatchesPerSession = 3,
    maxSessions = 50,
    ignoreCase = true,
    searchId = Date.now().toString(36),
  } = options

  const startedAt = Date.now()
  const results = new Map<string, SessionSearchResult>()
  const args = [
    '--json',
    '--max-count', '10',
    '-g', '**/session.jsonl',
    ...(ignoreCase ? ['-i'] : []),
    '-e',
    `"type":"(user|assistant)".*${escapeRegex(trimmedQuery)}|${escapeRegex(trimmedQuery)}.*"type":"(user|assistant)"`,
    sessionsDir,
  ]

  searchLog.info('ripgrep:start', { searchId, queryLength: trimmedQuery.length, scope: 'sessions' })
  await runRipgrep(args, timeout, data => {
    const filePath = data.path?.text
    const lineNumber = data.line_number
    if (!filePath || !lineNumber || lineNumber === 1) return

    const pathParts = filePath.split(/[/\\]/)
    const jsonlIndex = pathParts.findIndex(part => part === 'session.jsonl')
    const sessionId = jsonlIndex > 0 ? pathParts[jsonlIndex - 1] : undefined
    const rawLine = data.lines?.text ?? ''
    if (!sessionId || rawLine.includes('"isIntermediate":true') || rawLine.includes('base64')) return

    const result = results.get(sessionId) ?? { sessionId, matchCount: 0, matches: [] }
    result.matchCount += data.submatches?.length ?? 1
    if (results.size < maxSessions && result.matches.length < maxMatchesPerSession) {
      const matchText = data.submatches?.[0]?.match?.text ?? trimmedQuery
      result.matches.push({
        sessionId,
        lineNumber,
        snippet: extractSnippetFast(rawLine, matchText),
        matchText,
      })
    }
    results.set(sessionId, result)
  }, options.signal)

  const resultArray = Array.from(results.values())
    .sort((a, b) => b.matchCount - a.matchCount)
    .slice(0, maxSessions)
  searchLog.info('ripgrep:complete', {
    searchId,
    scope: 'sessions',
    durationMs: Date.now() - startedAt,
    returnedSessions: resultArray.length,
  })
  return resultArray
}

export async function searchWorkspaceDocuments(
  query: string,
  workspaceRoot: string,
  options: DocumentSearchOptions = {},
): Promise<WorkspaceDocumentSearchResult[]> {
  const trimmedQuery = normalizeSearchQuery(query)
  if (!trimmedQuery || !existsSync(workspaceRoot)) return []

  const {
    timeout = 5000,
    maxMatchesPerFile = 3,
    maxFiles = 50,
    ignoreCase = true,
    searchId = Date.now().toString(36),
  } = options

  const startedAt = Date.now()
  const results = new Map<string, WorkspaceDocumentSearchResult>()
  const args = [
    '--json',
    '--fixed-strings',
    '--max-count', String(maxMatchesPerFile),
    '--max-filesize', '2M',
    '-g', '!node_modules/**',
    '-g', '!.git/**',
    '-g', '!dist/**',
    '-g', '!build/**',
    '-g', '!coverage/**',
    ...(ignoreCase ? ['-i'] : []),
    '--',
    trimmedQuery,
    workspaceRoot,
  ]

  searchLog.info('ripgrep:start', { searchId, queryLength: trimmedQuery.length, scope: 'documents' })
  await runRipgrep(args, timeout, data => {
    const path = data.path?.text
    const lineNumber = data.line_number
    if (!path || !lineNumber || results.size >= maxFiles && !results.has(path)) return

    const matchText = data.submatches?.[0]?.match?.text ?? trimmedQuery
    const result = results.get(path) ?? {
      path,
      relativePath: relative(workspaceRoot, path),
      matchCount: 0,
      matches: [],
    }
    result.matchCount += data.submatches?.length ?? 1
    result.matches.push({
      lineNumber,
      snippet: extractTextWindow(data.lines?.text ?? '', matchText, 180),
    })
    results.set(path, result)
  }, options.signal)

  const resultArray = Array.from(results.values())
    .sort((a, b) => b.matchCount - a.matchCount || a.relativePath.localeCompare(b.relativePath))
    .slice(0, maxFiles)
  searchLog.info('ripgrep:complete', {
    searchId,
    scope: 'documents',
    durationMs: Date.now() - startedAt,
    returnedFiles: resultArray.length,
  })
  return resultArray
}
