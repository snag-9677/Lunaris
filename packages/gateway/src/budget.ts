import { randomUUID } from 'node:crypto';
import type { BudgetCaps, BudgetLedger, CallMeta, Reservation } from '@lunaris/core';

/** Thrown by BudgetLedger.reserve when a reservation would breach a configured cap. */
export class BudgetExceededError extends Error {
  readonly cap: 'perCallUsd' | 'perTaskUsd' | 'perDayUsd';
  readonly capUsd: number;
  readonly attemptedUsd: number;

  constructor(cap: 'perCallUsd' | 'perTaskUsd' | 'perDayUsd', capUsd: number, attemptedUsd: number) {
    super(
      `Budget exceeded: ${cap} cap is $${capUsd.toFixed(6)} but this reservation would bring the total to $${attemptedUsd.toFixed(6)}`,
    );
    this.name = 'BudgetExceededError';
    this.cap = cap;
    this.capUsd = capUsd;
    this.attemptedUsd = attemptedUsd;
  }
}

interface Bucket {
  reserved: number;
  settled: number;
}

function getOrCreate(map: Map<string, Bucket>, key: string): Bucket {
  let b = map.get(key);
  if (!b) {
    b = { reserved: 0, settled: 0 };
    map.set(key, b);
  }
  return b;
}

/** UTC day key, e.g. "2026-06-11". */
export function utcDayKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Transactional in-memory budget ledger (spec §2.7).
 *
 * reserve() checks caps against (reserved + settled + estimate) and commits the
 * reservation in the same synchronous frame — JS is single-threaded, so the
 * check-and-commit is atomic with no locks. Reservations count immediately, so
 * concurrent in-flight calls cannot collectively overshoot a cap.
 * settle() converts a reservation into actual spend; refund() releases it.
 * Both are idempotent: only the first finalization has any effect.
 */
export class InMemoryBudgetLedger implements BudgetLedger {
  private readonly caps: BudgetCaps;
  private readonly days = new Map<string, Bucket>();
  private readonly tasks = new Map<string, Bucket>();

  constructor(caps: BudgetCaps = {}) {
    this.caps = caps;
  }

  reserve(meta: CallMeta, estimatedUsd: number): Reservation {
    if (!Number.isFinite(estimatedUsd) || estimatedUsd < 0) {
      throw new Error(`Invalid reservation estimate: ${estimatedUsd}`);
    }
    const { perCallUsd, perTaskUsd, perDayUsd } = this.caps;

    if (perCallUsd !== undefined && estimatedUsd > perCallUsd) {
      throw new BudgetExceededError('perCallUsd', perCallUsd, estimatedUsd);
    }

    const day = getOrCreate(this.days, utcDayKey());
    if (perDayUsd !== undefined && day.reserved + day.settled + estimatedUsd > perDayUsd) {
      throw new BudgetExceededError('perDayUsd', perDayUsd, day.reserved + day.settled + estimatedUsd);
    }

    let task: Bucket | undefined;
    if (meta.taskId !== undefined) {
      task = getOrCreate(this.tasks, meta.taskId);
      if (perTaskUsd !== undefined && task.reserved + task.settled + estimatedUsd > perTaskUsd) {
        throw new BudgetExceededError('perTaskUsd', perTaskUsd, task.reserved + task.settled + estimatedUsd);
      }
    }

    // Commit — same synchronous frame as the checks above (atomic in JS).
    day.reserved += estimatedUsd;
    if (task) task.reserved += estimatedUsd;

    let finalized = false;
    const finalize = (actualUsd: number | null): void => {
      if (finalized) return;
      finalized = true;
      day.reserved = Math.max(0, day.reserved - estimatedUsd);
      if (task) task.reserved = Math.max(0, task.reserved - estimatedUsd);
      if (actualUsd !== null) {
        day.settled += actualUsd;
        if (task) task.settled += actualUsd;
      }
    };

    return {
      id: randomUUID(),
      settle: (actualUsd: number) => finalize(Number.isFinite(actualUsd) && actualUsd >= 0 ? actualUsd : 0),
      refund: () => finalize(null),
    };
  }

  /** Reserved + settled totals for a UTC day (defaults to today). For tests/status. */
  dayTotals(dayKey: string = utcDayKey()): { reserved: number; settled: number } {
    const b = this.days.get(dayKey);
    return b ? { ...b } : { reserved: 0, settled: 0 };
  }

  /** Reserved + settled totals for a task. For tests/status. */
  taskTotals(taskId: string): { reserved: number; settled: number } {
    const b = this.tasks.get(taskId);
    return b ? { ...b } : { reserved: 0, settled: 0 };
  }
}
