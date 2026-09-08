// input: Real TurnCard props and streamed response fragments
// output: Rendered-body regression coverage across languages and stream lifecycles
// pos: Public chat component seam for first-content visibility

import * as React from 'react'
import { beforeAll, expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

// Vite-owned worker URL is not available in the Bun SSR environment.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))

let TurnCard: typeof import('../TurnCard').TurnCard
beforeAll(async () => { TurnCard = (await import('../TurnCard')).TurnCard })

test('shows the first readable fragment without another chunk or completion', () => {
  for (const text of ['这是已经收到的中文正文。', '日本語の短い回答です。', 'Yes.', '中文 mixed reply', '```ts\nconst answer = 42']) {
    for (const age of [0, 3000, 10000]) {
      const html = renderToStaticMarkup(<TurnCard turnId="turn" activities={[]} isStreaming isComplete={false}
        response={{ text, isStreaming: true, streamStartTime: Date.now() - age }} />)
      expect(html).toContain('data-search-root="response"')
      expect(html).toContain(text.startsWith('```') ? 'answer' : text)
    }
  }
})

test('keeps blank fragments empty and displays completed received text', () => {
  const blank = renderToStaticMarkup(<TurnCard turnId="turn" activities={[]} isStreaming isComplete={false}
    response={{ text: ' \n ', isStreaming: true }} />)
  expect(blank).not.toContain('data-search-root="response"')
  const done = renderToStaticMarkup(<TurnCard turnId="turn" activities={[]} isStreaming={false} isComplete
    response={{ text: '最后一段正文', isStreaming: false }} />)
  expect(done).toContain('最后一段正文')
})

test('shows pending text from the real message-to-turn boundary before classification completes', async () => {
  const { groupMessagesByTurn } = await import('../turn-utils')
  const turns = groupMessagesByTurn([{ id: 'first', role: 'assistant', content: '首片正文', timestamp: 1, isStreaming: true, isPending: true }])
  const turn = turns[0]!
  expect(turn.type).toBe('assistant')
  if (turn.type !== 'assistant') throw new Error('Expected assistant turn')
  const html = renderToStaticMarkup(<TurnCard turnId={turn.turnId} activities={turn.activities} response={turn.response} isStreaming isComplete={false} />)
  expect(html).toContain('data-search-root="response"')
  expect(html).toContain('首片正文')
})
