// input: Code text, optional language hints, render mode, and current Shiki theme
// output: Syntax-highlighted or plain text code blocks for Markdown surfaces
// pos: Shared renderer used by chat responses, previews, and document overlays

import * as React from 'react'
import { codeToHtml, bundledLanguages, type BundledLanguage } from 'shiki'
import { Check, Copy } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useShikiTheme } from '../../context/ShikiThemeContext'

export interface CodeBlockProps {
  code: string
  language?: string
  className?: string
  /**
   * Render mode affects code block styling:
   * - 'terminal': Minimal, keeps control chars visible
   * - 'minimal': Clean code, basic styling
   * - 'full': Rich styling with background, copy button, etc.
   */
  mode?: 'terminal' | 'minimal' | 'full'
  /**
   * Force a specific theme. If not provided, detects from document.documentElement.classList
   */
  forcedTheme?: 'light' | 'dark'
}

// Languages to pre-load (most common in chat contexts)

// Map common aliases to Shiki language names
const LANGUAGE_ALIASES: Record<string, BundledLanguage> = {
  'js': 'javascript',
  'ts': 'typescript',
  'py': 'python',
  'sh': 'bash',
  'zsh': 'bash',
  'yml': 'yaml',
  'rb': 'ruby',
  'rs': 'rust',
  'kt': 'kotlin',
  'objective-c': 'objc',
  'objc': 'objc',
}

const PLAIN_TEXT_LANGUAGES = new Set(['text', 'txt', 'plain', 'plaintext', 'plain-text'])

function normalizeLanguage(language: string): string {
  const langLower = language.toLowerCase()
  if (PLAIN_TEXT_LANGUAGES.has(langLower)) return 'text'
  return LANGUAGE_ALIASES[langLower] || langLower
}

// Simple LRU cache for highlighted code
const highlightCache = new Map<string, string>()
const CACHE_MAX_SIZE = 200

function getCacheKey(code: string, lang: string, theme: string): string {
  return `${theme}:${lang}:${code}`
}

function isValidLanguage(lang: string): lang is BundledLanguage {
  const normalized = normalizeLanguage(lang)
  return normalized in bundledLanguages
}

/**
 * CodeBlock - Syntax highlighted code block using Shiki
 *
 * Uses VS Code's syntax highlighting engine for accurate highlighting.
 * Lazy-loads highlighting and caches results for performance.
 */
