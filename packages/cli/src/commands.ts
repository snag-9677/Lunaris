/**
 * Command implementations for the `lunaris` CLI.
 *
 * Cross-package wiring policy: sibling packages (@lunaris/core, gateway,
 * orchestrator, daemon) are authored concurrently, so all value-level access
 * goes through dynamic import + runtime symbol lookup with descriptive errors.
 * Shared *types* come from @lunaris/core (type-only imports, erased at
 * runtime). Each runX function returns the process exit code.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ApprovalTicket,
  BudgetCaps,
  BudgetLedger,
  EventStore,
  Goal,
  LunarisManifest,
  MemoryRecord,
  ProjectAnalytics,
} from '@lunaris/core';
import type {
  ConfigProposal,
  LoadedPlugin,
  OptimizerReport,
  QueuedGoal,
  QueuedGoalStatus,
  Schedule,
} from '@lunaris/core';
import {
  createdFilesFrom,
  exitCodeForStatus,
  formatAnalytics,
  formatApprovalLine,
  formatEventLine,
  formatMemoryLine,
  formatOptimizerReport,
  formatPluginLine,
  formatProposalLine,
  formatQueuedGoalLine,
  formatScheduleLine,
  normalizeResult,
  resolveModel,
  tailEvents,
  toolLineFor,
} from './format.js';

const MANIFEST_HINT = 'No lunaris.toml found here — run `lunaris init` first.';
/** Effectively "no limit" for EventStore.query. */
const MAX_QUERY = 1_000_000;

type EventStoreCtor = new (dbPath: string) => EventStore;
type BudgetLedgerCtor = new (caps?: BudgetCaps) => BudgetLedger;
type AnyCtor = new (opts: Record<string, unknown>) => unknown;
type AnyFn = (...args: unknown[]) => unknown;

// ---------- module / symbol resolution helpers ----------

/** Dynamic import via a variable specifier: resolved at runtime only. */
async function loadModule(specifier: string): Promise<Record<string, unknown>> {
  const mod: unknown = await import(specifier);
  return mod as Record<string, unknown>;
}

function pick<T>(mod: Record<string, unknown>, names: readonly string[], what: string): T {
  for (const name of names) {
    const value = mod[name];
    if (value !== undefined) return value as T;
  }
  throw new Error(`${what} not found (looked for export(s): ${names.join(', ')})`);
}

function firstFunction(
  obj: Record<string, unknown>,
  names: readonly string[],
): { name: string; fn: AnyFn } | undefined {
  for (const name of names) {
    const fn = obj[name];
    if (typeof fn === 'function') return { name, fn: fn as AnyFn };
  }
  return undefined;
}

function fail(err: unknown): 1 {
  console.error(err instanceof Error ? err.message : String(err));
  return 1;
}

// ---------- shared project plumbing ----------

export function eventsDbPath(cwd: string): string {
  return join(cwd, '.lunaris', 'state', 'events.db');
}

export function memoryDbPath(cwd: string): string {
  return join(cwd, '.lunaris', 'state', 'memory.db');
}

export function approvalsDbPath(cwd: string): string {
  return join(cwd, '.lunaris', 'state', 'approvals.db');
}

export function banditDbPath(cwd: string): string {
  return join(cwd, '.lunaris', 'state', 'bandit.db');
}

export function proposalDbPath(cwd: string): string {
  return join(cwd, '.lunaris', 'state', 'proposals.db');
}

export function queueDbPath(cwd: string): string {
  return join(cwd, '.lunaris', 'state', 'queue.db');
}

export function scheduleDbPath(cwd: string): string {
  return join(cwd, '.lunaris', 'state', 'schedules.db');
}

export function pluginsDir(cwd: string): string {
  return join(cwd, '.lunaris', 'plugins');
}

export async function loadProjectManifest(cwd: string): Promise<LunarisManifest> {
  if (!existsSync(join(cwd, 'lunaris.toml'))) throw new Error(MANIFEST_HINT);
  const core = await loadModule('@lunaris/core');
  const load = pick<AnyFn>(core, ['loadManifest', 'readManifest'], '@lunaris/core manifest loader');
  const manifest: unknown = await Promise.resolve(load(cwd));
  if (manifest === null || typeof manifest !== 'object') throw new Error(MANIFEST_HINT);
  return manifest as LunarisManifest;
}

