import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { computeAnalytics, costSeries } from './analytics.js';
import { SqliteEventStore } from './events.js';
import { uuidv7 } from './ids.js';

/** Seed a representative slice of the Phase 1 event spine for one project. */
function seed(store: SqliteEventStore): void {
  // Two goals reach a terminal state, one is still running.
  store.append({ projectId: 'p1', kind: 'goal.created', payload: { goalId: 'g1', prompt: 'a' } });
  store.append({ projectId: 'p1', kind: 'goal.created', payload: { goalId: 'g2', prompt: 'b' } });
  store.append({ projectId: 'p1', kind: 'goal.created', payload: { goalId: 'g3', prompt: 'c' } });
  store.append({ projectId: 'p1', kind: 'goal.done', payload: { goalId: 'g1' } });
  store.append({ projectId: 'p1', kind: 'goal.failed', payload: { goalId: 'g2', error: 'boom' } });

  // llm.call across two models, mirroring gateway's payload shape.
  store.append({
    projectId: 'p1',
    kind: 'llm.call',
    taskId: 't1',
    payload: {
      callId: 'c1',
      model: 'anthropic/claude-sonnet-4-6',
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
      stopReason: 'end',
      durationMs: 200,
    },
  });
  store.append({
    projectId: 'p1',
    kind: 'llm.call',
    taskId: 't1',
    payload: {
      callId: 'c2',
      model: 'anthropic/claude-sonnet-4-6',
      usage: { inputTokens: 200, outputTokens: 100, costUsd: 0.02 },
      stopReason: 'end',
      durationMs: 300,
    },
  });
  store.append({
    projectId: 'p1',
    kind: 'llm.call',
    payload: {
      callId: 'c3',
      model: 'deepseek/deepseek-chat',
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0001 },
      stopReason: 'end',
    },
  });
  // A robustness case: missing usage fields must be treated as 0.
  store.append({
    projectId: 'p1',
    kind: 'llm.call',
    payload: { callId: 'c4', model: 'deepseek/deepseek-chat' },
  });

  // tool.call: two succeed, one fails via ok:false, one fails via error field.
  store.append({ projectId: 'p1', kind: 'tool.call', payload: { name: 'list_dir', ok: true, durationMs: 5 } });
  store.append({ projectId: 'p1', kind: 'tool.call', payload: { name: 'read_file', ok: true, durationMs: 7 } });
  store.append({ projectId: 'p1', kind: 'tool.call', payload: { name: 'run_bash', ok: false, durationMs: 9 } });
  store.append({ projectId: 'p1', kind: 'tool.call', payload: { name: 'web_fetch', error: 'timeout' } });

  // Noise from another project must be ignored.
  store.append({ projectId: 'other', kind: 'goal.created', payload: { goalId: 'x1' } });
  store.append({
    projectId: 'other',
    kind: 'llm.call',
    payload: { model: 'm', usage: { inputTokens: 999, outputTokens: 999, costUsd: 9.99 } },
  });
}

test('computeAnalytics rolls up goal counts, including running goals', () => {
  const store = new SqliteEventStore(':memory:');
  seed(store);
  const a = computeAnalytics(store, 'p1');
  assert.deepEqual(a.goals, { total: 3, done: 1, failed: 1, running: 1 });
  assert.equal(a.projectId, 'p1');
  store.close();
});

test('computeAnalytics sums llm usage and groups byModel', () => {
  const store = new SqliteEventStore(':memory:');
  seed(store);
  const a = computeAnalytics(store, 'p1');

  // 4 llm.call events for p1; the 'other' project is excluded.
  assert.equal(a.llm.calls, 4);
  assert.equal(a.llm.inputTokens, 100 + 200 + 10 + 0);
  assert.equal(a.llm.outputTokens, 50 + 100 + 5 + 0);
  assert.ok(Math.abs(a.llm.costUsd - (0.01 + 0.02 + 0.0001)) < 1e-9);

  // byModel: anthropic aggregated across two calls, deepseek across two.
  assert.equal(a.byModel.length, 2);
  const anthropic = a.byModel.find((r) => r.model === 'anthropic/claude-sonnet-4-6');
  const deepseek = a.byModel.find((r) => r.model === 'deepseek/deepseek-chat');
  assert.ok(anthropic && deepseek);
  assert.equal(anthropic.calls, 2);
  assert.equal(anthropic.inputTokens, 300);
  assert.equal(anthropic.outputTokens, 150);
  assert.ok(Math.abs(anthropic.costUsd - 0.03) < 1e-9);
  assert.equal(deepseek.calls, 2);
  assert.equal(deepseek.inputTokens, 10);
  store.close();
});

