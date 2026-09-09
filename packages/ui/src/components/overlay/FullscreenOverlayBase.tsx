// input: Overlay content, dismissal callbacks, platform chrome, and responsive layout mode
// output: Accessible fullscreen or modal dialog with header preceding scrollable content
// pos: Shared presentation and dismissal boundary for high-priority overlays
/**
 * FullscreenOverlayBase - Base component for fullscreen and centered modal overlays
 *
 * Uses Radix Dialog primitives for proper:
 * - Focus management (blur on open, restore on close)
 * - ESC key handling
 * - Coordination with other Radix components (popovers, dropdowns)
 * - Accessibility (role="dialog", aria-modal)
 *
 * Additionally handles:
 * - macOS traffic light hiding (via PlatformContext)
 * - Default scenic background (bg-foreground-3 + fullscreen-overlay-background blur)
 *   Callers can override via className (twMerge resolves conflicts)
 * - Optional structured header with badges (typeBadge, filePath, title, subtitle)
 * - Optional built-in copy button (copyContent prop)
 * - Full-viewport scroll container with edge-to-edge gradient fade mask (iOS-style contentInset).
 *   The scroll area covers the entire viewport — content scrolls behind the floating header.
 *   A CSS mask gradient fades content at both edges (top and bottom, starting from y=0).
 *   The header floats on top and covers content behind it.
 *   Content padding clears the header at rest so nothing is clipped initially.
 *
 * Layout:
 *   Dialog.Content (fixed inset-0, relative)
 *   ├── Header (floating in fullscreen, in flow for modals)
 *   └── Masked area (absolute inset-0, CSS mask gradient)
 *       └── Scroll container (h-full, overflow-y-auto, paddingTop = header + fade)
 *           └── {error banner}
 *           └── {children}
 *
 * Used by: PreviewOverlay, DocumentFormattedMarkdownOverlay
 */

