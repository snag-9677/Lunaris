/**
 * startSchedulerLoop: one periodic tick (default 30s) that, for each registered
 * project, fires due cron schedules into that project's goal queue and then
 * drains the queue through a Dispatcher whose runGoal drives the orchestrator
 * (via runQueuedGoal). Plugin tools, if any, are resolved per run.
 *
 * Resilience: a failing project tick is caught and logged so it can never kill
 * the loop or starve sibling projects. The interval is unref()'d so it does not
 * keep the process alive on its own; SIGINT-driven shutdown calls stop().
 *
 * The daemon binds 127.0.0.1, so webhook intake requires an external tunnel —
 * but the schedule tick + queue drain run entirely locally.
 */
import { existsSync } from 'node:fs';
import type { EventStore, QueuedGoal } from '@lunaris/core';
import type { ProjectRegistry } from './registry.js';
import type { GoalRunner } from './goal-runner.js';
import { defaultGoalRunner } from './goal-runner.js';
import { runQueuedGoal } from './queue-runner.js';
import {
  loadPlugdPkg,
  loadSchedulerPkg,
  pluginsDir,
  queueDbPath,
  scheduleDbPath,
} from './phase3.js';

export interface StartSchedulerLoopOptions {
  events: EventStore;
  registry: ProjectRegistry;
  /** Goal execution strategy (defaults to the gateway+AgentLoop runner). */
  runGoal?: GoalRunner;
  /** Tick interval in ms (default 30_000). */
  intervalMs?: number;
  /** Max goals drained per project per tick (dispatcher concurrency, default 2). */
  concurrency?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Optional log sink. */
  log?: { warn?: (obj: unknown, msg?: string) => void; error?: (obj: unknown, msg?: string) => void };
}

export interface SchedulerLoopHandle {
  /** Run one tick across all projects immediately (also used by tests). */
  tickOnce(): Promise<void>;
  stop(): void;
}

/** Resolve enabled plugin tools for a project (best-effort; [] on any failure). */
async function pluginToolsFor(projectRoot: string): Promise<import('@lunaris/core').ResolvedTool[]> {
  const pkg = await loadPlugdPkg();
  if (!pkg) return [];
  try {
    const host = new pkg.FilePluginHost({ pluginsDir: pluginsDir(projectRoot) });
    return await host.enabledTools();
  } catch {
    return [];
  }
}

export function startSchedulerLoop(opts: StartSchedulerLoopOptions): SchedulerLoopHandle {
  const runGoal = opts.runGoal ?? defaultGoalRunner;
  const intervalMs = opts.intervalMs ?? 30_000;
  const concurrency = opts.concurrency ?? 2;
  const now = opts.now ?? (() => new Date());

  const tickProject = async (root: string): Promise<void> => {
    const pkg = await loadSchedulerPkg();
    if (!pkg) return;

    const at = now();
    const queue = new pkg.SqliteGoalQueue(queueDbPath(root), { now });
    try {
      // Fire due schedules into the queue (only if a schedule store exists).
      if (existsSync(scheduleDbPath(root))) {
        const schedules = new pkg.SqliteScheduleStore(scheduleDbPath(root), { now });
        try {
          schedules.tick(at, (projectId, prompt, source) => {
            queue.push({ projectId, prompt, source, priority: 0 });
          });
        } finally {
          schedules.close();
        }
      }

      // Drain the queue through a dispatcher driving the orchestrator.
      const dispatcher = new pkg.Dispatcher({
        queue,
        concurrency,
        now,
        runGoal: (g: QueuedGoal) =>
          runQueuedGoal(g, {
            events: opts.events,
            projectRoot: root,
            runGoal,
            pluginToolsFor: () => pluginToolsFor(root),
          }),
      });
      await dispatcher.drainOnce(at);
    } finally {
      queue.close();
    }
  };

  const tickOnce = async (): Promise<void> => {
    for (const project of opts.registry.list()) {
      try {
        await tickProject(project.root);
      } catch (err) {
        opts.log?.error?.({ err, projectId: project.id }, 'scheduler tick failed for project');
      }
    }
  };

  let running = false;
  const timer = setInterval(() => {
    if (running) return; // skip overlapping ticks
    running = true;
    void tickOnce()
      .catch((err: unknown) => opts.log?.error?.({ err }, 'scheduler loop tick rejected'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();

  return {
    tickOnce,
    stop: () => clearInterval(timer),
  };
}