async function openEventStore(cwd: string): Promise<EventStore> {
  mkdirSync(join(cwd, '.lunaris', 'state'), { recursive: true });
  const core = await loadModule('@lunaris/core');
  const StoreCtor = pick<EventStoreCtor>(core, ['SqliteEventStore'], '@lunaris/core SqliteEventStore');
  return new StoreCtor(eventsDbPath(cwd));
}

// ---------- lunaris init ----------

export async function runInit(cwd: string, name?: string): Promise<number> {
  try {
    const core = await loadModule('@lunaris/core');
    const init = pick<AnyFn>(core, ['initManifest'], '@lunaris/core initManifest');
    const result: unknown = await Promise.resolve(
      name === undefined ? init(cwd) : init(cwd, { name }),
    );
    const files = createdFilesFrom(result);
    if (files.length === 0) {
      console.log('initialized Lunaris project');
    } else {
      for (const file of files) console.log(`created ${file}`);
    }
    return 0;
  } catch (err) {
    return fail(err);
  }
}

// ---------- lunaris chat ----------

/**
 * Builds the Goal envelope for `lunaris chat`: a fresh time-ordered id, the
 * manifest's project id, the user prompt, an ISO timestamp, status 'running'.
 */
export function buildChatGoal(goalId: string, projectId: string, prompt: string): Goal {
  return {
    goalId,
    projectId,
    prompt,
    createdAt: new Date().toISOString(),
    status: 'running',
  };
}

export async function runChat(cwd: string, prompt: string, modelOverride?: string): Promise<number> {
  let unsubscribe: (() => void) | undefined;
  try {
    const manifest = await loadProjectManifest(cwd);
    const events = await openEventStore(cwd);

    const core = await loadModule('@lunaris/core');
    const gatewayMod = await loadModule('@lunaris/gateway');
    const LedgerCtor = pick<BudgetLedgerCtor>(
      { ...core, ...gatewayMod },
      ['InMemoryBudgetLedger'],
      '@lunaris/gateway (or @lunaris/core) InMemoryBudgetLedger',
    );
    const ledger = new LedgerCtor(manifest.budgets ?? {});

    const GatewayCtor = pick<AnyCtor>(gatewayMod, ['ModelGateway'], '@lunaris/gateway ModelGateway');
    const gateway = new GatewayCtor({
      manifest,
      providers: manifest.providers,
      ledger,
      budgetLedger: ledger,
      events,
      eventStore: events,
    });

    const model = resolveModel(manifest, modelOverride);
    const orchestratorMod = await loadModule('@lunaris/orchestrator');
    const LoopCtor = pick<AnyCtor>(orchestratorMod, ['AgentLoop'], '@lunaris/orchestrator AgentLoop');
    const loop = new LoopCtor({
      role: 'orchestrator',
      manifest,
      projectId: manifest.project.id,
      projectRoot: cwd,
      gateway,
      events,
      eventStore: events,
      ledger,
      budgetLedger: ledger,
      model,
    });

    // Live progress: tool-call lines as they hit the event spine.
    unsubscribe = events.subscribe((e) => {
      const line = toolLineFor(e);
      if (line !== undefined) process.stdout.write(`${line}\n`);
    });

    const run = firstFunction(loop as Record<string, unknown>, ['run', 'runGoal', 'execute']);
    if (run === undefined) throw new Error('AgentLoop instance has no run/runGoal/execute method');
    const mintGoalId = pick<AnyFn>(core, ['newGoalId', 'uuidv7'], '@lunaris/core goal id generator');
    const goal = buildChatGoal(String(mintGoalId()), manifest.project.id, prompt);
    const raw: unknown = await Promise.resolve(run.fn.call(loop, goal));

    const result = normalizeResult(raw);
    if (result.summary !== undefined && result.summary.length > 0) {
      process.stdout.write(result.summary.endsWith('\n') ? result.summary : `${result.summary}\n`);
    }
    return exitCodeForStatus(result.status);
  } catch (err) {
    return fail(err);
  } finally {
    unsubscribe?.();
  }
}