import { useEffect, useRef, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { usePlatform } from '../../context/PlatformContext'
import { cn } from '../../lib/utils'
import { getDismissibleLayerBridge } from '../../lib/dismissible-layer-bridge'
import { OVERLAY_LAYOUT, type OverlayMode } from '../../lib/layout'
import { FullscreenOverlayBaseHeader, type OverlayTypeBadge } from './FullscreenOverlayBaseHeader'
import { OverlayErrorBanner, type OverlayErrorBannerProps } from './OverlayErrorBanner'

// Z-index for fullscreen overlays - must be above app chrome (z-overlay: 300)
// Uses CSS variable when available, falls back to hardcoded value
const Z_FULLSCREEN = 'var(--z-fullscreen, 350)'

// HEADER_HEIGHT must match PreviewHeader's height prop (48px).
// FADE_SIZE is the transition zone where content fades in/out at edges.
const HEADER_HEIGHT = 48
const FADE_SIZE = 24

// Edge-to-edge gradient fade mask — starts at y=0, fades over FADE_SIZE at both edges.
// The floating header covers content behind it; the mask just provides the smooth fade.
const FADE_MASK = `linear-gradient(to bottom, transparent 0px, black ${FADE_SIZE}px, black calc(100% - ${FADE_SIZE}px), transparent 100%)`

export interface FullscreenOverlayBaseProps {
  /** Whether the overlay is visible */
  isOpen: boolean
  /** Callback when the overlay should close (ESC key triggers this) */
  onClose: () => void
  /** Content to render inside the overlay */
  children: ReactNode
  /** Additional CSS classes for the container */
  className?: string
  /** Presentation mode; existing callers remain fullscreen by default */
  mode?: OverlayMode
  /** Fixed fills the modal viewport; content grows only as tall as needed */
  modalSizing?: 'fixed' | 'content'
  /** Accessible title for the overlay (visually hidden) */
  accessibleTitle?: string

  // --- Structured header props (optional) ---
  // When any of these are provided, a FullscreenOverlayBaseHeader is rendered above children.

  /** Type badge — tool/format indicator (e.g. "Read", "Image", "Bash") */
  typeBadge?: OverlayTypeBadge
  /** File path — shows dual-trigger menu badge with "Open" + "Reveal in {file manager}" */
  filePath?: string
  /** Title — displayed as a badge when no filePath */
  title?: string
  /** Click handler for the title badge */
  onTitleClick?: () => void
  /** Subtitle — extra info badge (e.g. "Lines 1-50 of 200") */
  subtitle?: string
  /** Right-side header actions (e.g. diff controls) */
  headerActions?: ReactNode
  /** When provided, renders a built-in copy button in the header right actions area */
  copyContent?: string

  /** Optional error banner — rendered between header and children */
  error?: OverlayErrorBannerProps
}

export function handleFullscreenEscapeWithStack(): boolean {
  const bridge = getDismissibleLayerBridge()
  if (!bridge) return false
  return bridge.handleEscape()
}

export function FullscreenOverlayBase({
  isOpen,
  onClose,
  children,
  className,
  mode = 'fullscreen',
  modalSizing = 'fixed',
  accessibleTitle = 'Overlay',
  typeBadge,
  filePath,
  title,
  onTitleClick,
  subtitle,
  headerActions,
  copyContent,
  error,
}: FullscreenOverlayBaseProps) {
  const { onSetTrafficLightsVisible } = usePlatform()
  const isModal = mode === 'modal'
  const isContentSizedModal = isModal && modalSizing === 'content'
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null)

  // Determine if we should render the structured header.
  // Any header-related prop triggers header rendering.
  const hasHeader = !!(typeBadge || filePath || title || subtitle || headerActions || copyContent)
  const overlayIdRef = useRef(`fullscreen-overlay-${Math.random().toString(36).slice(2)}`)

  useEffect(() => {
    if (!isOpen) return

    const bridge = getDismissibleLayerBridge()
    if (!bridge) return

    return bridge.registerLayer({
      id: overlayIdRef.current,
      type: 'radix-dialog',
      priority: 100,
      close: onClose,
    })
  }, [isOpen, onClose])

  // Hide macOS traffic lights when overlay opens, restore when it closes
  // This prevents accidental clicks on window controls behind the fullscreen overlay
  useEffect(() => {
    if (!isOpen || isModal) return

    onSetTrafficLightsVisible?.(false)
    return () => onSetTrafficLightsVisible?.(true)
  }, [isOpen, isModal, onSetTrafficLightsVisible])

  // Content padding clears the floating header at rest (when present).
  // Without a header, just the fade zone inset.
  const contentPaddingTop = hasHeader ? HEADER_HEIGHT + FADE_SIZE : FADE_SIZE

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        {isModal && (
          <Dialog.Overlay
            className={OVERLAY_LAYOUT.modalBackdropClass}
            style={{ position: 'fixed', inset: 0, zIndex: Z_FULLSCREEN }}
          />
        )}
        <Dialog.Content
          className={cn(
            isModal
              ? 'fixed left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[16px] bg-background shadow-modal-small outline-none'
              : 'fixed inset-0 overflow-hidden bg-foreground-3 fullscreen-overlay-background outline-none',
            className
          )}
          style={isModal
            ? {
                zIndex: Z_FULLSCREEN,
                width: '90vw',
                maxWidth: isContentSizedModal
                  ? OVERLAY_LAYOUT.contentModalMaxWidth
                  : OVERLAY_LAYOUT.modalMaxWidth,
                height: isContentSizedModal
                  ? 'auto'
                  : `${OVERLAY_LAYOUT.modalMaxHeightPercent}vh`,
                maxHeight: `${OVERLAY_LAYOUT.modalMaxHeightPercent}vh`,
              }
            : { zIndex: Z_FULLSCREEN }}
          onOpenAutoFocus={(event) => {
            previouslyFocusedElementRef.current = document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null

            if (!isModal) event.preventDefault()
          }}
          onCloseAutoFocus={(event) => {
            const target = previouslyFocusedElementRef.current
            if (!target?.isConnected) return

            event.preventDefault()
            target.focus()
          }}
          onEscapeKeyDown={(event) => {
            const handled = handleFullscreenEscapeWithStack()
            if (!handled) return

            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDownOutside={isModal
            ? (event) => {
                const bridge = getDismissibleLayerBridge()
                const topLayer = bridge?.getTopLayer()

                if (topLayer && topLayer.id !== overlayIdRef.current) {
                  event.preventDefault()
                  bridge?.closeTop()
                }
              }
            : undefined}
        >
          {/* Visually hidden title for accessibility - required by Radix Dialog */}
          <Dialog.Title className="sr-only">{accessibleTitle}</Dialog.Title>

          {hasHeader && (
            <div className={isModal ? 'shrink-0' : 'absolute top-0 left-0 right-0 z-10'}>
              <FullscreenOverlayBaseHeader
                onClose={onClose}
                typeBadge={typeBadge}
                filePath={filePath}
                title={title}
                onTitleClick={onTitleClick}
                subtitle={subtitle}
                headerActions={headerActions}
                copyContent={copyContent}
              />
            </div>
          )}

          {/* Fullscreen content scrolls behind its floating header; modal content scrolls below it. */}
          <div
            className={
              isContentSizedModal
                ? 'min-h-0 overflow-y-auto'
                : isModal
                  ? 'relative min-h-0 flex-1'
                  : 'absolute inset-0'
            }
            style={{ maskImage: FADE_MASK, WebkitMaskImage: FADE_MASK }}
          >
            <div
              className={
                isContentSizedModal
                  ? ''
                  : isModal
                    ? 'absolute inset-0 overflow-y-auto'
                    : 'h-full overflow-y-auto'
              }
              style={{
                paddingTop: isModal ? FADE_SIZE : contentPaddingTop,
                paddingBottom: FADE_SIZE,
                scrollPaddingTop: isModal ? FADE_SIZE : contentPaddingTop,
              }}
            >
              <div className={isContentSizedModal ? 'flex flex-col' : 'flex min-h-full flex-col justify-center'}>
                {error && (
                  <div className="px-6 pb-4">
                    <OverlayErrorBanner label={error.label} message={error.message} />
                  </div>
                )}
                {children}
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
