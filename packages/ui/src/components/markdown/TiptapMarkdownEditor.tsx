// input: Markdown content, editor configuration, and optional document actions
// output: TipTap-powered Markdown editing surface with toolbar and bubble menus
// pos: Shared Markdown editor used by app document and writing surfaces

import { locateDocumentSearch, type DocumentSearchTarget, type DocumentSearchLocation } from './document-search'
import * as React from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from './extensions/AnimatedTaskItem'
import { Mathematics } from '@tiptap/extension-mathematics'
import Image from '@tiptap/extension-image'
import FileHandler from '@tiptap/extension-file-handler'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { Markdown as OfficialMarkdown } from '@tiptap/markdown'
import type { MarkdownToken } from '@tiptap/core'
import type { Editor } from '@tiptap/react'
import { EditorState } from '@tiptap/pm/state'
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Pilcrow,
  Quote,
  Redo2,
  Strikethrough,
  Undo2,
} from 'lucide-react'
import { tiptapCodeBlock } from './TiptapCodeBlockView'
import {
  TiptapBubbleMenus,
  INLINE_MATH_EDIT_EVENT,
  SelectionAiRangeHighlight,
  type TiptapSelectionAiRequest,
  type TiptapSelectionChatRequest,
} from './TiptapBubbleMenus'
import { TiptapSlashMenu } from './TiptapSlashMenu'
import { MermaidBlock } from './extensions/MermaidBlock'
import { looksLikeMermaidSource } from './mermaid-source'
import { LatexBlock } from './extensions/LatexBlock'
import { RichBlockInteractions } from './extensions/RichBlockInteractions'
import { TiptapReviewDiff, TIPTAP_REVIEW_DIFF_KEY } from './TiptapReviewDiff'
import { cn } from '../../lib/utils'
import 'katex/dist/katex.min.css'
import './tiptap-editor.css'
import './extensions/animated-task-item.css'

type TableAlignment = 'left' | 'center' | 'right' | null

type GfmTableToken = MarkdownToken & {
  align?: TableAlignment[]
  header?: Array<{ tokens: MarkdownToken[] }>
  rows?: Array<Array<{ tokens: MarkdownToken[] }>>
}

function normalizeTableAlignment(value: unknown): TableAlignment {
  return value === 'left' || value === 'center' || value === 'right' ? value : null
}

const tableAlignmentAttribute = {
  default: null,
  parseHTML: (element: HTMLElement) => normalizeTableAlignment(element.style.textAlign || element.getAttribute('align')),
  renderHTML: ({ align }: { align?: unknown }) => {
    const value = normalizeTableAlignment(align)
    return value ? { style: `text-align: ${value}` } : {}
  },
}

const GfmTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), align: tableAlignmentAttribute }
  },
})

const GfmTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), align: tableAlignmentAttribute }
  },
})

const GfmTable = Table.extend({
  parseMarkdown(token, h) {
    const table = token as GfmTableToken
    const createCell = (type: 'tableHeader' | 'tableCell', cell: { tokens: MarkdownToken[] }, column: number) => (
      h.createNode(type, { align: normalizeTableAlignment(table.align?.[column]) }, [
        h.createNode('paragraph', {}, h.parseInline(cell.tokens)),
      ])
    )
    const rows = []

    if (table.header) {
      rows.push(h.createNode('tableRow', {}, table.header.map((cell, column) => createCell('tableHeader', cell, column))))
    }
    for (const row of table.rows ?? []) {
      rows.push(h.createNode('tableRow', {}, row.map((cell, column) => createCell('tableCell', cell, column))))
    }

    return h.createNode('table', undefined, rows)
  },

  renderMarkdown(node, h, context) {
    const markdown = Table.config.renderMarkdown?.(node, h, context) ?? ''
    const alignments = node.content?.[0]?.content?.map((cell) => normalizeTableAlignment(cell.attrs?.align)) ?? []
    if (!alignments.some(Boolean)) return markdown

    const lines = markdown.split('\n')
    const separatorIndex = lines.findIndex((line) => /^\|\s*-{3,}(?:\s*\|\s*-{3,})+\s*\|$/.test(line))
    if (separatorIndex < 0) return markdown

    const separators = lines[separatorIndex]!.slice(1, -1).split('|').map((cell) => cell.trim())
    lines[separatorIndex] = `| ${separators.map((separator, column) => {
      const dashes = '-'.repeat(Math.max(3, separator.length))
      if (alignments[column] === 'left') return `:${dashes}`
      if (alignments[column] === 'center') return `:${dashes}:`
      if (alignments[column] === 'right') return `${dashes}:`
      return dashes
    }).join(' | ')} |`

    return lines.join('\n')
  },
})

