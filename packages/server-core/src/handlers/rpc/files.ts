// input: RPC request context, workspace file paths, attachments, and filesystem search queries
// output: Registered file read/write, attachment, directory, and search RPC handlers
// pos: Server-side filesystem boundary for renderer and remote clients

import { readFile, writeFile, unlink, mkdir, readdir, stat } from 'fs/promises'
import { isAbsolute, join, resolve, dirname, parse as parsePath } from 'path'
import { homedir } from 'os'
import { validatePathFormat } from '../../utils/path-validation'
import { randomUUID } from 'crypto'
import {
  RPC_CHANNELS,
  type DirectoryListingResult,
  type FileAttachment,
  type FileSearchBatchRequest,
  type FileSearchBatchResult,
  type FileSearchOptions,
  type StoreAttachmentResult,
} from '@craft-agent/shared/protocol'
import { readFileAttachment, perf } from '@craft-agent/shared/utils'
import { validateSessionId } from '@craft-agent/shared/sessions'
import { storeAttachmentFiles } from '@craft-agent/server-core/services'
import { sanitizeFilename } from '@craft-agent/server-core/handlers'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { requestClientOpenFileDialog } from '@craft-agent/server-core/transport'
import {
  resolveContextWorkspaceId,
  validateWorkspaceFilePath,
  validateWorkspaceMutationPath,
  validateWorkspaceSearchBasePath,
  withWorkspaceMutation,
} from './file-workspace-scope'
import { notifyConfigWatcherForWrite } from './workspace-file-effects'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.file.READ,
  RPC_CHANNELS.file.WRITE,
  RPC_CHANNELS.file.DELETE,
  RPC_CHANNELS.file.CREATE_DIRECTORY,
  RPC_CHANNELS.file.READ_DATA_URL,
  RPC_CHANNELS.file.READ_PREVIEW_DATA_URL,
  RPC_CHANNELS.file.READ_BINARY,
  RPC_CHANNELS.file.OPEN_DIALOG,
  RPC_CHANNELS.file.READ_ATTACHMENT,
  RPC_CHANNELS.file.READ_USER_ATTACHMENT,
  RPC_CHANNELS.file.STORE_ATTACHMENT,
  RPC_CHANNELS.file.GENERATE_THUMBNAIL,
  RPC_CHANNELS.fs.SEARCH,
  RPC_CHANNELS.fs.SEARCH_BATCH,
  RPC_CHANNELS.fs.LIST_FILES,
  RPC_CHANNELS.fs.LIST_DIRECTORY,
] as const

type FileSearchEntry = {
  name: string
  path: string
  type: 'file' | 'directory'
  relativePath: string
}

const FILE_SEARCH_MAX_RESULTS = 50
const FILE_SEARCH_BATCH_MAX_ENTRIES = 5000
const FILE_LIST_MAX_ROOTS = 64
const FILE_LIST_MAX_ENTRIES = 5000
// ponytail: Text reads are whole-buffer; use a streaming/chunked reader before raising this ceiling.
const TEXT_FILE_READ_MAX_BYTES = 5 * 1024 * 1024
const inFlightFileSearches = new Map<string, Promise<FileSearchEntry[]>>()
const inFlightFileSearchBatches = new Map<string, Promise<FileSearchBatchResult[]>>()

const FILE_SEARCH_SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build',
  '.next', '.nuxt', '.cache', '__pycache__', 'vendor',
  '.idea', '.vscode', 'coverage', '.nyc_output', '.turbo', 'out',
])

export type FileSearchBatchSummary = {
  requestCount: number
  uniqueRootCount: number
}

export function summarizeFileSearchBatch(
  basePath: string,
  requests: FileSearchBatchRequest[],
): FileSearchBatchSummary {
  return {
    requestCount: requests.length,
    uniqueRootCount: requests.length > 0 && basePath.trim() ? 1 : 0,
  }
}

function getFileSearchBatchKey(scope: string, basePath: string, requests: FileSearchBatchRequest[]): string {
  return JSON.stringify([scope, basePath, requests.map(({ query, options }) => [
    query,
    options?.mode ?? null,
    options?.includeDescendants ?? null,
    options?.maxResults ?? null,
  ])])
}

