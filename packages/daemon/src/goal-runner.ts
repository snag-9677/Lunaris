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
  ResolvedTool,
  ResultEnvelope,
} from '@lunaris/core';
import * as gatewayPkg from '@lunaris/gateway';
import * as orchestratorPkg from '@lunaris/orchestrator';
import type { Ed25519CapabilityTokenService, SqliteLeaseStore } from '@lunaris/identity';
import { join } from 'node:path';

/**
 * Top-level run capability set (FIX 1+2). The run token is minted with this
 * ROLE-STYLE vocabulary — the exact caps the orchestrator's subagentCaps()
 * understands and attenuates per child (drops `spawn`, narrows `exec`/`fs.write`
 * by the subrole's tool allowlist). It deliberately does NOT use the `rbac:*`
 * control-plane vocabulary, which subagentCaps() does not narrow (so attenuation
 * would be a no-op). `spawn` is included so the TOP-LEVEL run may spawn
 * subagents; every child loses it. `fs.read` / `net.fetch` cover the read-only
 * tools (read_file/list_dir, web_fetch).
 */
export const TOP_LEVEL_RUN_CAPS: readonly string[] = [
  'spawn',
  'exec',
  'fs.read',
  'fs.write',
  'net.fetch',
];

/**
 * Phase 4 lease/identity runtime threaded into a goal run. Optional so the
 * Phase 1-3 code path (and tests) is unaffected when it is absent.
 */
export interface GoalLeaseRuntime {
  leaseStore: SqliteLeaseStore;
  tokenService: Ed25519CapabilityTokenService;
  nodeId: string;
  /** Heartbeat interval (default 15s; must be < the lease ttl). */
  heartbeatMs?: number;
}

export interface GoalRunContext {
  goal: Goal;
  manifest: LunarisManifest;
  events: EventStore;
  projectRoot: string;
  /**
   * Phase 3: extra plugin-provided tools to expose to the AgentLoop for this
   * run (namespaced <pluginId>/<tool>). Resolved by the caller from the
   * project's FilePluginHost; optional so non-plugin runs are unaffected.
   */
  pluginTools?: ResolvedTool[];
  /**
   * Phase 4: one-orchestrator-per-repo lease + per-run capability token. When
   * present, the runner acquires the repo lease (repoId = projectId) before
   * running; a live lease held by another holder rejects the run with
   * LeaseHeldError. A heartbeat keeps the lease alive for the run's duration and
   * the lease is released at the end. A scoped AgentToken is minted and the
   * held epoch + an isFenced() check are passed into the AgentLoop.
   */
  lease?: GoalLeaseRuntime;
  /**
   * Phase 4: a lease already acquired by the caller (e.g. the server's
   * withLease wrapper). When present, the runner uses it directly and does NOT
   * acquire/release the lease itself.
   */
  acquiredLease?: AcquiredLease;
}

