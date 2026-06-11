/**
 * Phase 4 daemon routes: auth/RBAC (login → token → whoami; viewer 403 vs owner
 * 200 on goal submit), lease (a second concurrent run for the same project is
 * rejected 409), lifecycle (snapshot returns SnapshotInfo), and /api/version.
 *
 * Auth tests inject an in-memory SqliteIdentityStore so principals/roles are
 * deterministic. A stub runGoal keeps goal submission from spinning up the real
 * gateway/AgentLoop.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as core from '@lunaris/core';
import type { SnapshotInfo } from '@lunaris/core';
import { SqliteIdentityStore } from '@lunaris/identity';
import { buildServer } from './server.js';
import type { GoalRunner } from './goal-runner.js';
import { leasesDbPath } from './phase4.js';

interface Env {
  dir: string;
  registryPath: string;
  eventsDbPath: string;
  cleanup: () => void;
}

function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'lunarisd-p4-test-'));
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

/** A no-op runner: never touches gateway/AgentLoop; resolves a success result. */
const stubRunner: GoalRunner = async ({ goal }) => ({
  taskId: goal.goalId,
  status: 'success',
  summary: 'ok',
});

test('auth OFF: whoami returns the implicit owner, all routes open', async () => {
  const env = makeEnv();
  const app = await buildServer({
    registryPath: env.registryPath,
    eventsDbPath: env.eventsDbPath,
    identityDbPath: ':memory:',
    authMode: 'off',
    runGoal: stubRunner,
  });
  try {
    const who = await app.inject({ method: 'GET', url: '/api/whoami' });
    assert.equal(who.statusCode, 200, who.body);
    const body = who.json() as { authMode: string; implicit: boolean; principal: { kind: string } };
    assert.equal(body.authMode, 'off');
    assert.equal(body.implicit, true);
    assert.equal(body.principal.kind, 'user');
  } finally {
    await app.close();
    env.cleanup();
  }
});

