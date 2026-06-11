import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatGoal } from './commands.js';

test('buildChatGoal builds a running Goal carrying id, project and prompt', () => {
  const before = Date.now();
  const goal = buildChatGoal('goal-123', 'proj-9', 'refactor the parser');
  const after = Date.now();

  assert.equal(goal.goalId, 'goal-123');
  assert.equal(goal.projectId, 'proj-9');
  assert.equal(goal.prompt, 'refactor the parser');
  assert.equal(goal.status, 'running');

  // createdAt is a current, round-trippable ISO 8601 timestamp.
  const created = Date.parse(goal.createdAt);
  assert.ok(Number.isFinite(created), 'createdAt parses as a date');
  assert.ok(created >= before - 1_000 && created <= after + 1_000, 'createdAt is "now"');
  assert.equal(new Date(created).toISOString(), goal.createdAt);
});
