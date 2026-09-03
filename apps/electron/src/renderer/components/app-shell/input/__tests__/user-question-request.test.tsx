// input: Structured single- and multi-select user questions plus their input shell
// output: Accessible tab pages, guarded submission markup, and viewport-aware prompt height
// pos: Minimal renderer checks for ask_user_question's paged human input component

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { UserQuestionRequest } from '../structured/UserQuestionRequest'

const inputContainerSource = readFileSync(new URL('../InputContainer.tsx', import.meta.url), 'utf-8')
const userQuestionSource = readFileSync(new URL('../structured/UserQuestionRequest.tsx', import.meta.url), 'utf-8')

const testI18n = createInstance().use(initReactI18next)
await testI18n.init({
  lng: 'zh-Hans',
  keySeparator: false,
  resources: {
    'zh-Hans': {
      translation: {
        'chat.questionOther': '其他答案…',
        'chat.questionRequired': '需要你的选择',
        'common.cancel': '取消',
        'common.submit': '提交',
      },
    },
  },
})

describe('UserQuestionRequest', () => {
  it('renders one question per accessible tab page with guarded submission', () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <UserQuestionRequest
          request={{
            requestId: 'question-1',
            sessionId: 'session-1',
            questions: [
              {
                header: '范围',
                question: '修改哪些内容？',
                options: [
                  { label: '当前文件', description: '只改当前文件' },
                  { label: '全部文件', description: '改动整个项目' },
                ],
                multiSelect: false,
              },
              {
                header: '检查',
                question: '需要哪些验证？',
                options: [
                  { label: '类型', description: '运行类型检查' },
                  { label: '构建', description: '运行构建' },
                ],
                multiSelect: true,
              },
            ],
          }}
          onResponse={() => {}}
        />
      </I18nextProvider>
    )

    expect(html).toContain('role="tablist"')
    expect(html).toContain('role="tab"')
    expect(html).toContain('只改当前文件')
    expect(html).not.toContain('运行类型检查')
    expect(html).toContain('type="radio"')
    expect(html).toContain('其他答案')
    expect(html).toContain('disabled=""')
  })

  it('uses the shared viewport-aware maximum instead of a user-question hard cap', () => {
    expect(inputContainerSource).toContain('const structuredMaxHeight = getStructuredInputMaxHeight(viewportHeight)')
    expect(inputContainerSource).not.toContain("structuredInput?.type === 'user_question'")
  })

  it('enters free-form mode as soon as the other-answer input receives focus', () => {
    expect(userQuestionSource).toContain(`onFocus={() => {
                    setSelected(current => ({ ...current, [question.question]: [] }))`)
  })
})
