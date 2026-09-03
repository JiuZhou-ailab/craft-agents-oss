// input: Cloudflare Worker requests, signed model access JWTs, and upstream fetch stubs
// output: Regression coverage for NewAPI proxy authorization and credential isolation
// pos: Guards the edge boundary that keeps the NewAPI service key off desktop clients

import { describe, expect, it, spyOn } from 'bun:test'
import { handleRequest } from './index'

const CURRENT_MODEL_KEY_ID = 'model-access-2026-07'
const CURRENT_MODEL_SECRET = 'broker-signing-secret'
const PREVIOUS_MODEL_KEY_ID = 'model-access-2026-06'
const PREVIOUS_MODEL_SECRET = 'previous-broker-signing-secret'

async function signTestJwt(
  secret: string,
  payload: Record<string, unknown> = {},
  kid: string | null = CURRENT_MODEL_KEY_ID,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'HS256', typ: 'JWT', ...(kid ? { kid } : {}) }
  const body = {
    iss: 'storyflow-auth-broker',
    aud: 'storyflow-model-gateway',
    sub: 'neon:neon_user_123',
    scopes: ['model:chat'],
    model_tier: 'standard',
    exp: now + 60,
    iat: now,
    ...payload,
  }
  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(body)}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`
}

function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(value)))
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function makeEnv() {
  return {
    STORYFLOW_GATEWAY_JWT_CURRENT_KEY_ID: CURRENT_MODEL_KEY_ID,
    STORYFLOW_GATEWAY_JWT_CURRENT_SECRET: CURRENT_MODEL_SECRET,
    STORYFLOW_GATEWAY_JWT_PREVIOUS_KEY_ID: PREVIOUS_MODEL_KEY_ID,
    STORYFLOW_GATEWAY_JWT_PREVIOUS_SECRET: PREVIOUS_MODEL_SECRET,
    STORYFLOW_GATEWAY_JWT_AUDIENCE: 'storyflow-model-gateway',
    NEWAPI_API_KEY: 'server-only-newapi-key',
    NEWAPI_UPSTREAM_BASE_URL: 'https://jzapi.duanju.com',
    CATALOG_ORIGIN_URL: 'https://storyflow-catalog-origin.zjding.com',
    CATALOG_ORIGIN_TOKEN: 'server-only-catalog-token',
  }
}

describe('model gateway worker', () => {
  it('reports readiness only after NewAPI answers its real probe', async () => {
    const readinessRequests: Request[] = []
    const fetchStub = async (request: Request) => {
      readinessRequests.push(request)
      return Response.json({ data: [{ id: 'gpt-5.5' }] })
    }
    const ready = await handleRequest(
      new Request('https://model.storyflow.example.com/ready'),
      makeEnv(),
      fetchStub,
    )
    const legacyOnly = await handleRequest(
      new Request('https://model.storyflow.example.com/ready'),
      {
        ...makeEnv(),
        STORYFLOW_GATEWAY_JWT_CURRENT_SECRET: undefined,
        STORYFLOW_GATEWAY_JWT_SECRET: CURRENT_MODEL_SECRET,
      },
      fetchStub,
    )

    expect(ready.status).toBe(200)
    expect(await ready.json()).toEqual({ status: 'ready' })
    expect(readinessRequests.map(request => request.url)).toEqual(['https://jzapi.duanju.com/v1/models'])
    expect(readinessRequests[0]?.headers.get('authorization')).toBe('Bearer server-only-newapi-key')
    expect(legacyOnly.status).toBe(503)
    expect(await legacyOnly.json()).toEqual({
      status: 'not_ready',
      code: 'configuration_invalid',
    })
  })

  it('fails readiness when NewAPI is unavailable', async () => {
    const dependencyUnavailable = await handleRequest(
      new Request('https://model.storyflow.example.com/ready'),
      makeEnv(),
      async () => Response.json({ status: 'not_ready' }, { status: 503 }),
    )

    expect(dependencyUnavailable.status).toBe(503)
    expect(await dependencyUnavailable.json()).toEqual({
      status: 'not_ready',
      code: 'dependency_unavailable',
    })
  })

  it('exposes the authenticated managed model catalog with total context windows', async () => {
    const token = await signTestJwt(CURRENT_MODEL_SECRET)
    const health = await handleRequest(
      new Request('https://model.storyflow.example.com/health'),
      makeEnv(),
    )
    const catalog = await handleRequest(
      new Request('https://model.storyflow.example.com/v1/models', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      makeEnv(),
      async (request) => {
        expect(request.url).toBe('https://jzapi.duanju.com/v1/models')
        expect(request.headers.get('authorization')).toBe('Bearer server-only-newapi-key')
        return Response.json({
          object: 'list',
          data: [
            { id: 'gemini-3.6-flash' },
            { id: 'gemini-3.6-pro-preview' },
            { id: 'unmanaged-model' },
          ],
        })
      },
    )
    const wrongChatMethod = await handleRequest(
      new Request('https://model.storyflow.example.com/v1/responses'),
      makeEnv(),
    )
    const wrongCatalogMethod = await handleRequest(
      new Request('https://model.storyflow.example.com/v1/models', {
        method: 'POST',
      }),
      makeEnv(),
    )

    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok' })
    expect(catalog.status).toBe(200)
    const catalogBody = await catalog.json() as { object: string; data: Array<Record<string, unknown>> }
    expect(catalogBody.object).toBe('list')
    expect(catalogBody.data.map(model => model.id)).toEqual([
      'gpt-5.5',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'claude-sonnet-5',
      'claude-opus-5',
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3.1-pro-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'gemini-3.6-pro-preview',
    ])
    expect(catalogBody.data.find(model => model.id === 'gpt-5.5')).toMatchObject({
      short_name: 'GPT',
      context_window: 262_144,
      supports_thinking: true,
      thinking_level_map: { max: null },
      supports_images: true,
    })
    expect(catalogBody.data.find(model => model.id === 'claude-opus-5')).toMatchObject({
      short_name: 'Claude',
      api: 'anthropic-messages',
    })
    expect(catalogBody.data.find(model => model.id === 'gemini-3.6-flash')).toMatchObject({
      name: 'Gemini 3.6 Flash',
      short_name: 'Gemini',
      api: 'google-generative-ai',
    })
    expect(catalogBody.data.find(model => model.id === 'gemini-3.8-flash')).toMatchObject({
      name: 'Gemini 3.8 Flash',
      supports_thinking: true,
      thinking_level_map: { off: null, medium: 'medium', xhigh: null },
    })
    expect(catalogBody.data.find(model => model.id === 'gemini-3.1-pro-preview')).toMatchObject({
      name: 'Gemini 3.1 Pro Preview',
      short_name: 'Gemini',
      api: 'google-generative-ai',
    })
    expect(wrongChatMethod.status).toBe(405)
    expect(wrongChatMethod.headers.get('allow')).toBe('POST')
    expect(wrongCatalogMethod.status).toBe(405)
    expect(wrongCatalogMethod.headers.get('allow')).toBe('GET')
  })

  it('rejects missing or invalid model access tokens before calling NewAPI', async () => {
    let upstreamCalls = 0
    const fetchStub = async () => {
      upstreamCalls += 1
      return new Response('unexpected')
    }

    const missing = await handleRequest(
      new Request('https://model.storyflow.example.com/v1/responses', {
        method: 'POST',
      }),
      makeEnv(),
      fetchStub,
    )
    const cloudflareHeaderOnly = await handleRequest(
      new Request('https://model.storyflow.example.com/v1/responses', {
        method: 'POST',
        headers: { 'cf-aig-authorization': 'Bearer legacy-token' },
      }),
      makeEnv(),
      fetchStub,
    )
    const invalid = await handleRequest(
      new Request('https://model.storyflow.example.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: 'Bearer invalid-token' },
      }),
      makeEnv(),
      fetchStub,
    )

    expect(missing.status).toBe(401)
    expect(cloudflareHeaderOnly.status).toBe(401)
    expect(invalid.status).toBe(401)
    expect(await missing.json()).toEqual({
      error: 'Invalid model access token',
      code: 'model_access_token_invalid',
    })
    expect(await cloudflareHeaderOnly.json()).toEqual({
      error: 'Invalid model access token',
      code: 'model_access_token_invalid',
    })
    expect(await invalid.json()).toEqual({
      error: 'Invalid model access token',
      code: 'model_access_token_invalid',
    })
    expect(upstreamCalls).toBe(0)
  })

  it('keeps v0.13 Catalog reads working during the desktop migration', async () => {
    const token = await signTestJwt(CURRENT_MODEL_SECRET, {
      scopes: ['catalog:read'],
    })
    const response = await handleRequest(
      new Request('https://model.storyflow.example.com/v2/catalog/sources', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      makeEnv(),
      async request => {
        expect(request.url).toBe('https://storyflow-catalog-origin.zjding.com/v2/catalog/sources')
        expect(request.headers.get('x-storyflow-origin-token')).toBe('server-only-catalog-token')
        expect(request.headers.get('authorization')).toBeNull()
        return Response.json({ version: 2, sources: [{ id: 'hongguo' }] })
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ version: 2, sources: [{ id: 'hongguo' }] })
  })

  it('rejects expired, unscoped, and unknown-tier tokens', async () => {
    const now = Math.floor(Date.now() / 1000)
    const expiredToken = await signTestJwt('broker-signing-secret', { exp: now - 1 })
    const unscopedToken = await signTestJwt('broker-signing-secret', { scopes: ['profile:read'] })
    const unknownTierToken = await signTestJwt('broker-signing-secret', { model_tier: 'admin' })

    const requestWith = (token: string) => new Request(
      'https://model.storyflow.example.com/v1/responses',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: 'gpt-5.5', input: [] }),
      },
    )

    const expired = await handleRequest(requestWith(expiredToken), makeEnv())
    const unscoped = await handleRequest(requestWith(unscopedToken), makeEnv())
    const unknownTier = await handleRequest(requestWith(unknownTierToken), makeEnv())

    expect(expired.status).toBe(401)
    expect(await expired.json()).toEqual({
      error: 'Invalid model access token',
      code: 'model_access_token_invalid',
    })
    expect(unscoped.status).toBe(403)
    expect(unknownTier.status).toBe(403)
  })

  it('accepts current and previous keyed tokens but rejects missing or unknown key IDs', async () => {
    const requestWith = (token: string) => new Request(
      'https://model.storyflow.example.com/v1/responses',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: 'gpt-5.5', input: [] }),
      },
    )
    const fetchStub = async () => Response.json({ ok: true })

    const current = await handleRequest(
      requestWith(await signTestJwt(CURRENT_MODEL_SECRET)),
      makeEnv(),
      fetchStub,
    )
    const previous = await handleRequest(
      requestWith(await signTestJwt(PREVIOUS_MODEL_SECRET, {}, PREVIOUS_MODEL_KEY_ID)),
      makeEnv(),
      fetchStub,
    )
    const noKid = await handleRequest(
      requestWith(await signTestJwt(CURRENT_MODEL_SECRET, {}, null)),
      makeEnv(),
      fetchStub,
    )
    const unknown = await handleRequest(
      requestWith(await signTestJwt(CURRENT_MODEL_SECRET, {}, 'unknown-key')),
      makeEnv(),
      fetchStub,
    )

    expect(current.status).toBe(200)
    expect(previous.status).toBe(200)
    expect(noKid.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(await unknown.json()).toEqual({
      error: 'Invalid model access token',
      code: 'model_access_token_invalid',
    })
  })

  it('maps standard and pro tokens to the same server-side NewAPI credential', async () => {
    for (const tier of ['standard', 'pro'] as const) {
      const token = await signTestJwt('broker-signing-secret', { model_tier: tier })
      let upstreamRequest: Request | null = null

      const response = await handleRequest(
        new Request('https://model.storyflow.example.com/v1/responses?debug=1', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'text/event-stream',
            'Content-Type': 'application/json',
            Cookie: 'must-not-forward=1',
            'X-Untrusted-Header': 'must-not-forward',
          },
          body: JSON.stringify({ model: 'gpt-5.5', input: [], stream: true }),
        }),
        makeEnv(),
        async (request) => {
          upstreamRequest = request
          return new Response('data: {"ok":true}\n\n', {
            headers: { 'Content-Type': 'text/event-stream' },
          })
        },
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/event-stream')
      expect(await response.text()).toBe('data: {"ok":true}\n\n')
      expect(upstreamRequest?.url).toBe('https://jzapi.duanju.com/v1/responses?debug=1')
      expect(upstreamRequest?.headers.get('authorization')).toBe('Bearer server-only-newapi-key')
      expect(upstreamRequest?.headers.get('accept')).toBe('text/event-stream')
      expect(upstreamRequest?.headers.get('content-type')).toBe('application/json')
      expect(upstreamRequest?.headers.get('cookie')).toBeNull()
      expect(upstreamRequest?.headers.get('x-untrusted-header')).toBeNull()
    }
  })

  it('routes DeepSeek through native Chat Completions', async () => {
    const token = await signTestJwt(CURRENT_MODEL_SECRET)
    let upstreamUrl = ''

    const response = await handleRequest(
      new Request('https://model.storyflow.example.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [] }),
      }),
      makeEnv(),
      async (request) => {
        upstreamUrl = request.url
        return Response.json({ ok: true })
      },
    )

    expect(response.status).toBe(200)
    expect(upstreamUrl).toBe('https://jzapi.duanju.com/v1/chat/completions')
  })

  it('rejects a managed model sent through the wrong protocol', async () => {
    const token = await signTestJwt(CURRENT_MODEL_SECRET)
    let upstreamCalls = 0

    const response = await handleRequest(
      new Request('https://model.storyflow.example.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: 'deepseek-v4-flash', input: [] }),
      }),
      makeEnv(),
      async () => {
        upstreamCalls += 1
        return Response.json({ unexpected: true })
      },
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'model_not_allowed' })
    expect(upstreamCalls).toBe(0)
  })

  it('proxies native Anthropic Messages and streaming Gemini chat routes', async () => {
    const token = await signTestJwt(CURRENT_MODEL_SECRET)
    const upstreamRequests: Request[] = []
    const fetchStub = async (request: Request) => {
      upstreamRequests.push(request)
      return Response.json({ ok: true })
    }

    const anthropic = await handleRequest(
      new Request('https://model.storyflow.example.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': token,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'tools-2024-04-04',
        },
        body: JSON.stringify({ model: 'claude-sonnet-5', messages: [] }),
      }),
      makeEnv(),
      fetchStub,
    )
    const gemini = await handleRequest(
      new Request(
        'https://model.storyflow.example.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify({ contents: [] }),
        },
      ),
      makeEnv(),
      fetchStub,
    )

    expect(anthropic.status).toBe(200)
    expect(upstreamRequests[0]?.url).toBe('https://jzapi.duanju.com/v1/messages')
    expect(upstreamRequests[0]?.headers.get('x-api-key')).toBe('server-only-newapi-key')
    expect(upstreamRequests[0]?.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(upstreamRequests[0]?.headers.get('anthropic-beta')).toBe('tools-2024-04-04')
    expect(gemini.status).toBe(200)
    expect(upstreamRequests[1]?.url).toBe(
      'https://jzapi.duanju.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse',
    )
    expect(upstreamRequests[1]?.headers.get('x-goog-api-key')).toBe('server-only-newapi-key')
  })

  it('proxies only the approved native Gemini video route with isolated credentials', async () => {
    const token = await signTestJwt(CURRENT_MODEL_SECRET, {
      scopes: ['model:chat', 'model:video'],
    })
    let upstreamRequest: Request | null = null
    const response = await handleRequest(
      new Request(
        'https://model.storyflow.example.com/v1beta/models/gemini-3.1-flash-lite:generateContent',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-client': 'google-genai-sdk/1.52.0',
            'x-goog-api-key': token,
            Authorization: 'Bearer must-not-forward',
          },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }] }),
        },
      ),
      makeEnv(),
      async (request) => {
        upstreamRequest = request
        return Response.json({ candidates: [] })
      },
    )

    expect(response.status).toBe(200)
    expect(upstreamRequest?.url).toBe(
      'https://jzapi.duanju.com/v1beta/models/gemini-3.1-flash-lite:generateContent',
    )
    expect(upstreamRequest?.headers.get('x-goog-api-key')).toBe('server-only-newapi-key')
    expect(upstreamRequest?.headers.get('x-goog-api-client')).toBe('google-genai-sdk/1.52.0')
    expect(upstreamRequest?.headers.get('authorization')).toBeNull()
    expect([...upstreamRequest!.headers.values()].join(' ')).not.toContain(token)
  })

  it('rejects unscoped, unapproved, and Files API Gemini requests', async () => {
    let upstreamCalls = 0
    const chatOnlyToken = await signTestJwt(CURRENT_MODEL_SECRET)
    const videoToken = await signTestJwt(CURRENT_MODEL_SECRET, {
      scopes: ['model:chat', 'model:video'],
    })
    const request = (path: string, token: string) => new Request(
      `https://model.storyflow.example.com${path}`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': token },
        body: '{}',
      },
    )
    const fetchStub = async () => {
      upstreamCalls += 1
      return Response.json({ unexpected: true })
    }

    const unscoped = await handleRequest(
      request('/v1beta/models/gemini-3.1-flash-lite:generateContent', chatOnlyToken),
      makeEnv(),
      fetchStub,
    )
    const unapproved = await handleRequest(
      request('/v1beta/models/gemini-unapproved:generateContent', videoToken),
      makeEnv(),
      fetchStub,
    )
    const files = await handleRequest(
      request('/v1beta/files', videoToken),
      makeEnv(),
      fetchStub,
    )
    const catalog = await handleRequest(
      new Request('https://model.storyflow.example.com/v2/rankings', {
        headers: { Authorization: `Bearer ${videoToken}` },
      }),
      makeEnv(),
      fetchStub,
    )

    expect(unscoped.status).toBe(403)
    expect(unapproved.status).toBe(403)
    expect(await unapproved.json()).toMatchObject({ code: 'model_not_allowed' })
    expect(files.status).toBe(404)
    expect(catalog.status).toBe(403)
    expect(upstreamCalls).toBe(0)
  })

  it('fails closed when NewAPI configuration or the upstream is unavailable', async () => {
    const token = await signTestJwt('broker-signing-secret')
    const requestWithToken = () => new Request(
      'https://model.storyflow.example.com/v1/responses',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: 'gpt-5.5', input: [] }),
      },
    )

    const missingConfig = await handleRequest(
      requestWithToken(),
      { ...makeEnv(), NEWAPI_API_KEY: undefined },
    )
    const unavailable = await handleRequest(
      requestWithToken(),
      makeEnv(),
      async () => {
        throw new Error('network down')
      },
    )

    expect(missingConfig.status).toBe(503)
    expect(unavailable.status).toBe(502)
  })

  it('does not misclassify upstream service authentication failures as client token failures', async () => {
    const token = await signTestJwt(CURRENT_MODEL_SECRET)
    const response = await handleRequest(
      new Request('https://model.storyflow.example.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: 'gpt-5.5', input: [] }),
      }),
      makeEnv(),
      async () => Response.json(
        { error: 'server credential rejected' },
        { status: 401 },
      ),
    )

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: 'Model provider authentication failed',
      code: 'upstream_auth_failed',
    })
  })

  it('normalizes an empty upstream 400 into a structured gateway failure', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})

    try {
      const token = await signTestJwt(CURRENT_MODEL_SECRET)
      const response = await handleRequest(
        new Request('https://model.storyflow.example.com/v1/responses', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'x-storyflow-model-call-id': 'not-a-uuid',
            'x-storyflow-attempt': '999',
          },
          body: JSON.stringify({ model: 'gpt-5.5', input: [] }),
        }),
        makeEnv(),
        async () => new Response(null, {
          status: 400,
          headers: { 'cf-ray': 'empty-400-ray' },
        }),
      )

      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({
        error: {
          message: 'Model provider rejected the request without an error body',
          type: 'upstream_error',
          code: 'upstream_empty_response',
        },
      })
      expect(errorSpy.mock.calls[0]?.[0]).toMatchObject({
        stage: 'upstream',
        upstream_status: 400,
        upstream_ray: 'empty-400-ray',
        error: 'empty_response_body',
      })
      expect(errorSpy.mock.calls[0]?.[0]).not.toHaveProperty('model_call_id')
      expect(errorSpy.mock.calls[0]?.[0]).not.toHaveProperty('attempt')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('normalizes an upstream HTML error without reading successful response streams', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})

    try {
      const token = await signTestJwt(CURRENT_MODEL_SECRET)
      const response = await handleRequest(
        new Request('https://model.storyflow.example.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [] }),
        }),
        makeEnv(),
        async () => new Response(
          '<html><head><title>400 Bad Request</title></head><body><center>alb</center></body></html>',
          {
            status: 400,
            headers: {
              'content-type': 'text/html',
              'cf-ray': 'upstream-alb-ray',
            },
          },
        ),
      )

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: {
          message: 'Upstream gateway returned an unexpected HTML response',
          type: 'upstream_error',
          code: 'upstream_html_response',
        },
      })
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy.mock.calls[0]?.[0]).toMatchObject({
        stage: 'upstream',
        upstream_status: 400,
        upstream_ray: 'upstream-alb-ray',
        error: 'html_response_body',
      })
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('logs upstream failures with correlation fields but without request content or credentials', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})

    try {
      const token = await signTestJwt(CURRENT_MODEL_SECRET, {
        sub: 'feishu:ou_debug',
        user_name: '飞书用户',
      })
      const response = await handleRequest(
        new Request('https://model.storyflow.example.com/v1/responses', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'cf-ray': 'incoming-request-ray',
            'x-storyflow-model-call-id': '4f4666b0-d5b8-4d5b-9c87-9c58f829f9d4',
            'x-storyflow-attempt': '1',
          },
          body: JSON.stringify({
            model: 'gpt-5.5',
            input: [{ role: 'user', content: 'private prompt content' }],
          }),
        }),
        makeEnv(),
        async () => new Response('error code: 520', {
          status: 520,
          headers: { 'cf-ray': 'upstream-request-ray' },
        }),
      )

      expect(response.status).toBe(520)
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy.mock.calls[0]?.[0]).toMatchObject({
        stage: 'upstream',
        upstream_status: 520,
        upstream_ray: 'upstream-request-ray',
        user: 'feishu:ou_debug',
        user_name: '飞书用户',
        model_call_id: '4f4666b0-d5b8-4d5b-9c87-9c58f829f9d4',
        attempt: 1,
        model: 'gpt-5.5',
        api: 'openai-responses',
        duration_ms: expect.any(Number),
      })
      expect(Object.keys(errorSpy.mock.calls[0]?.[0] as object).sort()).toEqual([
        'api',
        'attempt',
        'duration_ms',
        'model',
        'model_call_id',
        'stage',
        'upstream_ray',
        'upstream_status',
        'user',
        'user_name',
      ])

      const logged = JSON.stringify(errorSpy.mock.calls[0]?.[0])
      expect(logged).not.toContain('private prompt content')
      expect(logged).not.toContain(CURRENT_MODEL_SECRET)
      expect(logged).not.toContain('server-only-newapi-key')
    } finally {
      errorSpy.mockRestore()
    }
  })
})
