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

/* ---------- Phase 3: optimizer / plugins / scheduler renderers ---------- */

/** Minimal views (mirror @lunaris/core; keep format.ts dep-free at runtime). */
export interface OutcomeStatsLike {
  taskClass: string;
  role: string;
  model: string;
  n: number;
  successes: number;
  successRate: number;
  avgCostUsd: number;
}
export interface RoutingSuggestionLike {
  taskClass: string;
  recommendedModel: string;
  rationale: string;
  confidence: number;
  basedOnN: number;
}
export interface ConfigProposalLike {
  id: string;
  kind: string;
  title: string;
  detail?: string;
  status: string;
  confidence: number;
}
export interface OptimizerReportLike {
  projectId: string;
  generatedAt: string;
  stats: OutcomeStatsLike[];
  routing: RoutingSuggestionLike[];
  proposals: ConfigProposalLike[];
  notes: string[];
}

/** Render an OptimizerReport as plain-text lines: stats table, routing, proposals. */
export function formatOptimizerReport(r: OptimizerReportLike): string[] {
  const lines: string[] = [];
  lines.push(`optimizer report · ${r.projectId} · ${r.generatedAt}`);

  lines.push('');
  lines.push('success rate by class/role/model:');
  if (r.stats.length === 0) {
    lines.push('  (no task outcomes yet)');
  } else {
    const keyOf = (s: OutcomeStatsLike): string => `${s.taskClass}/${s.role}/${s.model}`;
    const keyW = Math.max(5, ...r.stats.map((s) => keyOf(s).length));
    for (const s of r.stats) {
      lines.push(
        `  ${keyOf(s).padEnd(keyW)}  ${String(s.successes).padStart(3)}/${String(s.n).padEnd(3)}  ` +
          `${(s.successRate * 100).toFixed(1).padStart(5)}%  $${s.avgCostUsd.toFixed(4)}/task`,
      );
    }
  }

  lines.push('');
  lines.push('routing suggestions:');
  if (r.routing.length === 0) {
    lines.push('  (none yet — need more pulls per arm)');
  } else {
    for (const s of r.routing) {
      lines.push(
        `  ${s.taskClass} → ${s.recommendedModel}  (conf ${(s.confidence * 100).toFixed(0)}%, n=${s.basedOnN})`,
      );
      lines.push(`    ${s.rationale}`);
    }
  }

  lines.push('');
  lines.push(`proposals (${r.proposals.length}):`);
  if (r.proposals.length === 0) {
    lines.push('  (none)');
  } else {
    for (const p of r.proposals) {
      lines.push(`  ${p.id.slice(0, 8)}  [${p.kind}] ${p.status.padEnd(8)} ${p.title}`);
    }
  }

  for (const note of r.notes) lines.push(`note: ${note}`);
  return lines;
}

/** One-line rendering of a ConfigProposal. */
export function formatProposalLine(p: ConfigProposalLike): string {
  const id = p.id.slice(0, 12);
  const conf = `${(p.confidence * 100).toFixed(0)}%`;
  return `${id}  [${p.kind}] ${p.status.padEnd(8)} (conf ${conf})  ${p.title}`;
}

/** Minimal LoadedPlugin view for one-line CLI rendering. */
export interface LoadedPluginLike {
  manifest: { id: string; version: string; description?: string };
  enabled: boolean;
}

/** One-line rendering of a plugin. */
export function formatPluginLine(p: LoadedPluginLike): string {
  const mark = p.enabled ? '[on] ' : '[off]';
  const desc = p.manifest.description ? `  — ${p.manifest.description}` : '';
  return `${mark} ${p.manifest.id}@${p.manifest.version}${desc}`;
}

/** Minimal Schedule view for one-line CLI rendering. */
export interface ScheduleLike {
  id: string;
  cron: string;
  prompt?: string;
  templateId?: string;
  enabled: boolean;
  nextRunAt?: string;
}

/** One-line rendering of a schedule. */
export function formatScheduleLine(s: ScheduleLike): string {
  const id = s.id.slice(0, 12);
  const state = s.enabled ? 'on ' : 'off';
  const next = s.nextRunAt ? ` next=${s.nextRunAt}` : '';
  const body = s.prompt ?? (s.templateId ? `template:${s.templateId}` : '(no prompt)');
  return `${id}  ${state}  ${s.cron.padEnd(16)}${next}  ${truncate(body, 50)}`;
}

