import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as core from '@lunaris/core';
import type { EventEnvelope } from '@lunaris/core';
import { SqliteIdentityStore } from '@lunaris/identity';
import { buildServer, redactTicketParam } from './server.js';

interface TestEnv {
  dir: string;
  registryPath: string;
  eventsDbPath: string;
  cleanup: () => void;
}

function makeEnv(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), 'lunarisd-server-test-'));
  return {
    dir,
    registryPath: join(dir, 'projects.json'),
    eventsDbPath: join(dir, 'events.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Write a minimal project manifest via core's initManifest, then force the
 * default model to mock/echo (bound loosely so this test does not compile-
 * couple to initManifest's exact option names).
 */
async function writeTmpProject(root: string): Promise<void> {
  const initManifest = (core as unknown as Record<string, unknown>).initManifest as (
    root: string,
    opts?: Record<string, unknown>,
  ) => unknown;
  assert.equal(typeof initManifest, 'function', '@lunaris/core must export initManifest');
  await initManifest(root, { name: 'tmp-project', defaultModel: 'mock/echo', model: 'mock/echo' });

  const tomlPath = join(root, 'lunaris.toml');
  assert.ok(existsSync(tomlPath), 'initManifest should write lunaris.toml');
  const toml = readFileSync(tomlPath, 'utf8');
  if (!toml.includes('mock/echo')) {
    writeFileSync(tomlPath, toml.replace(/default\s*=\s*"[^"]*"/, 'default = "mock/echo"'), 'utf8');
  }
}

test('GET /api/status reports daemon identity and project count', async () => {
  const env = makeEnv();
  const app = await buildServer({ registryPath: env.registryPath, eventsDbPath: env.eventsDbPath });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { name: string; version: string; projects: number; uptime: number };
    assert.equal(body.name, 'lunarisd');
    assert.equal(typeof body.version, 'string');
    assert.equal(body.projects, 0);
    assert.equal(typeof body.uptime, 'number');
  } finally {
    await app.close();
    env.cleanup();
  }
});

test('listen refuses non-loopback hosts (Phase 1 security rule)', async () => {
  const env = makeEnv();
  const app = await buildServer({ registryPath: env.registryPath, eventsDbPath: env.eventsDbPath });
  try {
    await assert.rejects(
      async () => app.listen({ port: 0, host: '0.0.0.0' }),
      /127\.0\.0\.1 only/,
    );
    // Loopback listen works and is bound to 127.0.0.1.
    const address = await app.listen({ port: 0 });
    assert.match(address, /127\.0\.0\.1/);
  } finally {
    await app.close();
    env.cleanup();
  }
});

test('register project + POST goal (mock/echo) produces an llm.call event', async () => {
  const env = makeEnv();
  const projectRoot = mkdtempSync(join(tmpdir(), 'lunarisd-tmp-project-'));
  const app = await buildServer({ registryPath: env.registryPath, eventsDbPath: env.eventsDbPath });
  try {
    await writeTmpProject(projectRoot);

    const reg = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { root: projectRoot },
    });
    assert.equal(reg.statusCode, 201, reg.body);
    const project = reg.json() as { id: string; name: string; root: string };
    assert.equal(typeof project.id, 'string');

    const goalRes = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/goals`,
      payload: { prompt: 'say hello' },
    });
    assert.equal(goalRes.statusCode, 202, goalRes.body);
    const { goalId } = goalRes.json() as { goalId: string };
    assert.equal(typeof goalId, 'string');

    // Poll the events endpoint until the terminal goal.done event appears (timeout 5s).
    const deadline = Date.now() + 5000;
    let kinds: string[] = [];
    let done: EventEnvelope | undefined;
    while (Date.now() < deadline) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/events?limit=100`,
      });
      assert.equal(res.statusCode, 200, res.body);
      const list = res.json() as EventEnvelope[];
      kinds = list.map((e) => e.kind);
      done = list.find((e) => e.kind === 'goal.done');
      if (done !== undefined) break;
      await delay(100);
    }
    assert.ok(
      done,
      `expected a terminal goal.done event within 5s; saw kinds: ${JSON.stringify(kinds)}`,
    );
    assert.ok(kinds.includes('llm.call'), 'expected an llm.call event');
    assert.ok(kinds.includes('goal.created'), 'expected a goal.created event');
    assert.ok(!kinds.includes('goal.failed'), 'successful goal must not emit goal.failed');
    const donePayload = done.payload as { goalId?: string; result?: { status?: string; summary?: string } };
    assert.equal(donePayload.goalId, goalId, 'goal.done carries the goal id');
    assert.ok(
      donePayload.result && typeof donePayload.result.status === 'string',
      'goal.done carries the ResultEnvelope',
    );
  } finally {
    await app.close();
    env.cleanup();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('WS /api/ws streams appended events as JSON', async () => {
  const env = makeEnv();
  const app = await buildServer({ registryPath: env.registryPath, eventsDbPath: env.eventsDbPath });
  interface WsLike {
    onopen: ((ev: unknown) => void) | null;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onerror: ((ev: unknown) => void) | null;
    close(): void;
  }
  const WebSocketCtor = (globalThis as unknown as { WebSocket: new (url: string) => WsLike })
    .WebSocket;
  let ws: WsLike | undefined;
  try {
    const address = await app.listen({ port: 0 });
    ws = new WebSocketCtor(`${address.replace(/^http/, 'ws')}/api/ws`);
    const socket = ws;

    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = (ev) => reject(new Error(`ws error: ${String(ev)}`));
    });

    const received = new Promise<EventEnvelope>((resolve) => {
      socket.onmessage = (ev) => resolve(JSON.parse(String(ev.data)) as EventEnvelope);
    });

    // Append until the message arrives (avoids subscribe/handshake races).
    const deadline = Date.now() + 5000;
    let envelope: EventEnvelope | undefined;
    while (Date.now() < deadline && envelope === undefined) {
      app.lunaris.events.append({ projectId: 'ws-test', kind: 'test.ping', payload: { ok: true } });
      envelope = await Promise.race([received, delay(100).then(() => undefined)]);
    }

    assert.ok(envelope, 'expected a WS event message within 5s');
    assert.equal(envelope.kind, 'test.ping');
    assert.equal(envelope.projectId, 'ws-test');
    assert.equal(typeof envelope.eventId, 'string');
    assert.equal(typeof envelope.ts, 'string');
  } finally {
    ws?.close();
    await app.close();
    env.cleanup();
  }
});

