/**
 * Default goal execution: wire ModelGateway (@lunaris/gateway) with an
 * InMemoryBudgetLedger and the shared EventStore, then run the orchestrator's
 * AgentLoop with the project's default model from lunaris.toml.
 *
 * Phase 2: also construct the per-project autonomy substrate — a graphified
 * SqliteMemoryStore, a rule-based PolicyEngine (loaded from .lunaris/policy.yaml),
 * a TaintTracker and a durable SqliteApprovalQueue — and pass them into the loop
 * as optional fields. The orchestrator is being extended in parallel to accept
 * { memory, policy, taint, approvals }; we bind them loosely so this file stays
 * decoupled from the loop's exact option names. Memory runs on its offline
 * lexical path (no embed fn), so the whole thing works without network/LLM.
 *
 * NOTE: the constructor surfaces of ModelGateway / InMemoryBudgetLedger /
 * AgentLoop are not part of the shared types.ts contract, so they are bound
 * here through narrow structural casts. If a sibling package settles on a
 * different shape, this file is the single place to adjust.
 */
import type {
  ApprovalTicket,
  AutonomyLevel,
  BudgetCaps,
  BudgetLedger,
  EventStore,
  Goal,
  LunarisManifest,
  MemoryStore,
  PolicyEngine,
  PolicyRule,
  ResultEnvelope,
} from '@lunaris/core';
import * as gatewayPkg from '@lunaris/gateway';
import * as orchestratorPkg from '@lunaris/orchestrator';
import { join } from 'node:path';

export interface GoalRunContext {
  goal: Goal;
  manifest: LunarisManifest;
  events: EventStore;
  projectRoot: string;
}

/** Resolves with the goal's ResultEnvelope (if the loop produced one); rejects on infrastructure failure. */
export type GoalRunner = (ctx: GoalRunContext) => Promise<ResultEnvelope | undefined>;

interface GatewayExports {
  InMemoryBudgetLedger: new (caps?: BudgetCaps) => BudgetLedger;
  ModelGateway: new (opts: {
    manifest: LunarisManifest;
    events: EventStore;
    ledger: BudgetLedger;
  }) => unknown;
}

/** The Phase 2 autonomy substrate the loop may consume (all optional). */
export interface AgentLoopExtras {
  memory?: MemoryStore;
  policy?: PolicyEngine;
  taint?: unknown;
  approvals?: unknown;
}

interface OrchestratorExports {
  AgentLoop: new (opts: {
    gateway: unknown;
    events: EventStore;
    projectId: string;
    projectRoot: string;
    model: string;
  } & AgentLoopExtras) => {
    run(goal: Goal): Promise<{ result?: ResultEnvelope } | undefined>;
  };
}

/** Loose structural views of the Phase 2 packages (value-level, not in types.ts). */
interface MemoryExports {
  SqliteMemoryStore: new (opts: { dbPath: string; projectId: string }) => MemoryStore & {
    close?: () => void;
  };
}

interface PolicyExports {
  loadPolicy: (
    projectDir: string,
    options?: { level?: AutonomyLevel },
  ) => { level: AutonomyLevel; rules: PolicyRule[]; tightenWhenTainted: boolean; allowlistedHosts: string[] };
  RulePolicyEngine: new (opts: {
    level: AutonomyLevel;
    rules: PolicyRule[];
    tightenWhenTainted?: boolean;
    allowlistedHosts?: string[];
  }) => PolicyEngine;
  TaintTracker: new () => unknown;
  SqliteApprovalQueue: new (dbPath: string) => {
    create(input: { projectId: string; tool: string; args: unknown; reason: string; planEpoch?: number }): ApprovalTicket;
    list(projectId?: string, status?: ApprovalTicket['status']): ApprovalTicket[];
    resolve(ticketId: string, approved: boolean, by: string, currentPlanEpoch?: number): ApprovalTicket | undefined;
    close(): void;
  };
}

const { InMemoryBudgetLedger, ModelGateway } = gatewayPkg as unknown as GatewayExports;
const { AgentLoop } = orchestratorPkg as unknown as OrchestratorExports;

/** Per-project sqlite locations under <projectRoot>/.lunaris/state. */
export function memoryDbPath(projectRoot: string): string {
  return join(projectRoot, '.lunaris', 'state', 'memory.db');
}
export function approvalsDbPath(projectRoot: string): string {
  return join(projectRoot, '.lunaris', 'state', 'approvals.db');
}

export type PolicyPkg = PolicyExports;
export type MemoryPkg = MemoryExports;

/**
 * Lazily import the Phase 2 packages (value-level). They are workspace deps but
 * imported dynamically so the daemon still loads if they are unbuilt during an
 * incremental dev build.
 */
async function loadPhase2(): Promise<{ memory: MemoryExports; policy: PolicyExports } | undefined> {
  try {
    const memory = (await import('@lunaris/memory')) as unknown as MemoryExports;
    const policy = (await import('@lunaris/policy')) as unknown as PolicyExports;
    return { memory, policy };
  } catch {
    return undefined;
  }
}

/** Autonomy level from manifest (best-effort), defaulting to L2 (workspace). */
function manifestLevel(manifest: LunarisManifest): AutonomyLevel {
  const raw = (manifest as unknown as { autonomy?: unknown; autonomyLevel?: unknown }).autonomy;
  const lvl = typeof raw === 'number' ? raw : (manifest as unknown as { autonomyLevel?: unknown }).autonomyLevel;
  return lvl === 0 || lvl === 1 || lvl === 2 || lvl === 3 ? (lvl as AutonomyLevel) : 2;
}

export const defaultGoalRunner: GoalRunner = async ({ goal, manifest, events, projectRoot }) => {
  const ledger = new InMemoryBudgetLedger(manifest.budgets ?? {});
  const gateway = new ModelGateway({ manifest, events, ledger });

  const extras: AgentLoopExtras = {};
  let closeAll: () => void = () => {};
  const phase2 = await loadPhase2();
  if (phase2) {
    const memory = new phase2.memory.SqliteMemoryStore({
      dbPath: memoryDbPath(projectRoot),
      projectId: goal.projectId,
    });
    const loaded = phase2.policy.loadPolicy(projectRoot, { level: manifestLevel(manifest) });
    const policy = new phase2.policy.RulePolicyEngine({
      level: loaded.level,
      rules: loaded.rules,
      tightenWhenTainted: loaded.tightenWhenTainted,
      allowlistedHosts: loaded.allowlistedHosts,
    });
    const taint = new phase2.policy.TaintTracker();
    const approvals = new phase2.policy.SqliteApprovalQueue(approvalsDbPath(projectRoot));
    extras.memory = memory;
    extras.policy = policy;
    extras.taint = taint;
    extras.approvals = approvals;
    closeAll = () => {
      (memory as { close?: () => void }).close?.();
      approvals.close();
    };
  }

  try {
    const loop = new AgentLoop({
      gateway,
      events,
      projectId: goal.projectId,
      projectRoot,
      model: manifest.models.default,
      ...extras,
    });
    const outcome = await loop.run(goal);
    return outcome?.result;
  } finally {
    closeAll();
  }
};
