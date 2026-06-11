import type { ProviderAdapter, StopReason, UnifiedEvent, UnifiedRequest } from '@lunaris/core';
import { splitModelId } from '../pricing.js';
import { sseEvents } from '../sse.js';

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';

/** Known Anthropic model ids (full table with pricing lives in pricing.ts). */
export const ANTHROPIC_KNOWN_MODELS = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
] as const;

export interface AnthropicAdapterOptions {
  apiKey: string;
  baseUrl?: string;
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

/** Map unified ChatMessages onto Anthropic Messages API blocks. */
function toAnthropicPayload(req: UnifiedRequest): { system?: string; messages: AnthropicMessage[] } {
  let system = req.system;
  const messages: AnthropicMessage[] = [];

  for (const msg of req.messages) {
    if (msg.role === 'system') {
      const text = msg.content
        .flatMap((p) => (p.type === 'text' ? [p.text] : []))
        .join('\n');
      if (text) system = system ? `${system}\n${text}` : text;
      continue;
    }

    const blocks: AnthropicContentBlock[] = [];
    let role: 'user' | 'assistant' = msg.role === 'assistant' ? 'assistant' : 'user';

    for (const part of msg.content) {
      if (part.type === 'text') {
        blocks.push({ type: 'text', text: part.text });
      } else if (part.type === 'tool_call') {
        role = 'assistant';
        blocks.push({ type: 'tool_use', id: part.id, name: part.name, input: part.args ?? {} });
      } else {
        // tool_result blocks live in user-role messages on the Anthropic API
        role = 'user';
        const block: AnthropicContentBlock = { type: 'tool_result', tool_use_id: part.toolCallId, content: part.content };
        if (part.isError) block.is_error = true;
        blocks.push(block);
      }
    }

    if (blocks.length > 0) messages.push({ role, content: blocks });
  }

  const out: { system?: string; messages: AnthropicMessage[] } = { messages };
  if (system) out.system = system;
  return out;
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'max_tokens';
    case 'end_turn':
    default:
      return 'end';
  }
}

interface SseData {
  type?: string;
  index?: number;
  message?: { usage?: { input_tokens?: number } };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
}

/** Anthropic Messages API adapter (raw streaming HTTP — no SDK dependency by design). */
export class AnthropicAdapter implements ProviderAdapter {
  readonly id = 'anthropic';
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: AnthropicAdapterOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  async *chat(req: UnifiedRequest): AsyncIterable<UnifiedEvent> {
    const { model } = splitModelId(req.model);
    const { system, messages } = toAnthropicPayload(req);

    const body: Record<string, unknown> = {
      model,
      max_tokens: req.maxTokens ?? 4096,
      messages,
      stream: true,
    };
    if (system) body['system'] = system;
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.tools && req.tools.length > 0) {
      body['tools'] = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    }

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Anthropic API error (HTTP ${res.status}): ${detail.slice(0, 500)}`);
    }

    yield { type: 'message_start', model: req.model };

    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: StopReason = 'end';
    // index → accumulating tool_use block (input streamed as partial JSON)
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();

    for await (const ev of sseEvents(res.body)) {
      const data = JSON.parse(ev.data) as SseData;
      switch (data.type) {
        case 'message_start':
          inputTokens = data.message?.usage?.input_tokens ?? 0;
          break;
        case 'content_block_start':
          if (data.content_block?.type === 'tool_use' && data.index !== undefined) {
            toolBlocks.set(data.index, {
              id: data.content_block.id ?? `toolu_${data.index}`,
              name: data.content_block.name ?? '',
              json: '',
            });
          }
          break;
        case 'content_block_delta':
          if (data.delta?.type === 'text_delta' && data.delta.text) {
            yield { type: 'text_delta', text: data.delta.text };
          } else if (data.delta?.type === 'input_json_delta' && data.index !== undefined) {
            const tb = toolBlocks.get(data.index);
            if (tb) tb.json += data.delta.partial_json ?? '';
          }
          break;
        case 'content_block_stop': {
          if (data.index === undefined) break;
          const tb = toolBlocks.get(data.index);
          if (tb) {
            toolBlocks.delete(data.index);
            let args: unknown = {};
            if (tb.json.trim()) {
              try {
                args = JSON.parse(tb.json);
              } catch {
                args = tb.json; // pass through unparseable input rather than dropping it
              }
            }
            yield { type: 'tool_call', id: tb.id, name: tb.name, args };
          }
          break;
        }
        case 'message_delta':
          if (data.usage?.output_tokens !== undefined) outputTokens = data.usage.output_tokens;
          if (data.delta?.stop_reason) stopReason = mapStopReason(data.delta.stop_reason);
          break;
        case 'message_stop':
          yield { type: 'message_end', stopReason, usage: { inputTokens, outputTokens, costUsd: 0 } };
          return;
        case 'error':
          throw new Error(`Anthropic stream error: ${data.error?.message ?? ev.data}`);
        default:
          break; // ping etc.
      }
    }

    // Stream ended without an explicit message_stop — still honor the contract.
    yield { type: 'message_end', stopReason, usage: { inputTokens, outputTokens, costUsd: 0 } };
  }
}
