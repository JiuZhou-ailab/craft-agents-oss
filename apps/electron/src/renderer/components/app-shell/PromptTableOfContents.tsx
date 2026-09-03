// input: Session user-query anchors, transcript viewport, and turn element refs
// output: Collapsed prompt ticks with a hover/focus query list and scroll navigation
// pos: Session-local transcript table of contents beside ChatDisplay

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface PromptTocItem {
  id: string
  label: string
  turnIndex: number
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
  const activeItemRef = React.useRef<HTMLButtonElement>(null)

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

  const revealActiveItem = () => {
    activeItemRef.current?.scrollIntoView({ block: 'nearest' })
  }

  return (
    <nav
      aria-label="会话提问目录"
      data-testid="prompt-table-of-contents"
      className="group/prompt-toc absolute left-2 top-1/2 z-30 w-9 -translate-y-1/2"
      onMouseEnter={revealActiveItem}
      onFocusCapture={revealActiveItem}
    >
      <div className="max-h-[50lvh] w-9 overflow-clip">
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
                title={item.label}
                className={cn(
                  'group/toc-tick flex h-[9px] w-9 shrink-0 items-center justify-center rounded-[3px] outline-none',
                  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                )}
                onClick={() => {
                  setActiveIndex(index)
                  onSelect(item.turnIndex)
                }}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'rounded-full transition-[width,height,background-color] duration-150',
                    active
                      ? 'h-0.5 w-6 bg-foreground'
                      : 'h-px w-[18px] bg-muted-foreground/40 group-hover/toc-tick:w-[22px] group-hover/toc-tick:bg-muted-foreground/75',
                  )}
                />
              </button>
            )
          })}
        </div>
      </div>

      <div
        className={cn(
          'pointer-events-none invisible absolute left-9 top-1/2 w-[285px] -translate-x-1 -translate-y-1/2 pl-[5px] opacity-0 transition-[opacity,transform] duration-150',
          'group-hover/prompt-toc:pointer-events-auto group-hover/prompt-toc:visible group-hover/prompt-toc:translate-x-0 group-hover/prompt-toc:opacity-100',
          'group-focus-within/prompt-toc:pointer-events-auto group-focus-within/prompt-toc:visible group-focus-within/prompt-toc:translate-x-0 group-focus-within/prompt-toc:opacity-100',
        )}
      >
        <div className="max-h-[30lvh] w-[280px] overflow-y-auto overscroll-contain rounded-[10px] border border-border/60 bg-popover p-1 text-popover-foreground shadow-modal-small">
          {items.map((item, index) => {
            const active = index === activeIndex
            return (
              <button
                key={item.id}
                ref={active ? activeItemRef : undefined}
                type="button"
                aria-current={active ? 'location' : undefined}
                className={cn(
                  'block w-full truncate rounded-[6px] px-2 py-[3px] text-left text-[12px] leading-4 outline-none',
                  'focus-visible:ring-1 focus-visible:ring-ring',
                  active
                    ? 'bg-foreground/[0.09] text-foreground'
                    : 'text-foreground/85 hover:bg-foreground/[0.055]',
                )}
                onClick={() => {
                  setActiveIndex(index)
                  onSelect(item.turnIndex)
                }}
              >
                {item.label || `Prompt ${index + 1}`}
              </button>
            )
          })}
        </div>
      </div>
    </nav>
  )
}
