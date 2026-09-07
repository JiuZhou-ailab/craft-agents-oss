// input: Pi SDK lifecycle events and streamed tool output
// output: Renderer-visible product events with stable tool names and failure status
// pos: One-way projection from Pi runtime facts into Storyflow session state

/**
 * Pi SDK Event Adapter
 *
 * Maps Pi Agent Core events (AgentEvent / AgentSessionEvent) to the
 * product event vocabulary without controlling Pi lifecycle.
 */

import type { AgentEvent as ProductAgentEvent, TurnUsage } from '@craft-agent/core/types';
import type {
  AgentEvent as PiAgentEvent,
} from '@earendil-works/pi-agent-core';
import type {
  AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import { isContextOverflow } from '@earendil-works/pi-ai';
import { parseReadCommand, type ReadCommandInfo } from '../read-patterns.ts';
import { PI_TOOL_NAME_MAP } from './constants.ts';
import {
  isPiSubagentDetails,
  parsePiSubagentUsage,
} from './subagent-contract.ts';
import { parseError } from '../../errors.ts';
import { createLogger } from '../../../utils/debug.ts';

/**
 * Pi SDK auto-compaction race signature — the AbortController crash described
 * in `_runAutoCompaction` (`@earendil-works/pi-coding-agent` agent-session.ts).
 * When two `_runAutoCompaction` calls overlap, one's `finally` clears the
 * shared `_autoCompactionAbortController` field while the other is still
 * suspended on an await; the next `.signal` read crashes. Matched against
 * `compaction_end.errorMessage` to surface a friendly message instead of the
 * raw stack until the upstream fix lands. See plans/fix-pi-gpt-compaction.md.
 */
const SDK_AUTOCOMPACT_RACE_SIGNATURE = /_autoCompactionAbortController\.signal/;

/**
 * Combined event type the adapter can handle.
 * AgentSessionEvent is a superset of PiAgentEvent. Pi also emits persistence-only
 * entry_appended events that have no renderer projection.
 */
type PiEvent = PiAgentEvent | AgentSessionEvent | { type: 'entry_appended' };

/**
 * Maps Pi SDK facts to renderer-visible Product Host events.
 *
 * Event mapping:
 * - message_update (thinking_delta/end) → intermediate text_delta/text_complete
 * - message_update (text_delta) → text_delta
 * - message_end → text_complete
 * - tool_execution_start → tool_start
 * - tool_execution_end → tool_result
 * - agent_settled → complete
 * - compaction_start → status
 * - compaction_end → info/error + current context estimate
 * - auto_retry_start → status
 * - auto_retry_end → ignored (message_end owns final failure projection)
 * - queue_update / entry_appended → ignored (no current UI consumer)
 */
export class PiEventAdapter {
  private readonly log = createLogger('pi-event');
  private turnIndex = 0;
  private currentTurnId: string | null = null;
  private commandOutput = new Map<string, string>();
  private readCommands = new Map<string, ReadCommandInfo>();
  private blockReasons = new Map<string, string>();

  // Track tool names from execution_start for proper tool_result correlation
  private toolNames: Map<string, string> = new Map();

  // Track whether a final (non-intermediate) text_complete has been emitted this turn
  private hasEmittedFinalText: boolean = false;

  // Isolate each ordered assistant content block for renderer correlation.
  private subTurnCounter: number = 0;
  private contentBlockTurnId: string | null = null;

  // Model context window for usage_update events
  private contextWindow: number | undefined;

  // Mini model ID for call_llm display default (#596).
  // Used when the caller didn't specify an explicit model — we fill args.model
  // on the tool_start event so the UI shows the effective default instead of
  // leaving the badge blank.
  private miniModel: string | undefined;

  // Aggregate every model call in the outer user turn; tool loops may contain many.
  private turnUsage: {
    inputTokens: number;
    outputTokens: number;
    modelCalls: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
    contextTokens: number;
  } | undefined;

  // Raw overflow errors stay hidden while Pi attempts its native compact-and-retry.
  // If Pi settles without recovery or an explicit compaction failure, surface it once.
  private pendingOverflowError: string | null = null;

  startTurn(turnId?: string): void {
    this.turnIndex++;
    this.commandOutput.clear();
    this.readCommands.clear();
    this.blockReasons.clear();
    this.currentTurnId = turnId || null;
    this.onTurnStart();
  }

  setBlockReason(id: string, reason: string): void {
    this.log.warn('Block reason recorded', { id, reason });
    this.blockReasons.set(id, reason);
  }

  accumulateOutput(id: string, delta: string): void {
    const current = this.commandOutput.get(id) || '';
    this.commandOutput.set(id, current + delta);
  }

  private consumeBlockReason(...keys: string[]): string | undefined {
    for (const key of keys) {
      const reason = this.blockReasons.get(key);
      if (reason !== undefined) {
        this.blockReasons.delete(key);
        return reason;
      }
    }
    return undefined;
  }

  private classifyReadCommand(id: string, command: string): ReadCommandInfo | null {
    const readInfo = parseReadCommand(command);
    if (readInfo) this.readCommands.set(id, readInfo);
    return readInfo;
  }

  private consumeReadCommand(id: string): ReadCommandInfo | undefined {
    const info = this.readCommands.get(id);
    if (info) this.readCommands.delete(id);
    return info;
  }

  private consumeOutput(id: string): string | undefined {
    const output = this.commandOutput.get(id);
    if (output !== undefined) this.commandOutput.delete(id);
    return output;
  }

  private createToolStart(
    id: string,
    toolName: string,
    input: Record<string, unknown>,
    intent?: string,
    displayName?: string,
    parentToolUseId?: string,
  ): ProductAgentEvent {
    return {
      type: 'tool_start',
      toolName,
      toolUseId: id,
      input,
      intent,
      displayName,
      turnId: this.currentTurnId || undefined,
      parentToolUseId,
    };
  }

  private createToolResult(
    id: string,
    toolName: string,
    result: string,
    isError: boolean,
    parentToolUseId?: string,
  ): ProductAgentEvent {
    return {
      type: 'tool_result',
      toolUseId: id,
      toolName,
      result,
      isError,
      turnId: this.currentTurnId || undefined,
      parentToolUseId,
    };
  }

  private createReadToolStart(
    id: string,
    readInfo: ReadCommandInfo,
    intent?: string,
    displayName?: string,
    parentToolUseId?: string,
  ): ProductAgentEvent {
    return this.createToolStart(
      id,
      'Read',
      {
        file_path: readInfo.filePath,
        offset: readInfo.startLine,
        limit: readInfo.endLine
          ? readInfo.endLine - (readInfo.startLine || 1) + 1
          : undefined,
        _command: readInfo.originalCommand,
      },
      intent,
      displayName ?? 'Read File',
      parentToolUseId,
    );
  }

  /**
   * Set the model's context window size for usage reporting.
   */
  setContextWindow(cw: number): void {
    this.contextWindow = cw;
  }

  /**
   * Set the mini model ID for call_llm badge default.
   * When the agent's call_llm invocation omits `args.model`, we fill it with
   * this so the UI badge shows the effective default instead of nothing.
   * Explicit `args.model` values from the agent are always preserved.
   */
  setMiniModel(model: string | undefined): void {
    this.miniModel = model;
  }

  /**
   * Generate a unique sub-turnId for a text block within the current turn.
   */
  private nextSubTurnId(prefix: string): string {
    const base = this.currentTurnId || 'unknown';
    return `${base}__${prefix}${this.subTurnCounter++}`;
  }

  private completeEvent(): ProductAgentEvent {
    const usage = this.getTurnUsageSnapshot();
    return usage
      ? { type: 'complete', usage }
      : { type: 'complete' };
  }

  getTurnUsageSnapshot(): TurnUsage | undefined {
    return this.turnUsage
      ? { ...this.turnUsage, contextWindow: this.contextWindow }
      : undefined;
  }

  private addSubagentUsage(details: unknown): void {
    const usage = parsePiSubagentUsage(details);
    if (!usage) return;
    this.turnUsage ??= {
      inputTokens: 0,
      outputTokens: 0,
      modelCalls: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      contextTokens: 0,
    };
    this.turnUsage.inputTokens += usage.input + usage.cacheRead + usage.cacheWrite;
    this.turnUsage.outputTokens += usage.output;
    this.turnUsage.cacheReadTokens += usage.cacheRead;
    this.turnUsage.cacheCreationTokens += usage.cacheWrite;
    this.turnUsage.costUsd += usage.cost;
    this.turnUsage.modelCalls += usage.modelCalls ?? 0;
  }

  private onTurnStart(): void {
    this.toolNames.clear();
    this.hasEmittedFinalText = false;
    this.subTurnCounter = 0;
    this.contentBlockTurnId = null;
    this.turnUsage = undefined;
    this.pendingOverflowError = null;
    this.log.debug('Turn started', { turnIndex: this.turnIndex });
  }

  /**
   * Adapt a Pi SDK event to zero or more product events.
   */
  *adaptEvent(event: PiEvent): Generator<ProductAgentEvent> {
    switch (event.type) {
      // ============================================================
      // Agent lifecycle events
      // ============================================================

      case 'agent_start':
        // Internal — agent run has started
        break;

      case 'agent_end':
        // A Pi prompt may contain retries, compaction and queued continuations.
        // `agent_end` only closes one internal run; `agent_settled` closes all of it.
        break;

      case 'agent_settled':
        if (this.pendingOverflowError) {
          yield { type: 'error', message: this.pendingOverflowError };
          this.pendingOverflowError = null;
        }
        yield this.completeEvent();
        break;

      // ============================================================
      // Turn events
      // ============================================================

      case 'turn_start':
        // Pi SDK turn_start has no ID, so generate one for event correlation
        this.currentTurnId = `pi-turn-${this.turnIndex}`;
        break;

      case 'turn_end':
        // Don't emit complete here. Pi owns the full run lifecycle and emits
        // agent_settled after retries, compaction and queued continuations drain.
        this.currentTurnId = null;
        this.hasEmittedFinalText = false;
        this.subTurnCounter = 0;
        this.contentBlockTurnId = null;
        break;

      // ============================================================
      // Message events (text streaming)
      // ============================================================

      case 'message_start':
        // Pi SDK emits message_start for user messages too — skip non-assistant
        break;

      case 'message_update': {
        // Pi SDK emits message_update only for assistant messages (streaming deltas)
        const amEvent: AssistantMessageEvent = event.assistantMessageEvent;

        if (amEvent.type === 'thinking_start') {
          this.contentBlockTurnId ??= this.nextSubTurnId('m');
          break;
        }

        if (amEvent.type === 'thinking_delta' && amEvent.delta) {
          this.contentBlockTurnId ??= this.nextSubTurnId('m');
          yield {
            type: 'text_delta',
            text: amEvent.delta,
            turnId: this.contentBlockTurnId,
          };
          break;
        }

        if (amEvent.type === 'thinking_end') {
          const turnId = this.contentBlockTurnId || this.nextSubTurnId('m');
          this.contentBlockTurnId = null;
          if (amEvent.content) {
            yield {
              type: 'text_complete',
              text: amEvent.content,
              isIntermediate: true,
              turnId,
            };
          }
          break;
        }

        if (amEvent.type === 'text_delta' && amEvent.delta) {
          this.contentBlockTurnId ??= this.nextSubTurnId('m');
          yield {
            type: 'text_delta',
            text: amEvent.delta,
            turnId: this.contentBlockTurnId,
          };
        }
        break;
      }

      case 'message_end': {
        // Pi SDK emits message_end for ALL messages (user, assistant, toolResult).
        // Only process assistant messages — skip user prompts and tool results.
        const msg = event.message as { role?: string; stopReason?: string; errorMessage?: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { total: number } } } | undefined;
        const eventMetadata = event as { sdkTurnAnchor?: string; contextWindow?: number };
        const sdkTurnAnchor = eventMetadata.sdkTurnAnchor;
        if (msg?.role !== 'assistant') break;

        if (
          typeof eventMetadata.contextWindow === 'number' &&
          Number.isFinite(eventMetadata.contextWindow) &&
          eventMetadata.contextWindow > 0
        ) {
          this.contextWindow = eventMetadata.contextWindow;
        }

        if (msg.usage && typeof msg.usage.input === 'number') {
          const cacheReadTokens = msg.usage.cacheRead || 0;
          const cacheCreationTokens = msg.usage.cacheWrite || 0;
          const contextTokens = msg.usage.input + cacheReadTokens + cacheCreationTokens;
          this.turnUsage ??= {
            inputTokens: 0,
            outputTokens: 0,
            modelCalls: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0,
            contextTokens,
          };
          this.turnUsage.inputTokens += contextTokens;
          this.turnUsage.outputTokens += msg.usage.output || 0;
          this.turnUsage.modelCalls += 1;
          this.turnUsage.cacheReadTokens += cacheReadTokens;
          this.turnUsage.cacheCreationTokens += cacheCreationTokens;
          this.turnUsage.costUsd += msg.usage.cost.total || 0;
          this.turnUsage.contextTokens = contextTokens;

          yield {
            type: 'usage_update',
            usage: {
              contextTokens,
              contextWindow: this.contextWindow,
            },
          };
        }

        // Surface API errors — Pi SDK sets stopReason: 'error' and errorMessage on failures
        if (msg.stopReason === 'error' && msg.errorMessage) {
          // Context overflow: hand recovery to the SDK's _runAutoCompaction
          // and keep the UI quiet until we know the outcome (recovered turn
          // arrives, or compaction fails). Suppress the raw provider error.
          if (isContextOverflow(event.message as AssistantMessage, this.contextWindow)) {
            this.pendingOverflowError = msg.errorMessage;
            break;
          }

          // Classify the error for Product Host presentation. Pi retains retry
          // ownership; typed errors do not authorize the Host to replay the turn.
          const parsed = parseError(new Error(msg.errorMessage));
          const isClassified = parsed.code !== 'unknown_error';
          if (isClassified) {
            yield { type: 'typed_error', error: parsed };
          } else {
            yield { type: 'error', message: msg.errorMessage };
          }
          break;
        }

        // Extract text content from the final assistant message
        const textContent = this.extractTextFromMessage(event.message);
        this.pendingOverflowError = null;
        // Pi SDK stopReason: 'toolUse' means the model will call tools next (intermediate commentary),
        // 'stop'/'end_turn' means final response. Same logic as Claude's stop_reason === 'tool_use'.
        const isIntermediate = msg.stopReason === 'toolUse';
        if (textContent && (isIntermediate || !this.hasEmittedFinalText)) {
          if (!isIntermediate) this.hasEmittedFinalText = true;

          const mTurnId = this.contentBlockTurnId || this.nextSubTurnId('m');
          this.contentBlockTurnId = null;

          yield {
            type: 'text_complete',
            text: textContent,
            isIntermediate,
            turnId: mTurnId,
            sdkTurnAnchor,
          };
        }

        break;
      }

      // ============================================================
      // Tool events
      // ============================================================

      case 'tool_execution_start': {
        const toolCallId = event.toolCallId;
        const toolName = this.resolveToolName(event.toolName);
        this.toolNames.set(toolCallId, toolName);

        // Normalize Pi field names to Claude Code format for UI compatibility
        // (diff stats, diff overlay, document routing all expect Claude Code format)
        const modelArgs = { ...(event.args ?? {}) } as Record<string, unknown>;
        // Historical sessions can contain these deprecated model-visible UI fields.
        delete modelArgs._intent;
        delete modelArgs._displayName;
        const args = this.normalizeToolInput(toolName, modelArgs);

        // For call_llm, fill in the default display model when the caller didn't
        // specify one — Pi's call_llm defaults to miniModel. We only fill the gap;
        // we never overwrite an explicit agent-provided model (that was the #596 bug).
        if (toolName.includes('call_llm') && this.miniModel && !args.model) {
          args.model = this.miniModel;
        }

        const intent = typeof args.description === 'string' ? args.description : undefined;
        const displayName = this.getToolDisplayName(toolName);

        // Classify bash commands that are actually file reads
        if (toolName === 'Bash' && typeof args.command === 'string') {
          const readInfo = this.classifyReadCommand(toolCallId, args.command);
          if (readInfo) {
            yield this.createReadToolStart(
              toolCallId,
              readInfo,
              intent,
              'Read File',
            );
            break;
          }
        }

        yield this.createToolStart(
          toolCallId,
          toolName,
          args,
          intent,
          displayName,
        );
        break;
      }

      case 'tool_execution_update': {
        // Accumulate partial output for streaming tool results
        const partialResult = event.partialResult;
        if (partialResult && typeof partialResult === 'object') {
          const content = (partialResult as { content?: Array<{ type: string; text?: string }> }).content;
          if (Array.isArray(content)) {
            for (const part of content) {
              if (part.type === 'text' && part.text) {
                this.accumulateOutput(event.toolCallId, part.text);
              }
            }
          }
        }
        break;
      }

      case 'tool_execution_end': {
        const toolCallId = event.toolCallId;
        const resolvedToolName = this.toolNames.get(toolCallId) || 'tool';
        this.toolNames.delete(toolCallId);

        // Check for block reason
        const blockReason = this.consumeBlockReason(toolCallId, resolvedToolName);

        // Use accumulated output from partial results if available
        const accumulatedOutput = this.consumeOutput(toolCallId);

        const resultDetails = event.result && typeof event.result === 'object'
          ? (event.result as {
              details?: {
                isError?: boolean;
                kind?: unknown;
                usage?: unknown;
              };
            }).details
          : undefined;
        this.addSubagentUsage(resultDetails);
        const isError = event.isError === true || resultDetails?.isError === true;
        const isSubagentResult = isPiSubagentDetails(resultDetails);
        let result: string;

        if (accumulatedOutput && !isSubagentResult) {
          result = accumulatedOutput;
        } else if (blockReason) {
          result = blockReason;
        } else {
          result = this.extractToolResult(event.result, isError);
        }

        // After tool completion, the assistant may generate new text
        this.hasEmittedFinalText = false;
        this.contentBlockTurnId = null;

        // Check if this was classified as a file read
        const readInfo = this.consumeReadCommand(toolCallId);
        if (readInfo) {
          yield this.createToolResult(toolCallId, 'Read', result, isError);
          break;
        }

        yield this.createToolResult(toolCallId, resolvedToolName, result, isError);
        break;
      }

      // ============================================================
      // Session-level events (AgentSessionEvent extensions)
      // ============================================================

      case 'compaction_start':
        yield { type: 'status', message: 'Compacting context...', statusType: 'compacting' };
        break;

      case 'compaction_end': {
        const compactionEvent = event as Extract<AgentSessionEvent, { type: 'compaction_end' }>;
        if (compactionEvent.result && !compactionEvent.aborted) {
          yield {
            type: 'info',
            message: 'Compacted context to fit within limits',
            statusType: 'compaction_complete',
          };
          const estimatedTokensAfter = compactionEvent.result.estimatedTokensAfter;
          if (
            typeof estimatedTokensAfter === 'number' &&
            Number.isFinite(estimatedTokensAfter) &&
            estimatedTokensAfter >= 0
          ) {
            if (this.turnUsage) {
              this.turnUsage.contextTokens = estimatedTokensAfter;
            }
            yield {
              type: 'usage_update',
              usage: {
                contextTokens: estimatedTokensAfter,
                contextWindow: this.contextWindow,
              },
            };
          }
        } else if (compactionEvent.errorMessage) {
          // Defensive handler for the Pi SDK auto-compaction race (cause A
          // in plans/fix-pi-gpt-compaction.md). The raw stack
          // `undefined is not an object (evaluating 'this._autoCompactionAbortController.signal')`
          // is unhelpful to the user; convert it to a friendly retry hint and
          // log for diagnostics. Remove once the upstream fix ships.
          if (SDK_AUTOCOMPACT_RACE_SIGNATURE.test(compactionEvent.errorMessage)) {
            this.log.warn('Pi SDK auto-compaction race; recommend manual /compact', {
              errorMessage: compactionEvent.errorMessage,
            });
            yield {
              type: 'error',
              message: 'Auto-compaction hit a transient error. Try /compact manually.',
            };
          } else {
            yield {
              type: 'error',
              message: `Context compaction failed: ${compactionEvent.errorMessage}`,
            };
          }
          this.pendingOverflowError = null;
        }
        break;
      }

      case 'auto_retry_start': {
        const retryEvent = event as Extract<AgentSessionEvent, { type: 'auto_retry_start' }>;
        yield {
          type: 'status',
          message: `Retrying (attempt ${retryEvent.attempt}/${retryEvent.maxAttempts})...`,
          statusType: 'retrying',
        };
        break;
      }

      case 'auto_retry_end':
        // Pi already emits the exhausted attempt as message_end. Projecting
        // finalError here would create a second visible failure for one turn.
        break;

      case 'queue_update':
        // Queue contents are currently reflected by existing session/message state.
        // Ignore the event explicitly so newer Pi SDK sessions don't log noisy
        // "Unknown Pi event" warnings until we add a dedicated UI consumer.
        break;

      case 'entry_appended':
        break;

      default:
        this.log.warn(`Unknown Pi event type: ${(event as { type: string }).type}`);
        break;
    }
  }

  // ============================================================
  // Helpers
  // ============================================================

  /**
   * Normalize Pi SDK tool input field names to Claude Code format.
   * Pi uses camelCase (oldText, newText, path) while Claude Code uses
   * snake_case (old_string, new_string, file_path). The UI pipeline expects
   * Claude Code format for diff computation, overlay rendering, and
   * document type detection.
   */
  private normalizeToolInput(
    toolName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (toolName === 'Edit') {
      const normalized = { ...args };
      if ('path' in normalized && !('file_path' in normalized)) {
        normalized.file_path = normalized.path;
        delete normalized.path;
      }

      // Pi SDK >= 0.63.2 uses edits[] array instead of top-level oldText/newText.
      // Preserve the full edits[] payload so the renderer can expand and display
      // every replacement block. Also derive the first edit into flat old/new
      // fields as a compatibility bridge for UI paths that still expect them.
      const edits = normalized.edits as Array<{ oldText?: string; newText?: string }> | undefined;
      if (Array.isArray(edits) && edits.length > 0 && edits[0]) {
        const first = edits[0];
        if (first.oldText != null && !('old_string' in normalized)) {
          normalized.old_string = first.oldText;
        }
        if (first.newText != null && !('new_string' in normalized)) {
          normalized.new_string = first.newText;
        }
      }

      // Legacy path: top-level oldText/newText (Pi SDK < 0.63.2 or resumed sessions)
      if ('oldText' in normalized && !('old_string' in normalized)) {
        normalized.old_string = normalized.oldText;
        delete normalized.oldText;
      }
      if ('newText' in normalized && !('new_string' in normalized)) {
        normalized.new_string = normalized.newText;
        delete normalized.newText;
      }
      return normalized;
    }

    if (toolName === 'Write') {
      const normalized = { ...args };
      if ('path' in normalized && !('file_path' in normalized)) {
        normalized.file_path = normalized.path;
        delete normalized.path;
      }
      return normalized;
    }

    if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
      const normalized = { ...args };
      if ('path' in normalized && !('file_path' in normalized)) {
        normalized.file_path = normalized.path;
        delete normalized.path;
      }
      return normalized;
    }

    return args;
  }

  /**
   * Resolve Pi tool name to PascalCase for UI consistency.
   * Pi tools use lowercase names (read, write, edit, bash, grep, find, ls).
   */
  private resolveToolName(rawName: string): string {
    return PI_TOOL_NAME_MAP[rawName] || rawName;
  }

  /**
   * Extract text content from a Pi AgentMessage.
   * Pi messages use the pi-ai Message format with content arrays.
   */
  private extractTextFromMessage(message: unknown): string | null {
    if (!message || typeof message !== 'object') return null;

    const msg = message as {
      role?: string;
      content?: string | Array<{ type: string; text?: string }>;
    };

    if (typeof msg.content === 'string') {
      return msg.content || null;
    }

    if (Array.isArray(msg.content)) {
      const textParts = msg.content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!);
      return textParts.length > 0 ? textParts.join('') : null;
    }

    return null;
  }

  /**
   * Extract a string result from Pi tool execution result.
   */
  private extractToolResult(result: unknown, isError: boolean): string {
    if (!result) {
      return isError ? 'Tool execution failed' : 'Success';
    }

    if (typeof result === 'string') return result;

    // Pi tool results follow the AgentToolResult shape: { content: [...], details: ... }
    const typed = result as {
      content?: Array<{ type: string; text?: string }>;
      details?: unknown;
    };

    if (Array.isArray(typed.content)) {
      const texts = typed.content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!);
      if (texts.length > 0) return texts.join('\n');
    }

    // Fall back to JSON
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }

  /**
   * Get a human-readable display name for a tool.
   */
  private getToolDisplayName(toolName: string): string | undefined {
    switch (toolName) {
      case 'Bash':
        return 'Run Command';
      case 'Read':
        return 'Read File';
      case 'Write':
        return 'Write File';
      case 'Edit':
        return 'Edit File';
      case 'Glob':
      case 'Find':
        return 'Search Files';
      case 'Grep':
        return 'Search Content';
      case 'Ls':
        return 'List Directory';
      default:
        return undefined;
    }
  }
}
