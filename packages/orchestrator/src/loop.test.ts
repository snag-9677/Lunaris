import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {
  EventEnvelope,
  EventStore,
  Goal,
  ResultEnvelope,
  RoleDef,
  UnifiedEvent,
  UnifiedRequest,
  Usage,
} from '@lunaris/core';
import type { ChatGateway } from './loop.js';
import { AgentLoop } from './loop.js';
import { builtinRoles } from './roles.js';

const usage: Usage = { inputTokens: 10, outputTokens: 5, costUsd: 0.0001 };

function end(stopReason: 'end' | 'tool_calls' | 'error', error?: string): UnifiedEvent {
  return { type: 'message_end', stopReason, usage, ...(error !== undefined ? { error } : {}) };
}

function makeGoal(prompt: string): Goal {
  return {
    goalId: `goal-${Math.random().toString(36).slice(2, 8)}`,
    projectId: 'p1',
    prompt,
    createdAt: new Date().toISOString(),
    status: 'running',
  };
}

function stubEvents(): { store: EventStore; events: EventEnvelope[] } {
  const events: EventEnvelope[] = [];
  const store: EventStore = {
    append(e) {
      const env: EventEnvelope = {
        ...e,
        eventId: `ev-${String(events.length + 1).padStart(4, '0')}`,
        ts: new Date().toISOString(),
      };
      events.push(env);
      return env;
    },
    query(opts) {
      const matched = events.filter(
        (ev) =>
          (opts.projectId === undefined || ev.projectId === opts.projectId) &&
          (opts.kind === undefined || ev.kind === opts.kind),
      );
      return opts.limit !== undefined ? matched.slice(0, opts.limit) : matched;
    },
    subscribe() {
      return () => {};
    },
  };
  return { store, events };
}

interface ScriptedGateway extends ChatGateway {
  requests: UnifiedRequest[];
}

/** Hand-rolled gateway stub: a script maps each request to a list of stream events. */
function scriptedGateway(
  script: (req: UnifiedRequest, call: number) => UnifiedEvent[],
): ScriptedGateway {
  const requests: UnifiedRequest[] = [];
  return {
    requests,
    async *chat(req: UnifiedRequest): AsyncIterable<UnifiedEvent> {
      requests.push(req);
      yield { type: 'message_start', model: req.model };
      for (const ev of script(req, requests.length)) yield ev;
    },
  };
}

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'lunaris-loop-'));
}