// ---------- lunaris status ----------

export async function runStatus(cwd: string): Promise<number> {
  try {
    const manifest = await loadProjectManifest(cwd);
    let eventCount = 0;
    if (existsSync(eventsDbPath(cwd))) {
      const events = await openEventStore(cwd);
      eventCount = events.query({ projectId: manifest.project.id, limit: MAX_QUERY }).length;
    }
    console.log(`project:       ${manifest.project.id} (${manifest.project.name})`);
    console.log(`default model: ${manifest.models.default}`);
    console.log(`events:        ${eventCount}`);
    return 0;
  } catch (err) {
    return fail(err);
  }
}

// ---------- lunaris events ----------

export async function runEvents(cwd: string, tail: number): Promise<number> {
  try {
    if (!existsSync(eventsDbPath(cwd))) {
      console.log('no events recorded yet');
      return 0;
    }
    const store = await openEventStore(cwd);
    const all = store.query({ limit: MAX_QUERY });
    for (const e of tailEvents(all, tail)) console.log(formatEventLine(e));
    return 0;
  } catch (err) {
    return fail(err);
  }
}

// ---------- lunaris daemon ----------

export async function runDaemon(port = 7340): Promise<number> {
  try {
    const daemon = await loadModule('@lunaris/daemon');
    const entry = firstFunction(daemon, ['buildServer', 'createServer', 'start', 'main']);
    if (entry === undefined) {
      throw new Error('@lunaris/daemon exports none of buildServer/createServer/start/main');
    }
    const built: unknown = await Promise.resolve(entry.fn({ port }));
    if (built !== null && typeof built === 'object') {
      const listen = (built as Record<string, unknown>)['listen'];
      if (typeof listen === 'function') {
        await Promise.resolve(
          (listen as AnyFn).call(built, { port, host: '127.0.0.1' }),
        );
        console.log(`lunarisd listening on http://127.0.0.1:${port}`);
      }
    }
    // The open server handle keeps the process alive in the foreground.
    return 0;
  } catch (err) {
    return fail(err);
  }
}

// ---------- lunaris analytics ----------

export async function runAnalytics(cwd: string, since?: string): Promise<number> {
  try {
    const manifest = await loadProjectManifest(cwd);
    const core = await loadModule('@lunaris/core');
    const compute = pick<AnyFn>(core, ['computeAnalytics'], '@lunaris/core computeAnalytics');
    // Pass the db path string (computeAnalytics opens it read-only); empty when absent.
    if (!existsSync(eventsDbPath(cwd))) {
      console.log('no events recorded yet');
      return 0;
    }
    const analytics = compute(eventsDbPath(cwd), manifest.project.id, since) as ProjectAnalytics;
    for (const line of formatAnalytics(analytics)) console.log(line);
    return 0;
  } catch (err) {
    return fail(err);
  }
}

// ---------- lunaris memory ----------

export async function runMemory(cwd: string, query?: string, limit = 50): Promise<number> {
  try {
    const manifest = await loadProjectManifest(cwd);
    if (!existsSync(memoryDbPath(cwd))) {
      console.log('no memory recorded yet');
      return 0;
    }
    const memoryMod = await loadModule('@lunaris/memory');
    const StoreCtor = pick<AnyCtor>(memoryMod, ['SqliteMemoryStore'], '@lunaris/memory SqliteMemoryStore');
    const store = new StoreCtor({ dbPath: memoryDbPath(cwd), projectId: manifest.project.id }) as {
      search(query: string, limit?: number): MemoryRecord[];
      close?: () => void;
    };
    try {
      // search('') yields nothing, so a permissive token returns recent/strong records.
      const q = query !== undefined && query.trim().length > 0 ? query.trim() : ' ';
      const records = store.search(q, limit);
      if (records.length === 0) {
        console.log('no matching memory records');
      } else {
        for (const r of records) console.log(formatMemoryLine(r));
      }
      return 0;
    } finally {
      store.close?.();
    }
  } catch (err) {
    return fail(err);
  }
}

// ---------- lunaris approvals ----------

