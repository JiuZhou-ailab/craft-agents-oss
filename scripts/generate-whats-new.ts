// input: Git commit history or commit metadata JSON plus optional OpenAI credentials
// output: Generated release-note markdown and What's New manifest files
// pos: Release-time generator that turns developer commits into user-facing update notes

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs as parseNodeArgs } from 'node:util'
import {
  buildWhatsNewDraft,
  createWhatsNewDigest,
  deriveWhatsNewAccentColor,
  extractWhatsNewHighlights,
  isUserVisibleCommit,
  type WhatsNewCommit,
  type WhatsNewDraft,
} from '../packages/shared/src/release-notes/whats-new.ts'

interface CliOptions {
  version: string
  commitsJson?: string
  outDir: string
  outJson?: string
  from?: string
  to: string
  limit: number
  curatedNotes?: string
  curatedNotesExplicit: boolean
}

const ROOT_DIR = join(import.meta.dir, '..')

function usage(): string {
  return [
    'Usage: bun run scripts/generate-whats-new.ts --version=0.9.26 [options]',
    '',
    'Options:',
    '  --commits-json=/path/to/commits.json  Read commit metadata instead of git log',
    '  --out-dir=apps/electron/resources/release-notes',
    '  --out-json=/path/to/whats-new.json       Defaults to <out-dir>/whats-new.json',
    '  --from=<git-ref>                       Base ref; defaults to previous release tag',
    '  --to=<git-ref>                         Head ref; defaults to HEAD',
    '  --limit=30                             Fallback commit count when no base tag exists',
    '  --curated-notes=/path/to/next.md       Prefer curated markdown for the release note body',
    '  --no-curated-notes                     Always generate notes from commits',
    '',
    'Optional AI environment:',
    '  OPENAI_API_KEY or STORYFLOW_WHATS_NEW_OPENAI_API_KEY',
    '  STORYFLOW_WHATS_NEW_OPENAI_MODEL=gpt-4.1-mini',
    '  STORYFLOW_WHATS_NEW_DISABLE_AI=1',
  ].join('\n')
}

function parseArgs(argv: string[]): CliOptions {
  const { values } = parseNodeArgs({
    args: argv,
    allowPositionals: false,
    options: {
      version: { type: 'string' },
      'commits-json': { type: 'string' },
      'out-dir': { type: 'string' },
      'out-json': { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      limit: { type: 'string' },
      'curated-notes': { type: 'string' },
      'no-curated-notes': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    console.log(usage())
    process.exit(0)
  }

  const limit = Number.parseInt(values.limit ?? '30', 10)
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`Invalid --limit value: ${values.limit}`)
  }

  const curatedNotesExplicit = values['curated-notes'] !== undefined || values['no-curated-notes'] === true
  const options: CliOptions = {
    version: normalizeVersion(values.version ?? ''),
    commitsJson: values['commits-json'],
    outDir: values['out-dir'] ?? join(ROOT_DIR, 'apps/electron/resources/release-notes'),
    outJson: values['out-json'],
    from: values.from,
    to: values.to ?? 'HEAD',
    limit,
    curatedNotes: values['no-curated-notes']
      ? undefined
      : values['curated-notes'] ?? join(ROOT_DIR, 'apps/electron/resources/release-notes/next.md'),
    curatedNotesExplicit,
  }

  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(options.version)) {
    throw new Error(`Invalid --version value: ${options.version || '(missing)'}`)
  }
  options.outJson ??= join(options.outDir, 'whats-new.json')

  return options
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/, '')
}

function loadCuratedMarkdown(options: CliOptions): string | undefined {
  if (!options.curatedNotes) return undefined
  if (options.commitsJson && !options.curatedNotesExplicit) return undefined
  if (!existsSync(options.curatedNotes)) {
    if (options.curatedNotesExplicit) {
      throw new Error(`Curated release notes not found: ${options.curatedNotes}`)
    }
    return undefined
  }

  const content = readFileSync(options.curatedNotes, 'utf8').trim()
  if (!content) {
    if (options.curatedNotesExplicit) {
      throw new Error(`Curated release notes are empty: ${options.curatedNotes}`)
    }
    return undefined
  }
  return content.endsWith('\n') ? content : `${content}\n`
}

function buildCuratedWhatsNewDraft(input: {
  version: string
  generatedAt: string
  markdown: string
  commits: WhatsNewCommit[]
}): WhatsNewDraft {
  const digest = createWhatsNewDigest(input.markdown)
  const accent = deriveWhatsNewAccentColor(digest)
  const userVisibleCommits = input.commits.filter(isUserVisibleCommit)

  return {
    markdown: input.markdown,
    manifest: {
      version: input.version,
      digest,
      generatedAt: input.generatedAt,
      title: `Storyflow v${input.version} 更新说明`,
      summary: extractCuratedSummary(input.markdown),
      highlights: extractWhatsNewHighlights(input.markdown),
      accentColor: accent.hex,
      accentTextColor: accent.textColor,
      source: {
        commitCount: input.commits.length,
        userVisibleCommitCount: userVisibleCommits.length,
      },
    },
  }
}