test('loop executes a tool call, journals every turn, emits events, and terminates', async () => {
  const root = await makeRoot();
  try {
    const { store, events } = stubEvents();
    const gw = scriptedGateway((_req, call) => {
      if (call === 1) {
        return [
          {
            type: 'tool_call',
            id: 't1',
            name: 'write_file',
            args: { path: 'hello.txt', content: 'hi' },
          },
          end('tool_calls'),
        ];
      }
      return [
        { type: 'text_delta', text: 'all ' },
        { type: 'text_delta', text: 'done' },
        end('end'),
      ];
    });
    const loop = new AgentLoop({
      gateway: gw,
      events: store,
      projectId: 'p1',
      projectRoot: root,
      model: 'mock/echo',
    });
    const goal = makeGoal('write hello.txt containing hi');
    const outcome = await loop.run(goal, 'coder');

    assert.equal(outcome.result.status, 'success');
    assert.equal(outcome.goal.status, 'done');
    assert.equal(outcome.finalText, 'all done');

    // Tool actually executed.
    assert.equal(await readFile(path.join(root, 'hello.txt'), 'utf8'), 'hi');

    // Tool result fed back to the model on the second request.
    const second = gw.requests[1];
    assert.ok(second);
    const lastMsg = second.messages[second.messages.length - 1];
    assert.ok(lastMsg);
    assert.equal(lastMsg.role, 'tool');
    const part = lastMsg.content[0];
    assert.ok(part && part.type === 'tool_result' && part.toolCallId === 't1');

    // Journal written: 2 llm turns + 1 tool call as JSONL.
    const journalRaw = await readFile(
      path.join(root, '.lunaris', 'journal', `${goal.goalId}.jsonl`),
      'utf8',
    );
    const lines = journalRaw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { kind: string });
    assert.equal(lines.filter((l) => l.kind === 'llm.turn').length, 2);
    assert.equal(lines.filter((l) => l.kind === 'tool.call').length, 1);

    // tool.call event emitted with name/args summary/duration/ok.
    const toolEvents = events.filter((e) => e.kind === 'tool.call');
    assert.equal(toolEvents.length, 1);
    const payload = toolEvents[0]!.payload as {
      name: string;
      args: string;
      durationMs: number;
      ok: boolean;
    };
    assert.equal(payload.name, 'write_file');
    assert.equal(payload.ok, true);
    assert.match(payload.args, /hello\.txt/);
    assert.equal(typeof payload.durationMs, 'number');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('spawn_subagent runs a nested coder loop, emits task.start/task.end with a ResultEnvelope', async () => {
  const root = await makeRoot();
  try {
    const { store, events } = stubEvents();
    const gw = scriptedGateway((req, call) => {
      if (req.meta.agentRole === 'coder') {
        return [{ type: 'text_delta', text: 'sub finished: wrote a.txt' }, end('end')];
      }
      if (call === 1) {
        return [
          {
            type: 'tool_call',
            id: 's1',
            name: 'spawn_subagent',
            args: { role: 'coder', task: 'create a.txt' },
          },
          end('tool_calls'),
        ];
      }
      return [{ type: 'text_delta', text: 'orchestration complete' }, end('end')];
    });
    const loop = new AgentLoop({
      gateway: gw,
      events: store,
      projectId: 'p1',
      projectRoot: root,
      model: 'mock/echo',
    });
    const outcome = await loop.run(makeGoal('do a thing via a subagent'), 'orchestrator');

    assert.equal(outcome.result.status, 'success');
    assert.equal(outcome.finalText, 'orchestration complete');

    const starts = events.filter((e) => e.kind === 'task.start');
    const ends = events.filter((e) => e.kind === 'task.end');
    assert.equal(starts.length, 1);
    assert.equal(ends.length, 1);
    const envelope = ends[0]!.payload as ResultEnvelope;
    assert.equal(envelope.status, 'success');
    assert.equal(envelope.taskId, ends[0]!.taskId);

    // Subagent's final text came back as the tool result.
    const orchSecond = gw.requests.find(
      (r, i) => r.meta.agentRole === 'orchestrator' && i > 0,
    );
    assert.ok(orchSecond);
    const toolMsg = orchSecond.messages[orchSecond.messages.length - 1];
    assert.ok(toolMsg && toolMsg.role === 'tool');
    const part = toolMsg.content[0];
    assert.ok(part && part.type === 'tool_result');
    assert.equal(part.content, 'sub finished: wrote a.txt');

    // Depth guard: the subagent must not be offered spawn_subagent.
    const coderReq = gw.requests.find((r) => r.meta.agentRole === 'coder');
    assert.ok(coderReq);
    assert.ok(!(coderReq.tools ?? []).some((t) => t.name === 'spawn_subagent'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tool rejection (path escape) is returned to the model as an error result; loop continues', async () => {
  const root = await makeRoot();
  try {
    const { store } = stubEvents();
    const gw = scriptedGateway((_req, call) => {
      if (call === 1) {
        return [
          {
            type: 'tool_call',
            id: 'bad1',
            name: 'write_file',
            args: { path: '../x', content: 'escape!' },
          },
          end('tool_calls'),
        ];
      }
      return [{ type: 'text_delta', text: 'recovered' }, end('end')];
    });
    const loop = new AgentLoop({
      gateway: gw,
      events: store,
      projectId: 'p1',
      projectRoot: root,
      model: 'mock/echo',
    });
    const outcome = await loop.run(makeGoal('try to escape'), 'coder');

    assert.equal(outcome.result.status, 'success');
    const second = gw.requests[1];
    assert.ok(second);
    const toolMsg = second.messages[second.messages.length - 1];
    assert.ok(toolMsg && toolMsg.role === 'tool');
    const part = toolMsg.content[0];
    assert.ok(part && part.type === 'tool_result');
    assert.equal(part.isError, true);
    assert.match(part.content, /escapes the project root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('iteration budget guard stops with status partial', async () => {
  const root = await makeRoot();
  try {
    const { store } = stubEvents();
    const looper: RoleDef = {
      name: 'looper',
      systemPrompt: 'loop forever',
      tools: ['list_dir'],
      maxIterations: 2,
    };
    const gw = scriptedGateway((_req, call) => [
      { type: 'tool_call', id: `c${call}`, name: 'list_dir', args: { path: '.' } },
      end('tool_calls'),
    ]);
    const loop = new AgentLoop({
      gateway: gw,
      events: store,
      projectId: 'p1',
      projectRoot: root,
      model: 'mock/echo',
      roles: { ...builtinRoles, looper },
    });
    const outcome = await loop.run(makeGoal('never finish'), 'looper');

    assert.equal(outcome.result.status, 'partial');
    assert.match(outcome.result.summary, /maxIterations=2/);
    assert.equal(gw.requests.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('LLM error yields status failed with failureClass model', async () => {
  const root = await makeRoot();
  try {
    const { store } = stubEvents();
    const gw = scriptedGateway(() => [end('error', 'provider exploded')]);
    const loop = new AgentLoop({
      gateway: gw,
      events: store,
      projectId: 'p1',
      projectRoot: root,
      model: 'mock/echo',
    });
    const outcome = await loop.run(makeGoal('anything'), 'coder');

    assert.equal(outcome.result.status, 'failed');
    assert.equal(outcome.result.failureClass, 'model');
    assert.match(outcome.result.summary, /provider exploded/);
    assert.equal(outcome.goal.status, 'failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
