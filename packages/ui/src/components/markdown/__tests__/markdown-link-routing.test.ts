import { describe, it, expect } from 'bun:test'
import { classifyMarkdownLinkTarget, resolveMarkdownLinkTarget } from '../link-target'

describe('resolveMarkdownLinkTarget', () => {
  it('resolves absolute unix file paths as file targets', () => {
    expect(resolveMarkdownLinkTarget('/Users/balintorosz/.craft-agent/sessions/abc/image.jpg')).toEqual({
      kind: 'file',
      path: '/Users/balintorosz/.craft-agent/sessions/abc/image.jpg',
    })
  })

  it('resolves parent-relative file paths as file targets', () => {
    expect(resolveMarkdownLinkTarget('../downloads/assets/screenshot.png')).toEqual({
      kind: 'file',
      path: '../downloads/assets/screenshot.png',
    })
  })

  it('resolves repo-relative file paths as file targets', () => {
    expect(resolveMarkdownLinkTarget('apps/electron/resources/docs/browser-tools.md')).toEqual({
      kind: 'file',
      path: 'apps/electron/resources/docs/browser-tools.md',
    })
  })

  it('resolves CJK novel chapter paths as file targets (not URLs)', () => {
    expect(resolveMarkdownLinkTarget('./正文/02-别笑了，我真的报警了.md')).toEqual({
      kind: 'file',
      path: './正文/02-别笑了，我真的报警了.md',
    })
    expect(resolveMarkdownLinkTarget('./正文/03-破门前一秒，院士喊停.md')).toEqual({
      kind: 'file',
      path: './正文/03-破门前一秒，院士喊停.md',
    })
  })

  it('decodes percent-encoded CJK relative paths before classifying as files', () => {
    expect(resolveMarkdownLinkTarget('%E6%96%AF%E5%A5%88%E5%BE%B7%E8%8A%82%E6%8B%8D%E8%A1%A8.md')).toEqual({
      kind: 'file', path: '斯奈德节拍表.md',
    })
    const encoded = './%E6%AD%A3%E6%96%87/02-%E5%88%AB%E7%AC%91%E4%BA%86.md'
    expect(resolveMarkdownLinkTarget(encoded)).toEqual({
      kind: 'file',
      path: './正文/02-别笑了.md',
    })
  })

  it('resolves file paths with line suffixes as file targets', () => {
    expect(resolveMarkdownLinkTarget('/Users/tester/project/src/App.tsx:42')).toEqual({
      kind: 'file',
      path: '/Users/tester/project/src/App.tsx',
    })
    expect(resolveMarkdownLinkTarget('apps/electron/src/main.ts:12:4')).toEqual({
      kind: 'file',
      path: 'apps/electron/src/main.ts',
    })
  })

  it('resolves unix file URLs as file targets', () => {
    expect(resolveMarkdownLinkTarget('file:///Users/tester/report.xlsx')).toEqual({
      kind: 'file',
      path: '/Users/tester/report.xlsx',
    })
  })

  it('decodes percent-encoded unix file URLs', () => {
    expect(resolveMarkdownLinkTarget('file:///Users/tester/report%20final.pdf')).toEqual({
      kind: 'file',
      path: '/Users/tester/report final.pdf',
    })
  })

  it('normalizes windows drive-letter file URLs to local paths', () => {
    expect(resolveMarkdownLinkTarget('file:///C:/Users/Tester/Deck.pptx')).toEqual({
      kind: 'file',
      path: 'C:/Users/Tester/Deck.pptx',
    })
  })

  it('resolves https links as url targets', () => {
    expect(resolveMarkdownLinkTarget('https://example.com/image.jpg')).toEqual({
      kind: 'url',
      url: 'https://example.com/image.jpg',
    })
  })

  it('resolves mailto links as url targets', () => {
    expect(resolveMarkdownLinkTarget('mailto:test@example.com')).toEqual({
      kind: 'url',
      url: 'mailto:test@example.com',
    })
  })
})

describe('classifyMarkdownLinkTarget', () => {
  it('classifies absolute unix file paths as file', () => {
    expect(classifyMarkdownLinkTarget('/Users/balintorosz/.craft-agent/sessions/abc/image.jpg')).toBe('file')
  })

  it('classifies file paths with line suffixes as file', () => {
    expect(classifyMarkdownLinkTarget('/Users/tester/project/src/App.tsx:42')).toBe('file')
  })

  it('classifies file URLs as file', () => {
    expect(classifyMarkdownLinkTarget('file:///Users/tester/report.xlsx')).toBe('file')
  })

  it('classifies https links as url', () => {
    expect(classifyMarkdownLinkTarget('https://example.com/image.jpg')).toBe('url')
  })

  it('classifies mailto links as url', () => {
    expect(classifyMarkdownLinkTarget('mailto:test@example.com')).toBe('url')
  })
})
