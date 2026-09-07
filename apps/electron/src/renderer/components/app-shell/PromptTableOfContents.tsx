// input: Session turns, user-query anchors, transcript viewport, and turn element refs
// output: Compact prompt ticks with a full hover/focus prompt list and scroll navigation
// pos: Session-local transcript table of contents beside ChatDisplay

import * as React from 'react'
import type { Turn } from '@craft-agent/ui/chat/turn-utils'
import { sanitizePreview } from '@/utils/session'
import { cn } from '@/lib/utils'

export interface PromptTocItem {
  id: string
  label: string
  turnIndex: number
}

export function buildPromptTocItems(turns: readonly Turn[]): PromptTocItem[] {
  const items: PromptTocItem[] = []
  turns.forEach((turn, turnIndex) => {
    if (turn.type === 'user') {
      items.push({
        id: `user-${turn.message.id}`,
        label: sanitizePreview(turn.message.content) || `Prompt ${items.length + 1}`,
        turnIndex,
      })
    }
  })
  return items
}

export function resolveActivePromptIndex(
  itemTops: readonly (number | null)[],
  activationY: number,
): number {
  let firstRenderedIndex = -1
  let activeIndex = -1

  for (let index = 0; index < itemTops.length; index += 1) {
    const top = itemTops[index]
    if (top == null) continue
    if (firstRenderedIndex === -1) firstRenderedIndex = index

    if (top <= activationY) {
      activeIndex = index
      continue
    }

    if (activeIndex === -1) return index
    break
  }

  return activeIndex === -1 ? firstRenderedIndex : activeIndex
}

export function PromptTableOfContents({
  items,
  viewportRef,
  turnRefs,
  onSelect,
}: {
  items: readonly PromptTocItem[]
  viewportRef: React.RefObject<HTMLDivElement | null>
  turnRefs: React.RefObject<Map<string, HTMLDivElement>>
  onSelect: (turnIndex: number) => void
}) {
  const [activeIndex, setActiveIndex] = React.useState(0)
  const [open, setOpen] = React.useState(false)
  const listRef = React.useRef<HTMLDivElement>(null)
  const activeItemRef = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    if (!open) return
    const list = listRef.current
    const active = activeItemRef.current
    if (list && active) {
      list.scrollTop = active.offsetTop - (list.clientHeight - active.clientHeight) / 2
    }
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const focusedItem = document.activeElement?.closest<HTMLElement>('[data-toc-list-index]')
      if (focusedItem && list?.contains(focusedItem)) {
        list.closest('nav')?.querySelector<HTMLButtonElement>(`[data-toc-item-index="${focusedItem.dataset.tocListIndex}"]`)?.focus()
      }
      setOpen(false)
    }
    document.addEventListener('keydown', dismiss)
    return () => document.removeEventListener('keydown', dismiss)
  }, [open])

  const syncActivePrompt = React.useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const viewportRect = viewport.getBoundingClientRect()
    const activationY = viewportRect.top + viewport.clientHeight * 0.35
    const nextIndex = resolveActivePromptIndex(
      items.map(item => turnRefs.current?.get(item.id)?.getBoundingClientRect().top ?? null),
      activationY,
    )

    if (nextIndex >= 0) {
      setActiveIndex(current => current === nextIndex ? current : nextIndex)
    }
  }, [items, turnRefs, viewportRef])

  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    let frameId: number | null = null
    const scheduleSync = () => {
      if (frameId != null) return
      frameId = requestAnimationFrame(() => {
        frameId = null
        syncActivePrompt()
      })
    }

    scheduleSync()
    viewport.addEventListener('scroll', scheduleSync, { passive: true })
    window.addEventListener('resize', scheduleSync)

    return () => {
      viewport.removeEventListener('scroll', scheduleSync)
      window.removeEventListener('resize', scheduleSync)
      if (frameId != null) cancelAnimationFrame(frameId)
    }
  }, [syncActivePrompt, viewportRef])

  if (items.length < 2) return null

  return (
    <nav
      aria-label="会话提问目录"
      data-testid="prompt-table-of-contents"
      className="absolute left-2 top-1/2 z-30 w-6 -translate-y-1/2"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={event => {
        if (!event.currentTarget.contains(document.activeElement)) setOpen(false)
      }}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(':hover')) {
          setOpen(false)
        }
      }}
    >
      <div className="max-h-[50lvh] w-6 overflow-y-auto [scrollbar-width:none]">
        <div className="flex flex-col items-center gap-px py-1">
          {items.map((item, index) => {
            const active = index === activeIndex
            return (
              <button
                key={item.id}
                type="button"
                aria-label={`Prompt ${index + 1}`}
                aria-current={active ? 'location' : undefined}
                data-toc-item-index={index}
                data-toc-active={active ? '' : undefined}
                className={cn(
                  'group/toc-tick flex h-[9px] w-6 shrink-0 items-center justify-center rounded-[3px] outline-none',
                  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                )}
                onClick={() => {
                  setActiveIndex(index)
                  onSelect(item.turnIndex)
                }}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'rounded-full transition-[width,height,background-color] duration-150 motion-reduce:transition-none',
                    active
                      ? 'h-0.5 w-4 bg-foreground'
                      : 'h-px w-2.5 bg-muted-foreground/40 group-hover/toc-tick:w-3.5 group-hover/toc-tick:bg-muted-foreground/75',
                  )}
                />
              </button>
            )
          })}
        </div>
      </div>
      {open && (
        <div className="absolute left-6 top-1/2 w-[288px] max-w-[calc(100vw-64px)] -translate-y-1/2 pl-2">
          <div
            ref={listRef}
            data-testid="prompt-toc-preview"
            className="popover-styled relative max-h-[50lvh] overflow-y-auto overscroll-contain p-1 animate-in fade-in-0 slide-in-from-left-1 duration-150 motion-reduce:animate-none"
          >
            {items.map((item, index) => {
              const active = index === activeIndex
              return (
                <button
                  key={item.id}
                  ref={active ? activeItemRef : undefined}
                  type="button"
                  data-toc-list-index={index}
                  aria-current={active ? 'location' : undefined}
                  title={item.label}
                  className={cn(
                    'block w-full truncate rounded-[4px] px-2 py-1.5 text-left text-[13px] leading-5 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
                    active ? 'bg-foreground/[0.09] text-foreground' : 'text-foreground/85 hover:bg-foreground/[0.055]',
                  )}
                  onClick={() => {
                    setActiveIndex(index)
                    onSelect(item.turnIndex)
                  }}
                >
                  {item.label}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </nav>
  )
}