function getFileSearchKey(scope: string, basePath: string, query: string, options?: FileSearchOptions): string {
  return JSON.stringify([
    scope,
    basePath,
    query,
    options?.mode ?? null,
    options?.includeDescendants ?? null,
    options?.maxResults ?? null,
  ])
}

export function filterFileSearchSnapshot(
  entries: readonly FileSearchEntry[],
  query: string,
  maxResults = FILE_SEARCH_MAX_RESULTS,
): FileSearchEntry[] {
  const lowerQuery = query.toLowerCase()
  const results = entries.filter((entry) => {
    const lowerName = entry.name.toLowerCase()
    const lowerRelative = entry.relativePath.toLowerCase()
    return lowerName.includes(lowerQuery) || lowerRelative.includes(lowerQuery)
  }).slice(0, maxResults)

  results.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.length - b.name.length
  })

  return results
}

function resolveFileSearchMaxResults(options?: FileSearchOptions): number {
  const requested = options?.maxResults
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return FILE_SEARCH_MAX_RESULTS

  return Math.min(Math.max(1, Math.floor(requested)), FILE_SEARCH_BATCH_MAX_ENTRIES)
}

function isPathInsideRoot(path: string, rootPath: string): boolean {
  return path === rootPath || path.startsWith(`${rootPath}/`)
}

function isWorkspaceAccessError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('outside current workspace')
}

function normalizeSearchPathQuery(query: string): string | null {
  const normalized = query.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!normalized || normalized.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    return null
  }
  return normalized
}

async function collectDirectPathSearchResults(
  basePath: string,
  query: string,
  maxResults: number,
  skipDirs: Set<string>,
  includeDescendants = true
): Promise<FileSearchEntry[] | null> {
  const normalizedQuery = normalizeSearchPathQuery(query)
  if (!normalizedQuery) return null

  const resolvedBasePath = resolve(basePath).replace(/\\/g, '/').replace(/\/+$/, '')
  const directPath = resolve(basePath, normalizedQuery).replace(/\\/g, '/')
  if (!isPathInsideRoot(directPath, resolvedBasePath)) return null

  let directStat: Awaited<ReturnType<typeof stat>>
  try {
    directStat = await stat(directPath)
  } catch {
    return null
  }

  const directName = parsePath(directPath).base
  if (!directStat.isDirectory()) {
    return [{
      name: directName,
      path: directPath,
      type: 'file',
      relativePath: normalizedQuery,
    }]
  }

  const results: FileSearchEntry[] = [{
    name: directName,
    path: directPath,
    type: 'directory',
    relativePath: normalizedQuery,
  }]
  if (!includeDescendants) return results

  let queue = ['']

  while (queue.length > 0 && results.length < maxResults) {
    const nextQueue: string[] = []
    const dirResults = await Promise.all(
      queue.map(async (relDir) => {
        const absDir = relDir ? join(directPath, relDir) : directPath
        try {
          return { relDir, entries: await readdir(absDir, { withFileTypes: true }) }
        } catch {
          return { relDir, entries: [] as import('fs').Dirent[] }
        }
      })
    )

    for (const { relDir, entries } of dirResults) {
      if (results.length >= maxResults) break

      for (const entry of entries) {
        if (results.length >= maxResults) break

        const name = entry.name
        if (name.startsWith('.') || skipDirs.has(name)) continue

        const childRelativeToDirect = relDir ? `${relDir}/${name}` : name
        const relativePath = `${normalizedQuery}/${childRelativeToDirect}`
        const isDir = entry.isDirectory()

        if (isDir) {
          nextQueue.push(childRelativeToDirect)
        }

        results.push({
          name,
          path: join(directPath, childRelativeToDirect),
          type: isDir ? 'directory' : 'file',
          relativePath,
        })
      }
    }

    queue = nextQueue
  }

  return results
}

function pushFileListEntry(entries: FileSearchEntry[], seenPaths: Set<string>, entry: FileSearchEntry): void {
  if (seenPaths.has(entry.path)) return
  seenPaths.add(entry.path)
  entries.push(entry)
}

