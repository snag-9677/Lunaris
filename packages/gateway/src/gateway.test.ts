import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  EventEnvelope,
  EventStore,
  LunarisManifest,
  ProviderAdapter,
  UnifiedEvent,
  UnifiedRequest,
} from '@lunaris/core';
import { ModelGateway } from './gateway.js';
import { InMemoryBudgetLedger } from './budget.js';
import { estimateCostUsd } from './pricing.js';

function makeManifest(): LunarisManifest {
  return {
    project: { id: 'proj-1', name: 'Test Project' },
    models: { default: 'mock/echo' },
    providers: { mock: {} },
    budgets: { perDayUsd: 10 },
  };
}

class FakeEventStore implements EventStore {
  readonly appended: EventEnvelope[] = [];
  private seq = 0;

  append(e: Omit<EventEnvelope, 'eventId' | 'ts'>): EventEnvelope {
    const env: EventEnvelope = { ...e, eventId: `evt-${++this.seq}`, ts: new Date().toISOString() };
    this.appended.push(env);
    return env;
  }

  query(): EventEnvelope[] {
    return this.appended;
  }

  subscribe(): () => void {
    return () => {};
  }
}

async function collect(stream: AsyncIterable<UnifiedEvent>): Promise<UnifiedEvent[]> {
  const out: UnifiedEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

test('mock echo end-to-end through ModelGateway: deltas, usage, settle, llm.call event', async () => {
  const events = new FakeEventStore();
  const ledger = new InMemoryBudgetLedger({ perDayUsd: 10 });
  const gw = new ModelGateway({ manifest: makeManifest(), ledger, events });

  const input = 'hello lunaris gateway';
  const req: UnifiedRequest = {
    model: 'mock/echo',
    messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
    meta: { projectId: 'proj-1', callId: 'call-1', taskId: 'task-1', agentRole: 'coder' },
  };

  const evs = await collect(gw.chat(req));

  assert.equal(evs[0]?.type, 'message_start');
  const deltas = evs.flatMap((e) => (e.type === 'text_delta' ? [e.text] : []));
  assert.equal(deltas.length, 2, 'mock echoes in exactly 2 deltas');
  assert.equal(deltas.join(''), input);

  const end = evs.at(-1);
  assert.ok(end && end.type === 'message_end');
  assert.equal(end.stopReason, 'end');
  assert.equal(end.usage.inputTokens, Math.ceil(input.length / 4));
  assert.equal(end.usage.outputTokens, Math.ceil(input.length / 4));
  assert.equal(end.usage.costUsd, 0, 'mock provider is free');

  // Reservation released and settled at $0 — day budget back to zero spend.
  const day = ledger.dayTotals();
  assert.equal(day.reserved, 0);
  assert.equal(day.settled, 0);

  // llm.call appended to the event spine.
  assert.equal(events.appended.length, 1);
  const evt = events.appended[0];
  assert.ok(evt);
  assert.equal(evt.kind, 'llm.call');
  assert.equal(evt.projectId, 'proj-1');
  assert.equal(evt.taskId, 'task-1');
  const payload = evt.payload as { model: string; stopReason: string; usage: { costUsd: number } };
  assert.equal(payload.model, 'mock/echo');
  assert.equal(payload.stopReason, 'end');
});

test('mock tool_call path: emits tool_call when requested, echoes once a tool_result exists', async () => {
  const gw = new ModelGateway({ manifest: makeManifest(), ledger: new InMemoryBudgetLedger() });

  const toolText = 'USE_TOOL:get_weather {"city":"Sydney"}';
  const req: UnifiedRequest = {
    model: 'mock/echo',
    messages: [{ role: 'user', content: [{ type: 'text', text: toolText }] }],
    tools: [{ name: 'get_weather', description: 'Get weather for a city', inputSchema: { type: 'object' } }],
    meta: { projectId: 'proj-1', callId: 'call-2' },
  };

  const evs = await collect(gw.chat(req));
  const toolCall = evs.find((e) => e.type === 'tool_call');
  assert.ok(toolCall && toolCall.type === 'tool_call');
  assert.equal(toolCall.name, 'get_weather');
  assert.deepEqual(toolCall.args, { city: 'Sydney' });

  const end = evs.at(-1);
  assert.ok(end && end.type === 'message_end');
  assert.equal(end.stopReason, 'tool_calls');

  // Follow-up turn carrying the tool_result → mock falls back to echoing.
  const followUp: UnifiedRequest = {
    ...req,
    messages: [
      ...req.messages,
      { role: 'assistant', content: [{ type: 'tool_call', id: toolCall.id, name: 'get_weather', args: { city: 'Sydney' } }] },
      { role: 'tool', content: [{ type: 'tool_result', toolCallId: toolCall.id, content: '22C and sunny' }] },
    ],
    meta: { projectId: 'proj-1', callId: 'call-3' },
  };
  const evs2 = await collect(gw.chat(followUp));
  assert.ok(!evs2.some((e) => e.type === 'tool_call'), 'no second tool_call once a tool_result is present');
  const echoed = evs2.flatMap((e) => (e.type === 'text_delta' ? [e.text] : [])).join('');
  assert.equal(echoed, toolText);
  const end2 = evs2.at(-1);
  assert.ok(end2 && end2.type === 'message_end');
  assert.equal(end2.stopReason, 'end');
});

test('unknown tool in USE_TOOL falls back to echo', async () => {
  const gw = new ModelGateway({ manifest: makeManifest(), ledger: new InMemoryBudgetLedger() });
  const req: UnifiedRequest = {
    model: 'mock/echo',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'USE_TOOL:nope {"x":1}' }] }],
    tools: [{ name: 'get_weather', description: 'weather', inputSchema: {} }],
    meta: { projectId: 'proj-1', callId: 'call-4' },
  };
  const evs = await collect(gw.chat(req));
  assert.ok(!evs.some((e) => e.type === 'tool_call'));
  const end = evs.at(-1);
  assert.ok(end && end.type === 'message_end' && end.stopReason === 'end');
});