export interface ApprovalsOptions {
  resolve?: string;
  approve?: boolean;
  deny?: boolean;
  by?: string;
}

export async function runApprovals(cwd: string, opts: ApprovalsOptions = {}): Promise<number> {
  try {
    const manifest = await loadProjectManifest(cwd);
    if (!existsSync(approvalsDbPath(cwd))) {
      console.log('no approvals queued yet');
      return 0;
    }
    const policyMod = await loadModule('@lunaris/policy');
    const QueueCtor = pick<new (dbPath: string) => {
      list(projectId?: string, status?: ApprovalTicket['status']): ApprovalTicket[];
      resolve(ticketId: string, approved: boolean, by: string, currentPlanEpoch?: number): ApprovalTicket | undefined;
      close(): void;
    }>(policyMod, ['SqliteApprovalQueue'], '@lunaris/policy SqliteApprovalQueue');
    const queue = new QueueCtor(approvalsDbPath(cwd));
    try {
      if (opts.resolve !== undefined) {
        if (opts.approve === undefined && opts.deny === undefined) {
          throw new Error('--resolve requires --approve or --deny');
        }
        const approved = opts.approve === true && opts.deny !== true;
        const by = opts.by ?? 'cli';
        const resolved = queue.resolve(opts.resolve, approved, by);
        if (resolved === undefined) {
          console.error(`unknown ticket: ${opts.resolve}`);
          return 1;
        }
        console.log(`${resolved.ticketId} → ${resolved.status}`);
        return 0;
      }
      const pending = queue.list(manifest.project.id, 'pending');
      if (pending.length === 0) {
        console.log('no pending approvals');
      } else {
        for (const t of pending) console.log(formatApprovalLine(t));
      }
      return 0;
    } finally {
      queue.close();
    }
  } catch (err) {
    return fail(err);
  }
}

// ---------- lunaris optimize ----------

/** Structural view of @lunaris/optimizer's runOptimizer. */
type RunOptimizerFn = (opts: {
  store: EventStore | string;
  banditDbPath: string;
  proposalDbPath: string;
  projectId: string;
  sinceIso?: string;
  minSuggestionN?: number;
}) => OptimizerReport;

export async function runOptimize(cwd: string, sinceIso?: string): Promise<number> {
  try {
    const manifest = await loadProjectManifest(cwd);
    if (!existsSync(eventsDbPath(cwd))) {
      console.log('no events recorded yet — nothing to optimize');
      return 0;
    }
    const optimizerMod = await loadModule('@lunaris/optimizer');
    const runOptimizer = pick<RunOptimizerFn>(optimizerMod, ['runOptimizer'], '@lunaris/optimizer runOptimizer');
    mkdirSync(join(cwd, '.lunaris', 'state'), { recursive: true });
    const report = runOptimizer({
      // Pass the db path string — the optimizer opens the event store read-only.
      store: eventsDbPath(cwd),
      banditDbPath: banditDbPath(cwd),
      proposalDbPath: proposalDbPath(cwd),
      projectId: manifest.project.id,
      ...(sinceIso !== undefined ? { sinceIso } : {}),
    });
    for (const line of formatOptimizerReport(report)) console.log(line);
    return 0;
  } catch (err) {
    return fail(err);
  }
}

// ---------- lunaris proposals ----------

export interface ProposalsOptions {
  resolve?: string;
  approve?: boolean;
  reject?: boolean;
  status?: string;
}

interface ProposalStoreLike {
  list(projectId?: string, status?: ConfigProposal['status']): ConfigProposal[];
  resolve(id: string, approved: boolean): ConfigProposal | undefined;
  close(): void;
}

