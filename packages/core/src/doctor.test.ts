import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { doctor, type StoreReport } from './doctor.js';
import { runMigrations, setStoreVersion } from './migrate.js';
import { HARNESS_VERSION, SCHEMA_VERSIONS } from './version.js';

function by(stores: StoreReport[], name: string): StoreReport {
  const r = stores.find((s) => s.store === name);
  assert.ok(r, `report missing store ${name}`);
  return r;
}

test('doctor reports missing for an absent db file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lunaris-doctor-'));
  try {
    const report = doctor({ events: join(dir, 'nope.db') });
    assert.equal(report.harness, HARNESS_VERSION);
    const r = by(report.stores, 'events');
    assert.equal(r.present, false);
    assert.equal(r.version, null);
    assert.equal(r.status, 'missing');
    assert.equal(r.expected, SCHEMA_VERSIONS.events);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor reports ok when on-disk version matches expected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lunaris-doctor-'));
  try {
    const path = join(dir, 'events.db');
    const db = new DatabaseSync(path);
    // Climb to the current expected version via the real framework.
    runMigrations(db, 'events', [{ to: SCHEMA_VERSIONS.events as number, up: () => {} }]);
    db.close();

    const r = by(doctor({ events: path }).stores, 'events');
    assert.equal(r.present, true);
    assert.equal(r.version, SCHEMA_VERSIONS.events);
    assert.equal(r.status, 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor reports behind / ahead relative to expected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lunaris-doctor-'));
  try {
    const behindPath = join(dir, 'memory.db');
    const aheadPath = join(dir, 'identity.db');

    const dbA = new DatabaseSync(behindPath);
    setStoreVersion(dbA, 'memory', 0); // below expected (>=1)
    dbA.close();

    const dbB = new DatabaseSync(aheadPath);
    setStoreVersion(dbB, 'identity', (SCHEMA_VERSIONS.identity as number) + 5);
    dbB.close();

    const report = doctor({ memory: behindPath, identity: aheadPath });
    assert.equal(by(report.stores, 'memory').status, 'behind');
    assert.equal(by(report.stores, 'identity').status, 'ahead');
    // stores are sorted by name for stable output
    assert.deepEqual(
      report.stores.map((s) => s.store),
      ['identity', 'memory'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor flags a present db with no schema_meta as behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lunaris-doctor-'));
  try {
    const path = join(dir, 'raw.db');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE events (id INTEGER)'); // legacy db, never migrated
    db.close();

    const r = by(doctor({ events: path }).stores, 'events');
    assert.equal(r.present, true);
    assert.equal(r.version, null);
    assert.equal(r.status, 'behind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor marks an unknown store (no expected) as behind when present', () => {
  const r = by(doctor({ widgets: ':memory:' }).stores, 'widgets');
  // :memory: counts as present; unknown store has no expected version.
  assert.equal(r.present, true);
  assert.equal(r.expected, null);
  assert.equal(r.status, 'behind');
});
