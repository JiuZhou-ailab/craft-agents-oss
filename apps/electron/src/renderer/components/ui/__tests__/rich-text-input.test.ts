// input: Rich-text DOM fixtures and input lifecycle edge cases
// output: Regression proof for stable plain-text extraction and IME-safe behavior
// pos: Unit boundary for the shared chat contenteditable primitive

import { readFileSync } from 'fs'
import { afterAll, beforeAll, describe, it, expect } from 'bun:test'
import { iconCache } from '@/lib/icon-cache'
import {
  exceedsLongTextLineThreshold,
  getCursorPosition,
  getTextFromElement,
  inferCursorPositionAfterEdit,
  isEscapeDuringComposition,
  isRichTextDomMutationSafe,
  renderBadgeHTML,
  shouldShowRichTextPlaceholder,
  textToHTML,
} from '../rich-text-input'

const originalNode = globalThis.Node

beforeAll(() => {
  Object.defineProperty(globalThis, 'Node', {
    configurable: true,
    value: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
  })
})

afterAll(() => {
  if (originalNode) {
    Object.defineProperty(globalThis, 'Node', { configurable: true, value: originalNode })
  } else {
    Reflect.deleteProperty(globalThis, 'Node')
  }
})

function domElement(tagName: string, childNodes: Node[] = []): HTMLElement {
  return {
    nodeType: 1,
    tagName,
    childNodes,
    contains: (node: Node) => childNodes.includes(node),
    getAttribute: () => null,
  } as unknown as HTMLElement
}

function domText(textContent: string): Node {
  return { nodeType: 3, textContent } as Node
}

describe('getTextFromElement', () => {
  it('treats the contenteditable empty sentinel as zero model text', () => {
    expect(getTextFromElement(domElement('DIV', [domElement('BR')]))).toBe('')
  })

  it('preserves an intentional line break between text nodes', () => {
    expect(getTextFromElement(domElement('DIV', [
      domText('first'),
      domElement('BR'),
      domText('second'),
    ]))).toBe('first\nsecond')
  })
})

describe('inferCursorPositionAfterEdit', () => {
  it('recovers the changed-range end when Chromium temporarily loses selection', () => {
    expect(inferCursorPositionAfterEdit('', '/', 0)).toBe(1)
    expect(inferCursorPositionAfterEdit('draft', 'dr/aft', 2)).toBe(3)
    expect(inferCursorPositionAfterEdit('/', '', 1)).toBe(0)
  })
})

describe('getCursorPosition', () => {
  function withSelectionMocks(
    selection: { rangeCount: number; getRangeAt?: () => { startContainer: Node; startOffset: number } },
    createRangeImpl: (() => {
      selectNodeContents: () => void
      setEnd: () => void
      cloneContents: () => Node
    }) | undefined,
    run: () => void,
  ) {
    const originalWindow = globalThis.window
    const originalDocument = globalThis.document
    const fragment = domElement('DIV')
    const extractionRoot = Object.assign(domElement('DIV'), {
      appendChild: (node: Node) => node,
    })

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        getSelection: () => selection,
      },
    })
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createRange: createRangeImpl ?? (() => ({
          selectNodeContents: () => {},
          setEnd: () => {},
          cloneContents: () => fragment,
        })),
        createElement: () => extractionRoot,
      },
    })

    try {
      run()
    } finally {
      if (originalWindow) {
        Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
      } else {
        Reflect.deleteProperty(globalThis, 'window')
      }
      if (originalDocument) {
        Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument })
      } else {
        Reflect.deleteProperty(globalThis, 'document')
      }
    }
  }

  it('uses the inferred fallback when selection still belongs to the previous session editor', () => {
    withSelectionMocks(
      {
        rangeCount: 1,
        getRangeAt: () => ({ startContainer: domText('old editor'), startOffset: 0 }),
      },
      undefined,
      () => {
        expect(getCursorPosition(domElement('DIV'), 1)).toBe(1)
      },
    )
  })

  it('uses the inferred fallback when selection is temporarily missing', () => {
    withSelectionMocks(
      { rangeCount: 0 },
      undefined,
      () => {
        expect(getCursorPosition(domElement('DIV'), 1)).toBe(1)
      },
    )
  })

  it('uses the inferred fallback when mapping the live selection throws', () => {
    const currentEditor = domElement('DIV', [domText('/')])
    withSelectionMocks(
      {
        rangeCount: 1,
        getRangeAt: () => ({ startContainer: currentEditor.childNodes[0], startOffset: 1 }),
      },
      () => ({
        selectNodeContents: () => {},
        setEnd: () => {
          throw new DOMException('Invalid boundary', 'InvalidStateError')
        },
        cloneContents: () => domElement('DIV'),
      }),
      () => {
        expect(getCursorPosition(currentEditor, 1)).toBe(1)
      },
    )
  })
})

describe('shouldShowRichTextPlaceholder', () => {
  it('hides the placeholder while the IME owns visible composition text', () => {
    expect(shouldShowRichTextPlaceholder('', true)).toBe(false)
    expect(shouldShowRichTextPlaceholder('', false)).toBe(true)
    expect(shouldShowRichTextPlaceholder('你', true)).toBe(false)
  })
})

