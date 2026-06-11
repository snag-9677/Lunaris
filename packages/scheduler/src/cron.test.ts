import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matches, nextRun, parseCron } from './cron.js';

test('parseCron expands lists, ranges, steps', () => {
  const p = parseCron('0,30 9-17 * * 1-5');
  assert.deepEqual(p.minute, [0, 30]);
  assert.deepEqual(p.hour, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.equal(p.domStar, true);
  assert.deepEqual(p.dow, [1, 2, 3, 4, 5]);

  const step = parseCron('*/15 * * * *');
  assert.deepEqual(step.minute, [0, 15, 30, 45]);

  const rangeStep = parseCron('0 0-12/4 * * *');
  assert.deepEqual(rangeStep.hour, [0, 4, 8, 12]);
});

test('parseCron normalizes dow 7 to 0 (Sunday)', () => {
  assert.deepEqual(parseCron('0 0 * * 7').dow, [0]);
  assert.deepEqual(parseCron('0 0 * * 0,7').dow, [0]);
});

test('parseCron rejects malformed expressions', () => {
  assert.throws(() => parseCron('* * * *')); // only 4 fields
  assert.throws(() => parseCron('60 * * * *')); // minute out of range
  assert.throws(() => parseCron('5-1 * * * *')); // inverted range
  assert.throws(() => parseCron('*/0 * * * *')); // zero step
});

test('nextRun: every-minute is the next whole minute', () => {
  const after = new Date(2026, 0, 1, 10, 0, 30); // 10:00:30 local
  const next = nextRun('* * * * *', after);
  assert.equal(next.getMinutes(), 1);
  assert.equal(next.getSeconds(), 0);
  assert.equal(next.getHours(), 10);
});

test('nextRun: step minute every 15', () => {
  const after = new Date(2026, 0, 1, 10, 7, 0);
  const next = nextRun('*/15 * * * *', after);
  assert.equal(next.getMinutes(), 15);
  assert.equal(next.getHours(), 10);
});

test('nextRun: hour range picks first eligible hour', () => {
  // Daily at minute 0, hours 9-17. After 18:30 it must roll to next day 09:00.
  const after = new Date(2026, 2, 10, 18, 30, 0);
  const next = nextRun('0 9-17 * * *', after);
  assert.equal(next.getDate(), 11);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 0);
});

test('nextRun: day-of-week selects the right weekday', () => {
  // Mondays at 09:00. 2026-06-11 is a Thursday → next Monday is 2026-06-15.
  const after = new Date(2026, 5, 11, 12, 0, 0);
  const next = nextRun('0 9 * * 1', after);
  assert.equal(next.getDay(), 1); // Monday
  assert.equal(next.getDate(), 15);
  assert.equal(next.getHours(), 9);
});

test('nextRun: month rollover (Feb 29 only in leap years)', () => {
  // Midnight on Feb 29. 2027 is not a leap year; next valid is 2028-02-29.
  const after = new Date(2026, 5, 1, 0, 0, 0);
  const next = nextRun('0 0 29 2 *', after);
  assert.equal(next.getFullYear(), 2028);
  assert.equal(next.getMonth(), 1); // February
  assert.equal(next.getDate(), 29);
});

test('nextRun: year rollover (Jan 1)', () => {
  const after = new Date(2026, 11, 31, 23, 59, 0); // Dec 31 23:59
  const next = nextRun('0 0 1 1 *', after);
  assert.equal(next.getFullYear(), 2027);
  assert.equal(next.getMonth(), 0);
  assert.equal(next.getDate(), 1);
  assert.equal(next.getHours(), 0);
});

test('nextRun: Vixie OR semantics when both dom and dow restricted', () => {
  // dom=15 OR dow=1(Mon). From 2026-06-11 (Thu) the nearest is Mon 2026-06-15.
  const after = new Date(2026, 5, 11, 0, 0, 0);
  const next = nextRun('0 0 15 * 1', after);
  // 15th is a Monday in June 2026, so both match that day.
  assert.equal(next.getDate(), 15);
});

test('nextRun: impossible expression throws within horizon', () => {
  // Feb 30 never exists.
  assert.throws(() => nextRun('0 0 30 2 *', new Date(2026, 0, 1)), /no match|impossible/);
});

test('matches reflects nextRun outputs', () => {
  const expr = '30 14 * * *';
  assert.equal(matches(expr, new Date(2026, 0, 1, 14, 30, 0)), true);
  assert.equal(matches(expr, new Date(2026, 0, 1, 14, 31, 0)), false);
});
