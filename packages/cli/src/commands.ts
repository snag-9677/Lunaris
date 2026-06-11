/**
 * Command implementations for the `lun` CLI.
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
import {
  createdFilesFrom,
  exitCodeForStatus,
  formatAnalytics,
  formatApprovalLine,
  formatEventLine,
  formatMemoryLine,
  normalizeResult,
  resolveModel,
  tailEvents,
  toolLineFor,
} from './format.js';

const MANIFEST_HINT = 'No lunaris.toml found here — run `lun init` first.';
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

// ---------- lun init ----------

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

// ---------- lun chat ----------

/**
 * Builds the Goal envelope for `lun chat`: a fresh time-ordered id, the
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

// ---------- lun status ----------

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

// ---------- lun events ----------

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

// ---------- lun daemon ----------

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

// ---------- lun analytics ----------

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

// ---------- lun memory ----------

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

// ---------- lun approvals ----------

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
