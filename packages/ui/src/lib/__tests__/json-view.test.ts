import { expect, test } from 'bun:test'
import { deepParseJson, craftAgentDarkTheme, craftAgentLightTheme } from '../json-view'

test('expands nested JSON without changing invalid strings, primitives, or input data', () => {
  const input = { result: '{"nested":"[1,null,false]"}', invalid: ' {bad} ', text: '  hello  ' }
  expect(deepParseJson(input)).toEqual({
    result: { nested: [1, null, false] }, invalid: ' {bad} ', text: '  hello  ',
  })
  expect(input.result).toBe('{"nested":"[1,null,false]"}')
  for (const value of [null, undefined, 0, false, '"text"', '42', '']) {
    expect(deepParseJson(value)).toBe(value)
  }
  for (const theme of [craftAgentDarkTheme, craftAgentLightTheme]) {
    expect(theme['--w-rjv-background-color']).toBe('transparent')
    expect(theme['--w-rjv-font-family']).toBe('var(--font-mono, ui-monospace, monospace)')
  }
})
