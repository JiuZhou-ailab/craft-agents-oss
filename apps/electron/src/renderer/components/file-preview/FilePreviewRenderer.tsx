// input: File preview state plus host-provided binary/text loaders
// output: Lazily loaded preview overlay for the selected file type
// pos: Keeps PDF, code, markdown, and JSON preview dependencies out of the project-hub bundle

import {
  CodePreviewOverlay,
  DocumentFormattedMarkdownOverlay,
  ImagePreviewOverlay,
  JSONPreviewOverlay,
  PDFPreviewOverlay,
} from '@craft-agent/ui'
import type { FilePreviewState } from '@/hooks/useLinkInterceptor'

interface FilePreviewRendererProps {
  state: FilePreviewState
  onClose: () => void
  loadDataUrl: (path: string) => Promise<string>
  loadPdfData: (path: string) => Promise<Uint8Array>
  isDark: boolean
  embedded?: boolean
}

export function FilePreviewRenderer({
  state,
  onClose,
  loadDataUrl,
  loadPdfData,
  isDark,
  embedded,
}: FilePreviewRendererProps) {
  const theme = isDark ? 'dark' : 'light' as const

  switch (state.type) {
    case 'image':
      return (
        <ImagePreviewOverlay
          isOpen
          onClose={onClose}
          filePath={state.filePath}
          loadDataUrl={loadDataUrl}
          theme={theme}
        />
      )

    case 'pdf':
      return (
        <PDFPreviewOverlay
          isOpen
          onClose={onClose}
          filePath={state.filePath}
          loadPdfData={loadPdfData}
          theme={theme}
          embedded={embedded}
        />
      )

    case 'code':
    case 'text':
      return (
        <CodePreviewOverlay
          isOpen
          onClose={onClose}
          filePath={state.filePath}
          content={state.content ?? ''}
          language={state.type === 'code' ? state.language : 'plaintext'}
          mode="read"
          theme={theme}
          error={state.error}
          embedded={embedded}
        />
      )

    case 'markdown': {
      const isPlanFile =
        (state.filePath.includes('/plans/') || state.filePath.startsWith('plans/'))
        && state.filePath.endsWith('.md')
      return (
        <DocumentFormattedMarkdownOverlay
          isOpen
          onClose={onClose}
          content={state.content ?? ''}
          filePath={state.filePath}
          variant={isPlanFile ? 'plan' : 'response'}
        />
      )
    }

    case 'json': {
      let parsedData: unknown = null
      try {
        if (state.content) parsedData = JSON.parse(state.content)
      } catch {
        return (
          <CodePreviewOverlay
            isOpen
            onClose={onClose}
            filePath={state.filePath}
            content={state.content ?? ''}
            language="json"
            mode="read"
            theme={theme}
            error={state.error}
            embedded={embedded}
          />
        )
      }

      if ((!state.content || !state.content.trim()) && state.error) {
        return (
          <CodePreviewOverlay
            isOpen
            onClose={onClose}
            filePath={state.filePath}
            content={state.content ?? ''}
            language="json"
            mode="read"
            theme={theme}
            error={state.error}
            embedded={embedded}
          />
        )
      }

      return (
        <JSONPreviewOverlay
          isOpen
          onClose={onClose}
          filePath={state.filePath}
          title={state.filePath.split('/').pop() ?? 'JSON'}
          data={parsedData}
          theme={theme}
          error={state.error}
          embedded={embedded}
        />
      )
    }

    default:
      return null
  }
}
