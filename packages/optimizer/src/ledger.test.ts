import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteEventStore } from '@lunaris/core';
import type { EventStore, ResultEnvelope } from '@lunaris/core';
import { RoutingBandit } from './bandit.js';
import { classifyTask, deriveOutcomes } from './ledger.js';
import { computeStatsResult } from './stats.js';

test('classifyTask maps roles to coarse classes with a prompt fallback', () => {
  assert.equal(classifyTask('coder'), 'code');
  assert.equal(classifyTask('researcher'), 'research');
  assert.equal(classifyTask('tester'), 'test');
  assert.equal(classifyTask('orchestrator'), 'orchestration');
  assert.equal(classifyTask('something-else'), 'general');
  assert.equal(classifyTask(undefined, 'please implement this function'), 'code');
  assert.equal(classifyTask('', 'investigate the options'), 'research');
});

/** Seed a top-level goal: created -> llm.call(s) on taskId===goalId -> done. */
function seedGoal(
  store: EventStore,
  projectId: string,
  goalId: string,
  opts: {
    role: string;
    model: string;
    prompt: string;
    result: ResultEnvelope;
    cost: number;
    inTok: number;
    outTok: number;
  },
): void {
  store.append({
    projectId,
    kind: 'goal.created',
    payload: { goalId, projectId, prompt: opts.prompt, createdAt: new Date().toISOString(), status: 'running' },
  });
  store.append({
    projectId,
    kind: 'llm.call',
    taskId: goalId,
    agentId: opts.role,
    payload: {
      callId: `${goalId}-c1`,
      model: opts.model,
      usage: { inputTokens: opts.inTok, outputTokens: opts.outTok, costUsd: opts.cost },
      durationMs: 1200,
      stopReason: 'end',
    },
  });
  store.append({
    projectId,
    kind: 'tool.call',
    taskId: goalId,
    agentId: opts.role,
    payload: { name: 'read_file', args: {}, durationMs: 5, ok: true },
  });
  store.append({
    projectId,
    kind: 'goal.done',
    payload: { goalId, result: opts.result },
  });
}

test('deriveOutcomes reconstructs one outcome per goal, joining llm.call usage', () => {
  const store = new SqliteEventStore(':memory:');
  seedGoal(store, 'p1', 'g1', {
    role: 'coder',
    model: 'mock/echo',
    prompt: 'fix the bug',
    result: { taskId: 'g1', status: 'success', summary: 'done' },
    cost: 0.03,
    inTok: 100,
    outTok: 40,
  });

  const outcomes = deriveOutcomes(store, 'p1');
  assert.equal(outcomes.length, 1);
  const o = outcomes[0];
  assert.equal(o?.taskId, 'g1');
  assert.equal(o?.taskClass, 'code');
  assert.equal(o?.role, 'coder');
  assert.equal(o?.model, 'mock/echo');
  assert.equal(o?.status, 'success');
  assert.equal(o?.costUsd, 0.03);
  assert.equal(o?.tokensIn, 100);
  assert.equal(o?.tokensOut, 40);
  assert.equal(o?.failureClass, undefined);
  store.close();
});

