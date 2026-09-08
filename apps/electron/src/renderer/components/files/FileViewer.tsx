// input: Selected project file path, optional Search Hit, and explicit system-open action
// output: Bounded inline preview for the shared project document tab
// pos: Read-only counterpart to the writing editor for non-editable project files

import { lazy, Suspense, useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ExternalLink, FileText, FileVideo } from 'lucide-react'
import { Spinner, locateSourceSearch, type DocumentSearchTarget } from '@craft-agent/ui'
import { classifyFile, isVideoFile } from '@craft-agent/ui/file-classification'
import { useTheme } from '@/hooks/useTheme'
import type { FilePreviewState } from '@/hooks/useLinkInterceptor'

const FilePreviewRenderer = lazy(async () => {
  const module = await import('@/components/file-preview/FilePreviewRenderer')
  return { default: module.FilePreviewRenderer }
})

interface FileViewerProps {
  path: string | null
  searchTarget?: DocumentSearchTarget
  onOpenExternal?: (path: string) => void
  onClose?: () => void
}

function getFileName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path
}

export function FileViewer({ path, searchTarget, onOpenExternal, onClose }: FileViewerProps) {
  const { t } = useTranslation()
  const { isDark } = useTheme()
  const [content, setContent] = useState<string>('')
  const readKey = JSON.stringify([path, searchTarget?.requestId])
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const matchRef = useRef<HTMLElement>(null)
  const searchLocation = useMemo(() => searchTarget && loadedFor === readKey
    ? locateSourceSearch(content, searchTarget) : null, [content, loadedFor, readKey, searchTarget])
  useEffect(() => { matchRef.current?.scrollIntoView({ block: 'center' }) }, [searchLocation])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const classification = useMemo(() => path ? classifyFile(path) : null, [path])
  const isVideo = useMemo(() => path ? isVideoFile(path) : false, [path])
  const mediaUrl = useMemo(
    () => path ? `workspace-file://media/${encodeURIComponent(path)}` : '',
    [path],
  )
  const loadDataUrl = useCallback((filePath: string) => window.electronAPI.readFileDataUrl(filePath), [])
  const loadPdfData = useCallback((filePath: string) => window.electronAPI.readFileBinary(filePath), [])

  useEffect(() => {
    let cancelled = false
    setContent('')
    setLoadedFor(null)
    setError(null)

    if (!path) {
      setIsLoading(false)
      return () => { cancelled = true }
    }
    if (
      isVideo
      || classification?.type === 'image'
      || !classification?.canPreview
      || !classification.type
      || classification.type === 'pdf'
    ) {
      setIsLoading(false)
      return () => { cancelled = true }
    }

    const loadFile = async () => {
      setIsLoading(true)
      try {
        const fileContent = await window.electronAPI.readFile(path)
        if (!cancelled) { setContent(fileContent); setLoadedFor(readKey) }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load file')
          setContent('')
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void loadFile()
    return () => { cancelled = true }
  }, [classification, isVideo, path, readKey])

  if (!path) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-8 text-center">
        <div className="size-16 bg-muted rounded-2xl flex items-center justify-center mb-4">
          <FileText className="size-8 text-muted-foreground/50" />
        </div>
        <p className="font-medium text-foreground">{t("fileViewer.noFileSelected")}</p>
        <p className="text-sm mt-1">{t("fileViewer.clickToView")}</p>
      </div>
    )
  }

  const fileName = getFileName(path)
  const previewKind = isVideo
    ? 'video'
    : classification?.canPreview
    ? classification.type
    : 'external'

  const embeddedPreviewState: FilePreviewState | null = previewKind === 'pdf'
    ? { type: 'pdf', filePath: path }
    : previewKind === 'json' && !isLoading && !searchTarget
      ? { type: 'json', filePath: path, content, error: error ?? undefined }
      : null

  if (embeddedPreviewState) {
    return (
      <Suspense fallback={(
        <div className="flex h-full items-center justify-center text-muted-foreground">
          <Spinner className="text-lg" />
        </div>
      )}>
        <FilePreviewRenderer
          state={embeddedPreviewState}
          onClose={onClose ?? (() => {})}
          loadDataUrl={loadDataUrl}
          loadPdfData={loadPdfData}
          isDark={isDark}
          embedded
        />
      </Suspense>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-col bg-background" data-file-viewer-kind={previewKind}>
      {/* File path header */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-foreground/[0.06] px-3">
        <FileText className="size-4 text-muted-foreground shrink-0" />
        <p className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={path}>
          {fileName}
        </p>
        {onOpenExternal ? (
          <button
            type="button"
            onClick={() => onOpenExternal(path)}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t('common.open')}
          </button>
        ) : null}
      </div>

      {searchLocation?.status === 'missing' || searchLocation?.status === 'relocated' ? (
        <div role="status" className="px-3 py-2 text-xs text-muted-foreground">
          {t(`globalSearch.location.${searchLocation.status}`)}
        </div>
      ) : null}
      {/* File content */}
      {isLoading ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <Spinner className="text-lg" />
          <span className="text-sm font-medium">{t("fileViewer.loadingContent")}</span>
        </div>
      ) : error ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-destructive">
          <p className="text-sm font-medium">{t("fileViewer.errorLoading")}</p>
          <p className="text-xs">{error}</p>
        </div>
      ) : previewKind === 'image' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-foreground/[0.02] p-6">
          <img
            src={mediaUrl}
            alt={fileName}
            className="max-h-full max-w-full object-contain"
            onError={() => setError(t('fileViewer.errorLoading'))}
          />
        </div>
      ) : previewKind === 'video' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black p-4">
          <video
            src={mediaUrl}
            aria-label={fileName}
            className="max-h-full max-w-full"
            controls
            preload="metadata"
            playsInline
            onError={() => setError(t('fileViewer.errorLoading'))}
          />
        </div>
      ) : previewKind === 'external' ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-foreground/[0.04]">
            <FileVideo className="size-8 opacity-55" />
          </div>
          <p className="max-w-md truncate text-sm font-medium text-foreground/80">{fileName}</p>
          <p className="max-w-md text-xs leading-5">
            {t('fileViewer.externalPreviewHint')}
          </p>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-4">
            <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed selection:bg-foreground/20">
              {searchLocation?.from !== undefined && searchLocation.to !== undefined ? <>
                {content.slice(0, searchLocation.from)}
                <mark ref={matchRef} data-document-search-match>{content.slice(searchLocation.from, searchLocation.to)}</mark>
                {content.slice(searchLocation.to)}
              </> : content}
            </pre>
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
