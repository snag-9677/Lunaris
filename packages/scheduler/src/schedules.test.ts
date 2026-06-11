import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteScheduleStore } from './schedules.js';
import { SqliteTemplateStore } from './templates.js';

function clockAt(d: Date) {
  let t = d.getTime();
  return {
    now: () => new Date(t),
    set: (n: Date) => {
      t = n.getTime();
    },
  };
}

test('create computes nextRunAt from cron', () => {
  const clock = clockAt(new Date(2026, 5, 11, 10, 0, 0));
  const store = new SqliteScheduleStore(':memory:', { now: clock.now });
  const s = store.create({ projectId: 'p', cron: '0 * * * *', prompt: 'hourly' });
  assert.ok(s.nextRunAt);
  // Next top-of-hour after 10:00 is 11:00 local.
  assert.equal(new Date(s.nextRunAt!).getHours(), 11);
  store.close();
});

test('dueSchedules returns only enabled schedules whose nextRunAt arrived', () => {
  const clock = clockAt(new Date(2026, 5, 11, 10, 0, 0));
  const store = new SqliteScheduleStore(':memory:', { now: clock.now });
  const s = store.create({ projectId: 'p', cron: '0 * * * *', prompt: 'hourly' });
  store.create({ projectId: 'p', cron: '0 * * * *', prompt: 'disabled', enabled: false });

  // Before nextRunAt → nothing due.
  assert.equal(store.dueSchedules(clock.now()).length, 0);

  // Advance past nextRunAt.
  clock.set(new Date(s.nextRunAt!));
  const due = store.dueSchedules(clock.now());
  assert.equal(due.length, 1);
  assert.equal(due[0]?.id, s.id);
  store.close();
});

test('markFired updates lastRunAt and advances nextRunAt', () => {
  const clock = clockAt(new Date(2026, 5, 11, 10, 0, 0));
  const store = new SqliteScheduleStore(':memory:', { now: clock.now });
  const s = store.create({ projectId: 'p', cron: '0 * * * *', prompt: 'hourly' });
  const fireTime = new Date(s.nextRunAt!);

  const updated = store.markFired(s.id, fireTime);
  assert.equal(updated?.lastRunAt, fireTime.toISOString());
  // nextRunAt must move strictly forward.
  assert.ok(new Date(updated!.nextRunAt!).getTime() > fireTime.getTime());
  assert.equal(new Date(updated!.nextRunAt!).getHours(), fireTime.getHours() + 1);
  store.close();
});

test('tick renders template, enqueues with schedule:<id> source, and advances', () => {
  const clock = clockAt(new Date(2026, 5, 11, 10, 0, 0));
  const templates = new SqliteTemplateStore(':memory:');
  const tpl = templates.create({ name: 't', promptTemplate: 'Report for {{project}}' });
  const store = new SqliteScheduleStore(':memory:', { now: clock.now, templates });
  const s = store.create({
    projectId: 'proj-x',
    cron: '0 * * * *',
    templateId: tpl.id,
    vars: { project: 'proj-x' },
  });

  const calls: Array<{ projectId: string; prompt: string; source: string }> = [];
  const fireTime = new Date(s.nextRunAt!);
  const fired = store.tick(fireTime, (projectId, prompt, source) =>
    calls.push({ projectId, prompt, source }),
  );

  assert.equal(fired, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.prompt, 'Report for proj-x');
  assert.equal(calls[0]?.source, `schedule:${s.id}`);
  // Advanced, so a second tick at the same instant fires nothing.
  assert.equal(store.tick(fireTime, () => calls.push({ projectId: '', prompt: '', source: '' })), 0);
  store.close();
  templates.close();
});

test('inline prompt schedule renders without a template store', () => {
  const clock = clockAt(new Date(2026, 5, 11, 10, 0, 0));
  const store = new SqliteScheduleStore(':memory:', { now: clock.now });
  const s = store.create({ projectId: 'p', cron: '0 * * * *', prompt: 'hi {{who}}', vars: { who: 'bob' } });
  const calls: string[] = [];
  store.tick(new Date(s.nextRunAt!), (_p, prompt) => calls.push(prompt));
  assert.deepEqual(calls, ['hi bob']);
  store.close();
});

test('FIX 2: tick isolates a failing enqueue — other due schedules still fire + advance', () => {
  const clock = clockAt(new Date(2026, 5, 11, 10, 0, 0));
  const store = new SqliteScheduleStore(':memory:', { now: clock.now });
  // Three schedules that all come due at the same instant.
  const s1 = store.create({ projectId: 'p', cron: '0 * * * *', prompt: 'first' });
  const s2 = store.create({ projectId: 'p', cron: '0 * * * *', prompt: 'boom' });
  const s3 = store.create({ projectId: 'p', cron: '0 * * * *', prompt: 'third' });
  const fireTime = new Date(s1.nextRunAt!);

  const enqueued: string[] = [];
  const fired = store.tick(fireTime, (_p, prompt) => {
    if (prompt === 'boom') throw new Error('enqueue exploded');
    enqueued.push(prompt);
  });

  // The throw must not abort the batch: the two healthy schedules enqueued.
  assert.equal(fired, 2);
  assert.deepEqual(enqueued.sort(), ['first', 'third']);

  // The two that succeeded were marked fired (nextRunAt advanced past fireTime).
  assert.ok(new Date(store.get(s1.id)!.nextRunAt!).getTime() > fireTime.getTime());
  assert.ok(new Date(store.get(s3.id)!.nextRunAt!).getTime() > fireTime.getTime());
  // The failing one was NOT marked fired, so it remains due and can retry.
  assert.equal(store.get(s2.id)?.nextRunAt, s2.nextRunAt);
  assert.equal(store.dueSchedules(fireTime).some((s) => s.id === s2.id), true);
  store.close();
});

test('update with new cron recomputes nextRunAt', () => {
  const clock = clockAt(new Date(2026, 5, 11, 10, 0, 0));
  const store = new SqliteScheduleStore(':memory:', { now: clock.now });
  const s = store.create({ projectId: 'p', cron: '0 * * * *', prompt: 'x' });
  const updated = store.update(s.id, { cron: '0 0 * * *' });
  // Daily at midnight → next is tomorrow 00:00.
  assert.equal(new Date(updated!.nextRunAt!).getHours(), 0);
  assert.equal(new Date(updated!.nextRunAt!).getDate(), 12);
  store.close();
});
