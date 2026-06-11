/**
 * Outcome ledger: reconstruct per-task/per-goal TaskOutcome rows from the
 * append-only event spine (see @lunaris/core events.ts).
 *
 * A "task" is keyed by the taskId that llm.call / tool.call events carry. For a
 * subagent it is the task.start/task.end taskId; for a top-level goal it is the
 * goal.goalId (the orchestrator runs the root with taskId === goalId, so the
 * root's llm.call events join straight onto goal.created/goal.done/goal.failed).
 *
 * We join terminal events (task.end ResultEnvelope, or goal.done/goal.failed)
 * onto the llm.call + tool.call events sharing the taskId to derive status,
 * failureClass, model, summed cost/tokens and end-to-end duration. Every field
 * is read defensively — missing/garbage payloads degrade to safe defaults.
 */
import { DatabaseSync } from 'node:sqlite';
import type { EventStore, FailureClass, ResultEnvelope, TaskOutcome } from '@lunaris/core';

/** Pull the full history so the ledger sees everything (matches analytics.ts). */
const SCAN_LIMIT = 1_000_000;
const EPOCH = '1970-01-01T00:00:00.000Z';

const FAILURE_CLASSES: ReadonlySet<string> = new Set([
  'infra',
  'model',
  'policy-denied',
  'user-cancelled',
]);
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['success', 'partial', 'failed', 'blocked']);

