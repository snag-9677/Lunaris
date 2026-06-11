/**
 * Dispatcher: drains a GoalQueue by leasing eligible goals and handing each to
 * an injected runGoal(queuedGoal) => Promise<{ goalId, status }>.
 *
 * Concurrency is bounded (default 2): drainOnce leases up to `concurrency`
 * goals, runs them in parallel, and on settle calls complete() for a successful
 * status or fail(retry) otherwise. A single goal that rejects (a thrown runGoal)
 * is caught and failed — it must NEVER kill the loop or sink sibling goals.
 *
 * start(intervalMs) runs drainOnce on a setInterval (timer stored on the
 * instance); stop() clears it. drainOnce(now?) is exposed for deterministic
 * tests and accepts an injected clock value forwarded to lease().
 */
import type { GoalQueue, QueuedGoal } from '@lunaris/core';

/** What an injected runner returns for a leased goal. */
export interface RunResult {
  /** the orchestrator run id this dispatch produced. */
  goalId: string;
  status: 'success' | 'partial' | 'failed' | 'blocked';
}

export type RunGoalFn = (g: QueuedGoal) => Promise<RunResult>;

export interface DispatcherOptions {
  queue: GoalQueue;
  runGoal: RunGoalFn;
  /** Max goals in flight per drain pass. Default 2. */
  concurrency?: number;
  /**
   * Whether a failed/throwing goal should be retried (subject to the queue's own
   * attempts<maxAttempts gate). May be a constant or a predicate of the goal +
   * error. Default true.
   */
  retryOnFailure?: boolean | ((g: QueuedGoal, error?: unknown) => boolean);
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Optional sink for observability of dispatch outcomes (never throws upstream). */
  onSettled?: (g: QueuedGoal, result: RunResult | { error: unknown }) => void;
}

export class Dispatcher {
  private readonly queue: GoalQueue;
  private readonly runGoal: RunGoalFn;
  private readonly concurrency: number;
  private readonly retryOnFailure: boolean | ((g: QueuedGoal, error?: unknown) => boolean);
  private readonly now: () => Date;
  private readonly onSettled: ((g: QueuedGoal, r: RunResult | { error: unknown }) => void) | undefined;

  private timer: ReturnType<typeof setInterval> | undefined;
  /** Guards against overlapping drains when a tick is still in flight. */
  private draining = false;

  constructor(opts: DispatcherOptions) {
    this.queue = opts.queue;
    this.runGoal = opts.runGoal;
    this.concurrency = Math.max(1, Math.floor(opts.concurrency ?? 2));
    this.retryOnFailure = opts.retryOnFailure ?? true;
    this.now = opts.now ?? (() => new Date());
    this.onSettled = opts.onSettled;
  }

  private shouldRetry(g: QueuedGoal, error?: unknown): boolean {
    return typeof this.retryOnFailure === 'function'
      ? this.retryOnFailure(g, error)
      : this.retryOnFailure;
  }

  /** Run one leased goal to completion, translating outcome into queue state. */
  private async runOne(g: QueuedGoal): Promise<void> {
    try {
      const result = await this.runGoal(g);
      if (result.status === 'success') {
        this.queue.complete(g.id, result.goalId);
      } else {
        // Non-success terminal statuses are failures from the queue's view.
        this.queue.fail(g.id, this.shouldRetry(g), `status=${result.status}`);
      }
      this.onSettled?.(g, result);
    } catch (err) {
      // A throwing runner must not propagate — fail the goal and keep draining.
      const message = err instanceof Error ? err.message : String(err);
      this.queue.fail(g.id, this.shouldRetry(g, err), message);
      this.onSettled?.(g, { error: err });
    }
  }

  /**
   * Lease up to `concurrency` eligible goals and run them in parallel. Returns
   * the number of goals dispatched this pass. Re-entrancy is guarded: if a drain
   * is already in flight, this resolves to 0 without leasing.
   */
  async drainOnce(now?: Date): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    try {
      const at = now ?? this.now();
      const batch: QueuedGoal[] = [];
      for (let i = 0; i < this.concurrency; i++) {
        const leased = this.queue.lease(at);
        if (leased === null) break;
        batch.push(leased);
      }
      if (batch.length === 0) return 0;
      // allSettled (not all) so one rejection can't abort siblings; runOne also
      // catches internally, this is belt-and-braces.
      await Promise.allSettled(batch.map((g) => this.runOne(g)));
      return batch.length;
    } finally {
      this.draining = false;
    }
  }

  /** Begin periodic draining. Idempotent — a second start is a no-op while running. */
  start(intervalMs: number): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      // Errors inside drainOnce are already swallowed per-goal; guard the tick too.
      void this.drainOnce().catch(() => {
        /* never let a tick rejection kill the interval */
      });
    }, intervalMs);
    // Don't keep the event loop alive solely for the dispatcher.
    this.timer.unref?.();
  }

  /** Stop periodic draining. Safe to call when not started. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
