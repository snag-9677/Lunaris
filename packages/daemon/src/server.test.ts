import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as core from '@lunaris/core';
import type { EventEnvelope } from '@lunaris/core';
import { buildServer } from './server.js';

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
