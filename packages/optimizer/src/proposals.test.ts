import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OutcomeStats, RoutingSuggestion } from '@lunaris/core';
import { SqliteProposalStore, generateProposals } from './proposals.js';

test('create mints a pending proposal; list/get/resolve work', () => {
  const store = new SqliteProposalStore(':memory:');
  const p = store.create({
    projectId: 'p1',
    kind: 'routing',
    title: 'Route code to mock/echo',
    detail: 'because reasons',
    diff: '- a\n+ b',
    confidence: 0.7,
  });
  assert.match(p.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/, 'uuidv7 id');
  assert.equal(p.status, 'pending');
  assert.deepEqual(store.get(p.id), p);

  assert.equal(store.list('p1', 'pending').length, 1);
  assert.equal(store.list('other').length, 0, 'filtered by project');

  const resolved = store.resolve(p.id, true);
  assert.equal(resolved?.status, 'approved');
  // Idempotent: re-resolving returns unchanged.
  assert.equal(store.resolve(p.id, false)?.status, 'approved');
  assert.equal(store.resolve('nope', true), undefined);

  const other = store.create({ projectId: 'p1', kind: 'capability', title: 't', detail: 'd', confidence: 0.5 });
  assert.equal(store.resolve(other.id, false)?.status, 'rejected');
  store.close();
});

test('generateProposals emits routing proposals with a readable diff', () => {
  const stats: OutcomeStats[] = [
    {
      key: 'code/coder/good',
      taskClass: 'code',
      role: 'coder',
      model: 'good',
      n: 12,
      successes: 11,
      successRate: 0.78,
      avgCostUsd: 0.012,
      avgDurationMs: 2000,
    },
  ];
  const suggestions: RoutingSuggestion[] = [
    {
      taskClass: 'code',
      recommendedModel: 'good',
      rationale: 'mean reward 0.800 over 12 pulls',
      confidence: 0.6,
      basedOnN: 12,
    },
  ];
  const drafts = generateProposals(stats, suggestions, 'p1', '2026-06-11T00:00:00.000Z');
  const routing = drafts.find((d) => d.kind === 'routing');
  assert.ok(routing, 'routing proposal generated');
  assert.match(routing?.title ?? '', /Route code tasks to good/);
  assert.match(routing?.diff ?? '', /\+ code = "good"/);
  assert.match(routing?.diff ?? '', /success 78\.0% @ \$0\.0120/);
  assert.equal(routing?.confidence, 0.6);
});

test('generateProposals flags recurring-failure capability concerns', () => {
  const stats: OutcomeStats[] = [
    {
      key: 'test/tester/weak',
      taskClass: 'test',
      role: 'tester',
      model: 'weak',
      n: 10,
      successes: 2, // 8 failures, best success rate well under 0.5
      successRate: 0.18,
      avgCostUsd: 0.01,
      avgDurationMs: 1000,
    },
  ];
  const drafts = generateProposals(stats, [], 'p1');
  const cap = drafts.find((d) => d.kind === 'capability');
  assert.ok(cap, 'capability proposal generated for a struggling task class');
  assert.match(cap?.title ?? '', /Investigate recurring failures in test/);
  assert.match(cap?.detail ?? '', /8\/10/);
});
