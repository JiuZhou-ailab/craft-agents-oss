// input: The real Markdown display boundary in a browser, instrumented only by this probe
// output: Render counts, current callback behavior, and formatting equivalence
// pos: Deterministic component acceptance used by the Electron performance harness
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ResponseCard } from '../../packages/ui/src/components/chat/TurnCard'
import { CollapsibleMarkdownProvider } from '../../packages/ui/src/components/markdown/CollapsibleMarkdownContext'
import { Markdown, MemoizedMarkdown, type MarkdownProps } from '../../packages/ui/src/components/markdown/Markdown'

export async function runMarkdownProbe() {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let renders = 0
  const component = MemoizedMarkdown as unknown as { type: typeof Markdown }
  const original = component.type
  component.type = props => { renders++; return original(props) }
  let unmemoizedRenders = 0
  const Unmemoized = (props: MarkdownProps) => { unmemoizedRenders++; return original(props) }
  const calls: string[] = []
  const content = '# Heading\n\n- First\n- Second **bold**\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n[reference][r]\n\n[r]: https://example.com\n\n```ts\nconst x = 1\n```\n\n$$x^2$$'
  const props: MarkdownProps = { children: content, mode: 'minimal', onUrlClick: () => calls.push('old') }
  const draw = (next: MarkdownProps) => flushSync(() => root.render(<MemoizedMarkdown {...next} />))
  const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
  try {
    for (let i = 0; i <= 50; i++) flushSync(() => root.render(<Unmemoized {...props} />))
    draw(props)
    const initial = renders
    for (let i = 0; i < 50; i++) draw(props)
    check(renders === initial, 'Unchanged displayed text must not re-render Markdown')
    host.querySelector<HTMLAnchorElement>('a')!.click()
    draw({ ...props, onUrlClick: () => calls.push('new'), className: 'updated-display' })
    host.querySelector<HTMLAnchorElement>('a')!.click()
    check(calls.join(',') === 'old,new', 'Link callback must not keep a stale closure')
    check(host.querySelector('.updated-display'), 'Display-only props must update')
    const rendersAfterChangedProps = renders
    const memoHtml = host.innerHTML
    flushSync(() => root.render(<Markdown {...props} onUrlClick={() => {}} className="updated-display" />))
    check(host.innerHTML === memoHtml, 'Memoization must preserve Markdown structure')
    check(host.querySelectorAll('li').length === 2 && host.querySelector('table') && host.querySelector('.katex'), 'Lists, tables and formulas must render')
    flushSync(() => root.render(<CollapsibleMarkdownProvider><MemoizedMarkdown collapsible>{'# Toggle\n\nVisible body'}</MemoizedMarkdown></CollapsibleMarkdownProvider>))
    const contextRenders = renders
    flushSync(() => host.querySelector<HTMLElement>('.markdown-collapsible-section > div')!.click())
    check(renders > contextRenders, 'Context changes must pass through memoization')
    const added: unknown[] = []
    const drawResponse = (text: string, streaming: boolean) => flushSync(() => root.render(<ResponseCard text={text} isStreaming={streaming} messageId="probe" onAddAnnotation={(_id, annotation) => added.push(annotation)} />))
    drawResponse('Received first fragment', true)
    drawResponse('Received first fragment final tail', true)
    drawResponse('Received first fragment final tail', false)
    check(host.textContent?.includes('final tail'), 'Terminal component must not lose throttled tail')
    drawResponse('```ts\nconst annotate = true\n```', false)
    host.querySelector<HTMLElement>('[data-ca-block-path]')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, shiftKey: true }))
    check(added.length === 1, 'Completed response must still accept block annotations')
    return { unmemoizedRenders, contextUpdates: true, componentStreamingToTerminal: true, blockAnnotations: added.length, unchangedUpdates: 50, initialRenders: initial, rendersAfterChangedProps, callbacks: calls, semanticEquality: true }
  } finally {
    root.unmount(); host.remove(); component.type = original
  }
}
void runMarkdownProbe().then(result => { (window as any).__markdownProbe = { result } }, error => { (window as any).__markdownProbe = { error: String(error) } })
