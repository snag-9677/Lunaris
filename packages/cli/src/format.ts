/**
 * Pure, dependency-free helpers for the `lun` CLI.
 * Kept side-effect free so they are cheap to unit test; only type-level
 * imports from @lunaris/core (erased at runtime).
 */
import type { EventEnvelope } from '@lunaris/core';

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
