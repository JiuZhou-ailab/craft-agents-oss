// input: Pi subprocess protocol messages, prompt context, and host credential fixtures
// output: Prompt-envelope, error, credential, rewind, and runtime-update assertions
// pos: Host-side PiAgent protocol boundary test

import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import { AbortReason } from '../backend/types.ts'
import type { BackendConfig } from '../backend/types.ts'

function createConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/craft-agent-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/craft-agent-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
    ...overrides,
  }
}

function captureSuccessfulCredentialUpdate(agent: PiAgent, sent: unknown[]): void {
  ;(agent as any).send = (message: { id: string }) => {
    sent.push(message)
    ;(agent as any).handleLine(JSON.stringify({
      type: 'token_update_result',
      id: message.id,
      success: true,
    }))
  }
}

describe('PiAgent subprocess error handling', () => {
  it('stays busy after host abort until Pi reports native settlement', async () => {
    const agent = new PiAgent(createConfig())
    ;(agent as any).ensureSubprocess = async () => {}
    let promptSent!: () => void
    const sent = new Promise<void>(resolve => { promptSent = resolve })
    ;(agent as any).send = (message: { type: string }) => { if (message.type === 'prompt') promptSent() }
    const iterator = agent.chat('cancel me')
    const pending = iterator.next()
    await sent
    agent.forceAbort(AbortReason.UserStop)
    await pending
    expect(agent.isProcessing()).toBe(false)
    expect(agent.isIdle()).toBe(false)
    ;(agent as any).handleLine(JSON.stringify({ type: 'event', event: { type: 'agent_end' } }))
    expect(agent.isIdle()).toBe(false)
    ;(agent as any).handleLine(JSON.stringify({ type: 'event', event: { type: 'agent_settled' } }))
    expect(agent.isIdle()).toBe(true)
    agent.destroy()
  })

  it('keeps transient context separate from the durable prompt message', async () => {
    const agent = new PiAgent(createConfig())
    ;(agent as any).ensureSubprocess = async () => {}
    let resolvePrompt!: (message: Record<string, unknown>) => void
    const promptSent = new Promise<Record<string, unknown>>(resolve => {
      resolvePrompt = resolve
    })
    ;(agent as any).send = (message: Record<string, unknown>) => {
      if (message.type === 'prompt') resolvePrompt(message)
    }

    const iterator = agent.chat('hello', undefined, {
      oneTimeContext: 'NOVEL WORKSPACE BRIEF',
    })
    const pending = iterator.next()
    const prompt = await promptSent

    expect(prompt.message).toBe('hello')
    expect(prompt.systemPrompt).not.toContain('NOVEL WORKSPACE BRIEF')
    expect(prompt.turnPolicy).toContain('<workspace_capabilities>')
    expect(prompt.turnPolicy).toContain('<session_state>')
    expect(prompt.turnPolicy).toContain("**USER'S DATE AND TIME:")
    expect(prompt.turnPolicy).toContain('<language_policy_reminder>')
    expect(prompt.turnPolicy).not.toContain('<workspace_root>')
    expect(prompt.turnContext).toContain('<workspace_root>')
    expect(prompt.turnContext).toContain(
      '<request_context scope="turn">\nNOVEL WORKSPACE BRIEF\n</request_context>',
    )
    expect(prompt.turnContext).not.toContain('<language_policy_reminder>')
    expect(prompt).not.toHaveProperty('dynamicSystemPrompt')

    ;(agent as any).handleLine(JSON.stringify({
      type: 'prompt_result',
      id: prompt.id,
      status: 'completed_without_agent',
    }))
    await pending
    agent.destroy()
  })

  it('preserves the legacy rewind error code', async () => {
    const agent = new PiAgent(createConfig())
    ;(agent as any).requestEnsureSessionReady = async () => 'pi-session-test'
    ;(agent as any).ensureSubprocess = async () => {}
    ;(agent as any).send = (message: { id: string }) => {
      ;(agent as any).handleLine(JSON.stringify({
        type: 'rewind_user_message_result',
        id: message.id,
        success: false,
        errorCode: 'REWIND_UNAVAILABLE_LEGACY',
        errorMessage: 'Legacy rewind mapping is unavailable',
      }))
    }

    const rewind = agent.rewindUserMessage('legacy-message')

    await expect(rewind).rejects.toMatchObject({
      code: 'REWIND_UNAVAILABLE_LEGACY',
    })
    agent.destroy()
  })

  it('persists OAuth credentials refreshed by Pi', async () => {
    const agent = new PiAgent(createConfig({
      connectionSlug: 'openai-codex-test',
      authType: 'oauth',
    }))
    const updates: unknown[] = []
    ;(agent as any).persistOAuthCredential = async (provider: string, credential: unknown) => {
      updates.push({ provider, credential })
    }

    ;(agent as any).handleLine(JSON.stringify({
      type: 'credential_update',
      provider: 'openai-codex',
      credential: {
        type: 'oauth',
        access: 'new-access',
        refresh: 'new-refresh',
        expires: 123456,
      },
    }))
    await Promise.resolve()

    expect(updates).toEqual([{
      provider: 'openai-codex',
      credential: {
        type: 'oauth',
        access: 'new-access',
        refresh: 'new-refresh',
        expires: 123456,
      },
    }])
    agent.destroy()
  })

  it('preserves Extension notification severity', () => {
    const agent = new PiAgent(createConfig())
    const enqueued: unknown[] = []
    ;(agent as any).eventQueue.enqueue = (event: unknown) => enqueued.push(event)

    ;(agent as any).handleLine(JSON.stringify({
      type: 'extension_notification',
      message: 'No checkpoints available',
      level: 'warning',
    }))

    expect(enqueued).toEqual([{
      type: 'info',
      message: 'No checkpoints available',
      level: 'warning',
    }])
    agent.destroy()
  })

  it('completes only the matching prompt command without forging a Pi settlement event', () => {
    const agent = new PiAgent(createConfig())
    let completions = 0
    ;(agent as any).activePromptId = 'turn-2'
    ;(agent as any).eventQueue.complete = () => { completions++ }

    ;(agent as any).handleLine(JSON.stringify({
      type: 'prompt_result',
      id: 'turn-1',
      status: 'failed',
    }))
    expect(completions).toBe(0)

    ;(agent as any).handleLine(JSON.stringify({
      type: 'prompt_result',
      id: 'turn-2',
      status: 'failed',
    }))
    expect(completions).toBe(1)

    agent.destroy()
  })

  it('maps raw upstream HTML subprocess errors to typed service_error events', () => {
    const agent = new PiAgent(createConfig())

    const enqueued: any[] = []
    ;(agent as any).eventQueue.enqueue = (event: any) => {
      enqueued.push(event)
    }

    ;(agent as any).handleLine(JSON.stringify({
      type: 'error',
      message: '<html><head><title>400 Bad Request</title></head><body><center><h1>400 Bad Request</h1></center><hr><center>cloudflare</center></body></html>',
    }))

    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].type).toBe('typed_error')
    expect(enqueued[0].error.code).toBe('service_error')
    expect(enqueued[0].error.message.toLowerCase()).not.toContain('<html')

    agent.destroy()
  })

  it('leaves managed gateway presentation to the session boundary', () => {
    const agent = new PiAgent(createConfig({
      connectionSlug: 'storyflow-managed',
      authType: 'api_key',
    }))

    const enqueued: any[] = []
    ;(agent as any).eventQueue.enqueue = (event: any) => {
      enqueued.push(event)
    }

    ;(agent as any).handleLine(JSON.stringify({
      type: 'error',
      message: '401 {"error":{"code":"auth_failed","message":"ApiKey Validate fail","type":"auth_failed"}}',
    }))

    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].type).toBe('typed_error')
    expect(enqueued[0].error.code).toBe('invalid_api_key')
    expect(enqueued[0].error.actions.some((action: any) => action.action === 'reauth')).toBe(false)
    expect(enqueued[0].error.actions.some((action: any) => action.action === 'settings')).toBe(true)

    agent.destroy()
  })

  it('pushes the latest API credential into a live subprocess', async () => {
    const agent = new PiAgent(createConfig({
      connectionSlug: 'storyflow-managed',
      authType: 'api_key',
    }))
    const sent: unknown[] = []
    ;(agent as any).subprocess = {}
    ;(agent as any).getPiAuth = async () => ({
      provider: 'openai',
      credential: { type: 'api_key', key: 'rotated-token' },
    })
    captureSuccessfulCredentialUpdate(agent, sent)

    await expect(agent.reloadCredentials()).resolves.toBe(true)
    expect(sent).toEqual([{
      type: 'token_update',
      id: 'credential-update-1',
      piAuth: {
        provider: 'openai',
        credential: { type: 'api_key', key: 'rotated-token' },
      },
    }])

    ;(agent as any).subprocess = null
    agent.destroy()
  })

  it('pushes host-provided managed model access without a stored provider credential', async () => {
    const agent = new PiAgent(createConfig({
      connectionSlug: 'test-managed-explicit-access',
      authType: 'api_key',
      runtime: { piAuthProvider: 'openai' },
    }))
    const sent: unknown[] = []
    ;(agent as any).subprocess = {}
    captureSuccessfulCredentialUpdate(agent, sent)

    await expect(agent.reloadCredentials({ token: 'managed-model-token' })).resolves.toBe(true)
    expect(sent).toEqual([{
      type: 'token_update',
      id: 'credential-update-1',
      piAuth: {
        provider: 'openai',
        credential: { type: 'api_key', key: 'managed-model-token' },
      },
    }])

    ;(agent as any).subprocess = null
    agent.destroy()
  })

  it('does not enqueue chat errors for llm_query_error messages', () => {
    const agent = new PiAgent(createConfig())

    const enqueued: any[] = []
    ;(agent as any).eventQueue.enqueue = (event: any) => {
      enqueued.push(event)
    }

    ;(agent as any).handleLine(JSON.stringify({
      type: 'error',
      code: 'llm_query_error',
      message: '<html><head><title>400 Bad Request</title></head><body><center><h1>400 Bad Request</h1></center><hr><center>cloudflare</center></body></html>',
    }))

    expect(enqueued).toHaveLength(0)

    agent.destroy()
  })

  it('suppresses only identical consecutive subprocess errors', () => {
    const agent = new PiAgent(createConfig())

    const enqueued: any[] = []
    ;(agent as any).eventQueue.enqueue = (event: any) => {
      enqueued.push(event)
    }

    for (let i = 0; i < 4; i++) {
      ;(agent as any).handleLine(JSON.stringify({
        type: 'error',
        message: 'EFAULT: broken pipe',
      }))
    }

    expect(enqueued).toHaveLength(3)
    expect(enqueued.every((event) => event.type === 'error' || event.type === 'typed_error')).toBe(true)

    agent.destroy()
  })

  it('resets repeated subprocess error suppression after non-error traffic', () => {
    const agent = new PiAgent(createConfig())

    const enqueued: any[] = []
    ;(agent as any).eventQueue.enqueue = (event: any) => {
      enqueued.push(event)
    }

    for (let i = 0; i < 3; i++) {
      ;(agent as any).handleLine(JSON.stringify({
        type: 'error',
        message: 'EFAULT: broken pipe',
      }))
    }

    ;(agent as any).handleLine(JSON.stringify({
      type: 'event',
      event: { type: 'agent_message_delta', delta: 'ok' },
    }))

    ;(agent as any).handleLine(JSON.stringify({
      type: 'error',
      message: 'EFAULT: broken pipe',
    }))

    expect(enqueued.filter((event) => event.type === 'error' || event.type === 'typed_error')).toHaveLength(4)

    agent.destroy()
  })
})