export function createTiptapTableKit() {
  return [
    GfmTable.configure({ renderWrapper: true }),
    GfmTableCell,
    GfmTableHeader,
    TableRow,
  ]
}

function useEditorToolbarRefresh(editor: Editor) {
  const [, setVersion] = React.useState(0)

  React.useEffect(() => {
    const refresh = () => setVersion((version) => (version + 1) % 10000)

    editor.on('selectionUpdate', refresh)
    editor.on('transaction', refresh)
    editor.on('update', refresh)

    return () => {
      editor.off('selectionUpdate', refresh)
      editor.off('transaction', refresh)
      editor.off('update', refresh)
    }
  }, [editor])
}

function ToolbarButton({
  title,
  active,
  disabled,
  onClick,
  children,
}: {
  title: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      className={cn('tiptap-toolbar-btn', active && 'is-active')}
      onMouseDown={(event) => {
        event.preventDefault()
      }}
      onClick={() => {
        if (!disabled) onClick()
      }}
    >
      {children}
    </button>
  )
}

export type IncomingContentSyncAction = 'ignore' | 'record' | 'sync'

export interface TiptapMarkdownEditorHandle {
  getMarkdownSnapshot(): string
}

export function getIncomingContentSyncAction({
  previousContent,
  incomingContent,
  currentMarkdown,
  lastEmittedMarkdown,
}: {
  previousContent: string
  incomingContent: string
  currentMarkdown?: string
  lastEmittedMarkdown?: string | null
}): IncomingContentSyncAction {
  if (incomingContent === previousContent) return 'ignore'
  if (lastEmittedMarkdown === incomingContent) return 'record'
  if (currentMarkdown === incomingContent) return 'record'
  return 'sync'
}

function ToolbarDivider() {
  return <div className="tiptap-toolbar-divider" aria-hidden="true" />
}

