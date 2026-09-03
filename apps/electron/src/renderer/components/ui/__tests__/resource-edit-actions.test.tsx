// input: Resource edit action props for config-backed entities
// output: Regression coverage for separate manual and AI edit affordances
// pos: Keeps resource edit controls from collapsing manual editing into AI-only flows

import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
mock.module('beautiful-mermaid', () => ({
  renderMermaidSVG: () => '<svg width="320" height="180"><text>mock mermaid</text></svg>',
}))

let ManualEditButton: typeof import('../manual-edit-button').ManualEditButton
let selectManualEditOpener: typeof import('../manual-edit-button').selectManualEditOpener

beforeAll(async () => {
  const module = await import('../manual-edit-button')
  ManualEditButton = module.ManualEditButton
  selectManualEditOpener = module.selectManualEditOpener
})

describe('resource edit actions', () => {
  it('renders a direct manual edit button for file-backed resources', () => {
    const html = renderToStaticMarkup(
      <ManualEditButton
        label="Edit File"
        filePath="/workspace/sources/github/config.json"
        onOpenFile={() => {}}
      />
    )

    expect(html).toContain('data-testid="manual-edit-file-button"')
    expect(html).toContain('Edit File')
    expect(html).toContain('title="Edit File"')
  })

  it('uses the external file opener for manual editing instead of the preview opener', async () => {
    const calls: string[] = []
    const previewOpen = async (path: string) => { calls.push(`preview:${path}`) }
    const externalOpen = async (path: string) => { calls.push(`external:${path}`) }

    const openFile = selectManualEditOpener({
      onOpenFileExternal: externalOpen,
      onOpenFile: previewOpen,
    })

    expect(openFile).toBeDefined()
    if (!openFile) throw new Error('Expected manual edit opener')
    await openFile('/workspace/skills/review/SKILL.md')

    expect(calls).toEqual(['external:/workspace/skills/review/SKILL.md'])
  })
})
