// input: Parsed file diff, display options, and file interaction callbacks
// output: Themed diff rendering with shared readiness and header-click lifecycle
// pos: Internal renderer used by both public diff viewer entry points

import { useEffect, useMemo, useRef } from 'react'
import { FileDiff, type FileDiffMetadata, type FileDiffProps } from '@pierre/diffs/react'
import { DIFFS_TAG_NAME } from '@pierre/diffs'
import { cn } from '../../lib/utils'
import { registerCraftShikiThemes } from './registerShikiThemes'

// Register the diffs-container custom element if not already registered
// This is necessary because the React component renders a custom element
if (typeof HTMLElement !== 'undefined' && !customElements.get(DIFFS_TAG_NAME)) {
  class FileDiffContainer extends HTMLElement {
    constructor() {
      super()
      if (this.shadowRoot != null) return
      this.attachShadow({ mode: 'open' })
    }
  }
  customElements.define(DIFFS_TAG_NAME, FileDiffContainer)
}

// Register custom themes once per runtime.
registerCraftShikiThemes()

export interface DiffViewerProps {
  /** File path - used for language detection and display */
  filePath?: string
  /** Diff style: 'unified' (stacked) or 'split' (side-by-side) */
  diffStyle?: 'unified' | 'split'
  /** Theme mode */
  theme?: 'light' | 'dark'
  /** Shiki theme name (e.g., 'dracula', 'github-dark'). When provided, uses the matching
   *  Shiki theme natively. Falls back to craft-dark/craft-light (transparent bg) if not set. */
  shikiTheme?: string
  /** Disable background highlighting on changed lines */
  disableBackground?: boolean
  /** Whether to hide pierre's native file header (filename + stats). Default: true */
  disableFileHeader?: boolean
  /** Callback when the file header is clicked (e.g. to open the file in an editor).
   *  When provided, the header becomes clickable with cursor: pointer. */
  onFileHeaderClick?: (filePath: string) => void
  /** Callback when ready */
  onReady?: () => void
  /** Additional class names */
  className?: string
}

export function DiffViewer({
  fileDiff,
  fallback,
  filePath = 'file',
  diffStyle = 'unified',
  theme = 'light',
  shikiTheme,
  disableBackground = false,
  disableFileHeader = true,
  onFileHeaderClick,
  onReady,
  className,
}: DiffViewerProps & { fileDiff: FileDiffMetadata | null; fallback?: string }) {
  // Diff options - use the app's Shiki theme if available, otherwise fall back
  // to craft-dark/craft-light which have transparent bg for CSS variable theming
  const resolvedThemeName = shikiTheme || (theme === 'dark' ? 'craft-dark' : 'craft-light')
  // When onFileHeaderClick is provided, inject CSS to make the header look clickable
  const unsafeCSS = onFileHeaderClick
    ? '[data-diffs-header] { cursor: pointer; } [data-diffs-header]:hover [data-title] { text-decoration: underline; }'
    : undefined

  const options: FileDiffProps<undefined>['options'] = useMemo(() => ({
    theme: resolvedThemeName,
    diffStyle,
    diffIndicators: 'bars',
    disableBackground,
    lineDiffType: 'word',
    overflow: 'scroll',
    disableFileHeader,
    themeType: theme === 'dark' ? 'dark' : 'light',
    unsafeCSS,
  }), [resolvedThemeName, theme, diffStyle, disableBackground, disableFileHeader, unsafeCSS])

  // Call onReady after first render
  useEffect(() => {
    if (onReady) {
      // Give Shiki time to highlight
      const timer = setTimeout(() => {
        onReady()
      }, 100)
      return () => {
        clearTimeout(timer)
      }
    }
  }, [onReady, fileDiff, fallback])

  // Attach a click listener to the file header inside pierre's shadow DOM.
  // We query for the <diffs-container> custom element, then find [data-diffs-header]
  // inside its shadowRoot. This lets the filename be clickable without modifying pierre.
  const containerRef = useRef<HTMLDivElement>(null)
  const onFileHeaderClickRef = useRef(onFileHeaderClick)
  onFileHeaderClickRef.current = onFileHeaderClick

  useEffect(() => {
    if (!onFileHeaderClick || disableFileHeader) return

    let removeHeaderListener: (() => void) | undefined
    // Wait briefly for pierre to render the header into the shadow DOM
    const timer = setTimeout(() => {
      const diffsContainer = containerRef.current?.querySelector(DIFFS_TAG_NAME)
      const header = diffsContainer?.shadowRoot?.querySelector('[data-diffs-header]')
      if (!header) return

      const handleClick = () => {
        onFileHeaderClickRef.current?.(filePath)
      }
      header.addEventListener('click', handleClick)
      removeHeaderListener = () => header.removeEventListener('click', handleClick)
    }, 150)

    return () => {
      clearTimeout(timer)
      removeHeaderListener?.()
    }
  }, [filePath, fileDiff, disableFileHeader, onFileHeaderClick])

  // Use CSS variable so custom themes are respected
  const backgroundColor = 'var(--background)'

  return (
    <div
      ref={containerRef}
      className={cn(
        'h-full w-full overflow-auto',
        fileDiff ? 'transition-opacity duration-200' : 'p-4',
        className
      )}
      style={{
        backgroundColor,
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      {fileDiff ? (
        <FileDiff fileDiff={fileDiff} options={options} className="min-h-full h-full" />
      ) : (
        <pre className="text-foreground/70 whitespace-pre-wrap">{fallback || '(empty diff)'}</pre>
      )}
    </div>
  )
}