function TiptapFixedToolbar({
  editor,
  editable,
  accessory,
}: {
  editor: Editor
  editable: boolean
  accessory?: React.ReactNode
}) {
  useEditorToolbarRefresh(editor)

  const disabled = !editable

  return (
    <div className="tiptap-toolbar" role="toolbar" aria-label="Markdown formatting toolbar">
      <div className="tiptap-toolbar-group">
        <ToolbarButton title="Undo" disabled={disabled} onClick={() => editor.chain().focus().undo().run()}>
          <Undo2 className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton title="Redo" disabled={disabled} onClick={() => editor.chain().focus().redo().run()}>
          <Redo2 className="h-3.5 w-3.5" />
        </ToolbarButton>
      </div>
      <ToolbarDivider />
      <div className="tiptap-toolbar-group">
        <ToolbarButton title="Paragraph" disabled={disabled} active={editor.isActive('paragraph')} onClick={() => editor.chain().focus().setParagraph().run()}>
          <Pilcrow className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton title="Heading 1" disabled={disabled} active={editor.isActive('heading', { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
          <Heading1 className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton title="Heading 2" disabled={disabled} active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
          <Heading2 className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton title="Heading 3" disabled={disabled} active={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
          <Heading3 className="h-3.5 w-3.5" />
        </ToolbarButton>
      </div>
      <ToolbarDivider />
      <div className="tiptap-toolbar-group">
        <ToolbarButton title="Bold" disabled={disabled} active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
          <Bold className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton title="Italic" disabled={disabled} active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
          <Italic className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton title="Strikethrough" disabled={disabled} active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}>
          <Strikethrough className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton title="Inline code" disabled={disabled} active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}>
          <Code className="h-3.5 w-3.5" />
        </ToolbarButton>
      </div>
      <ToolbarDivider />
      <div className="tiptap-toolbar-group">
        <ToolbarButton title="Bullet list" disabled={disabled} active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>
          <List className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton title="Numbered list" disabled={disabled} active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
          <ListOrdered className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton title="Task list" disabled={disabled} active={editor.isActive('taskList')} onClick={() => editor.chain().focus().toggleTaskList().run()}>
          <ListChecks className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton title="Quote" disabled={disabled} active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
          <Quote className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton title="Divider" disabled={disabled} onClick={() => editor.chain().focus().setHorizontalRule().run()}>
          <Minus className="h-3.5 w-3.5" />
        </ToolbarButton>
      </div>
      {accessory ? (
        <>
          <ToolbarDivider />
          <div className="tiptap-toolbar-group tiptap-toolbar-accessory">{accessory}</div>
        </>
      ) : null}
    </div>
  )
}


function getOfficialMarkdown(editor: { getMarkdown?: () => string }): string {
  return editor.getMarkdown?.() ?? ''
}

function forceShikiDecorations(editor: any) {
  try {
    if (editor?.isDestroyed) return
    const tr = editor.view?.state.tr.setMeta('shikiPluginForceDecoration', true)
    if (tr) {
      editor.view?.dispatch(tr)
    }
  } catch {
    // Best-effort refresh only.
  }
}

function scheduleShikiRefresh(editor: any) {
  // Chapter switches already pay for markdown setContent on the critical path.
  // Force-decorating immediately + three timed passes competes with first paint
  // after project entry. Defer the first pass to idle/rAF; keep one short retry
  // for async highlighter readiness without stacking 3 timer storms.
  const run = () => {
    if (!editor?.isDestroyed) forceShikiDecorations(editor)
  }

  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(run, { timeout: 120 })
  } else {
    requestAnimationFrame(() => {
      setTimeout(run, 0)
    })
  }

  setTimeout(run, 220)
}

const INLINE_DOUBLE_DOLLAR_REGEX = /\$\$([^\n]+?)\$\$/g
// Currency marker used during official parse to avoid accidental math tokenization.
const CURRENCY_MARKER = '¤'
const CURRENCY_RANGE_REGEX = /\$(\d[\dA-Za-z.,]*\s*[–-]\s*)\$(\d[\dA-Za-z.,]*)/g
const CURRENCY_AMOUNT_REGEX = /\$(\d[\dA-Za-z.,]*)/g

/**
 * Normalize markdown for official TipTap parser:
 * - Keep product policy: users write math with $$...$$
 * - Convert same-line $$...$$ to inline $...$ (TipTap inline math)
 * - Escape currency-like dollars ($100, $2M...) so they don't become inline math nodes
 */
export function preprocessMarkdownForOfficial(markdown: string): string {
  let index = 0
  const placeholders = new Map<string, string>()

  const withPlaceholders = markdown.replace(INLINE_DOUBLE_DOLLAR_REGEX, (_, latex: string) => {
    const key = `@@CA_INLINE_MATH_${index++}@@`
    placeholders.set(key, latex)
    return key
  })

  const rangeProtected = withPlaceholders.replace(
    CURRENCY_RANGE_REGEX,
    (_match, left: string, right: string) => `${CURRENCY_MARKER}${left}${CURRENCY_MARKER}${right}`
  )

  const amountProtected = rangeProtected.replace(
    CURRENCY_AMOUNT_REGEX,
    (_match, amount: string) => `${CURRENCY_MARKER}${amount}`
  )

  return amountProtected.replace(/@@CA_INLINE_MATH_\d+@@/g, (key) => {
    const latex = placeholders.get(key) ?? ''
    return `$${latex}$`
  })
}

/** Undo parser-safety escaping in serialized markdown. */
export function postprocessMarkdownFromOfficial(markdown: string): string {
  return markdown.replaceAll(CURRENCY_MARKER, '$')
}

const MERMAID_FILE_EXTENSIONS = new Set(['mmd', 'mermaid'])

export function isMermaidFilename(fileName: string): boolean {
  const ext = fileName.toLowerCase().split('.').pop()
  return ext != null && MERMAID_FILE_EXTENSIONS.has(ext)
}

export function extractMermaidSource(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const fenced = trimmed.match(/^```mermaid\s*\n([\s\S]*?)\n```$/i)
  if (fenced?.[1]) {
    const source = fenced[1].trim()
    return source.length > 0 ? source : null
  }

  return looksLikeMermaidSource(trimmed) ? trimmed : null
}

async function readFileAsDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result === 'string') resolve(result)
      else reject(new Error('Failed to read file as data URL'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

async function readImageDimensions(src: string): Promise<{ width: number; height: number } | null> {
  return await new Promise((resolve) => {
    const image = new globalThis.Image()
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) {
        resolve(null)
        return
      }
      resolve({ width: image.naturalWidth, height: image.naturalHeight })
    }
    image.onerror = () => resolve(null)
    image.src = src
  })
}

