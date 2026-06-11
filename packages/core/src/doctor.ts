/**
 * Schema doctor (Phase 4): compare each store's on-disk schema_meta version
 * against the CURRENT expected version in version.ts and report drift.
 *
 * status semantics per store:
 *   missing — the db file isn't present (nothing to migrate yet)
 *   behind  — on-disk version < expected (a migration is pending)
 *   ahead   — on-disk version > expected (db written by a NEWER harness)
 *   ok      — on-disk version == expected
 *
 * Read-only: dbs are opened with readOnly so doctor never mutates state.
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { HARNESS_VERSION, SCHEMA_VERSIONS } from './version.js';

export type DoctorStatus = 'ok' | 'behind' | 'ahead' | 'missing';

export interface StoreReport {
  store: string;
  path: string;
  /** True iff the db file exists on disk (always true for :memory:). */
  present: boolean;
  /** On-disk schema_meta version, or null if absent/unreadable. */
  version: number | null;
  /** Expected version from SCHEMA_VERSIONS, or null for an unknown store. */
  expected: number | null;
  status: DoctorStatus;
  /**
   * FIX 8: set when the version read FAILED (e.g. the store is in use and its
   * WAL/SHM made a read-only open transiently unreadable). When present, a
   * 'behind'/null result is NOT authoritative — it may be a transient WAL
   * artifact rather than real schema drift; re-run doctor when the store is idle.
   */
  note?: string;
}

export interface DoctorReport {
  harness: string;
  stores: StoreReport[];
}

interface MetaRow {
  version: number;
}

/**
 * Read a store's on-disk schema version without mutating it. Opens read-only so
 * a sibling writer's WAL isn't disturbed.
 *
 * Returns { version, readFailed }:
 *  - version: the recorded version, or null when the file is missing, has no
 *    schema_meta table, or has no row for the store.
 *  - readFailed: true when opening/querying THREW. FIX 8: opening a WAL-mode db
 *    read-only while another process holds it can transiently fail (or the -wal
 *    sidecar can make the read-only snapshot look empty), so we surface this so
 *    the caller can flag a 'behind'/null result as possibly transient rather
 *    than treating it as authoritative schema drift.
 */
function readVersion(path: string, store: string): { version: number | null; readFailed: boolean } {
  if (path !== ':memory:' && !existsSync(path)) return { version: null, readFailed: false };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const meta = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'`)
      .get() as unknown as { name: string } | undefined;
    if (meta === undefined) return { version: null, readFailed: false };
    const row = db
      .prepare(`SELECT version FROM schema_meta WHERE store = ?`)
      .get(store) as unknown as MetaRow | undefined;
    return { version: row ? row.version : null, readFailed: false };
  } catch {
    // Read-only open/query failed — likely an in-use WAL store. Report the
    // failure distinctly so the result is not mistaken for real drift.
    return { version: null, readFailed: true };
  } finally {
    db?.close();
  }
}

function classify(present: boolean, version: number | null, expected: number | null): DoctorStatus {
  if (!present) return 'missing';
  if (version === null || expected === null) {
    // File exists but carries no recorded version (or store is unknown):
    // treat as behind so an operator is nudged to baseline/migrate it.
    return 'behind';
  }
  if (version < expected) return 'behind';
  if (version > expected) return 'ahead';
  return 'ok';
}

/**
 * Diagnose schema drift across a set of stores.
 *
 * @param dbPaths map of store name -> sqlite db path. Store names are matched
 *   against SCHEMA_VERSIONS for the expected version; an unmapped store gets
 *   expected = null and is flagged 'behind' when present.
 */
export function doctor(dbPaths: Record<string, string>): DoctorReport {
  const stores: StoreReport[] = [];
  for (const [store, path] of Object.entries(dbPaths)) {
    const present = path === ':memory:' || existsSync(path);
    const read = present ? readVersion(path, store) : { version: null, readFailed: false };
    const version = read.version;
    const expected = store in SCHEMA_VERSIONS ? (SCHEMA_VERSIONS[store] as number) : null;
    const report: StoreReport = {
      store,
      path,
      present,
      version,
      expected,
      status: classify(present, version, expected),
    };
    // FIX 8: a behind/null result for an IN-USE WAL store can be a transient
    // artifact (the read-only snapshot may miss uncommitted WAL frames or the
    // open may have raced a writer). Flag it so an operator does not migrate on
    // a false 'behind'.
    if (read.readFailed) {
      report.note =
        'version read failed (store may be in use); a behind/null result may be a transient WAL artifact — re-run when idle';
    }
    stores.push(report);
  }
  // Deterministic ordering for stable reports/snapshots.
  stores.sort((a, b) => (a.store < b.store ? -1 : a.store > b.store ? 1 : 0));
  return { harness: HARNESS_VERSION, stores };
}
