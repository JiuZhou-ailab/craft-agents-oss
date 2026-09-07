// input: Project or free-chat context for a new conversation panel
// output: Regression coverage for unified rotating tips, prompt starters, and project commands
// pos: Protects the shared empty-session opening contract shown before the first user message

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'

import { getTipWindow, pickRandomTipKeys, resolveChatOpeningPrompt } from '../chat-opening'

const zhHansLocale = JSON.parse(readFileSync(new URL('../../../../../../../packages/shared/src/i18n/locales/zh-Hans.json', import.meta.url), 'utf8'))

describe('resolveChatOpeningPrompt', () => {
  it('offers a content-empty project three real ways to begin', () => {
    const opening = resolveChatOpeningPrompt({
      workspaceName: '空白作品',
      isProject: true,
      hasUserContent: false,
    })

    expect(opening.titleKey).toBe('chatOpening.project.emptyTitle')
    expect(opening.hintKey).toBe('chatOpening.project.emptyHint')
    expect(opening.workspaceName).toBe('空白作品')
    expect(opening.sections.map(section => section.id)).toEqual(['project'])
    expect(opening.tipKeys).toHaveLength(8)
    expect(opening.actions.map(action => ({
      id: action.id,
      command: action.kind === 'command' ? action.command : null,
    }))).toEqual([
      { id: 'project.import', command: 'import-files' },
      { id: 'project.createFile', command: 'create-file' },
      { id: 'project.skills', command: 'open-skills' },
    ])
  })

  it('derives a ready project opening from real content instead of project metadata', () => {
    const opening = resolveChatOpeningPrompt({
      workspaceName: '已有作品',
      isProject: true,
      hasUserContent: true,
    })

    expect(opening.titleKey).toBe('chatOpening.project.readyTitle')
    expect(opening.hintKey).toBe('chatOpening.project.readyHint')
    expect(opening.actions.map(action => action.id)).toEqual([
      'project.import',
      'project.createFile',
      'project.skills',
    ])
  })

  it('combines rotating tips with compact prompt starters in free chat', () => {
    const opening = resolveChatOpeningPrompt({
      workspaceName: '自由对话',
      isProject: false,
      hasUserContent: false,
    })

    expect(opening.titleKey).toBe('chatOpening.general.title')
    expect(opening.workspaceName).toBeUndefined()
    expect(opening.sections.map(section => section.id)).toEqual(['tools'])
    expect(opening.actions.map(action => ({
      id: action.id,
      kind: action.kind,
      promptKey: action.kind === 'prompt' ? action.promptKey : null,
    }))).toEqual([
      { id: 'tools.skill', kind: 'prompt', promptKey: 'chatOpening.tools.skill.prompt' },
      { id: 'tools.tutorial', kind: 'prompt', promptKey: 'chatOpening.tools.tutorial.prompt' },
    ])
    expect(opening.tipKeys).toEqual([
      'chatInput.placeholder.mention',
      'chatInput.placeholder.shiftTab',
      'chatInput.placeholder.labels',
      'chatInput.placeholder.newLine',
      'mode.askFullDesc',
      'mode.exploreFullDesc',
      'skillsList.emptyDescription',
      'sourcesList.emptyDescription',
    ])
    const tips = pickRandomTipKeys(opening.tipKeys, 3, () => 0)
    expect(tips).toHaveLength(3)
    expect(new Set(tips).size).toBe(3)
  })

  it('cycles through a shuffled tip queue in three-item windows', () => {
    const queue = ['a', 'b', 'c', 'd', 'e']

    expect(getTipWindow(queue, 0, 3)).toEqual(['a', 'b', 'c'])
    expect(getTipWindow(queue, 3, 3)).toEqual(['d', 'e', 'a'])
    expect(getTipWindow(queue, 8, 3)).toEqual(['d', 'e', 'a'])
    expect(getTipWindow([], 3, 3)).toEqual([])
  })

  it('keeps project starter labels and descriptions concise', () => {
    const opening = resolveChatOpeningPrompt({
      workspaceName: '空白作品',
      isProject: true,
      hasUserContent: false,
    })

    for (const action of opening.actions) {
      expect(zhHansLocale[action.labelKey].length).toBeLessThanOrEqual(8)
      expect(zhHansLocale[action.descriptionKey].length).toBeLessThanOrEqual(14)
    }
  })
})
