// input: SkillsHubPage source and its catalog/install contracts
// output: Regression coverage for local authority, uninstalled discovery, and safe one-click installation
// pos: Small source-level check isolated from Electron's browser-only dependency graph

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { MarketSkillSummary } from '@craft-agent/shared/skills/marketplace'
import {
  filterMarketSkills,
  getInstalledMarketSlug,
  hasMarketSkillUpdate,
  isInstallableMarketSkill,
  normalizeRequiredSourceSlugs,
  normalizeMarketSkillExternalUrl,
  resolveRequiredSources,
  stripSkillFrontmatter,
} from '../skills-hub-logic'

const source = readFileSync(new URL('../SkillsHubPage.tsx', import.meta.url), 'utf8')
const skillAvatarSource = readFileSync(new URL('../../components/ui/skill-avatar.tsx', import.meta.url), 'utf8')
const marketSkill: MarketSkillSummary = {
  slug: 'story-structure',
  version: '1.0.0',
  displayName: 'Story Structure',
  summary: 'Build a reliable story structure',
  author: 'Method Team',
  publisher: { id: 'publisher', displayName: 'Studio' },
  visibility: 'public',
  license: 'MIT',
  tags: ['story'],
  roots: ['plot'],
  downloadCount: 2,
  featured: true,
  sha256: 'a'.repeat(64),
}