/** Minimal QueuedGoal view for one-line CLI rendering. */
export interface QueuedGoalLike {
  id: string;
  prompt: string;
  priority: number;
  status: string;
  source: string;
  attempts: number;
  maxAttempts: number;
}

/** One-line rendering of a queued goal. */
export function formatQueuedGoalLine(g: QueuedGoalLike): string {
  const id = g.id.slice(0, 12);
  const status = g.status.padEnd(7);
  return `${id}  ${status}  p${g.priority}  ${g.attempts}/${g.maxAttempts}  ${g.source.padEnd(14)}  ${truncate(g.prompt, 50)}`;
}

/* ---------- Phase 4: auth / lifecycle / lease / version renderers ---------- */

/** Minimal Principal view for CLI rendering. */
export interface PrincipalLike {
  id: string;
  kind: string;
  displayName: string;
  status?: string;
}

/** Render `lun whoami` output lines. */
export function formatWhoami(principal: PrincipalLike, role: string | null): string[] {
  return [
    `principal: ${principal.displayName} (${principal.id})`,
    `kind:      ${principal.kind}`,
    `role:      ${role ?? '(unbound)'}`,
    `status:    ${principal.status ?? 'active'}`,
  ];
}

/** Minimal SnapshotInfo view for CLI rendering. */
export interface SnapshotInfoLike {
  id: string;
  createdAt: string;
  bytes: number;
  kind: string;
}

/** Human-readable byte size. */
export function formatBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}kB`;
  return `${n}B`;
}

/** One-line rendering of a snapshot. */
export function formatSnapshotLine(s: SnapshotInfoLike): string {
  const id = s.id.slice(0, 12);
  return `${id}  ${s.kind.padEnd(6)}  ${formatBytes(s.bytes).padStart(8)}  ${s.createdAt}`;
}

/** Minimal BundleManifest view for CLI rendering. */
export interface BundleManifestLike {
  formatVersion: number;
  projectId: string;
  name: string;
  createdAt: string;
  contents: string[];
  schemaVersions: Record<string, number>;
}

/** Render bundle-manifest summary lines. */
export function formatBundleManifest(m: BundleManifestLike): string[] {
  const lines: string[] = [];
  lines.push(`  name:     ${m.name}`);
  lines.push(`  project:  ${m.projectId}`);
  lines.push(`  format:   v${m.formatVersion}`);
  lines.push(`  contents: ${m.contents.length > 0 ? m.contents.join(', ') : '(none)'}`);
  return lines;
}

/** Minimal Lease view for CLI rendering. */
export interface LeaseLike {
  repoId: string;
  holderId: string;
  nodeId: string;
  epoch: number;
  acquiredAt: string;
  heartbeatAt: string;
}

/** One-line rendering of the current lease. */
export function formatLeaseLine(l: LeaseLike): string {
  return `lease ${l.repoId}: holder ${l.holderId.slice(0, 12)} node ${l.nodeId} epoch ${l.epoch} (heartbeat ${l.heartbeatAt})`;
}

/** Minimal VersionInfo + DoctorReport views for CLI rendering. */
export interface VersionInfoLike {
  harness: string;
  schemaVersions: Record<string, number>;
}
export interface StoreReportLike {
  store: string;
  present: boolean;
  version: number | null;
  expected: number | null;
  status: string;
}
export interface DoctorReportLike {
  harness: string;
  stores: StoreReportLike[];
}

/** Render `lun version`: harness version + a per-store schema doctor table. */
export function formatDoctorReport(version: VersionInfoLike, report: DoctorReportLike): string[] {
  const lines: string[] = [];
  lines.push(`lunaris harness ${version.harness}`);
  lines.push('');
  lines.push('schema doctor:');
  if (report.stores.length === 0) {
    lines.push('  (no stores found)');
    return lines;
  }
  const nameW = Math.max(5, ...report.stores.map((s) => s.store.length));
  for (const s of report.stores) {
    const ver = s.version === null ? '-' : String(s.version);
    const exp = s.expected === null ? '-' : String(s.expected);
    lines.push(`  ${s.store.padEnd(nameW)}  v${ver}/${exp}  ${s.status}`);
  }
  return lines;
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
