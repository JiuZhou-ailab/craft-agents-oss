// input: Slash-menu Skill, command, and folder fixtures
// output: Regression proof for canonical Pi Skill insertion and menu filtering
// pos: Renderer-unit boundary for slash command behavior

import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { LoadedSkill } from '../../../../shared/types'
import type { SlashSection } from '../slash-command-menu'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))

let createSlashSkillItems: typeof import('../slash-command-menu').createSlashSkillItems
let createSlashFolderItems: typeof import('../slash-command-menu').createSlashFolderItems
let hasMatchingSlashItems: typeof import('../slash-command-menu').hasMatchingSlashItems
let getSlashSkillInsertionText: typeof import('../slash-command-menu').getSlashSkillInsertionText
let replaceSlashSkillSelection: typeof import('../slash-command-menu').replaceSlashSkillSelection
let parseInlineSlashCommandQuery: typeof import('../slash-command-menu').parseInlineSlashCommandQuery
let defaultSlashCommandGroups: typeof import('../slash-command-menu').DEFAULT_SLASH_COMMAND_GROUPS

beforeAll(async () => {
  const mod = await import('../slash-command-menu')
  createSlashSkillItems = mod.createSlashSkillItems
  createSlashFolderItems = mod.createSlashFolderItems
  hasMatchingSlashItems = mod.hasMatchingSlashItems
  getSlashSkillInsertionText = mod.getSlashSkillInsertionText
  replaceSlashSkillSelection = mod.replaceSlashSkillSelection
  parseInlineSlashCommandQuery = mod.parseInlineSlashCommandQuery
  defaultSlashCommandGroups = mod.DEFAULT_SLASH_COMMAND_GROUPS
})

function skill(overrides: Partial<LoadedSkill> & Pick<LoadedSkill, 'slug'>): LoadedSkill {
  return {
    slug: overrides.slug,
    metadata: {
      name: overrides.metadata?.name ?? overrides.slug,
      description: overrides.metadata?.description ?? '',
    },
    content: '',
    path: overrides.path ?? `/skills/${overrides.slug}`,
    filePath: overrides.filePath ?? `/skills/${overrides.slug}/SKILL.md`,
    scope: overrides.scope ?? 'user',
    source: overrides.source ?? 'pi',
    origin: overrides.origin ?? 'top-level',
    iconPath: overrides.iconPath,
  }
}