test('deriveOutcomes reads status + failureClass from terminal envelopes', () => {
  const store = new SqliteEventStore(':memory:');
  // A failed goal whose ResultEnvelope carries a model failureClass.
  seedGoal(store, 'p1', 'g-fail', {
    role: 'coder',
    model: 'mock/echo',
    prompt: 'do the thing',
    result: { taskId: 'g-fail', status: 'failed', summary: 'nope', failureClass: 'model' },
    cost: 0.01,
    inTok: 10,
    outTok: 5,
  });
  // A subagent task via task.start/task.end carrying its own taskId.
  store.append({ projectId: 'p1', kind: 'task.start', taskId: 'sub1', agentId: 'researcher', payload: { role: 'researcher', task: 'look it up' } });
  store.append({
    projectId: 'p1',
    kind: 'llm.call',
    taskId: 'sub1',
    agentId: 'researcher',
    payload: { callId: 's1', model: 'mock/big', usage: { inputTokens: 50, outputTokens: 20, costUsd: 0.02 }, durationMs: 800, stopReason: 'end' },
  });
  store.append({ projectId: 'p1', kind: 'task.end', taskId: 'sub1', agentId: 'researcher', payload: { taskId: 'sub1', status: 'partial', summary: 'meh' } });

  const outcomes = deriveOutcomes(store, 'p1');
  const fail = outcomes.find((o) => o.taskId === 'g-fail');
  assert.equal(fail?.status, 'failed');
  assert.equal(fail?.failureClass, 'model');

  const sub = outcomes.find((o) => o.taskId === 'sub1');
  assert.equal(sub?.status, 'partial');
  assert.equal(sub?.taskClass, 'research');
  assert.equal(sub?.role, 'researcher');
  assert.equal(sub?.model, 'mock/big');
  assert.equal(sub?.costUsd, 0.02);
  store.close();
});

test('FIX 1: a goal.failed with no failureClass is a model failure — counted in stats AND fed to the bandit', () => {
  const store = new SqliteEventStore(':memory:');
  // Mirrors the daemon /goals + queue runner: goal.failed carries {goalId, error}
  // and NO failureClass. This must NOT be reconstructed as infra.
  store.append({
    projectId: 'p1',
    kind: 'goal.created',
    payload: { goalId: 'g-thrown', projectId: 'p1', prompt: 'do the risky thing', status: 'running' },
  });
  store.append({
    projectId: 'p1',
    kind: 'llm.call',
    taskId: 'g-thrown',
    agentId: 'coder',
    payload: {
      callId: 'g-thrown-c1',
      model: 'mock/echo',
      usage: { inputTokens: 20, outputTokens: 8, costUsd: 0.01 },
      durationMs: 900,
      stopReason: 'end',
    },
  });
  store.append({
    projectId: 'p1',
    kind: 'goal.failed',
    payload: { goalId: 'g-thrown', error: 'boom' },
  });

  const outcomes = deriveOutcomes(store, 'p1');
  const o = outcomes.find((x) => x.taskId === 'g-thrown');
  assert.ok(o, 'outcome reconstructed');
  assert.equal(o?.status, 'failed');
  assert.equal(o?.failureClass, 'model', 'classless goal.failed defaults to model, not infra');

  // It IS counted in computeStats (infra would be excluded).
  const { stats, infraExcluded } = computeStatsResult(outcomes);
  assert.equal(infraExcluded, 0, 'a model failure is not infra-excluded');
  const code = stats.find((s) => s.taskClass === 'code');
  assert.equal(code?.n, 1, 'the failed goal is counted in the group');
  assert.equal(code?.successes, 0);

  // It DOES feed the bandit: rewardOf returns a number (0 for a model failure),
  // not null (which infra would yield and observe() would skip).
  const bandit = new RoutingBandit({ dbPath: ':memory:', projectId: 'p1' });
  assert.equal(bandit.rewardOf(o!), 0, 'model failure yields reward 0, not null');
  bandit.close();
  store.close();
});

test('FIX 1: an explicit failureClass:infra on goal.failed is still honored as infra', () => {
  const store = new SqliteEventStore(':memory:');
  store.append({
    projectId: 'p1',
    kind: 'goal.created',
    payload: { goalId: 'g-infra', projectId: 'p1', prompt: 'x', status: 'running' },
  });
  store.append({
    projectId: 'p1',
    kind: 'goal.failed',
    payload: { goalId: 'g-infra', error: 'rate limited', failureClass: 'infra' },
  });
  const outcomes = deriveOutcomes(store, 'p1');
  const o = outcomes.find((x) => x.taskId === 'g-infra');
  assert.equal(o?.failureClass, 'infra', 'explicit infra is preserved');
  store.close();
});

export { seedGoal };
