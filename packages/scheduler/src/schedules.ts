/**
 * SqliteScheduleStore: CRUD over cron schedules, backed by node:sqlite
 * (DatabaseSync, WAL for file-backed stores).
 *
 * nextRunAt is derived from the cron expression via cron.nextRun on every
 * create/update and after each firing (markFired). dueSchedules(now) returns the
 * enabled schedules whose nextRunAt has arrived (<= now). tick(now, enqueue)
 * fires each due schedule: it renders the schedule's prompt (inline or via a
 * GoalTemplate) and calls the injected enqueue, then markFired advances the
 * schedule. All I/O goes through the injected stores + enqueue — this module
 * touches no queue or template tables directly.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { uuidv7 } from '@lunaris/core';
import type { Schedule } from '@lunaris/core';
import { nextRun } from './cron.js';
import { renderTemplate, type SqliteTemplateStore } from './templates.js';

interface ScheduleRow {
  id: string;
  project_id: string;
  cron: string;
  template_id: string | null;
  prompt: string | null;
  vars: string | null;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
}

function rowToSchedule(row: ScheduleRow): Schedule {
  const s: Schedule = {
    id: row.id,
    projectId: row.project_id,
    cron: row.cron,
    enabled: row.enabled !== 0,
  };
  if (row.template_id !== null) s.templateId = row.template_id;
  if (row.prompt !== null) s.prompt = row.prompt;
  if (row.vars !== null) s.vars = JSON.parse(row.vars) as Record<string, string>;
  if (row.last_run_at !== null) s.lastRunAt = row.last_run_at;
  if (row.next_run_at !== null) s.nextRunAt = row.next_run_at;
  return s;
}

export interface CreateScheduleInput {
  projectId: string;
  cron: string;
  templateId?: string;
  prompt?: string;
  vars?: Record<string, string>;
  enabled?: boolean;
}

/** Enqueue callback injected into tick(): how a fired schedule reaches the queue. */
export type EnqueueFn = (projectId: string, prompt: string, source: string) => void;

export interface ScheduleStoreOptions {
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Optional template store, required to render schedules that use templateId. */
  templates?: SqliteTemplateStore;
}