/** Adapter stub for paid-model tests: streams a fixed reply without any network. */
function fakePaidAdapter(id = 'anthropic'): ProviderAdapter {
  return {
    id,
    // eslint-disable-next-line @typescript-eslint/require-await
    async *chat(): AsyncIterable<UnifiedEvent> {
      yield { type: 'message_start', model: `${id}/fake` };
      yield { type: 'text_delta', text: 'hello' };
      yield {
        type: 'message_end',
        stopReason: 'end',
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
      };
    },
  };
}

test('budget denial surfaces as message_end error and records an llm.call error event', async () => {
  const events = new FakeEventStore();
  // Paid models floor the reservation at $0.001, so a $0.0005 day cap always denies.
  const ledger = new InMemoryBudgetLedger({ perDayUsd: 0.0005 });
  const gw = new ModelGateway({
    manifest: makeManifest(),
    ledger,
    events,
    adapters: { anthropic: fakePaidAdapter() },
  });

  const req: UnifiedRequest = {
    model: 'anthropic/claude-sonnet-4-6',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    meta: { projectId: 'proj-1', callId: 'call-5' },
  };

  const evs = await collect(gw.chat(req));
  assert.equal(evs.length, 1, 'denied calls emit only the terminal message_end');
  const end = evs[0];
  assert.ok(end && end.type === 'message_end');
  assert.equal(end.stopReason, 'error');
  assert.match(end.error ?? '', /Budget exceeded/);

  const evt = events.appended[0];
  assert.ok(evt);
  const payload = evt.payload as { stopReason: string; error?: string };
  assert.equal(payload.stopReason, 'error');
  assert.match(payload.error ?? '', /Budget exceeded/);
});

test('early consumer break refunds the reservation (no perDayUsd leak)', async () => {
  const ledger = new InMemoryBudgetLedger({ perDayUsd: 10 });
  const gw = new ModelGateway({
    manifest: makeManifest(),
    ledger,
    adapters: { anthropic: fakePaidAdapter() },
  });
  const req: UnifiedRequest = {
    model: 'anthropic/claude-sonnet-4-6',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'long-running request' }] }],
    meta: { projectId: 'proj-1', callId: 'call-break', taskId: 'task-break' },
  };

  let sawFirstEvent = false;
  for await (const ev of gw.chat(req)) {
    assert.equal(ev.type, 'message_start');
    assert.ok(ledger.dayTotals().reserved > 0, 'a nonzero reservation is held mid-stream');
    sawFirstEvent = true;
    break; // consumer bails out early → generator .return() must refund via finally
  }
  assert.ok(sawFirstEvent);

  const day = ledger.dayTotals();
  assert.equal(day.reserved, 0, 'reservation refunded after early break');
  assert.equal(day.settled, 0, 'nothing settled after early break');
  const task = ledger.taskTotals('task-break');
  assert.equal(task.reserved, 0);
  assert.equal(task.settled, 0);
});