test('FIX 3: redactTicketParam strips the ticket value from a URL', () => {
  assert.equal(redactTicketParam('/api/ws?ticket=secret-token'), '/api/ws?ticket=[REDACTED]');
  assert.equal(
    redactTicketParam('/api/ws?foo=1&ticket=abc123&bar=2'),
    '/api/ws?foo=1&ticket=[REDACTED]&bar=2',
  );
  // No ticket param: URL is unchanged.
  assert.equal(redactTicketParam('/api/projects?limit=10'), '/api/projects?limit=10');
});

/**
 * Open a WS to `wsUrl` and resolve true iff it AUTHENTICATES — i.e. it stays
 * open past a short settle window. The HTTP upgrade (101) completes regardless,
 * so a rejected connection fires `onopen` and is then immediately closed by the
 * server with code 1008; we therefore treat a close (or error) within the
 * settle window as "rejected", and survival past it as "authorized".
 */
function tryWsConnect(wsUrl: string): Promise<boolean> {
  interface WsLike {
    onopen: ((ev: unknown) => void) | null;
    onclose: ((ev: { code?: number }) => void) | null;
    onerror: ((ev: unknown) => void) | null;
    close(): void;
  }
  const Ctor = (globalThis as unknown as { WebSocket: new (url: string) => WsLike }).WebSocket;
  return new Promise<boolean>((resolve) => {
    const ws = new Ctor(wsUrl);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (authorized: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(authorized);
    };
    ws.onopen = () => {
      // Survive the settle window without a server-initiated close => authorized.
      timer = setTimeout(() => done(true), 250);
    };
    ws.onclose = () => done(false);
    ws.onerror = () => done(false);
  });
}

test('FIX 3: auth ON — bearer token is rejected as a WS ticket; a fresh ws-ticket works once and is rejected on reuse', async () => {
  const env = makeEnv();
  const identity = new SqliteIdentityStore(':memory:');
  const owner = identity.createUser('owner', 'pw');
  identity.bind(owner.id, 'global', 'owner');
  const app = await buildServer({
    registryPath: env.registryPath,
    eventsDbPath: env.eventsDbPath,
    authMode: 'on',
    identity,
  });
  try {
    const address = await app.listen({ port: 0 });
    const wsBase = `${address.replace(/^http/, 'ws')}/api/ws`;

    // Log in to obtain the long-lived bearer token.
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { user: 'owner', password: 'pw' } });
    assert.equal(login.statusCode, 200, login.body);
    const token = (login.json() as { token: string }).token;

    // The bearer token must NOT be accepted as a WS ticket (FIX 3).
    assert.equal(
      await tryWsConnect(`${wsBase}?ticket=${encodeURIComponent(token)}`),
      false,
      'bearer token must be rejected as a ws ticket',
    );

    // No ticket at all => rejected.
    assert.equal(await tryWsConnect(wsBase), false, 'missing ticket must be rejected');

    // Mint a short-lived single-use ws-ticket (requires the bearer in the header).
    const noAuthTicket = await app.inject({ method: 'POST', url: '/api/ws-ticket' });
    assert.equal(noAuthTicket.statusCode, 401, 'minting a ws-ticket requires auth');

    const minted = await app.inject({
      method: 'POST',
      url: '/api/ws-ticket',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(minted.statusCode, 201, minted.body);
    const { ticket } = minted.json() as { ticket: string; expiresInMs: number };
    assert.ok(ticket && ticket.length > 0);
    assert.notEqual(ticket, token, 'ws-ticket must be distinct from the bearer token');

    // The fresh ticket opens the socket exactly once.
    assert.equal(await tryWsConnect(`${wsBase}?ticket=${encodeURIComponent(ticket)}`), true, 'fresh ticket must work');

    // Re-using the same ticket is rejected (single-use).
    assert.equal(
      await tryWsConnect(`${wsBase}?ticket=${encodeURIComponent(ticket)}`),
      false,
      'a consumed ticket must be rejected on reuse',
    );
  } finally {
    await app.close();
    identity.close();
    env.cleanup();
  }
});
