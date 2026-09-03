// input: Chat input state, IME metadata, and dropped file-system entry fixtures
// output: Regression coverage for input decisions and recursive directory attachments
// pos: Guards chat composer behavior without importing heavyweight UI dependencies

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { THINKING_LEVELS } from '@craft-agent/shared/agent/thinking-levels'
import {
  MAX_DROPPED_ATTACHMENT_FILES,
  assignSharedInputHandle,
  collectDroppedFiles,
  getAttachmentBatchLimitError,
  getPrimaryInputAction,
  groupModelMenuOptions,
  isCompositionInput,
  readAttachmentBatch,
  resolveAutoCapitalisedInput,
  shouldShowTextInput,
} from '../free-form-input-behavior'

describe('FreeFormInput behavior helpers', () => {
  describe('isCompositionInput', () => {
    it('treats browser composition input types as composition input', () => {
      expect(isCompositionInput({ inputType: 'insertCompositionText' })).toBe(true)
      expect(isCompositionInput({ inputType: 'insertFromComposition' })).toBe(true)
    })
  })

  describe('resolveAutoCapitalisedInput', () => {
  it('does not rewrite IME composition text', () => {
      expect(resolveAutoCapitalisedInput('n', 1, {
        enabled: true,
        isCompositionInput: true,
      })).toBeNull()
    })

    it('capitalises ordinary latin input when enabled', () => {
      expect(resolveAutoCapitalisedInput('hello', 1, {
        enabled: true,
        isCompositionInput: false,
      })).toEqual({ text: 'Hello', cursor: 1 })
    })

    it('leaves commands and mentions unchanged', () => {
      expect(resolveAutoCapitalisedInput('/compact', 1, {
        enabled: true,
        isCompositionInput: false,
      })).toBeNull()
      expect(resolveAutoCapitalisedInput('@skill', 1, {
        enabled: true,
        isCompositionInput: false,
      })).toBeNull()
      expect(resolveAutoCapitalisedInput('#label', 1, {
        enabled: true,
        isCompositionInput: false,
      })).toBeNull()
    })
  })

  describe('getPrimaryInputAction', () => {
    it('uses send while processing when there is draft content to queue', () => {
      expect(getPrimaryInputAction({
        isProcessing: true,
        hasContent: true,
        disabled: false,
        disableSend: false,
      })).toBe('send')
    })

    it('uses stop while processing with an empty draft', () => {
      expect(getPrimaryInputAction({
        isProcessing: true,
        hasContent: false,
        disabled: false,
        disableSend: false,
      })).toBe('stop')
    })

    it('keeps send as the primary action for a draft while processing even when sending is disabled', () => {
      expect(getPrimaryInputAction({
        isProcessing: true,
        hasContent: true,
        disabled: true,
        disableSend: true,
      })).toBe('send')
    })
  })

  describe('shouldShowTextInput', () => {
    it('keeps compact input visible while the agent is processing', () => {
      expect(shouldShowTextInput({
        compactMode: true,
        isProcessing: true,
      })).toBe(true)
    })
  })

  describe('readAttachmentBatch', () => {
    it('limits concurrent file reads and keeps successful attachments ordered', async () => {
      let started = 0
      let releaseFirst: () => void = () => {
        throw new Error('first read was not started')
      }
      let releaseSecond: () => void = () => {
        throw new Error('second read was not started')
      }

      const resultPromise = readAttachmentBatch(['first', 'second', 'third'], async (file, index) => {
        started++
        if (file === 'first') {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
        }
        if (file === 'second') {
          await new Promise<void>((resolve) => {
            releaseSecond = resolve
          })
          return null
        }
        return {
          type: 'text',
          path: file,
          name: `${index}:${file}`,
          mimeType: 'text/plain',
          size: 1,
        }
      }, 2)

      await Promise.resolve()
      expect(started).toBe(2)

      releaseFirst()
      await Promise.resolve()
      await Promise.resolve()
      expect(started).toBe(3)

      releaseSecond()
      await expect(resultPromise).resolves.toEqual([
        {
          type: 'text',
          path: 'first',
          name: '0:first',
          mimeType: 'text/plain',
          size: 1,
        },
        {
          type: 'text',
          path: 'third',
          name: '2:third',
          mimeType: 'text/plain',
          size: 1,
        },
      ])
    })
  })

  describe('collectDroppedFiles', () => {
    it('expands dropped directories, drains reader batches, and preserves relative paths', async () => {
      const rootFile = new File(['root'], 'root.txt', { type: 'text/plain' })
      const childFile = new File(['child'], 'child.txt', { type: 'text/plain' })
      const looseFile = new File(['loose'], 'loose.txt', { type: 'text/plain' })

      const fileEntry = (name: string, file: File): FileSystemFileEntry => ({
        name,
        fullPath: `/${name}`,
        isFile: true,
        isDirectory: false,
        file: (success) => success(file),
      } as FileSystemFileEntry)
      const directoryEntry = (
        name: string,
        batches: FileSystemEntry[][],
      ): FileSystemDirectoryEntry => ({
        name,
        fullPath: `/${name}`,
        isFile: false,
        isDirectory: true,
        createReader: () => ({
          readEntries: (success) => success(batches.shift() ?? []),
        }),
      } as FileSystemDirectoryEntry)

      const nested = directoryEntry('nested', [[fileEntry('child.txt', childFile)], []])
      const project = directoryEntry('project', [
        [fileEntry('root.txt', rootFile)],
        [nested],
        [],
      ])
      const dropped = await collectDroppedFiles({
        items: [
          { kind: 'file', webkitGetAsEntry: () => project },
          { kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => looseFile },
        ],
        files: [],
      })

      expect(dropped.files.map(({ file, relativePath }) => [file.name, relativePath])).toEqual([
        ['root.txt', 'project/root.txt'],
        ['child.txt', 'project/nested/child.txt'],
        ['loose.txt', 'loose.txt'],
      ])
      expect(dropped.skippedSensitiveFiles).toBe(0)
    })

    it('skips sensitive files discovered inside a directory but keeps an explicitly dropped file', async () => {
      const secret = new File(['secret'], '.env', { type: 'text/plain' })
      const fileEntry = (name: string, file: File): FileSystemFileEntry => ({
        name,
        fullPath: `/${name}`,
        isFile: true,
        isDirectory: false,
        file: (success) => success(file),
      } as FileSystemFileEntry)
      const project = {
        name: 'project',
        fullPath: '/project',
        isFile: false,
        isDirectory: true,
        createReader: () => {
          const batches: FileSystemEntry[][] = [[fileEntry('.env', secret)], []]
          return { readEntries: (success: (entries: FileSystemEntry[]) => void) => success(batches.shift() ?? []) }
        },
      } as FileSystemDirectoryEntry

      const nested = await collectDroppedFiles({
        items: [{ kind: 'file', webkitGetAsEntry: () => project }],
        files: [],
      })
      const explicit = await collectDroppedFiles({
        items: [{ kind: 'file', webkitGetAsEntry: () => fileEntry('.env', secret) }],
        files: [],
      })

      expect(nested.files).toEqual([])
      expect(nested.skippedSensitiveFiles).toBe(1)
      expect(explicit.files).toHaveLength(1)
      expect(explicit.skippedSensitiveFiles).toBe(0)
    })

    it('rejects attachment batches that exceed the file-count limit', () => {
      const files = Array.from(
        { length: MAX_DROPPED_ATTACHMENT_FILES + 1 },
        () => ({ size: 1 }),
      )

      expect(getAttachmentBatchLimitError(files)).toBe('too_many_files')
    })
  })
})