export async function runProposals(cwd: string, opts: ProposalsOptions = {}): Promise<number> {
  try {
    const manifest = await loadProjectManifest(cwd);
    if (!existsSync(proposalDbPath(cwd))) {
      console.log('no proposals yet — run `lunaris optimize` first');
      return 0;
    }
    const optimizerMod = await loadModule('@lunaris/optimizer');
    const StoreCtor = pick<new (dbPath: string) => ProposalStoreLike>(
      optimizerMod,
      ['SqliteProposalStore'],
      '@lunaris/optimizer SqliteProposalStore',
    );
    const store = new StoreCtor(proposalDbPath(cwd));
    try {
      if (opts.resolve !== undefined) {
        if (opts.approve === undefined && opts.reject === undefined) {
          throw new Error('--resolve requires --approve or --reject');
        }
        const approved = opts.approve === true && opts.reject !== true;
        const resolved = store.resolve(opts.resolve, approved);
        if (resolved === undefined) {
          console.error(`unknown proposal: ${opts.resolve}`);
          return 1;
        }
        console.log(`${resolved.id} → ${resolved.status}`);
        return 0;
      }
      const valid = new Set(['pending', 'approved', 'rejected']);
      const status = opts.status !== undefined && valid.has(opts.status) ? (opts.status as ConfigProposal['status']) : undefined;
      const list = store.list(manifest.project.id, status);
      if (list.length === 0) {
        console.log('no proposals');
      } else {
        for (const p of list) console.log(formatProposalLine(p));
      }
      return 0;
    } finally {
      store.close();
    }
  } catch (err) {
    return fail(err);
  }
}

// ---------- lunaris plugins / lunaris plugin ... ----------

interface PluginHostLike {
  list(): LoadedPlugin[];
  enable(id: string): void;
  disable(id: string): void;
}
type ScaffoldPluginFn = (dir: string, opts: { id: string; name: string; version?: string; force?: boolean }) => void;

async function openPluginHost(cwd: string): Promise<PluginHostLike> {
  const plugd = await loadModule('@lunaris/plugd');
  const HostCtor = pick<new (opts: { pluginsDir: string }) => PluginHostLike>(
    plugd,
    ['FilePluginHost'],
    '@lunaris/plugd FilePluginHost',
  );
  return new HostCtor({ pluginsDir: pluginsDir(cwd) });
}

export async function runPlugins(cwd: string): Promise<number> {
  try {
    await loadProjectManifest(cwd);
    if (!existsSync(pluginsDir(cwd))) {
      console.log('no plugins directory — add plugins under .lunaris/plugins or run `lunaris plugin new <dir>`');
      return 0;
    }
    const host = await openPluginHost(cwd);
    const plugins = host.list();
    if (plugins.length === 0) {
      console.log('no plugins found');
    } else {
      for (const p of plugins) console.log(formatPluginLine(p));
    }
    return 0;
  } catch (err) {
    return fail(err);
  }
}

