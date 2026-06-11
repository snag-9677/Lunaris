/**
 * Pure, dependency-free helpers for the `lun` CLI.
 * Kept side-effect free so they are cheap to unit test; only type-level
 * imports from @lunaris/core (erased at runtime).
 */
import type { EventEnvelope, ProjectAnalytics } from '@lunaris/core';

/** Minimal slice of an event used by formatting helpers (eases testing). */
export type EventLike = Pick<EventEnvelope, 'ts' | 'kind' | 'payload'>;

/** Truncate a string to `max` characters, ending with an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return '…';
  return `${text.slice(0, max - 1)}…`;
}

/** JSON.stringify that never throws (circular refs, BigInt, etc.). */
export function safeStringify(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    const seen = new WeakSet<object>();
    const out = JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v === 'bigint') return v.toString();
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[circular]';
        seen.add(v);
      }
      return v;
    });
    return out ?? String(value);
  } catch {
    return String(value);
  }
}

/** One-line rendering of an event: "<ts>  <kind>  <payload…>". */
export function formatEventLine(e: EventLike, payloadWidth = 80): string {
  const payload = truncate(safeStringify(e.payload), payloadWidth);
  return payload.length > 0 ? `${e.ts}  ${e.kind}  ${payload}` : `${e.ts}  ${e.kind}`;
}

/**
 * Last `n` events in chronological order (ts, then eventId — UUIDv7 is
 * time-ordered so the lexicographic tiebreak is stable).
 */
export function tailEvents<T extends { ts: string; eventId: string }>(
  events: readonly T[],
  n: number,
): T[] {
  if (n <= 0) return [];
  return [...events]
    .sort((a, b) => (a.ts === b.ts ? a.eventId.localeCompare(b.eventId) : a.ts.localeCompare(b.ts)))
    .slice(-n);
}

/** Parse a --tail option value; falls back for missing/invalid input. */
export function parseTail(raw: string | undefined, fallback = 20): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** "[tool] <name>" for tool.call events, undefined for everything else. */
export function toolLineFor(e: Pick<EventLike, 'kind' | 'payload'>): string | undefined {
  if (e.kind !== 'tool.call' && !e.kind.startsWith('tool.call.')) return undefined;
  let name: string | undefined;
  const payload = e.payload;
  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    for (const key of ['name', 'tool', 'toolName']) {
      const v = record[key];
      if (typeof v === 'string' && v.length > 0) {
        name = v;
        break;
      }
    }
  }
  return `[tool] ${name ?? '?'}`;
}

/** Model resolution: explicit override > per-role binding > project default. */
export function resolveModel(
  manifest: { models: { default: string; roles?: Record<string, string> } },
  override?: string,
  role = 'orchestrator',
): string {
  if (override !== undefined && override.length > 0) return override;
  return manifest.models.roles?.[role] ?? manifest.models.default;
}

/** Exit code mapping for `lun chat`: success → 0, anything else → 1. */
export function exitCodeForStatus(status: string | undefined): 0 | 1 {
  return status === 'success' ? 0 : 1;
}

/**
 * Defensive view over whatever the AgentLoop returns: a bare ResultEnvelope,
 * or an AgentRunOutcome-style wrapper carrying the envelope under `result`.
 */
export function normalizeResult(result: unknown): { status?: string; summary?: string } {
  if (typeof result === 'string') return { summary: result };
  if (result !== null && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    const nested =
      r['result'] !== null && typeof r['result'] === 'object'
        ? (r['result'] as Record<string, unknown>)
        : undefined;
    let status = typeof r['status'] === 'string' ? (r['status'] as string) : undefined;
    if (status === undefined && nested && typeof nested['status'] === 'string') {
      status = nested['status'] as string;
    }
    let summary: string | undefined;
    for (const key of ['summary', 'finalText', 'text']) {
      const v = r[key];
      if (typeof v === 'string' && v.length > 0) {
        summary = v;
        break;
      }
    }
    if (summary === undefined && nested && typeof nested['summary'] === 'string') {
      summary = nested['summary'] as string;
    }
    return { status, summary };
  }
  return {};
}

/** Render a ProjectAnalytics rollup as plain text lines (one per array entry). */
export function formatAnalytics(a: ProjectAnalytics): string[] {
  const lines: string[] = [];
  const total = a.goals.done + a.goals.failed;
  const successRate = total > 0 ? Math.round((a.goals.done / total) * 100) : 0;
  lines.push(`project:   ${a.projectId}`);
  lines.push(`since:     ${a.since}`);
  lines.push(
    `goals:     ${a.goals.total} total · ${a.goals.done} done · ${a.goals.failed} failed · ${a.goals.running} running (${successRate}% success)`,
  );
  lines.push(
    `llm:       ${a.llm.calls} calls · ${a.llm.inputTokens} in / ${a.llm.outputTokens} out tok · $${a.llm.costUsd.toFixed(4)}`,
  );
  lines.push(`tools:     ${a.tools.calls} calls · ${a.tools.failures} failures`);
  if (a.byModel.length > 0) {
    lines.push('by model:');
    const nameW = Math.max(5, ...a.byModel.map((m) => m.model.length));
    for (const m of a.byModel) {
      lines.push(
        `  ${m.model.padEnd(nameW)}  ${String(m.calls).padStart(4)} calls  ` +
          `${String(m.inputTokens).padStart(7)} in  ${String(m.outputTokens).padStart(7)} out  $${m.costUsd.toFixed(4)}`,
      );
    }
  }
  return lines;
}

/** A minimal MemoryRecord view for one-line CLI rendering. */
export interface MemoryRecordLike {
  type?: string;
  statement?: string;
  confidence?: number;
  strength?: number;
  tainted?: boolean;
}

/** One-line rendering of a memory record. */
export function formatMemoryLine(r: MemoryRecordLike): string {
  const conf = typeof r.confidence === 'number' ? r.confidence.toFixed(2) : '?';
  const str = typeof r.strength === 'number' ? r.strength.toFixed(2) : '?';
  const taint = r.tainted ? ' (untrusted)' : '';
  const type = (r.type ?? 'mem').padEnd(10);
  return `${type} [conf ${conf} str ${str}]${taint} ${r.statement ?? ''}`;
}

/** A minimal ApprovalTicket view for one-line CLI rendering. */
export interface ApprovalTicketLike {
  ticketId?: string;
  tool?: string;
  reason?: string;
  status?: string;
  createdAt?: string;
}

/** One-line rendering of an approval ticket. */
export function formatApprovalLine(t: ApprovalTicketLike): string {
  const id = (t.ticketId ?? '?').slice(0, 12);
  const status = (t.status ?? '?').padEnd(8);
  return `${id}  ${status}  ${t.tool ?? '?'}  — ${t.reason ?? ''}`;
}

/** Normalize initManifest()'s return value into a list of created file paths. */
export function createdFilesFrom(result: unknown): string[] {
  if (typeof result === 'string') return [result];
  if (Array.isArray(result)) return result.filter((x): x is string => typeof x === 'string');
  if (result !== null && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    for (const key of ['createdFiles', 'files', 'created', 'paths']) {
      const v = r[key];
      if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
      if (typeof v === 'string') return [v];
    }
    for (const key of ['manifestPath', 'path']) {
      const v = r[key];
      if (typeof v === 'string') return [v];
    }
  }
  return [];
}
