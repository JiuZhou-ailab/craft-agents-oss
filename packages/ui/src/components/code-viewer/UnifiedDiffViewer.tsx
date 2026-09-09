// input: Pre-computed unified diff strings and display options
// output: Parsed patch rendering or raw-text fallback, plus change statistics
// pos: Public unified-patch entry point using the shared diff viewer

import { useMemo } from 'react'
import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs'
import { DiffViewer, type DiffViewerProps } from './DiffViewer'
import { getDiffStats } from './ShikiDiffViewer'

export interface UnifiedDiffViewerProps extends DiffViewerProps {
  unifiedDiff: string
}

/**
 * Parse a unified diff string into FileDiffMetadata.
 * Handles edge cases like empty diffs or malformed patches.
 */
function parseUnifiedDiff(unifiedDiff: string, filePath: string): FileDiffMetadata | null {
  if (!unifiedDiff || !unifiedDiff.trim()) {
    return null
  }

  try {
    // parsePatchFiles expects a complete patch format
    // If the diff doesn't have a proper header, we might need to add one
    let patchContent = unifiedDiff

    // Check if it's a raw hunk without file headers
    // A proper unified diff starts with "---" or "diff --git"
    if (!patchContent.startsWith('---') && !patchContent.startsWith('diff ')) {
      // Wrap in minimal unified diff format
      patchContent = `--- a/${filePath}\n+++ b/${filePath}\n${patchContent}`
    }

    const patches = parsePatchFiles(patchContent)
    const firstPatch = patches[0]
    if (firstPatch && firstPatch.files.length > 0) {
      const firstFile = firstPatch.files[0]
      return firstFile ?? null
    }
    return null
  } catch (e) {
    console.warn('[UnifiedDiffViewer] Failed to parse unified diff:', e)
    return null
  }
}

export function UnifiedDiffViewer({ unifiedDiff, filePath = 'file', ...props }: UnifiedDiffViewerProps) {
  const fileDiff = useMemo(() => parseUnifiedDiff(unifiedDiff, filePath), [unifiedDiff, filePath])
  return <DiffViewer {...props} filePath={filePath} fileDiff={fileDiff} fallback={unifiedDiff} />
}

/** Calculate change counts without rendering the patch. */
export function getUnifiedDiffStats(unifiedDiff: string, filePath: string = 'file'): { additions: number; deletions: number } | null {
  const fileDiff = parseUnifiedDiff(unifiedDiff, filePath)
  return fileDiff ? getDiffStats(fileDiff) : null
}