export class SqliteScheduleStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly templates: SqliteTemplateStore | undefined;

  /** @param dbPath sqlite file path (parent dirs created) or ':memory:'. */
  constructor(dbPath: string, opts: ScheduleStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.templates = opts.templates;
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        cron        TEXT NOT NULL,
        template_id TEXT,
        prompt      TEXT,
        vars        TEXT,
        enabled     INTEGER NOT NULL,
        last_run_at TEXT,
        next_run_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_schedules_project ON schedules (project_id, id);
      CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules (enabled, next_run_at);
    `);
  }

  create(input: CreateScheduleInput): Schedule {
    const enabled = input.enabled ?? true;
    // Compute the first run from now; nextRun() returns the first match strictly after.
    const nextRunAt = nextRun(input.cron, this.now()).toISOString();
    const s: Schedule = {
      id: uuidv7(),
      projectId: input.projectId,
      cron: input.cron,
      enabled,
      nextRunAt,
    };
    if (input.templateId !== undefined) s.templateId = input.templateId;
    if (input.prompt !== undefined) s.prompt = input.prompt;
    if (input.vars !== undefined) s.vars = input.vars;

    this.db
      .prepare(
        `INSERT INTO schedules
           (id, project_id, cron, template_id, prompt, vars, enabled, last_run_at, next_run_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        s.id,
        s.projectId,
        s.cron,
        s.templateId ?? null,
        s.prompt ?? null,
        s.vars !== undefined ? JSON.stringify(s.vars) : null,
        enabled ? 1 : 0,
        nextRunAt,
      );
    return s;
  }

  get(id: string): Schedule | undefined {
    const row = this.db
      .prepare(`SELECT * FROM schedules WHERE id = ?`)
      .get(id) as unknown as ScheduleRow | undefined;
    return row ? rowToSchedule(row) : undefined;
  }

  list(projectId?: string): Schedule[] {
    const whereSql = projectId !== undefined ? 'WHERE project_id = ?' : '';
    const params = projectId !== undefined ? [projectId] : [];
    const rows = this.db
      .prepare(`SELECT * FROM schedules ${whereSql} ORDER BY id ASC`)
      .all(...params) as unknown as ScheduleRow[];
    return rows.map(rowToSchedule);
  }

  /**
   * Patch a schedule. If the cron expression changes, nextRunAt is recomputed
   * from now. Returns the updated schedule, or undefined if unknown.
   */
  update(
    id: string,
    patch: Partial<Pick<Schedule, 'cron' | 'templateId' | 'prompt' | 'vars' | 'enabled'>>,
  ): Schedule | undefined {
    const existing = this.get(id);
    if (existing === undefined) return undefined;

    const next: Schedule = { ...existing };
    if (patch.cron !== undefined) next.cron = patch.cron;
    if (patch.templateId !== undefined) next.templateId = patch.templateId;
    if (patch.prompt !== undefined) next.prompt = patch.prompt;
    if (patch.vars !== undefined) next.vars = patch.vars;
    if (patch.enabled !== undefined) next.enabled = patch.enabled;

    // Recompute the next run whenever the cron expression changes.
    if (patch.cron !== undefined) {
      next.nextRunAt = nextRun(next.cron, this.now()).toISOString();
    }

    this.db
      .prepare(
        `UPDATE schedules
            SET cron = ?, template_id = ?, prompt = ?, vars = ?, enabled = ?, next_run_at = ?
          WHERE id = ?`,
      )
      .run(
        next.cron,
        next.templateId ?? null,
        next.prompt ?? null,
        next.vars !== undefined ? JSON.stringify(next.vars) : null,
        next.enabled ? 1 : 0,
        next.nextRunAt ?? null,
        id,
      );
    return next;
  }

  /** Returns true if a row was deleted. */
  delete(id: string): boolean {
    const res = this.db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id);
    return res.changes > 0;
  }

  /** Enabled schedules whose nextRunAt has arrived (<= now), oldest-due first. */
  dueSchedules(now?: Date): Schedule[] {
    const nowIso = (now ?? this.now()).toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM schedules
          WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
          ORDER BY next_run_at ASC`,
      )
      .all(nowIso) as unknown as ScheduleRow[];
    return rows.map(rowToSchedule);
  }

  /**
   * Record a firing: set lastRunAt = now and recompute nextRunAt from the cron
   * expression (strictly after now, so a schedule never re-fires on the same
   * minute within one tick). Returns the updated schedule, or undefined.
   */
  markFired(id: string, now?: Date): Schedule | undefined {
    const existing = this.get(id);
    if (existing === undefined) return undefined;
    const fireTime = now ?? this.now();
    const lastRunAt = fireTime.toISOString();
    const nextRunAt = nextRun(existing.cron, fireTime).toISOString();
    this.db
      .prepare(`UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?`)
      .run(lastRunAt, nextRunAt, id);
    const updated: Schedule = { ...existing, lastRunAt, nextRunAt };
    return updated;
  }

  /**
   * Resolve a schedule's prompt: render the linked template (if any) else the
   * inline prompt, filling {{var}} placeholders from the schedule's vars.
   * Returns null when the schedule has neither a renderable template nor an
   * inline prompt (a misconfigured schedule, which tick() skips).
   */
  resolvePrompt(s: Schedule): string | null {
    const vars = s.vars ?? {};
    if (s.templateId !== undefined && this.templates !== undefined) {
      const tpl = this.templates.get(s.templateId);
      if (tpl !== undefined) return renderTemplate(tpl.promptTemplate, vars);
    }
    if (s.prompt !== undefined) return renderTemplate(s.prompt, vars);
    return null;
  }

  /**
   * Fire all due schedules: for each, resolve its prompt and call enqueue with
   * source `schedule:<id>`, then markFired to advance nextRunAt. A schedule that
   * resolves to no prompt is skipped (but still marked fired, so it doesn't jam
   * the due set). Returns the number of schedules that enqueued a goal.
   *
   * Each schedule is isolated: if enqueue (or resolve) throws for one schedule,
   * the error is swallowed and we continue with the remaining due schedules. A
   * schedule whose enqueue failed is NOT marked fired, so it stays due and can
   * retry on the next tick — but one failure never aborts the whole batch.
   */
  tick(now: Date, enqueue: EnqueueFn): number {
    let fired = 0;
    for (const s of this.dueSchedules(now)) {
      try {
        const prompt = this.resolvePrompt(s);
        if (prompt !== null) {
          enqueue(s.projectId, prompt, `schedule:${s.id}`);
          fired++;
        }
        // Only advance the schedule once its enqueue (if any) succeeded.
        this.markFired(s.id, now);
      } catch {
        // Swallow and continue: a failing schedule must not skip the others and
        // is left un-fired so it can retry next tick.
      }
    }
    return fired;
  }

  close(): void {
    this.db.close();
  }
}
