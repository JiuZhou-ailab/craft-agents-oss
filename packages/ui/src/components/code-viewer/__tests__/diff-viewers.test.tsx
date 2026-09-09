// input: Equivalent original/modified files and unified patches
// output: Shared rendering, parser statistics, and raw fallback regression checks
// pos: Public diff viewer contract coverage
import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseDiffFromFile } from '@pierre/diffs'
import { ShikiDiffViewer, getDiffStats } from '../ShikiDiffViewer'
import { UnifiedDiffViewer, getUnifiedDiffStats } from '../UnifiedDiffViewer'

const original = 'const value = 1\n'
const modified = 'const value = 2\nconst added = true\n'
const patch = '@@ -1 +1,2 @@\n-const value = 1\n+const value = 2\n+const added = true\n'

describe('diff viewer public entry points', () => {
  it('retains matching change counts for file contents, raw hunks, and complete patches', () => {
    const expected = { additions: 2, deletions: 1 }
    expect(getDiffStats(parseDiffFromFile(
      { name: 'file.ts', contents: original },
      { name: 'file.ts', contents: modified },
    ))).toEqual(expected)
    expect(getUnifiedDiffStats(patch, 'file.ts')).toEqual(expected)
    expect(getUnifiedDiffStats(`--- a/file.ts\n+++ b/file.ts\n${patch}`)).toEqual(expected)
  })

  it('renders both inputs through the same themed container', () => {
    const props = { filePath: 'file.ts', theme: 'dark' as const, diffStyle: 'split' as const, className: 'caller-class' }
    const contents = renderToStaticMarkup(<ShikiDiffViewer {...props} original={original} modified={modified} />)
    const unified = renderToStaticMarkup(<UnifiedDiffViewer {...props} unifiedDiff={patch} />)
    expect(contents).toBe(unified)
    expect(contents).toContain('diffs-container')
    expect(contents).toContain('caller-class')
  })

  it('keeps escaped raw text and empty diff fallbacks when parsing yields no file', () => {
    expect(getUnifiedDiffStats('')).toBeNull()
    expect(getUnifiedDiffStats('diff <not-a-patch>')).toBeNull()
    expect(renderToStaticMarkup(<UnifiedDiffViewer unifiedDiff="" />)).toContain('(empty diff)')
    expect(renderToStaticMarkup(<UnifiedDiffViewer unifiedDiff="diff <not-a-patch>" />)).toContain('&lt;not-a-patch&gt;')
  })
})
