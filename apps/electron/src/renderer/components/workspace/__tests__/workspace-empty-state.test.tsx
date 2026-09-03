// input: Empty project identity, root path, and existing workspace actions
// output: Regression coverage for the first-class blank workspace surface
// pos: Protects the cold-start boundary between the project tree and chat

import { readFileSync } from 'fs'
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { setupI18n } from '@craft-agent/shared/i18n/setupI18n'
import { initReactI18next } from 'react-i18next'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
setupI18n([initReactI18next])

let WorkspaceEmptyState: typeof import('../WorkspaceEmptyState').WorkspaceEmptyState

beforeAll(async () => {
  const module = await import('../WorkspaceEmptyState')
  WorkspaceEmptyState = module.WorkspaceEmptyState
})

describe('WorkspaceEmptyState', () => {
  it('renders a valid empty project as an actionable workspace', () => {
    const html = renderToStaticMarkup(
      <WorkspaceEmptyState
        workspaceName="九州新项目"
        rootPath="/Users/zjding/Stories/jiuzhou"
        onCreateFile={() => {}}
        onImportFiles={() => {}}
        onOpenSkills={() => {}}
      />
    )

    expect(html).toContain('data-testid="workspace-empty-state"')
    expect(html).toContain('九州新项目')
    expect(html).toContain('/Users/zjding/Stories/jiuzhou')
    expect(html).toContain('data-workspace-action="create-file"')
    expect(html).toContain('data-workspace-action="import-files"')
    expect(html).toContain('data-workspace-action="open-skills"')
    expect(html).toContain('flex h-full min-h-0 flex-1 items-center justify-center overflow-y-auto px-5 py-8')
    // Match chat-opening action cards: soft border + label/desc, not stacked primary buttons.
    expect(html).toContain('min-h-[52px] rounded-[7px] border border-border/60 bg-background')
    expect(html).toContain('shadow-minimal')
    expect(html).not.toContain('data-slot="button"')
    expect(html).not.toContain('lucide-folder-open')
    expect(html).not.toContain('<header')
    expect(html).not.toContain('writing.emptySection')
  })

  it('keeps the editor file-scoped and lets AppShell own the empty-project branch', () => {
    const appShellSource = readFileSync(new URL('../../app-shell/AppShell.tsx', import.meta.url), 'utf-8')
    const editorSource = readFileSync(new URL('../../writing/NovelDocumentEditorPanel.tsx', import.meta.url), 'utf-8')

    expect(appShellSource).toContain("selectedNovelFile ? selectedNovelFileOpenTarget === 'editor' ? (")
    expect(appShellSource).toContain('<WorkspaceEmptyState')
    expect(appShellSource).toContain('onCreateFile={() => handleWorkspaceOpeningCommand')
    expect(appShellSource).toContain('<div className="min-w-0 flex-1">')
    expect(editorSource).not.toContain('WorkspaceEmptyState')
  })
})