/** Thrown when the project's repo lease is held by another live orchestrator. */
export class LeaseHeldError extends Error {
  readonly code = 'LEASE_HELD';
  constructor(
    readonly projectId: string,
    readonly holder: { holderId: string; nodeId: string; epoch: number },
  ) {
    super(`repo lease for ${projectId} is held by ${holder.holderId} (node ${holder.nodeId}, epoch ${holder.epoch})`);
    this.name = 'LeaseHeldError';
  }
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

/**
 * Minimal structural view of @lunaris/identity's Ed25519CapabilityTokenService:
 * the orchestrator's AgentLoop only needs attenuate() (re-sign a STRICT subset of
 * caps; throws on escalation) to derive subagent tokens. Kept structural so this
 * file does not hard-depend on the concrete class shape.
 */
export interface CapTokenService {
  attenuate(signed: string, caps: string[]): string;
}

/** The Phase 2 autonomy substrate (+ Phase 3 plugin tools) the loop may consume (all optional). */
export interface AgentLoopExtras {
  memory?: MemoryStore;
  policy?: PolicyEngine;
  taint?: unknown;
  approvals?: unknown;
  /** Phase 3: plugin tools passed to the loop under both `tools` and `extraTools`. */
  tools?: ResolvedTool[];
  extraTools?: ResolvedTool[];
  /** Phase 4: held lease epoch + signed agent token + a fencing check. */
  leaseEpoch?: number;
  /**
   * Phase 4 (FIX 1+2): the signed run capability token. The orchestrator's
   * AgentLoop reads this as `capToken` (the field name it actually consumes —
   * the legacy `agentToken` name was a DEAD field the loop never read).
   */
  capToken?: string;
  /**
   * Phase 4 (FIX 1+2): the capability-token service the AgentLoop uses to
   * ATTENUATE the run token for each subagent (only shrinks caps; throws on
   * escalation). Subagent attenuation runs only when BOTH capToken and capTokens
   * are present.
   */
  capTokens?: CapTokenService;
  /** True iff a side-effecting write may still proceed (epoch still current). */
  isFenced?: () => boolean;
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

/**
 * Acquired-lease handle: the held epoch, a scoped agent token, a fencing check,
 * a heartbeat stopper and a release. Acquisition is atomic (rejects with
 * LeaseHeldError if a live lease is held by another holder).
 */
export interface AcquiredLease {
  epoch: number;
  agentToken: string;
  /**
   * The capability-token service that minted `agentToken`. Threaded through so
   * the runner can hand it to the AgentLoop as `capTokens` for subagent
   * attenuation (FIX 1+2). attenuate() re-verifies the parent signature.
   */
  tokenService: CapTokenService;
  isFenced: () => boolean;
  stop: () => void;
}

/**
 * Acquire the per-repo lease (repoId = projectId, holderId = goal.goalId), mint
 * a scoped per-run capability token, and start a heartbeat. Throws
 * LeaseHeldError if the lease is held by another live holder. Call .stop() to
 * stop the heartbeat AND release the lease at run end.
 */
export function acquireRunLease(goal: Goal, lease: GoalLeaseRuntime): AcquiredLease {
  const holderId = goal.goalId;
  const acquired = lease.leaseStore.acquire(goal.projectId, holderId, lease.nodeId);
  if (acquired === null) {
    const current = lease.leaseStore.current(goal.projectId);
    throw new LeaseHeldError(goal.projectId, {
      holderId: current?.holderId ?? 'unknown',
      nodeId: current?.nodeId ?? 'unknown',
      epoch: current?.epoch ?? 0,
    });
  }
  const epoch = acquired.epoch;
  // Mint a per-run capability token scoped to project/run/epoch. The cap set is
  // the ROLE-STYLE top-level run set (FIX 1+2) — `spawn`, `exec`, `fs.read`,
  // `fs.write`, `net.fetch` — the exact vocabulary the orchestrator's
  // subagentCaps() understands and attenuates per child (drops `spawn`; narrows
  // `exec`/`fs.write` by the subrole's tool allowlist). It is NOT the `rbac:*`
  // control-plane vocabulary, which the orchestrator does not narrow (so
  // attenuation would have been a silent no-op). Token material never hits the
  // event spine.
  const agentToken = lease.tokenService.mint({
    principalId: `agt_${holderId}`,
    projectId: goal.projectId,
    runId: goal.goalId,
    leaseEpoch: epoch,
    caps: [...TOP_LEVEL_RUN_CAPS],
  });
  const interval = setInterval(() => {
    try {
      lease.leaseStore.heartbeat(goal.projectId, holderId);
    } catch {
      /* heartbeat best-effort; a missed beat lets the lease expire */
    }
  }, lease.heartbeatMs ?? 15_000);
  // Don't keep the process alive solely for the heartbeat.
  (interval as unknown as { unref?: () => void }).unref?.();
  return {
    epoch,
    agentToken,
    tokenService: lease.tokenService,
    isFenced: () => lease.leaseStore.isCurrentEpoch(goal.projectId, epoch),
    stop: () => {
      clearInterval(interval);
      try {
        lease.leaseStore.release(goal.projectId, holderId);
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Wrap any GoalRunner so that, when the context carries a `lease` runtime, the
 * repo lease is acquired (atomically, rejecting double-runs) before the inner
 * runner executes and released afterwards. The held epoch + agent token +
 * isFenced check are injected back into the context so the inner runner (and
 * its AgentLoop) can fence side-effecting writes. Used by the server so lease
 * semantics hold regardless of which runner is injected.
 */
export function withLease(inner: GoalRunner): GoalRunner {
  return async (ctx) => {
    if (ctx.lease === undefined) return inner(ctx);
    const held = acquireRunLease(ctx.goal, ctx.lease);
    try {
      return await inner({
        ...ctx,
        acquiredLease: held,
      });
    } finally {
      held.stop();
    }
  };
}

export const defaultGoalRunner: GoalRunner = async ({
  goal,
  manifest,
  events,
  projectRoot,
  pluginTools,
  lease,
  acquiredLease,
}) => {
  const ledger = new InMemoryBudgetLedger(manifest.budgets ?? {});
  const gateway = new ModelGateway({ manifest, events, ledger });

  const extras: AgentLoopExtras = {};
  if (pluginTools !== undefined && pluginTools.length > 0) {
    // Bind under both `tools` and `extraTools`: the loop's exact field name is
    // owned by the orchestrator package, so we supply both and let it pick.
    extras.tools = pluginTools;
    extras.extraTools = pluginTools;
  }

  // ---- Phase 4: lease epoch + scoped agent token passed into the AgentLoop ----
  //
  // The server normally wraps this runner with withLease(), which acquires the
  // lease and injects `acquiredLease`. If a raw `lease` runtime is passed
  // without a pre-acquired handle (e.g. a direct caller), acquire it here too so
  // the runner is self-sufficient. Either way the held epoch + token + fencing
  // check flow into the loop.
  let ownLease: AcquiredLease | undefined;
  const held = acquiredLease ?? (lease !== undefined ? (ownLease = acquireRunLease(goal, lease)) : undefined);
  if (held !== undefined) {
    extras.leaseEpoch = held.epoch;
    // FIX 1+2: feed the loop the fields it actually reads — `capToken` (the
    // signed run token) and `capTokens` (the service used to ATTENUATE it for
    // subagents). The previous `extras.agentToken` was DEAD (the loop reads
    // `capToken`), and without `capTokens` the loop never attenuated at all.
    extras.capToken = held.agentToken;
    extras.capTokens = held.tokenService;
    extras.isFenced = held.isFenced;
  }

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
    // Only release a lease we acquired ourselves; a caller-supplied
    // acquiredLease is released by the wrapper (withLease) that created it.
    ownLease?.stop();
    closeAll();
  }
};