describe('SkillsHubPage contracts', () => {
  it('derives installed state from the Pi-native skills atom', () => {
    expect(source).toContain("import { skillsAtom } from '@/atoms/skills'")
    expect(source).toContain('useAtomValue(skillsAtom)')
    expect(source).toContain('const marketSlug = getInstalledMarketSlug(skill)')
    expect(source).not.toContain('window.electronAPI.getSkills')
    expect(getInstalledMarketSlug({ origin: 'top-level', path: '/skills/story-structure/' } as never))
      .toBe('story-structure')
    expect(getInstalledMarketSlug({ origin: 'extension', path: '/skills/story-structure' } as never))
      .toBeNull()
  })

  it('keeps installed Skills out of discovery', () => {
    expect(source).toContain('.filter(skill => !installedBySlug.has(skill.slug))')
    expect(source).not.toContain('const installed = installedBySlug.get(skill.slug)')
  })

  it('validates downloads and imports only into the active project', () => {
    expect(source).toContain('window.electronAPI.downloadSkillFromMarket(skill)')
    expect(source).toContain("'skip',")
    expect(source).toContain("skillScope: 'project'")
    expect(source).toContain('installArtifact:')
    expect(source).toContain('raw: downloaded.raw')
    expect(source).toContain('currentWorkspaceId.current !== targetWorkspaceId')
  })

  it('offers explicit tracked upgrades without generic overwrite', () => {
    expect(source).toContain("window.electronAPI.listSkillInstallReceipts(workspaceId, 'project')")
    expect(source).toContain('window.electronAPI.upgradeInstalledSkill(')
    expect(source).toContain('window.electronAPI.downloadSkillFromMarket(receipt)')
    expect(source).not.toContain("downloaded.bundle,\n        'overwrite'")
    const receipt = {
      kind: 'skill', slug: marketSkill.slug, version: '0.9.0', sha256: 'b'.repeat(64), scope: 'project',
    } as const
    expect(hasMarketSkillUpdate(receipt, marketSkill)).toBe(true)
    expect(hasMarketSkillUpdate({ ...receipt, version: marketSkill.version, sha256: marketSkill.sha256 }, marketSkill)).toBe(false)
  })

  it('keeps reference-only recommendations visible without synthetic Markdown instructions', () => {
    expect(source).toContain('window.electronAPI.listSkillsFromMarket()')
    expect(source).not.toContain('DEFAULT_SKILLS_MARKET_ORIGIN')
    expect(source).toContain('isInstallableMarketSkill(skill)')
    expect(source).toContain("t('skillsHub.referenceOnly', '仅供参考')")
    expect(source).toContain("t('skillsHub.openSource', '查看来源')")
    expect(source).toContain('detail && isInstallableMarketSkill(detail)')
    expect(source).toContain("showContent ? 'grid-rows-[auto_minmax(0,1fr)_auto]' : 'grid-rows-[auto_auto]'")
    expect(isInstallableMarketSkill(marketSkill)).toBe(true)
    expect(isInstallableMarketSkill({ ...marketSkill, sha256: '' })).toBe(false)
  })

  it('reloads the uncached catalog after a successful publication', () => {
    expect(source).toContain('onPublished={() => setReloadToken(value => value + 1)}')
  })

  it('resolves hidden runtime workspaces without hiding the header actions', () => {
    expect(source).toContain('windowRuntimeWorkspaceAtom')
    expect(source).toContain('useAtomValue(windowRuntimeWorkspaceAtom)')
    expect(source).toContain('disabled={!workspace || publishableSkills.length === 0}')
    expect(source).toContain("? t('workspace.loadingWorkspaces', '正在加载项目...')")
  })

  it('separates discovery and installed management into top-level tabs', () => {
    expect(source).toContain("type SkillsTab = 'discover' | 'installed'")
    expect(source).toContain('<TabsTrigger value="discover"')
    expect(source).toContain('<TabsTrigger value="installed"')
    expect(source).toContain('<TabsContent value="discover"')
    expect(source).toContain('<TabsContent value="installed"')
    expect(source).not.toContain('INSTALLED_SKILLS_PREVIEW_LIMIT')
    expect(source).not.toContain('mt-3 flex gap-2 overflow-x-auto')
  })

  it('shows installed descriptions in a readable two-column list', () => {
    expect(source).toContain('id="installed-skills-grid" className="grid grid-cols-1 gap-x-8 lg:grid-cols-2"')
    expect(source).toContain('{skill.metadata.description}')
    expect(source).not.toContain('block line-clamp-2')
  })

  it('keeps the fixed external SkillHub entry inside discovery', () => {
    expect(source).toContain("window.electronAPI.openUrl('https://skillhub.cn')")
    expect(source).toContain("t('skillsHub.browseSkillHub', '浏览 SkillHub')")
  })

  it('opens authenticated catalog details and renders Skill instructions', () => {
    expect(source).toContain('window.electronAPI.getSkillDetailFromMarket(skill.slug)')
    expect(source).toContain('stripSkillFrontmatter(detail.skillMarkdown)')
    expect(source).toContain('onClick={() => void openMarketSkill(skill)}')
    expect(source).toContain('<Info_Markdown mode="full"')
    expect(source).toContain('setSelectedMarketSkill(detail)')
    expect(source).toContain('const installTarget = marketSkillDetail ?? selectedMarketSkill')
    expect(stripSkillFrontmatter('---\nname: test\n---\n\n# Instructions')).toBe('# Instructions')
  })

  it('shows manifest Source dependencies without handling credentials in the Skill surface', () => {
    expect(source).toContain("import { sourcesAtom } from '@/atoms/sources'")
    expect(source).toContain("t('skillInfo.requiredSources')")
    expect(source).toContain('detail?.manifest.contributes?.requiredSources')
    expect(source).toContain('detail?.requiresStoryflowLogin === true')
    expect(source).toContain("routes.view.settings('profile')")
    expect(source).not.toContain("routes.view.settings('app')")
    expect(source).toContain('routes.view.sources({')
    expect(source).not.toContain('saveSourceCredentials')
    expect(source).not.toContain('API_KEY')
  })

  it('opens details before installing so runtime requirements stay visible', () => {
    expect(source).toContain('onClick={() => void openMarketSkill(skill)}')
  })

  it('normalizes untrusted manifest dependencies and resolves local auth ownership', () => {
    expect(normalizeRequiredSourceSlugs([
      ' linear ',
      'storyflow-catalog',
      'linear',
      '',
      '../escape',
      42,
    ])).toEqual(['linear', 'storyflow-catalog'])

    const managed = {
      origin: 'craft-global',
      config: {
        id: 'builtin-storyflow-catalog',
        slug: 'storyflow-catalog',
        provider: 'storyflow',
        type: 'api',
        api: { authType: 'managed' },
      },
    }
    const byok = {
      origin: 'craft-global',
      config: {
        id: 'linear',
        slug: 'linear',
        provider: 'linear',
        type: 'mcp',
        mcp: { authType: 'bearer' },
      },
    }
    const publicSource = {
      origin: 'craft-global',
      config: {
        id: 'public-docs',
        slug: 'public-docs',
        provider: 'docs',
        type: 'mcp',
        mcp: { authType: 'none' },
      },
    }

    expect(resolveRequiredSources(
      ['storyflow-catalog', 'linear', 'public-docs', 'missing'],
      [managed, byok, publicSource] as never,
    ).map(item => [item.slug, item.access])).toEqual([
      ['storyflow-catalog', 'managed'],
      ['linear', 'byok'],
      ['public-docs', 'no-auth'],
      ['missing', 'missing'],
    ])
  })

  it('uses the installed Skill avatar UI for catalog icons', () => {
    expect(source).toContain('SkillAvatar, SkillVisualAvatar')
    expect(source).toContain('return resolveSkillVisual([skill.slug, skill.displayName, ...skill.tags, ...skill.roots])')
    expect(source).toContain('<SkillVisualAvatar')
    expect(source).not.toContain("'flex size-10 shrink-0 items-center justify-center rounded-lg'")
    expect(skillAvatarSource).toContain('const SKILL_VISUALS')
    expect(skillAvatarSource).toContain('export function SkillVisualAvatar')
    expect(skillAvatarSource).toContain('<SkillVisualAvatar')
    expect(skillAvatarSource.match(/<EntityIcon/g)).toHaveLength(1)
  })

  it('manages each installed Skill in place and confirms removal through the shared dialog', () => {
    expect(source).toContain("import { SkillRemovalDialog } from '@/components/app-shell/SkillMenu'")
    expect(source).toContain('isDefaultGlobalAgentSkillSlug(getInstalledMarketSlug(skill) ?? skill.slug)')
    expect(source).toContain('setSkillToRemove(skill)')
    expect(source).toContain("? 'Storyflow'")
    expect(source).toContain('<SkillRemovalDialog')
    expect(source).not.toContain('window.electronAPI.deleteSkill')
  })

  it('keeps free-form tags as search metadata instead of primary navigation', () => {
    expect(source).not.toContain('selectedTag')
    expect(source).not.toContain('marketSkills.flatMap(skill => skill.tags)')
    expect(source).not.toContain("t('skillsHub.tags'")
    expect(filterMarketSkills([marketSkill], 'studio', 'all')).toEqual([marketSkill])
    expect(filterMarketSkills([{ ...marketSkill, featured: false }], '', 'featured')).toEqual([])
  })

  it('shows only the uploader name and Market download count in catalog metadata', () => {
    expect(source).toContain('{skill.publisher.displayName}</span>')
    expect(source).toContain('{resolvedSkill.publisher.displayName}</span>')
    expect(source).toContain('count: skill.downloadCount')
    expect(source).toContain('flex min-w-0 gap-2 overflow-hidden whitespace-nowrap text-xs')
    expect(source).not.toContain('{skill.author}</span>')
    expect(source).not.toContain('{resolvedSkill.author}</span>')
  })

  it('keeps recommendation evidence searchable but displays Market download counts', () => {
    expect(source).toContain("React.useState<CatalogView>('all')")
    expect(source).toContain('skill.downloadCount')
    expect(source).not.toContain('skill.recommendation.label')
    expect(source).toContain("t('skillsHub.downloadCount'")
    expect(filterMarketSkills([marketSkill], '', 'featured')).toEqual([marketSkill])
  })

  it('shows the newest Registry entries first in the default all view', () => {
    const older = { ...marketSkill, slug: 'older', publishedAt: '2026-08-01T00:00:00Z' }
    const newer = { ...marketSkill, slug: 'newer', publishedAt: '2026-09-01T00:00:00Z' }
    expect(filterMarketSkills([older, newer], '', 'all').map(skill => skill.slug)).toEqual(['newer', 'older'])
  })

  it('uses button semantics and blocks remote Markdown image requests', () => {
    expect(source).toContain('role="group"')
    expect(source).toContain('aria-pressed={catalogView === view}')
    expect(source).not.toContain('role="tab"')
    expect(source).toContain('allowImages={false}')
    expect(source).toContain('onUrlClick={onOpenUrl}')
    expect(normalizeMarketSkillExternalUrl('https://example.com/docs')).toBe('https://example.com/docs')
    expect(normalizeMarketSkillExternalUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeMarketSkillExternalUrl('file:///tmp/private')).toBeNull()
  })
})
