// input: FileViewer source and the AppShell call site that hosts project-file previews
// output: Regression coverage for embedded JSON/PDF rendering and tab-close wiring
// pos: Source-contract guard for non-editable project files in the right workspace

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'

const fileViewerSource = readFileSync(new URL('../FileViewer.tsx', import.meta.url), 'utf8')
const appShellSource = readFileSync(new URL('../../app-shell/AppShell.tsx', import.meta.url), 'utf8')

describe('workspace file previews', () => {
  it('renders JSON and PDF through the embedded preview surface', () => {
    expect(fileViewerSource).toContain("previewKind === 'pdf'")
    expect(fileViewerSource).toContain("previewKind === 'json' && !isLoading")
    expect(fileViewerSource).toContain("{ type: 'pdf', filePath: path }")
    expect(fileViewerSource).toContain("{ type: 'json', filePath: path, content, error: error ?? undefined }")
    expect(fileViewerSource).toContain('<FilePreviewRenderer')
    expect(fileViewerSource).toContain('loadPdfData={loadPdfData}')
    expect(fileViewerSource).toContain('embedded')
  })

  it('keeps the embedded preview connected to the active project tab', () => {
    expect(appShellSource).toContain('onClose={() => { void handleCloseNovelFileTab(selectedNovelFile.path) }}')
    expect(fileViewerSource).toContain('onClose={onClose ?? (() => {})}')
  })
})
