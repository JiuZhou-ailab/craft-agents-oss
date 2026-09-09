import * as React from 'react'
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PlatformProvider } from '../../../context/PlatformContext'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))

let Markdown: typeof import('../Markdown').Markdown

beforeAll(async () => {
  Markdown = (await import('../Markdown')).Markdown
})

describe('Markdown link href safety', () => {
  it('offers a context menu only for local file links when the host can reveal files', () => {
    const content = '[斯奈德节拍表.md](%E6%96%AF%E5%A5%88%E5%BE%B7%E8%8A%82%E6%8B%8D%E8%A1%A8.md) [web](https://example.com/report.md)'
    const html = renderToStaticMarkup(
      <PlatformProvider actions={{ onRevealInFinder: () => {} }}><Markdown>{content}</Markdown></PlatformProvider>,
    )
    expect(html.match(/data-state="closed"/g)).toHaveLength(1)
    expect(html).toContain('斯奈德节拍表.md')
    expect(html).toContain('href="https://example.com/report.md"')
    expect(renderToStaticMarkup(<Markdown>{content}</Markdown>)).not.toContain('data-state="closed"')
  })
  it('omits dangerous schemes from DOM href attributes', () => {
    const html = renderToStaticMarkup(<Markdown>{'[bad](javascript:alert(1)) [ok](https://example.com)'}</Markdown>)

    expect(html).toContain('href="https://example.com"')
    expect(html).not.toContain('href="javascript:')
  })

  it('preserves file URLs for local file routing', () => {
    const html = renderToStaticMarkup(<Markdown>{'[report](file:///Users/tester/report.pdf)'}</Markdown>)

    expect(html).toContain('href="file:///Users/tester/report.pdf"')
  })

  it('can suppress images for untrusted Markdown', () => {
    const html = renderToStaticMarkup(
      <Markdown allowImages={false}>{'![tracking pixel](https://example.com/pixel.png)'}</Markdown>,
    )

    expect(html).not.toContain('<img')
    expect(html).not.toContain('pixel.png')
  })
})
