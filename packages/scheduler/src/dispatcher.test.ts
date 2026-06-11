import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QueuedGoal } from '@lunaris/core';
import { Dispatcher, type RunResult } from './dispatcher.js';
import { SqliteGoalQueue } from './queue.js';

test('drainOnce completes successful goals and records goalId', async () => {
  const q = new SqliteGoalQueue(':memory:');
  const g = q.push({ projectId: 'p', prompt: 'x', source: 'cli' });
  const d = new Dispatcher({
    queue: q,
    concurrency: 2,
    runGoal: async (goal: QueuedGoal): Promise<RunResult> => ({
      goalId: `run-${goal.id}`,
      status: 'success',
    }),
  });
  const n = await d.drainOnce();
  assert.equal(n, 1);
  const after = q.get(g.id);
  assert.equal(after?.status, 'done');
  assert.equal(after?.goalId, `run-${g.id}`);
  q.close();
});

test('drainOnce honors the concurrency limit', async () => {
  const q = new SqliteGoalQueue(':memory:');
  for (let i = 0; i < 5; i++) q.push({ projectId: 'p', prompt: `g${i}`, source: 'cli' });

  let inFlight = 0;
  let maxInFlight = 0;
  const d = new Dispatcher({
    queue: q,
    concurrency: 2,
    runGoal: async (goal: QueuedGoal): Promise<RunResult> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { goalId: goal.id, status: 'success' };
    },
  });

  const n = await d.drainOnce();
  assert.equal(n, 2); // only 2 leased this pass
  assert.equal(maxInFlight, 2);
  assert.equal(q.list('p', 'queued').length, 3); // remaining still queued
  q.close();
});

test('drainOnce survives a throwing runGoal and fails that goal only', async () => {
  const q = new SqliteGoalQueue(':memory:');
  const bad = q.push({ projectId: 'p', prompt: 'bad', priority: 10, source: 'cli', maxAttempts: 1 });
  const good = q.push({ projectId: 'p', prompt: 'good', priority: 5, source: 'cli' });

  const d = new Dispatcher({
    queue: q,
    concurrency: 2,
    runGoal: async (goal: QueuedGoal): Promise<RunResult> => {
      if (goal.id === bad.id) throw new Error('kaboom');
      return { goalId: `run-${goal.id}`, status: 'success' };
    },
  });

  const n = await d.drainOnce();
  assert.equal(n, 2);
  assert.equal(q.get(bad.id)?.status, 'dead'); // maxAttempts 1 → dead
  assert.equal(q.get(bad.id)?.lastError, 'kaboom');
  assert.equal(q.get(good.id)?.status, 'done'); // sibling unaffected
  q.close();
});

test('non-success status is treated as a failure (and retried when allowed)', async () => {
  const q = new SqliteGoalQueue(':memory:');
  const g = q.push({ projectId: 'p', prompt: 'x', source: 'cli', maxAttempts: 2 });
  const d = new Dispatcher({
    queue: q,
    runGoal: async (goal: QueuedGoal): Promise<RunResult> => ({
      goalId: goal.id,
      status: 'failed',
    }),
    retryOnFailure: true,
  });
  await d.drainOnce();
  // attempt 1 failed → retried back to queued
  assert.equal(q.get(g.id)?.status, 'queued');
  await d.drainOnce();
  // attempt 2 == maxAttempts → dead
  assert.equal(q.get(g.id)?.status, 'dead');
  q.close();
});

test('drainOnce returns 0 when nothing is eligible', async () => {
  const q = new SqliteGoalQueue(':memory:');
  const d = new Dispatcher({
    queue: q,
    runGoal: async () => ({ goalId: 'x', status: 'success' as const }),
  });
  assert.equal(await d.drainOnce(), 0);
  q.close();
});

test('start/stop drive periodic draining without leaking the timer', async () => {
  const q = new SqliteGoalQueue(':memory:');
  q.push({ projectId: 'p', prompt: 'x', source: 'cli' });
  let ran = 0;
  const d = new Dispatcher({
    queue: q,
    runGoal: async (goal: QueuedGoal): Promise<RunResult> => {
      ran++;
      return { goalId: goal.id, status: 'success' };
    },
  });
  d.start(5);
  await new Promise((r) => setTimeout(r, 40));
  d.stop();
  assert.ok(ran >= 1);
  q.close();
});
