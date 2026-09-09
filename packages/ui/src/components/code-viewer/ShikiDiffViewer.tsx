// input: Original and modified file contents, language, and display options
// output: Parsed file diff rendered with the shared diff viewer
// pos: Public content-based diff entry point and change statistics

import { useMemo } from 'react'
import { parseDiffFromFile, type FileContents, type FileDiffMetadata } from '@pierre/diffs'
import { LANGUAGE_MAP } from './language-map'
import { DiffViewer, type DiffViewerProps } from './DiffViewer'

export interface ShikiDiffViewerProps extends DiffViewerProps {
  original: string
  modified: string
  /** Auto-detected from filePath if not provided. */
  language?: string
}

/**
 * Calculate addition/deletion stats from a FileDiffMetadata
 * Useful for displaying change counts in headers
 */
export function getDiffStats(fileDiff: FileDiffMetadata): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const hunk of fileDiff.hunks) {
    additions += hunk.additionCount
    deletions += hunk.deletionCount
  }
  return { additions, deletions }
}

function getLanguageFromPath(filePath: string, explicit?: string): string {
  if (explicit) return explicit
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  return LANGUAGE_MAP[ext] || 'text'
}

export function ShikiDiffViewer({
  original,
  modified,
  filePath = 'file',
  language,
  ...props
}: ShikiDiffViewerProps) {
  // Resolve language
  const resolvedLang = useMemo(() => {
    return language || getLanguageFromPath(filePath)
  }, [language, filePath])

  // Create file contents objects for the diff parser
  const oldFile: FileContents = useMemo(() => ({
    name: filePath,
    contents: original,
    lang: resolvedLang as any,
  }), [filePath, original, resolvedLang])

  const newFile: FileContents = useMemo(() => ({
    name: filePath,
    contents: modified,
    lang: resolvedLang as any,
  }), [filePath, modified, resolvedLang])

  // Parse the diff
  const fileDiff: FileDiffMetadata = useMemo(() => {
    return parseDiffFromFile(oldFile, newFile)
  }, [oldFile, newFile])

  return <DiffViewer {...props} filePath={filePath} fileDiff={fileDiff} />
}
