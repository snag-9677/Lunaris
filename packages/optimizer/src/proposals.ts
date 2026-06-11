/**
 * SqliteProposalStore + proposal generation. Propose-only (spec v1): the
 * optimizer NEVER writes a config file. It mints durable, human-reviewable
 * ConfigProposals (table proposals, uuidv7 ids, WAL for file-backed stores —
 * matching SqliteApprovalQueue) that a human approves/rejects out of band.
 *
 * Two proposal sources:
 *  - routing: from RoutingSuggestions — "route <taskClass> to <model>" with a
 *    readable routing-table diff and the success/cost evidence.
 *  - capability: from recurring tool-failure patterns visible in the stats /
 *    outcomes — surfaced as "investigate tool X" advisories.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { uuidv7 } from '@lunaris/core';
import type {
  ConfigProposal,
  OutcomeStats,
  ProposalKind,
  RoutingSuggestion,
} from '@lunaris/core';

export interface CreateProposalInput {
  projectId: string;
  kind: ProposalKind;
  title: string;
  detail: string;
  diff?: string;
  confidence: number;
  /** Injectable clock for deterministic tests. */
  createdAt?: string;
}

interface ProposalRow {
  id: string;
  project_id: string;
  kind: string;
  title: string;
  detail: string;
  diff: string | null;
  status: ConfigProposal['status'];
  created_at: string;
  confidence: number;
}

function rowToProposal(row: ProposalRow): ConfigProposal {
  const p: ConfigProposal = {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as ProposalKind,
    title: row.title,
    detail: row.detail,
    status: row.status,
    createdAt: row.created_at,
    confidence: row.confidence,
  };
  if (row.diff !== null) p.diff = row.diff;
  return p;
}

export class SqliteProposalStore {
  private readonly db: DatabaseSync;

  /** @param dbPath sqlite file path (parent dirs created) or ':memory:'. */
  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proposals (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        kind        TEXT NOT NULL,
        title       TEXT NOT NULL,
        detail      TEXT NOT NULL,
        diff        TEXT,
        status      TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        confidence  REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_proposals_project ON proposals (project_id, id);
      CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals (status, id);
    `);
  }

  /** Mint a pending proposal. */
  create(input: CreateProposalInput): ConfigProposal {
    const proposal: ConfigProposal = {
      id: uuidv7(),
      projectId: input.projectId,
      kind: input.kind,
      title: input.title,
      detail: input.detail,
      status: 'pending',
      createdAt: input.createdAt ?? new Date().toISOString(),
      confidence: input.confidence,
    };
    if (input.diff !== undefined) proposal.diff = input.diff;

    this.db
      .prepare(
        `INSERT INTO proposals (id, project_id, kind, title, detail, diff, status, created_at, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        proposal.id,
        proposal.projectId,
        proposal.kind,
        proposal.title,
        proposal.detail,
        proposal.diff ?? null,
        proposal.status,
        proposal.createdAt,
        proposal.confidence,
      );
    return proposal;
  }

  get(id: string): ConfigProposal | undefined {
    const row = this.db
      .prepare(`SELECT * FROM proposals WHERE id = ?`)
      .get(id) as unknown as ProposalRow | undefined;
    return row ? rowToProposal(row) : undefined;
  }

  /** List proposals, optionally filtered by project and/or status; newest first. */
  list(projectId?: string, status?: ConfigProposal['status']): ConfigProposal[] {
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
      .prepare(`SELECT * FROM proposals ${whereSql} ORDER BY id DESC`)
      .all(...params) as unknown as ProposalRow[];
    return rows.map(rowToProposal);
  }

  /**
   * Resolve a pending proposal: approved=true => 'approved', false =>
   * 'rejected'. Unknown id => undefined; already-resolved => returned unchanged.
   * (Approval is recorded only — v1 never auto-applies.)
   */
  resolve(id: string, approved: boolean): ConfigProposal | undefined {
    const existing = this.get(id);
    if (existing === undefined) return undefined;
    if (existing.status !== 'pending') return existing;
    const status: ConfigProposal['status'] = approved ? 'approved' : 'rejected';
    this.db.prepare(`UPDATE proposals SET status = ? WHERE id = ?`).run(status, id);
    return this.get(id);
  }

