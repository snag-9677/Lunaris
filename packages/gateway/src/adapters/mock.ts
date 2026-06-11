import type { ChatMessage, ProviderAdapter, UnifiedEvent, UnifiedRequest, Usage } from '@lunaris/core';

/**
 * Deterministic 'mock' provider for tests and offline development.
 *
 * Model 'echo': streams the last user text back in 2 text deltas.
 * If the last user text contains `USE_TOOL:<name> <json-args>` AND that tool
 * exists in req.tools AND no tool_result is present yet in the conversation,
 * it emits one tool_call instead (then, on the follow-up turn that carries the
 * tool_result, it echoes).
 *
 * Usage is deterministic: inputTokens = outputTokens = ceil(chars/4), costUsd 0.
 */
export class MockAdapter implements ProviderAdapter {
  readonly id = 'mock';

  async *chat(req: UnifiedRequest): AsyncIterable<UnifiedEvent> {
    const text = lastUserText(req.messages);

    yield { type: 'message_start', model: req.model };

    const tokens = Math.ceil(text.length / 4);
    const usage: Usage = { inputTokens: tokens, outputTokens: tokens, costUsd: 0 };

    const match = /USE_TOOL:(\S+)\s+(.+)/s.exec(text);
    const hasToolResult = req.messages.some((m) => m.content.some((p) => p.type === 'tool_result'));

    if (match && !hasToolResult) {
      const name = match[1] ?? '';
      const rawArgs = (match[2] ?? '').trim();
      const toolExists = req.tools?.some((t) => t.name === name) ?? false;
      if (toolExists) {
        let args: unknown;
        try {
          args = JSON.parse(rawArgs);
        } catch {
          args = rawArgs;
        }
        yield { type: 'tool_call', id: 'mock_call_1', name, args };
        yield { type: 'message_end', stopReason: 'tool_calls', usage };
        return;
      }
    }

    // Echo path: stream the text back in two deltas.
    const mid = Math.ceil(text.length / 2);
    if (text.length > 0) {
      yield { type: 'text_delta', text: text.slice(0, mid) };
      if (mid < text.length) yield { type: 'text_delta', text: text.slice(mid) };
    }
    yield { type: 'message_end', stopReason: 'end', usage };
  }
}

function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== 'user') continue;
    const text = msg.content
      .flatMap((p) => (p.type === 'text' ? [p.text] : []))
      .join('\n');
    if (text) return text;
  }
  return '';
}
