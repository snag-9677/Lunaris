/**
 * Default goal execution: wire ModelGateway (@lunaris/gateway) with an
 * InMemoryBudgetLedger and the shared EventStore, then run the orchestrator's
 * AgentLoop with the project's default model from lunaris.toml.
 *
 * NOTE: the constructor surfaces of ModelGateway / InMemoryBudgetLedger /
 * AgentLoop are not part of the shared types.ts contract, so they are bound
 * here through narrow structural casts. If a sibling package settles on a
 * different shape, this file is the single place to adjust.
 */
import type { BudgetCaps, BudgetLedger, EventStore, Goal, LunarisManifest, ResultEnvelope } from '@lunaris/core';
import * as gatewayPkg from '@lunaris/gateway';
import * as orchestratorPkg from '@lunaris/orchestrator';

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

interface OrchestratorExports {
  AgentLoop: new (opts: {
    gateway: unknown;
    events: EventStore;
    projectId: string;
    projectRoot: string;
    model: string;
  }) => {
    run(goal: Goal): Promise<{ result?: ResultEnvelope } | undefined>;
  };
}

const { InMemoryBudgetLedger, ModelGateway } = gatewayPkg as unknown as GatewayExports;
const { AgentLoop } = orchestratorPkg as unknown as OrchestratorExports;

export const defaultGoalRunner: GoalRunner = async ({ goal, manifest, events, projectRoot }) => {
  const ledger = new InMemoryBudgetLedger(manifest.budgets ?? {});
  const gateway = new ModelGateway({ manifest, events, ledger });
  const loop = new AgentLoop({
    gateway,
    events,
    projectId: goal.projectId,
    projectRoot,
    model: manifest.models.default,
  });
  const outcome = await loop.run(goal);
  return outcome?.result;
};
