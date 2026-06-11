/**
 * Phase 3 daemon routes: optimizer (run + proposals list/resolve), plugins
 * (list + enable), goal queue (push + list), schedules (create then a due tick
 * enqueues), and webhook HMAC intake (reject + accept).
 *
 * These inject against buildServer with a temp registry + shared events db; the
 * Phase 3 stores live under each project's <root>/.lunaris/state. The scheduler
 * loop is exercised directly via startSchedulerLoop().tickOnce() with an
 * injected clock so the test is deterministic.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as core from '@lunaris/core';
import type { ConfigProposal, OptimizerReport, QueuedGoal, Schedule } from '@lunaris/core';
import { buildServer } from './server.js';
import { startSchedulerLoop } from './scheduler-loop.js';
import { queueDbPath, scheduleDbPath } from './phase3.js';

interface Env {
  dir: string;
  registryPath: string;
  eventsDbPath: string;
  cleanup: () => void;
}

function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'lunarisd-p3-test-'));
  return {
    dir,
    registryPath: join(dir, 'projects.json'),
    eventsDbPath: join(dir, 'events.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function writeTmpProject(root: string): Promise<void> {
  const initManifest = (core as unknown as Record<string, unknown>).initManifest as (
    root: string,
    opts?: Record<string, unknown>,
  ) => unknown;
  await initManifest(root, { name: 'tmp-project', defaultModel: 'mock/echo', model: 'mock/echo' });
  const tomlPath = join(root, 'lunaris.toml');
  const toml = readFileSync(tomlPath, 'utf8');
  if (!toml.includes('mock/echo')) {
    writeFileSync(tomlPath, toml.replace(/default\s*=\s*"[^"]*"/, 'default = "mock/echo"'), 'utf8');
  }
}

test('optimize: POST returns a report; proposals list + resolve', async () => {
  const env = makeEnv();
  const projectRoot = mkdtempSync(join(tmpdir(), 'lunarisd-p3-project-'));
  const app = await buildServer({ registryPath: env.registryPath, eventsDbPath: env.eventsDbPath });
  try {
    await writeTmpProject(projectRoot);
    const reg = await app.inject({ method: 'POST', url: '/api/projects', payload: { root: projectRoot } });
    const project = reg.json() as { id: string };

    // Seed a root-goal task outcome: goal.created/done + an llm.call on the
    // root taskId (== goalId) so deriveOutcomes reconstructs one outcome.
    const events = app.lunaris.events;
    const goalId = 'g-opt-1';
    events.append({ projectId: project.id, kind: 'goal.created', payload: { goalId, projectId: project.id, prompt: 'x', createdAt: new Date().toISOString(), status: 'running' } });
    events.append({
      projectId: project.id,
      kind: 'llm.call',
      taskId: goalId,
      agentId: 'orchestrator',
      payload: { model: 'mock/echo', usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 }, durationMs: 12, stopReason: 'end' },
    });
    events.append({ projectId: project.id, kind: 'goal.done', payload: { goalId, result: { taskId: goalId, status: 'success', summary: 'ok' } } });

    const optRes = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/optimize`, payload: {} });
    assert.equal(optRes.statusCode, 200, optRes.body);
    const report = optRes.json() as OptimizerReport;
    assert.equal(report.projectId, project.id);
    assert.ok(Array.isArray(report.stats));
    assert.ok(Array.isArray(report.proposals));
    assert.ok(report.notes.some((n) => n.includes('PROPOSE-ONLY')));

    // proposals list endpoint reads the persisted store.
    const listRes = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/proposals` });
    assert.equal(listRes.statusCode, 200, listRes.body);
    const { proposals } = listRes.json() as { proposals: ConfigProposal[] };
    assert.ok(Array.isArray(proposals));

    // If any proposal was generated, resolving it flips its status (propose-only).
    if (proposals.length > 0) {
      const id = proposals[0]!.id;
      const res = await app.inject({ method: 'POST', url: `/api/proposals/${id}/resolve`, payload: { approved: true, projectId: project.id } });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal((res.json() as ConfigProposal).status, 'approved');
    }

    // Unknown proposal => 404.
    const missing = await app.inject({ method: 'POST', url: `/api/proposals/does-not-exist/resolve`, payload: { approved: false } });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
    env.cleanup();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('plugins: list empty, then scaffold + enable shows enabled=true', async () => {
  const env = makeEnv();
  const projectRoot = mkdtempSync(join(tmpdir(), 'lunarisd-p3-project-'));
  const app = await buildServer({ registryPath: env.registryPath, eventsDbPath: env.eventsDbPath });
  try {
    await writeTmpProject(projectRoot);
    const reg = await app.inject({ method: 'POST', url: '/api/projects', payload: { root: projectRoot } });
    const project = reg.json() as { id: string };

    // No plugins dir yet => empty list.
    const empty = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/plugins` });
    assert.equal(empty.statusCode, 200, empty.body);
    assert.deepEqual(empty.json(), { plugins: [] });

    // Scaffold a plugin into <root>/.lunaris/plugins/echo via the plugd package.
    const plugd = (await import('@lunaris/plugd')) as unknown as {
      scaffoldPlugin: (dir: string, opts: { id: string; name: string }) => void;
    };
    const pluginDir = join(projectRoot, '.lunaris', 'plugins', 'echo');
    plugd.scaffoldPlugin(pluginDir, { id: 'dev.test.echo', name: 'Echo' });

    const listed = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/plugins` });
    const { plugins } = listed.json() as { plugins: { manifest: { id: string }; enabled: boolean }[] };
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0]!.manifest.id, 'dev.test.echo');
    assert.equal(plugins[0]!.enabled, false);

    const enabled = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/plugins/dev.test.echo/enable` });
    assert.equal(enabled.statusCode, 200, enabled.body);
    const after = enabled.json() as { plugins: { manifest: { id: string }; enabled: boolean }[] };
    assert.equal(after.plugins[0]!.enabled, true);

    // Path-traversal guard.
    const bad = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/plugins/..%2F..%2Fetc/enable` });
    assert.equal(bad.statusCode, 400);
  } finally {
    await app.close();
    env.cleanup();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('queue: push then list returns the queued goal', async () => {
  const env = makeEnv();
  const projectRoot = mkdtempSync(join(tmpdir(), 'lunarisd-p3-project-'));
  const app = await buildServer({ registryPath: env.registryPath, eventsDbPath: env.eventsDbPath });
  try {
    await writeTmpProject(projectRoot);
    const reg = await app.inject({ method: 'POST', url: '/api/projects', payload: { root: projectRoot } });
    const project = reg.json() as { id: string };

    const pushRes = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/queue`, payload: { prompt: 'do a thing', priority: 5 } });
    assert.equal(pushRes.statusCode, 201, pushRes.body);
    const pushed = pushRes.json() as QueuedGoal;
    assert.equal(pushed.prompt, 'do a thing');
    assert.equal(pushed.priority, 5);
    assert.equal(pushed.status, 'queued');
    assert.equal(pushed.source, 'ui');

    const listRes = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/queue` });
    assert.equal(listRes.statusCode, 200, listRes.body);
    const { goals } = listRes.json() as { goals: QueuedGoal[] };
    assert.equal(goals.length, 1);
    assert.equal(goals[0]!.id, pushed.id);

    // Empty body => 400.
    const bad = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/queue`, payload: {} });
    assert.equal(bad.statusCode, 400);
  } finally {
    await app.close();
    env.cleanup();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('schedule: create then a due scheduler tick enqueues a goal', async () => {
  const env = makeEnv();
  const projectRoot = mkdtempSync(join(tmpdir(), 'lunarisd-p3-project-'));
  // Stub goal runner so the dispatcher drain does not invoke the real loop.
  const app = await buildServer({
    registryPath: env.registryPath,
    eventsDbPath: env.eventsDbPath,
    runGoal: async () => ({ taskId: 't', status: 'success', summary: 'stub' }),
  });
  try {
    await writeTmpProject(projectRoot);
    const reg = await app.inject({ method: 'POST', url: '/api/projects', payload: { root: projectRoot } });
    const project = reg.json() as { id: string };

    // Every-minute schedule.
    const createRes = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/schedules`,
      payload: { cron: '* * * * *', prompt: 'nightly chore' },
    });
    assert.equal(createRes.statusCode, 201, createRes.body);
    const schedule = createRes.json() as Schedule;
    assert.ok(schedule.nextRunAt);

    // List shows it.
    const listRes = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/schedules` });
    const { schedules } = listRes.json() as { schedules: Schedule[] };
    assert.equal(schedules.length, 1);

    // Tick the loop at a time at/after nextRunAt with a stub runner that keeps
    // the goal queued (so we can observe the enqueue independent of dispatch).
    const enqueued: { projectId: string; prompt: string }[] = [];
    const loop = startSchedulerLoop({
      events: app.lunaris.events,
      registry: app.lunaris.registry,
      // Runner returns 'blocked' -> dispatcher will fail() it (no maxAttempts retry),
      // but the schedule's enqueue still happened first; assert via the queue db.
      runGoal: async () => ({ taskId: 't', status: 'success', summary: 'stub' }),
      now: () => new Date(new Date(schedule.nextRunAt!).getTime() + 1000),
    });
    try {
      await loop.tickOnce();
    } finally {
      loop.stop();
    }

    // The schedule should have produced a queued goal (now dispatched/completed).
    assert.ok(existsSync(queueDbPath(projectRoot)), 'queue db created by tick');
    assert.ok(existsSync(scheduleDbPath(projectRoot)), 'schedule db exists');
    const queueRes = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/queue` });
    const { goals } = queueRes.json() as { goals: QueuedGoal[] };
    assert.equal(goals.length, 1, 'one goal enqueued by the schedule tick');
    assert.equal(goals[0]!.source, `schedule:${schedule.id}`);
    // The stub runner returned success, so the dispatcher completed it.
    assert.equal(goals[0]!.status, 'done');
    assert.ok(goals[0]!.goalId, 'completed goal records the orchestrator run id');
  } finally {
    await app.close();
    env.cleanup();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('webhook intake: bad HMAC rejected, valid HMAC routes + enqueues', async () => {
  const env = makeEnv();
  const projectRoot = mkdtempSync(join(tmpdir(), 'lunarisd-p3-project-'));
  const app = await buildServer({ registryPath: env.registryPath, eventsDbPath: env.eventsDbPath });
  try {
    await writeTmpProject(projectRoot);
    const reg = await app.inject({ method: 'POST', url: '/api/projects', payload: { root: projectRoot } });
    const project = reg.json() as { id: string };

    // Set the per-project webhook secret (route reads process.env).
    const secret = 'top-secret';
    process.env['LUNARIS_WEBHOOK_SECRET'] = secret;

    // A trigger rule that fires on github 'push' events.
    const trigRes = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/triggers`,
      payload: { source: 'github', eventTypes: ['push'], promptTemplate: 'CI failed on {{ref}}' },
    });
    assert.equal(trigRes.statusCode, 201, trigRes.body);

    const body = JSON.stringify({ ref: 'refs/heads/main' });

    // Bad signature => 401.
    const bad = await app.inject({
      method: 'POST',
      url: `/hooks/${project.id}/github`,
      headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=deadbeef' },
      payload: body,
    });
    assert.equal(bad.statusCode, 401, bad.body);

    // Valid signature => routed.
    const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const ok = await app.inject({
      method: 'POST',
      url: `/hooks/${project.id}/github`,
      headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': sig },
      payload: body,
    });
    assert.equal(ok.statusCode, 200, ok.body);
    const routed = ok.json() as { matched: number; eventType: string };
    assert.equal(routed.matched, 1);
    assert.equal(routed.eventType, 'push');

    // The matched rule enqueued a goal with the rendered prompt.
    const queueRes = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/queue` });
    const { goals } = queueRes.json() as { goals: QueuedGoal[] };
    assert.equal(goals.length, 1);
    assert.equal(goals[0]!.prompt, 'CI failed on refs/heads/main');
    assert.equal(goals[0]!.source, 'webhook:github');
  } finally {
    delete process.env['LUNARIS_WEBHOOK_SECRET'];
    await app.close();
    env.cleanup();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('FIX 3: a form-urlencoded signed webhook captures rawBody so HMAC verifies', async () => {
  const env = makeEnv();
  const projectRoot = mkdtempSync(join(tmpdir(), 'lunarisd-p3-project-'));
  const app = await buildServer({ registryPath: env.registryPath, eventsDbPath: env.eventsDbPath });
  try {
    await writeTmpProject(projectRoot);
    const reg = await app.inject({ method: 'POST', url: '/api/projects', payload: { root: projectRoot } });
    const project = reg.json() as { id: string };

    const secret = 'top-secret';
    process.env['LUNARIS_WEBHOOK_SECRET'] = secret;

    await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/triggers`,
      payload: { source: 'github', eventTypes: ['push'], promptTemplate: 'CI failed on {{ref}}' },
    });

    // GitHub can deliver as application/x-www-form-urlencoded. The raw bytes must
    // be captured for that content-type, otherwise HMAC runs over the wrong body.
    const body = JSON.stringify({ ref: 'refs/heads/main' });
    const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const ok = await app.inject({
      method: 'POST',
      url: `/hooks/${project.id}/github`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-github-event': 'push',
        'x-hub-signature-256': sig,
      },
      payload: body,
    });
    assert.equal(ok.statusCode, 200, ok.body);
    const routed = ok.json() as { matched: number; eventType: string };
    assert.equal(routed.matched, 1);

    const queueRes = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/queue` });
    const { goals } = queueRes.json() as { goals: QueuedGoal[] };
    assert.equal(goals.length, 1);
    assert.equal(goals[0]!.prompt, 'CI failed on refs/heads/main');
  } finally {
    delete process.env['LUNARIS_WEBHOOK_SECRET'];
    await app.close();
    env.cleanup();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