test('auth ON: login issues a token that whoami accepts; no token => 401', async () => {
  const env = makeEnv();
  const identity = new SqliteIdentityStore(':memory:');
  const owner = identity.createUser('owner', 'pw');
  identity.bind(owner.id, 'global', 'owner');
  const app = await buildServer({
    registryPath: env.registryPath,
    eventsDbPath: env.eventsDbPath,
    authMode: 'on',
    identity,
    runGoal: stubRunner,
  });
  try {
    // No token => 401 on a guarded route.
    const noTok = await app.inject({ method: 'GET', url: '/api/whoami' });
    assert.equal(noTok.statusCode, 401, noTok.body);

    // Bad credentials => 401, no token.
    const bad = await app.inject({ method: 'POST', url: '/api/login', payload: { user: 'owner', password: 'WRONG' } });
    assert.equal(bad.statusCode, 401, bad.body);

    // Good login => token.
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { user: 'owner', password: 'pw' } });
    assert.equal(login.statusCode, 200, login.body);
    const token = (login.json() as { token: string }).token;
    assert.ok(token && token.length > 0);

    // whoami accepts the token.
    const who = await app.inject({
      method: 'GET',
      url: '/api/whoami',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(who.statusCode, 200, who.body);
    const body = who.json() as { role: string; principal: { id: string } };
    assert.equal(body.role, 'owner');
    assert.equal(body.principal.id, owner.id);

    // Garbage token => 401.
    const garbage = await app.inject({
      method: 'GET',
      url: '/api/whoami',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    assert.equal(garbage.statusCode, 401, garbage.body);
  } finally {
    await app.close();
    identity.close();
    env.cleanup();
  }
});

test('auth ON RBAC: viewer is 403 on goal submit while owner is 202', async () => {
  const env = makeEnv();
  const projectRoot = mkdtempSync(join(tmpdir(), 'lunarisd-p4-project-'));
  const identity = new SqliteIdentityStore(':memory:');
  const owner = identity.createUser('owner', 'pw');
  const viewer = identity.createUser('viewer', 'pw');
  // Bind roles up front (global bindings cover every project scope).
  identity.bind(owner.id, 'global', 'owner');
  identity.bind(viewer.id, 'global', 'viewer');
  const app = await buildServer({
    registryPath: env.registryPath,
    eventsDbPath: env.eventsDbPath,
    authMode: 'on',
    identity,
    identityDbPath: ':memory:', // forces lease store to :memory: so no ~/.lunaris write
    runGoal: stubRunner,
  });
  try {
    await writeTmpProject(projectRoot);

    // Owner logs in to register the project (POST /api/projects requires
    // change_autonomy after FIX 6, which owner has).
    const ownerTok = (
      (await app.inject({ method: 'POST', url: '/api/login', payload: { user: 'owner', password: 'pw' } })).json() as {
        token: string;
      }
    ).token;
    const reg = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { root: projectRoot },
      headers: { authorization: `Bearer ${ownerTok}` },
    });
    assert.equal(reg.statusCode, 201, reg.body);
    const project = reg.json() as { id: string };

    const viewerTok = (
      (await app.inject({ method: 'POST', url: '/api/login', payload: { user: 'viewer', password: 'pw' } })).json() as {
        token: string;
      }
    ).token;

    // Viewer lacks goal.submit => 403.
    const viewerSubmit = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/goals`,
      payload: { prompt: 'do a thing' },
      headers: { authorization: `Bearer ${viewerTok}` },
    });
    assert.equal(viewerSubmit.statusCode, 403, viewerSubmit.body);

    // Owner has goal.submit => 202 (accepted, runs async via stub).
    const ownerSubmit = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/goals`,
      payload: { prompt: 'do a thing' },
      headers: { authorization: `Bearer ${ownerTok}` },
    });
    assert.equal(ownerSubmit.statusCode, 202, ownerSubmit.body);
  } finally {
    await app.close();
    identity.close();
    env.cleanup();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('FIX 6: auth ON — a viewer is 403 on POST /api/projects (registration) while an owner is allowed', async () => {
  const env = makeEnv();
  const projectRoot = mkdtempSync(join(tmpdir(), 'lunarisd-p4-fix6-'));
  const identity = new SqliteIdentityStore(':memory:');
  const owner = identity.createUser('owner', 'pw');
  const viewer = identity.createUser('viewer', 'pw');
  identity.bind(owner.id, 'global', 'owner');
  identity.bind(viewer.id, 'global', 'viewer');
  const app = await buildServer({
    registryPath: env.registryPath,
    eventsDbPath: env.eventsDbPath,
    authMode: 'on',
    identity,
    identityDbPath: ':memory:',
    runGoal: stubRunner,
  });
  try {
    await writeTmpProject(projectRoot);
    const tokenFor = async (user: string): Promise<string> =>
      (
        (await app.inject({ method: 'POST', url: '/api/login', payload: { user, password: 'pw' } })).json() as {
          token: string;
        }
      ).token;
    const ownerTok = await tokenFor('owner');
    const viewerTok = await tokenFor('viewer');

    // A viewer may LIST projects (project.read) ...
    const viewerList = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${viewerTok}` },
    });
    assert.equal(viewerList.statusCode, 200, viewerList.body);

    // ... but must NOT register a project root (needs change_autonomy) => 403.
    const viewerReg = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { root: projectRoot },
      headers: { authorization: `Bearer ${viewerTok}` },
    });
    assert.equal(viewerReg.statusCode, 403, viewerReg.body);

    // Owner (has change_autonomy) registers successfully.
    const ownerReg = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { root: projectRoot },
      headers: { authorization: `Bearer ${ownerTok}` },
    });
    assert.equal(ownerReg.statusCode, 201, ownerReg.body);
  } finally {
    await app.close();
    identity.close();
    env.cleanup();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('lease: a second concurrent run for the same project is rejected 409', async () => {
  const env = makeEnv();
  const projectRoot = mkdtempSync(join(tmpdir(), 'lunarisd-p4-lease-'));
  // A runner that holds the lease for a beat so the second submit overlaps.
  let resolveHold: (() => void) | undefined;
  const holder: GoalRunner = async ({ goal }) => {
    await new Promise<void>((res) => {
      resolveHold = res;
    });
    return { taskId: goal.goalId, status: 'success', summary: 'ok' };
  };
  const app = await buildServer({
    registryPath: env.registryPath,
    eventsDbPath: env.eventsDbPath,
    identityDbPath: ':memory:', // also routes the lease store to :memory:
    authMode: 'off',
    runGoal: holder,
  });
  try {
    await writeTmpProject(projectRoot);
    const reg = await app.inject({ method: 'POST', url: '/api/projects', payload: { root: projectRoot } });
    const project = reg.json() as { id: string };

    // First submit acquires the lease (held open by the runner).
    const first = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/goals`,
      payload: { prompt: 'first' },
    });
    assert.equal(first.statusCode, 202, first.body);

    // Give the async runner a tick to acquire the lease.
    await new Promise((r) => setTimeout(r, 50));

    // Second submit while the first still holds => 409.
    const second = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/goals`,
      payload: { prompt: 'second' },
    });
    assert.equal(second.statusCode, 409, second.body);
    const holderInfo = (second.json() as { holder?: { holderId: string } }).holder;
    assert.ok(holderInfo && typeof holderInfo.holderId === 'string');

    // Let the first run finish + release the lease.
    resolveHold?.();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await app.close();
    env.cleanup();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('lifecycle: snapshot route returns a SnapshotInfo; snapshots lists it', async () => {
  const env = makeEnv();
  const projectRoot = mkdtempSync(join(tmpdir(), 'lunarisd-p4-snap-'));
  const app = await buildServer({
    registryPath: env.registryPath,
    eventsDbPath: env.eventsDbPath,
    identityDbPath: ':memory:',
    authMode: 'off',
    runGoal: stubRunner,
  });
  try {
    await writeTmpProject(projectRoot);
    const reg = await app.inject({ method: 'POST', url: '/api/projects', payload: { root: projectRoot } });
    const project = reg.json() as { id: string };

    const snap = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/snapshot`, payload: {} });
    assert.equal(snap.statusCode, 201, snap.body);
    const info = snap.json() as SnapshotInfo;
    assert.ok(info.id && info.id.length > 0);
    assert.equal(info.projectId, project.id);
    assert.equal(typeof info.bytes, 'number');
    assert.ok(info.kind === 'full' || info.kind === 'pre-op');

    const list = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/snapshots` });
    assert.equal(list.statusCode, 200, list.body);
    const { snapshots } = list.json() as { snapshots: SnapshotInfo[] };
    assert.ok(snapshots.some((s) => s.id === info.id));
  } finally {
    await app.close();
    env.cleanup();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('/api/version returns a VersionInfo + doctor report', async () => {
  const env = makeEnv();
  const app = await buildServer({
    registryPath: env.registryPath,
    eventsDbPath: env.eventsDbPath,
    identityDbPath: ':memory:',
    authMode: 'off',
    runGoal: stubRunner,
  });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/version' });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as {
      version: { harness: string; schemaVersions: Record<string, number> };
      doctor: { harness: string; stores: { store: string; status: string }[] };
    };
    assert.match(body.version.harness, /^\d+\.\d+\.\d+/);
    assert.ok(typeof body.version.schemaVersions === 'object');
    assert.equal(body.doctor.harness, body.version.harness);
    assert.ok(Array.isArray(body.doctor.stores));
  } finally {
    await app.close();
    env.cleanup();
  }
});

// Keep an explicit reference so the import is used even if the path helper is
// only exercised indirectly (documents the ~/.lunaris/leases.db default).
test('leasesDbPath resolves under ~/.lunaris', () => {
  assert.match(leasesDbPath(), /\.lunaris[/\\]leases\.db$/);
});