async function collectWorkspaceFileList(
  basePath: string,
  rootPaths: readonly string[],
  maxEntries = FILE_LIST_MAX_ENTRIES,
): Promise<FileSearchEntry[]> {
  const entries: FileSearchEntry[] = []
  const seenPaths = new Set<string>()
  const coveredRoots: string[] = []
  const resolvedBasePath = resolve(basePath).replace(/\\/g, '/').replace(/\/+$/, '')

  const requestedRoots = rootPaths.length > 0
    ? rootPaths.slice(0, FILE_LIST_MAX_ROOTS)
    : ['']

  for (const rawRootPath of requestedRoots) {
    if (entries.length >= maxEntries) break

    const normalizedRoot = rawRootPath === '' ? '' : normalizeSearchPathQuery(rawRootPath)
    if (normalizedRoot === null) continue
    if (coveredRoots.some(root => normalizedRoot === root || normalizedRoot.startsWith(`${root}/`))) continue
    coveredRoots.push(normalizedRoot)

    const rootPath = normalizedRoot
      ? resolve(basePath, normalizedRoot).replace(/\\/g, '/')
      : resolvedBasePath
    if (!isPathInsideRoot(rootPath, resolvedBasePath)) continue

    let rootStat: Awaited<ReturnType<typeof stat>>
    try {
      rootStat = await stat(rootPath)
    } catch (error) {
      if (normalizedRoot !== '' && (error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }

    const rootName = parsePath(rootPath).base
    if (!rootStat.isDirectory()) {
      pushFileListEntry(entries, seenPaths, {
        name: rootName,
        path: rootPath,
        type: 'file',
        relativePath: normalizedRoot,
      })
      continue
    }

    let queue = ['']
    while (queue.length > 0 && entries.length < maxEntries) {
      const nextQueue: string[] = []

      for (const relDir of queue) {
        if (entries.length >= maxEntries) break

        const absDir = relDir ? join(rootPath, relDir) : rootPath
        let dirEntries: import('fs').Dirent[]
        try {
          dirEntries = await readdir(absDir, { withFileTypes: true })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' && relDir) continue
          throw error
        }

        for (const entry of dirEntries) {
          if (entries.length >= maxEntries) break

          const name = entry.name
          if (name.startsWith('.') || FILE_SEARCH_SKIP_DIRS.has(name)) continue

          const childRelativeToRoot = relDir ? `${relDir}/${name}` : name
          const relativePath = normalizedRoot
            ? `${normalizedRoot}/${childRelativeToRoot}`
            : childRelativeToRoot
          const isDir = entry.isDirectory()

          if (isDir) {
            nextQueue.push(childRelativeToRoot)
            if (normalizedRoot === '') {
              pushFileListEntry(entries, seenPaths, {
                name,
                path: join(rootPath, childRelativeToRoot),
                type: 'directory',
                relativePath,
              })
            }
            continue
          }

          pushFileListEntry(entries, seenPaths, {
            name,
            path: join(rootPath, childRelativeToRoot),
            type: 'file',
            relativePath,
          })
        }
      }

      queue = nextQueue
    }
  }

  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true, sensitivity: 'base' }))
  return entries
}

async function searchFilesInBase(
  basePath: string,
  query: string,
  options?: FileSearchOptions
): Promise<FileSearchEntry[]> {
  const lowerQuery = query.toLowerCase()
  const results: FileSearchEntry[] = []
  const maxResults = resolveFileSearchMaxResults(options)

  const directPathResults = await collectDirectPathSearchResults(
    basePath,
    query,
    maxResults,
    FILE_SEARCH_SKIP_DIRS,
    options?.includeDescendants !== false
  )
  if (directPathResults) return directPathResults
  if (options?.mode === 'path') return []

  let queue = ['']

  while (queue.length > 0 && results.length < maxResults) {
    const nextQueue: string[] = []

    const dirResults = await Promise.all(
      queue.map(async (relDir) => {
        const absDir = relDir ? join(basePath, relDir) : basePath
        try {
          return { relDir, entries: await readdir(absDir, { withFileTypes: true }) }
        } catch {
          return { relDir, entries: [] as import('fs').Dirent[] }
        }
      })
    )

    for (const { relDir, entries } of dirResults) {
      if (results.length >= maxResults) break

      for (const entry of entries) {
        if (results.length >= maxResults) break

        const name = entry.name
        if (name.startsWith('.') || FILE_SEARCH_SKIP_DIRS.has(name)) continue

        const relativePath = relDir ? `${relDir}/${name}` : name
        const isDir = entry.isDirectory()

        if (isDir) {
          nextQueue.push(relativePath)
        }

        const lowerName = name.toLowerCase()
        const lowerRelative = relativePath.toLowerCase()
        if (lowerName.includes(lowerQuery) || lowerRelative.includes(lowerQuery)) {
          results.push({
            name,
            path: join(basePath, relativePath),
            type: isDir ? 'directory' : 'file',
            relativePath,
          })
        }
      }
    }

    queue = nextQueue
  }

  results.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.length - b.name.length
  })

  return results
}

