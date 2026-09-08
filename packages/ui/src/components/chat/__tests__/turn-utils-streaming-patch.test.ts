// input: Prior transcript turns plus a structure-stable text_delta content growth
// output: Regression coverage for O(1)-ish turn patch vs full regroup
// pos: Continuous-axis guard — stream frame cost must not depend on history length

import { describe, expect, it } from 'bun:test'
import {
  groupMessagesByTurn,
  tryPatchTurnsForStreamingContentChange,
  type Turn,
} from '../turn-utils'
import type { Message } from '@craft-agent/core'

function user(id: string, content: string, timestamp: number): Message {
  return { id, role: 'user', content, timestamp }
}

function streamingAssistant(id: string, content: string, timestamp: number, turnId = 'turn-live'): Message {
  return {
    id,
    role: 'assistant',
    content,
    timestamp,
    turnId,
    isStreaming: true,
    isPending: true,
  }
}

function buildLongHistory(completedTurns: number): Message[] {
  const messages: Message[] = []
  let ts = 1_000
  for (let i = 0; i < completedTurns; i++) {
    messages.push(user(`u-${i}`, `prompt ${i}`, ts++))
    messages.push({
      id: `a-${i}`,
      role: 'assistant',
      content: `answer ${i}`,
      timestamp: ts++,
      turnId: `turn-${i}`,
    })
  }
  messages.push(user('u-live', 'live prompt', ts++))
  messages.push(streamingAssistant('a-live', 'Hel', ts++))
  return messages
}

function growLastContent(messages: Message[], nextContent: string): Message[] {
  const next = messages.slice()
  const last = next[next.length - 1]!
  next[next.length - 1] = { ...last, content: nextContent }
  return next
}

function assistantResponseText(turns: readonly Turn[]): string | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (turn?.type !== 'assistant') continue
    const lastIntermediate = [...turn.activities].reverse().find(a => a.type === 'intermediate')
    if (lastIntermediate?.content) return lastIntermediate.content
    return turn.response?.text
  }
  return undefined
}

describe('tryPatchTurnsForStreamingContentChange', () => {
  it('patches pending response content without regrouping when only delta content grows', () => {
    const previousMessages = buildLongHistory(3)
    const previousTurns = groupMessagesByTurn(previousMessages)
    const nextMessages = growLastContent(previousMessages, 'Hello')

    const patched = tryPatchTurnsForStreamingContentChange(
      previousMessages,
      nextMessages,
      previousTurns,
    )

    expect(patched).not.toBeNull()
    expect(patched).not.toBe(previousTurns)
    expect(assistantResponseText(patched!)).toBe('Hello')
    expect(patched!.length).toBe(previousTurns.length)

    const full = groupMessagesByTurn(nextMessages)
    expect(assistantResponseText(patched!)).toBe(assistantResponseText(full))
    expect(patched!.map(t => t.type)).toEqual(full.map(t => t.type))
  })

  it('returns null when a new message is appended (structure change)', () => {
    const previousMessages = buildLongHistory(2)
    const previousTurns = groupMessagesByTurn(previousMessages)
    const nextMessages = [
      ...previousMessages,
      streamingAssistant('a-extra', 'x', Date.now(), 'turn-extra'),
    ]

    expect(
      tryPatchTurnsForStreamingContentChange(previousMessages, nextMessages, previousTurns),
    ).toBeNull()
  })

  it('returns null when streaming lifecycle flags change', () => {
    const previousMessages = buildLongHistory(1)
    const previousTurns = groupMessagesByTurn(previousMessages)
    const nextMessages = previousMessages.slice()
    const last = nextMessages[nextMessages.length - 1]!
    nextMessages[nextMessages.length - 1] = {
      ...last,
      content: `${last.content}!`,
      isPending: false,
      isStreaming: false,
      isIntermediate: false,
    }

    expect(
      tryPatchTurnsForStreamingContentChange(previousMessages, nextMessages, previousTurns),
    ).toBeNull()
  })

  it('returns null when an earlier message content changes', () => {
    const previousMessages = buildLongHistory(2)
    const previousTurns = groupMessagesByTurn(previousMessages)
    const nextMessages = previousMessages.slice()
    nextMessages[0] = { ...nextMessages[0]!, content: 'mutated history' }
    nextMessages[nextMessages.length - 1] = {
      ...nextMessages[nextMessages.length - 1]!,
      content: 'Hello world',
    }

    expect(
      tryPatchTurnsForStreamingContentChange(previousMessages, nextMessages, previousTurns),
    ).toBeNull()
  })

  it('matches full regroup for many sequential content-only deltas on a long transcript', () => {
    let messages = buildLongHistory(40)
    let turns = groupMessagesByTurn(messages)
    const chunks = ['Hel', 'Hell', 'Hello', 'Hello,', 'Hello, world']

    for (const content of chunks) {
      const nextMessages = growLastContent(messages, content)
      const patched = tryPatchTurnsForStreamingContentChange(messages, nextMessages, turns)
      expect(patched).not.toBeNull()
      const full = groupMessagesByTurn(nextMessages)
      expect(assistantResponseText(patched!)).toBe(assistantResponseText(full))
      expect(patched!.length).toBe(full.length)
      messages = nextMessages
      turns = patched!
    }
  })

  it('keeps patch path cheaper than full regroup on long transcripts (smoke timing)', () => {
    // Not a CI wall-clock gate — only a coarse ratio guard so the fast path cannot
    // accidentally regress into "always full regroup" while still looking correct.
    const previousMessages = buildLongHistory(200)
    const previousTurns = groupMessagesByTurn(previousMessages)
    const nextMessages = growLastContent(previousMessages, `${previousMessages.at(-1)!.content}x`)

    const patchSamples = 200
    const t0 = performance.now()
    for (let i = 0; i < patchSamples; i++) {
      tryPatchTurnsForStreamingContentChange(previousMessages, nextMessages, previousTurns)
    }
    const patchMs = performance.now() - t0

    const regroupSamples = 20
    const t1 = performance.now()
    for (let i = 0; i < regroupSamples; i++) {
      groupMessagesByTurn(nextMessages)
    }
    const regroupMs = performance.now() - t1

    const patchPer = patchMs / patchSamples
    const regroupPer = regroupMs / regroupSamples
    // Expect at least 3× cheaper per call; generous floor avoids CI flake.
    expect(patchPer * 3).toBeLessThan(regroupPer)
  })
})