function insertMermaidBlock(editor: NonNullable<ReturnType<typeof useEditor>>, source: string, pos?: number) {
  const payload = {
    type: 'mermaidBlock',
    attrs: { code: source },
  }

  const chain = editor.chain().focus()
  if (typeof pos === 'number') chain.setTextSelection(pos)
  chain.insertContent(payload).run()
}

function insertImageNode(
  editor: NonNullable<ReturnType<typeof useEditor>>,
  src: string,
  pos?: number,
  dimensions?: { width: number; height: number } | null,
) {
  const chain = editor.chain().focus()
  if (typeof pos === 'number') chain.setTextSelection(pos)
  chain.setImage({
    src,
    ...(dimensions?.width && dimensions?.height
      ? { width: dimensions.width, height: dimensions.height }
      : {}),
  }).run()
}

async function handleDroppedOrPastedFiles(
  editor: NonNullable<ReturnType<typeof useEditor>>,
  files: File[],
  pos?: number,
): Promise<void> {
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      const src = await readFileAsDataUrl(file)
      const dimensions = await readImageDimensions(src)
      insertImageNode(editor, src, pos, dimensions)
      continue
    }

    if (!isMermaidFilename(file.name)) continue
    const text = await file.text()
    const source = extractMermaidSource(text) ?? text.trim()
    if (!source) continue
    insertMermaidBlock(editor, source, pos)
  }
}

export interface TiptapMarkdownEditorProps {
  searchTarget?: DocumentSearchTarget
  onSearchLocation?: (location: DocumentSearchLocation) => void
  /** Markdown string content */
  content: string
  /** Called when content changes */
  onUpdate?: (markdown: string) => void
  /** Called when the document changes without forcing a Markdown snapshot. */
  onDocumentChanged?: () => void
  /** Placeholder text when empty */
  placeholder?: string
  className?: string
  /** Whether the editor is editable */
  editable?: boolean
  /** Show a fixed formatting toolbar above the editable document. */
  showToolbar?: boolean
  /** Optional document action rendered at the end of the fixed toolbar. */
  toolbarAccessory?: React.ReactNode
  /** Visual surface tuned for the current document type. */
  surface?: 'default' | 'manuscript'
  /** Show a subtle line-number gutter for long-form editing surfaces. */
  showLineNumbers?: boolean
  /** Optional fixed status content in the lower-right corner of the editor. */
  bottomRightAccessory?: React.ReactNode
  /** Previous Markdown content to compare against the current editor document. */
  reviewDiffOriginalContent?: string | null
  /** Called when the user asks AI to work on the current text selection. */
  onAskAiForSelection?: (request: TiptapSelectionAiRequest) => Promise<string>
  /** Called when the user adds the current text selection to the chat draft. */
  onAddSelectionToChat?: (request: TiptapSelectionChatRequest) => void
}

