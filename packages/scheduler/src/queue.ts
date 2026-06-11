/**
 * SqliteGoalQueue: durable, priority-ordered goal queue backed by node:sqlite
 * (DatabaseSync). WAL mode for file-backed stores, matching SqliteEventStore /
 * SqliteApprovalQueue.
 *
 * Leasing is ATOMIC: lease() runs a single UPDATE whose WHERE clause selects the
 * one eligible row (highest priority, then oldest), so two concurrent ticks can
 * never lease the same row — the second UPDATE matches zero rows. node:sqlite's
 * synchronous, serialized statement execution plus WAL make this safe in-process.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { uuidv7 } from '@lunaris/core';
import type { GoalQueue, QueuedGoal, QueuedGoalStatus } from '@lunaris/core';

interface GoalRow {
  id: string;
  project_id: string;
  prompt: string;
  priority: number;
  status: QueuedGoalStatus;
  source: string;
  not_before: string | null;
  attempts: number;
  max_attempts: number;
  created_at: string;
  leased_at: string | null;
  goal_id: string | null;
  last_error: string | null;
}

function rowToGoal(row: GoalRow): QueuedGoal {
  const g: QueuedGoal = {
    id: row.id,
    projectId: row.project_id,
    prompt: row.prompt,
    priority: row.priority,
    status: row.status,
    source: row.source,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
  };
  if (row.not_before !== null) g.notBefore = row.not_before;
  if (row.leased_at !== null) g.leasedAt = row.leased_at;
  if (row.goal_id !== null) g.goalId = row.goal_id;
  if (row.last_error !== null) g.lastError = row.last_error;
  return g;
}

export interface SqliteGoalQueueOptions {
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /**
   * Backoff in ms applied to notBefore on a retry. May be a constant or a fn of
   * the new attempt count. Default 0 (retry immediately eligible).
   */
  retryBackoffMs?: number | ((attempts: number) => number);
}

export class SqliteGoalQueue implements GoalQueue {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly retryBackoffMs: number | ((attempts: number) => number);

