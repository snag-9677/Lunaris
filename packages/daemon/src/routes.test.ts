/**
 * Phase 2 daemon routes: analytics + approvals + policy.
 *
 * These inject directly against buildServer with a temp registry/events db.
 * The analytics route reads the shared live event store, so we seed a couple of
 * events and assert the rollup. Approvals/policy routes touch per-project sqlite
 * files under <root>/.lunaris/state, so we mint a ticket via the policy package's
 * SqliteApprovalQueue and a project registered through the public API.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as core from '@lunaris/core';
import { SqliteApprovalQueue } from '@lunaris/policy';
import type { ProjectAnalytics, ApprovalTicket } from '@lunaris/core';
import { buildServer } from './server.js';
import { approvalsDbPath } from './goal-runner.js';

interface TestEnv {
  dir: string;
  registryPath: string;
  eventsDbPath: string;
  cleanup: () => void;
}

function makeEnv(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), 'lunarisd-routes-test-'));
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
  assert.equal(typeof initManifest, 'function', '@lunaris/core must export initManifest');
  await initManifest(root, { name: 'tmp-project', defaultModel: 'mock/echo', model: 'mock/echo' });
  const tomlPath = join(root, 'lunaris.toml');
  assert.ok(existsSync(tomlPath));
  const toml = readFileSync(tomlPath, 'utf8');
  if (!toml.includes('mock/echo')) {
    writeFileSync(tomlPath, toml.replace(/default\s*=\s*"[^"]*"/, 'default = "mock/echo"'), 'utf8');
  }
}

test('GET /api/projects/:id/analytics rolls up seeded events', async () => {
  const env = makeEnv();
  const projectRoot = mkdtempSync(join(tmpdir(), 'lunarisd-routes-project-'));
  const app = await buildServer({ registryPath: env.registryPath, eventsDbPath: env.eventsDbPath });
  try {
    await writeTmpProject(projectRoot);
    const reg = await app.inject({ method: 'POST', url: '/api/projects', payload: { root: projectRoot } });
    assert.equal(reg.statusCode, 201, reg.body);
    const project = reg.json() as { id: string };

    // Seed a goal lifecycle, an llm.call with usage, and a failed tool.call.
    const events = app.lunaris.events;
    const goalId = 'g-analytics-1';
    events.append({ projectId: project.id, kind: 'goal.created', payload: { goalId } });
    events.append({ projectId: project.id, kind: 'goal.done', payload: { goalId } });
    events.append({
      projectId: project.id,
      kind: 'llm.call',
      payload: { model: 'mock/echo', usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.02 } },
    });
    events.append({ projectId: project.id, kind: 'tool.call', payload: { name: 'run_bash', ok: false } });

    const res = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/analytics` });
    assert.equal(res.statusCode, 200, res.body);
    const a = res.json() as ProjectAnalytics;
    assert.equal(a.projectId, project.id);
    assert.equal(a.goals.total, 1);
    assert.equal(a.goals.done, 1);
    assert.equal(a.llm.calls, 1);
    assert.equal(a.llm.costUsd, 0.02);
    assert.equal(a.byModel.length, 1);
    assert.equal(a.byModel[0]?.model, 'mock/echo');
    assert.equal(a.tools.calls, 1);
    assert.equal(a.tools.failures, 1);
  } finally {
    await app.close();
    env.cleanup();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('approvals: list pending then resolve via POST', async () => {
  const env = makeEnv();
  const projectRoot = mkdtempSync(join(tmpdir(), 'lunarisd-routes-project-'));
  const app = await buildServer({ registryPath: env.registryPath, eventsDbPath: env.eventsDbPath });
  try {
    await writeTmpProject(projectRoot);
    const reg = await app.inject({ method: 'POST', url: '/api/projects', payload: { root: projectRoot } });
    const project = reg.json() as { id: string };

    // Mint a pending ticket directly into the project's approval queue.
    const queue = new SqliteApprovalQueue(approvalsDbPath(projectRoot));
    let ticketId: string;
    try {
      const t = queue.create({ projectId: project.id, tool: 'run_bash', args: { command: 'git push' }, reason: 'irreversible' });
      ticketId = t.ticketId;
    } finally {
      queue.close();
    }

    const listRes = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/approvals?status=pending` });
    assert.equal(listRes.statusCode, 200, listRes.body);
    const { tickets } = listRes.json() as { tickets: ApprovalTicket[] };
    assert.equal(tickets.length, 1);
    assert.equal(tickets[0]?.ticketId, ticketId);
    assert.equal(tickets[0]?.status, 'pending');

    const resolveRes = await app.inject({
      method: 'POST',
      url: `/api/approvals/${ticketId}/resolve`,
      payload: { approved: true, by: 'tester' },
    });
    assert.equal(resolveRes.statusCode, 200, resolveRes.body);
    const resolved = resolveRes.json() as ApprovalTicket;
    assert.equal(resolved.status, 'approved');
    assert.equal(resolved.resolvedBy, 'tester');

    // Now no pending tickets remain.
    const after = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/approvals?status=pending` });
    const afterList = (after.json() as { tickets: ApprovalTicket[] }).tickets;
    assert.equal(afterList.length, 0);
  } finally {
    await app.close();
    env.cleanup();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('policy: GET defaults then PUT updates the level', async () => {
  const env = makeEnv();
  const projectRoot = mkdtempSync(join(tmpdir(), 'lunarisd-routes-project-'));
  const app = await buildServer({ registryPath: env.registryPath, eventsDbPath: env.eventsDbPath });
  try {
    await writeTmpProject(projectRoot);
    const reg = await app.inject({ method: 'POST', url: '/api/projects', payload: { root: projectRoot } });
    const project = reg.json() as { id: string };

    const getRes = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/policy` });
    assert.equal(getRes.statusCode, 200, getRes.body);
    const loaded = getRes.json() as { level: number; rules: unknown[] };
    assert.equal(loaded.level, 2, 'absent policy.yaml falls back to L2');
    assert.ok(Array.isArray(loaded.rules));

    const putRes = await app.inject({
      method: 'PUT',
      url: `/api/projects/${project.id}/policy`,
      payload: { level: 1 },
    });
    assert.equal(putRes.statusCode, 200, putRes.body);
    const updated = putRes.json() as { level: number };
    assert.equal(updated.level, 1);

    // Re-read to confirm persistence to .lunaris/policy.yaml.
    const reread = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/policy` });
    assert.equal((reread.json() as { level: number }).level, 1);
  } finally {
    await app.close();
    env.cleanup();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('memory routes return empty shapes when no memory db exists', async () => {
  const env = makeEnv();
  const projectRoot = mkdtempSync(join(tmpdir(), 'lunarisd-routes-project-'));
  const app = await buildServer({ registryPath: env.registryPath, eventsDbPath: env.eventsDbPath });
  try {
    await writeTmpProject(projectRoot);
    const reg = await app.inject({ method: 'POST', url: '/api/projects', payload: { root: projectRoot } });
    const project = reg.json() as { id: string };

    const memRes = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/memory` });
    assert.equal(memRes.statusCode, 200, memRes.body);
    assert.deepEqual(memRes.json(), { records: [] });

    const graphRes = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/memory/graph` });
    assert.equal(graphRes.statusCode, 200, graphRes.body);
    assert.deepEqual(graphRes.json(), { entities: [], relations: [] });
  } finally {
    await app.close();
    env.cleanup();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