export function CodeBlock({ code, language = 'text', className, mode = 'full', forcedTheme }: CodeBlockProps) {
  const [highlighted, setHighlighted] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)
  const [copied, setCopied] = React.useState(false)

  // Get shiki theme from context (set by ShikiThemeProvider in the app).
  // This correctly handles edge cases like dark-only themes in light system mode.
  const contextShikiTheme = useShikiTheme()

  // Resolve language alias - keep as string to allow 'text' fallback
  const resolvedLang = normalizeLanguage(language)
  const isPlainText = resolvedLang === 'text'
  const languageLabel = isPlainText ? null : resolvedLang

  React.useEffect(() => {
    let cancelled = false

    async function highlight() {
      if (isPlainText) {
        setHighlighted(null)
        setIsLoading(false)
        return
      }

      // Theme priority:
      // 1. Context theme (from ShikiThemeProvider) - handles supportedModes correctly
      // 2. forcedTheme prop - explicit override for specific use cases
      // 3. DOM detection fallback - backwards compatible default
      let theme: string
      if (contextShikiTheme) {
        theme = contextShikiTheme
      } else if (forcedTheme) {
        theme = forcedTheme === 'dark' ? 'github-dark' : 'github-light'
      } else {
        const isDark = document.documentElement.classList.contains('dark')
        theme = isDark ? 'github-dark' : 'github-light'
      }
      const cacheKey = getCacheKey(code, resolvedLang, theme)

      const cached = highlightCache.get(cacheKey)
      if (cached) {
        if (!cancelled) {
          setHighlighted(cached)
          setIsLoading(false)
        }
        return
      }

      try {
        // Use valid language or fallback to plaintext
        const lang = isValidLanguage(resolvedLang) ? resolvedLang : 'text'

        const html = await codeToHtml(code, {
          lang,
          theme,
        })

        // Cache the result
        if (highlightCache.size >= CACHE_MAX_SIZE) {
          const firstKey = highlightCache.keys().next().value
          if (firstKey) highlightCache.delete(firstKey)
        }
        highlightCache.set(cacheKey, html)

        if (!cancelled) {
          setHighlighted(html)
          setIsLoading(false)
        }
      } catch (error) {
        // Fallback to plain text on error
        console.warn(`Shiki highlighting failed for language "${resolvedLang}":`, error)
        if (!cancelled) {
          setHighlighted(null)
          setIsLoading(false)
        }
      }
    }

    highlight()

    return () => {
      cancelled = true
    }
  }, [code, resolvedLang, forcedTheme, contextShikiTheme, isPlainText])

  const handleCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy code:', err)
    }
  }, [code])

  // Terminal mode: raw monospace with minimal styling
  if (mode === 'terminal') {
    return (
      <pre className={cn('font-mono text-sm whitespace-pre-wrap', className)}>
        <code>{code}</code>
      </pre>
    )
  }

  // Minimal mode: just syntax highlighting, no chrome
  if (mode === 'minimal') {
    if (isLoading || !highlighted) {
      return (
        <pre className={cn('font-mono text-sm whitespace-pre-wrap break-words', className)}>
          <code>{code}</code>
        </pre>
      )
    }

    return (
      <div
        className={cn('font-mono text-sm [&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_code]:!bg-transparent', className)}
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    )
  }

  const copyLabel = languageLabel ? 'Copy code' : 'Copy text'
  const copyButton = (
    <button
      onClick={handleCopy}
      className={cn(
        'inline-flex h-6 w-6 items-center justify-center rounded-[5px]',
        'text-muted-foreground/60 transition-all hover:bg-foreground/[0.06] hover:text-foreground',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        !languageLabel && 'absolute right-2 top-2 opacity-0 shadow-minimal group-hover/code-block:opacity-100 focus-visible:opacity-100',
      )}
      aria-label={copyLabel}
      title={copyLabel}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )

  if (isPlainText) {
    return (
      <div
        className={cn(
          'relative group/code-block overflow-hidden border-l border-foreground/[0.12] bg-transparent py-2 pl-3.5 pr-8',
          className,
        )}
      >
        {copyButton}
        <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.72] text-foreground/[0.74]">
          <code>{code}</code>
        </pre>
      </div>
    )
  }

  // Full mode: rich styling with header and copy button
  return (
    <div className={cn('relative group/code-block overflow-hidden rounded-[7px] border border-border/55 bg-foreground/[0.025]', className)}>
      {languageLabel ? (
        <div className="flex min-h-8 items-center justify-between border-b border-border/45 bg-foreground/[0.025] px-3 py-1 text-xs">
          <span className="font-medium text-muted-foreground/75">
            {languageLabel}
          </span>
          {copyButton}
        </div>
      ) : copyButton}

      {/* Code content */}
      <div className={cn('overflow-x-auto', languageLabel ? 'p-3' : 'px-3 py-2.5')}>
        {isLoading || !highlighted ? (
          <pre className="font-mono text-[12.5px] leading-5 text-foreground/85 whitespace-pre-wrap break-words">
            <code>{code}</code>
          </pre>
        ) : (
          <div
            className="font-mono text-[12.5px] leading-5 text-foreground/85 [&_pre]:!bg-transparent [&_pre]:!m-0 [&_pre]:!p-0 [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_code]:!bg-transparent"
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        )}
      </div>
    </div>
  )
}

/**
 * InlineCode - Styled inline code span
 * Features: subtle background (3%), no border, 75% opacity text
 */
export function InlineCode({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <code className={cn(
      'pl-1 pr-1 py-0 rounded bg-foreground/[0.04] font-mono text-[13px]',
      className
    )}>
      {children}
    </code>
  )
}
