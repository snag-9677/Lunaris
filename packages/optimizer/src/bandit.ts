/**
 * RoutingBandit: a per-task-class model-routing bandit whose arms accumulate
 * across optimizer runs in SQLite (table routing_arms), matching the
 * SqliteEventStore / SqliteApprovalQueue persistence pattern (WAL for
 * file-backed stores).
 *
 * For each taskClass the arms are the models seen for that class. update() folds
 * a reward in [0,1] into the arm; select() does epsilon-greedy exploration over
 * supplied candidates (defaulting to known arms). suggestions() turns the
 * accumulated means into propose-only RoutingSuggestions for arms with enough
 * pulls.
 *
 * Reward shaping (rewardOf): a clean success is worth 1, scaled DOWN by
 * normalized cost so a cheaper model that succeeds beats a pricey one; partial
 * is 0.4; failed/blocked is 0. INFRA failures are not the model's fault and are
 * NOT fed to the bandit (callers must filter them — see runOptimizer).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RoutingArm, RoutingSuggestion, TaskOutcome } from '@lunaris/core';

export interface RoutingBanditOptions {
  /** sqlite file path (parent dirs created) or ':memory:'. */
  dbPath: string;
  projectId: string;
  /** Cost (USD) that maps to the full cost penalty; default $0.50. */
  costCeilingUsd?: number;
  /** Deterministic RNG hook for tests (returns [0,1)); default Math.random. */
  rng?: () => number;
}

interface ArmRow {
  task_class: string;
  model: string;
  pulls: number;
  reward: number;
}