describe('isRichTextDomMutationSafe', () => {
  it('accepts ordinary input immediately after composition ends', () => {
    expect(isRichTextDomMutationSafe(false, false)).toBe(true)
  })

  it('protects the IME-owned DOM while either composition signal is active', () => {
    expect(isRichTextDomMutationSafe(true, false)).toBe(false)
    expect(isRichTextDomMutationSafe(false, true)).toBe(false)
  })
})

describe('isEscapeDuringComposition', () => {
  it('returns true for Escape when local composition ref is active', () => {
    expect(isEscapeDuringComposition({ key: 'Escape' }, true)).toBe(true)
  })

  it('returns true for Escape when nativeEvent.isComposing is true', () => {
    expect(
      isEscapeDuringComposition(
        { key: 'Escape', nativeEvent: { isComposing: true } },
        false
      )
    ).toBe(true)
  })

  it('returns true for Escape when event.isComposing is true', () => {
    expect(isEscapeDuringComposition({ key: 'Escape', isComposing: true }, false)).toBe(true)
  })

  it('returns false for Escape when no composition signal is active', () => {
    expect(isEscapeDuringComposition({ key: 'Escape' }, false)).toBe(false)
  })

  it('returns false for non-Escape keys even if composing', () => {
    expect(isEscapeDuringComposition({ key: 'Enter', isComposing: true }, true)).toBe(false)
  })
})

describe('exceedsLongTextLineThreshold', () => {
  it('detects long pasted text without requiring exact full line count', () => {
    expect(exceedsLongTextLineThreshold(Array.from({ length: 100 }, () => 'x').join('\n'))).toBe(false)
    expect(exceedsLongTextLineThreshold(Array.from({ length: 101 }, () => 'x').join('\n'))).toBe(true)
  })
})

describe('renderBadgeHTML', () => {
  it('keeps cached icon URLs and tooltips inside their HTML attributes', () => {
    const workspaceId = 'workspace'
    const sourceSlug = 'source'
    const untrustedAttributeValue = `https://example.test/icon?a=1&b=" autofocus='yes' <tag>>`
    const escapedAttributeValue = 'https://example.test/icon?a=1&amp;b=&quot; autofocus=&#39;yes&#39; &lt;tag&gt;&gt;'
    const source = {
      config: { slug: sourceSlug, name: 'Source' },
    } as Parameters<typeof renderBadgeHTML>[3]

    iconCache.set(`source:${workspaceId}:${sourceSlug}`, untrustedAttributeValue)
    try {
      const html = renderBadgeHTML(
        'source',
        'Source',
        undefined,
        source,
        workspaceId,
        untrustedAttributeValue,
      )

      expect(html).toContain(`src="${escapedAttributeValue}"`)
      expect(html).toContain(`title="${escapedAttributeValue}"`)
      expect(html).not.toContain('" autofocus=')
    } finally {
      iconCache.delete(`source:${workspaceId}:${sourceSlug}`)
    }
  })
})

describe('textToHTML', () => {
  it('keeps the original mention text inside its data attribute', () => {
    const html = textToHTML(
      `[file:dir/a&"'<tag>.md]`,
      [],
      [],
      new Map(),
      new Map(),
    )

    expect(html).toContain('data-mention-text="[file:dir/a&amp;&quot;&#39;&lt;tag&gt;.md]"')
    expect(html).not.toContain('data-mention-text="[file:dir/a&amp;&quot;\'')
  })
})

describe('RichTextInput mention hot paths', () => {
  it('skips mention signature work for ordinary input without bracket tokens', () => {
    const source = readFileSync(new URL('../rich-text-input.tsx', import.meta.url), 'utf-8')
    const handlerStart = source.indexOf('const handleInput = React.useCallback')
    const handlerEnd = source.indexOf('// Handle composition events', handlerStart)
    const handlerSource = source.slice(handlerStart, handlerEnd)

    expect(handlerSource).toContain("const mayHaveMentions = newText.includes('[') || !!lastMentionSignatureRef.current")
    expect(handlerSource).toContain('if (mayHaveMentions) {')
    expect(handlerSource).toContain('const newSignature = getMentionSignature(newText, skillSlugs, sourceSlugs)')
  })

  it('reuses mention lookup data while converting text to html', () => {
    const source = readFileSync(new URL('../rich-text-input.tsx', import.meta.url), 'utf-8')
    const textToHTMLStart = source.indexOf('function textToHTML')
    const textToHTMLEnd = source.indexOf('function getMentionSignature', textToHTMLStart)
    const textToHTMLSource = source.slice(textToHTMLStart, textToHTMLEnd)

    expect(source).toContain('const skillBySlug = React.useMemo')
    expect(source).toContain('const sourceBySlug = React.useMemo')
    expect(source).toContain('textToHTML(newText, skillSlugs, sourceSlugs, skillBySlug, sourceBySlug')
    expect(textToHTMLSource).not.toContain('skills.map(s => s.slug)')
    expect(textToHTMLSource).not.toContain('sources.map(s => s.config.slug)')
    expect(textToHTMLSource).not.toContain('skills.find(s => s.slug === match.id)')
    expect(textToHTMLSource).not.toContain('sources.find(s => s.config.slug === match.id)')
  })
})
