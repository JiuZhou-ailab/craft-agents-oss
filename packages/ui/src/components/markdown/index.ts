/**
 * Markdown component exports for @craft-agent/ui
 *
 * input: Markdown component modules
 * output: Public Markdown component exports
 * pos: Barrel export for shared Markdown UI
 */

export { Markdown, MemoizedMarkdown, type MarkdownProps, type RenderMode } from './Markdown'
export { CodeBlock, InlineCode, type CodeBlockProps } from './CodeBlock'
export { MarkdownMermaidBlock } from './MarkdownMermaidBlock'
export { preprocessLinks, detectLinks, hasLinks } from './linkify'
export { CollapsibleSection } from './CollapsibleSection'
export { CollapsibleMarkdownProvider, useCollapsibleMarkdown } from './CollapsibleMarkdownContext'
export { MarkdownDatatableBlock, type MarkdownDatatableBlockProps } from './MarkdownDatatableBlock'
export { MarkdownSpreadsheetBlock, type MarkdownSpreadsheetBlockProps } from './MarkdownSpreadsheetBlock'
export { MarkdownImageBlock, type MarkdownImageBlockProps } from './MarkdownImageBlock'
export {
  parseMarkdownPreviewSpec,
  normalizePreviewItems,
  type MarkdownPreviewItem,
  type MarkdownPreviewSpec,
} from './markdown-preview-helpers'
export { ImageCardStack, type ImageCardStackProps, type ImageCardStackItem } from './ImageCardStack'
export { TiptapMarkdownEditor, type TiptapMarkdownEditorHandle, type TiptapMarkdownEditorProps } from './TiptapMarkdownEditor'
export type { TiptapSelectionAiRequest, TiptapSelectionChatRequest } from './TiptapBubbleMenus'

export type { DocumentSearchTarget, DocumentSearchLocation } from './document-search'
