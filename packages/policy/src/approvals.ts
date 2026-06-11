/**
 * SqliteApprovalQueue: durable approval queue for tool calls the PDP routed to
 * 'queue'. Tickets are minted pending and resolved out-of-band by a human (or a
 * higher-trust agent). Backed by node:sqlite (DatabaseSync), matching the
 * SqliteEventStore pattern (WAL for file-backed stores).
 *
 * Staleness guard (spec §6): a ticket records the plan epoch at queue time. If
 * the world has moved on (currentPlanEpoch != ticket.planEpoch) by the time it
 * resolves, the resolution is rejected and the ticket is marked 'stale' rather
 * than silently approving an action against an outdated plan.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { uuidv7 } from '@lunaris/core';
import type { ApprovalTicket, AutonomyLevel, PolicyRule } from '@lunaris/core';
import { RulePolicyEngine } from './policy.js';

export interface CreateTicketInput {
  projectId: string;
  tool: string;
  args: unknown;
  reason: string;
  /** Plan epoch at queue time, for the staleness guard. */
  planEpoch?: number;
}

interface TicketRow {
  ticket_id: string;
  project_id: string;
  tool: string;
  args: string;
  reason: string;
  created_at: string;
  status: ApprovalTicket['status'];
  resolved_at: string | null;
  resolved_by: string | null;
  plan_epoch: number | null;
}

function rowToTicket(row: TicketRow): ApprovalTicket {
  const t: ApprovalTicket = {
    ticketId: row.ticket_id,
    projectId: row.project_id,
    tool: row.tool,
    args: JSON.parse(row.args) as unknown,
    reason: row.reason,
    createdAt: row.created_at,
    status: row.status,
  };
  if (row.resolved_at !== null) t.resolvedAt = row.resolved_at;
  if (row.resolved_by !== null) t.resolvedBy = row.resolved_by;
  if (row.plan_epoch !== null) t.planEpoch = row.plan_epoch;
  return t;
}

export class SqliteApprovalQueue {
  private readonly db: DatabaseSync;

  /** @param dbPath sqlite file path (parent dirs created) or ':memory:'. */
  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        ticket_id   TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        tool        TEXT NOT NULL,
        args        TEXT NOT NULL,
        reason      TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        status      TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        plan_epoch  INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_project ON approvals (project_id, ticket_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals (status, ticket_id);
    `);
  }

  /** Mint a pending ticket. */
  create(input: CreateTicketInput): ApprovalTicket {
    const ticket: ApprovalTicket = {
      ticketId: uuidv7(),
      projectId: input.projectId,
      tool: input.tool,
      args: input.args,
      reason: input.reason,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };
    if (input.planEpoch !== undefined) ticket.planEpoch = input.planEpoch;

    this.db
      .prepare(
        `INSERT INTO approvals
           (ticket_id, project_id, tool, args, reason, created_at, status, resolved_at, resolved_by, plan_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        ticket.ticketId,
        ticket.projectId,
        ticket.tool,
        JSON.stringify(ticket.args ?? null),
        ticket.reason,
        ticket.createdAt,
        ticket.status,
        ticket.planEpoch ?? null,
      );
    return ticket;
  }

  get(ticketId: string): ApprovalTicket | undefined {
    const row = this.db
      .prepare(`SELECT * FROM approvals WHERE ticket_id = ?`)
      .get(ticketId) as unknown as TicketRow | undefined;
    return row ? rowToTicket(row) : undefined;
  }

  /** List tickets, optionally filtered by project and/or status; newest first. */
  list(projectId?: string, status?: ApprovalTicket['status']): ApprovalTicket[] {
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
    const rows = this.db
      .prepare(`SELECT * FROM approvals ${whereSql} ORDER BY ticket_id DESC`)
      .all(...params) as unknown as TicketRow[];
    return rows.map(rowToTicket);
  }

  /**
   * Resolve a pending ticket.
   *  - Unknown ticket → undefined.
   *  - Already resolved (not pending) → returned unchanged.
   *  - Staleness guard: if the ticket carries a planEpoch AND a currentPlanEpoch
   *    is supplied AND they differ, the ticket is marked 'stale' and returned;
   *    the requested approve/deny is NOT applied.
   *  - Otherwise marks 'approved' or 'denied'.
   */
  resolve(
    ticketId: string,
    approved: boolean,
    by: string,
    currentPlanEpoch?: number,
  ): ApprovalTicket | undefined {
    const existing = this.get(ticketId);
    if (existing === undefined) return undefined;
    if (existing.status !== 'pending') return existing;

    const resolvedAt = new Date().toISOString();

    if (
      existing.planEpoch !== undefined &&
      currentPlanEpoch !== undefined &&
      currentPlanEpoch !== existing.planEpoch
    ) {
      this.db
        .prepare(
          `UPDATE approvals SET status = 'stale', resolved_at = ?, resolved_by = ? WHERE ticket_id = ?`,
        )
        .run(resolvedAt, by, ticketId);
      return this.get(ticketId);
    }

    const status: ApprovalTicket['status'] = approved ? 'approved' : 'denied';
    this.db
      .prepare(
        `UPDATE approvals SET status = ?, resolved_at = ?, resolved_by = ? WHERE ticket_id = ?`,
      )
      .run(status, resolvedAt, by, ticketId);
    return this.get(ticketId);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Sensible starter rule set for a given autonomy level. These are *additive*
 * conveniences layered on top of the level defaults baked into the engine:
 * mostly explicit allows for cheap, safe read tools, plus a belt-and-braces
 * deny of secret-adjacent tools under taint. The level default still governs
 * anything not named here, and the irreversible-class overlay still applies.
 */
export function defaultPolicyRules(level: AutonomyLevel): PolicyRule[] {
  const rules: PolicyRule[] = [
    // Secret-adjacent tools are denied whenever the context is tainted, at every level.
    {
      effect: 'deny',
      tools: ['read_secret', 'get_secret', 'read_env', 'dump_env'],
      whenTainted: true,
      reason: 'secret-adjacent tool blocked under taint',
    },
  ];
  if (level >= 1) {
    // Reads/searches/list are always fine on supervised+ (the L0 default already allows them).
    rules.push({
      effect: 'allow',
      tools: ['read_file', 'list_dir', 'search'],
      reason: 'read-only tools are always allowed',
    });
  }
  return rules;
}

/** Factory: a ready-to-use PDP for a level, plus the rule set it was built from. */
export function defaultPolicy(level: AutonomyLevel): {
  level: AutonomyLevel;
  rules: PolicyRule[];
  engine: RulePolicyEngine;
} {
  const rules = defaultPolicyRules(level);
  const engine = new RulePolicyEngine({ level, rules });
  return { level, rules, engine };
}
