/**
 * Tiny forward-only migration framework over node:sqlite (DatabaseSync).
 *
 * Every SQLite-backed store calls runMigrations(db, store, steps) at open time
 * to climb from its on-disk schema version (tracked in a shared schema_meta
 * table) up to the CURRENT version declared in version.ts. For v1 most stores
 * pass an empty step list (they're born at version 1); the framework is the
 * forward-compat seam so a future schema change is an additive, transactional,
 * idempotent step rather than an ad-hoc ALTER scattered through constructors.
 *
 * Design notes:
 *  - A step's `to` is the version it RAISES the store to; steps run in
 *    ascending `to` order, each inside its own transaction.
 *  - Re-running is a no-op: only steps with to > current version apply.
 *  - schema_meta is the single source of on-disk truth; a store with no row
 *    is treated as version 0 (fresh) so an empty step list leaves it at 0
 *    unless the caller seeds it (stores typically pass at least one step, or
 *    call setStoreVersion to baseline an already-created schema).
 */
import { copyFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { MigrationStep } from './types.js';

/** A single forward migration: raise the store to `to`, applying `up`. */
export interface Migration {
  /** Target version this step brings the store to (must be > previous). */
  to: number;
  /** Optional human-readable label recorded in the returned MigrationStep. */
  description?: string;
  /** Idempotent-friendly schema mutation; runs inside a transaction. */
  up: (db: DatabaseSync) => void;
}

interface MetaRow {
  version: number;
}

/** Create the shared schema_meta table if absent. Idempotent. */
export function ensureSchemaMeta(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      store   TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    );
  `);
}

/**
 * On-disk schema version for a store, or 0 if it has no schema_meta row.
 * Ensures schema_meta exists first so this is safe on a fresh db.
 */
export function getStoreVersion(db: DatabaseSync, store: string): number {
  ensureSchemaMeta(db);
  const row = db
    .prepare(`SELECT version FROM schema_meta WHERE store = ?`)
    .get(store) as unknown as MetaRow | undefined;
  return row ? row.version : 0;
}

/** Upsert the on-disk schema version for a store. */
export function setStoreVersion(db: DatabaseSync, store: string, version: number): void {
  ensureSchemaMeta(db);
  db.prepare(
    `INSERT INTO schema_meta (store, version) VALUES (?, ?)
       ON CONFLICT(store) DO UPDATE SET version = excluded.version`,
  ).run(store, version);
}

/**
 * Pure planner: given the current version and a step list (any order),
 * return the steps that still need to apply (to > current), in ascending
 * `to` order. No db access; deterministic — the unit-testable core.
 */
export function planMigrations(currentVersion: number, steps: Migration[]): Migration[] {
  return steps
    .filter((s) => s.to > currentVersion)
    .sort((a, b) => a.to - b.to);
}

/**
 * Copy a file-backed db to `<dbPath>.bak-<version>` before mutating it, so a
 * failed/buggy migration is recoverable. No-op for :memory: (nothing to copy)
 * and for a not-yet-existing file. Returns the backup path, or null if skipped.
 */
export function backupBefore(dbPath: string, version: number): string | null {
  if (dbPath === ':memory:') return null;
  if (!existsSync(dbPath)) return null;
  const backup = `${dbPath}.bak-${version}`;
  copyFileSync(dbPath, backup);
  return backup;
}

/**
 * Bring `store` up to the highest version in `steps`, applying each pending
 * step (to > current) in ascending order, each inside its own transaction so
 * a mid-step failure rolls that step back cleanly. The store's version is
 * bumped to the step's `to` within the same transaction as the schema change,
 * keeping schema_meta and the actual schema atomically consistent.
 *
 * Idempotent: a second call with the same steps applies nothing.
 * Returns the MigrationSteps that were applied (empty if already current).
 *
 * @param now injectable clock (unused for the mutation itself; reserved so
 *   callers/tests share the deterministic-time convention used elsewhere).
 */
export function runMigrations(
  db: DatabaseSync,
  store: string,
  steps: Migration[],
  _now?: Date,
): MigrationStep[] {
  ensureSchemaMeta(db);
  const applied: MigrationStep[] = [];
  // Re-read current version before each step so the plan reflects prior steps.
  for (;;) {
    const current = getStoreVersion(db, store);
    const [next] = planMigrations(current, steps);
    if (next === undefined) break;

    db.exec('BEGIN');
    try {
      next.up(db);
      setStoreVersion(db, store, next.to);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    applied.push({
      store,
      from: current,
      to: next.to,
      description: next.description ?? `migrate ${store} ${current}->${next.to}`,
    });
  }
  return applied;
}