describe('FreeFormInput attachment read path', () => {
  it('uses main-side user attachment reads before renderer FileReader for path-backed files', () => {
    const source = readFileSync(new URL('../FreeFormInput.tsx', import.meta.url), 'utf-8')
    const helperStart = source.indexOf('const readFileAsAttachment = async')
    const helperEnd = source.indexOf('const processFileAttachments = async', helperStart)
    const helperSource = source.slice(helperStart, helperEnd)

    expect(helperSource).toContain('window.electronAPI.readUserAttachment(realPath)')
    expect(helperSource.indexOf('window.electronAPI.readUserAttachment(realPath)')).toBeLessThan(
      helperSource.indexOf('new FileReader()'),
    )
  })

  it('uses the existing attachment preview flow for files and dropped directories', () => {
    const source = readFileSync(new URL('../FreeFormInput.tsx', import.meta.url), 'utf-8')
    const pickerStart = source.indexOf('const renderAttachmentPicker')
    const pickerEnd = source.indexOf('\n\n  return (', pickerStart)
    const pickerSource = source.slice(pickerStart, pickerEnd)

    expect(source).toContain('collectDroppedFiles(e.dataTransfer)')
    expect(source).toContain('processFileAttachments(files, relativePaths)')
    expect(pickerSource).not.toContain('<DropdownMenu>')
    expect(pickerSource).toContain('onClick={handleAttachClick}')
    expect(pickerSource).toContain('icon={<Paperclip')
    expect(pickerSource).not.toContain('FolderUp')
  })

  it('collapses the desktop attachment and source controls into one add menu', () => {
    const source = readFileSync(new URL('../FreeFormInput.tsx', import.meta.url), 'utf-8')
    const desktopStart = source.indexOf('{/* Desktop: one add menu')
    const desktopEnd = source.indexOf('{/* Right side:', desktopStart)
    const desktopSource = source.slice(desktopStart, desktopEnd)

    expect(desktopSource).toContain('<Plus className="h-4 w-4" />')
    expect(desktopSource).toContain('onSelect={handleAttachClick}')
    expect(desktopSource).toContain("setSourceDropdownOpen(true)")
    expect(desktopSource).toContain('data-tutorial="source-selector-button"')
    expect(desktopSource).not.toContain('renderAttachmentPicker(!!isEmptySession)')
  })

  it('uses text color alone for the desktop permission mode state', () => {
    const source = readFileSync(new URL('../DesktopPermissionModeSelector.tsx', import.meta.url), 'utf-8')
    const colorsStart = source.indexOf('const currentColor =')
    const colorsEnd = source.indexOf('\n\n  return (', colorsStart)
    const colorsSource = source.slice(colorsStart, colorsEnd)

    expect(colorsSource).toContain("ask: 'text-info'")
    expect(colorsSource).toContain("'allow-all': 'text-accent'")
    expect(colorsSource).not.toContain('bg-')
    expect(source).not.toContain('shadow-tinted')
  })

  it('scopes asynchronous attachment imports to the active session and blocks send while loading', () => {
    const inputContainerSource = readFileSync(new URL('../InputContainer.tsx', import.meta.url), 'utf-8')
    const inputSource = readFileSync(new URL('../FreeFormInput.tsx', import.meta.url), 'utf-8')

    expect(inputContainerSource).toContain("`freeform-${freeFormProps.sessionId ?? 'unscoped'}`")
    expect(inputSource).toContain('if (!hasContent || disabled || loadingCount > 0) return false')
    expect(inputSource).toContain('disabled={!hasContent || disabled || disableSend || loadingCount > 0}')
  })

  it('restores a path-backed attachment with its persisted relative display name', () => {
    const appSource = readFileSync(new URL('../../../../App.tsx', import.meta.url), 'utf-8')

    expect(appSource).toContain('return { ...attachment, name: ref.name }')
  })
})