test('computeAnalytics counts tool calls and failures (ok:false or error field)', () => {
  const store = new SqliteEventStore(':memory:');
  seed(store);
  const a = computeAnalytics(store, 'p1');
  assert.deepEqual(a.tools, { calls: 4, failures: 2 });
  store.close();
});

test('computeAnalytics defaults since to epoch and honors a since lower bound', () => {
  const store = new SqliteEventStore(':memory:');
  seed(store);
  const def = computeAnalytics(store, 'p1');
  assert.equal(def.since, '1970-01-01T00:00:00.000Z');

  // A future since excludes everything (all seeded events are in the past).
  const future = computeAnalytics(store, 'p1', '2999-01-01T00:00:00.000Z');
  assert.deepEqual(future.goals, { total: 0, done: 0, failed: 0, running: 0 });
  assert.equal(future.llm.calls, 0);
  assert.equal(future.tools.calls, 0);
  store.close();
});

test('costSeries buckets llm spend by hour and by day, ascending', () => {
  // Craft explicit timestamps via a direct db write so bucketing is testable
  // (SqliteEventStore stamps ts with now, which would collapse into one bucket).
  const root = mkdtempSync(join(tmpdir(), 'lunaris-analytics-test-'));
  const dbPath = join(root, 'events.db');
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE events (
        event_id TEXT PRIMARY KEY, ts TEXT NOT NULL, project_id TEXT NOT NULL,
        kind TEXT NOT NULL, task_id TEXT, agent_id TEXT, payload TEXT NOT NULL
      );
    `);
    const insert = db.prepare(
      `INSERT INTO events (event_id, ts, project_id, kind, task_id, agent_id, payload)
       VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
    );
    const rows: Array<[string, string, number]> = [
      // [ts, model, cost]
      ['2026-06-10T08:15:00.000Z', 'm1', 0.01],
      ['2026-06-10T08:45:00.000Z', 'm1', 0.02],
      ['2026-06-10T09:05:00.000Z', 'm1', 0.04],
      ['2026-06-11T10:00:00.000Z', 'm1', 0.08],
    ];
    for (const [ts, model, cost] of rows) {
      insert.run(uuidv7(), ts, 'p1', 'llm.call', JSON.stringify({ model, usage: { costUsd: cost } }));
    }
    // A non-llm event must not appear in the series.
    insert.run(uuidv7(), '2026-06-10T08:30:00.000Z', 'p1', 'tool.call', JSON.stringify({ ok: true }));
    db.close();

    const byHour = costSeries(dbPath, 'p1', 'hour');
    assert.deepEqual(
      byHour.map((b) => b.bucket),
      ['2026-06-10T08', '2026-06-10T09', '2026-06-11T10'],
    );
    assert.equal(byHour[0]?.calls, 2);
    assert.ok(Math.abs((byHour[0]?.costUsd ?? 0) - 0.03) < 1e-9);

    const byDay = costSeries(dbPath, 'p1', 'day');
    assert.deepEqual(
      byDay.map((b) => b.bucket),
      ['2026-06-10', '2026-06-11'],
    );
    assert.equal(byDay[0]?.calls, 3);
    assert.ok(Math.abs((byDay[0]?.costUsd ?? 0) - 0.07) < 1e-9);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('computeAnalytics works against a db path (read-only SQL path)', () => {
  const root = mkdtempSync(join(tmpdir(), 'lunaris-analytics-path-'));
  const dbPath = join(root, 'events.db');
  try {
    const store = new SqliteEventStore(dbPath);
    seed(store);
    store.close();

    const a = computeAnalytics(dbPath, 'p1');
    assert.deepEqual(a.goals, { total: 3, done: 1, failed: 1, running: 1 });
    assert.equal(a.llm.calls, 4);
    assert.deepEqual(a.tools, { calls: 4, failures: 2 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
