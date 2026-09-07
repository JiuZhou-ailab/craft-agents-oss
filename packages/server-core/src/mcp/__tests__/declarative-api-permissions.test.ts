// input: Declarative and flexible API tools plus Host-owned Source registrations
// output: Permission and remembered-approval decisions isolated by Source and HTTP operation
// pos: Regression guard for the API Source permission boundary

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shouldAllowToolInMode, permissionsConfigCache } from '@craft-agent/shared/agent'
import { McpClientPool } from '../mcp-pool'
import { createApiServer } from '@craft-agent/shared/sources'
import { shouldPromptInAskMode, type PermissionManagerLike } from '@craft-agent/shared/agent/core/pre-tool-use'

const temporaryRoots: string[] = []

afterEach(() => {
  permissionsConfigCache.clear()
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('declarative API permissions', () => {
  it('binds flexible API requests and approvals to the registered Source', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'flexible-api-permissions-'))
    temporaryRoots.push(workspaceRootPath)
    const sourceDir = join(workspaceRootPath, '.craft-agent', 'sources', 'a')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'permissions.json'), JSON.stringify({
      allowedApiEndpoints: [{ method: 'POST', path: '^/search$' }],
    }))
    const context = {
      workspaceRootPath,
      allowProjectGrants: true,
      activeSources: ['a', 'b'].map(slug => ({
        slug, ownerRootPath: workspaceRootPath, grantAuthority: 'project' as const,
      })),
    }
    const pool = new McpClientPool()
    const remembered = new Set<string>()
    const permissionManager = {
      isCommandWhitelisted: (command: string) => remembered.has(command),
    } as PermissionManagerLike
    try {
      for (const name of ['a', 'b']) {
        await pool.connectInProcess(name, {
          ...createApiServer({ name, baseUrl: 'https://example.invalid', auth: { type: 'none' } }, ''),
          capabilityRef: `project:${name}:definition`,
        })
      }
      const input = { method: 'POST', path: '/allowed/../search', sourceSlug: 'a' }
      const operationA = pool.getProxyToolPermission('mcp__a__api_a', input)
      const operationB = pool.getProxyToolPermission('mcp__b__api_b', input)
      expect(operationA).toEqual({ sourceSlug: 'a', method: 'POST', path: '/search' })
      expect(operationB).toEqual({ sourceSlug: 'b', method: 'POST', path: '/search' })
      expect(shouldAllowToolInMode('mcp__a__api_a', input, 'safe', {
        permissionsContext: context, apiOperation: operationA,
      }).allowed).toBe(true)
      expect(shouldAllowToolInMode('mcp__b__api_b', input, 'safe', {
        permissionsContext: context, apiOperation: operationB,
      }).allowed).toBe(false)
      expect(shouldPromptInAskMode('mcp__a__api_a', input, permissionManager, context, undefined, operationA)).toBeNull()
      const noGrants = { workspaceRootPath, activeSources: [] }
      const approval = shouldPromptInAskMode('mcp__a__api_a', input, permissionManager, noGrants, undefined, operationA)!
      remembered.add(approval.command!)
      expect(shouldPromptInAskMode('mcp__a__api_a', input, permissionManager, noGrants, undefined, operationA)).toBeNull()
      expect(shouldPromptInAskMode('mcp__b__api_b', input, permissionManager, noGrants, undefined, operationB)?.promptType).toBe('api_mutation')
      const otherPath = pool.getProxyToolPermission('mcp__a__api_a', { method: 'POST', path: '/delete' })
      expect(shouldPromptInAskMode('mcp__a__api_a', {}, permissionManager, noGrants, undefined, otherPath)?.promptType).toBe('api_mutation')
      const invalid = pool.getProxyToolPermission('mcp__a__api_a', { method: 'GET', path: 123 })
      expect(shouldAllowToolInMode('mcp__a__api_a', {}, 'safe', { apiOperation: invalid }).allowed).toBe(false)
      await pool.disconnect('a')
      expect(pool.getProxyToolPermission('mcp__a__api_a', input)).toBeUndefined()
    } finally {
      await pool.disconnectAll()
    }
  })

  it('keeps Source endpoint grants and remembered approvals on the owning Source', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'api-permission-owner-'))
    temporaryRoots.push(workspaceRootPath)
    const sourceDir = join(workspaceRootPath, '.craft-agent', 'sources', 'a')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'permissions.json'), JSON.stringify({
      allowedApiEndpoints: [{ method: 'POST', path: '^/graphql$' }],
    }))
    const context = {
      workspaceRootPath,
      allowProjectGrants: false,
      activeSources: ['a', 'b'].map(slug => ({
        slug, ownerRootPath: workspaceRootPath, grantAuthority: 'host' as const,
      })),
    }
    const pool = new McpClientPool()
    const remembered = new Set<string>()
    const permissionManager = {
      isCommandWhitelisted: (command: string) => remembered.has(command),
    } as PermissionManagerLike
    try {
      for (const name of ['a', 'b']) {
        await pool.connectInProcess(name, {
          ...createApiServer({ name, baseUrl: 'https://example.invalid', auth: { type: 'none' },
            operations: [{ name: 'mutate', description: 'Mutation', method: 'POST', path: '/graphql' }],
          }, ''),
          capabilityRef: `host:${name}:definition`,
        })
      }
      const operationA = pool.getProxyToolPermission('mcp__a__mutate', {})!
      const operationB = pool.getProxyToolPermission('mcp__b__mutate', {})!
      expect(shouldAllowToolInMode('mcp__a__mutate', {}, 'safe', {
        permissionsContext: context, apiOperation: operationA,
      }).allowed).toBe(true)
      expect(shouldAllowToolInMode('mcp__b__mutate', {}, 'safe', {
        permissionsContext: context, apiOperation: operationB,
      }).allowed).toBe(false)
      expect(shouldPromptInAskMode('mcp__a__mutate', {}, permissionManager, context, undefined, operationA)).toBeNull()
      expect(shouldPromptInAskMode('mcp__b__mutate', {}, permissionManager, context, undefined, operationB)?.promptType).toBe('api_mutation')

      const noGrants = { workspaceRootPath, activeSources: [] }
      const approvalA = shouldPromptInAskMode('mcp__a__mutate', {}, permissionManager, noGrants, undefined, operationA)!
      remembered.add(approvalA.command!)
      expect(shouldPromptInAskMode('mcp__a__mutate', {}, permissionManager, noGrants, undefined, operationA)).toBeNull()
      expect(shouldPromptInAskMode('mcp__b__mutate', {}, permissionManager, noGrants, undefined, operationB)?.promptType).toBe('api_mutation')
    } finally {
      await pool.disconnectAll()
    }
  })

  it('uses HTTP semantics before tool-name heuristics', () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'api-permission-method-'))
    temporaryRoots.push(workspaceRootPath)
    expect(shouldPromptInAskMode(
      'mcp__source__delete_job',
      {},
      { isCommandWhitelisted: (_command: string): boolean => false } as PermissionManagerLike,
      { workspaceRootPath, activeSources: [] },
      undefined,
      { sourceSlug: 'source', method: 'GET', path: '/jobs/42' },
    )).toBeNull()
    expect(shouldAllowToolInMode(
      'mcp__source__Read',
      {},
      'safe',
      { apiOperation: { sourceSlug: 'source', method: 'DELETE', path: '/jobs/42' } },
    ).allowed).toBe(false)

    expect(shouldAllowToolInMode(
      'mcp__source__delete_job',
      {},
      'safe',
      { apiOperation: { sourceSlug: 'source', method: 'GET', path: '/jobs/42' } },
    ).allowed).toBe(true)
  })

  it('checks the canonical request path before applying endpoint rules', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'api-permission-path-'))
    temporaryRoots.push(workspaceRootPath)
    writeFileSync(join(workspaceRootPath, 'permissions.json'), JSON.stringify({
      allowedApiEndpoints: [{ method: 'POST', path: '^/allowed/.*$' }],
    }))

    const server = createApiServer({
      name: 'source',
      baseUrl: 'https://api.example.com',
      auth: { type: 'none' },
      operations: [{
        name: 'mutate',
        description: 'Mutate one record.',
        method: 'POST',
        path: '/allowed/{id}/delete',
        parameters: [{ name: 'id', type: 'string', required: true }],
      }],
    }, '')
    const pool = new McpClientPool()

    try {
      await pool.connectInProcess('source', {
        ...server,
        capabilityRef: 'workspace:source:test-definition',
      })
      const apiOperation = pool.getProxyToolPermission('mcp__source__mutate', { id: '..' })
      expect(apiOperation).toEqual({ sourceSlug: 'source', method: 'POST', path: '/delete' })
      expect(pool.getProxyToolPermission('mcp__source__mutate', {})).toEqual({
        sourceSlug: 'source',
        method: 'POST',
        path: '/.storyflow/invalid-api-operation',
      })
      expect(shouldAllowToolInMode(
        'mcp__source__mutate',
        { id: '..' },
        'safe',
        {
          apiOperation,
          permissionsContext: { workspaceRootPath, activeSourceSlugs: [] },
        },
      ).allowed).toBe(false)
    } finally {
      await pool.disconnectAll()
    }
  })

  it('applies path defaults before checking endpoint rules', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'api-permission-default-'))
    temporaryRoots.push(workspaceRootPath)
    writeFileSync(join(workspaceRootPath, 'permissions.json'), JSON.stringify({
      allowedApiEndpoints: [{ method: 'POST', path: '^/allowed/.*$' }],
    }))

    const server = createApiServer({
      name: 'source',
      baseUrl: 'https://api.example.com',
      auth: { type: 'none' },
      operations: [{
        name: 'mutate',
        description: 'Mutate one record.',
        method: 'POST',
        path: '/allowed/{id}/delete',
        parameters: [{ name: 'id', type: 'string', default: '..' }],
      }],
    }, '')
    const pool = new McpClientPool()

    try {
      await pool.connectInProcess('source', {
        ...server,
        capabilityRef: 'workspace:source:test-definition',
      })
      const apiOperation = pool.getProxyToolPermission('mcp__source__mutate', {})
      expect(apiOperation).toEqual({ sourceSlug: 'source', method: 'POST', path: '/delete' })
      expect(shouldAllowToolInMode(
        'mcp__source__mutate',
        {},
        'safe',
        {
          apiOperation,
          permissionsContext: { workspaceRootPath, activeSourceSlugs: [] },
        },
      ).allowed).toBe(false)
    } finally {
      await pool.disconnectAll()
    }
  })
})
