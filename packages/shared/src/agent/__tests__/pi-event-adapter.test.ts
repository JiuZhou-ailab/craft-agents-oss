// input: Mock Pi lifecycle events, tool payloads, and session state
// output: Regression coverage for ordered assistant content, tool failure, and retry ownership projection
// pos: Contract tests for the Pi-to-Craft UI event boundary

/**
 * Tests for PiEventAdapter
 *
 * Tests the Pi SDK AgentEvent / AgentSessionEvent → Craft AgentEvent conversion.
 * Each test provides mock Pi SDK event objects and verifies the AgentEvents produced.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { PiEventAdapter } from '../backend/pi/event-adapter.ts';

// Helper: collect all events from a generator
function collect(gen: Generator<any>): any[] {
  return [...gen];
}

describe('PiEventAdapter', () => {
  let adapter: PiEventAdapter;

  beforeEach(() => {
    adapter = new PiEventAdapter();
    adapter.startTurn();
  });

  // ============================================================
  // Agent lifecycle
  // ============================================================

  describe('agent lifecycle', () => {
    it('should emit nothing for agent_start', () => {
      const events = collect(adapter.adaptEvent({ type: 'agent_start' } as any));
      expect(events).toHaveLength(0);
    });

    it('should wait for agent_settled before emitting complete', () => {
      const events = collect(adapter.adaptEvent({ type: 'agent_end' } as any));
      expect(events).toHaveLength(0);
      const settledEvents = collect(adapter.adaptEvent({ type: 'agent_settled' } as any));
      expect(settledEvents).toHaveLength(1);
      expect(settledEvents[0]).toMatchObject({ type: 'complete' });
    });

    it('should aggregate usage across every model call in the user turn', () => {
      const firstCallEvents = collect(adapter.adaptEvent({
        type: 'message_end',
        contextWindow: 131_072,
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: 'Checking',
          usage: {
            input: 100,
            output: 40,
            cacheRead: 20,
            cacheWrite: 10,
            totalTokens: 170,
            cost: { total: 0.01 },
          },
        },
      } as any));
      expect(firstCallEvents).toContainEqual({
        type: 'usage_update',
        usage: {
          contextTokens: 130,
          contextWindow: 131_072,
        },
      });
      collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: 'Done',
          usage: {
            input: 200,
            output: 50,
            cacheRead: 30,
            cacheWrite: 5,
            totalTokens: 285,
            cost: { total: 0.02 },
          },
        },
      } as any));

      expect(adapter.getTurnUsageSnapshot()).toEqual({
        inputTokens: 365,
        outputTokens: 90,
        modelCalls: 2,
        cacheReadTokens: 50,
        cacheCreationTokens: 15,
        costUsd: 0.03,
        contextTokens: 235,
        contextWindow: 131_072,
      });

      const events = collect(adapter.adaptEvent({ type: 'agent_settled' } as any));

      expect(events).toEqual([{
        type: 'complete',
        usage: {
          inputTokens: 365,
          outputTokens: 90,
          modelCalls: 2,
          cacheReadTokens: 50,
          cacheCreationTokens: 15,
          costUsd: 0.03,
          contextTokens: 235,
          contextWindow: 131_072,
        },
      }]);
    });

    it('should include subagent usage without replacing parent context usage', () => {
      collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: 'Delegating',
          usage: {
            input: 100,
            output: 40,
            cacheRead: 20,
            cacheWrite: 10,
            totalTokens: 170,
            cost: { total: 0.01 },
          },
        },
      } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'subagent-1',
        toolName: 'subagent',
        args: { tasks: [{ task: 'inspect', capability: 'read_only' }] },
      } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'subagent-1',
        result: {
          content: [{ type: 'text', text: 'done' }],
          details: {
            kind: 'storyflow-subagent',
            results: [],
            usage: {
              input: 120,
              output: 30,
              cacheRead: 10,
              cacheWrite: 5,
              cost: 0.02,
              modelCalls: 3,
            },
          },
        },
        isError: false,
      } as any));
      collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: 'Done',
          usage: {
            input: 200,
            output: 50,
            cacheRead: 30,
            cacheWrite: 5,
            totalTokens: 285,
            cost: { total: 0.03 },
          },
        },
      } as any));

      expect(collect(adapter.adaptEvent({ type: 'agent_settled' } as any))).toEqual([{
        type: 'complete',
        usage: {
          inputTokens: 500,
          outputTokens: 120,
          modelCalls: 5,
          cacheReadTokens: 60,
          cacheCreationTokens: 20,
          costUsd: 0.06,
          contextTokens: 235,
          contextWindow: undefined,
        },
      }]);
    });

    it('should reset turn usage before the next user turn', () => {
      collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: 'Done',
          usage: {
            input: 100,
            output: 25,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 125,
            cost: { total: 0.01 },
          },
        },
      } as any));
      collect(adapter.adaptEvent({ type: 'agent_settled' } as any));

      adapter.startTurn();

      expect(collect(adapter.adaptEvent({ type: 'agent_settled' } as any))).toEqual([
        { type: 'complete' },
      ]);
    });
  });

  // ============================================================
  // Turn lifecycle
  // ============================================================

  describe('turn lifecycle', () => {
    it('should set currentTurnId on turn_start', () => {
      // turn_start is handled internally — emits no events
      const events = collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      expect(events).toHaveLength(0);
    });

    it('should emit nothing on turn_end', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({ type: 'turn_end' } as any));
      expect(events).toHaveLength(0);
    });

    it('should generate sequential turn IDs across turns', () => {
      // First turn (turnIndex=1 from beforeEach startTurn)
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events1 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Hello' },
      } as any));
      expect(events1[0].turnId).toMatch(/^pi-turn-1/);

      // End first turn, start second
      collect(adapter.adaptEvent({ type: 'turn_end' } as any));
      adapter.startTurn();
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      const events2 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'World' },
      } as any));
      expect(events2[0].turnId).toMatch(/^pi-turn-2/);
    });
  });

  // ============================================================
  // Message events — text streaming
  // ============================================================

  describe('message events', () => {
    it('should emit nothing for message_start', () => {
      const events = collect(adapter.adaptEvent({ type: 'message_start' } as any));
      expect(events).toHaveLength(0);
    });

    it('should emit text_delta for message_update with text_delta', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'text_delta',
        text: 'Hello',
      });
      expect(events[0].turnId).toMatch(/^pi-turn-1__m0$/);
    });

    it('should skip message_update without text_delta type', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'usage_delta', delta: null },
      } as any));
      expect(events).toHaveLength(0);
    });

    it('should skip message_update with empty delta', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: '' },
      } as any));
      expect(events).toHaveLength(0);
    });

    it('should reuse same sub-turnId for consecutive deltas', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      const events1 = collect(adapter.adaptEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      } as any));
      const events2 = collect(adapter.adaptEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: ' World' },
      } as any));

      expect(events1[0].turnId).toBe(events2[0].turnId);
    });

    it('should preserve thinking and answer as ordered streaming blocks', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      const events = [
        ...collect(adapter.adaptEvent({
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 },
        } as any)),
        ...collect(adapter.adaptEvent({
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Checking the evidence' },
        } as any)),
        ...collect(adapter.adaptEvent({
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'Checking the evidence' },
        } as any)),
        ...collect(adapter.adaptEvent({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Final answer' },
        } as any)),
        ...collect(adapter.adaptEvent({
          type: 'message_end',
          message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'Checking the evidence' }, { type: 'text', text: 'Final answer' }] },
        } as any)),
      ];

      expect(events).toEqual([
        { type: 'text_delta', text: 'Checking the evidence', turnId: 'pi-turn-1__m0' },
        { type: 'text_complete', text: 'Checking the evidence', isIntermediate: true, turnId: 'pi-turn-1__m0' },
        { type: 'text_delta', text: 'Final answer', turnId: 'pi-turn-1__m1' },
        { type: 'text_complete', text: 'Final answer', isIntermediate: false, turnId: 'pi-turn-1__m1', sdkTurnAnchor: undefined },
      ]);
    });

    it('should emit text_complete for final assistant message_end', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Hello there' },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'text_complete',
        text: 'Hello there',
        isIntermediate: false,
      });
    });

    it('should forward sdkTurnAnchor from message_end into text_complete', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        sdkTurnAnchor: 'entry_abc123',
        message: { role: 'assistant', stopReason: 'stop', content: 'Anchored output' },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'text_complete',
        text: 'Anchored output',
        sdkTurnAnchor: 'entry_abc123',
      });
    });

    it('should skip non-assistant message_end', () => {
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'user', content: 'Hello' },
      } as any));
      expect(events).toHaveLength(0);
    });

    it('should skip toolResult message_end', () => {
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'toolResult', content: 'result' },
      } as any));
      expect(events).toHaveLength(0);
    });

    it('should extract text from content array', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [
            { type: 'text', text: 'Part 1' },
            { type: 'text', text: ' Part 2' },
          ],
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('Part 1 Part 2');
    });

    it('should skip message_end with no text content', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'tool_use', id: 'tool1' }],
        },
      } as any));
      expect(events).toHaveLength(0);
    });
  });

  // ============================================================
  // Intermediate vs final text classification
  // ============================================================

  describe('intermediate text classification', () => {
    it('should set isIntermediate: true when stopReason is toolUse', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: 'Let me check that...',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'text_complete',
        text: 'Let me check that...',
        isIntermediate: true,
      });
    });

    it('should set isIntermediate: false when stopReason is stop', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: 'Here is the final answer.',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'text_complete',
        text: 'Here is the final answer.',
        isIntermediate: false,
      });
    });

    it('should allow multiple intermediate messages in a turn', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // First intermediate message
      const events1 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: 'Let me read the file...',
        },
      } as any));

      // Simulate tool execution between intermediates
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'tool1',
        toolName: 'read',
        args: { path: '/foo.ts' },
      } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'tool1',
        result: 'file content',
        isError: false,
      } as any));

      // Second intermediate message
      const events2 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: 'Now let me check the tests...',
        },
      } as any));

      expect(events1).toHaveLength(1);
      expect(events1[0].isIntermediate).toBe(true);

      expect(events2).toHaveLength(1);
      expect(events2[0].isIntermediate).toBe(true);
    });

    it('should block duplicate final messages in same turn', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // First final message
      const events1 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: 'Final answer',
        },
      } as any));

      // Duplicate final message (should be blocked)
      const events2 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: 'Duplicate final',
        },
      } as any));

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(0);
    });

    it('should allow final message after tool completion resets state', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // Intermediate message
      collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'toolUse', content: 'Checking...' },
      } as any));

      // Tool execution
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'tool1',
        toolName: 'read',
        args: {},
      } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'tool1',
        result: 'output',
        isError: false,
      } as any));

      // Final message after tool — should work because tool_execution_end resets hasEmittedFinalText
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Here is the answer.' },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].isIntermediate).toBe(false);
    });
  });

  // ============================================================
  // Sub-turnId isolation
  // ============================================================

  describe('sub-turnId isolation', () => {
    it('should generate unique sub-turnIds for text blocks', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // First text block
      const events1 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'toolUse', content: 'First' },
      } as any));

      // Tool between text blocks
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 't1',
        toolName: 'read',
        args: {},
      } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 't1',
        result: 'ok',
        isError: false,
      } as any));

      // Second text block
      const events2 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Second' },
      } as any));

      expect(events1[0].turnId).not.toBe(events2[0].turnId);
      expect(events1[0].turnId).toMatch(/^pi-turn-1__m/);
      expect(events2[0].turnId).toMatch(/^pi-turn-1__m/);
    });

    it('should use streaming sub-turnId when deltas preceded text_complete', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // Stream deltas first
      const deltaEvents = collect(adapter.adaptEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      } as any));

      // Then text_complete
      const completeEvents = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Hello world' },
      } as any));

      // text_complete should reuse the delta's sub-turnId
      expect(completeEvents[0].turnId).toBe(deltaEvents[0].turnId);
    });

    it('should reset sub-turnId counter across turns', () => {
      // First turn
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events1 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Turn 1' },
      } as any));

      // End turn, start new one
      collect(adapter.adaptEvent({ type: 'turn_end' } as any));
      adapter.startTurn();
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      const events2 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Turn 2' },
      } as any));

      // Sub-turn counter resets: both should end with m0
      expect(events1[0].turnId).toBe('pi-turn-1__m0');
      expect(events2[0].turnId).toBe('pi-turn-2__m0');
    });
  });

  // ============================================================
  // Error surfacing
  // ============================================================

  describe('error surfacing', () => {
    it('should emit plain error for unclassified error messages', () => {
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'Something went wrong internally',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'error',
        message: 'Something went wrong internally',
      });
    });

    it('should emit typed_error for raw upstream HTML pages', () => {
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: '<html><head><title>400 Bad Request</title></head><body><center><h1>400 Bad Request</h1></center><hr><center>cloudflare</center></body></html>',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('typed_error');
      expect((events[0] as any).error.code).toBe('service_error');
      expect((events[0] as any).error.message.toLowerCase()).not.toContain('<html');
    });

    it('should emit typed_error for auth-expiry error messages', () => {
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'Provided authentication token is expired. Please try signing in again.',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('typed_error');
      expect(events[0].error.code).toBe('expired_oauth_token');
    });

    it('should emit typed_error for 401 unauthorized errors', () => {
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: '401 Unauthorized',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('typed_error');
      expect(events[0].error.code).toBe('invalid_api_key');
    });

    it('should emit typed_error for billing/402 errors', () => {
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: '402 Payment required',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('typed_error');
      expect(events[0].error.code).toBe('billing_error');
    });

    it('should emit typed_error for rate limit errors', () => {
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: '429 Too many requests - rate limit exceeded',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('typed_error');
      expect(events[0].error.code).toBe('rate_limited');
    });

    it('should emit typed_error for provider content filtering', () => {
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'Provider finish_reason: content_filtered',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('typed_error');
      expect(events[0].error.code).toBe('content_filtered');
      expect(events[0].error.message).not.toContain('finish_reason');
    });

    it('should not emit error without errorMessage even if stopReason is error', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          // No errorMessage — fall through to normal text extraction
          content: 'Some partial content',
        },
      } as any));

      // Should emit as text_complete, not error
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('text_complete');
    });
  });

  // ============================================================
  // Tool events
  // ============================================================

  describe('tool events', () => {
    it('should emit tool_start for tool_execution_start', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_123',
        toolName: 'bash',
        args: { command: 'ls -la', description: 'List files' },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_start',
        toolName: 'Bash',
        toolUseId: 'call_123',
        input: { command: 'ls -la', description: 'List files' },
        displayName: 'Run Command',
      });
    });

    it('should strip deprecated model-visible UI metadata', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_no_store',
        toolName: 'bash',
        args: {
          command: 'npm test',
          _intent: 'Run unit tests',
          _displayName: 'Run Tests',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_start',
        toolName: 'Bash',
        toolUseId: 'call_no_store',
        input: { command: 'npm test' },
        displayName: 'Run Command',
      });
      expect(events[0].intent).toBeUndefined();
      expect(events[0].input).not.toHaveProperty('_intent');
      expect(events[0].input).not.toHaveProperty('_displayName');
    });

    it('should preserve edits[] for Pi edit tools while deriving legacy diff fields', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_edit',
        toolName: 'edit',
        args: {
          path: '/src/app.ts',
          edits: [
            { oldText: 'const a = 1', newText: 'const a = 2' },
            { oldText: 'const b = 1', newText: 'const b = 2' },
          ],
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_start',
        toolName: 'Edit',
        toolUseId: 'call_edit',
        input: {
          file_path: '/src/app.ts',
          old_string: 'const a = 1',
          new_string: 'const a = 2',
          edits: [
            { oldText: 'const a = 1', newText: 'const a = 2' },
            { oldText: 'const b = 1', newText: 'const b = 2' },
          ],
        },
      });
    });

    it('should resolve Pi lowercase tool names to PascalCase', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      const toolTests = [
        { piName: 'read', expected: 'Read' },
        { piName: 'write', expected: 'Write' },
        { piName: 'edit', expected: 'Edit' },
        { piName: 'grep', expected: 'Grep' },
        { piName: 'find', expected: 'Find' },
        { piName: 'ls', expected: 'Ls' },
        { piName: 'task', expected: 'task' },
      ];

      for (const { piName, expected } of toolTests) {
        const events = collect(adapter.adaptEvent({
          type: 'tool_execution_start',
          toolCallId: `call_${piName}`,
          toolName: piName,
          args: {},
        } as any));

        expect(events[0].toolName).toBe(expected);
      }
    });

    it('should emit tool_result for tool_execution_end', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // Start tool first
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'read',
        args: { path: '/foo.ts' },
      } as any));

      // End tool
      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        result: { content: [{ type: 'text', text: 'file contents' }] },
        isError: false,
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_result',
        toolUseId: 'call_1',
        toolName: 'Read',
        result: 'file contents',
        isError: false,
      });
    });

    it('should handle string result in tool_execution_end', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: {},
      } as any));

      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        result: 'command output',
        isError: false,
      } as any));

      expect(events[0].result).toBe('command output');
    });

    it('should handle error tool results', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: {},
      } as any));

      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        result: null,
        isError: true,
      } as any));

      expect(events[0]).toMatchObject({
        type: 'tool_result',
        isError: true,
        result: 'Tool execution failed',
      });
    });

    it('should preserve errors reported in tool result details', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'web_search',
        args: { query: 'Storyflow' },
      } as any));

      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        result: {
          content: [{ type: 'text', text: 'Search failed' }],
          details: { isError: true },
        },
        isError: false,
      } as any));

      expect(events[0]).toMatchObject({
        type: 'tool_result',
        toolName: 'WebSearch',
        result: 'Search failed',
        isError: true,
      });
    });

    it('should accumulate partial output from tool_execution_update', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: {},
      } as any));

      // Partial updates
      collect(adapter.adaptEvent({
        type: 'tool_execution_update',
        toolCallId: 'call_1',
        partialResult: { content: [{ type: 'text', text: 'line 1\n' }] },
      } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_update',
        toolCallId: 'call_1',
        partialResult: { content: [{ type: 'text', text: 'line 2\n' }] },
      } as any));

      // End — should use accumulated output
      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        result: 'ignored because accumulated',
        isError: false,
      } as any));

      expect(events[0].result).toBe('line 1\nline 2\n');
    });

    it('should preserve the final result of an atomic subagent call', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'subagent-call',
        toolName: 'subagent',
        args: { task: 'inspect', capability: 'read_only' },
      } as any));

      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'subagent-call',
        result: {
          content: [{ type: 'text', text: 'final finding' }],
          details: {
            kind: 'storyflow-subagent',
            result: {
              task: 'inspect',
              capability: 'read_only',
              status: 'completed',
              output: 'final finding',
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
              },
            },
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
            },
          },
        },
        isError: false,
      } as any));

      expect(events[0].result).toBe('final finding');
    });

    it('should use description as intent for bash tools', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: { command: 'npm test', description: 'Run unit tests' },
      } as any));

      expect(events[0].intent).toBe('Run unit tests');
    });

    it('should classify bash cat commands as Read tool starts', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: { command: 'cat /path/to/file.ts' },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].toolName).toBe('Read');
      expect(events[0].displayName).toBe('Read File');
    });

    it('should reset hasEmittedFinalText after tool_execution_end', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // Emit final text
      collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'toolUse', content: 'Checking...' },
      } as any));

      // Tool execution
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 't1',
        toolName: 'read',
        args: {},
      } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 't1',
        result: 'ok',
        isError: false,
      } as any));

      // Another text after tool — should succeed
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Done!' },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('Done!');
    });
  });

  // ============================================================
  // Session-level events
  // ============================================================

  describe('session events', () => {
    it('should emit status for compaction_start', () => {
      const events = collect(adapter.adaptEvent({
        type: 'compaction_start',
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'status',
        message: 'Compacting context...',
        statusType: 'compacting',
      });
    });

    it('should report the compacted context estimate without changing turn input', () => {
      adapter.setContextWindow(131_072);
      collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: '',
          usage: {
            input: 100_000,
            output: 100,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 100_100,
            cost: { total: 0.1 },
          },
        },
      } as any));

      const events = collect(adapter.adaptEvent({
        type: 'compaction_end',
        result: { estimatedTokensAfter: 20_000 },
        aborted: false,
      } as any));

      expect(events).toEqual([
        {
          type: 'info',
          message: 'Compacted context to fit within limits',
          statusType: 'compaction_complete',
        },
        {
          type: 'usage_update',
          usage: {
            contextTokens: 20_000,
            contextWindow: 131_072,
          },
        },
      ]);
      expect(collect(adapter.adaptEvent({ type: 'agent_settled' } as any))).toEqual([{
        type: 'complete',
        usage: {
          inputTokens: 100_000,
          outputTokens: 100,
          modelCalls: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0.1,
          contextTokens: 20_000,
          contextWindow: 131_072,
        },
      }]);
    });

    it('should emit error for failed compaction_end', () => {
      const events = collect(adapter.adaptEvent({
        type: 'compaction_end',
        result: null,
        aborted: false,
        errorMessage: 'Out of memory',
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'error',
        message: 'Context compaction failed: Out of memory',
      });
    });

    it('should emit nothing for aborted compaction', () => {
      const events = collect(adapter.adaptEvent({
        type: 'compaction_end',
        result: null,
        aborted: true,
      } as any));

      expect(events).toHaveLength(0);
    });

    it('should emit status for auto_retry_start', () => {
      const events = collect(adapter.adaptEvent({
        type: 'auto_retry_start',
        attempt: 2,
        maxAttempts: 3,
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'status',
        message: 'Retrying (attempt 2/3)...',
        statusType: 'retrying',
      });
    });

    it('should leave final failure projection to message_end when auto_retry_end fails', () => {
      const finalEvents = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: '401 Unauthorized',
        },
      } as any));
      const retryEndEvents = collect(adapter.adaptEvent({
        type: 'auto_retry_end',
        success: false,
        finalError: 'Max retries exceeded',
      } as any));

      expect(finalEvents).toHaveLength(1);
      expect(finalEvents[0]).toMatchObject({
        type: 'typed_error',
        error: { code: 'invalid_api_key' },
      });
      expect(retryEndEvents).toEqual([]);
    });

    it('should emit nothing for successful auto_retry_end', () => {
      const events = collect(adapter.adaptEvent({
        type: 'auto_retry_end',
        success: true,
      } as any));

      expect(events).toHaveLength(0);
    });

    it('should emit nothing for queue_update', () => {
      const events = collect(adapter.adaptEvent({
        type: 'queue_update',
        steering: ['Focus on tests'],
        followUp: ['Then summarize the diff'],
      } as any));

      expect(events).toHaveLength(0);
    });

    it('should emit nothing for entry_appended', () => {
      const events = collect(adapter.adaptEvent({ type: 'entry_appended' }));

      expect(events).toHaveLength(0);
    });
  });

  // ============================================================
  // Full multi-turn flow
  // ============================================================

  describe('full multi-turn flow', () => {
    it('should handle intermediate → tool → final message flow', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // 1. Intermediate commentary
      const intermediateEvents = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: 'Let me check the file...',
        },
      } as any));

      // 2. Tool execution
      const toolStartEvents = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'read',
        args: { path: '/src/index.ts' },
      } as any));

      const toolEndEvents = collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        result: 'file contents here',
        isError: false,
      } as any));

      // 3. Final response
      const finalEvents = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: 'The file contains your code.',
        },
      } as any));

      // Verify complete flow
      expect(intermediateEvents[0]).toMatchObject({
        type: 'text_complete',
        isIntermediate: true,
        text: 'Let me check the file...',
      });
      expect(toolStartEvents[0]).toMatchObject({
        type: 'tool_start',
        toolName: 'Read',
      });
      expect(toolEndEvents[0]).toMatchObject({
        type: 'tool_result',
        toolName: 'Read',
      });
      expect(finalEvents[0]).toMatchObject({
        type: 'text_complete',
        isIntermediate: false,
        text: 'The file contains your code.',
      });

      // All events should have pi-turn-1 prefix
      expect(intermediateEvents[0].turnId).toMatch(/^pi-turn-1/);
      expect(toolStartEvents[0].turnId).toMatch(/^pi-turn-1/);
      expect(finalEvents[0].turnId).toMatch(/^pi-turn-1/);
    });
  });

  // ============================================================
  // Pi-owned overflow recovery
  // ============================================================
  //
  // Pi owns compact-and-retry and emits agent_settled after the full lifecycle.
  // The adapter only hides the transient overflow error and projects one final
  // complete event.

  describe('overflow recovery', () => {
    const overflowMessage = {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'Your input exceeds the context window of this model. Please adjust your input and try again. (context_length_exceeded)',
    };

    it('surfaces a recovered turn and completes once at agent_settled', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const errEvents = collect(adapter.adaptEvent({
        type: 'message_end',
        message: overflowMessage,
      } as any));
      expect(errEvents).toHaveLength(0);
      const heldAgentEnd = collect(adapter.adaptEvent({ type: 'agent_end' } as any));
      expect(heldAgentEnd).toHaveLength(0);
      const startEvents = collect(adapter.adaptEvent({ type: 'compaction_start' } as any));
      expect(startEvents).toMatchObject([{ type: 'status', message: 'Compacting context...', statusType: 'compacting' }]);
      const endEvents = collect(adapter.adaptEvent({
        type: 'compaction_end',
        result: { /* compaction result */ },
        aborted: false,
      } as any));
      expect(endEvents).toMatchObject([{
        type: 'info',
        message: 'Compacted context to fit within limits',
        statusType: 'compaction_complete',
      }]);
      const recoveredText = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Recovered answer' },
      } as any));
      expect(recoveredText).toMatchObject([{ type: 'text_complete', text: 'Recovered answer' }]);
      expect(collect(adapter.adaptEvent({ type: 'agent_end' } as any))).toEqual([]);
      const settled = collect(adapter.adaptEvent({ type: 'agent_settled' } as any));
      expect(settled).toMatchObject([{ type: 'complete' }]);

      const allYields = [...errEvents, ...heldAgentEnd, ...startEvents, ...endEvents, ...recoveredText, ...settled];
      const errorYields = allYields.filter(e => e.type === 'error' || e.type === 'typed_error');
      expect(errorYields).toHaveLength(0);
    });

    it('reports compaction failure and still completes only at agent_settled', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      collect(adapter.adaptEvent({ type: 'message_end', message: overflowMessage } as any));
      collect(adapter.adaptEvent({ type: 'agent_end' } as any));
      collect(adapter.adaptEvent({ type: 'compaction_start' } as any));
      const failureEvents = collect(adapter.adaptEvent({
        type: 'compaction_end',
        result: null,
        aborted: false,
        errorMessage: 'Out of memory during summary',
      } as any));

      expect(failureEvents).toEqual([
        { type: 'error', message: 'Context compaction failed: Out of memory during summary' },
      ]);
      expect(collect(adapter.adaptEvent({ type: 'agent_settled' } as any))).toMatchObject([
        { type: 'complete' },
      ]);
    });

    it('surfaces the original overflow if Pi settles without recovery events', () => {
      collect(adapter.adaptEvent({ type: 'message_end', message: overflowMessage } as any));
      collect(adapter.adaptEvent({ type: 'agent_end' } as any));
      expect(collect(adapter.adaptEvent({ type: 'agent_settled' } as any))).toEqual([
        { type: 'error', message: overflowMessage.errorMessage },
        { type: 'complete' },
      ]);
    });

    it('non-overflow regression: rate-limit error preserves existing behavior', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'Rate limit exceeded; please try again in 30s',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].type).toMatch(/^(error|typed_error)$/);
      expect(collect(adapter.adaptEvent({ type: 'agent_end' } as any))).toEqual([]);
      expect(collect(adapter.adaptEvent({ type: 'agent_settled' } as any))).toMatchObject([
        { type: 'complete' },
      ]);
    });

    it('SDK race signature: friendly message instead of raw stack', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      collect(adapter.adaptEvent({ type: 'message_end', message: overflowMessage } as any));
      collect(adapter.adaptEvent({ type: 'agent_end' } as any));
      collect(adapter.adaptEvent({ type: 'compaction_start' } as any));

      const events = collect(adapter.adaptEvent({
        type: 'compaction_end',
        result: null,
        aborted: false,
        errorMessage: "Auto-compaction failed: undefined is not an object (evaluating 'this._autoCompactionAbortController.signal')",
      } as any));

      expect(events).toEqual([
        { type: 'error', message: 'Auto-compaction hit a transient error. Try /compact manually.' },
      ]);
      // The raw `_autoCompactionAbortController.signal` text is not in any yield.
      const allMessages = events.map((e: any) => e.message ?? '').join(' ');
      expect(allMessages).not.toMatch(/_autoCompactionAbortController/);
      expect(collect(adapter.adaptEvent({ type: 'agent_settled' } as any))).toMatchObject([
        { type: 'complete' },
      ]);
    });
  });
});
