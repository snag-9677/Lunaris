import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteApprovalQueue, defaultPolicy, defaultPolicyRules } from './approvals.js';

test('create mints a pending ticket and list/get retrieve it', () => {
  const q = new SqliteApprovalQueue(':memory:');
  const t = q.create({ projectId: 'p1', tool: 'run_bash', args: { command: 'git push' }, reason: 'irreversible' });
  assert.match(t.ticketId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/);
  assert.equal(t.status, 'pending');
  assert.equal(new Date(t.createdAt).toISOString(), t.createdAt);

  const got = q.get(t.ticketId);
  assert.deepEqual(got, t);

  const pending = q.list('p1', 'pending');
  assert.equal(pending.length, 1);
  assert.equal(q.list('other').length, 0, 'filtered by project');
  q.close();
});

test('resolve approves/denies pending tickets and is idempotent', () => {
  const q = new SqliteApprovalQueue(':memory:');
  const a = q.create({ projectId: 'p1', tool: 'write_file', args: {}, reason: 'r' });
  const resolved = q.resolve(a.ticketId, true, 'alice');
  assert.equal(resolved?.status, 'approved');
  assert.equal(resolved?.resolvedBy, 'alice');
  assert.ok(resolved?.resolvedAt);

  // Re-resolving an already-resolved ticket returns it unchanged.
  const again = q.resolve(a.ticketId, false, 'bob');
  assert.equal(again?.status, 'approved', 'no flip after first resolution');

  const b = q.create({ projectId: 'p1', tool: 'write_file', args: {}, reason: 'r' });
  assert.equal(q.resolve(b.ticketId, false, 'carol')?.status, 'denied');

  assert.equal(q.resolve('does-not-exist', true, 'x'), undefined);
  q.close();
});

test('staleness guard: planEpoch mismatch marks the ticket stale', () => {
  const q = new SqliteApprovalQueue(':memory:');
  const t = q.create({
    projectId: 'p1',
    tool: 'run_bash',
    args: { command: 'deploy' },
    reason: 'deploy',
    planEpoch: 7,
  });
  // World moved to epoch 8: resolving must NOT approve, must mark stale.
  const stale = q.resolve(t.ticketId, true, 'alice', 8);
  assert.equal(stale?.status, 'stale');
  assert.equal(stale?.resolvedBy, 'alice');

  // A fresh ticket at the same epoch resolves normally.
  const t2 = q.create({ projectId: 'p1', tool: 'run_bash', args: {}, reason: 'r', planEpoch: 9 });
  assert.equal(q.resolve(t2.ticketId, true, 'alice', 9)?.status, 'approved');

  // No currentPlanEpoch supplied → guard is skipped.
  const t3 = q.create({ projectId: 'p1', tool: 'run_bash', args: {}, reason: 'r', planEpoch: 3 });
  assert.equal(q.resolve(t3.ticketId, true, 'alice')?.status, 'approved');
  q.close();
});

test('approval queue survives reopen (file-backed)', () => {
  const root = mkdtempSync(join(tmpdir(), 'lunaris-approvals-test-'));
  const dbPath = join(root, 'nested', 'approvals.db');
  try {
    const q = new SqliteApprovalQueue(dbPath);
    const t = q.create({ projectId: 'p1', tool: 'run_bash', args: { command: 'x' }, reason: 'r' });
    q.close();
    assert.ok(existsSync(dbPath));

    const reopened = new SqliteApprovalQueue(dbPath);
    assert.equal(reopened.get(t.ticketId)?.status, 'pending');
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('defaultPolicy factory returns engine + rules sensible for the level', () => {
  const l0 = defaultPolicy(0);
  assert.equal(l0.level, 0);
  assert.equal(l0.engine.level, 0);
  // L0 still denies writes via the engine default.
  assert.equal(
    l0.engine.evaluate('write_file', { path: 'a.ts' }, { projectId: 'p', tainted: false }).effect,
    'deny',
  );

  const l2 = defaultPolicy(2);
  // Default rules include a read allow on L1+.
  assert.ok(defaultPolicyRules(2).some((r) => r.effect === 'allow' && r.tools?.includes('read_file')));
  assert.equal(
    l2.engine.evaluate('run_bash', { command: 'npm test' }, { projectId: 'p', tainted: false })
      .effect,
    'allow',
  );
});
