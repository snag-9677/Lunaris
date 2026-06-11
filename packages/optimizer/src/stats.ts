/**
 * Outcome statistics: group TaskOutcome rows by <taskClass>/<role>/<model> and
 * summarize n, successes, a Wilson lower-bound success rate, and average
 * cost/duration.
 *
 * Quality stance: infra failures are NOT the model's fault, so they are
 * excluded from the success denominator entirely (counted separately and
 * surfaced in OptimizerReport.notes). This keeps a flaky sandbox from dragging
 * down a model's measured quality.
 */
import type { OutcomeStats, TaskOutcome } from '@lunaris/core';

/**
 * Wilson score interval lower bound for a binomial proportion. Penalizes small
 * samples (a 1/1 success scores far below 1.0), which is exactly what we want
 * before recommending a model on thin evidence. Returns 0 for n <= 0.
 */
export function wilsonLowerBound(successes: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const s = Math.max(0, Math.min(successes, n));
  const phat = s / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  const lb = (centre - margin) / denom;
  return Math.max(0, Math.min(1, lb));
}

/** Aggregate of how many infra failures were dropped while computing stats. */
export interface StatsResult {
  stats: OutcomeStats[];
  /** Outcomes excluded from quality stats because failureClass === 'infra'. */
  infraExcluded: number;
}

interface Acc {
  taskClass: string;
  role: string;
  model: string;
  n: number;
  successes: number;
  costSum: number;
  durationSum: number;
}

function isInfra(o: TaskOutcome): boolean {
  return o.failureClass === 'infra';
}

/**
 * Group outcomes by key and compute per-group stats. Infra failures are
 * excluded from every group (they do not count toward n, successes, or the
 * averages); the count of excluded rows is returned alongside.
 *
 * `successes` counts status === 'success' only (partial does not count as a
 * success here — it is a non-failure but not a clean win).
 */
export function computeStatsResult(outcomes: TaskOutcome[]): StatsResult {
  const groups = new Map<string, Acc>();
  let infraExcluded = 0;

  for (const o of outcomes) {
    if (isInfra(o)) {
      infraExcluded += 1;
      continue;
    }
    const key = `${o.taskClass}/${o.role}/${o.model}`;
    let acc = groups.get(key);
    if (acc === undefined) {
      acc = {
        taskClass: o.taskClass,
        role: o.role,
        model: o.model,
        n: 0,
        successes: 0,
        costSum: 0,
        durationSum: 0,
      };
      groups.set(key, acc);
    }
    acc.n += 1;
    if (o.status === 'success') acc.successes += 1;
    acc.costSum += o.costUsd;
    acc.durationSum += o.durationMs;
  }

  const stats: OutcomeStats[] = [];
  for (const [key, acc] of groups) {
    stats.push({
      key,
      taskClass: acc.taskClass,
      role: acc.role,
      model: acc.model,
      n: acc.n,
      successes: acc.successes,
      successRate: wilsonLowerBound(acc.successes, acc.n),
      avgCostUsd: acc.n > 0 ? acc.costSum / acc.n : 0,
      avgDurationMs: acc.n > 0 ? acc.durationSum / acc.n : 0,
    });
  }

  // Deterministic order: by quality desc, then key asc as a stable tiebreak.
  stats.sort((a, b) =>
    b.successRate !== a.successRate
      ? b.successRate - a.successRate
      : a.key < b.key
        ? -1
        : a.key > b.key
          ? 1
          : 0,
  );
  return { stats, infraExcluded };
}

/** Convenience: just the grouped stats (infra count available via the *Result form). */
export function computeStats(outcomes: TaskOutcome[]): OutcomeStats[] {
  return computeStatsResult(outcomes).stats;
}
