/**
 * runQueuedGoal: the Dispatcher's runGoal — turn a leased QueuedGoal into an
 * orchestrator run via the shared GoalRunner, emitting the same goal lifecycle
 * events as the HTTP /goals route (goal.created / goal.done / goal.failed) so
 * the UI feed and analytics treat scheduled/webhook goals identically.
 *
 * Returns the dispatcher's { goalId, status } so the queue records the run id
 * and the dispatcher can complete()/fail() the queued entry accordingly.
 */
import { randomUUID } from 'node:crypto';
import { loadManifest } from '@lunaris/core';
import type { EventStore, Goal, QueuedGoal, ResolvedTool, ResultEnvelope } from '@lunaris/core';
import type { GoalRunner } from './goal-runner.js';

export interface RunQueuedGoalDeps {
  events: EventStore;
  projectRoot: string;
  runGoal: GoalRunner;
  /** Plugin tools resolved at run time for this project (optional). */
  pluginToolsFor?: () => Promise<ResolvedTool[]>;
}

export interface QueueRunResult {
  goalId: string;
  status: 'success' | 'partial' | 'failed' | 'blocked';
}

/** Run a queued goal end-to-end; never rejects (status reflects the outcome). */
export async function runQueuedGoal(q: QueuedGoal, deps: RunQueuedGoalDeps): Promise<QueueRunResult> {
  const goalId = randomUUID();
  const goal: Goal = {
    goalId,
    projectId: q.projectId,
    prompt: q.prompt,
    createdAt: new Date().toISOString(),
    status: 'running',
  };

  try {
    const manifest = await loadManifest(deps.projectRoot);
    deps.events.append({ projectId: q.projectId, kind: 'goal.created', payload: goal });

    const pluginTools = deps.pluginToolsFor ? await deps.pluginToolsFor().catch(() => []) : undefined;
    const result: ResultEnvelope | undefined = await deps.runGoal({
      goal,
      manifest,
      events: deps.events,
      projectRoot: deps.projectRoot,
      ...(pluginTools !== undefined && pluginTools.length > 0 ? { pluginTools } : {}),
    });

    deps.events.append({
      projectId: q.projectId,
      kind: 'goal.done',
      payload: { goalId, ...(result !== undefined ? { result } : {}) },
    });
    return { goalId, status: result?.status ?? 'success' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      deps.events.append({ projectId: q.projectId, kind: 'goal.failed', payload: { goalId, error: message } });
    } catch {
      /* event append best-effort */
    }
    return { goalId, status: 'failed' };
  }
}