const DEFAULT_COST_CEILING = 0.5;
const COST_PENALTY = 0.3; // success reward is scaled down by up to this fraction.

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export class RoutingBandit {
  private readonly db: DatabaseSync;
  private readonly projectId: string;
  private readonly costCeilingUsd: number;
  private readonly rng: () => number;

  constructor(opts: RoutingBanditOptions) {
    if (opts.dbPath !== ':memory:') {
      mkdirSync(dirname(opts.dbPath), { recursive: true });
    }
    this.projectId = opts.projectId;
    this.costCeilingUsd =
      opts.costCeilingUsd !== undefined && opts.costCeilingUsd > 0
        ? opts.costCeilingUsd
        : DEFAULT_COST_CEILING;
    this.rng = opts.rng ?? Math.random;
    this.db = new DatabaseSync(opts.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS routing_arms (
        project_id  TEXT NOT NULL,
        task_class  TEXT NOT NULL,
        model       TEXT NOT NULL,
        pulls       INTEGER NOT NULL DEFAULT 0,
        reward      REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, task_class, model)
      );
    `);
  }

  /**
   * Map an outcome to a scalar reward in [0,1]. Returns null for infra failures,
   * which must not be fed to the bandit (the caller skips a null reward).
   */
  rewardOf(outcome: TaskOutcome): number | null {
    if (outcome.failureClass === 'infra') return null;
    switch (outcome.status) {
      case 'success': {
        const costFrac = clamp01(outcome.costUsd / this.costCeilingUsd);
        return clamp01(1 - costFrac * COST_PENALTY);
      }
      case 'partial':
        return 0.4;
      case 'failed':
      case 'blocked':
        return 0;
      default:
        return 0;
    }
  }

  /** Fold one reward (clamped to [0,1]) into an arm, accumulating in SQLite. */
  update(taskClass: string, model: string, reward: number): void {
    const r = clamp01(reward);
    this.db
      .prepare(
        `INSERT INTO routing_arms (project_id, task_class, model, pulls, reward)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(project_id, task_class, model)
         DO UPDATE SET pulls = pulls + 1, reward = reward + excluded.reward`,
      )
      .run(this.projectId, taskClass, model, r);
  }

  /** Convenience: derive the reward and update, skipping infra failures. */
  observe(outcome: TaskOutcome): void {
    const reward = this.rewardOf(outcome);
    if (reward === null) return;
    this.update(outcome.taskClass, outcome.model, reward);
  }

  /**
   * Epsilon-greedy model choice for a task class. With probability epsilon
   * explore a uniformly random candidate; otherwise exploit the highest mean
   * reward. Candidates default to the known arms for the class. Returns null
   * only when there is nothing to choose from.
   */
  select(taskClass: string, candidates?: string[], epsilon = 0.1): string | null {
    const arms = this.armsFor(taskClass);
    const pool =
      candidates !== undefined && candidates.length > 0
        ? candidates
        : arms.map((a) => a.model);
    if (pool.length === 0) return null;
    if (pool.length === 1) return pool[0] ?? null;

    if (this.rng() < epsilon) {
      const idx = Math.min(pool.length - 1, Math.floor(this.rng() * pool.length));
      return pool[idx] ?? null;
    }

    const meanByModel = new Map(arms.map((a) => [a.model, a.meanReward]));
    let best = pool[0] ?? null;
    let bestMean = best !== null ? (meanByModel.get(best) ?? -1) : -1;
    for (const model of pool) {
      // An unseen candidate gets mean 0; prefer exploring it over a known-bad arm
      // only via the epsilon branch, so unseen ties resolve to first-seen order.
      const mean = meanByModel.get(model) ?? 0;
      if (mean > bestMean) {
        best = model;
        bestMean = mean;
      }
    }
    return best;
  }

  /** All arms for this project, ordered by taskClass then meanReward desc. */
  arms(): RoutingArm[] {
    const rows = this.db
      .prepare(
        `SELECT task_class, model, pulls, reward
           FROM routing_arms
          WHERE project_id = ?
          ORDER BY task_class ASC`,
      )
      .all(this.projectId) as unknown as ArmRow[];
    return rows.map(rowToArm).sort((a, b) =>
      a.taskClass !== b.taskClass
        ? a.taskClass < b.taskClass
          ? -1
          : 1
        : b.meanReward - a.meanReward,
    );
  }

  private armsFor(taskClass: string): RoutingArm[] {
    const rows = this.db
      .prepare(
        `SELECT task_class, model, pulls, reward
           FROM routing_arms
          WHERE project_id = ? AND task_class = ?`,
      )
      .all(this.projectId, taskClass) as unknown as ArmRow[];
    return rows.map(rowToArm).sort((a, b) => b.meanReward - a.meanReward);
  }

  /**
   * Propose-only routing suggestions: for each task class with a best arm of at
   * least minN pulls, recommend that arm. Confidence blends sample size with the
   * mean-reward gap to the runner-up (a wide, well-sampled gap is high
   * confidence; a thin or close race is low).
   */
  suggestions(minN = 8): RoutingSuggestion[] {
    const byClass = new Map<string, RoutingArm[]>();
    for (const arm of this.arms()) {
      const list = byClass.get(arm.taskClass) ?? [];
      list.push(arm);
      byClass.set(arm.taskClass, list);
    }

    const out: RoutingSuggestion[] = [];
    for (const [taskClass, arms] of byClass) {
      const sorted = [...arms].sort((a, b) => b.meanReward - a.meanReward);
      const best = sorted[0];
      if (best === undefined || best.pulls < minN) continue;

      const runnerUp = sorted[1];
      const gap = runnerUp !== undefined ? best.meanReward - runnerUp.meanReward : best.meanReward;
      // Sample term saturates around 4*minN pulls; gap term rewards separation.
      const sampleTerm = clamp01(best.pulls / (minN * 4));
      const gapTerm = clamp01(gap * 2);
      const confidence = clamp01(0.4 * sampleTerm + 0.6 * gapTerm);

      const rationale =
        runnerUp !== undefined
          ? `mean reward ${best.meanReward.toFixed(3)} over ${best.pulls} pulls beats ${runnerUp.model} (${runnerUp.meanReward.toFixed(3)}) by ${gap.toFixed(3)}`
          : `mean reward ${best.meanReward.toFixed(3)} over ${best.pulls} pulls (only arm seen)`;

      out.push({
        taskClass,
        recommendedModel: best.model,
        rationale,
        confidence,
        basedOnN: best.pulls,
      });
    }
    out.sort((a, b) => (a.taskClass < b.taskClass ? -1 : a.taskClass > b.taskClass ? 1 : 0));
    return out;
  }

  close(): void {
    this.db.close();
  }
}

function rowToArm(row: ArmRow): RoutingArm {
  return {
    taskClass: row.task_class,
    model: row.model,
    pulls: row.pulls,
    reward: row.reward,
    meanReward: row.pulls > 0 ? row.reward / row.pulls : 0,
  };
}