function extractCuratedSummary(markdown: string): string {
  const line = markdown
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith('#') && !item.startsWith('-'))
  return line ?? '查看本次更新中的新功能与修复。'
}

function loadCommits(options: CliOptions): WhatsNewCommit[] {
  if (options.commitsJson) {
    const raw = JSON.parse(readFileSync(options.commitsJson, 'utf8')) as unknown
    if (!Array.isArray(raw)) {
      throw new Error('--commits-json must contain an array')
    }
    return raw.map((entry) => normalizeCommit(entry))
  }

  const base = options.from ?? previousReleaseTag(options.to)
  const range = base ? `${base}..${options.to}` : options.to
  const args = base
    ? ['log', '--format=%H%x1f%s%x1f%b%x1e', range]
    : ['log', `--max-count=${options.limit}`, '--format=%H%x1f%s%x1f%b%x1e', options.to]
  const output = runGit(args)
  return parseGitLog(output)
}

function normalizeCommit(entry: unknown): WhatsNewCommit {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Commit entry must be an object')
  }
  const commit = entry as Record<string, unknown>
  if (typeof commit.hash !== 'string' || typeof commit.subject !== 'string') {
    throw new Error('Commit entry must include hash and subject strings')
  }
  return {
    hash: commit.hash,
    subject: commit.subject,
    body: typeof commit.body === 'string' ? commit.body : undefined,
  }
}

function previousReleaseTag(to: string): string | undefined {
  const result = Bun.spawnSync([
    'git',
    'describe',
    '--tags',
    '--abbrev=0',
    '--match',
    'v[0-9]*',
    `${to}^`,
  ], {
    cwd: ROOT_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) return undefined
  return result.stdout.toString().trim() || undefined
}

function runGit(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: ROOT_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || `git ${args.join(' ')} failed`)
  }
  return result.stdout.toString()
}

function parseGitLog(output: string): WhatsNewCommit[] {
  return output
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash = '', subject = '', body = ''] = record.split('\x1f')
      return { hash, subject, body: body.trim() || undefined }
    })
}

async function maybeGenerateAiSummary(commits: WhatsNewCommit[]): Promise<string | undefined> {
  if (process.env.STORYFLOW_WHATS_NEW_DISABLE_AI === '1') return undefined

  const apiKey = process.env.STORYFLOW_WHATS_NEW_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY
  if (!apiKey) return undefined

  const model = process.env.STORYFLOW_WHATS_NEW_OPENAI_MODEL ?? 'gpt-4.1-mini'
  const input = [
    'You write concise Chinese release-note summaries for a desktop writing app.',
    'Use plain user-facing language. Ignore chores, CI, refactors, and packaging unless users benefit directly.',
    'Return one short paragraph, no heading, no markdown list.',
    '',
    'Commits:',
    ...commits.map((commit) => `- ${commit.subject}`),
  ].join('\n')

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input,
      store: false,
      temperature: 0.2,
      max_output_tokens: 220,
    }),
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(`OpenAI summary request failed: ${response.status} ${message}`)
  }

  const payload = await response.json() as {
    output_text?: string
    output?: Array<{ content?: Array<{ text?: string }> }>
  }
  const text = payload.output_text
    ?? payload.output?.flatMap((item) => item.content ?? []).map((content) => content.text ?? '').join('').trim()
  return text?.trim() || undefined
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2))
  const commits = loadCommits(options)
  const generatedAt = new Date().toISOString()
  const curatedMarkdown = loadCuratedMarkdown(options)
  const draft = curatedMarkdown
    ? buildCuratedWhatsNewDraft({
      version: options.version,
      generatedAt,
      markdown: curatedMarkdown,
      commits,
    })
    : buildWhatsNewDraft({
      version: options.version,
      generatedAt,
      commits,
      aiSummary: await maybeGenerateAiSummary(commits),
    })

  mkdirSync(options.outDir, { recursive: true })
  const markdownPath = join(options.outDir, `${options.version}.md`)
  writeFileSync(markdownPath, draft.markdown, 'utf8')

  if (options.outJson) {
    const outJsonDir = dirname(options.outJson)
    if (!existsSync(outJsonDir)) mkdirSync(outJsonDir, { recursive: true })
    writeFileSync(options.outJson, `${JSON.stringify(draft.manifest, null, 2)}\n`, 'utf8')
  }

  console.log(`Generated What's New for v${options.version}`)
  console.log(`Markdown: ${markdownPath}`)
  if (options.outJson) console.log(`Manifest: ${options.outJson}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  console.error('')
  console.error(usage())
  process.exit(1)
})
