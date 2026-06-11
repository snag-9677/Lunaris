/**
 * SqliteLeaseStore: one-orchestrator-per-repo lease with fencing (replaces a
 * plain lockfile). Backed by node:sqlite (DatabaseSync), WAL — matching the
 * other Lunaris stores.
 *
 * Fencing: each fresh acquisition increments a monotonic `epoch`. Side-effecting
 * writes are stamped with the held epoch; isCurrentEpoch() rejects a stale epoch
 * so a paused-then-resumed zombie holder cannot clobber a newer holder.
 *
 * Atomicity: a fresh acquisition (no live lease, or expired) is performed as a
 * single conditional UPSERT inside an IMMEDIATE transaction, so two racers can
 * never both win — the first commits the new holder+epoch; the second re-reads
 * inside its own transaction and sees a live lease held by another → null.
 * node:sqlite executes statements synchronously and serially in-process, and the
 * transaction guards the file-backed multi-process case.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { Lease, LeaseStore } from '@lunaris/core';

const DEFAULT_TTL_MS = 45_000;

interface LeaseRow {
  repo_id: string;
  holder_id: string;
  node_id: string;
  epoch: number;
  acquired_at: string;
  heartbeat_at: string;
  ttl_ms: number;
}

function rowToLease(row: LeaseRow): Lease {
  return {
    repoId: row.repo_id,
    holderId: row.holder_id,
    nodeId: row.node_id,
    epoch: row.epoch,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    ttlMs: row.ttl_ms,
  };
}

/** True iff a lease is expired at `nowMs` (now - heartbeat > ttl). */
function isExpired(row: LeaseRow, nowMs: number): boolean {
  return nowMs - new Date(row.heartbeat_at).getTime() > row.ttl_ms;
}

export interface SqliteLeaseStoreOptions {
  /** Default lease ttl in ms (default 45000). */
  ttlMs?: number;
  /** Override the node id (mostly for tests); default is a stable machine id. */
  nodeId?: string;
}

export class SqliteLeaseStore implements LeaseStore {
  private readonly db: DatabaseSync;
  private readonly ttlMs: number;
  readonly nodeId: string;

  /** @param dbPath sqlite file path (parent dirs created) or ':memory:'. */
  constructor(dbPath: string, opts: SqliteLeaseStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.nodeId = opts.nodeId ?? stableNodeId();
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS leases (
        repo_id      TEXT PRIMARY KEY,
        holder_id    TEXT NOT NULL,
        node_id      TEXT NOT NULL,
        epoch        INTEGER NOT NULL,
        acquired_at  TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        ttl_ms       INTEGER NOT NULL
      );
    `);
  }

  private getRow(repoId: string): LeaseRow | undefined {
    return this.db
      .prepare(`SELECT * FROM leases WHERE repo_id = ?`)
      .get(repoId) as unknown as LeaseRow | undefined;
  }

  /**
   * Acquire if free, expired, or already held by the same holder.
   *  - Fresh acquisition (no row / expired / different holder taking over an
   *    expired lease): epoch = prevEpoch + 1 (or 1 if none), acquiredAt = now.
   *  - Same-holder re-acquire of a still-live lease: keep epoch, refresh
   *    heartbeat (idempotent renew).
   *  - A live lease held by a DIFFERENT holder: return null.
   */
  acquire(repoId: string, holderId: string, nodeId?: string, now?: Date): Lease | null {
    const node = nodeId ?? this.nodeId;
    const at = now ?? new Date();
    const nowMs = at.getTime();
    const nowIso = at.toISOString();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.getRow(repoId);

      if (existing === undefined || isExpired(existing, nowMs)) {
        const epoch = (existing?.epoch ?? 0) + 1;
        this.db
          .prepare(
            `INSERT INTO leases
               (repo_id, holder_id, node_id, epoch, acquired_at, heartbeat_at, ttl_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (repo_id) DO UPDATE SET
               holder_id = excluded.holder_id,
               node_id = excluded.node_id,
               epoch = excluded.epoch,
               acquired_at = excluded.acquired_at,
               heartbeat_at = excluded.heartbeat_at,
               ttl_ms = excluded.ttl_ms`,
          )
          .run(repoId, holderId, node, epoch, nowIso, nowIso, this.ttlMs);
        this.db.exec('COMMIT');
        return rowToLease(this.getRow(repoId) as LeaseRow);
      }

      if (existing.holder_id === holderId) {
        // Same holder, still live: keep epoch, refresh heartbeat.
        this.db
          .prepare(
            `UPDATE leases SET node_id = ?, heartbeat_at = ?, ttl_ms = ? WHERE repo_id = ?`,
          )
          .run(node, nowIso, this.ttlMs, repoId);
        this.db.exec('COMMIT');
        return rowToLease(this.getRow(repoId) as LeaseRow);
      }

      // Live lease held by someone else.
      this.db.exec('COMMIT');
      return null;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Refresh heartbeat only if `holderId` still holds a live lease. */
  heartbeat(repoId: string, holderId: string, now?: Date): boolean {
    const at = now ?? new Date();
    const nowMs = at.getTime();
    const existing = this.getRow(repoId);
    if (existing === undefined || existing.holder_id !== holderId) return false;
    if (isExpired(existing, nowMs)) return false;
    this.db
      .prepare(`UPDATE leases SET heartbeat_at = ? WHERE repo_id = ? AND holder_id = ?`)
      .run(at.toISOString(), repoId, holderId);
    return true;
  }

  /**
   * Release the lease iff held by `holderId` (no-op otherwise). The row is NOT
   * deleted: we expire it in place (heartbeat pushed to the epoch) so the epoch
   * counter is retained. Keeping epoch monotonic across release/re-acquire means
   * a stale token from the released holder can never match a future epoch — a
   * reset-to-1 would let an old epoch-1 zombie pass the fence.
   */
  release(repoId: string, holderId: string): void {
    // Set heartbeat to the unix epoch so current()/acquire() treat it as expired
    // immediately, while preserving the epoch column for monotonicity.
    this.db
      .prepare(
        `UPDATE leases SET heartbeat_at = ? WHERE repo_id = ? AND holder_id = ?`,
      )
      .run(new Date(0).toISOString(), repoId, holderId);
  }

  /** The current live lease, or null if none / expired. */
  current(repoId: string, now?: Date): Lease | null {
    const nowMs = (now ?? new Date()).getTime();
    const row = this.getRow(repoId);
    if (row === undefined || isExpired(row, nowMs)) return null;
    return rowToLease(row);
  }

  /** Fencing check: true iff a live lease exists with matching epoch. */
  isCurrentEpoch(repoId: string, epoch: number, now?: Date): boolean {
    const cur = this.current(repoId, now);
    return cur !== null && cur.epoch === epoch;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Stable per-machine node id: sha256(hostname + persisted-random)[:16], hex.
 * The random component is persisted under ~/.lunaris/node-id so the id is
 * stable across runs on a machine but not guessable from the hostname alone.
 * Falls back to an ephemeral random id if the home dir is unwritable.
 */
export function stableNodeId(): string {
  const dir = join(homedir(), '.lunaris');
  const file = join(dir, 'node-id');
  let seed: string;
  try {
    if (existsSync(file)) {
      seed = readFileSync(file, 'utf8').trim();
    } else {
      seed = randomBytes(16).toString('hex');
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, seed, { mode: 0o600 });
    }
  } catch {
    seed = randomBytes(16).toString('hex');
  }
  const digest = createHash('sha256').update(`${hostname()}:${seed}`).digest('hex');
  return `node_${digest.slice(0, 16)}`;
}
