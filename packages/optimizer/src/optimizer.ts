/**
 * runOptimizer: the nightly/idle entry point for Lunaris recursive
 * self-optimization, propose-only v1.
 *
 * Pipeline: derive TaskOutcomes from the event spine -> compute grouped stats
 * (excluding infra failures) -> feed every non-infra outcome to the persistent
 * routing bandit -> read back routing suggestions -> generate + persist
 * ConfigProposals -> assemble an OptimizerReport.
 *
 * It NEVER applies a change: all output is proposals + an advisory report.
 */
import type { EventStore, OptimizerReport } from '@lunaris/core';
import { deriveOutcomes } from './ledger.js';
import { computeStatsResult } from './stats.js';
import { RoutingBandit } from './bandit.js';
import { SqliteProposalStore, generateProposals } from './proposals.js';

export interface RunOptimizerOptions {
  /** Live EventStore or a sqlite db path (read-only) for the event spine. */
  store: EventStore | string;
  /** SQLite path for the routing bandit's accumulating arms (or ':memory:'). */
  banditDbPath: string;
  /** SQLite path for the proposal queue (or ':memory:'). */
  proposalDbPath: string;
  projectId: string;
  /** Only consider events at/after this ISO timestamp. */
  sinceIso?: string;
  /** Minimum pulls before a routing arm yields a suggestion (default 8). */
  minSuggestionN?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Reuse an existing bandit (e.g. tests); else one is opened on banditDbPath. */
  bandit?: RoutingBandit;
  /** Reuse an existing proposal store; else one is opened on proposalDbPath. */
  proposalStore?: SqliteProposalStore;
}

export function runOptimizer(opts: RunOptimizerOptions): OptimizerReport {
  const now = opts.now ?? (() => new Date());
  const generatedAt = now().toISOString();

  const outcomes = deriveOutcomes(opts.store, opts.projectId, opts.sinceIso);
  const { stats, infraExcluded } = computeStatsResult(outcomes);

  const ownBandit = opts.bandit === undefined;
  const bandit =
    opts.bandit ?? new RoutingBandit({ dbPath: opts.banditDbPath, projectId: opts.projectId });
  const ownStore = opts.proposalStore === undefined;
  const proposalStore = opts.proposalStore ?? new SqliteProposalStore(opts.proposalDbPath);

  try {
    // Feed every non-infra outcome to the bandit (rewardOf returns null for
    // infra, which observe() skips), so arms accumulate across runs.
    for (const o of outcomes) {
      bandit.observe(o);
    }

    const routing = bandit.suggestions(opts.minSuggestionN ?? 8);
    const drafts = generateProposals(stats, routing, opts.projectId, generatedAt);
    const proposals = drafts.map((d) =>
      proposalStore.create({
        projectId: d.projectId,
        kind: d.kind,
        title: d.title,
        detail: d.detail,
        ...(d.diff !== undefined ? { diff: d.diff } : {}),
        confidence: d.confidence,
        createdAt: generatedAt,
      }),
    );

    const notes: string[] = [];
    notes.push(
      `Derived ${outcomes.length} task outcome(s) across ${stats.length} class/role/model group(s).`,
    );
    if (infraExcluded > 0) {
      notes.push(
        `Excluded ${infraExcluded} infra failure(s) from quality stats and bandit rewards.`,
      );
    }
    notes.push(
      routing.length > 0
        ? `Generated ${routing.length} routing suggestion(s) and ${proposals.length} pending proposal(s).`
        : `No routing suggestions yet (need more pulls per arm); ${proposals.length} proposal(s) created.`,
    );
    notes.push('PROPOSE-ONLY: no configuration was changed; all proposals await human review.');

    return {
      projectId: opts.projectId,
      generatedAt,
      stats,
      routing,
      proposals,
      notes,
    };
  } finally {
    if (ownBandit) bandit.close();
    if (ownStore) proposalStore.close();
  }
}