export const TiptapMarkdownEditor = React.forwardRef<TiptapMarkdownEditorHandle, TiptapMarkdownEditorProps>(function TiptapMarkdownEditor({
  content,
  searchTarget,
  onSearchLocation,
  onUpdate,
  onDocumentChanged,
  placeholder = 'Write something...',
  className,
  editable = true,
  showToolbar = false,
  toolbarAccessory,
  surface = 'default',
  showLineNumbers = false,
  bottomRightAccessory,
  reviewDiffOriginalContent = null,
  onAskAiForSelection,
  onAddSelectionToChat,
}, ref) {
  const onUpdateRef = React.useRef(onUpdate)
  onUpdateRef.current = onUpdate
  const onDocumentChangedRef = React.useRef(onDocumentChanged)
  onDocumentChangedRef.current = onDocumentChanged
  const lastEmittedMarkdownRef = React.useRef<string | null>(null)
  const hasLocalEditsRef = React.useRef(false)
  const handledSearchRef = React.useRef<string | null>(null)
  const isApplyingExternalContentRef = React.useRef(false)
  const [bubbleMenuAppendTo, setBubbleMenuAppendTo] = React.useState<HTMLElement | null>(null)
  const [bubbleMenuScrollTarget, setBubbleMenuScrollTarget] = React.useState<HTMLElement | null>(null)

  // Ref for the editor instance — used by the Mathematics onClick callback
  // which is created at extension-configure time (before useEditor returns).
  const editorRef = React.useRef<Editor | null>(null)

  const extensions = React.useMemo(() => {
    const base = [
      StarterKit.configure({
        codeBlock: false,
        heading: { levels: [1, 2, 3] },
      }),
      TaskList,
      TaskItem.configure({
        nested: true,
      }),
      tiptapCodeBlock.configure({
        themes: { light: 'github-light', dark: 'github-dark' },
      }),
      MermaidBlock,
      LatexBlock,
      Placeholder.configure({ placeholder }),
      Image.configure({
        inline: false,
        allowBase64: true,
      }),
      ...createTiptapTableKit(),
      FileHandler.configure({
        onPaste: async (editor, files) => {
          if (!editor.isEditable || files.length === 0) return
          await handleDroppedOrPastedFiles(editor as NonNullable<ReturnType<typeof useEditor>>, files)
        },
        onDrop: async (editor, files, pos) => {
          if (!editor.isEditable || files.length === 0) return
          await handleDroppedOrPastedFiles(editor as NonNullable<ReturnType<typeof useEditor>>, files, pos)
        },
      }),
      RichBlockInteractions,
      TiptapReviewDiff,
      SelectionAiRangeHighlight,
      TiptapSlashMenu,
    ]

    return [
      ...base,
      Mathematics.configure({
        inlineOptions: {
          onClick: (_node, pos) => {
            const e = editorRef.current
            if (!e) return
            e.chain().focus().setNodeSelection(pos).run()
            // Emit after selection so BubbleMenu mounts, then the event activates the input
            queueMicrotask(() => (e as any).emit(INLINE_MATH_EDIT_EVENT))
          },
        },
        katexOptions: {
          throwOnError: false,
          strict: false,
        },
      }),
      OfficialMarkdown.configure({
        markedOptions: {
          gfm: true,
        },
      }),
    ]
  }, [placeholder])

  const initialContent = preprocessMarkdownForOfficial(content)

  const getMarkdownSnapshot = React.useCallback((): string => {
    const activeEditor = editorRef.current
    if (!activeEditor) return content
    return postprocessMarkdownFromOfficial(getOfficialMarkdown(activeEditor as { getMarkdown?: () => string }))
  }, [content])

  React.useImperativeHandle(ref, () => ({
    getMarkdownSnapshot,
  }), [getMarkdownSnapshot])

  const editor = useEditor({
    extensions,
    content: initialContent,
    immediatelyRender: false,
    contentType: 'markdown',
    editable,
    editorProps: {
      attributes: {
        class: 'tiptap-prose outline-none',
      },
      handlePaste: (_view, event) => {
        const activeEditor = editorRef.current
        if (!activeEditor?.isEditable) return false
        if (event.clipboardData?.files?.length) return false

        const text = event.clipboardData?.getData('text/plain') ?? ''
        const source = extractMermaidSource(text)
        if (!source) return false

        insertMermaidBlock(activeEditor, source)
        return true
      },
      handleDrop: (view, event) => {
        const activeEditor = editorRef.current
        if (!activeEditor?.isEditable) return false
        if (event.dataTransfer?.files?.length) return false

        const text = event.dataTransfer?.getData('text/plain') ?? ''
        const source = extractMermaidSource(text)
        if (!source) return false

        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
        insertMermaidBlock(activeEditor, source, pos)
        return true
      },
    },
    onCreate: ({ editor }) => {
      queueMicrotask(() => {
        scheduleShikiRefresh(editor)
      })
    },
    onUpdate: ({ editor }) => {
      if (isApplyingExternalContentRef.current || !editor.isFocused) return
      hasLocalEditsRef.current = true
      if (!onUpdateRef.current) {
        onDocumentChangedRef.current?.()
        return
      }
      const md = postprocessMarkdownFromOfficial(getOfficialMarkdown(editor as { getMarkdown?: () => string }))
      lastEmittedMarkdownRef.current = md
      onUpdateRef.current?.(md)
      onDocumentChangedRef.current?.()
    },
  }, [extensions])

  // Keep editorRef in sync for the Mathematics onClick callback
  editorRef.current = editor

  // Sync editable prop
  React.useEffect(() => {
    if (editor && editor.isEditable !== editable) {
      editor.setEditable(editable)
    }
  }, [editor, editable])

  React.useEffect(() => {
    if (!editor) return

    const markdown = reviewDiffOriginalContent
    if (markdown == null) {
      editor.view.dispatch(editor.state.tr.setMeta(TIPTAP_REVIEW_DIFF_KEY, { previousDoc: null }))
      return
    }

    try {
      const normalized = preprocessMarkdownForOfficial(markdown)
      const previousDoc = editor.schema.nodeFromJSON(
        (editor as Editor & { markdown?: { parse: (value: string) => unknown } }).markdown?.parse(normalized)
      )
      editor.view.dispatch(editor.state.tr.setMeta(TIPTAP_REVIEW_DIFF_KEY, { previousDoc }))
    } catch {
      editor.view.dispatch(editor.state.tr.setMeta(TIPTAP_REVIEW_DIFF_KEY, { previousDoc: null }))
    }
  }, [editor, reviewDiffOriginalContent])

  // Sync content when the selected task changes (key prop handles this,
  // but as a safety net for direct content prop changes)
  const prevContentRef = React.useRef(content)
  React.useEffect(() => {
    if (editor) {
      const fastSyncAction = getIncomingContentSyncAction({
        previousContent: prevContentRef.current,
        incomingContent: content,
        lastEmittedMarkdown: lastEmittedMarkdownRef.current,
      })
      if (fastSyncAction !== 'sync') {
        if (fastSyncAction === 'record') {
          prevContentRef.current = content
        }
        return
      }

      const currentMd = postprocessMarkdownFromOfficial(getOfficialMarkdown(editor as { getMarkdown?: () => string }))
      const syncAction = getIncomingContentSyncAction({
        previousContent: prevContentRef.current,
        incomingContent: content,
        currentMarkdown: currentMd,
      })

      if (syncAction === 'ignore') return

      prevContentRef.current = content
      if (syncAction === 'record') return

      try {
        isApplyingExternalContentRef.current = true
        hasLocalEditsRef.current = false
        const normalized = preprocessMarkdownForOfficial(content)
        editor.commands.setContent(normalized, {
          contentType: 'markdown',
          emitUpdate: false,
        } as never)
        // Drop undo stack from the previous document when content is replaced
        // externally (chapter switch). Without this, reused editors retain prior
        // document history and inflate memory across open/close cycles.
        const commandsWithHistory = editor.commands as unknown as {
          clearHistory?: () => boolean
        }
        if (typeof commandsWithHistory.clearHistory === 'function') {
          commandsWithHistory.clearHistory()
        } else {
          // reconfigure() reuses plugin state; EditorState.create rebuilds it.
          const { state } = editor
          editor.view.updateState(EditorState.create({
            doc: state.doc,
            plugins: state.plugins,
          }))
        }
      } finally {
        isApplyingExternalContentRef.current = false
      }

      queueMicrotask(() => {
        if (!editor.isDestroyed) {
          scheduleShikiRefresh(editor)
        }
      })
    }
  }, [editor, content])

  React.useEffect(() => {
    if (!editor || !editable || !searchTarget || handledSearchRef.current === searchTarget.requestId) return
    handledSearchRef.current = searchTarget.requestId
    const source = hasLocalEditsRef.current
      ? postprocessMarkdownFromOfficial(getOfficialMarkdown(editor))
      : content
    const location = locateDocumentSearch(source, searchTarget, editor.state.doc, value =>
      editor.schema.nodeFromJSON(editor.markdown!.parse(preprocessMarkdownForOfficial(value))))
    if (location.from !== undefined && location.to !== undefined) {
      editor.chain().focus().setTextSelection({ from: location.from, to: location.to }).scrollIntoView().run()
    }
    onSearchLocation?.(location)
  }, [editor, editable, searchTarget, content, onSearchLocation])


  return (
    <div
      ref={setBubbleMenuAppendTo}
      className={cn(
        'tiptap-editor',
        showToolbar && 'tiptap-editor--with-toolbar',
        surface === 'manuscript' && 'tiptap-editor--manuscript',
        showLineNumbers && 'tiptap-editor--line-numbers',
        className
      )}
    >
      {editor && showToolbar && (
        <TiptapFixedToolbar editor={editor} editable={editable} accessory={toolbarAccessory} />
      )}
      <div ref={setBubbleMenuScrollTarget} className="tiptap-editor-content">
        <EditorContent editor={editor} />
      </div>
      {editor && editable && (
        <TiptapBubbleMenus
          editor={editor}
          appendTo={bubbleMenuAppendTo}
          scrollTarget={bubbleMenuScrollTarget}
          onAskAiForSelection={onAskAiForSelection}
          onAddSelectionToChat={onAddSelectionToChat}
        />
      )}
      {bottomRightAccessory ? (
        <div className="tiptap-editor-status-badge">
          {bottomRightAccessory}
        </div>
      ) : null}
    </div>
  )
})
