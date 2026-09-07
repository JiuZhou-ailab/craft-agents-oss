import { vscodeTheme } from '@uiw/react-json-view/vscode'
import { githubLightTheme } from '@uiw/react-json-view/githubLight'

export const craftAgentDarkTheme = {
  ...vscodeTheme,
  '--w-rjv-font-family': 'var(--font-mono, ui-monospace, monospace)',
  '--w-rjv-background-color': 'transparent',
}

export const craftAgentLightTheme = {
  ...githubLightTheme,
  '--w-rjv-font-family': 'var(--font-mono, ui-monospace, monospace)',
  '--w-rjv-background-color': 'transparent',
}

export function deepParseJson(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return deepParseJson(JSON.parse(trimmed))
      } catch {
        return value
      }
    }
    return value
  }
  if (Array.isArray(value)) return value.map(deepParseJson)
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) result[k] = deepParseJson(v)
    return result
  }
  return value
}