async function collectFileSearchSnapshot(
  basePath: string,
  maxEntries: number,
  skipDirs: Set<string>,
): Promise<FileSearchEntry[]> {
  const entries: FileSearchEntry[] = []
  let queue = ['']

  while (queue.length > 0 && entries.length < maxEntries) {
    const nextQueue: string[] = []

    const dirResults = await Promise.all(
      queue.map(async (relDir) => {
        const absDir = relDir ? join(basePath, relDir) : basePath
        try {
          return { relDir, entries: await readdir(absDir, { withFileTypes: true }) }
        } catch {
          return { relDir, entries: [] as import('fs').Dirent[] }
        }
      })
    )

    for (const { relDir, entries: dirEntries } of dirResults) {
      if (entries.length >= maxEntries) break

      for (const entry of dirEntries) {
        if (entries.length >= maxEntries) break

        const name = entry.name
        if (name.startsWith('.') || skipDirs.has(name)) continue

        const relativePath = relDir ? `${relDir}/${name}` : name
        const isDir = entry.isDirectory()

        if (isDir) {
          nextQueue.push(relativePath)
        }

        entries.push({
          name,
          path: join(basePath, relativePath),
          type: isDir ? 'directory' : 'file',
          relativePath,
        })
      }
    }

    queue = nextQueue
  }

  return entries
}

