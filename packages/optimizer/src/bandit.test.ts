import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TaskOutcome } from '@lunaris/core';
import { RoutingBandit } from './bandit.js';

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

test('rewardOf shapes rewards and skips infra failures', () => {
  const b = new RoutingBandit({ dbPath: ':memory:', projectId: 'p1', costCeilingUsd: 1 });
  assert.equal(b.rewardOf(outcome({ status: 'success', costUsd: 0 })), 1, 'free success => 1');
  // success at full cost ceiling => 1 - 0.3 = 0.7
  assert.ok(Math.abs((b.rewardOf(outcome({ status: 'success', costUsd: 1 })) ?? -1) - 0.7) < 1e-9);
  assert.equal(b.rewardOf(outcome({ status: 'partial' })), 0.4);
  assert.equal(b.rewardOf(outcome({ status: 'failed', failureClass: 'model' })), 0);
  assert.equal(b.rewardOf(outcome({ status: 'blocked' })), 0);
  assert.equal(b.rewardOf(outcome({ status: 'failed', failureClass: 'infra' })), null, 'infra skipped');
  b.close();
});

test('select converges on the higher-reward model (greedy, no exploration)', () => {
  // epsilon=0 + deterministic rng => pure exploitation.
  const b = new RoutingBandit({ dbPath: ':memory:', projectId: 'p1', rng: () => 0.99 });
  for (let i = 0; i < 20; i++) {
    b.update('code', 'good', 0.9);
    b.update('code', 'bad', 0.1);
  }
  const choice = b.select('code', ['good', 'bad'], 0);
  assert.equal(choice, 'good');
  const arms = b.arms();
  const good = arms.find((a) => a.model === 'good');
  assert.equal(good?.pulls, 20);
  assert.ok(Math.abs((good?.meanReward ?? 0) - 0.9) < 1e-9);
  b.close();
});

test('arms persist across bandit instances on the same db', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lunaris-bandit-'));
  const dbPath = join(dir, 'bandit.db');
  try {
    const b1 = new RoutingBandit({ dbPath, projectId: 'p1' });
    for (let i = 0; i < 10; i++) b1.update('code', 'good', 0.8);
    b1.close();

    // Reopen: accumulated pulls/reward must survive.
    const b2 = new RoutingBandit({ dbPath, projectId: 'p1' });
    for (let i = 0; i < 10; i++) b2.update('code', 'good', 0.8);
    const arm = b2.arms().find((a) => a.model === 'good');
    assert.equal(arm?.pulls, 20, 'pulls accumulated across runs');
    assert.ok(Math.abs((arm?.meanReward ?? 0) - 0.8) < 1e-9);

    const suggestions = b2.suggestions(8);
    const code = suggestions.find((s) => s.taskClass === 'code');
    assert.equal(code?.recommendedModel, 'good');
    assert.equal(code?.basedOnN, 20);
    b2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('suggestions withhold a recommendation until minN pulls', () => {
  const b = new RoutingBandit({ dbPath: ':memory:', projectId: 'p1' });
  for (let i = 0; i < 3; i++) b.update('research', 'm1', 0.9);
  assert.equal(b.suggestions(8).length, 0, 'too few pulls => no suggestion');
  for (let i = 0; i < 6; i++) b.update('research', 'm1', 0.9);
  const sugg = b.suggestions(8);
  assert.equal(sugg.length, 1);
  assert.equal(sugg[0]?.recommendedModel, 'm1');
  b.close();
});
