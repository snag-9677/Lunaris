import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteEventStore } from '@lunaris/core';
import type { EventStore, ResultEnvelope } from '@lunaris/core';
import { runOptimizer } from './optimizer.js';

/** Seed a top-level goal whose root llm.call shares taskId === goalId. */
function seedGoal(
  store: EventStore,
  goalId: string,
  role: string,
  model: string,
  result: ResultEnvelope,
  costUsd: number,
): void {
  store.append({
    projectId: 'p1',
    kind: 'goal.created',
    payload: { goalId, projectId: 'p1', prompt: 'implement feature', createdAt: new Date().toISOString(), status: 'running' },
  });
  store.append({
    projectId: 'p1',
    kind: 'llm.call',
    taskId: goalId,
    agentId: role,
    payload: { callId: `${goalId}-c`, model, usage: { inputTokens: 100, outputTokens: 50, costUsd }, durationMs: 1000, stopReason: 'end' },
  });
  store.append({ projectId: 'p1', kind: 'goal.done', payload: { goalId, result } });
}

test('runOptimizer turns a seeded event spine into a routing suggestion + pending proposal', () => {
  const store = new SqliteEventStore(':memory:');

  // 12 'code' goals on a cheap reliable model (mostly success) and 12 on a
  // pricey flaky one — enough pulls to clear minN and separate the arms.
  for (let i = 0; i < 12; i++) {
    seedGoal(store, `good-${i}`, 'coder', 'mock/cheap', { taskId: `good-${i}`, status: 'success', summary: 'ok' }, 0.005);
  }
  for (let i = 0; i < 12; i++) {
    const ok = i < 4; // ~33% success
    const result: ResultEnvelope = ok
      ? { taskId: `bad-${i}`, status: 'success', summary: 'ok' }
      : { taskId: `bad-${i}`, status: 'failed', summary: 'nope', failureClass: 'model' };
    seedGoal(store, `bad-${i}`, 'coder', 'mock/pricey', result, 0.2);
  }
  // An infra failure that must be excluded from stats AND not fed to the bandit.
  seedGoal(store, 'infra-1', 'coder', 'mock/cheap', { taskId: 'infra-1', status: 'failed', summary: 'sandbox died', failureClass: 'infra' }, 0.0);

  const report = runOptimizer({
    store,
    banditDbPath: ':memory:',
    proposalDbPath: ':memory:',
    projectId: 'p1',
    now: () => new Date('2026-06-11T00:00:00.000Z'),
  });

  // Report shape
  assert.equal(report.projectId, 'p1');
  assert.equal(report.generatedAt, '2026-06-11T00:00:00.000Z');
  assert.ok(report.stats.length >= 2, 'cheap + pricey groups present');

  // Routing suggestion exists for 'code' and points at the cheap reliable model.
  const code = report.routing.find((r) => r.taskClass === 'code');
  assert.ok(code, 'code routing suggestion produced');
  assert.equal(code?.recommendedModel, 'mock/cheap');
  assert.ok((code?.basedOnN ?? 0) >= 8);

  // A pending routing proposal was persisted with a real uuidv7 id + diff.
  const routingProposal = report.proposals.find((p) => p.kind === 'routing');
  assert.ok(routingProposal, 'routing proposal persisted');
  assert.equal(routingProposal?.status, 'pending');
  assert.match(routingProposal?.id ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/);
  assert.match(routingProposal?.diff ?? '', /mock\/cheap/);

  // Infra exclusion is noted.
  assert.ok(report.notes.some((n) => /infra/i.test(n)), 'infra exclusion noted');
  assert.ok(report.notes.some((n) => /PROPOSE-ONLY/.test(n)), 'propose-only stance noted');

  store.close();
});

test('runOptimizer accumulates bandit arms across two runs sharing a db path', () => {
  const store = new SqliteEventStore(':memory:');
  for (let i = 0; i < 5; i++) {
    seedGoal(store, `g-${i}`, 'researcher', 'mock/r', { taskId: `g-${i}`, status: 'success', summary: 'ok' }, 0.01);
  }

  const run1 = runOptimizer({ store, banditDbPath: ':memory:', proposalDbPath: ':memory:', projectId: 'p1' });
  // 5 pulls < default minN(8) => no suggestion yet on a single run.
  assert.equal(run1.routing.length, 0);

  store.close();
});
