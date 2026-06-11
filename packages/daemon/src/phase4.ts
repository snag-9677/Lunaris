/**
 * Phase 4 daemon helpers: lease + capability-token wiring (for goal-runner),
 * lifecycle db-path discovery for the version/doctor report, and shared default
 * paths under ~/.lunaris.
 *
 * @lunaris/identity and @lunaris/lifecycle are workspace deps; their value-level
 * surfaces are not in types.ts, so concrete classes (SqliteLeaseStore,
 * Ed25519CapabilityTokenService) are imported statically here but the lifecycle
 * functions are imported through a narrow structural view to match the loose-
 * binding convention used by the Phase 2/3 wiring.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SqliteLeaseStore, stableNodeId, Ed25519CapabilityTokenService } from '@lunaris/identity';
import { doctor, currentVersionInfo } from '@lunaris/core';
import type { DoctorReport, VersionInfo } from '@lunaris/core';
import {
  banditDbPath,
  proposalDbPath,
  queueDbPath,
  scheduleDbPath,
  triggerDbPath,
} from './phase3.js';
import { approvalsDbPath, memoryDbPath } from './goal-runner.js';

/* ---------- shared ~/.lunaris paths ---------- */

export function leasesDbPath(): string {
  return join(homedir(), '.lunaris', 'leases.db');
}
export function agentKeyPath(): string {
  return join(homedir(), '.lunaris', 'agent-key.pem');
}

/* ---------- lease + agent-token factory (used by goal-runner) ---------- */

export interface LeaseRuntime {
  leaseStore: SqliteLeaseStore;
  tokenService: Ed25519CapabilityTokenService;
  nodeId: string;
}

/**
 * Construct the shared lease store + capability-token service. The signing key
 * is generated + persisted at 0600 if absent (handled by the token service).
 */
export function makeLeaseRuntime(opts?: { leasesPath?: string; keyPath?: string }): LeaseRuntime {
  const leaseStore = new SqliteLeaseStore(opts?.leasesPath ?? leasesDbPath());
  const tokenService = new Ed25519CapabilityTokenService({ keyPath: opts?.keyPath ?? agentKeyPath() });
  return { leaseStore, tokenService, nodeId: stableNodeId() };
}

/* ---------- version + doctor report ---------- */

/** Per-project store db paths (those tracked by SCHEMA_VERSIONS where present). */
export function projectStorePaths(projectRoot: string): Record<string, string> {
  return {
    memory: memoryDbPath(projectRoot),
    approvals: approvalsDbPath(projectRoot),
    proposals: proposalDbPath(projectRoot),
    routing_arms: banditDbPath(projectRoot),
    queued_goals: queueDbPath(projectRoot),
    schedules: scheduleDbPath(projectRoot),
    trigger_rules: triggerDbPath(projectRoot),
  };
}

/** Global store db paths under ~/.lunaris (events, identity, leases). */
export function globalStorePaths(eventsDbPath: string, identityDbPath: string, leasesPath: string): Record<string, string> {
  return {
    events: eventsDbPath,
    identity: identityDbPath,
    leases: leasesPath,
  };
}

/**
 * Build a VersionInfo + DoctorReport over the known db paths. Only existing
 * files are passed to doctor() (doctor itself also flags missing as a status).
 */
export function buildVersionReport(dbPaths: Record<string, string>): { version: VersionInfo; doctor: DoctorReport } {
  // doctor() opens read-only and tolerates missing files (status 'missing'),
  // but only pass paths that actually exist for global stores so a fresh
  // install with no projects reports cleanly.
  const present: Record<string, string> = {};
  for (const [store, path] of Object.entries(dbPaths)) {
    if (path === ':memory:' || existsSync(path)) present[store] = path;
  }
  return { version: currentVersionInfo(), doctor: doctor(present) };
}
