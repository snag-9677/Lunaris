import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskOutcome } from '@lunaris/core';
import { computeStatsResult, computeStats, wilsonLowerBound } from './stats.js';

function outcome(p: Partial<TaskOutcome>): TaskOutcome {
  return {
    taskId: p.taskId ?? 't',
    projectId: p.projectId ?? 'p1',
    taskClass: p.taskClass ?? 'code',
    role: p.role ?? 'coder',
    model: p.model ?? 'mock/echo',
    status: p.status ?? 'success',
    costUsd: p.costUsd ?? 0,
    durationMs: p.durationMs ?? 0,
    tokensIn: p.tokensIn ?? 0,
    tokensOut: p.tokensOut ?? 0,
    ts: p.ts ?? '2026-01-01T00:00:00.000Z',
    ...(p.failureClass !== undefined ? { failureClass: p.failureClass } : {}),
  };
}

test('wilsonLowerBound penalizes small samples and stays in [0,1]', () => {
  assert.equal(wilsonLowerBound(0, 0), 0, 'no data => 0');
  assert.equal(wilsonLowerBound(0, 10), 0, 'all failures => 0 lower bound');
  // 1/1 success must score well below 1 (small-sample penalty).
  const one = wilsonLowerBound(1, 1);
  assert.ok(one > 0 && one < 0.85, `1/1 should be uncertain, got ${one}`);
  // 100/100 should be close to (but below) 1, and far above 1/1.
  const many = wilsonLowerBound(100, 100);
  assert.ok(many > one, 'more evidence raises the lower bound');
  assert.ok(many > 0.95 && many <= 1, `100/100 should be high, got ${many}`);
  // More samples at the same rate => tighter (higher) lower bound.
  assert.ok(wilsonLowerBound(80, 100) > wilsonLowerBound(8, 10));
});

test('computeStats groups by class/role/model and counts successes', () => {
  const outcomes = [
    outcome({ taskId: 'a', status: 'success', costUsd: 0.02, durationMs: 1000 }),
    outcome({ taskId: 'b', status: 'success', costUsd: 0.04, durationMs: 3000 }),
    outcome({ taskId: 'c', status: 'failed', failureClass: 'model' }),
    outcome({ taskId: 'd', taskClass: 'research', role: 'researcher', model: 'm2' }),
  ];
  const stats = computeStats(outcomes);
  const code = stats.find((s) => s.key === 'code/coder/mock/echo');
  assert.ok(code, 'code group exists');
  assert.equal(code?.n, 3);
  assert.equal(code?.successes, 2);
  assert.equal(code?.avgCostUsd, (0.02 + 0.04 + 0) / 3);
  assert.equal(code?.avgDurationMs, (1000 + 3000 + 0) / 3);
  // separate group for the research outcome
  assert.ok(stats.some((s) => s.taskClass === 'research'));
});

test('infra failures are excluded from stats and counted separately', () => {
  const outcomes = [
    outcome({ taskId: 'a', status: 'success' }),
    outcome({ taskId: 'b', status: 'failed', failureClass: 'infra' }),
    outcome({ taskId: 'c', status: 'failed', failureClass: 'infra' }),
  ];
  const { stats, infraExcluded } = computeStatsResult(outcomes);
  assert.equal(infraExcluded, 2, 'two infra failures dropped');
  const code = stats.find((s) => s.taskClass === 'code');
  assert.equal(code?.n, 1, 'only the non-infra outcome counts');
  assert.equal(code?.successes, 1);
});
