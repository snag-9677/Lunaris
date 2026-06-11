/**
 * Harness version + per-store schema version registry (Phase 4).
 *
 * SCHEMA_VERSIONS is the single source of truth for the CURRENT expected
 * schema version of every SQLite-backed store. Each store calls
 * runMigrations(db, store, steps) at open time to climb to its entry here
 * (see migrate.ts); doctor.ts compares on-disk versions against this map.
 *
 * Bump a store's number here whenever you add a migration step that raises it.
 */
import type { VersionInfo } from './types.js';

/**
 * Semver of the harness binary. Hardcoded (reading package.json at runtime
 * is brittle under bundling and the dist layout); keep in lockstep with the
 * monorepo version on release.
 */
export const HARNESS_VERSION = '0.4.0';

/**
 * Current expected schema version per store. v1 = the Phase 1-3 baseline
 * shape; new stores (identity, leases) also start at 1. The key set is the
 * canonical list of migratable stores in the harness.
 */
export const SCHEMA_VERSIONS: Record<string, number> = {
  events: 1,
  memory: 1,
  approvals: 1,
  routing_arms: 1,
  proposals: 1,
  queued_goals: 1,
  schedules: 1,
  trigger_rules: 1,
  identity: 1,
  leases: 1,
};

/** Snapshot of the harness + expected schema versions this build ships. */
export function currentVersionInfo(): VersionInfo {
  return {
    harness: HARNESS_VERSION,
    // Copy so callers can't mutate the shared registry.
    schemaVersions: { ...SCHEMA_VERSIONS },
  };
}
