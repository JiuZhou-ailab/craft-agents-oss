// input: Pi's base UI context and Storyflow's existing structured-question host callbacks
// output: RPC-capable Extension UI dialogs with unsupported TUI components disabled
// pos: Thin projection from Pi Extension UI onto Storyflow's existing human-in-the-loop contract

import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import type {
  UserQuestion,
  UserQuestionResponse,
} from '../../session-tools-core/src/types.ts';

interface ExtensionUIHost {
  askUserQuestion(question: UserQuestion): Promise<UserQuestionResponse>;
  notify(message: string, type?: 'info' | 'warning' | 'error'): void;
}

const HEADER = '扩展';

export function createExtensionUIContext(
  base: ExtensionUIContext,
  host: ExtensionUIHost,
): ExtensionUIContext {
  // ponytail: dialog timeouts/signals use host cancellation for now; add a
  // correlated cancel message when an installed Extension demonstrably needs them.
  const ask = async (question: UserQuestion): Promise<string | undefined> => {
    const response = await host.askUserQuestion(question);
    return response.cancelled ? undefined : response.answers[question.question];
  };

  return {
    ...base,
    select: async (title: string, options: string[]) => {
      if (options.length === 0) return undefined;
      return ask({
        header: HEADER,
        question: title,
        options: options.map((label: string) => ({ label, description: `选择 ${label}` })),
        multiSelect: false,
      });
    },
    confirm: async (title: string, message: string) => {
      const answer = await ask({
        header: HEADER,
        question: message || title,
        options: [
          { label: '确认', description: '继续执行此操作' },
          { label: '取消', description: '保持当前状态' },
        ],
        multiSelect: false,
      });
      return answer === '确认';
    },
    input: async (title: string, placeholder?: string) => ask({
      header: HEADER,
      question: placeholder ? `${title}\n${placeholder}` : title,
      options: [],
      multiSelect: false,
    }),
    notify: host.notify,
    // Pi RPC cannot render arbitrary terminal components. Leaving this absent lets
    // extensions such as pi-rewind select their standard dialog fallback.
    custom: undefined,
  } as unknown as ExtensionUIContext;
}
