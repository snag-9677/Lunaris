/**
 * Analytics rollups over the Phase 1 event spine (see events.ts).
 *
 * computeAnalytics aggregates a project's events into a ProjectAnalytics
 * snapshot; costSeries buckets llm.call spend into a time series for charts.
 *
 * Either accepts a live EventStore (read via query) or a sqlite db path
 * (opened read-only for SQL aggregation against the real events schema).
 */
import { DatabaseSync } from 'node:sqlite';
import type { EventStore, ModelUsageRow, ProjectAnalytics } from './types.js';

/** Pull more than the default query limit so rollups see the full history. */
const SCAN_LIMIT = 1_000_000;
const EPOCH = '1970-01-01T00:00:00.000Z';

interface EventRow {
  ts: string;
  kind: string;
  payload: string;
}

/** Goal terminal/lifecycle payloads carry the originating goalId. */
interface GoalPayload {
  goalId?: string;
}

interface UsagePayload {
  inputTokens?: unknown;
  outputTokens?: unknown;
  costUsd?: unknown;
}

interface LlmCallPayload {
  model?: unknown;
  usage?: UsagePayload;
}

interface ToolCallPayload {
  ok?: unknown;
  error?: unknown;
}

/** Coerce an unknown numeric payload field to a finite number, else 0. */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function asGoalId(payload: unknown): string | undefined {
  if (payload !== null && typeof payload === 'object') {
    const id = (payload as GoalPayload).goalId;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return undefined;
}

/**
 * Read a project's events as lightweight rows (ts, kind, payload string),
 * oldest-first. When given a db path we aggregate via SQL for efficiency;
 * when given a live store we go through its query API.
 */
function readRows(source: EventStore | string, projectId: string, sinceIso: string): EventRow[] {
  if (typeof source === 'string') {
    const db = new DatabaseSync(source, { readOnly: true });
    try {
      return db
        .prepare(
          `SELECT ts, kind, payload
             FROM events
            WHERE project_id = ? AND ts >= ?
            ORDER BY event_id ASC`,
        )
        .all(projectId, sinceIso) as unknown as EventRow[];
    } finally {
      db.close();
    }
  }
  // Live store: query newest-first, then narrow to project/since and reverse
  // to oldest-first so deterministic ordering matches the SQL path.
  const events = source.query({ projectId, limit: SCAN_LIMIT });
  const rows: EventRow[] = [];
  for (const e of events) {
    if (e.ts < sinceIso) continue;
    rows.push({ ts: e.ts, kind: e.kind, payload: JSON.stringify(e.payload ?? null) });
  }
  rows.reverse();
  return rows;
}

function parsePayload(row: EventRow): unknown {
  try {
    return JSON.parse(row.payload) as unknown;
  } catch {
    return null;
  }
}

/**
 * Aggregate a project's events into a ProjectAnalytics snapshot.
 *
 * goals.running = goal.created goalIds with no matching goal.done/goal.failed.
 * llm totals + byModel are summed from llm.call usage (missing fields => 0).
 * tools.failures counts tool.call events where ok === false or an error field
 * is present.
 *
 * @param sinceIso ISO lower bound (inclusive); defaults to the epoch.
 */
export function computeAnalytics(
  source: EventStore | string,
  projectId: string,
  sinceIso?: string,
): ProjectAnalytics {
  const since = sinceIso ?? EPOCH;
  const rows = readRows(source, projectId, since);

  const createdGoals = new Set<string>();
  const doneGoals = new Set<string>();
  const failedGoals = new Set<string>();

  let llmCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  const byModel = new Map<string, ModelUsageRow>();

  let toolCalls = 0;
  let toolFailures = 0;

  for (const row of rows) {
    switch (row.kind) {
      case 'goal.created': {
        const id = asGoalId(parsePayload(row));
        if (id !== undefined) createdGoals.add(id);
        break;
      }
      case 'goal.done': {
        const id = asGoalId(parsePayload(row));
        if (id !== undefined) doneGoals.add(id);
        break;
      }
      case 'goal.failed': {
        const id = asGoalId(parsePayload(row));
        if (id !== undefined) failedGoals.add(id);
        break;
      }
      case 'llm.call': {
        const payload = parsePayload(row) as LlmCallPayload | null;
        const usage = payload?.usage ?? {};
        const inTok = num(usage.inputTokens);
        const outTok = num(usage.outputTokens);
        const cost = num(usage.costUsd);
        llmCalls += 1;
        inputTokens += inTok;
        outputTokens += outTok;
        costUsd += cost;
        const model = typeof payload?.model === 'string' ? payload.model : 'unknown';
        const acc = byModel.get(model) ?? {
          model,
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        };
        acc.calls += 1;
        acc.inputTokens += inTok;
        acc.outputTokens += outTok;
        acc.costUsd += cost;
        byModel.set(model, acc);
        break;
      }
      case 'tool.call': {
        const payload = parsePayload(row) as ToolCallPayload | null;
        toolCalls += 1;
        const failed =
          payload?.ok === false ||
          (payload?.error !== undefined && payload.error !== null);
        if (failed) toolFailures += 1;
        break;
      }
      default:
        break;
    }
  }

  const done = countMembers(createdGoals, doneGoals);
  const failed = countMembers(createdGoals, failedGoals);
  const terminal = new Set<string>([...doneGoals, ...failedGoals]);
  let running = 0;
  for (const id of createdGoals) {
    if (!terminal.has(id)) running += 1;
  }

  return {
    projectId,
    since,
    goals: { total: createdGoals.size, done, failed, running },
    llm: { calls: llmCalls, inputTokens, outputTokens, costUsd },
    byModel: [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd),
    tools: { calls: toolCalls, failures: toolFailures },
  };
}

/** Count terminal-marked goals that were actually created in-window. */
function countMembers(created: Set<string>, terminal: Set<string>): number {
  let n = 0;
  for (const id of terminal) {
    if (created.has(id)) n += 1;
  }
  return n;
}

export interface CostBucket {
  /** Bucket key: 'YYYY-MM-DDTHH' for hour, 'YYYY-MM-DD' for day (UTC). */
  bucket: string;
  costUsd: number;
  calls: number;
}

/** Derive the UTC bucket key for an ISO timestamp. */
function bucketKey(ts: string, bucket: 'hour' | 'day'): string {
  // ISO 8601 is already UTC-lexicographic: slice off the prefix we need.
  // 'YYYY-MM-DDTHH' = 13 chars; 'YYYY-MM-DD' = 10 chars.
  return bucket === 'hour' ? ts.slice(0, 13) : ts.slice(0, 10);
}

/**
 * Bucket llm.call spend into a time series for a UI chart, ordered ascending
 * by bucket key. Costs/calls are summed per bucket; missing cost => 0.
 */
export function costSeries(
  source: EventStore | string,
  projectId: string,
  bucket: 'hour' | 'day',
  sinceIso?: string,
): CostBucket[] {
  const since = sinceIso ?? EPOCH;
  const rows = readRows(source, projectId, since);
  const buckets = new Map<string, CostBucket>();

  for (const row of rows) {
    if (row.kind !== 'llm.call') continue;
    const payload = parsePayload(row) as LlmCallPayload | null;
    const cost = num(payload?.usage?.costUsd);
    const key = bucketKey(row.ts, bucket);
    const acc = buckets.get(key) ?? { bucket: key, costUsd: 0, calls: 0 };
    acc.costUsd += cost;
    acc.calls += 1;
    buckets.set(key, acc);
  }

  return [...buckets.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));
}
