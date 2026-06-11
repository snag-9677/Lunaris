import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteEventStore } from './events.js';
import type { EventEnvelope } from './types.js';

test('append assigns eventId + ISO ts and persists the payload', () => {
  const store = new SqliteEventStore(':memory:');
  const appended = store.append({
    projectId: 'p1',
    kind: 'llm.call',
    taskId: 't1',
    agentId: 'a1',
    payload: { model: 'mock/echo', n: 1 },
  });

  assert.match(
    appended.eventId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(new Date(appended.ts).toISOString(), appended.ts, 'ts is ISO 8601');

  const [got] = store.query({ projectId: 'p1' });
  assert.ok(got);
  assert.deepEqual(got, appended);
  store.close();
});

test('query filters by projectId/kind, applies limit, newest first', () => {
  const store = new SqliteEventStore(':memory:');
  for (let i = 0; i < 5; i++) {
    store.append({ projectId: 'p1', kind: 'task.start', payload: { i } });
  }
  store.append({ projectId: 'p1', kind: 'task.end', payload: { i: 99 } });
  store.append({ projectId: 'p2', kind: 'task.start', payload: { i: -1 } });

  const all = store.query({});
  assert.equal(all.length, 7);

  const p1Starts = store.query({ projectId: 'p1', kind: 'task.start' });
  assert.equal(p1Starts.length, 5);
  assert.deepEqual(
    p1Starts.map((e) => (e.payload as { i: number }).i),
    [4, 3, 2, 1, 0],
    'newest first',
  );

  const limited = store.query({ projectId: 'p1', kind: 'task.start', limit: 2 });
  assert.deepEqual(
    limited.map((e) => (e.payload as { i: number }).i),
    [4, 3],
  );

  const ids = all.map((e) => e.eventId);
  assert.deepEqual(ids, [...ids].sort().reverse(), 'uuidv7 ids are time-ordered');
  store.close();
});

test('subscribe notifies on append; unsubscribe stops notifications', () => {
  const store = new SqliteEventStore(':memory:');
  const seen: EventEnvelope[] = [];
  const unsubscribe = store.subscribe((e) => seen.push(e));
  // A throwing subscriber must not break append or other subscribers.
  store.subscribe(() => {
    throw new Error('boom');
  });

  const first = store.append({ projectId: 'p1', kind: 'chat.message', payload: 'hi' });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], first);

  unsubscribe();
  store.append({ projectId: 'p1', kind: 'chat.message', payload: 'bye' });
  assert.equal(seen.length, 1, 'no notification after unsubscribe');
  store.close();
});

test('file-backed store creates parent dirs and survives reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'lunaris-events-test-'));
  const dbPath = join(root, 'nested', 'deeper', 'events.db');
  try {
    const store = new SqliteEventStore(dbPath);
    store.append({ projectId: 'p1', kind: 'goal.created', payload: { prompt: 'do it' } });
    store.close();
    assert.ok(existsSync(dbPath));

    const reopened = new SqliteEventStore(dbPath);
    const events = reopened.query({ projectId: 'p1' });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'goal.created');
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