  /** @param dbPath sqlite file path (parent dirs created) or ':memory:'. */
  constructor(dbPath: string, opts: SqliteGoalQueueOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.retryBackoffMs = opts.retryBackoffMs ?? 0;
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS queued_goals (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL,
        prompt       TEXT NOT NULL,
        priority     INTEGER NOT NULL,
        status       TEXT NOT NULL,
        source       TEXT NOT NULL,
        not_before   TEXT,
        attempts     INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        created_at   TEXT NOT NULL,
        leased_at    TEXT,
        goal_id      TEXT,
        last_error   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_queued_status ON queued_goals (status, priority, id);
      CREATE INDEX IF NOT EXISTS idx_queued_project ON queued_goals (project_id, id);
    `);
  }

  // `priority` and `maxAttempts` are optional here (defaults 0 / 1). This widens
  // the GoalQueue.push input — a method accepting a superset of inputs still
  // structurally implements the interface — so callers may omit them.
  push(
    g: Omit<QueuedGoal, 'id' | 'status' | 'attempts' | 'createdAt' | 'priority' | 'maxAttempts'> & {
      priority?: number;
      maxAttempts?: number;
    },
  ): QueuedGoal {
    const goal: QueuedGoal = {
      id: uuidv7(),
      projectId: g.projectId,
      prompt: g.prompt,
      priority: g.priority ?? 0,
      status: 'queued',
      source: g.source,
      attempts: 0,
      maxAttempts: g.maxAttempts ?? 1,
      createdAt: this.now().toISOString(),
    };
    if (g.notBefore !== undefined) goal.notBefore = g.notBefore;
    if (g.goalId !== undefined) goal.goalId = g.goalId;
    if (g.lastError !== undefined) goal.lastError = g.lastError;

    this.db
      .prepare(
        `INSERT INTO queued_goals
           (id, project_id, prompt, priority, status, source, not_before,
            attempts, max_attempts, created_at, leased_at, goal_id, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        goal.id,
        goal.projectId,
        goal.prompt,
        goal.priority,
        goal.status,
        goal.source,
        goal.notBefore ?? null,
        goal.attempts,
        goal.maxAttempts,
        goal.createdAt,
        goal.goalId ?? null,
        goal.lastError ?? null,
      );
    return goal;
  }

  /**
   * Atomically lease the highest-priority eligible goal. Eligible = status
   * 'queued' AND (not_before IS NULL OR not_before <= now). The whole select +
   * mutate is a single UPDATE so concurrent ticks cannot lease the same row.
   */
  lease(now?: Date): QueuedGoal | null {
    const nowIso = (now ?? this.now()).toISOString();
    // ORDER BY priority DESC then id ASC (id is UUIDv7, so ascending = oldest first).
    const row = this.db
      .prepare(
        `UPDATE queued_goals
            SET status = 'leased', leased_at = ?, attempts = attempts + 1
          WHERE id = (
            SELECT id FROM queued_goals
             WHERE status = 'queued'
               AND (not_before IS NULL OR not_before <= ?)
             ORDER BY priority DESC, id ASC
             LIMIT 1
          )
        RETURNING *`,
      )
      .get(nowIso, nowIso) as unknown as GoalRow | undefined;
    return row ? rowToGoal(row) : null;
  }

  /** Mark a leased goal done and record the orchestrator run id it produced. */
  complete(id: string, goalId: string): void {
    this.db
      .prepare(`UPDATE queued_goals SET status = 'done', goal_id = ? WHERE id = ?`)
      .run(goalId, id);
  }

  /**
   * Fail a leased goal. If retry is requested AND attempts remain
   * (attempts < maxAttempts) the goal returns to 'queued' (with an optional
   * backoff notBefore); otherwise it becomes 'dead'. The error is recorded.
   */
  fail(id: string, retry: boolean, error?: string): void {
    const cur = this.db
      .prepare(`SELECT * FROM queued_goals WHERE id = ?`)
      .get(id) as unknown as GoalRow | undefined;
    if (cur === undefined) return;

    const canRetry = retry && cur.attempts < cur.max_attempts;
    if (canRetry) {
      const backoff =
        typeof this.retryBackoffMs === 'function'
          ? this.retryBackoffMs(cur.attempts)
          : this.retryBackoffMs;
      const notBefore =
        backoff > 0 ? new Date(this.now().getTime() + backoff).toISOString() : null;
      this.db
        .prepare(
          `UPDATE queued_goals
              SET status = 'queued', leased_at = NULL, not_before = ?, last_error = ?
            WHERE id = ?`,
        )
        .run(notBefore, error ?? null, id);
    } else {
      this.db
        .prepare(`UPDATE queued_goals SET status = 'dead', last_error = ? WHERE id = ?`)
        .run(error ?? null, id);
    }
  }

  get(id: string): QueuedGoal | undefined {
    const row = this.db
      .prepare(`SELECT * FROM queued_goals WHERE id = ?`)
      .get(id) as unknown as GoalRow | undefined;
    return row ? rowToGoal(row) : undefined;
  }

  list(projectId?: string, status?: QueuedGoalStatus): QueuedGoal[] {
    const where: string[] = [];
    const params: string[] = [];
    if (projectId !== undefined) {
      where.push('project_id = ?');
      params.push(projectId);
    }
    if (status !== undefined) {
      where.push('status = ?');
      params.push(status);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    // Highest priority first, then oldest first (id ASC = chronological).
    const rows = this.db
      .prepare(`SELECT * FROM queued_goals ${whereSql} ORDER BY priority DESC, id ASC`)
      .all(...params) as unknown as GoalRow[];
    return rows.map(rowToGoal);
  }

  close(): void {
    this.db.close();
  }
}
