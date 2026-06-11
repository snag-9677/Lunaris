import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  backupBefore,
  ensureSchemaMeta,
  getStoreVersion,
  planMigrations,
  runMigrations,
  setStoreVersion,
  type Migration,
} from './migrate.js';

test('ensureSchemaMeta is idempotent and seeds version 0', () => {
  const db = new DatabaseSync(':memory:');
  ensureSchemaMeta(db);
  ensureSchemaMeta(db); // second call must not throw
  assert.equal(getStoreVersion(db, 'events'), 0);
  setStoreVersion(db, 'events', 1);
  setStoreVersion(db, 'events', 2); // upsert path
  assert.equal(getStoreVersion(db, 'events'), 2);
  db.close();
});

test('planMigrations returns only steps with to>current, in ascending order', () => {
  const steps: Migration[] = [
    { to: 3, up: () => {} },
    { to: 1, up: () => {} },
    { to: 2, up: () => {} },
  ];
  assert.deepEqual(
    planMigrations(0, steps).map((s) => s.to),
    [1, 2, 3],
  );
  assert.deepEqual(
    planMigrations(1, steps).map((s) => s.to),
    [2, 3],
  );
  assert.deepEqual(planMigrations(3, steps), []);
});

test('runMigrations applies pending steps in order and bumps version', () => {
  const db = new DatabaseSync(':memory:');
  let calls: number[] = [];
  const steps: Migration[] = [
    {
      to: 1,
      description: 'create t',
      up: (d) => {
        calls.push(1);
        d.exec('CREATE TABLE t (id INTEGER)');
      },
    },
    {
      to: 2,
      description: 'add col',
      up: (d) => {
        calls.push(2);
        d.exec('ALTER TABLE t ADD COLUMN name TEXT');
      },
    },
  ];

  const applied = runMigrations(db, 'memory', steps);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(getStoreVersion(db, 'memory'), 2);
  assert.deepEqual(
    applied.map((s) => [s.from, s.to]),
    [
      [0, 1],
      [1, 2],
    ],
  );
  assert.equal(applied[0]?.description, 'create t');
  // Schema actually changed: the new column accepts a value.
  db.prepare('INSERT INTO t (id, name) VALUES (?, ?)').run(1, 'x');
  db.close();
});

test('runMigrations is idempotent: a second run applies nothing', () => {
  const db = new DatabaseSync(':memory:');
  let ups = 0;
  const steps: Migration[] = [{ to: 1, up: () => ups++ }];

  const first = runMigrations(db, 'leases', steps);
  assert.equal(first.length, 1);
  assert.equal(ups, 1);

  const second = runMigrations(db, 'leases', steps);
  assert.equal(second.length, 0, 'no steps re-applied');
  assert.equal(ups, 1, 'up() not called again');
  assert.equal(getStoreVersion(db, 'leases'), 1);
  db.close();
});

test('runMigrations only applies steps above the current on-disk version', () => {
  const db = new DatabaseSync(':memory:');
  // Pretend the store was already baselined at v1.
  setStoreVersion(db, 'identity', 1);
  let ranV1 = false;
  let ranV2 = false;
  const applied = runMigrations(db, 'identity', [
    { to: 1, up: () => (ranV1 = true) },
    { to: 2, up: () => (ranV2 = true) },
  ]);
  assert.equal(ranV1, false, 'already-applied step skipped');
  assert.equal(ranV2, true, 'newer step applied');
  assert.deepEqual(
    applied.map((s) => s.to),
    [2],
  );
  assert.equal(getStoreVersion(db, 'identity'), 2);
  db.close();
});

test('runMigrations rolls back a failing step and leaves version unchanged', () => {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, 'events', [{ to: 1, up: (d) => d.exec('CREATE TABLE e (id INTEGER)') }]);
  assert.equal(getStoreVersion(db, 'events'), 1);

  assert.throws(() =>
    runMigrations(db, 'events', [
      { to: 1, up: () => {} },
      {
        to: 2,
        up: (d) => {
          d.exec('CREATE TABLE e2 (id INTEGER)');
          throw new Error('boom');
        },
      },
    ]),
  );
  // Version stays at 1 and the partial table was rolled back.
  assert.equal(getStoreVersion(db, 'events'), 1);
  const tbl = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='e2'`)
    .get();
  assert.equal(tbl, undefined, 'failed step rolled back');
  db.close();
});

test('backupBefore copies file-backed dbs and skips :memory: / missing files', () => {
  assert.equal(backupBefore(':memory:', 1), null);

  const dir = mkdtempSync(join(tmpdir(), 'lunaris-migrate-'));
  try {
    const dbPath = join(dir, 'store.db');
    assert.equal(backupBefore(dbPath, 1), null, 'missing file -> no backup');

    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE x (id INTEGER)');
    db.close();

    const backup = backupBefore(dbPath, 2);
    assert.equal(backup, `${dbPath}.bak-2`);
    assert.ok(backup && existsSync(backup), 'backup file written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
