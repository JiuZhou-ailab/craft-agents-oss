// input: Skills Market summaries/details, installed Skills, local Sources, and external Markdown targets
// output: Pure catalog, dependency ownership, installability, slug, frontmatter, and URL policy decisions
// pos: Browser-independent policy boundary for the Skills Hub

import type { MarketSkillSummary } from '@craft-agent/shared/skills/marketplace'
import type { SkillInstallReceipt } from '@craft-agent/shared/resources'
import type { LoadedSkill, LoadedSource } from '../../shared/types'

export type CatalogView = 'company' | 'featured' | 'all'

export type RequiredSourceAccess = 'managed' | 'byok' | 'no-auth' | 'missing'

export interface RequiredSourceDependency {
  slug: string
  source: LoadedSource | null
  access: RequiredSourceAccess
}

const SOURCE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function stripSkillFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
}

export function normalizeMarketSkillExternalUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null
  } catch {
    return null
  }
}

/** Keep routing inputs reduced to unique Source slugs at the renderer boundary. */
export function normalizeRequiredSourceSlugs(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const slugs = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const slug = item.trim()
    if (slug.length === 0 || slug.length > 64 || !SOURCE_SLUG_PATTERN.test(slug)) continue
    slugs.add(slug)
  }
  return [...slugs]
}

export function resolveRequiredSources(
  requiredSourceSlugs: readonly string[],
  sources: readonly LoadedSource[],
): RequiredSourceDependency[] {
  const sourcesBySlug = new Map(sources.map(source => [source.config.slug, source]))
  return requiredSourceSlugs.map((slug) => {
    const source = sourcesBySlug.get(slug) ?? null
    if (!source) return { slug, source, access: 'missing' }

    const { config } = source
    const managed = source.origin === 'craft-global'
      && config.id === 'builtin-storyflow-catalog'
      && config.slug === 'storyflow-catalog'
      && config.provider === 'storyflow'
      && config.type === 'api'
      && config.api?.authType === 'managed'
    if (managed) return { slug, source, access: 'managed' }

    const requiresCredentials = config.type === 'api'
      ? Boolean(config.api?.authType && !['none', 'managed'].includes(config.api.authType))
      : config.type === 'mcp'
        ? config.mcp?.authType === 'oauth'
          || config.mcp?.authType === 'bearer'
          || Boolean(config.mcp?.headerNames?.length)
        : false
    return { slug, source, access: requiresCredentials ? 'byok' : 'no-auth' }
  })
}

export function filterMarketSkills(
  skills: MarketSkillSummary[],
  query: string,
  view: CatalogView,
): MarketSkillSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filtered = skills.filter((skill) => {
    if (view === 'company' && skill.visibility !== 'company') return false
    if (!normalizedQuery && view === 'featured' && !skill.featured) return false
    if (!normalizedQuery) return true
    return [
      skill.displayName,
      skill.summary,
      skill.author,
      skill.publisher.displayName,
      skill.tags.join(' '),
      skill.recommendation?.label,
      skill.recommendation?.sourceName,
    ]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  })
  return view === 'all'
    ? filtered.sort((a, b) => (Date.parse(b.publishedAt ?? '') || 0) - (Date.parse(a.publishedAt ?? '') || 0))
    : filtered
}

export function isInstallableMarketSkill(skill: MarketSkillSummary): boolean {
  return /^[a-f0-9]{64}$/.test(skill.sha256)
}

export function hasMarketSkillUpdate(
  receipt: SkillInstallReceipt,
  skill: MarketSkillSummary,
): boolean {
  return receipt.slug === skill.slug
    && (receipt.version !== skill.version || receipt.sha256 !== skill.sha256)
}

export function getInstalledMarketSlug(skill: LoadedSkill): string | null {
  if (skill.origin !== 'top-level') return null
  const segments = skill.path.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return segments.at(-1) || null
}
