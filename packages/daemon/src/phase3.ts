/**
 * Phase 3 substrate wiring for the daemon: db-path helpers + loosely-bound
 * lazy loaders for @lunaris/optimizer, @lunaris/plugd and @lunaris/scheduler.
 *
 * Like the Phase 2 wiring in goal-runner.ts/server.ts, the value-level surfaces
 * of these packages are not part of types.ts, so they are imported dynamically
 * and bound through narrow structural views. This keeps the daemon decoupled
 * from each package's exact constructor names and lets it still load if a
 * sibling package is unbuilt during an incremental dev build.
 *
 * Per-project state lives under <projectRoot>/.lunaris/state/*.db, matching the
 * memory.db / approvals.db convention already used by goal-runner.ts.
 */
import { join } from 'node:path';
import type {
  ConfigProposal,
  EventStore,
  OptimizerReport,
  LoadedPlugin,
  PluginHost,
  QueuedGoal,
  QueuedGoalStatus,
  ResolvedTool,
  Schedule,
  TriggerRule,
} from '@lunaris/core';

/* ---------- per-project sqlite locations under <projectRoot>/.lunaris/state ---------- */

export function banditDbPath(projectRoot: string): string {
  return join(projectRoot, '.lunaris', 'state', 'bandit.db');
}
export function proposalDbPath(projectRoot: string): string {
  return join(projectRoot, '.lunaris', 'state', 'proposals.db');
}
export function queueDbPath(projectRoot: string): string {
  return join(projectRoot, '.lunaris', 'state', 'queue.db');
}
export function scheduleDbPath(projectRoot: string): string {
  return join(projectRoot, '.lunaris', 'state', 'schedules.db');
}
export function triggerDbPath(projectRoot: string): string {
  return join(projectRoot, '.lunaris', 'state', 'triggers.db');
}
export function pluginsDir(projectRoot: string): string {
  return join(projectRoot, '.lunaris', 'plugins');
}

/* ---------- @lunaris/optimizer (structural view) ---------- */

export interface ProposalStoreLike {
  list(projectId?: string, status?: ConfigProposal['status']): ConfigProposal[];
  get(id: string): ConfigProposal | undefined;
  resolve(id: string, approved: boolean): ConfigProposal | undefined;
  close(): void;
}

export interface OptimizerPkgLike {
  runOptimizer(opts: {
    store: EventStore | string;
    banditDbPath: string;
    proposalDbPath: string;
    projectId: string;
    sinceIso?: string;
    minSuggestionN?: number;
  }): OptimizerReport;
  SqliteProposalStore: new (dbPath: string) => ProposalStoreLike;
}

export async function loadOptimizerPkg(): Promise<OptimizerPkgLike | undefined> {
  try {
    return (await import('@lunaris/optimizer')) as unknown as OptimizerPkgLike;
  } catch {
    return undefined;
  }
}

/* ---------- @lunaris/plugd (structural view) ---------- */

export interface PluginHostLike extends PluginHost {
  list(): LoadedPlugin[];
  enable(id: string): void;
  disable(id: string): void;
  enabledTools(): Promise<ResolvedTool[]>;
}

export interface PlugdPkgLike {
  FilePluginHost: new (opts: { pluginsDir: string; enabledIds?: string[]; registryPath?: string }) => PluginHostLike;
  scaffoldPlugin: (dir: string, opts: { id: string; name: string; version?: string; force?: boolean }) => void;
}

export async function loadPlugdPkg(): Promise<PlugdPkgLike | undefined> {
  try {
    return (await import('@lunaris/plugd')) as unknown as PlugdPkgLike;
  } catch {
    return undefined;
  }
}

/* ---------- @lunaris/scheduler (structural view) ---------- */

export interface GoalQueueLike {
  push(g: { projectId: string; prompt: string; source: string; priority?: number; maxAttempts?: number; notBefore?: string }): QueuedGoal;
  lease(now?: Date): QueuedGoal | null;
  complete(id: string, goalId: string): void;
  fail(id: string, retry: boolean, error?: string): void;
  list(projectId?: string, status?: QueuedGoalStatus): QueuedGoal[];
  get(id: string): QueuedGoal | undefined;
  close(): void;
}

export interface ScheduleStoreLike {
  create(input: { projectId: string; cron: string; templateId?: string; prompt?: string; vars?: Record<string, string>; enabled?: boolean }): Schedule;
  get(id: string): Schedule | undefined;
  list(projectId?: string): Schedule[];
  update(id: string, patch: Partial<Pick<Schedule, 'cron' | 'templateId' | 'prompt' | 'vars' | 'enabled'>>): Schedule | undefined;
  delete(id: string): boolean;
  tick(now: Date, enqueue: (projectId: string, prompt: string, source: string) => void): number;
  close(): void;
}

export interface TriggerStoreLike {
  create(input: { projectId: string; source: string; eventTypes: string[]; promptTemplate: string; enabled?: boolean }): TriggerRule;
  get(id: string): TriggerRule | undefined;
  list(projectId?: string, source?: string): TriggerRule[];
  delete(id: string): boolean;
  routeEvent(source: string, eventType: string, payload: unknown, enqueue: (projectId: string, prompt: string, source: string) => void): TriggerRule[];
  close(): void;
}

export interface DispatcherLike {
  drainOnce(now?: Date): Promise<number>;
  start(intervalMs: number): void;
  stop(): void;
}

export interface SchedulerPkgLike {
  SqliteGoalQueue: new (dbPath: string, opts?: { now?: () => Date }) => GoalQueueLike;
  SqliteScheduleStore: new (dbPath: string, opts?: { now?: () => Date }) => ScheduleStoreLike;
  SqliteTriggerStore: new (dbPath: string) => TriggerStoreLike;
  Dispatcher: new (opts: {
    queue: GoalQueueLike;
    runGoal: (g: QueuedGoal) => Promise<{ goalId: string; status: 'success' | 'partial' | 'failed' | 'blocked' }>;
    concurrency?: number;
    now?: () => Date;
  }) => DispatcherLike;
  verifyHmac: (secret: string, rawBody: string | Buffer, signatureHeader: string) => boolean;
}

export async function loadSchedulerPkg(): Promise<SchedulerPkgLike | undefined> {
  try {
    return (await import('@lunaris/scheduler')) as unknown as SchedulerPkgLike;
  } catch {
    return undefined;
  }
}

/* ---------- misc helpers ---------- */

/** Reject ids that could escape a directory (plugin id used in a path lookup). */
export function isSafePathSegment(seg: string): boolean {
  return seg.length > 0 && !seg.includes('/') && !seg.includes('\\') && seg !== '.' && seg !== '..' && !seg.includes('\0');
}

/** Per-project webhook secret resolution (env var convention; loopback fallback in the route). */
export function webhookSecretFor(projectId: string): string | undefined {
  // Convention: LUNARIS_WEBHOOK_SECRET_<PROJECT_ID upper, non-alnum -> _>.
  const norm = projectId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return process.env[`LUNARIS_WEBHOOK_SECRET_${norm}`] ?? process.env['LUNARIS_WEBHOOK_SECRET'];
}
