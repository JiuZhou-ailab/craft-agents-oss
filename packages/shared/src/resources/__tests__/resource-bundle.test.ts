import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { chmodSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { exportResources, importResources, validateResourceBundle } from '../resource-bundle'
import type { ResourceBundle, AutomationBundleEntry } from '../types'
import type { FolderSourceConfig } from '../../sources/types'
import type { AutomationMatcher } from '../../automations/types'

// ============================================================
// Helpers
// ============================================================

function createTestWorkspace(rootDir: string): string {
  const wsDir = join(rootDir, 'workspace')
  mkdirSync(sourceRoot(wsDir), { recursive: true })
  mkdirSync(skillRoot(wsDir), { recursive: true })
  writeFileSync(join(wsDir, '.craft-agent', 'config.json'), JSON.stringify({ name: 'Test Workspace' }))
  return wsDir
}

function sourceRoot(wsDir: string): string {
  return join(wsDir, '.craft-agent', 'sources')
}

function skillRoot(wsDir: string): string {
  return join(wsDir, '.pi', 'skills')
}

function sourcePath(wsDir: string, slug: string): string {
  return join(sourceRoot(wsDir), slug)
}

function skillPath(wsDir: string, slug: string): string {
  return join(skillRoot(wsDir), slug)
}

function createTestSource(wsDir: string, slug: string, config?: Partial<FolderSourceConfig>): void {
  const sourceDir = sourcePath(wsDir, slug)
  mkdirSync(sourceDir, { recursive: true })

  const defaultConfig: FolderSourceConfig = {
    id: `${slug}_abc123`,
    name: slug,
    slug,
    enabled: true,
    provider: 'custom',
    type: 'api',
    api: { baseUrl: 'https://api.example.com', authType: 'bearer' },
    isAuthenticated: true,
    connectionStatus: 'connected',
    lastTestedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...config,
  }

  writeFileSync(join(sourceDir, 'config.json'), JSON.stringify(defaultConfig, null, 2))
  writeFileSync(join(sourceDir, 'guide.md'), `# ${slug}\n\nUsage guide.`)
}

function createTestSkill(wsDir: string, slug: string, extraFiles?: Record<string, string>): void {
  const skillDir = skillPath(wsDir, slug)
  mkdirSync(skillDir, { recursive: true })

  writeFileSync(join(skillDir, 'SKILL.md'), `---
name: ${slug}
description: Test skill ${slug}
---

Instructions for ${slug}.
`)

  if (extraFiles) {
    for (const [name, content] of Object.entries(extraFiles)) {
      const filePath = join(skillDir, name)
      const dir = join(skillDir, ...name.split('/').slice(0, -1))
      if (dir !== skillDir) mkdirSync(dir, { recursive: true })
      writeFileSync(filePath, content)
    }
  }
}

function makeBundleFile(path: string, content: string) {
  const buf = Buffer.from(content)
  return {
    relativePath: path,
    contentBase64: buf.toString('base64'),
    size: buf.length,
  }
}

function createTestAutomations(
  wsDir: string,
  automations: Record<string, AutomationMatcher[]>,
  version = 2,
): void {
  writeFileSync(join(wsDir, 'automations.json'), JSON.stringify({ version, automations }, null, 2))
}

function makeAutomationEntry(overrides: Partial<AutomationBundleEntry> & { id: string; event: string }): AutomationBundleEntry {
  return {
    matcher: {
      id: overrides.id,
      name: overrides.name,
      actions: [{ type: 'prompt', prompt: 'test' }],
    },
    ...overrides,
  }
}

// Minimal valid deps for import
const noopDeps = {
  clearSourceCredentials: async () => {},
}

// ============================================================
// Tests
// ============================================================

describe('resource-bundle', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `resource-bundle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true })
    }
  })

  // ============================================================
  // Export
  // ============================================================

  describe('exportResources', () => {
    it('exports sources with sanitized config', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'github', {
        isAuthenticated: true,
        connectionStatus: 'connected',
        connectionError: 'old error',
        lastTestedAt: 12345,
      })

      const { bundle } = exportResources(wsDir, { sources: 'all' })

      expect(bundle.version).toBe(1)
      expect(bundle.resources.sources).toHaveLength(1)

      const source = bundle.resources.sources![0]!
      expect(source.slug).toBe('github')
      // Auth state should be reset
      expect(source.config['isAuthenticated']).toBe(false)
      expect(source.config.connectionStatus).toBe('needs_auth')
      expect(source.config.connectionError).toBeUndefined()
      expect(source.config.lastTestedAt).toBeUndefined()
    })

    it('strips known secret fields from source configs', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'google-api', {
        provider: 'google',
        type: 'api',
        api: {
          baseUrl: 'https://gmail.googleapis.com',
          authType: 'oauth',
          googleOAuthClientSecret: 'super-secret',
          defaultHeaders: { 'X-Custom': 'value' },
        },
      })

      const { bundle, warnings } = exportResources(wsDir, { sources: ['google-api'] })

      const config = bundle.resources.sources![0]!.config
      expect(config.api?.googleOAuthClientSecret).toBeUndefined()
      expect(config.api?.defaultHeaders).toBeUndefined()
      expect(warnings.some(w => w.includes('googleOAuthClientSecret'))).toBe(true)
      expect(warnings.some(w => w.includes('defaultHeaders'))).toBe(true)
    })

    it('strips mcp.env and mcp.headers from source configs', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'mcp-server', {
        type: 'mcp',
        mcp: {
          url: 'https://mcp.example.com',
          authType: 'bearer',
          env: { SECRET_TOKEN: 'abc123' },
          headers: { 'Authorization': 'Bearer xyz' },
        },
      })

      const { bundle, warnings } = exportResources(wsDir, { sources: ['mcp-server'] })

      const config = bundle.resources.sources![0]!.config
      expect(config.mcp?.env).toBeUndefined()
      expect(config.mcp?.headers).toBeUndefined()
      expect(warnings.some(w => w.includes('mcp.env'))).toBe(true)
      expect(warnings.some(w => w.includes('mcp.headers'))).toBe(true)
    })

    it('exports all non-hidden files from source folder', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'postgres')

      // Add extra files
      const sourceDir = sourcePath(wsDir, 'postgres')
      writeFileSync(join(sourceDir, 'INSTALL.md'), '# Installation')
      mkdirSync(join(sourceDir, 'templates'), { recursive: true })
      writeFileSync(join(sourceDir, 'templates', 'query.sql'), 'SELECT 1')

      const { bundle } = exportResources(wsDir, { sources: ['postgres'] })

      const files = bundle.resources.sources![0]!.files
      const paths = files.map(f => f.relativePath)
      expect(paths).toContain('guide.md')
      expect(paths).toContain('INSTALL.md')
      expect(paths).toContain('templates/query.sql')
      // config.json should NOT be in files (it's in the config field)
      expect(paths).not.toContain('config.json')
    })

    it('exports skills with all auxiliary files', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSkill(wsDir, 'pdf', {
        'forms.md': '# Forms reference',
        'reference.md': '# PDF Reference',
        'scripts/extract.py': 'import pdf',
        'LICENSE.txt': 'MIT',
      })

      const { bundle } = exportResources(wsDir, { skills: 'all' })

      expect(bundle.resources.skills).toHaveLength(1)
      const skill = bundle.resources.skills![0]!
      const paths = skill.files.map(f => f.relativePath)
      expect(paths).toContain('SKILL.md')
      expect(paths).toContain('forms.md')
      expect(paths).toContain('reference.md')
      expect(paths).toContain('scripts/extract.py')
      expect(paths).toContain('LICENSE.txt')
    })

    it('rejects an unsafe Skill export selector', () => {
      const wsDir = createTestWorkspace(tmpDir)
      const outsideSkill = join(skillRoot(wsDir), '..', 'outside-skill')
      mkdirSync(outsideSkill, { recursive: true })
      writeFileSync(join(outsideSkill, 'SKILL.md'), '# outside')

      const { bundle, warnings } = exportResources(wsDir, { skills: ['../outside-skill'] })

      expect(bundle.resources.skills).toEqual([])
      expect(warnings.some(warning => warning.includes('invalid'))).toBe(true)
    })

    it('does not export a Skill through a symlinked Skill directory', () => {
      const wsDir = createTestWorkspace(tmpDir)
      const skillsRoot = join(tmpDir, 'global-skills')
      const outsideSkill = join(tmpDir, 'outside-skill')
      mkdirSync(skillsRoot)
      mkdirSync(outsideSkill)
      writeFileSync(join(outsideSkill, 'SKILL.md'), '# outside secret')
      symlinkSync(outsideSkill, join(skillsRoot, 'safe-skill'), 'dir')

      const { bundle, warnings } = exportResources(
        wsDir,
        { skills: ['safe-skill'] },
        skillsRoot,
      )

      expect(bundle.resources.skills).toEqual([])
      expect(warnings.some(warning => warning.includes('symbolic link'))).toBe(true)
    })

    it('exports automations as per-entry array', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [
          { id: 'aaa111', name: 'Greeting', actions: [{ type: 'prompt', prompt: 'hello' }] },
        ],
        SessionStart: [
          { id: 'bbb222', name: 'Init', actions: [{ type: 'prompt', prompt: 'init' }] },
        ],
      })

      const { bundle } = exportResources(wsDir, { automations: true })

      expect(bundle.resources.automations).toHaveLength(2)
      const ids = bundle.resources.automations!.map(a => a.id)
      expect(ids).toContain('aaa111')
      expect(ids).toContain('bbb222')

      const greeting = bundle.resources.automations!.find(a => a.id === 'aaa111')!
      expect(greeting.name).toBe('Greeting')
      expect(greeting.event).toBe('UserPromptSubmit')
      expect(greeting.matcher.actions).toHaveLength(1)
    })

    it('does not export automations through a project symlink', () => {
      const wsDir = createTestWorkspace(tmpDir)
      const outsideConfig = join(tmpDir, 'outside-automations.json')
      writeFileSync(outsideConfig, JSON.stringify({
        version: 2,
        automations: {
          UserPromptSubmit: [{
            id: 'outside',
            actions: [{ type: 'prompt', prompt: 'outside secret' }],
          }],
        },
      }))
      symlinkSync(outsideConfig, join(wsDir, 'automations.json'))

      const { bundle, warnings } = exportResources(wsDir, { automations: 'all' })

      expect(bundle.resources.automations).toEqual([])
      expect(warnings.some(warning => warning.includes('symbolic link'))).toBe(true)
    })

    it('exports automations selectively by ID', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [
          { id: 'aaa111', name: 'First', actions: [{ type: 'prompt', prompt: 'a' }] },
          { id: 'bbb222', name: 'Second', actions: [{ type: 'prompt', prompt: 'b' }] },
        ],
      })

      const { bundle } = exportResources(wsDir, { automations: ['aaa111'] })

      expect(bundle.resources.automations).toHaveLength(1)
      expect(bundle.resources.automations![0]!.id).toBe('aaa111')
    })

    it('exports automations selectively by name', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [
          { id: 'aaa111', name: 'My Automation', actions: [{ type: 'prompt', prompt: 'a' }] },
          { id: 'bbb222', name: 'Other', actions: [{ type: 'prompt', prompt: 'b' }] },
        ],
      })

      const { bundle } = exportResources(wsDir, { automations: ['My Automation'] })

      expect(bundle.resources.automations).toHaveLength(1)
      expect(bundle.resources.automations![0]!.id).toBe('aaa111')
    })

    it('warns when name selector matches multiple automations', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [
          { id: 'aaa111', name: 'Dup Name', actions: [{ type: 'prompt', prompt: 'a' }] },
          { id: 'bbb222', name: 'Dup Name', actions: [{ type: 'prompt', prompt: 'b' }] },
        ],
      })

      const { bundle, warnings } = exportResources(wsDir, { automations: ['Dup Name'] })

      // Both should be included
      expect(bundle.resources.automations).toHaveLength(2)
      expect(warnings.some(w => w.includes('matched 2 automations'))).toBe(true)
    })

    it('warns for unmatched automation selector', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [
          { id: 'aaa111', name: 'Real', actions: [{ type: 'prompt', prompt: 'a' }] },
        ],
      })

      const { warnings } = exportResources(wsDir, { automations: ['nonexistent'] })

      expect(warnings.some(w => w.includes("'nonexistent'") && w.includes('did not match'))).toBe(true)
    })

    it('sanitizes webhook auth on export', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [{
          id: 'aaa111',
          name: 'Webhook Test',
          actions: [{
            type: 'webhook',
            url: 'https://api.example.com/hook',
            auth: { type: 'bearer', token: 'secret-token-123' },
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer hardcoded-secret',
            },
          }],
        }],
      })

      const { bundle, warnings } = exportResources(wsDir, { automations: 'all' })

      const action = bundle.resources.automations![0]!.matcher.actions[0] as any
      expect(action.auth).toBeUndefined()
      expect(action.headers?.['Authorization']).toBeUndefined()
      // Content-Type should be preserved
      expect(action.headers?.['Content-Type']).toBe('application/json')
      expect(warnings.some(w => w.includes('auth credentials'))).toBe(true)
      expect(warnings.some(w => w.includes("header 'Authorization'"))).toBe(true)
    })

    it('preserves templated header values on export', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [{
          id: 'aaa111',
          actions: [{
            type: 'webhook',
            url: 'https://api.example.com/hook',
            headers: { 'Authorization': 'Bearer $CRAFT_WH_TOKEN' },
          }],
        }],
      })

      const { bundle } = exportResources(wsDir, { automations: 'all' })

      const action = bundle.resources.automations![0]!.matcher.actions[0] as any
      // Templated Authorization should be preserved
      expect(action.headers?.['Authorization']).toBe('Bearer $CRAFT_WH_TOKEN')
    })

    it('automations: true is backward-compatible with "all"', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [
          { id: 'aaa111', actions: [{ type: 'prompt', prompt: 'a' }] },
        ],
      })

      const { bundle } = exportResources(wsDir, { automations: true })

      expect(bundle.resources.automations).toHaveLength(1)
    })

    it('warns for non-existent sources', () => {
      const wsDir = createTestWorkspace(tmpDir)
      const { warnings } = exportResources(wsDir, { sources: ['nonexistent'] })

      expect(warnings.some(w => w.includes('nonexistent'))).toBe(true)
    })

    it('skips skills without SKILL.md', () => {
      const wsDir = createTestWorkspace(tmpDir)
      // Create a skill dir with no SKILL.md
      mkdirSync(skillPath(wsDir, 'broken'), { recursive: true })
      writeFileSync(join(skillPath(wsDir, 'broken'), 'readme.txt'), 'not a skill')

      const { bundle, warnings } = exportResources(wsDir, { skills: 'all' })

      expect(bundle.resources.skills).toHaveLength(0)
      expect(warnings.some(w => w.includes('SKILL.md'))).toBe(true)
    })

    it('includes sourceWorkspace from workspace config', () => {
      const wsDir = createTestWorkspace(tmpDir)
      const { bundle } = exportResources(wsDir, { sources: 'all' })

      expect(bundle.sourceWorkspace).toBe('Test Workspace')
    })
  })

  // ============================================================
  // Validation
  // ============================================================

  describe('validateResourceBundle', () => {
    it('accepts a valid bundle', () => {
      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'test',
            config: { id: 'test_1', name: 'Test', slug: 'test', enabled: true, provider: 'custom', type: 'api' },
            files: [makeBundleFile('guide.md', '# Test')],
          }],
          skills: [{
            slug: 'my-skill',
            files: [makeBundleFile('SKILL.md', '---\nname: my-skill\ndescription: test\n---\nBody')],
          }],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(true)
      expect(errors).toHaveLength(0)
    })

    it('rejects non-object', () => {
      const { valid } = validateResourceBundle('not an object')
      expect(valid).toBe(false)
    })

    it('rejects wrong version', () => {
      const { valid, errors } = validateResourceBundle({ version: 2, exportedAt: 1, resources: {} })
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('version'))).toBe(true)
    })

    it('rejects duplicate source slugs', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [
            { slug: 'dup', config: { id: '1', name: 'A', slug: 'dup', enabled: true, provider: 'x', type: 'api' }, files: [] },
            { slug: 'dup', config: { id: '2', name: 'B', slug: 'dup', enabled: true, provider: 'x', type: 'api' }, files: [] },
          ],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('duplicate slug'))).toBe(true)
    })

    it('rejects duplicate skill slugs', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          skills: [
            { slug: 'dup', files: [makeBundleFile('SKILL.md', 'x')] },
            { slug: 'dup', files: [makeBundleFile('SKILL.md', 'y')] },
          ],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('duplicate slug'))).toBe(true)
    })

    it('rejects skills without SKILL.md', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          skills: [
            { slug: 'no-skill-md', files: [makeBundleFile('readme.md', 'hi')] },
          ],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('missing SKILL.md'))).toBe(true)
    })

    it('rejects unsafe Skill slugs and mismatched SKILL.md names', () => {
      const unsafe = validateResourceBundle({
        version: 1,
        exportedAt: Date.now(),
        resources: { skills: [{ slug: '../escape', files: [makeBundleFile('SKILL.md', '---\nname: escape\ndescription: test\n---\nBody')] }] },
      })
      expect(unsafe.valid).toBe(false)
      expect(unsafe.errors.some(error => error.includes('invalid slug'))).toBe(true)

      const mismatch = validateResourceBundle({
        version: 1,
        exportedAt: Date.now(),
        resources: { skills: [{ slug: 'safe-skill', files: [makeBundleFile('SKILL.md', '---\nname: other-skill\ndescription: test\n---\nBody')] }] },
      })
      expect(mismatch.valid).toBe(false)
      expect(mismatch.errors.some(error => error.includes('does not match'))).toBe(true)
    })

    it('rejects a SKILL.md that is not valid UTF-8', () => {
      const invalidUtf8 = validateResourceBundle({
        version: 1,
        exportedAt: Date.now(),
        resources: {
          skills: [{
            slug: 'broken-skill',
            files: [{
              relativePath: 'SKILL.md',
              contentBase64: Buffer.from([0xc3, 0x28]).toString('base64'),
              size: 2,
            }],
          }],
        },
      })
      expect(invalidUtf8.valid).toBe(false)
      expect(invalidUtf8.errors.some(error => error.includes('not valid UTF-8'))).toBe(true)
    })

    it('rejects path traversal in files', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'evil',
            config: { id: '1', name: 'Evil', slug: 'evil', enabled: true, provider: 'x', type: 'api' },
            files: [makeBundleFile('../escape.txt', 'pwned')],
          }],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('traversal'))).toBe(true)
    })

    it('rejects source with mismatched config.slug', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'github',
            config: { id: '1', name: 'Evil', slug: 'evil-proxy', enabled: true, provider: 'x', type: 'api' },
            files: [],
          }],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('does not match'))).toBe(true)
    })

    it('accepts valid automation entries', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            { id: 'aaa111', event: 'UserPromptSubmit', matcher: { id: 'aaa111', actions: [{ type: 'prompt', prompt: 'hi' }] } },
          ],
        },
      }

      const { valid } = validateResourceBundle(bundle)
      expect(valid).toBe(true)
    })

    it('rejects duplicate automation IDs', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            { id: 'aaa111', event: 'UserPromptSubmit', matcher: { id: 'aaa111', actions: [{ type: 'prompt', prompt: 'a' }] } },
            { id: 'aaa111', event: 'SessionStart', matcher: { id: 'aaa111', actions: [{ type: 'prompt', prompt: 'b' }] } },
          ],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('duplicate id'))).toBe(true)
    })

    it('allows duplicate automation names', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            { id: 'aaa111', name: 'Same Name', event: 'UserPromptSubmit', matcher: { id: 'aaa111', actions: [{ type: 'prompt', prompt: 'a' }] } },
            { id: 'bbb222', name: 'Same Name', event: 'SessionStart', matcher: { id: 'bbb222', actions: [{ type: 'prompt', prompt: 'b' }] } },
          ],
        },
      }

      const { valid } = validateResourceBundle(bundle)
      expect(valid).toBe(true)
    })

    it('rejects automation with unknown event', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            { id: 'aaa111', event: 'FakeEvent', matcher: { id: 'aaa111', actions: [{ type: 'prompt', prompt: 'a' }] } },
          ],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('unknown event'))).toBe(true)
    })

    it('rejects automation without actions', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            { id: 'aaa111', event: 'UserPromptSubmit', matcher: { id: 'aaa111', actions: [] } },
          ],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('at least one action'))).toBe(true)
    })

    it('rejects duplicate file paths', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'test',
            config: { id: '1', name: 'Test', slug: 'test', enabled: true, provider: 'x', type: 'api' },
            files: [
              makeBundleFile('guide.md', 'first'),
              makeBundleFile('Guide.md', 'second'),
            ],
          }],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('duplicate path'))).toBe(true)
    })
  })

  // ============================================================
  // Import
  // ============================================================

  describe('importResources', () => {
    it('imports sources into workspace', async () => {
      const wsDir = createTestWorkspace(tmpDir)

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'imported-api',
            config: {
              id: 'imported-api_abc',
              name: 'Imported API',
              slug: 'imported-api',
              enabled: true,
              provider: 'custom',
              type: 'api',
              api: { baseUrl: 'https://api.example.com', authType: 'none' },
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            files: [makeBundleFile('guide.md', '# Imported\n\nGuide content.')],
          }],
        },
      }

      const result = await importResources(wsDir, bundle, 'skip', noopDeps)

      expect(result.sources.imported).toEqual(['imported-api'])
      expect(existsSync(join(sourcePath(wsDir, 'imported-api'), 'config.json'))).toBe(true)
      expect(existsSync(join(sourcePath(wsDir, 'imported-api'), 'guide.md'))).toBe(true)
      expect(readFileSync(join(sourcePath(wsDir, 'imported-api'), 'guide.md'), 'utf-8')).toBe('# Imported\n\nGuide content.')
    })

    it('imports skills with auxiliary files', async () => {
      const wsDir = createTestWorkspace(tmpDir)

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          skills: [{
            slug: 'pdf-tools',
            files: [
              makeBundleFile('SKILL.md', '---\nname: pdf-tools\ndescription: PDF stuff\n---\nInstructions'),
              makeBundleFile('forms.md', '# Forms'),
              makeBundleFile('scripts/extract.py', 'import pdf'),
            ],
          }],
        },
      }

      const result = await importResources(wsDir, bundle, 'skip', noopDeps)

      expect(result.skills.imported).toEqual(['pdf-tools'])
      expect(existsSync(join(skillPath(wsDir, 'pdf-tools'), 'SKILL.md'))).toBe(true)
      expect(existsSync(join(skillPath(wsDir, 'pdf-tools'), 'forms.md'))).toBe(true)
      expect(existsSync(join(skillPath(wsDir, 'pdf-tools'), 'scripts', 'extract.py'))).toBe(true)
    })

    it('does not import a project Skill through a symlinked Skill root', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      const outsideSkills = join(tmpDir, 'outside-skills')
      mkdirSync(outsideSkills)
      rmSync(skillRoot(wsDir), { recursive: true })
      symlinkSync(outsideSkills, skillRoot(wsDir), 'dir')
      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: { skills: [{
          slug: 'escaped-skill',
          files: [makeBundleFile(
            'SKILL.md',
            '---\nname: escaped-skill\ndescription: test\n---\nBody',
          )],
        }] },
      }

      const result = await importResources(wsDir, bundle, 'skip', noopDeps)

      expect(result.skills.failed[0]?.error).toContain('symbolic link')
      expect(existsSync(join(outsideSkills, 'escaped-skill'))).toBe(false)
    })

    it('imports and exports Skills through an explicit global root', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      const globalSkillsRoot = join(tmpDir, 'global-skills')
      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          skills: [{
            slug: 'global-review',
            files: [makeBundleFile(
              'SKILL.md',
              '---\nname: global-review\ndescription: Global review\n---\nReview globally.',
            )],
          }],
        },
      }

      const imported = await importResources(
        wsDir,
        bundle,
        'skip',
        noopDeps,
        globalSkillsRoot,
      )
      const exported = exportResources(
        wsDir,
        { skills: 'all' },
        globalSkillsRoot,
      )

      expect(imported.skills.imported).toEqual(['global-review'])
      expect(existsSync(join(globalSkillsRoot, 'global-review', 'SKILL.md'))).toBe(true)
      expect(existsSync(skillPath(wsDir, 'global-review'))).toBe(false)
      expect(exported.bundle.resources.skills?.map(skill => skill.slug)).toEqual(['global-review'])
    })

    it('skips existing resources in skip mode', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'existing')
      createTestSkill(wsDir, 'existing-skill')

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'existing',
            config: { id: 'x', name: 'X', slug: 'existing', enabled: true, provider: 'x', type: 'api', api: { baseUrl: 'http://new', authType: 'none' }, createdAt: 1, updatedAt: 1 },
            files: [makeBundleFile('guide.md', '# New guide')],
          }],
          skills: [{
            slug: 'existing-skill',
            files: [makeBundleFile('SKILL.md', '---\nname: existing-skill\ndescription: new\n---\nNew')],
          }],
        },
      }

      const result = await importResources(wsDir, bundle, 'skip', noopDeps)

      expect(result.sources.skipped).toEqual(['existing'])
      expect(result.skills.skipped).toEqual(['existing-skill'])
      // Original content should be preserved
      expect(readFileSync(join(sourcePath(wsDir, 'existing'), 'guide.md'), 'utf-8')).toContain('Usage guide')
    })

    it('replaces existing resources in overwrite mode', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'target')

      // Add an extra file to the original that shouldn't survive overwrite
      writeFileSync(join(sourcePath(wsDir, 'target'), 'old-file.txt'), 'stale')

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'target',
            config: {
              id: 'target_new',
              name: 'Target',
              slug: 'target',
              enabled: true,
              provider: 'custom',
              type: 'api',
              api: { baseUrl: 'https://new-api.example.com', authType: 'none' },
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            files: [makeBundleFile('guide.md', '# New guide')],
          }],
        },
      }

      const result = await importResources(wsDir, bundle, 'overwrite', noopDeps)

      expect(result.sources.imported).toEqual(['target'])
      // New content
      expect(readFileSync(join(sourcePath(wsDir, 'target'), 'guide.md'), 'utf-8')).toBe('# New guide')
      // Old stale file should be gone (full replacement)
      expect(existsSync(join(sourcePath(wsDir, 'target'), 'old-file.txt'))).toBe(false)
    })

    it('calls clearSourceCredentials on source overwrite', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'creds-test')

      const cleared: string[] = []
      const deps = {
        clearSourceCredentials: async (_wsId: string, slug: string) => {
          cleared.push(slug)
        },
      }

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'creds-test',
            config: {
              id: 'creds-test_x',
              name: 'Creds Test',
              slug: 'creds-test',
              enabled: true,
              provider: 'custom',
              type: 'api',
              api: { baseUrl: 'https://api.example.com', authType: 'none' },
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            files: [],
          }],
        },
      }

      await importResources(wsDir, bundle, 'overwrite', deps)
      expect(cleared).toEqual(['creds-test'])
    })

    it('imports automations into workspace with no existing file', async () => {
      const wsDir = createTestWorkspace(tmpDir)

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            makeAutomationEntry({ id: 'aaa111', name: 'Auto 1', event: 'UserPromptSubmit' }),
          ],
        },
      }

      const result = await importResources(wsDir, bundle, 'skip', noopDeps)

      expect(result.automations.imported).toEqual(['Auto 1'])
      const config = JSON.parse(readFileSync(join(wsDir, 'automations.json'), 'utf-8'))
      expect(config.version).toBe(2)
      expect(config.automations.UserPromptSubmit).toHaveLength(1)
      expect(config.automations.UserPromptSubmit[0].id).toBe('aaa111')
    })

    it('merges automations into existing config', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [
          { id: 'existing1', name: 'Existing', actions: [{ type: 'prompt', prompt: 'old' }] },
        ],
      })

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            makeAutomationEntry({ id: 'new1', name: 'New Auto', event: 'SessionStart' }),
          ],
        },
      }

      const result = await importResources(wsDir, bundle, 'skip', noopDeps)

      expect(result.automations.imported).toEqual(['New Auto'])
      const config = JSON.parse(readFileSync(join(wsDir, 'automations.json'), 'utf-8'))
      // Existing automation should be preserved
      expect(config.automations.UserPromptSubmit).toHaveLength(1)
      expect(config.automations.UserPromptSubmit[0].id).toBe('existing1')
      // New automation should be added
      expect(config.automations.SessionStart).toHaveLength(1)
      expect(config.automations.SessionStart[0].id).toBe('new1')
    })

    it('skips automations with existing ID in skip mode', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [
          { id: 'aaa111', name: 'Original', actions: [{ type: 'prompt', prompt: 'original' }] },
        ],
      })

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            makeAutomationEntry({ id: 'aaa111', name: 'Updated', event: 'UserPromptSubmit' }),
          ],
        },
      }

      const result = await importResources(wsDir, bundle, 'skip', noopDeps)

      expect(result.automations.skipped).toEqual(['Updated'])
      // Original should be preserved
      const config = JSON.parse(readFileSync(join(wsDir, 'automations.json'), 'utf-8'))
      expect(config.automations.UserPromptSubmit[0].name).toBe('Original')
    })

    it('overwrites automation by ID in overwrite mode', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [
          { id: 'aaa111', name: 'Original', actions: [{ type: 'prompt', prompt: 'original' }] },
          { id: 'bbb222', name: 'Untouched', actions: [{ type: 'prompt', prompt: 'keep' }] },
        ],
      })

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            makeAutomationEntry({ id: 'aaa111', name: 'Replaced', event: 'UserPromptSubmit' }),
          ],
        },
      }

      const result = await importResources(wsDir, bundle, 'overwrite', noopDeps)

      expect(result.automations.imported).toEqual(['Replaced'])
      const config = JSON.parse(readFileSync(join(wsDir, 'automations.json'), 'utf-8'))
      // Replaced automation
      const names = config.automations.UserPromptSubmit.map((m: any) => m.name)
      expect(names).toContain('Replaced')
      // Untouched automation should survive
      expect(names).toContain('Untouched')
    })

    it('preserves existing version field on import', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [
          { id: 'existing1', actions: [{ type: 'prompt', prompt: 'old' }] },
        ],
      }, 2)

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            makeAutomationEntry({ id: 'new1', event: 'SessionStart' }),
          ],
        },
      }

      await importResources(wsDir, bundle, 'skip', noopDeps)

      const config = JSON.parse(readFileSync(join(wsDir, 'automations.json'), 'utf-8'))
      expect(config.version).toBe(2)
    })

    it('selectively clears history and retry queue for overwritten IDs', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [
          { id: 'aaa111', actions: [{ type: 'prompt', prompt: 'old' }] },
          { id: 'bbb222', actions: [{ type: 'prompt', prompt: 'keep' }] },
        ],
      })

      // Write history with entries for both IDs
      const historyLines = [
        JSON.stringify({ automationId: 'aaa111', ts: 1, ok: true }),
        JSON.stringify({ automationId: 'bbb222', ts: 2, ok: true }),
        JSON.stringify({ automationId: 'aaa111', ts: 3, ok: false }),
      ]
      writeFileSync(join(wsDir, 'automations-history.jsonl'), historyLines.join('\n') + '\n')

      // Write retry queue
      const retryLines = [
        JSON.stringify({ matcherId: 'aaa111', id: 'r1', nextRetryAt: Date.now() }),
        JSON.stringify({ matcherId: 'bbb222', id: 'r2', nextRetryAt: Date.now() }),
      ]
      writeFileSync(join(wsDir, 'automations-retry-queue.jsonl'), retryLines.join('\n') + '\n')

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            makeAutomationEntry({ id: 'aaa111', event: 'UserPromptSubmit' }),
          ],
        },
      }

      await importResources(wsDir, bundle, 'overwrite', noopDeps)

      // History for aaa111 should be removed, bbb222 should survive
      const history = readFileSync(join(wsDir, 'automations-history.jsonl'), 'utf-8')
      expect(history).not.toContain('aaa111')
      expect(history).toContain('bbb222')

      // Retry queue for aaa111 should be removed, bbb222 should survive
      const retries = readFileSync(join(wsDir, 'automations-retry-queue.jsonl'), 'utf-8')
      expect(retries).not.toContain('aaa111')
      expect(retries).toContain('bbb222')
    })

    it('does not clear automation history through a project symlink', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [{ id: 'aaa111', actions: [{ type: 'prompt', prompt: 'old' }] }],
      })
      const outsideHistory = join(tmpDir, 'outside-history.jsonl')
      const originalHistory = `${JSON.stringify({ automationId: 'aaa111', ts: 1 })}\n`
      writeFileSync(outsideHistory, originalHistory)
      symlinkSync(outsideHistory, join(wsDir, 'automations-history.jsonl'))
      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: { automations: [
          makeAutomationEntry({ id: 'aaa111', event: 'UserPromptSubmit' }),
        ] },
      }

      const result = await importResources(wsDir, bundle, 'overwrite', noopDeps)

      expect(readFileSync(outsideHistory, 'utf-8')).toBe(originalHistory)
      expect(result.automations.warnings.some(warning => warning.includes('cleanup failed'))).toBe(true)
    })

    it('does not commit an automation overwrite when retry cleanup is unsafe', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [{
          id: 'aaa111', name: 'Old', actions: [{ type: 'prompt', prompt: 'old' }],
        }],
      })
      const outsideRetry = join(tmpDir, 'outside-retry.jsonl')
      const originalRetry = `${JSON.stringify({ matcherId: 'aaa111', action: { url: 'https://old.example' } })}\n`
      writeFileSync(outsideRetry, originalRetry)
      symlinkSync(outsideRetry, join(wsDir, 'automations-retry-queue.jsonl'))
      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: { automations: [
          makeAutomationEntry({ id: 'aaa111', name: 'New', event: 'UserPromptSubmit' }),
        ] },
      }

      const result = await importResources(wsDir, bundle, 'overwrite', noopDeps)

      expect(result.automations.imported).toEqual([])
      expect(result.automations.failed[0]?.error).toContain('retry cleanup')
      expect(readFileSync(outsideRetry, 'utf-8')).toBe(originalRetry)
      expect(JSON.parse(readFileSync(join(wsDir, 'automations.json'), 'utf-8'))
        .automations.UserPromptSubmit[0].name).toBe('Old')
    })

    it('does not commit an automation overwrite when its retry queue is read-only', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [{
          id: 'aaa111', name: 'Old', actions: [{ type: 'prompt', prompt: 'old' }],
        }],
      })
      const retryPath = join(wsDir, 'automations-retry-queue.jsonl')
      const originalRetry = `${JSON.stringify({
        matcherId: 'aaa111',
        action: { type: 'webhook', url: 'https://old.example' },
      })}\n`
      writeFileSync(retryPath, originalRetry)
      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: { automations: [
          makeAutomationEntry({ id: 'aaa111', name: 'New', event: 'UserPromptSubmit' }),
        ] },
      }

      chmodSync(retryPath, 0o444)
      let result
      try {
        result = await importResources(wsDir, bundle, 'overwrite', noopDeps)
      } finally {
        chmodSync(retryPath, 0o644)
      }

      expect(result.automations.imported).toEqual([])
      expect(result.automations.failed[0]?.error).toContain('retry cleanup')
      expect(readFileSync(retryPath, 'utf-8')).toBe(originalRetry)
      expect(JSON.parse(readFileSync(join(wsDir, 'automations.json'), 'utf-8'))
        .automations.UserPromptSubmit[0].name).toBe('Old')
    })

    it('keeps the retry queue when the automation config commit fails', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestAutomations(wsDir, {
        UserPromptSubmit: [{
          id: 'aaa111', name: 'Old', actions: [{ type: 'prompt', prompt: 'old' }],
        }],
      })
      const retryPath = join(wsDir, 'automations-retry-queue.jsonl')
      const originalRetry = `${JSON.stringify({ matcherId: 'aaa111', id: 'retry-1' })}\n`
      writeFileSync(retryPath, originalRetry)
      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: { automations: [
          makeAutomationEntry({ id: 'aaa111', name: 'New', event: 'UserPromptSubmit' }),
        ] },
      }

      chmodSync(wsDir, 0o555)
      let result
      try {
        result = await importResources(wsDir, bundle, 'overwrite', noopDeps)
      } finally {
        chmodSync(wsDir, 0o755)
      }

      expect(result.automations.failed[0]?.error).toContain('Failed to write automations.json')
      expect(readFileSync(retryPath, 'utf-8')).toBe(originalRetry)
      expect(JSON.parse(readFileSync(join(wsDir, 'automations.json'), 'utf-8'))
        .automations.UserPromptSubmit[0].name).toBe('Old')
    })

    it('fails import when existing automations.json is invalid in skip mode', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      writeFileSync(join(wsDir, 'automations.json'), 'not valid json {{{')

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            makeAutomationEntry({ id: 'aaa111', event: 'UserPromptSubmit' }),
          ],
        },
      }

      const result = await importResources(wsDir, bundle, 'skip', noopDeps)

      expect(result.automations.failed).toHaveLength(1)
      expect(result.automations.imported).toHaveLength(0)
    })

    it('starts fresh when existing automations.json is invalid in overwrite mode', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      writeFileSync(join(wsDir, 'automations.json'), 'not valid json {{{')

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [
            makeAutomationEntry({ id: 'aaa111', name: 'Fresh Start', event: 'UserPromptSubmit' }),
          ],
        },
      }

      const result = await importResources(wsDir, bundle, 'overwrite', noopDeps)

      expect(result.automations.imported).toEqual(['Fresh Start'])
      const config = JSON.parse(readFileSync(join(wsDir, 'automations.json'), 'utf-8'))
      expect(config.version).toBe(2)
      expect(config.automations.UserPromptSubmit[0].id).toBe('aaa111')
    })

    it('rejects import when merged config has invalid regex', async () => {
      const wsDir = createTestWorkspace(tmpDir)

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          automations: [{
            id: 'aaa111',
            event: 'UserPromptSubmit',
            matcher: {
              id: 'aaa111',
              matcher: '(a+)+$', // ReDoS pattern
              actions: [{ type: 'prompt', prompt: 'test' }],
            },
          }],
        },
      }

      const result = await importResources(wsDir, bundle, 'skip', noopDeps)

      expect(result.automations.failed).toHaveLength(1)
      expect(result.automations.failed[0]!.error).toContain('invalid')
    })

    it('rejects invalid bundle with error in result', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      const result = await importResources(wsDir, { version: 99 } as any, 'skip', noopDeps)

      expect(result.sources.failed).toHaveLength(1)
      expect(result.sources.failed[0]!.error).toContain('Invalid bundle')
    })

    it('handles partial failures gracefully', async () => {
      const wsDir = createTestWorkspace(tmpDir)

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [
            {
              slug: 'good-source',
              config: {
                id: 'good_1',
                name: 'Good',
                slug: 'good-source',
                enabled: true,
                provider: 'custom',
                type: 'api',
                api: { baseUrl: 'https://api.example.com', authType: 'none' },
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
              files: [makeBundleFile('guide.md', '# Good')],
            },
          ],
          skills: [
            {
              slug: 'good-skill',
              files: [makeBundleFile('SKILL.md', '---\nname: good-skill\ndescription: Good\n---\nBody')],
            },
          ],
        },
      }

      const result = await importResources(wsDir, bundle, 'skip', noopDeps)

      expect(result.sources.imported).toEqual(['good-source'])
      expect(result.skills.imported).toEqual(['good-skill'])
    })

    it('cleans up temp dirs on failure', async () => {
      const wsDir = createTestWorkspace(tmpDir)

      // Import should complete without leaving temp dirs
      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'test',
            config: { id: 'test_1', name: 'Test', slug: 'test', enabled: true, provider: 'x', type: 'api', api: { baseUrl: 'http://x', authType: 'none' }, createdAt: 1, updatedAt: 1 },
            files: [makeBundleFile('guide.md', '# Test')],
          }],
        },
      }

      await importResources(wsDir, bundle, 'skip', noopDeps)

      // No .tmp-* dirs should remain
      const sourcesDir = sourceRoot(wsDir)
      const entries = readdirSync(sourcesDir)
      const tmpDirs = entries.filter(e => e.startsWith('.tmp-'))
      expect(tmpDirs).toHaveLength(0)
    })
  })

  // ============================================================
  // Round-trip
  // ============================================================

  describe('round-trip export → import', () => {
    it('preserves source and skill content through round-trip', async () => {
      // Create source workspace with resources
      const srcDir = createTestWorkspace(join(tmpDir, 'src'))
      createTestSource(srcDir, 'my-api')
      createTestSkill(srcDir, 'my-skill', {
        'helper.ts': 'export function help() {}',
      })

      // Export
      const { bundle } = exportResources(srcDir, { sources: 'all', skills: 'all' })

      // Import into fresh workspace
      const dstDir = createTestWorkspace(join(tmpDir, 'dst'))
      const result = await importResources(dstDir, bundle, 'skip', noopDeps)

      expect(result.sources.imported).toEqual(['my-api'])
      expect(result.skills.imported).toEqual(['my-skill'])

      // Verify source files
      expect(existsSync(join(sourcePath(dstDir, 'my-api'), 'config.json'))).toBe(true)
      expect(existsSync(join(sourcePath(dstDir, 'my-api'), 'guide.md'))).toBe(true)

      // Verify skill files
      expect(existsSync(join(skillPath(dstDir, 'my-skill'), 'SKILL.md'))).toBe(true)
      expect(existsSync(join(skillPath(dstDir, 'my-skill'), 'helper.ts'))).toBe(true)
      expect(readFileSync(join(skillPath(dstDir, 'my-skill'), 'helper.ts'), 'utf-8')).toBe('export function help() {}')

      // Imported source config should have auth reset
      const importedConfig = JSON.parse(readFileSync(join(sourcePath(dstDir, 'my-api'), 'config.json'), 'utf-8'))
      expect(importedConfig.isAuthenticated).toBe(false)
    })

    it('preserves automations through round-trip', async () => {
      const srcDir = createTestWorkspace(join(tmpDir, 'src'))
      createTestAutomations(srcDir, {
        UserPromptSubmit: [
          { id: 'aaa111', name: 'Greet', actions: [{ type: 'prompt', prompt: 'hello' }] },
        ],
        SchedulerTick: [
          { id: 'bbb222', name: 'Daily Check', cron: '0 9 * * 1-5', timezone: 'Europe/Budapest', actions: [{ type: 'prompt', prompt: 'check' }] },
        ],
      })

      // Export
      const { bundle } = exportResources(srcDir, { automations: 'all' })
      expect(bundle.resources.automations).toHaveLength(2)

      // Import into fresh workspace
      const dstDir = createTestWorkspace(join(tmpDir, 'dst'))
      const result = await importResources(dstDir, bundle, 'skip', noopDeps)

      expect(result.automations.imported).toHaveLength(2)

      const config = JSON.parse(readFileSync(join(dstDir, 'automations.json'), 'utf-8'))
      expect(config.version).toBe(2)
      expect(config.automations.UserPromptSubmit).toHaveLength(1)
      expect(config.automations.UserPromptSubmit[0].name).toBe('Greet')
      expect(config.automations.SchedulerTick).toHaveLength(1)
      expect(config.automations.SchedulerTick[0].cron).toBe('0 9 * * 1-5')
    })
  })
})