test('known-free models (mock/*, ollama/*) reserve $0: no $0.001 floor against tiny caps', async () => {
  // A day cap below the old floor: a free model must still be admitted.
  const ledger = new InMemoryBudgetLedger({ perDayUsd: 0.0005 });
  const gw = new ModelGateway({ manifest: makeManifest(), ledger });
  const req: UnifiedRequest = {
    model: 'mock/echo',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    meta: { projectId: 'proj-1', callId: 'call-free' },
  };
  const evs = await collect(gw.chat(req));
  const end = evs.at(-1);
  assert.ok(end && end.type === 'message_end');
  assert.equal(end.stopReason, 'end', end.type === 'message_end' ? end.error : '');
  const day = ledger.dayTotals();
  assert.equal(day.reserved, 0);
  assert.equal(day.settled, 0);
});

test('missing API key yields a clear message_end error naming the env var', async () => {
  const gw = new ModelGateway({
    manifest: makeManifest(),
    ledger: new InMemoryBudgetLedger(),
    env: {}, // no keys available
  });
  const req: UnifiedRequest = {
    model: 'anthropic/claude-sonnet-4-6',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    meta: { projectId: 'proj-1', callId: 'call-6' },
  };
  const evs = await collect(gw.chat(req));
  const end = evs.at(-1);
  assert.ok(end && end.type === 'message_end');
  assert.equal(end.stopReason, 'error');
  assert.match(end.error ?? '', /ANTHROPIC_API_KEY/);
});

test('unknown provider yields a message_end error', async () => {
  const gw = new ModelGateway({ manifest: makeManifest(), ledger: new InMemoryBudgetLedger() });
  const req: UnifiedRequest = {
    model: 'nope/some-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    meta: { projectId: 'proj-1', callId: 'call-7' },
  };
  const evs = await collect(gw.chat(req));
  const end = evs.at(-1);
  assert.ok(end && end.type === 'message_end');
  assert.equal(end.stopReason, 'error');
  assert.match(end.error ?? '', /Unknown provider/);
});

test('pricing: estimateCostUsd applies per-MTok rates; local providers are free', () => {
  // 1M in + 1M out on opus-4-8 = $5 + $25
  assert.equal(
    estimateCostUsd('anthropic/claude-opus-4-8', { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    30,
  );
  assert.equal(
    estimateCostUsd('anthropic/claude-haiku-4-5-20251001', { inputTokens: 2_000_000, outputTokens: 0 }),
    2,
  );
  assert.equal(estimateCostUsd('ollama/qwen3:8b', { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 0);
  assert.equal(estimateCostUsd('mock/echo', { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 0);
  assert.equal(estimateCostUsd('openai/some-unknown-model', { inputTokens: 1_000_000, outputTokens: 0 }), 0);
});

test('ollama base URL resolution: OLLAMA_BASE_URL env overrides manifest, falls back to default', async () => {
  // Stub global fetch to capture the URL the Ollama adapter hits and return a
  // minimal NDJSON completion stream.
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ message: { content: 'hi' }, done: true, prompt_eval_count: 1, eval_count: 1 }) + '\n',
          ),
        );
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  }) as typeof fetch;

  try {
    const req = (): UnifiedRequest => ({
      model: 'ollama/llama3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      meta: { projectId: 'proj-1', callId: 'c', taskId: 't', agentRole: 'coder' },
    });
    const manifest: LunarisManifest = {
      project: { id: 'proj-1', name: 'P' },
      models: { default: 'ollama/llama3' },
      providers: { ollama: { baseUrl: 'http://manifest-host:11434' } },
      budgets: { perDayUsd: 10 },
    };

    // env wins over the manifest baseUrl
    const gwEnv = new ModelGateway({
      manifest,
      ledger: new InMemoryBudgetLedger({ perDayUsd: 10 }),
      env: { OLLAMA_BASE_URL: 'http://remote-ollama:9999' },
    });
    await collect(gwEnv.chat(req()));
    assert.ok(calls[0]?.startsWith('http://remote-ollama:9999/'), `env override; got ${calls[0]}`);

    // no env → manifest baseUrl
    calls.length = 0;
    const gwManifest = new ModelGateway({
      manifest,
      ledger: new InMemoryBudgetLedger({ perDayUsd: 10 }),
      env: {},
    });
    await collect(gwManifest.chat(req()));
    assert.ok(calls[0]?.startsWith('http://manifest-host:11434/'), `manifest fallback; got ${calls[0]}`);

    // neither → adapter default localhost:11434
    calls.length = 0;
    const gwDefault = new ModelGateway({
      manifest: { project: { id: 'p', name: 'P' }, models: { default: 'ollama/llama3' }, providers: { ollama: {} }, budgets: { perDayUsd: 10 } },
      ledger: new InMemoryBudgetLedger({ perDayUsd: 10 }),
      env: {},
    });
    await collect(gwDefault.chat(req()));
    assert.ok(calls[0]?.startsWith('http://localhost:11434/'), `default; got ${calls[0]}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});
