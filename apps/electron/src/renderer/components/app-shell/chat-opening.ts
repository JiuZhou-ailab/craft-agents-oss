// input: Workspace identity and real project content state for an empty chat session
// output: Unified opening copy, rotating tips, prompt starters, and real workspace commands
// pos: Product contract for the main chat empty state

export type ChatOpeningCommand = 'import-files' | 'create-file' | 'open-skills'

interface ChatOpeningActionBase {
  id: string
  labelKey: string
  descriptionKey: string
}

export interface ChatOpeningCommandAction extends ChatOpeningActionBase {
  kind: 'command'
  command: ChatOpeningCommand
}

export interface ChatOpeningPromptAction extends ChatOpeningActionBase {
  kind: 'prompt'
  promptKey: string
}

export type ChatOpeningAction = ChatOpeningCommandAction | ChatOpeningPromptAction

export interface ChatOpeningSection {
  id: 'project' | 'tools'
  labelKey: string
  actions: ChatOpeningAction[]
}

export interface ChatOpeningPrompt {
  titleKey: string
  workspaceName?: string
  hintKey: string
  tipKeys: string[]
  sections: ChatOpeningSection[]
  actions: ChatOpeningAction[]
}

export interface ResolveChatOpeningPromptInput {
  workspaceName?: string
  isProject?: boolean
  hasUserContent?: boolean
}

function commandAction(
  id: string,
  command: ChatOpeningCommand,
): ChatOpeningCommandAction {
  const keyPrefix = `chatOpening.${id}`
  return {
    id,
    kind: 'command',
    command,
    labelKey: `${keyPrefix}.label`,
    descriptionKey: `${keyPrefix}.desc`,
  }
}

function promptAction(id: string): ChatOpeningPromptAction {
  const keyPrefix = `chatOpening.${id}`
  return {
    id,
    kind: 'prompt',
    labelKey: `${keyPrefix}.label`,
    descriptionKey: `${keyPrefix}.desc`,
    promptKey: `${keyPrefix}.prompt`,
  }
}

const GENERAL_ACTIONS: ChatOpeningAction[] = [
  promptAction('tools.skill'),
  promptAction('tools.tutorial'),
]
const SHARED_TIP_KEYS = [
  'chatInput.placeholder.mention',
  'chatInput.placeholder.shiftTab',
  'chatInput.placeholder.labels',
  'chatInput.placeholder.newLine',
  'mode.askFullDesc',
  'mode.exploreFullDesc',
  'skillsList.emptyDescription',
  'sourcesList.emptyDescription',
]

export function pickRandomTipKeys(
  keys: string[],
  count: number,
  random: () => number = Math.random,
): string[] {
  const pool = [...keys]
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1))
    ;[pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]]
  }
  return pool.slice(0, Math.max(0, count))
}

export function getTipWindow(keys: string[], offset: number, count: number): string[] {
  if (keys.length === 0 || count <= 0) return []
  const start = ((offset % keys.length) + keys.length) % keys.length
  return Array.from(
    { length: Math.min(count, keys.length) },
    (_, index) => keys[(start + index) % keys.length],
  )
}

const PROJECT_ACTIONS: ChatOpeningAction[] = [
  commandAction('project.import', 'import-files'),
  commandAction('project.createFile', 'create-file'),
  commandAction('project.skills', 'open-skills'),
]

export function resolveChatOpeningPrompt({
  workspaceName,
  isProject = false,
  hasUserContent = false,
}: ResolveChatOpeningPromptInput): ChatOpeningPrompt {
  const actions = isProject ? PROJECT_ACTIONS : GENERAL_ACTIONS

  return {
    titleKey: isProject
      ? hasUserContent
        ? 'chatOpening.project.readyTitle'
        : 'chatOpening.project.emptyTitle'
      : 'chatOpening.general.title',
    workspaceName: isProject ? workspaceName?.trim() || undefined : undefined,
    hintKey: isProject
      ? hasUserContent
        ? 'chatOpening.project.readyHint'
        : 'chatOpening.project.emptyHint'
      : 'chatOpening.hint',
    tipKeys: SHARED_TIP_KEYS,
    sections: actions.length > 0
      ? [{
          id: isProject ? 'project' : 'tools',
          labelKey: isProject ? 'chatOpening.section.project' : 'chatOpening.section.tools',
          actions,
        }]
      : [],
    actions,
  }
}
