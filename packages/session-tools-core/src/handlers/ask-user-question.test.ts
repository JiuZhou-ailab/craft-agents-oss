// input: Session question requests and simulated UI responses
// output: Regression coverage for blocking question tool behavior
// pos: Minimal contract check for the human-in-the-loop handler

import { describe, expect, it } from 'bun:test';
import { handleAskUserQuestion } from './ask-user-question.ts';
import type { SessionToolContext } from '../context.ts';
import { AskUserQuestionSchema } from '../tool-defs.ts';

describe('handleAskUserQuestion', () => {
  it('accepts free-form-only questions without fake choices', () => {
    expect(AskUserQuestionSchema.safeParse({
      questions: [{
        header: 'Extension',
        question: 'Checkpoint name',
        multiSelect: false,
        options: [],
      }],
    }).success).toBe(true);
  });

  it('waits for and returns the user answer', async () => {
    const ctx = {
      sessionId: 'session-1',
      callbacks: {
        onPlanSubmitted: () => {},
        onAuthRequest: () => {},
        onAskUserQuestion: async () => ({ answers: { '选择哪个方案？': '第一个方案' } }),
      },
    } as unknown as SessionToolContext;

    const result = await handleAskUserQuestion(ctx, {
      questions: [{
        header: '方案',
        question: '选择哪个方案？',
        multiSelect: false,
        options: [
          { label: '第一个方案', description: '使用第一个方案' },
          { label: '第二个方案', description: '使用第二个方案' },
        ],
      }],
    });

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]!.text!)).toEqual({ answers: { '选择哪个方案？': '第一个方案' } });
  });
});
