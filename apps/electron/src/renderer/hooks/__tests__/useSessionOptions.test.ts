// input: session-scoped option maps and partial option updates
// output: regression coverage for preserving option map references on no-op writes
// pos: guards App-level sessionOptions context state against unnecessary invalidation

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  defaultSessionOptions,
  sessionOptionsAtom,
  sessionOptionsAtomFamily,
  updateSessionOptionsMap,
  initializeSessionOptionsMap,
  type SessionOptions,
} from '../useSessionOptions'

const appSource = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf-8')
const appShellContextSource = readFileSync(new URL('../../context/AppShellContext.tsx', import.meta.url), 'utf-8')
const appShellSource = readFileSync(new URL('../../components/app-shell/AppShell.tsx', import.meta.url), 'utf-8')

describe('updateSessionOptionsMap', () => {
  it('keeps the original map when default options are not stored', () => {
    const options = new Map<string, SessionOptions>()

    expect(updateSessionOptionsMap(options, 's1', defaultSessionOptions)).toBe(options)
  })

  it('keeps the original map when stored options are unchanged', () => {
    const current = { ...defaultSessionOptions, permissionMode: 'allow-all' as const }
    const options = new Map<string, SessionOptions>([['s1', current]])

    expect(updateSessionOptionsMap(options, 's1', { permissionMode: 'allow-all' })).toBe(options)
  })

  it('stores non-default options', () => {
    const options = new Map<string, SessionOptions>()
    const next = updateSessionOptionsMap(options, 's1', { permissionMode: 'allow-all' })

    expect(next).not.toBe(options)
    expect(next.get('s1')?.permissionMode).toBe('allow-all')
  })

  it('deletes stored options when they return to defaults', () => {
    const options = new Map<string, SessionOptions>([
      ['s1', { ...defaultSessionOptions, permissionMode: 'allow-all' }],
    ])
    const next = updateSessionOptionsMap(options, 's1', { permissionMode: defaultSessionOptions.permissionMode })

    expect(next).not.toBe(options)
    expect(next.has('s1')).toBe(false)
  })

  it('does not rebuild message sending when unrelated session options change', () => {
    const sendMessageSource = appSource.slice(
      appSource.indexOf('const handleSendMessage = useCallback'),
      appSource.indexOf('const handleSessionOptionsChange')
    )

    const dependencyList = sendMessageSource.slice(sendMessageSource.lastIndexOf('}, ['))
    expect(dependencyList).not.toContain('sessionOptions')
  })

  it('keeps session option state out of the broad app shell context', () => {
    expect(appShellContextSource).not.toContain('sessionOptions: Map')
    expect(appShellContextSource).not.toContain('sessionOptions.get(sessionId)')
    expect(appShellSource).not.toContain('contextValue.sessionOptions')
  })

  it('does not notify other sessions when one session option changes', () => {
    const store = createStore()
    const s2OptionsAtom = sessionOptionsAtomFamily('s2')
    let s2Notifications = 0

    expect(store.get(s2OptionsAtom)).toBe(defaultSessionOptions)
    const unsubscribe = store.sub(s2OptionsAtom, () => {
      s2Notifications++
    })

    store.set(
      sessionOptionsAtom,
      updateSessionOptionsMap(store.get(sessionOptionsAtom), 's1', { permissionMode: 'allow-all' })
    )

    unsubscribe()
    expect(store.get(sessionOptionsAtomFamily('s1')).permissionMode).toBe('allow-all')
    expect(store.get(s2OptionsAtom)).toBe(defaultSessionOptions)
    expect(s2Notifications).toBe(0)
  })
})


describe('initial permission snapshot', () => {
  const oldOptions: SessionOptions = { ...defaultSessionOptions, permissionMode: 'allow-all', permissionModeVersion: 8 }
  const before = new Map([['s1', oldOptions]])

  it('accepts a new Host snapshot when no event arrived during the load', () => {
    const result = initializeSessionOptionsMap([{ id: 's1', permissionMode: 'safe', permissionModeVersion: 1 }], before, before)
    expect(result.get('s1')?.permissionMode).toBe('safe')
    expect(result.get('s1')?.permissionModeVersion).toBe(1)
    const changedThinking = new Map([['s1', { ...oldOptions, thinkingLevel: 'max' as const }]])
    expect(initializeSessionOptionsMap([{ id: 's1', permissionMode: 'safe', permissionModeVersion: 1 }], before, changedThinking).get('s1')?.permissionModeVersion).toBe(1)
  })

  it('preserves a newer event received while the snapshot was in flight', () => {
    const empty = new Map<string, SessionOptions>()
    const event = new Map([['s1', { ...defaultSessionOptions, permissionMode: 'safe' as const, permissionModeVersion: 2 }]])
    const result = initializeSessionOptionsMap([{ id: 's1', permissionMode: 'allow-all', permissionModeVersion: 1 }], empty, event)
    expect(result.get('s1')?.permissionMode).toBe('safe')
    expect(result.get('s1')?.permissionModeVersion).toBe(2)
    const newerSnapshot = initializeSessionOptionsMap([{ id: 's1', permissionMode: 'ask', permissionModeVersion: 3 }], empty, event)
    expect(newerSnapshot.get('s1')?.permissionMode).toBe('ask')
    expect(newerSnapshot.get('s1')?.permissionModeVersion).toBe(3)
  })
})
