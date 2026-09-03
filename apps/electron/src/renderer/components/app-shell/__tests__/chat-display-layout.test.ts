// input: ChatDisplay, prompt TOC, composer, and ScrollArea source contracts.
// output: Regression coverage for owned transcript scrolling, prompt navigation, and composer layout.
// pos: Source-level guard for the app-shell chat panel viewport and navigation.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolveActivePromptIndex } from '../PromptTableOfContents'

const chatDisplaySource = readFileSync(new URL('../ChatDisplay.tsx', import.meta.url), 'utf-8')
const promptTocSource = readFileSync(new URL('../PromptTableOfContents.tsx', import.meta.url), 'utf-8')
const chatInputZoneSource = readFileSync(new URL('../input/ChatInputZone.tsx', import.meta.url), 'utf-8')
const freeFormInputSource = readFileSync(new URL('../input/FreeFormInput.tsx', import.meta.url), 'utf-8')
const scrollAreaSource = readFileSync(new URL('../../ui/scroll-area.tsx', import.meta.url), 'utf-8')

describe('ChatDisplay scroll layout', () => {
  it('keeps the transcript viewport explicitly scrollable inside a clipped flex area', () => {
    expect(scrollAreaSource).toContain('viewportClassName?: string')
    expect(chatDisplaySource).toContain('className="relative flex-1 min-h-0 overflow-hidden"')
    expect(chatDisplaySource).toContain('className="h-full min-h-0 overflow-hidden"')
    expect(chatDisplaySource).toContain('viewportClassName="h-full min-h-0 overflow-y-auto overscroll-contain"')
    expect(chatDisplaySource).toContain('compactMode ? "px-3 py-4 space-y-2" : [CHAT_LAYOUT.containerPaddingX, "pt-12 pb-8", CHAT_LAYOUT.messageSpacing]')
    expect(chatDisplaySource).toContain('scrollViewportRef.current')
    expect(chatDisplaySource).not.toContain('scrollIntoView(')
  })

  it('renders queued user messages above the input instead of inside the transcript', () => {
    expect(chatDisplaySource).toContain('const partitionedMessages = React.useMemo')
    expect(chatDisplaySource).toContain('const queuedUserMessages = partitionedMessages.queuedUserMessages')
    expect(chatDisplaySource).toContain('const transcriptMessages = partitionedMessages.transcriptMessages')
    expect(chatDisplaySource).toContain("message.role === 'user' && message.isQueued")
    expect(chatDisplaySource).not.toContain('const queuedUserMessages = React.useMemo')
    expect(chatDisplaySource).not.toContain('const transcriptMessages = React.useMemo')
    expect(chatDisplaySource).toContain('groupMessagesByTurn(transcriptMessages)')
    expect(chatDisplaySource).toContain('queuedMessages={queuedUserMessages}')
    expect(chatDisplaySource).toContain('forceQueuePreview: session?.isProcessing === true')
    expect(chatInputZoneSource).toContain('queuedMessages?: QueuedInputMessage[]')
    expect(chatInputZoneSource).toContain('queuedMessages.length > 0')
    expect(chatInputZoneSource).toContain("t('chat.queuedBadge')")
  })

  it('ends turn-card thinking when the session lifecycle is idle', () => {
    expect(chatDisplaySource).toContain('const isTurnComplete = turn.isComplete || !session.isProcessing')
    expect(chatDisplaySource).toContain('const turnFileChanges = isTurnComplete')
    expect(chatDisplaySource).toContain('isComplete={isTurnComplete}')
    expect(chatDisplaySource).toContain('isTurnExpanded(assistantUiKey, isTurnComplete)')
    expect(chatDisplaySource).toContain('toggleTurn(assistantUiKey, isTurnComplete, expanded)')
  })

  it('never exposes an action that interrupts the active answer from the queue preview', () => {
    expect(chatInputZoneSource).not.toContain('onSendQueuedMessageNow')
    expect(chatInputZoneSource).not.toContain("t('chat.sendQueuedNow')")
    expect(chatDisplaySource).not.toContain("type: 'sendQueuedMessageNow'")
    expect(chatDisplaySource).not.toContain('handleSendQueuedMessageNow')
  })

  it('wires queued message previews to edit and delete actions', () => {
    expect(chatInputZoneSource).toContain('onEditQueuedMessage?: (message: QueuedInputMessage) => void')
    expect(chatInputZoneSource).toContain('onRemoveQueuedMessage?: (messageId: string) => void')
    expect(chatInputZoneSource).toContain('onEditQueuedMessage?.(message)')
    expect(chatInputZoneSource).toContain('onRemoveQueuedMessage?.(message.id)')
    expect(chatDisplaySource).toContain("type: 'removeQueuedMessage'")
    expect(chatDisplaySource).toContain('onEditQueuedMessage={handleEditQueuedMessage}')
    expect(chatDisplaySource).toContain('onRemoveQueuedMessage={handleRemoveQueuedMessage}')
  })

  it('renders a session prompt toc instead of per-message hover cards', () => {
    expect(chatDisplaySource).not.toContain('QueryPreviewPopover')
    expect(chatDisplaySource).not.toContain('getQueryReplyPreview')
    expect(chatDisplaySource).toContain('<PromptTableOfContents')
    expect(chatDisplaySource).toContain('const promptTocItems')
    expect(chatDisplaySource).toContain('scrollToTurnIndex')
    expect(promptTocSource).toContain('max-h-[50lvh] w-9 overflow-clip')
    expect(promptTocSource).toContain('data-toc-item-index={index}')
    expect(promptTocSource).toContain("'h-0.5 w-6 bg-foreground'")
    expect(promptTocSource).toContain('group-hover/toc-tick:w-[22px]')
    expect(promptTocSource).toContain('transition-[opacity,transform] duration-150')
    expect(promptTocSource).toContain('group-hover/prompt-toc:visible')
  })

  it('selects the prompt nearest the upper viewport reading line', () => {
    expect(resolveActivePromptIndex([null, 40, 160, 320], 120)).toBe(1)
    expect(resolveActivePromptIndex([null, 160, 320], 120)).toBe(1)
    expect(resolveActivePromptIndex([-320, -40, null], 120)).toBe(1)
    expect(resolveActivePromptIndex([null, null], 120)).toBe(-1)
  })

  it('reuses label lookup data when adding labels from the composer', () => {
    expect(chatInputZoneSource).toContain('const labelById = React.useMemo')
    expect(chatInputZoneSource).toContain('new Map(flattenLabels(labels).map(label => [label.id, label]))')
    expect(chatInputZoneSource).toContain('const config = labelById.get(labelId)')
    expect(chatInputZoneSource).not.toContain('flattenLabels(labels || []).find')
  })

  it('keeps the composer toolbar actions visible in narrow side panels', () => {
    expect(freeFormInputSource).toContain('flex min-w-0 items-center gap-1 px-2 py-2')
    expect(freeFormInputSource).toContain('flex min-w-0 flex-1 items-center gap-1 overflow-hidden')
    expect(freeFormInputSource).not.toContain('<div className="min-w-1 flex-1" />')
    expect(freeFormInputSource).toContain('flex min-w-0 max-w-[52%] items-center justify-end shrink-0')
    expect(freeFormInputSource).toContain('input-toolbar-btn inline-flex !h-7 min-w-0 max-w-[240px]')
    expect(freeFormInputSource).toContain('<span className="min-w-0 truncate">{currentModelDisplayName}</span>')
  })

  it('centers and advances the three opening tips every ten seconds', () => {
    expect(chatDisplaySource).toContain('window.setInterval')
    expect(chatDisplaySource).toContain('10_000')
    expect(chatDisplaySource).toContain('window.clearInterval')
    expect(chatDisplaySource).toContain('tipsPaused || shouldReduceMotion')
    expect(chatDisplaySource).toContain("key={session?.id ?? 'new-session'}")
    expect(chatDisplaySource).toContain('mx-auto mt-6 w-fit max-w-[520px]')
  })
})