describe('slash skill commands', () => {
  it('selects a skill from the add menu without a slash query or losing the draft', () => {
    const result = replaceSlashSkillSelection('[skill:old] 保留中文草稿', 0, 0, skill({ slug: 'new' }))
    expect(result.value).toBe('[skill:new] 保留中文草稿')
    expect(result.cursorPosition).toBe(result.value.length)
  })
  it('offers only ask and direct-run permission modes', () => {
    expect(defaultSlashCommandGroups[0]?.commands.map(command => command.id))
      .toEqual(['ask', 'allow-all'])
  })

  it('maps skills into slash command items', () => {
    const items = createSlashSkillItems([
      skill({
        slug: 'review-pr',
        metadata: {
          name: 'Review PR',
          description: 'Review the current pull request',
        },
      }),
    ])

    expect(items).toEqual([
      {
        id: 'review-pr',
        type: 'skill',
        label: 'Review PR',
        description: 'Review the current pull request',
        searchText: 'review pr review-pr review the current pull request',
        skill: items[0]!.skill,
      },
    ])
  })

  it('inserts selected Skills as global mention tokens', () => {
    expect(getSlashSkillInsertionText(skill({ slug: 'review-pr' }))).toBe('[skill:review-pr] ')
  })

  it('keeps one top-level Skill and moves it to the prompt start', () => {
    expect(replaceSlashSkillSelection(
      'draft [skill:first] /review-pr more',
      20,
      30,
      skill({ slug: 'review-pr' }),
    )).toEqual({
      value: '[skill:review-pr] draft more',
      cursorPosition: 28,
    })
  })

  it('keeps hyphenated skill names in the slash query', () => {
    expect(parseInlineSlashCommandQuery('/review-pr')).toEqual({ start: 0, filter: 'review-pr' })
    expect(parseInlineSlashCommandQuery('please /review-pr')).toEqual({ start: 7, filter: 'review-pr' })
  })

  it('opens slash commands after no-space CJK text without treating latin words as commands', () => {
    expect(parseInlineSlashCommandQuery('帮我/')).toEqual({ start: 2, filter: '' })
    expect(parseInlineSlashCommandQuery('帮我/审查')).toEqual({ start: 2, filter: '审查' })
    expect(parseInlineSlashCommandQuery('path/to')).toBeNull()
  })

  it('builds sorted folder items from precomputed folder display data', () => {
    const items = createSlashFolderItems([
      '/Users/zjding/work/beta',
      '/Users/zjding/work/Alpha',
      '/tmp/zeta',
    ], '/Users/zjding')

    expect(items.map(item => item.label)).toEqual(['Alpha', 'beta', 'zeta'])
    expect(items.map(item => item.description)).toEqual([
      '~/work/Alpha',
      '~/work/beta',
      '/tmp/zeta',
    ])
    expect(items.find(item => item.label === 'Alpha')?.searchText).toBe('alpha /users/zjding/work/alpha ~/work/alpha')
  })

  it('checks whether slash sections contain a filter match without rebuilding sections', () => {
    const sections: SlashSection[] = [
      {
        id: 'commands',
        label: 'Commands',
        items: [
          {
            id: 'compact',
            label: 'Compact Context',
            description: 'Summarize conversation context',
            icon: null,
          },
        ],
      },
      {
        id: 'folders',
        label: 'Folders',
        items: createSlashFolderItems(['/Users/zjding/work/Alpha'], '/Users/zjding'),
      },
    ]

    expect(hasMatchingSlashItems(sections, '')).toBe(true)
    expect(hasMatchingSlashItems(sections, 'alp')).toBe(true)
    expect(hasMatchingSlashItems(sections, '~/work')).toBe(true)
    expect(hasMatchingSlashItems(sections, 'missing')).toBe(false)
  })

  it('memoizes inline slash filtering and flattening in the menu render path', () => {
    const source = readFileSync(new URL('../slash-command-menu.tsx', import.meta.url), 'utf-8')

    expect(source).toContain('const filteredSections = React.useMemo(')
    expect(source).toContain('() => filterSections(sections, filter)')
    expect(source).toContain('[sections, filter]')
    expect(source).toContain('const flatItems = React.useMemo(')
    expect(source).toContain('() => flattenSections(filteredSections)')
    expect(source).toContain('[filteredSections]')
    expect(source).not.toContain('const filteredSections = filterSections(sections, filter)')
    expect(source).not.toContain('const flatItems = flattenSections(filteredSections)')
  })

  it('precomputes slash item search text for inline menu filtering', () => {
    const source = readFileSync(new URL('../slash-command-menu.tsx', import.meta.url), 'utf-8')
    const matcherStart = source.indexOf('function slashItemMatchesFilter')
    const matcherEnd = source.indexOf('export function hasMatchingSlashItems', matcherStart)
    const matcherSource = source.slice(matcherStart, matcherEnd)

    expect(source).toContain('searchText: buildSlashItemSearchText(')
    expect(matcherSource).toContain('if (item.searchText) return item.searchText.includes(lowerFilter)')
    expect(matcherSource).not.toContain('item.label.toLowerCase().includes(lowerFilter)')
  })

  it('keeps the floating menu distinct from the composer surface', () => {
    const source = readFileSync(new URL('../slash-command-menu.tsx', import.meta.url), 'utf-8')
    const inputSource = readFileSync(new URL('../../app-shell/input/FreeFormInput.tsx', import.meta.url), 'utf-8')
    const inlineSource = source.slice(
      source.indexOf('export function InlineSlashCommand'),
      source.indexOf('// Hook for managing inline slash command state'),
    )

    expect(source).toContain("const INLINE_MENU_CONTAINER_STYLE = 'overflow-hidden rounded-[16px] border border-border/70 bg-foreground-5")
    expect(inlineSource).toContain('INLINE_MENU_CONTAINER_STYLE')
    expect(inlineSource).toContain('flatItems.map')
    expect(inlineSource).not.toContain('section.label')
    expect(inlineSource).not.toContain('Use @ to attach')
    expect(inlineSource).toContain('width: Math.round(anchorRect.width)')
    expect(inputSource).toContain('anchorRef={containerRef}')
    expect(inputSource).toContain('aria-controls={inlineSlash.isOpen ? slashListboxId : undefined}')
    expect(inputSource).toContain('aria-activedescendant={activeSlashOptionId}')
    expect(source).toContain('id={`${listboxId}-option-${itemIndex}`}')
    expect(source).toContain('shrink-0 size-3 rounded-full bg-blue-500')
    expect(source).toContain('Check className="size-2 text-white"')
    expect(source).not.toContain('rounded-full bg-current')
  })
})
