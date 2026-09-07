// input: Renderer automation hooks, isolated hook state, and mocked Electron APIs
// output: Regression coverage for runtime action ownership and coalesced startup loads
// pos: Guards runtime-scoped automation projection and delayed action results

import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { loadAutomationsForWorkspace, __resetAutomationsLoadCacheForTests } from '../useAutomations'

it('keeps pending deletion and late test results owned by their original runtime', () => {
  // Isolate hook primitives so this regression cannot replace React for other tests.
  const run = spawnSync(process.execPath, ['--eval', `
    import { mock } from 'bun:test';
    import assert from 'node:assert/strict';
    const state = []; let cursor = 0;
    mock.module('react', () => ({
      useState(initial) { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }]; },
      useCallback: callback => callback, useEffect() {},
    }));
    mock.module('react-i18next', () => ({ useTranslation: () => ({ t: key => key }) }));
    mock.module('sonner', () => ({ toast: { error() {}, success() {} } }));
    const pending = new Map(); const deleted = [];
    globalThis.window = { electronAPI: {
      testAutomation: ({ workspaceId }) => new Promise(resolve => pending.set(workspaceId, resolve)),
      deleteAutomation: async (...args) => { deleted.push(args); },
    } };
    const { useAutomationActions } = await import(${JSON.stringify(join(import.meta.dir, '../useAutomations.ts'))});
    const items = [{ id: 'same-id', name: 'Task', event: 'SchedulerTick', matcherIndex: 0, actions: [] }];
    const render = workspace => { cursor = 0; return useAutomationActions(workspace, items); };
    const first = render('project');
    first.handleTestAutomation('same-id'); first.handleDeleteAutomation('same-id');
    assert.equal(render('project').automationPendingDelete, 'same-id');
    const second = render('free');
    assert.equal(second.automationPendingDelete, null);
    assert.equal(second.automationTestResults['same-id'], undefined);
    second.confirmDeleteAutomation(); assert.equal(deleted.length, 0);
    second.handleTestAutomation('same-id');
    pending.get('free')({ actions: [{ success: true }] }); await Promise.resolve();
    pending.get('project')({ actions: [{ success: false, stderr: 'Project failure' }] }); await Promise.resolve();
    assert.equal(render('free').automationTestResults['same-id'].state, 'success');
    assert.equal(render('project').automationTestResults['same-id'].stderr, 'Project failure');
    render('project').confirmDeleteAutomation();
    assert.deepEqual(deleted, [['project', 'SchedulerTick', 0]]);
  `], { encoding: 'utf8' })
  expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' })
})

describe('loadAutomationsForWorkspace', () => {
  it('coalesces concurrent loads for the same workspace', async () => {
    __resetAutomationsLoadCacheForTests()

    let resolveConfig: (value: unknown) => void
    const configPromise = new Promise<unknown>((resolve) => {
      resolveConfig = resolve
    })

    let automationCalls = 0
    let historyCalls = 0
    const api = {
      getAutomations: async () => {
        automationCalls += 1
        return configPromise
      },
      getAutomationLastExecuted: async () => {
        historyCalls += 1
        return { 'SchedulerTick-0': 123 }
      },
    }

    const first = loadAutomationsForWorkspace('workspace-1', api)
    const second = loadAutomationsForWorkspace('workspace-1', api)

    resolveConfig!({
      version: 2,
      automations: {
        SchedulerTick: [
          { actions: [{ type: 'prompt', prompt: 'daily check' }] },
        ],
      },
    })

    const [firstItems, secondItems] = await Promise.all([first, second])

    expect(automationCalls).toBe(1)
    expect(historyCalls).toBe(1)
    expect(firstItems).toEqual(secondItems)
    expect(firstItems[0].lastExecutedAt).toBe(123)
  })
})
