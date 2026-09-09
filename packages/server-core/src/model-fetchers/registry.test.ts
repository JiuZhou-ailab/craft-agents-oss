// input: Registry entries and a controlled backend model response
// output: Refresh policy, delegation, host context, and error propagation checks
// pos: Offline contract test for the stateless provider fetchers
import { expect, it } from 'bun:test'

it('preserves provider refresh policies and delegates model discovery', () => {
  // Isolate module mocks so other model-refresh tests retain their real imports.
  const result = Bun.spawnSync([process.execPath, '-e', `
    import assert from 'node:assert/strict'
    import { mock } from 'bun:test'
    const calls = [], logs = []
    const response = { models: [{ id: 'test-model' }], serverDefault: 'test-model' }
    const hostRuntime = { appRootPath: '/fixture', resourcesPath: '/fixture/resources', isPackaged: false }
    let failure
    mock.module('@craft-agent/shared/agent/backend', () => ({
      fetchBackendModels: async args => { calls.push(args); if (failure) throw failure; return response },
    }))
    mock.module(${JSON.stringify(new URL('./runtime.ts', import.meta.url).href)}, () => ({
      getHostRuntime: () => hostRuntime, handlerLog: { info: message => logs.push(message) },
    }))
    const { MODEL_FETCHERS } = await import(${JSON.stringify(new URL('./registry.ts', import.meta.url).href)})
    assert.equal(MODEL_FETCHERS.anthropic.refreshIntervalMs, 3_600_000)
    assert.equal(MODEL_FETCHERS.pi.refreshIntervalMs, 0)
    for (const providerType of ['anthropic', 'pi']) {
      const connection = { providerType, piAuthProvider: 'github-copilot' }
      const credentials = { apiKey: 'offline-test' }
      assert.equal(await MODEL_FETCHERS[providerType].fetchModels(connection, credentials), response)
      assert.deepEqual(calls.at(-1), { connection, credentials, hostRuntime })
    }
    assert.deepEqual(logs, ['Fetched 1 Anthropic models: test-model'])
    failure = new Error('backend unavailable')
    await assert.rejects(MODEL_FETCHERS.pi.fetchModels({}, {}), error => error === failure)
  `], { cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe' })
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
})
