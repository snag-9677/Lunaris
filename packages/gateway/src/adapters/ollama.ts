import { randomUUID } from 'node:crypto';
import type { ProviderAdapter, UnifiedEvent, UnifiedRequest } from '@lunaris/core';
import { ndjsonLines } from '../sse.js';
import { splitModelId } from '../pricing.js';

export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434';

export interface OllamaAdapterOptions {
  baseUrl?: string;
}

type OllamaMessage =
  | { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }
  | {
      role: 'assistant';
      content: string;
      tool_calls: { function: { name: string; arguments: unknown } }[];
    };

/** Map unified ChatMessages onto Ollama /api/chat messages (text flattened). */
function toOllamaMessages(req: UnifiedRequest): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  if (req.system) out.push({ role: 'system', content: req.system });

  for (const msg of req.messages) {
    const texts = msg.content.flatMap((p) => (p.type === 'text' ? [p.text] : []));
    const toolCalls = msg.content.flatMap((p) => (p.type === 'tool_call' ? [p] : []));
    const toolResults = msg.content.flatMap((p) => (p.type === 'tool_result' ? [p] : []));

    if (toolCalls.length > 0) {
      out.push({
        role: 'assistant',
        content: texts.join('\n'),
        tool_calls: toolCalls.map((tc) => ({ function: { name: tc.name, arguments: tc.args ?? {} } })),
      });
    } else if (texts.length > 0) {
      const role = msg.role === 'system' ? 'system' : msg.role === 'assistant' ? 'assistant' : 'user';
      out.push({ role, content: texts.join('\n') });
    }

    for (const tr of toolResults) {
      out.push({ role: 'tool', content: tr.content });
    }
  }
  return out;
}

interface OllamaChunk {
  message?: {
    content?: string;
    tool_calls?: { function?: { name?: string; arguments?: unknown } }[];
  };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/** Ollama /api/chat adapter (NDJSON streaming). Local models — costUsd is always 0. */
export class OllamaAdapter implements ProviderAdapter {
  readonly id = 'ollama';
  private readonly baseUrl: string;

  constructor(opts: OllamaAdapterOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  async *chat(req: UnifiedRequest): AsyncIterable<UnifiedEvent> {
    const { model } = splitModelId(req.model);

    const body: Record<string, unknown> = {
      model,
      messages: toOllamaMessages(req),
      stream: true,
    };
    if (req.tools && req.tools.length > 0) {
      body['tools'] = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }
    const options: Record<string, unknown> = {};
    if (req.temperature !== undefined) options['temperature'] = req.temperature;
    if (req.maxTokens !== undefined) options['num_predict'] = req.maxTokens;
    if (Object.keys(options).length > 0) body['options'] = options;

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Ollama API error (HTTP ${res.status}): ${detail.slice(0, 500)}`);
    }

    yield { type: 'message_start', model: req.model };

    let inputTokens = 0;
    let outputTokens = 0;
    let sawToolCall = false;

    for await (const line of ndjsonLines(res.body)) {
      const chunk = line as OllamaChunk;
      if (chunk.error) throw new Error(`Ollama stream error: ${chunk.error}`);

      if (chunk.message?.content) {
        yield { type: 'text_delta', text: chunk.message.content };
      }
      if (chunk.message?.tool_calls) {
        for (const tc of chunk.message.tool_calls) {
          sawToolCall = true;
          yield {
            type: 'tool_call',
            id: randomUUID(), // ollama does not assign tool-call ids
            name: tc.function?.name ?? '',
            args: tc.function?.arguments ?? {},
          };
        }
      }
      if (chunk.done) {
        inputTokens = chunk.prompt_eval_count ?? 0;
        outputTokens = chunk.eval_count ?? 0;
      }
    }

    yield {
      type: 'message_end',
      stopReason: sawToolCall ? 'tool_calls' : 'end',
      usage: { inputTokens, outputTokens, costUsd: 0 },
    };
  }
}
