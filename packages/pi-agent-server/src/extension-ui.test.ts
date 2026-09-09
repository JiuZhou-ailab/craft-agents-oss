// input: Synthetic Pi UI calls and host answers
// output: Assertions for the Extension UI to structured-question projection
// pos: Behavior check for the non-TUI Pi Extension bridge

import { describe, expect, it } from 'bun:test';
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';

import { createExtensionUIContext } from './extension-ui.ts';

const base = {
  custom: async () => undefined,
} as unknown as ExtensionUIContext;

describe('createExtensionUIContext', () => {
  it('projects dialogs onto the existing host question flow', async () => {
    const questions: Array<{ question: string; options: string[] }> = [];
    const notifications: string[] = [];
    const ui = createExtensionUIContext(base, {
      askUserQuestion: async (question) => {
        expect(question.header).toBe('扩展');
        questions.push({
          question: question.question,
          options: question.options.map((option) => option.label),
        });
        return {
          answers: {
            [question.question]: question.options[0]?.label ?? 'draft',
          },
        };
      },
      notify: (message) => notifications.push(message),
    });

    await expect(ui.select('Choose checkpoint', ['one', 'two'])).resolves.toBe('one');
    await expect(ui.confirm('Restore', 'Restore files?')).resolves.toBe(true);
    await expect(ui.input('Name', 'Optional label')).resolves.toBe('draft');
    ui.notify('Checkpoint restored');

    expect(questions).toEqual([
      { question: 'Choose checkpoint', options: ['one', 'two'] },
      { question: 'Restore files?', options: ['确认', '取消'] },
      { question: 'Name\nOptional label', options: [] },
    ]);
    expect(notifications).toEqual(['Checkpoint restored']);
    expect((ui as unknown as { custom?: unknown }).custom).toBeUndefined();
  });

  it('maps host cancellation to Pi dialog defaults', async () => {
    const ui = createExtensionUIContext(base, {
      askUserQuestion: async () => ({ answers: {}, cancelled: true }),
      notify: () => {},
    });

    await expect(ui.select('Choose', ['one'])).resolves.toBeUndefined();
    await expect(ui.confirm('Confirm', 'Continue?')).resolves.toBe(false);
    await expect(ui.input('Name')).resolves.toBeUndefined();
  });
});
