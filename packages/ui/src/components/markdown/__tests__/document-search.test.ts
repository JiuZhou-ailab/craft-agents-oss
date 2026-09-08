import { describe, expect, it } from 'bun:test'
import { Editor } from '@tiptap/core'
import { Fragment } from '@tiptap/pm/model'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { locateDocumentSearch } from '../document-search'

describe('source search navigation', () => {
  it('reveals the source occurrence through Markdown structure, not visual lines', () => {
    for (const source of [
      '# needle\n\n- first needle\n- second **needle**\n\n[needle][ref]\n\n[ref]: https://example.com',
      'needle\n\n```ts\nneedle\n```\n\n尾声 needle',
      'first needle\nsecond needle\nthird needle',
      '[needle]\n\n[needle]: https://example.com',
      '[needle][]\n\n[needle]: https://example.com',
      '<https://needle.test>',
    ]) {
      const editor = new Editor({ extensions: [StarterKit, Markdown], content: source, contentType: 'markdown' })
      const parse = (text: string) => editor.schema.nodeFromJSON(editor.markdown.parse(text))
      for (const [i, line] of source.split('\n').entries()) {
        if (!line.includes('needle') || line.startsWith('[needle]:')) continue
        const result = locateDocumentSearch(source, { lineNumber: i + 1, query: 'needle', snippet: line, requestId: 'test' }, editor.state.doc, parse)
        expect(result.status).toBe('located')
        expect(editor.state.doc.textBetween(result.from!, result.to!)).toBe('needle')
        const preceding = source.split('\n').slice(0, i).join('\n').match(/needle/g)?.length ?? 0
        expect(editor.state.doc.textBetween(0, result.from!).match(/needle/g)?.length ?? 0).toBe(preceding)
      }
      editor.destroy()
    }
  })
  it('reports relocated, missing, and non-visible source matches truthfully', () => {
    const source = 'first\n\nnew needle\n\n[link](https://needle.test)'
    const editor = new Editor({ extensions: [StarterKit, Markdown], content: source, contentType: 'markdown' })
    const parse = (text: string) => editor.schema.nodeFromJSON(editor.markdown.parse(text))
    const target = { lineNumber: 1, query: 'needle', snippet: 'old needle', requestId: 'test' }
    expect(locateDocumentSearch(source, target, editor.state.doc, parse).status).toBe('relocated')
    expect(locateDocumentSearch(source, { ...target, query: 'missing' }, editor.state.doc, parse).status).toBe('missing')
    expect(locateDocumentSearch(source, { ...target, lineNumber: 5, snippet: '[link](https://needle.test)' }, editor.state.doc, parse).status).toBe('not-visible')
    const withTrailingParagraph = editor.state.doc.copy(editor.state.doc.content.append(Fragment.from(editor.schema.nodes.paragraph!.create())))
    expect(locateDocumentSearch(source, target, withTrailingParagraph, parse).status).toBe('relocated')
    editor.destroy()
  })
})
