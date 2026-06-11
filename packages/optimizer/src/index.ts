/**
 * @lunaris/optimizer — recursive self-optimization, propose-only v1.
 *
 * Reads the event spine, reconstructs per-task outcomes, scores model quality
 * per task class, runs a persistent routing bandit, and emits human-reviewable
 * ConfigProposals + an OptimizerReport. It NEVER auto-applies a change.
 */
export { classifyTask, deriveOutcomes } from './ledger.js';
export { computeStats, computeStatsResult, wilsonLowerBound } from './stats.js';
export type { StatsResult } from './stats.js';
export { RoutingBandit } from './bandit.js';
export type { RoutingBanditOptions } from './bandit.js';
export { SqliteProposalStore, generateProposals } from './proposals.js';
export type { CreateProposalInput } from './proposals.js';
export { runOptimizer } from './optimizer.js';
export type { RunOptimizerOptions } from './optimizer.js';