  close(): void {
    this.db.close();
  }
}

/** Minimum failed tool-call observations before flagging a capability concern. */
const CAPABILITY_MIN_FAILURES = 3;

/**
 * Build (but do not persist) ConfigProposals from stats + routing suggestions.
 * Persisting is the caller's job (runOptimizer feeds these to a store), keeping
 * generation pure and testable.
 *
 * Routing proposals describe the suggested routing-table change as a readable
 * diff. Capability proposals call out task classes whose measured success rate
 * is poor despite enough samples — a recurring-failure pattern worth a human
 * looking at tools/prompts for that class.
 */
export function generateProposals(
  stats: OutcomeStats[],
  suggestions: RoutingSuggestion[],
  projectId: string,
  createdAt?: string,
): ConfigProposal[] {
  const proposals: ConfigProposal[] = [];

  for (const s of suggestions) {
    proposals.push({
      // Placeholder id/status; SqliteProposalStore.create mints the real id.
      id: '',
      projectId,
      kind: 'routing',
      title: `Route ${s.taskClass} tasks to ${s.recommendedModel}`,
      detail: `For task class "${s.taskClass}", ${s.recommendedModel} is the best-performing model: ${s.rationale}. Based on ${s.basedOnN} observations.`,
      diff: routingDiff(s, stats),
      status: 'pending',
      createdAt: createdAt ?? new Date().toISOString(),
      confidence: s.confidence,
    });
  }

  // Capability concerns: a task class whose best-sampled model still has a poor
  // Wilson lower-bound success rate is a recurring-failure pattern.
  const byClass = new Map<string, OutcomeStats[]>();
  for (const s of stats) {
    const list = byClass.get(s.taskClass) ?? [];
    list.push(s);
    byClass.set(s.taskClass, list);
  }
  for (const [taskClass, group] of byClass) {
    const totalN = group.reduce((acc, g) => acc + g.n, 0);
    const totalFailures = group.reduce((acc, g) => acc + (g.n - g.successes), 0);
    if (totalFailures < CAPABILITY_MIN_FAILURES) continue;
    const best = group.reduce((a, b) => (b.successRate > a.successRate ? b : a));
    if (best.successRate >= 0.5) continue; // even the best model struggles here.
    proposals.push({
      id: '',
      projectId,
      kind: 'capability',
      title: `Investigate recurring failures in ${taskClass} tasks`,
      detail: `Task class "${taskClass}" failed ${totalFailures}/${totalN} non-infra runs; best model ${best.model} only reaches a ${(best.successRate * 100).toFixed(1)}% Wilson lower-bound success rate. Review the tool allowlist and role prompt for this class.`,
      status: 'pending',
      createdAt: createdAt ?? new Date().toISOString(),
      confidence: clampConfidenceFromFailures(totalFailures, totalN),
    });
  }

  return proposals;
}

function routingDiff(s: RoutingSuggestion, stats: OutcomeStats[]): string {
  const match = stats.find(
    (st) => st.taskClass === s.taskClass && st.model === s.recommendedModel,
  );
  const evidence =
    match !== undefined
      ? `success ${(match.successRate * 100).toFixed(1)}% @ $${match.avgCostUsd.toFixed(4)}/task`
      : `confidence ${(s.confidence * 100).toFixed(0)}%`;
  return [
    `# lunaris.toml [models.roles] (proposed)`,
    `- ${s.taskClass} = <project default>`,
    `+ ${s.taskClass} = "${s.recommendedModel}"  # ${evidence}`,
  ].join('\n');
}

function clampConfidenceFromFailures(failures: number, n: number): number {
  if (n <= 0) return 0;
  const rate = failures / n;
  return Math.max(0, Math.min(1, rate));
}
