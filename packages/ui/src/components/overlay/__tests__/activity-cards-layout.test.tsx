import * as React from 'react'
import { afterAll, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FullscreenOverlayBaseHeader } from '../FullscreenOverlayBaseHeader'
import { PreviewOverlay, type PreviewOverlayProps } from '../PreviewOverlay'

// Keep the real header and content; omit the browser-only dialog portal for SSR.
mock.module('../PreviewOverlay', () => ({
  PreviewOverlay: ({ children, ...props }: PreviewOverlayProps) => (
    <div><FullscreenOverlayBaseHeader {...props} />{children}</div>
  ),
}))
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
const { ActivityCardsOverlay } = await import('../ActivityCardsOverlay')
afterAll(() => { mock.module('../PreviewOverlay', () => ({ PreviewOverlay })) })

it('renders one activity title and flat content, retaining labels when sections need distinguishing', () => {
  const output = { id: 'output', label: 'Output', data: { type: 'document' as const, content: '**Scheduled tasks**\n\nOriginal content.' } }
  const render = (cards = [output], title = 'Activity') => renderToStaticMarkup(
    <ActivityCardsOverlay isOpen onClose={() => {}} title={title} cards={cards} />,
  )
  const single = render()
  expect(single.match(/>Activity</g)).toHaveLength(1)
  expect(single).toContain('Original content.')
  expect(single).not.toContain('shadow-strong')
  expect(single).not.toContain('<h3')
  const multiple = render([{ ...output, id: 'input', label: 'Input' }, output], 'Read')
  expect(multiple.match(/<h3 /g)).toHaveLength(2)
  expect(multiple).toContain('>Input</h3>')
  expect(multiple).toContain('>Output</h3>')
  expect(multiple).toContain('>Read</span>')
  expect(multiple).not.toContain('shadow-strong')
})