describe('FreeFormInput model menu', () => {
  it('groups concrete models under their ordered series', () => {
    expect(groupModelMenuOptions([
      { id: 'gpt-5.5', name: 'GPT-5.5', series: 'GPT' },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', series: 'GPT' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', series: 'GPT' },
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', series: 'Gemini' },
    ])).toEqual([
      {
        name: 'GPT',
        models: [
          { id: 'gpt-5.5', name: 'GPT-5.5', series: 'GPT' },
          { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', series: 'GPT' },
          { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', series: 'GPT' },
        ],
      },
      {
        name: 'Gemini',
        models: [{ id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', series: 'Gemini' }],
      },
    ])
  })

  it('puts thinking strength beside model series instead of inside each model', () => {
    const source = readFileSync(new URL('../FreeFormInput.tsx', import.meta.url), 'utf-8')

    expect(source).toContain('modelSupportsThinking(effectiveConnectionDetails, currentModel)')
    expect(source).toContain('modelSupportsThinkingLevel(effectiveConnectionDetails, currentModel, id)')
    expect(source).toContain('resolveModelThinkingLevel(effectiveConnectionDetails, currentModel, thinkingLevel)')
    expect(source).toContain('<StyledDropdownMenuSubTrigger')
    expect(source).toContain("{t('settings.ai.thinking')}")
    expect(source).toContain('renderThinkingMenuItem()')
    expect(THINKING_LEVELS.find(({ id }) => id === 'xhigh')?.descriptionKey)
      .toBe('thinking.extendedDesc')
    expect(source).not.toContain('thinkingDisabled')
    expect(source).not.toContain('getThinkingLevelNameKey')
  })

  it('projects every managed model family only before the session starts', () => {
    const source = readFileSync(new URL('../FreeFormInput.tsx', import.meta.url), 'utf-8')

    expect(source).toContain('if (isManagedLlmConnectionSlug(conn.slug)) return null')
    expect(source).toContain('const managedModelSeries = React.useMemo')
    expect(source).toContain('isManagedLlmConnectionSlug(connection.slug)')
    expect(source).toContain('managedModelSeries.map(({ connection, series })')
    expect(source).toContain('selectModel: modelId => onModelChange(modelId, connection.slug)')
    expect(source).toContain('const customConnectionsByProvider = React.useMemo')
    expect(source).toContain('!isManagedLlmConnectionSlug(currentConnectionDetails.slug)')
    expect(source).toContain(') : isEmptySession && isManagedEffectiveConnection ? (')
  })

  it('keeps the full model name and thinking strength visible in the bottom toolbar', () => {
    const source = readFileSync(new URL('../FreeFormInput.tsx', import.meta.url), 'utf-8')

    expect(source).toContain('const currentThinkingLabel =')
    expect(source).toContain(": t('thinking.off')")
    expect(source).toContain('max-w-[240px]')
    expect(source).toContain('· {currentThinkingLabel}')
    expect(source).toContain('`${currentModelDisplayName} · ${currentThinkingLabel}`')
    expect(source).not.toContain("{t('settings.ai.thinking')}: {currentThinkingLabel}")
  })

  it('projects a successful model switch into the current window', () => {
    const source = readFileSync(new URL('../../../../pages/ChatPage.tsx', import.meta.url), 'utf-8')
    const handlerStart = source.indexOf('const handleModelChange = React.useCallback')
    const handlerEnd = source.indexOf('// Session connection change handler', handlerStart)
    const handlerSource = source.slice(handlerStart, handlerEnd)

    expect(source).toContain('updateSessionAtom')
    expect(handlerSource).toContain('await window.electronAPI.setSessionModel')
    expect(handlerSource).toContain('updateSession(sessionId, current => current && {')
    expect(handlerSource.indexOf('await window.electronAPI.setSessionModel')).toBeLessThan(
      handlerSource.indexOf('updateSession(sessionId, current => current && {'),
    )
  })

  it('uses DeepSeek identity independently of its OpenAI-compatible protocol', () => {
    const source = readFileSync(new URL('../../../icons/ConnectionIcon.tsx', import.meta.url), 'utf-8')
    const providerIconSource = readFileSync(new URL('../../../../lib/provider-icons.ts', import.meta.url), 'utf-8')

    expect(source).toContain('MANAGED_DEEPSEEK_CONNECTION_SLUG')
    expect(source).toContain("? getProviderIcon('pi', null, 'deepseek')")
    expect(providerIconSource).toContain("import deepseekIcon from '@/assets/provider-icons/deepseek.svg'")
    expect(providerIconSource).toContain("case 'deepseek':")
  })

  it('gives the activity rail a slightly stronger default weight', () => {
    const source = readFileSync(new URL('../../ActivityRail.tsx', import.meta.url), 'utf-8')

    expect(source).toContain('bg-foreground-1.5 font-medium')
  })
})

describe('FreeFormInput render hot paths', () => {
  it('memoizes source and skill lookups used while typing', () => {
    const source = readFileSync(new URL('../FreeFormInput.tsx', import.meta.url), 'utf-8')

    expect(source).toContain('const skillSlugs = React.useMemo')
    expect(source).toContain('const sourceSlugs = React.useMemo')
    expect(source).toContain('const selectedSourcesForBadge = React.useMemo')
    expect(source).not.toContain('const skillSlugs = skills.map')
    expect(source).not.toContain('const sourceSlugs = sources.map')
    expect(source.match(/sources\.filter\(s => optimisticSourceSlugs\.includes\(s\.config\.slug\)\)/g) ?? []).toHaveLength(0)
  })

  it('skips source mention parsing for ordinary input changes without source tokens', () => {
    const source = readFileSync(new URL('../FreeFormInput.tsx', import.meta.url), 'utf-8')
    const handlerStart = source.indexOf('const handleInputChange = React.useCallback')
    const handlerEnd = source.indexOf('const handleRichInput = React.useCallback', handlerStart)
    const handlerSource = source.slice(handlerStart, handlerEnd)

    expect(handlerSource).toContain("const mayHaveSourceMentions = prevValue.includes('[source:') || nextValue.includes('[source:')")
    expect(handlerSource).toContain('if (onSourcesChange && mayHaveSourceMentions)')
    expect(handlerSource).toContain('const currentSourceSet = new Set(currMentions.sources)')
    expect(handlerSource).not.toContain('!currMentions.sources.includes(slug)')
  })

  it('skips inline menu detectors for ordinary rich text input without triggers', () => {
    const source = readFileSync(new URL('../FreeFormInput.tsx', import.meta.url), 'utf-8')
    const handlerStart = source.indexOf('const handleRichInput = React.useCallback')
    const handlerEnd = source.indexOf('// Handle inline slash command selection', handlerStart)
    const handlerSource = source.slice(handlerStart, handlerEnd)

    expect(handlerSource).toContain('const textBeforeCursor = nextValue.slice(0, cursorPosition)')
    expect(handlerSource).toContain("if (inlineSlash.isOpen || textBeforeCursor.includes('/'))")
    expect(handlerSource).toContain("if (inlineMention.isOpen || textBeforeCursor.includes('@'))")
    expect(handlerSource).toContain("if (inlineLabel.isOpen || textBeforeCursor.includes('#'))")
    expect(handlerSource).not.toContain('// Update inline slash command state\n    inlineSlash.handleInputChange(nextValue, cursorPosition)')
  })

  it('keeps a local rich-text handle so session remounts cannot null the shared parent ref', () => {
    const source = readFileSync(new URL('../FreeFormInput.tsx', import.meta.url), 'utf-8')
    expect(source).toContain('assignSharedInputHandle')
    expect(source).toContain('ref={assignRichInputRef}')
    expect(source).not.toContain('const richInputRef = externalInputRef || internalInputRef')
  })
})

describe('assignSharedInputHandle', () => {
  it('preserves the surviving instance when the exiting instance unmounts', () => {
    const shared = { current: null as string | null }
    const exiting = { current: null as string | null }
    const surviving = { current: null as string | null }

    assignSharedInputHandle(exiting, shared, 'exit-handle')
    assignSharedInputHandle(surviving, shared, 'live-handle')
    expect(shared.current).toBe('live-handle')

    // AnimatePresence unmount order: exiting instance clears after survivor mounted.
    assignSharedInputHandle(exiting, shared, null)
    expect(shared.current).toBe('live-handle')
    expect(exiting.current).toBeNull()
    expect(surviving.current).toBe('live-handle')
  })

  it('clears the shared ref when the owning instance unmounts alone', () => {
    const shared = { current: null as string | null }
    const only = { current: null as string | null }

    assignSharedInputHandle(only, shared, 'only-handle')
    assignSharedInputHandle(only, shared, null)
    expect(shared.current).toBeNull()
  })
})
