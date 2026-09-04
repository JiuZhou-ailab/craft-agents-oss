// input: Markdown strings containing raw HTML payloads
// output: Regression coverage for inert markdown HTML rendering
// pos: Guards chat and document markdown surfaces from renderer-active HTML

import * as React from 'react'
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))

let Markdown: typeof import('../Markdown').Markdown

beforeAll(async () => {
  Markdown = (await import('../Markdown')).Markdown
})

describe('Markdown raw HTML handling', () => {
  it('does not render raw HTML payloads as active DOM elements', () => {
    const html = renderToStaticMarkup(
      <Markdown>
        {'Before\n\n<sq+qr><iframe srcdoc="<script>alert(1)</script>"></iframe><object data="x"></object><svg onload="alert(1)"></svg><form action="https://example.com"><button>send</button></form><img src="x" onerror="alert(1)">\n\nAfter'}
      </Markdown>
    )

    expect(html).toContain('Before')
    expect(html).toContain('After')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('<object')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;sq+qr&gt;')
    expect(html).toContain('&lt;iframe')
  })
})
