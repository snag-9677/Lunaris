import test from 'node:test';
import assert from 'node:assert/strict';
import type { CallMeta } from '@lunaris/core';
import { BudgetExceededError, InMemoryBudgetLedger } from './budget.js';

function meta(taskId?: string): CallMeta {
  const m: CallMeta = { projectId: 'proj-1', callId: `call-${Math.random().toString(36).slice(2)}` };
  if (taskId !== undefined) m.taskId = taskId;
  return m;
}

test('reserve + settle: settled spend counts against the day cap, reservations are released', () => {
  const ledger = new InMemoryBudgetLedger({ perDayUsd: 1 });

  const r1 = ledger.reserve(meta(), 0.5);
  assert.equal(ledger.dayTotals().reserved, 0.5);

  r1.settle(0.2);
  assert.equal(ledger.dayTotals().reserved, 0);
  assert.equal(ledger.dayTotals().settled, 0.2);

  // 0.2 settled + 0.7 new = 0.9 <= 1.0 → allowed
  const r2 = ledger.reserve(meta(), 0.7);

  // 0.2 settled + 0.7 reserved + 0.2 new = 1.1 > 1.0 → denied
  assert.throws(() => ledger.reserve(meta(), 0.2), BudgetExceededError);
  try {
    ledger.reserve(meta(), 0.2);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof BudgetExceededError);
    assert.equal(err.cap, 'perDayUsd');
    assert.equal(err.capUsd, 1);
  }

  r2.refund();
});

test('refund releases reserved budget so later calls are admitted', () => {
  const ledger = new InMemoryBudgetLedger({ perDayUsd: 1 });

  const r1 = ledger.reserve(meta(), 0.9);
  assert.throws(() => ledger.reserve(meta(), 0.2), BudgetExceededError);

  r1.refund();
  assert.equal(ledger.dayTotals().reserved, 0);
  assert.equal(ledger.dayTotals().settled, 0);

  // Now there is room again.
  const r2 = ledger.reserve(meta(), 0.95);
  r2.settle(0.95);
  assert.equal(ledger.dayTotals().settled, 0.95);
});

test('perCallUsd cap rejects oversized single reservations', () => {
  const ledger = new InMemoryBudgetLedger({ perCallUsd: 0.5 });
  assert.throws(() => ledger.reserve(meta(), 0.6), BudgetExceededError);
  const r = ledger.reserve(meta(), 0.5); // exactly at the cap is allowed
  r.refund();
});

test('perTaskUsd is tracked per task; independent tasks do not interfere', () => {
  const ledger = new InMemoryBudgetLedger({ perTaskUsd: 1 });

  const a = ledger.reserve(meta('task-a'), 0.8);
  const b = ledger.reserve(meta('task-b'), 0.8); // different task → its own bucket

  assert.throws(() => ledger.reserve(meta('task-a'), 0.3), BudgetExceededError);

  a.settle(0.6);
  // task-a: settled 0.6, reserved 0 → 0.3 more fits under 1.0
  const a2 = ledger.reserve(meta('task-a'), 0.3);

  assert.equal(ledger.taskTotals('task-a').settled, 0.6);
  assert.equal(ledger.taskTotals('task-a').reserved, 0.3);
  assert.equal(ledger.taskTotals('task-b').reserved, 0.8);

  a2.refund();
  b.refund();
});

test('settle and refund are idempotent — double finalization never double-adjusts', () => {
  const ledger = new InMemoryBudgetLedger({ perDayUsd: 10 });

  const r = ledger.reserve(meta('task-x'), 1);
  r.settle(0.4);
  r.settle(0.4); // no-op
  r.refund(); // no-op after settle

  assert.equal(ledger.dayTotals().reserved, 0);
  assert.equal(ledger.dayTotals().settled, 0.4);
  assert.equal(ledger.taskTotals('task-x').settled, 0.4);

  const r2 = ledger.reserve(meta(), 1);
  r2.refund();
  r2.settle(5); // no-op after refund
  assert.equal(ledger.dayTotals().settled, 0.4);
});

test('reservations count immediately: concurrent-style reserves cannot overshoot the cap', () => {
  const ledger = new InMemoryBudgetLedger({ perDayUsd: 1 });

  // Three in-flight calls admitted back-to-back before any settles.
  const r1 = ledger.reserve(meta(), 0.4);
  const r2 = ledger.reserve(meta(), 0.4);
  assert.throws(() => ledger.reserve(meta(), 0.4), BudgetExceededError); // would total 1.2

  r1.settle(0.1);
  r2.settle(0.1);
  // settled 0.2 → plenty of headroom restored
  const r3 = ledger.reserve(meta(), 0.4);
  r3.refund();
});

test('invalid estimates are rejected', () => {
  const ledger = new InMemoryBudgetLedger();
  assert.throws(() => ledger.reserve(meta(), -1));
  assert.throws(() => ledger.reserve(meta(), Number.NaN));
});
