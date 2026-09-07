// input: Empty and loading chat fallback states
// output: Rendered first-screen regression checks
// pos: Isolated UI test for the shared chat placeholder

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { setupI18n } from '@craft-agent/shared/i18n/setupI18n'
import { initReactI18next } from 'react-i18next'

mock.module('@/contexts/NavigationContext', () => ({
  useNavigationActions: () => ({ navigate: () => {} }),
}))
mock.module('@/context/AppShellContext', () => ({
  useSessionPanelChrome: () => ({}),
}))
setupI18n([initReactI18next])

const { ChatPanelPlaceholder } = await import('../ChatPanelPlaceholder')

describe('ChatPanelPlaceholder', () => {
  it('gives a project without conversations a heading and a central start action', () => {
    const html = renderToStaticMarkup(createElement(ChatPanelPlaceholder, { empty: true }))
    expect(html).toContain('<h2')
    expect(html).toContain('data-testid="start-conversation"')
    expect(html).not.toContain('role="status"')
  })

  it('announces loading instead of leaving the content body blank', () => {
    const html = renderToStaticMarkup(createElement(ChatPanelPlaceholder))
    expect(html).toContain('role="status"')
    expect(html).not.toContain('data-testid="start-conversation"')
  })
})
