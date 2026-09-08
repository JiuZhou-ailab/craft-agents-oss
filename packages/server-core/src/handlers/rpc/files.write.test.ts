// input: File RPC handler registrations, temporary filesystem fixtures, and captured perf metrics
// output: Regression coverage for text file operations, filesystem search, and handler latency spans
// pos: Guards server-core filesystem RPC behavior at the transport boundary

import { existsSync, rmSync, chmodSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { clearMetrics, configurePerfTracking } from '@craft-agent/shared/utils'
import type { HandlerFn, RequestContext, RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import {
  HANDLED_CHANNELS,
  filterFileSearchSnapshot,
  registerFilesHandlers,
  summarizeFileSearchBatch,
} from './files'

interface CapturedPerfMetric {
  name: string
  marks: Array<{ name: string }>
  metadata?: Record<string, unknown>
}

function createFileHarness() {
  const handlers = new Map<string, HandlerFn>()

  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient() {
      return undefined
    },
  }

  const deps: HandlerDeps = {
    sessionManager: {
      withProjectLifecycle: async <T>(_projectId: string, work: () => Promise<T>): Promise<T> => work(),
    } as unknown as HandlerDeps['sessionManager'],
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
    platform: {
      appRootPath: '/',
      resourcesPath: '/',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
    },
  }

  registerFilesHandlers(server, deps)

  const readTextFile = handlers.get(RPC_CHANNELS.file.READ)
  const writeFile = handlers.get(RPC_CHANNELS.file.WRITE)
  const deleteFile = handlers.get(RPC_CHANNELS.file.DELETE)
  const createDirectory = handlers.get(RPC_CHANNELS.file.CREATE_DIRECTORY)
  const searchFiles = handlers.get(RPC_CHANNELS.fs.SEARCH)
  const searchFilesBatch = handlers.get(RPC_CHANNELS.fs.SEARCH_BATCH)
  const listWorkspaceFiles = handlers.get(RPC_CHANNELS.fs.LIST_FILES)
  if (!readTextFile || !writeFile || !deleteFile || !createDirectory || !searchFiles || !searchFilesBatch || !listWorkspaceFiles) {
    throw new Error('file handlers not registered')
  }

  const ctx: RequestContext = {
    clientId: 'client-1',
    workspaceId: null,
    webContentsId: 1,
  }

  return { readTextFile, writeFile, deleteFile, createDirectory, searchFiles, searchFilesBatch, listWorkspaceFiles, ctx }
}

function capturePerfMetrics(): CapturedPerfMetric[] {
  const metrics: CapturedPerfMetric[] = []
  configurePerfTracking({
    enabled: true,
    onMetric: metric => {
      metrics.push(metric)
    },
  })
  return metrics
}

describe('file write RPC registration', () => {
  afterEach(() => {
    configurePerfTracking({ enabled: false, onMetric: undefined })
    clearMetrics()
  })

  it('registers the workspace-scoped text write channel', () => {
    expect(HANDLED_CHANNELS).toContain('file:write')
  })

  it('registers the workspace-scoped file delete channel', () => {
    expect(HANDLED_CHANNELS).toContain('file:delete')
  })

  it('registers the workspace-scoped directory creation channel', () => {
    expect(HANDLED_CHANNELS).toContain('file:createDirectory')
  })

  it('registers the batch filesystem search channel', () => {
    expect(HANDLED_CHANNELS).toContain('fs:searchBatch')
  })

  it('registers the workspace file listing channel', () => {
    expect(HANDLED_CHANNELS).toContain('fs:listFiles')
  })

  it('records text read latency marks inside the file RPC handler', async () => {
    const { readTextFile, ctx } = createFileHarness()
    const root = await mkdtemp(join(homedir(), '.craft-file-read-'))
    const targetPath = join(root, 'story', 'outline.md')
    const metrics = capturePerfMetrics()

    try {
      await mkdir(join(root, 'story'), { recursive: true })
      await writeFile(targetPath, 'outline')

      const content = await readTextFile(ctx, targetPath) as string

      expect(content).toBe('outline')
      const metric = metrics.find(item => item.name === 'rpc.file.read')
      expect(metric).toBeDefined()
      expect(metric?.marks.map(mark => mark.name)).toEqual([
        'validate.start',
        'validate.done',
        'fs.read.start',
        'fs.read.done',
      ])
      expect(metric?.metadata).toEqual(expect.objectContaining({
        bytes: Buffer.byteLength('outline', 'utf-8'),
        extension: '.md',
        file: 'outline.md',
        status: 'ok',
      }))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects unbounded text reads before loading a large file into memory', async () => {
    const { readTextFile, ctx } = createFileHarness()
    const root = await mkdtemp(join(homedir(), '.craft-file-read-limit-'))
    const targetPath = join(root, 'episode.mp4')

    try {
      await writeFile(targetPath, '')
      await truncate(targetPath, 5 * 1024 * 1024 + 1)

      await expect(readTextFile(ctx, targetPath)).rejects.toThrow('File is too large to read as text')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('records text write latency marks inside the file RPC handler', async () => {
    const { writeFile, ctx } = createFileHarness()
    const root = await mkdtemp(join(tmpdir(), 'craft-file-write-perf-'))
    const targetPath = join(root, 'story', 'outline.md')
    const metrics = capturePerfMetrics()

    try {
      await writeFile(ctx, targetPath, 'outline')

      const metric = metrics.find(item => item.name === 'rpc.file.write')
      expect(metric).toBeDefined()
      expect(metric?.marks.map(mark => mark.name)).toEqual(['path.validated', 'file.written'])
      expect(metric?.metadata).toEqual(expect.objectContaining({
        bytes: Buffer.byteLength('outline', 'utf-8'),
        extension: '.md',
        file: 'outline.md',
        status: 'ok',
      }))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('summarizes batch filesystem search profiling metadata without scanning', () => {
    expect(summarizeFileSearchBatch('/tmp/workspace', [
      { query: '正文', options: { mode: 'path' } },
      { query: '大纲.md', options: { mode: 'path' } },
      { query: 'chapter' },
    ])).toEqual({
      requestCount: 3,
      uniqueRootCount: 1,
    })

    expect(summarizeFileSearchBatch('/tmp/workspace', [])).toEqual({
      requestCount: 0,
      uniqueRootCount: 0,
    })
  })

  it('filters a shared filesystem search snapshot for multiple fuzzy queries', () => {
    const snapshot = [
      { name: '正文', path: '/workspace/正文', type: 'directory', relativePath: '正文' },
      { name: '01.md', path: '/workspace/正文/01.md', type: 'file', relativePath: '正文/01.md' },
      { name: '大纲.md', path: '/workspace/大纲.md', type: 'file', relativePath: '大纲.md' },
    ] as const

    expect(filterFileSearchSnapshot(snapshot, '正文').map(result => result.relativePath)).toEqual([
      '正文',
      '正文/01.md',
    ])
    expect(filterFileSearchSnapshot(snapshot, '大纲').map(result => result.relativePath)).toEqual([
      '大纲.md',
    ])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports an unreadable directory instead of publishing a partial catalog', async () => {
    const { listWorkspaceFiles, ctx } = createFileHarness()
    const root = await mkdtemp(join(tmpdir(), 'craft-list-denied-'))
    const denied = join(root, 'blocked')
    await mkdir(denied)
    await writeFile(join(denied, 'chapter.md'), 'preserved content')
    chmodSync(denied, 0)
    try {
      await expect(listWorkspaceFiles(ctx, root, [])).rejects.toThrow()
    } finally {
      chmodSync(denied, 0o700)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lists known workspace roots without fuzzy search snapshots', async () => {
    const { listWorkspaceFiles, ctx } = createFileHarness()
    const root = await mkdtemp(join(tmpdir(), 'craft-file-list-'))

    try {
      await mkdir(join(root, '正文'), { recursive: true })
      await mkdir(join(root, '全局'), { recursive: true })
      await mkdir(join(root, '.craft-agent'), { recursive: true })
      await writeFile(join(root, '正文', '01.md'), 'body')
      await writeFile(join(root, '正文', '.gitkeep'), '')
      await writeFile(join(root, '全局', '大纲.md'), 'outline')
      await writeFile(join(root, '.craft-agent', 'config.json'), '{}')

      const results = await listWorkspaceFiles(ctx, root, ['正文', '全局']) as Array<{ relativePath: string; type: string }>

      const relativePaths = results.map(result => result.relativePath)
      expect(relativePaths).toEqual(['全局/大纲.md', '正文/01.md'])
      expect(results.some(result => result.relativePath.startsWith('.craft-agent/'))).toBe(false)
      expect(results.some(result => result.relativePath.endsWith('.gitkeep'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lists the real project tree when no semantic roots are supplied', async () => {
    const { listWorkspaceFiles, ctx } = createFileHarness()
    const root = await mkdtemp(join(tmpdir(), 'craft-project-tree-'))

    try {
      await mkdir(join(root, '自定义目录', '空目录'), { recursive: true })
      await mkdir(join(root, '.craft-agent'), { recursive: true })
      await mkdir(join(root, 'build'), { recursive: true })
      await writeFile(join(root, 'README.md'), 'project')
      await writeFile(join(root, '人物.md'), 'characters')
      await writeFile(join(root, '自定义目录', '线索.md'), 'clue')
      await writeFile(join(root, '.craft-agent', 'config.json'), '{}')
      await writeFile(join(root, 'build', 'generated.js'), 'generated')

      const results = await listWorkspaceFiles(ctx, root, []) as Array<{
        name: string
        path: string
        relativePath: string
        type: string
      }>

      expect(results).toEqual([
        { name: 'README.md', path: join(root, 'README.md'), relativePath: 'README.md', type: 'file' },
        { name: '人物.md', path: join(root, '人物.md'), relativePath: '人物.md', type: 'file' },
        { name: '自定义目录', path: join(root, '自定义目录'), relativePath: '自定义目录', type: 'directory' },
        { name: '空目录', path: join(root, '自定义目录', '空目录'), relativePath: '自定义目录/空目录', type: 'directory' },
        { name: '线索.md', path: join(root, '自定义目录', '线索.md'), relativePath: '自定义目录/线索.md', type: 'file' },
      ])
      expect(results.some(result => result.relativePath.startsWith('.craft-agent/'))).toBe(false)
      expect(results.some(result => result.relativePath.startsWith('build/'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lists media and structured files without treating extensions as catalog filters', async () => {
    const { listWorkspaceFiles, ctx } = createFileHarness()
    const root = await mkdtemp(join(tmpdir(), 'craft-project-media-tree-'))

    try {
      await writeFile(join(root, 'config.json'), '{}')
      await writeFile(join(root, 'poster.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      await writeFile(join(root, 'episode.mp4'), Buffer.from([0x00, 0x00, 0x00, 0x18]))

      const results = await listWorkspaceFiles(ctx, root, []) as Array<{
        relativePath: string
        type: string
      }>

      expect(results.map(result => [result.relativePath, result.type]).sort()).toEqual([
        ['config.json', 'file'],
        ['episode.mp4', 'file'],
        ['poster.png', 'file'],
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates missing parent directories before writing text files', async () => {
    const { writeFile, ctx } = createFileHarness()
    const root = await mkdtemp(join(tmpdir(), 'craft-file-write-'))
    const targetPath = join(root, 'exports', 'novel-export-test', 'manuscript.md')

    try {
      await writeFile(ctx, targetPath, 'body')

      expect(await readFile(targetPath, 'utf-8')).toBe('body')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('deletes workspace text files', async () => {
    const { deleteFile, ctx } = createFileHarness()
    const root = await mkdtemp(join(homedir(), '.craft-file-delete-'))
    const targetPath = join(root, 'story', 'new-chapter.md')

    try {
      await mkdir(join(root, 'story'), { recursive: true })
      await writeFile(targetPath, 'body')

      await deleteFile(ctx, targetPath)

      expect(existsSync(targetPath)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('recursively creates export directories before file writes', async () => {
    const { createDirectory, ctx } = createFileHarness()
    const root = await mkdtemp(join(tmpdir(), 'craft-file-dir-'))
    const exportDir = join(root, 'exports', 'novel-export-test')

    try {
      await createDirectory(ctx, exportDir)

      expect(existsSync(exportDir)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('scopes exact directory searches to the requested subtree', async () => {
    const { searchFiles, ctx } = createFileHarness()
    const root = await mkdtemp(join(tmpdir(), 'craft-file-search-'))

    try {
      await mkdir(join(root, '正文', '第一卷'), { recursive: true })
      await writeFile(join(root, '正文', '第一卷', '01.md'), 'chapter')
      await writeFile(join(root, '正文-notes.md'), 'outside')

      const results = await searchFiles(ctx, root, '正文') as Array<{ relativePath: string }>

      expect(results.map(result => result.relativePath)).toContain('正文/第一卷/01.md')
      expect(results.map(result => result.relativePath)).not.toContain('正文-notes.md')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns no fuzzy fallback results for missing path-only searches', async () => {
    const { searchFiles, ctx } = createFileHarness()
    const root = await mkdtemp(join(tmpdir(), 'craft-file-search-path-'))

    try {
      await writeFile(join(root, '正文-notes.md'), 'outside')

      const results = await searchFiles(ctx, root, '正文', { mode: 'path' }) as Array<{ relativePath: string }>

      expect(results).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('can probe an exact directory without recursively listing descendants', async () => {
    const { searchFiles, ctx } = createFileHarness()
    const root = await mkdtemp(join(tmpdir(), 'craft-file-search-probe-'))

    try {
      await mkdir(join(root, '正文', '第一卷'), { recursive: true })
      await writeFile(join(root, '正文', '第一卷', '01.md'), 'chapter')

      const results = await searchFiles(ctx, root, '正文', {
        mode: 'path',
        includeDescendants: false,
      }) as Array<{ name: string; path: string; relativePath: string; type: string }>

      expect(results).toEqual([
        { name: '正文', path: join(root, '正文'), relativePath: '正文', type: 'directory' },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lets callers raise the fuzzy search result cap for native workspace trees', async () => {
    const { searchFiles, ctx } = createFileHarness()
    const root = await mkdtemp(join(tmpdir(), 'craft-file-search-cap-'))

    try {
      for (let index = 0; index < 60; index += 1) {
        await writeFile(join(root, `file-${String(index).padStart(2, '0')}.md`), 'content')
      }

      const results = await searchFiles(ctx, root, '', { maxResults: 80 }) as Array<{ relativePath: string }>

      expect(results).toHaveLength(60)
      expect(results.map(result => result.relativePath)).toContain('file-59.md')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('batches path probes through one filesystem search handler call', async () => {
    const { searchFilesBatch, ctx } = createFileHarness()
    const root = await mkdtemp(join(tmpdir(), 'craft-file-search-batch-'))
    const metrics = capturePerfMetrics()

    try {
      await mkdir(join(root, '正文'), { recursive: true })
      await writeFile(join(root, '大纲.md'), 'outline')

      const results = await searchFilesBatch(ctx, root, [
        { query: '正文', options: { mode: 'path', includeDescendants: false } },
        { query: '大纲.md', options: { mode: 'path', includeDescendants: false } },
      ]) as Array<{ query: string; results: Array<{ relativePath: string }> }>

      expect(results.map(result => result.query)).toEqual(['正文', '大纲.md'])
      expect(results.flatMap(result => result.results.map(item => item.relativePath))).toEqual(['正文', '大纲.md'])
      const metric = metrics.find(item => item.name === 'fs.searchBatch')
      expect(metric?.metadata).toEqual(expect.objectContaining({
        requestCount: 2,
        resultCount: 2,
        snapshotEntryCount: 0,
        uniqueRootCount: 1,
      }))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('coalesces identical concurrent batch filesystem searches', async () => {
    const { searchFilesBatch, ctx } = createFileHarness()
    const root = await mkdtemp(join(tmpdir(), 'craft-file-search-coalesce-'))
    const metrics = capturePerfMetrics()
    const requests = [
      { query: '正文', options: { mode: 'path', includeDescendants: false } },
      { query: '大纲.md', options: { mode: 'path', includeDescendants: false } },
    ]

    try {
      await mkdir(join(root, '正文'), { recursive: true })
      await writeFile(join(root, '大纲.md'), 'outline')

      const [first, second] = await Promise.all([
        searchFilesBatch(ctx, root, requests),
        searchFilesBatch(ctx, root, requests),
      ]) as Array<Array<{ query: string; results: Array<{ relativePath: string }> }>>

      expect(second).toEqual(first)
      expect(metrics.filter(item => item.name === 'fs.searchBatch')).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps global batch search coalescing scoped to one client', async () => {
    const { searchFilesBatch, ctx } = createFileHarness()
    const root = await mkdtemp(join(tmpdir(), 'craft-file-search-client-scope-'))
    const metrics = capturePerfMetrics()
    const requests = [
      { query: '正文', options: { mode: 'path', includeDescendants: false } },
    ]

    try {
      await mkdir(join(root, '正文'), { recursive: true })

      await Promise.all([
        searchFilesBatch(ctx, root, requests),
        searchFilesBatch({ ...ctx, clientId: 'client-2' }, root, requests),
      ])

      expect(metrics.filter(item => item.name === 'fs.searchBatch')).toHaveLength(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not coalesce different batch filesystem search signatures', async () => {
    const { searchFilesBatch, ctx } = createFileHarness()
    const root = await mkdtemp(join(tmpdir(), 'craft-file-search-signature-'))
    const metrics = capturePerfMetrics()

    try {
      await mkdir(join(root, '正文', '第一卷'), { recursive: true })
      await writeFile(join(root, '正文', '第一卷', '01.md'), 'chapter')

      await Promise.all([
        searchFilesBatch(ctx, root, [
          { query: '正文', options: { mode: 'path', includeDescendants: false } },
        ]),
        searchFilesBatch(ctx, root, [
          { query: '正文', options: { mode: 'path', includeDescendants: true } },
        ]),
      ])

      expect(metrics.filter(item => item.name === 'fs.searchBatch')).toHaveLength(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