export async function runPluginNew(cwd: string, dir: string, id?: string, name?: string): Promise<number> {
  try {
    const plugd = await loadModule('@lunaris/plugd');
    const scaffold = pick<ScaffoldPluginFn>(plugd, ['scaffoldPlugin'], '@lunaris/plugd scaffoldPlugin');
    // Default the plugin id/name from the target dir basename when not supplied.
    const base = dir.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? 'plugin';
    const pluginId = id ?? `local.${base.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
    const target = existsSync(dir) || dir.includes('/') || dir.includes('\\') ? dir : join(pluginsDir(cwd), dir);
    scaffold(target, { id: pluginId, name: name ?? base });
    console.log(`scaffolded plugin ${pluginId} at ${target}`);
    return 0;
  } catch (err) {
    return fail(err);
  }
}

/** Reject plugin ids that could escape a directory (mirrors the daemon's isSafePathSegment). */
function isSafePluginId(id: string): boolean {
  return id.length > 0 && !id.includes('/') && !id.includes('\\') && id !== '.' && id !== '..' && !id.includes('\0');
}

export async function runPluginToggle(cwd: string, id: string, enable: boolean): Promise<number> {
  try {
    await loadProjectManifest(cwd);
    // Validate the id before it reaches the host (which uses it in a path lookup).
    if (!isSafePluginId(id)) {
      console.error(`invalid plugin id: ${id}`);
      return 1;
    }
    const host = await openPluginHost(cwd);
    if (enable) host.enable(id);
    else host.disable(id);
    console.log(`${id} → ${enable ? 'enabled' : 'disabled'}`);
    return 0;
  } catch (err) {
    return fail(err);
  }
}

// ---------- lunaris schedule ----------

interface ScheduleStoreLike {
  create(input: { projectId: string; cron: string; prompt?: string; vars?: Record<string, string>; enabled?: boolean }): Schedule;
  list(projectId?: string): Schedule[];
  delete(id: string): boolean;
  close(): void;
}

export interface ScheduleOptions {
  cron?: string;
  prompt?: string;
  rm?: string;
}

async function openScheduleStore(cwd: string): Promise<ScheduleStoreLike> {
  const scheduler = await loadModule('@lunaris/scheduler');
  const StoreCtor = pick<new (dbPath: string) => ScheduleStoreLike>(
    scheduler,
    ['SqliteScheduleStore'],
    '@lunaris/scheduler SqliteScheduleStore',
  );
  return new StoreCtor(scheduleDbPath(cwd));
}

export async function runSchedule(cwd: string, opts: ScheduleOptions = {}): Promise<number> {
  try {
    const manifest = await loadProjectManifest(cwd);

    // Remove a schedule.
    if (opts.rm !== undefined) {
      if (!existsSync(scheduleDbPath(cwd))) {
        console.error(`unknown schedule: ${opts.rm}`);
        return 1;
      }
      const store = await openScheduleStore(cwd);
      try {
        const ok = store.delete(opts.rm);
        console.log(ok ? `removed ${opts.rm}` : `unknown schedule: ${opts.rm}`);
        return ok ? 0 : 1;
      } finally {
        store.close();
      }
    }

    // Add a schedule.
    if (opts.cron !== undefined || opts.prompt !== undefined) {
      if (opts.cron === undefined || opts.prompt === undefined) {
        throw new Error('adding a schedule requires both --cron <expr> and --prompt <p>');
      }
      const store = await openScheduleStore(cwd);
      try {
        const s = store.create({ projectId: manifest.project.id, cron: opts.cron, prompt: opts.prompt });
        console.log(`created ${s.id} (${s.cron}) next=${s.nextRunAt ?? '?'}`);
        return 0;
      } finally {
        store.close();
      }
    }

    // List schedules (default).
    if (!existsSync(scheduleDbPath(cwd))) {
      console.log('no schedules');
      return 0;
    }
    const store = await openScheduleStore(cwd);
    try {
      const list = store.list(manifest.project.id);
      if (list.length === 0) console.log('no schedules');
      else for (const s of list) console.log(formatScheduleLine(s));
      return 0;
    } finally {
      store.close();
    }
  } catch (err) {
    return fail(err);
  }
}

// ---------- lunaris queue ----------

interface GoalQueueLike {
  push(g: { projectId: string; prompt: string; source: string; priority?: number }): QueuedGoal;
  list(projectId?: string, status?: QueuedGoalStatus): QueuedGoal[];
  close(): void;
}

export interface QueueOptions {
  push?: string;
  priority?: number;
}

async function openGoalQueue(cwd: string): Promise<GoalQueueLike> {
  const scheduler = await loadModule('@lunaris/scheduler');
  const QueueCtor = pick<new (dbPath: string) => GoalQueueLike>(
    scheduler,
    ['SqliteGoalQueue'],
    '@lunaris/scheduler SqliteGoalQueue',
  );
  return new QueueCtor(queueDbPath(cwd));
}

export async function runQueue(cwd: string, opts: QueueOptions = {}): Promise<number> {
  try {
    const manifest = await loadProjectManifest(cwd);

    if (opts.push !== undefined) {
      const queue = await openGoalQueue(cwd);
      try {
        const g = queue.push({
          projectId: manifest.project.id,
          prompt: opts.push,
          source: 'cli',
          priority: opts.priority ?? 0,
        });
        console.log(`queued ${g.id} (p${g.priority})`);
        return 0;
      } finally {
        queue.close();
      }
    }

    if (!existsSync(queueDbPath(cwd))) {
      console.log('queue is empty');
      return 0;
    }
    const queue = await openGoalQueue(cwd);
    try {
      const list = queue.list(manifest.project.id);
      if (list.length === 0) console.log('queue is empty');
      else for (const g of list) console.log(formatQueuedGoalLine(g));
      return 0;
    } finally {
      queue.close();
    }
  } catch (err) {
    return fail(err);
  }
}
