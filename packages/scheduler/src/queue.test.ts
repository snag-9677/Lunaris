import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteGoalQueue } from './queue.js';

function fixedClock(start = new Date('2026-06-11T00:00:00.000Z')) {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
    set: (d: Date) => {
      t = d.getTime();
    },
  };
}

test('push applies defaults: priority 0, maxAttempts 1, status queued', () => {
  const q = new SqliteGoalQueue(':memory:');
  const g = q.push({ projectId: 'p', prompt: 'do it', source: 'cli' });
  assert.equal(g.priority, 0);
  assert.equal(g.maxAttempts, 1);
  assert.equal(g.status, 'queued');
  assert.equal(g.attempts, 0);
  assert.ok(g.id.length > 0);
  assert.ok(g.createdAt.length > 0);
  q.close();
});

test('lease honors priority then age (oldest first)', () => {
  const q = new SqliteGoalQueue(':memory:');
  const low = q.push({ projectId: 'p', prompt: 'low', priority: 0, source: 'cli' });
  const highA = q.push({ projectId: 'p', prompt: 'highA', priority: 5, source: 'cli' });
  const highB = q.push({ projectId: 'p', prompt: 'highB', priority: 5, source: 'cli' });

  const first = q.lease();
  assert.equal(first?.id, highA.id); // higher priority, older of the two
  const second = q.lease();
  assert.equal(second?.id, highB.id);
  const third = q.lease();
  assert.equal(third?.id, low.id);
  assert.equal(q.lease(), null);
  q.close();
});

test('lease respects notBefore', () => {
  const clock = fixedClock();
  const q = new SqliteGoalQueue(':memory:', { now: clock.now });
  const future = new Date(clock.now().getTime() + 60_000).toISOString();
  q.push({ projectId: 'p', prompt: 'later', source: 'schedule:1', notBefore: future });
  assert.equal(q.lease(), null); // not yet eligible
  clock.advance(61_000);
  const leased = q.lease(clock.now());
  assert.ok(leased);
  assert.equal(leased?.status, 'leased');
  assert.equal(leased?.attempts, 1);
  q.close();
});

test('lease is atomic: same row never leased twice', () => {
  const q = new SqliteGoalQueue(':memory:');
  q.push({ projectId: 'p', prompt: 'only', source: 'cli' });
  const a = q.lease();
  const b = q.lease();
  assert.ok(a);
  assert.equal(b, null); // second lease finds nothing eligible
  q.close();
});

test('complete marks done and stores goalId', () => {
  const q = new SqliteGoalQueue(':memory:');
  const g = q.push({ projectId: 'p', prompt: 'x', source: 'cli' });
  q.lease();
  q.complete(g.id, 'run-123');
  const got = q.get(g.id);
  assert.equal(got?.status, 'done');
  assert.equal(got?.goalId, 'run-123');
  q.close();
});

test('fail retries while attempts remain, then goes dead', () => {
  const q = new SqliteGoalQueue(':memory:');
  const g = q.push({ projectId: 'p', prompt: 'flaky', source: 'cli', maxAttempts: 2 });

  // attempt 1
  let leased = q.lease();
  assert.equal(leased?.attempts, 1);
  q.fail(g.id, true, 'boom1');
  let after = q.get(g.id);
  assert.equal(after?.status, 'queued'); // retried
  assert.equal(after?.lastError, 'boom1');

  // attempt 2 (== maxAttempts) → next fail must be dead
  leased = q.lease();
  assert.equal(leased?.attempts, 2);
  q.fail(g.id, true, 'boom2');
  after = q.get(g.id);
  assert.equal(after?.status, 'dead');
  assert.equal(after?.lastError, 'boom2');
  q.close();
});

test('fail with retry=false goes straight to dead', () => {
  const q = new SqliteGoalQueue(':memory:');
  const g = q.push({ projectId: 'p', prompt: 'x', source: 'cli', maxAttempts: 5 });
  q.lease();
  q.fail(g.id, false, 'fatal');
  assert.equal(q.get(g.id)?.status, 'dead');
  q.close();
});

test('retry backoff sets notBefore in the future', () => {
  const clock = fixedClock();
  const q = new SqliteGoalQueue(':memory:', { now: clock.now, retryBackoffMs: 30_000 });
  const g = q.push({ projectId: 'p', prompt: 'x', source: 'cli', maxAttempts: 2 });
  q.lease(clock.now());
  q.fail(g.id, true, 'retry me');
  const after = q.get(g.id);
  assert.equal(after?.status, 'queued');
  assert.ok(after?.notBefore);
  // Not eligible immediately, eligible after backoff elapses.
  assert.equal(q.lease(clock.now()), null);
  clock.advance(30_001);
  assert.ok(q.lease(clock.now()));
  q.close();
});

test('list filters by project and status', () => {
  const q = new SqliteGoalQueue(':memory:');
  q.push({ projectId: 'a', prompt: '1', source: 'cli' });
  q.push({ projectId: 'b', prompt: '2', source: 'cli' });
  const gb2 = q.push({ projectId: 'b', prompt: '3', source: 'cli' });
  q.lease(); // leases highest/oldest across all → project a's
  assert.equal(q.list('b').length, 2);
  assert.equal(q.list('b', 'queued').length, 2);
  assert.equal(q.list(undefined, 'leased').length, 1);
  assert.ok(gb2);
  q.close();
});
