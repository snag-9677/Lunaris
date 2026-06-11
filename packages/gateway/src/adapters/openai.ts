import type { ProviderAdapter, StopReason, UnifiedEvent, UnifiedRequest } from '@lunaris/core';
import { splitModelId } from '../pricing.js';
import { sseEvents } from '../sse.js';

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';

export interface OpenAIAdapterOptions {
  apiKey: string;
  /** Provider id this instance serves ('openai' | 'deepseek' | other compatible). */
  id?: string;
  baseUrl?: string;
}

type OaiMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Map unified ChatMessages onto OpenAI chat-completions messages. */
function toOpenAiMessages(req: UnifiedRequest): OaiMessage[] {
  const out: OaiMessage[] = [];
  if (req.system) out.push({ role: 'system', content: req.system });

  for (const msg of req.messages) {
    const texts = msg.content.flatMap((p) => (p.type === 'text' ? [p.text] : []));
    const toolCalls = msg.content.flatMap((p) => (p.type === 'tool_call' ? [p] : []));
    const toolResults = msg.content.flatMap((p) => (p.type === 'tool_result' ? [p] : []));

    if (toolCalls.length > 0) {
      out.push({
        role: 'assistant',
        content: texts.length > 0 ? texts.join('\n') : null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
        })),
      });
    } else if (texts.length > 0) {
      const role = msg.role === 'system' ? 'system' : msg.role === 'assistant' ? 'assistant' : 'user';
      out.push({ role, content: texts.join('\n') });
    }

    for (const tr of toolResults) {
      out.push({ role: 'tool', tool_call_id: tr.toolCallId, content: tr.content });
    }
  }
  return out;
}

function mapFinishReason(reason: string | undefined, sawToolCalls: boolean): StopReason {
  switch (reason) {
    case 'tool_calls':
      return 'tool_calls';
    case 'length':
      return 'max_tokens';
    case 'stop':
      return 'end';
    default:
      return sawToolCalls ? 'tool_calls' : 'end';
  }
}

interface OaiChunk {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/**
 * OpenAI-compatible chat-completions adapter. Covers OpenAI and DeepSeek
 * (and any other compatible endpoint) via baseUrl.
 */
export class OpenAIAdapter implements ProviderAdapter {
  readonly id: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: OpenAIAdapterOptions) {
    this.id = opts.id ?? 'openai';
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? (this.id === 'deepseek' ? DEEPSEEK_DEFAULT_BASE_URL : OPENAI_DEFAULT_BASE_URL)).replace(/\/$/, '');
  }

  async *chat(req: UnifiedRequest): AsyncIterable<UnifiedEvent> {
    const { model } = splitModelId(req.model);

    const body: Record<string, unknown> = {
      model,
      messages: toOpenAiMessages(req),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.maxTokens !== undefined) body['max_tokens'] = req.maxTokens;
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.tools && req.tools.length > 0) {
      body['tools'] = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${this.id} API error (HTTP ${res.status}): ${detail.slice(0, 500)}`);
    }

    yield { type: 'message_start', model: req.model };

    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: string | undefined;
    // tool_call fragments accumulate per choice-delta index
    const pending = new Map<number, { id: string; name: string; args: string }>();

    for await (const ev of sseEvents(res.body)) {
      if (ev.data === '[DONE]') break;
      const chunk = JSON.parse(ev.data) as OaiChunk;

      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
        outputTokens = chunk.usage.completion_tokens ?? outputTokens;
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta;
      if (delta?.content) {
        yield { type: 'text_delta', text: delta.content };
      }
      if (delta?.tool_calls) {
        for (const frag of delta.tool_calls) {
          const idx = frag.index ?? 0;
          let entry = pending.get(idx);
          if (!entry) {
            entry = { id: frag.id ?? `call_${idx}`, name: '', args: '' };
            pending.set(idx, entry);
          }
          if (frag.id) entry.id = frag.id;
          if (frag.function?.name) entry.name = frag.function.name;
          if (frag.function?.arguments) entry.args += frag.function.arguments;
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    // Flush accumulated tool calls in index order.
    for (const [, entry] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      let args: unknown = {};
      if (entry.args.trim()) {
        try {
          args = JSON.parse(entry.args);
        } catch {
          args = entry.args;
        }
      }
      yield { type: 'tool_call', id: entry.id, name: entry.name, args };
    }

    yield {
      type: 'message_end',
      stopReason: mapFinishReason(finishReason, pending.size > 0),
      usage: { inputTokens, outputTokens, costUsd: 0 },
    };
  }
}