interface EventRow {
  ts: string;
  kind: string;
  task_id: string | null;
  agent_id: string | null;
  payload: string;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asFailureClass(v: unknown): FailureClass | undefined {
  return typeof v === 'string' && FAILURE_CLASSES.has(v) ? (v as FailureClass) : undefined;
}

function parsePayload(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw) as unknown;
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Coarse task class from an agent role (and optionally the goal/task prompt).
 * Role is the strongest signal; the prompt is only consulted as a fallback when
 * the role is missing/unknown.
 */
export function classifyTask(role: string | undefined, prompt?: string): string {
  const r = (role ?? '').toLowerCase();
  if (r.includes('coder') || r.includes('code') || r.includes('dev') || r.includes('engineer'))
    return 'code';
  if (r.includes('research') || r.includes('search') || r.includes('analyst')) return 'research';
  if (r.includes('test') || r.includes('qa')) return 'test';
  if (r.includes('orchestrat') || r.includes('planner') || r.includes('lead'))
    return 'orchestration';
  // Fallback: sniff the prompt for obvious intent words.
  const p = (prompt ?? '').toLowerCase();
  if (p.length > 0) {
    if (/\b(code|implement|refactor|bug|function|class|compile)\b/.test(p)) return 'code';
    if (/\b(research|investigate|find out|compare|survey)\b/.test(p)) return 'research';
    if (/\b(test|spec|coverage|assert)\b/.test(p)) return 'test';
  }
  return 'general';
}

/** Mutable accumulator while folding events for one taskId. */
interface TaskAcc {
  taskId: string;
  projectId: string;
  role: string | undefined;
  prompt: string | undefined;
  model: string | undefined;
  modelCounts: Map<string, number>;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  llmDurationMs: number;
  startTs: string | undefined;
  endTs: string | undefined;
  status: TaskOutcome['status'] | undefined;
  failureClass: FailureClass | undefined;
  hasTerminal: boolean;
}

function emptyAcc(taskId: string, projectId: string): TaskAcc {
  return {
    taskId,
    projectId,
    role: undefined,
    prompt: undefined,
    model: undefined,
    modelCounts: new Map(),
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    llmDurationMs: 0,
    startTs: undefined,
    endTs: undefined,
    status: undefined,
    failureClass: undefined,
    hasTerminal: false,
  };
}

function readRows(source: EventStore | string, projectId: string, sinceIso: string): EventRow[] {
  if (typeof source === 'string') {
    const db = new DatabaseSync(source, { readOnly: true });
    try {
      return db
        .prepare(
          `SELECT ts, kind, task_id, agent_id, payload
             FROM events
            WHERE project_id = ? AND ts >= ?
            ORDER BY event_id ASC`,
        )
        .all(projectId, sinceIso) as unknown as EventRow[];
    } finally {
      db.close();
    }
  }
  // Live store: query newest-first, narrow to since, reverse to oldest-first so
  // start/end timestamp tracking is deterministic and matches the SQL path.
  const events = source.query({ projectId, limit: SCAN_LIMIT });
  const rows: EventRow[] = [];
  for (const e of events) {
    if (e.ts < sinceIso) continue;
    rows.push({
      ts: e.ts,
      kind: e.kind,
      task_id: e.taskId ?? null,
      agent_id: e.agentId ?? null,
      payload: JSON.stringify(e.payload ?? null),
    });
  }
  rows.reverse();
  return rows;
}

function noteStart(acc: TaskAcc, ts: string): void {
  if (acc.startTs === undefined || ts < acc.startTs) acc.startTs = ts;
}
function noteEnd(acc: TaskAcc, ts: string): void {
  if (acc.endTs === undefined || ts > acc.endTs) acc.endTs = ts;
}

/**
 * Derive one TaskOutcome per task/goal over a project's event history.
 *
 * @param source live EventStore or a sqlite db path (opened read-only).
 * @param sinceIso inclusive ISO lower bound; defaults to the epoch.
 */
export function deriveOutcomes(
  source: EventStore | string,
  projectId: string,
  sinceIso?: string,
): TaskOutcome[] {
  const since = sinceIso ?? EPOCH;
  const rows = readRows(source, projectId, since);

  const tasks = new Map<string, TaskAcc>();
  // goalId -> taskId is identity here (root taskId === goalId), so goal events
  // and root llm/tool events land in the same accumulator keyed by that id.
  const get = (id: string): TaskAcc => {
    let acc = tasks.get(id);
    if (acc === undefined) {
      acc = emptyAcc(id, projectId);
      tasks.set(id, acc);
    }
    return acc;
  };

  for (const row of rows) {
    const payload = parsePayload(row.payload);
    switch (row.kind) {
      case 'goal.created': {
        const goalId = str(payload?.goalId);
        if (goalId === undefined) break;
        const acc = get(goalId);
        noteStart(acc, row.ts);
        if (acc.prompt === undefined) acc.prompt = str(payload?.prompt);
        break;
      }
      case 'goal.done': {
        const goalId = str(payload?.goalId);
        if (goalId === undefined) break;
        const acc = get(goalId);
        noteEnd(acc, row.ts);
        acc.hasTerminal = true;
        const result = payload?.result;
        if (result !== null && typeof result === 'object') {
          applyResult(acc, result as Partial<ResultEnvelope>);
        }
        if (acc.status === undefined) acc.status = 'success';
        break;
      }
      case 'goal.failed': {
        const goalId = str(payload?.goalId);
        if (goalId === undefined) break;
        const acc = get(goalId);
        noteEnd(acc, row.ts);
        acc.hasTerminal = true;
        acc.status = 'failed';
        // The daemon /goals path and the queue runner emit goal.failed with only
        // {goalId, error} — no failureClass. Treating that as 'infra' would
        // silently drop real model/logic failures from the quality stats AND the
        // bandit (rewardOf→null). Default a classless failure to 'model'; only an
        // EXPLICIT failureClass:'infra' on the event is honored as infra.
        if (acc.failureClass === undefined) {
          acc.failureClass = asFailureClass(payload?.failureClass) ?? 'model';
        }
        break;
      }
      case 'task.start': {
        const taskId = str(row.task_id);
        if (taskId === undefined) break;
        const acc = get(taskId);
        noteStart(acc, row.ts);
        if (acc.role === undefined) acc.role = str(row.agent_id) ?? str(payload?.role);
        if (acc.prompt === undefined) acc.prompt = str(payload?.task);
        break;
      }
      case 'task.end': {
        const taskId = str(row.task_id);
        if (taskId === undefined) break;
        const acc = get(taskId);
        noteEnd(acc, row.ts);
        acc.hasTerminal = true;
        if (acc.role === undefined) acc.role = str(row.agent_id);
        // task.end payload IS the ResultEnvelope.
        if (payload !== null) applyResult(acc, payload as Partial<ResultEnvelope>);
        break;
      }
      case 'llm.call': {
        const taskId = str(row.task_id);
        if (taskId === undefined) break;
        const acc = get(taskId);
        noteStart(acc, row.ts);
        noteEnd(acc, row.ts);
        if (acc.role === undefined) acc.role = str(row.agent_id);
        const model = str(payload?.model);
        if (model !== undefined) {
          acc.modelCounts.set(model, (acc.modelCounts.get(model) ?? 0) + 1);
          if (acc.model === undefined) acc.model = model;
        }
        const usage = payload?.usage;
        if (usage !== null && typeof usage === 'object') {
          const u = usage as Record<string, unknown>;
          acc.costUsd += num(u.costUsd);
          acc.tokensIn += num(u.inputTokens);
          acc.tokensOut += num(u.outputTokens);
        }
        acc.llmDurationMs += num(payload?.durationMs);
        break;
      }
      case 'tool.call': {
        const taskId = str(row.task_id);
        if (taskId === undefined) break;
        const acc = get(taskId);
        noteStart(acc, row.ts);
        noteEnd(acc, row.ts);
        if (acc.role === undefined) acc.role = str(row.agent_id);
        break;
      }
      default:
        break;
    }
  }

  const outcomes: TaskOutcome[] = [];
  for (const acc of tasks.values()) {
    // Skip pure ghosts: a task we only ever saw referenced with no signal.
    if (!acc.hasTerminal && acc.modelCounts.size === 0 && acc.startTs === undefined) continue;

    const role = acc.role ?? 'unknown';
    const status: TaskOutcome['status'] = acc.status ?? (acc.hasTerminal ? 'success' : 'partial');
    // Dominant model across this task's llm.call events; fall back to 'unknown'.
    const model = dominantModel(acc.modelCounts) ?? acc.model ?? 'unknown';
    const ts = acc.endTs ?? acc.startTs ?? since;
    const durationMs = durationOf(acc);

    const outcome: TaskOutcome = {
      taskId: acc.taskId,
      projectId: acc.projectId,
      taskClass: classifyTask(role, acc.prompt),
      role,
      model,
      status,
      costUsd: acc.costUsd,
      durationMs,
      tokensIn: acc.tokensIn,
      tokensOut: acc.tokensOut,
      ts,
    };
    if (acc.failureClass !== undefined) outcome.failureClass = acc.failureClass;
    outcomes.push(outcome);
  }

  // Stable, time-ordered output.
  outcomes.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return outcomes;
}

function applyResult(acc: TaskAcc, result: Partial<ResultEnvelope>): void {
  const status = result.status;
  if (typeof status === 'string' && TERMINAL_STATUSES.has(status)) {
    acc.status = status as TaskOutcome['status'];
  }
  const fc = asFailureClass(result.failureClass);
  if (fc !== undefined) acc.failureClass = fc;
}

function dominantModel(counts: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestN = -1;
  for (const [model, n] of counts) {
    if (n > bestN) {
      best = model;
      bestN = n;
    }
  }
  return best;
}

/** End-to-end ms from first to last event; fall back to summed llm latency. */
function durationOf(acc: TaskAcc): number {
  if (acc.startTs !== undefined && acc.endTs !== undefined) {
    const span = Date.parse(acc.endTs) - Date.parse(acc.startTs);
    if (Number.isFinite(span) && span > 0) return span;
  }
  return acc.llmDurationMs;
}