export function registerFilesHandlers(server: RpcServer, deps: HandlerDeps): void {
  // Read a file (with path validation to prevent traversal attacks)
  server.handle(RPC_CHANNELS.file.READ, async (ctx, path: string) => {
    const workspaceId = resolveContextWorkspaceId(ctx, deps)
    const readSpan = perf.span('rpc.file.read', { workspaceId: workspaceId ?? null })

    try {
      readSpan.mark('validate.start')
      const safePath = await validateWorkspaceFilePath(ctx, deps, path)
      readSpan.mark('validate.done')
      const parsedPath = parsePath(safePath)
      readSpan.setMetadata('file', parsedPath.base)
      readSpan.setMetadata('extension', parsedPath.ext || null)
      const fileStats = await stat(safePath)
      if (fileStats.size > TEXT_FILE_READ_MAX_BYTES) {
        throw new Error(
          `File is too large to read as text (${Math.ceil(fileStats.size / 1024 / 1024)}MB > ${TEXT_FILE_READ_MAX_BYTES / 1024 / 1024}MB limit)`,
        )
      }
      readSpan.mark('fs.read.start')
      const content = await readFile(safePath, 'utf-8')
      readSpan.mark('fs.read.done')
      readSpan.setMetadata('status', 'ok')
      readSpan.setMetadata('bytes', Buffer.byteLength(content, 'utf-8'))
      return content
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      readSpan.setMetadata('status', 'error')
      readSpan.setMetadata('errorCode', error instanceof Error && 'code' in error
        ? (error as NodeJS.ErrnoException).code
        : null)
      // ENOENT is expected for optional config files (e.g. automations.json)
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        deps.platform.logger.debug('readFile: file not found:', path)
      } else {
        deps.platform.logger.error('readFile error:', path, message)
      }
      throw new Error(`Failed to read file: ${message}`)
    } finally {
      readSpan.end()
    }
  })

  server.handle(RPC_CHANNELS.file.WRITE, async (ctx, path: string, content: string) => {
    const workspaceId = resolveContextWorkspaceId(ctx, deps)
    const writeSpan = perf.span('rpc.file.write', { workspaceId: workspaceId ?? null })

    try {
      if (typeof content !== 'string') {
        throw new Error('File content must be a string')
      }
      await withWorkspaceMutation(ctx, deps, async (currentWorkspaceId, scopedContext) => {
        const safePath = await validateWorkspaceMutationPath(scopedContext, deps, path)
        const parsedPath = parsePath(safePath)
        writeSpan.setMetadata('file', parsedPath.base)
        writeSpan.setMetadata('extension', parsedPath.ext || null)
        writeSpan.mark('path.validated')
        await mkdir(dirname(safePath), { recursive: true })
        await writeFile(safePath, content, 'utf-8')
        writeSpan.mark('file.written')
        writeSpan.setMetadata('status', 'ok')
        writeSpan.setMetadata('bytes', Buffer.byteLength(content, 'utf-8'))
        notifyConfigWatcherForWrite(deps, currentWorkspaceId, safePath)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      writeSpan.setMetadata('status', 'error')
      deps.platform.logger.error('writeFile error:', path, message)
      throw new Error(`Failed to write file: ${message}`)
    } finally {
      writeSpan.end()
    }
  })

  server.handle(RPC_CHANNELS.file.DELETE, async (ctx, path: string) => {
    try {
      await withWorkspaceMutation(ctx, deps, async (workspaceId, scopedContext) => {
        const safePath = await validateWorkspaceMutationPath(scopedContext, deps, path)
        await unlink(safePath)
        notifyConfigWatcherForWrite(deps, workspaceId, safePath)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('deleteFile error:', path, message)
      throw new Error(`Failed to delete file: ${message}`)
    }
  })

  server.handle(RPC_CHANNELS.file.CREATE_DIRECTORY, async (ctx, path: string) => {
    try {
      await withWorkspaceMutation(ctx, deps, async (_workspaceId, scopedContext) => {
        const safePath = await validateWorkspaceMutationPath(scopedContext, deps, path)
        await mkdir(safePath, { recursive: true })
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('createDirectory error:', path, message)
      throw new Error(`Failed to create directory: ${message}`)
    }
  })

  // Read an image file as a data URL for in-app image preview overlays.
  // Returns data:{mime};base64,{content} — used by ImagePreviewOverlay and markdown image blocks.
  server.handle(RPC_CHANNELS.file.READ_DATA_URL, async (ctx, path: string) => {
    try {
      const safePath = await validateWorkspaceFilePath(ctx, deps, path)
      const buffer = await readFile(safePath)
      const ext = safePath.split('.').pop()?.toLowerCase() ?? ''

      // Map previewable image extensions to MIME types.
      // HEIC/HEIF/TIFF are intentionally excluded — no Chromium codec, opened externally instead.
      const mimeMap: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        svg: 'image/svg+xml',
        bmp: 'image/bmp',
        ico: 'image/x-icon',
        avif: 'image/avif',
      }
      const mime = mimeMap[ext] || 'application/octet-stream'
      const base64 = buffer.toString('base64')
      return `data:${mime};base64,${base64}`
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('readFileDataUrl error:', message)
      throw new Error(`Failed to read file as data URL: ${message}`)
    }
  })

  // Read an image file as a small preview data URL for lightweight thumbnail rendering.
  // Returns a PNG data URL resized to fit within maxSize×maxSize.
  server.handle(RPC_CHANNELS.file.READ_PREVIEW_DATA_URL, async (ctx, path: string, maxSize = 64) => {
    try {
      const safePath = await validateWorkspaceFilePath(ctx, deps, path)
      const size = Number.isFinite(maxSize) ? Math.max(16, Math.min(256, Math.floor(maxSize))) : 64
      const preview = await deps.platform.imageProcessor.process(safePath, {
        resize: { width: size, height: size },
        fit: 'inside',
        format: 'png',
      })
      return `data:image/png;base64,${preview.toString('base64')}`
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('readFilePreviewDataUrl error:', message)
      throw new Error(`Failed to read file preview: ${message}`)
    }
  })

  // Read a file as raw binary (Uint8Array) for react-pdf.
  // The WS transport codec preserves Uint8Array payloads over JSON envelopes.
  server.handle(RPC_CHANNELS.file.READ_BINARY, async (ctx, path: string) => {
    try {
      const safePath = await validateWorkspaceFilePath(ctx, deps, path)
      const buffer = await readFile(safePath)
      // Return as Uint8Array (serializes to ArrayBuffer over IPC)
      return new Uint8Array(buffer)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('readFileBinary error:', message)
      throw new Error(`Failed to read file as binary: ${message}`)
    }
  })

  // Open native file dialog for selecting files to attach (routed to client)
  server.handle(RPC_CHANNELS.file.OPEN_DIALOG, async (ctx) => {
    const result = await requestClientOpenFileDialog(server, ctx.clientId, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        // Allow all files by default - the agent can figure out how to handle them
        { name: 'All Files', extensions: ['*'] },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'] },
        { name: 'Documents', extensions: ['pdf', 'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'txt', 'md', 'rtf'] },
        { name: 'Code', extensions: ['js', 'ts', 'tsx', 'jsx', 'py', 'json', 'css', 'html', 'xml', 'yaml', 'yml', 'sh', 'sql', 'go', 'rs', 'rb', 'php', 'java', 'c', 'cpp', 'h', 'swift', 'kt'] },
      ]
    })
    return result.canceled ? [] : result.filePaths
  })

  // Read file and return as FileAttachment with Quick Look thumbnail
  server.handle(RPC_CHANNELS.file.READ_ATTACHMENT, async (ctx, path: string) => {
    try {
      const safePath = await validateWorkspaceFilePath(ctx, deps, path)
      // Use shared utility that handles file type detection, encoding, etc.
      const attachment = await readFileAttachment(safePath)
      if (!attachment) return null

      // Generate thumbnail for image preview
      // Only works for image formats the processor supports — PDFs/Office files get icon fallback
      try {
        const thumbBuffer = await deps.platform.imageProcessor.process(safePath, {
          resize: { width: 200, height: 200 },
          format: 'png',
        })
        ;(attachment as { thumbnailBase64?: string }).thumbnailBase64 = thumbBuffer.toString('base64')
      } catch (thumbError) {
        // Thumbnail generation failed (non-image file or corrupt) — icon fallback
        deps.platform.logger.info('Thumbnail generation failed (using fallback):', thumbError instanceof Error ? thumbError.message : thumbError)
      }

      return attachment
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('readFileAttachment error:', message)
      return null
    }
  })

  // Read a user-attached file (bypasses workspace-dir validation).
  // Used only by renderer draft hydration: the path was written to drafts.json by a
  // previous user-initiated OS-picker / Finder-drag attach, so the path implies consent.
  // NOT exposed to agent code — no equivalent MCP tool. Kept separate from readFileAttachment
  // on purpose to preserve the agent-facing read's narrow trust boundary.
  const USER_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024
  server.handle(RPC_CHANNELS.file.READ_USER_ATTACHMENT, async (_ctx, path: string) => {
    try {
      if (!path || typeof path !== 'string' || !isAbsolute(path)) return null
      const info = await stat(path).catch(() => null)
      if (!info || !info.isFile()) return null
      if (info.size > USER_ATTACHMENT_MAX_BYTES) {
        deps.platform.logger.warn(`[readUserAttachment] file exceeds ${USER_ATTACHMENT_MAX_BYTES} bytes, skipping: ${path}`)
        return null
      }
      const attachment = readFileAttachment(path)
      if (!attachment) return null
      try {
        const thumbBuffer = await deps.platform.imageProcessor.process(path, {
          resize: { width: 200, height: 200 },
          format: 'png',
        })
        ;(attachment as { thumbnailBase64?: string }).thumbnailBase64 = thumbBuffer.toString('base64')
      } catch {
        // Non-image or corrupt — icon fallback, same as readFileAttachment
      }
      return attachment
    } catch (error) {
      deps.platform.logger.error('readUserAttachment error:', error instanceof Error ? error.message : error)
      return null
    }
  })

  // Generate thumbnail from base64 data (for drag-drop files where we don't have a path)
  server.handle(RPC_CHANNELS.file.GENERATE_THUMBNAIL, async (_ctx, base64: string, _mimeType: string): Promise<string | null> => {
    try {
      const buffer = Buffer.from(base64, 'base64')
      const thumbBuffer = await deps.platform.imageProcessor.process(buffer, {
        resize: { width: 200, height: 200 },
        format: 'png',
      })
      return thumbBuffer.toString('base64')
    } catch (error) {
      deps.platform.logger.info('generateThumbnail failed:', error instanceof Error ? error.message : error)
      return null
    }
  })

  // Validate session ownership before delegating byte storage and derivation.
  server.handle(RPC_CHANNELS.file.STORE_ATTACHMENT, async (ctx, sessionId: string, attachment: FileAttachment): Promise<StoreAttachmentResult> => {
    try {
      if (attachment.size === 0) {
        throw new Error('Cannot attach empty file')
      }

      validateSessionId(sessionId)
      return await deps.sessionManager.withSessionPathOperation(sessionId, async sessionPath => {
        await validateWorkspaceFilePath(ctx, deps, sessionPath)

        const attachmentsDir = await validateWorkspaceMutationPath(
          ctx,
          deps,
          join(sessionPath, 'attachments'),
        )
        await mkdir(attachmentsDir, { recursive: true })
        return storeAttachmentFiles({
          attachment,
          attachmentsDir,
          id: randomUUID(),
          safeName: sanitizeFilename(attachment.name),
          validateWritePath: path => validateWorkspaceMutationPath(ctx, deps, path),
          imageProcessor: deps.platform.imageProcessor,
          logger: deps.platform.logger,
        })
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger.error('storeAttachment error:', message)
      throw new Error(`Failed to store attachment: ${message}`)
    }
  })

  // Filesystem search for @ mention file selection.
  // Parallel BFS walk that skips ignored directories BEFORE entering them,
  // avoiding reading node_modules/etc. contents entirely. Uses withFileTypes
  // to get entry types without separate stat calls.
  server.handle(RPC_CHANNELS.fs.SEARCH, async (ctx, basePath: string, query: string, options?: FileSearchOptions) => {
    deps.platform.logger.info('[FS_SEARCH] called:', basePath, query)

    try {
      const safeBasePath = await validateWorkspaceSearchBasePath(ctx, deps, basePath)
      const searchScope = resolveContextWorkspaceId(ctx, deps) ?? `client:${ctx.clientId}`
      const searchKey = getFileSearchKey(searchScope, safeBasePath, query, options)
      const inFlight = inFlightFileSearches.get(searchKey)
      if (inFlight) return await inFlight

      const searchPromise = searchFilesInBase(safeBasePath, query, options)
        .finally(() => {
          inFlightFileSearches.delete(searchKey)
        })
      inFlightFileSearches.set(searchKey, searchPromise)
      const results = await searchPromise
      deps.platform.logger.info('[FS_SEARCH] returning', results.length, 'results')
      return results
    } catch (err) {
      deps.platform.logger.error('[FS_SEARCH] error:', err)
      if (isWorkspaceAccessError(err)) throw err
      return []
    }
  })

  server.handle(RPC_CHANNELS.fs.SEARCH_BATCH, async (ctx, basePath: string, requests: FileSearchBatchRequest[]): Promise<FileSearchBatchResult[]> => {
    const safeRequests = Array.isArray(requests) ? requests.slice(0, 100) : []
    const fuzzyRequests = safeRequests.filter((request) => request.options?.mode !== 'path')
    deps.platform.logger.debug('[FS_SEARCH_BATCH] called:', basePath, safeRequests.length)

    const safeBasePath = await validateWorkspaceSearchBasePath(ctx, deps, basePath)
    const batchScope = resolveContextWorkspaceId(ctx, deps) ?? `client:${ctx.clientId}`
    const batchKey = getFileSearchBatchKey(batchScope, safeBasePath, safeRequests)
    const inFlight = inFlightFileSearchBatches.get(batchKey)
    if (inFlight) return inFlight

    const searchPromise = (async () => {
      const searchSummary = summarizeFileSearchBatch(safeBasePath, safeRequests)
      const searchSpan = perf.span('fs.searchBatch', {
        basePath: safeBasePath,
        requestCount: searchSummary.requestCount,
        uniqueRootCount: searchSummary.uniqueRootCount,
      })
      try {
        const snapshot = fuzzyRequests.length > 0
          ? await collectFileSearchSnapshot(safeBasePath, FILE_SEARCH_BATCH_MAX_ENTRIES, FILE_SEARCH_SKIP_DIRS)
          : []
        if (fuzzyRequests.length > 0) {
          searchSpan.mark('snapshot.collected')
        }
        searchSpan.setMetadata('snapshotEntryCount', snapshot.length)

        const resultSets = await Promise.all(
          safeRequests.map(async (request) => {
            try {
              const directPathResults = await collectDirectPathSearchResults(
                safeBasePath,
                request.query,
                resolveFileSearchMaxResults(request.options),
                FILE_SEARCH_SKIP_DIRS,
                request.options?.includeDescendants !== false
              )
              if (directPathResults) {
                return {
                  query: request.query,
                  results: directPathResults,
                }
              }
              if (request.options?.mode === 'path') {
                return {
                  query: request.query,
                  results: [],
                }
              }
              return {
                query: request.query,
                results: filterFileSearchSnapshot(snapshot, request.query, resolveFileSearchMaxResults(request.options)),
              }
            } catch (err) {
              deps.platform.logger.error('[FS_SEARCH_BATCH] query error:', request.query, err)
              return {
                query: request.query,
                results: [],
              }
            }
          })
        )

        searchSpan.setMetadata('resultCount', resultSets.reduce((count, resultSet) => count + resultSet.results.length, 0))
        return resultSets
      } finally {
        searchSpan.end()
      }
    })()

    inFlightFileSearchBatches.set(batchKey, searchPromise)
    try {
      return await searchPromise
    } finally {
      inFlightFileSearchBatches.delete(batchKey)
    }
  })

  // Purpose-built workspace listing. Passing no roots lists the real project tree
  // (files plus directories); named roots preserve the legacy file-only fallback.
  server.handle(RPC_CHANNELS.fs.LIST_FILES, async (ctx, basePath: string, rootPaths: string[]): Promise<FileSearchEntry[]> => {
    const safeRootPaths = Array.isArray(rootPaths) ? rootPaths.slice(0, FILE_LIST_MAX_ROOTS) : []
    deps.platform.logger.debug('[FS_LIST_FILES] called:', basePath, safeRootPaths.length)

    const safeBasePath = await validateWorkspaceSearchBasePath(ctx, deps, basePath)
    const listSpan = perf.span('fs.listFiles', {
      basePath: safeBasePath,
      rootCount: safeRootPaths.length,
    })

    try {
      const results = await collectWorkspaceFileList(safeBasePath, safeRootPaths)
      listSpan.setMetadata('resultCount', results.length)
      return results
    } finally {
      listSpan.end()
    }
  })

  // List directories in a given path (for remote directory browsing).
  // Returns only directories (not files) — this is a folder picker.
  server.handle(RPC_CHANNELS.fs.LIST_DIRECTORY, async (_ctx, dirPath: string) => {
    // Resolve ~ to server's home directory (thin clients don't know the server's home)
    if (dirPath === '~' || dirPath.startsWith('~/')) {
      dirPath = dirPath === '~' ? homedir() : join(homedir(), dirPath.slice(2))
    }

    // Reject cross-platform and relative paths before resolve() can concatenate with cwd
    const pathCheck = validatePathFormat(dirPath)
    if (!pathCheck.valid) {
      throw new Error(pathCheck.reason!)
    }

    // Normalize (collapses .. segments, trailing slashes, etc.)
    const resolved = resolve(dirPath)

    // Read entries, filter to directories
    const raw = await readdir(resolved, { withFileTypes: true })

    const entries: Array<{ name: string; path: string; isSymlink: boolean }> = []
    for (const entry of raw) {
      const fullPath = join(resolved, entry.name)
      const isSymlink = entry.isSymbolicLink()

      if (entry.isDirectory()) {
        entries.push({ name: entry.name, path: fullPath, isSymlink: false })
      } else if (isSymlink) {
        // Follow symlink — check if target is a directory
        try {
          const target = await stat(fullPath)
          if (target.isDirectory()) {
            entries.push({ name: entry.name, path: fullPath, isSymlink: true })
          }
        } catch {
          // Broken symlink — skip silently
        }
      }
    }

    // Sort alphabetically (case-insensitive), cap at 500
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    const totalEntries = entries.length
    const truncated = totalEntries > 500
    if (truncated) entries.length = 500

    // Compute parent path
    const parentPath = resolved === parsePath(resolved).root ? null : dirname(resolved)

    // Compute breadcrumbs server-side
    const breadcrumbs: Array<{ name: string; path: string }> = []
    let current = resolved
    while (true) {
      const parsed = parsePath(current)
      const name = parsed.base || parsed.root
      breadcrumbs.unshift({ name, path: current })
      if (current === parsed.root) break
      current = dirname(current)
    }

    return {
      currentPath: resolved,
      parentPath,
      breadcrumbs,
      platform: process.platform as DirectoryListingResult['platform'],
      truncated,
      totalEntries,
      entries,
    } satisfies DirectoryListingResult
  })
}
