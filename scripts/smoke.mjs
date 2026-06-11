#!/usr/bin/env node
/**
 * Lunaris end-to-end smoke test (no network, no API keys).
 *
 * 1. Creates a tmp project dir and runs core's initManifest (default model is
 *    mock/echo; asserted/patched defensively).
 * 2. Runs an AgentLoop goal through the real ModelGateway (mock adapter) with
 *    the orchestrator's real builtin tool registry. The mock adapter's
 *    USE_TOOL directive makes it issue a real write_file tool call.
 * 3. Asserts hello.txt exists OR final text was returned, events.db contains
 *    llm.call events, and the goal's journal file exists.
 * 4. Builds the daemon server via buildServer() and asserts GET /api/status
 *    returns 200.
 * 5. Runs the Phase 2 smoke (scripts/smoke-phase2.mjs) which exercises memory
 *    retention + brief, the PolicyEngine at L0/L2, computeAnalytics over a real
 *    events.db, and GET /api/projects/:id/analytics — all offline.
 * 6. Runs the Phase 3 smoke (scripts/smoke-phase3.mjs) which exercises the
 *    optimizer (stats + a persisted proposal), the plugin host (scaffold ->
 *    enable -> resolve -> execute), the scheduler goal queue (priority lease),
 *    the cron nextRun, and GET /api/projects/:id/proposals — all offline.
 *
 * Run from anywhere: node scripts/smoke.mjs — exits 0 on success.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPhase2Smoke } from './smoke-phase2.mjs';
import { runPhase3Smoke } from './smoke-phase3.mjs';

const core = await import(new URL('../packages/core/dist/index.js', import.meta.url).href);
const gatewayPkg = await import(new URL('../packages/gateway/dist/index.js', import.meta.url).href);
const orchestratorPkg = await import(
  new URL('../packages/orchestrator/dist/index.js', import.meta.url).href
);
const daemonPkg = await import(new URL('../packages/daemon/dist/index.js', import.meta.url).href);

const { initManifest, loadManifest, SqliteEventStore } = core;
const { ModelGateway, InMemoryBudgetLedger } = gatewayPkg;
const { AgentLoop } = orchestratorPkg;
const { buildServer } = daemonPkg;

const root = mkdtempSync(join(tmpdir(), 'lunaris-smoke-'));
const daemonDir = mkdtempSync(join(tmpdir(), 'lunaris-smoke-daemon-'));
let events;
let app;

try {
  // ---- 1. init project manifest, force model mock/echo ----------------------
  let manifest = initManifest(root, 'smoke-project');
  if (manifest.models.default !== 'mock/echo') {
    const tomlPath = join(root, 'lunaris.toml');
    const toml = readFileSync(tomlPath, 'utf8');
    writeFileSync(tomlPath, toml.replace(/default\s*=\s*"[^"]*"/, 'default = "mock/echo"'), 'utf8');
    manifest = loadManifest(root);
  }
  assert.equal(manifest.models.default, 'mock/echo');
  assert.equal(manifest.project.name, 'smoke-project');

  // ---- 2. run a goal through the real gateway (mock adapter) + real tools ---
  events = new SqliteEventStore(join(root, '.lunaris', 'state', 'events.db'));
  const ledger = new InMemoryBudgetLedger(manifest.budgets ?? {});
  const gateway = new ModelGateway({ manifest, ledger, events });
  const loop = new AgentLoop({
    gateway,
    events,
    projectId: manifest.project.id,
    projectRoot: root,
    model: manifest.models.default,
  });

  const goal = {
    goalId: randomUUID(),
    projectId: manifest.project.id,
    prompt:
      'write hello.txt via your tools then say done. ' +
      'USE_TOOL:write_file {"path":"hello.txt","content":"hello from lunaris smoke\\n"}',
    createdAt: new Date().toISOString(),
    status: 'running',
  };
  const outcome = await loop.run(goal);

  // ---- 3. assertions ---------------------------------------------------------
  const helloPath = join(root, 'hello.txt');
  const finalText = outcome?.finalText ?? '';
  assert.ok(
    existsSync(helloPath) || finalText.length > 0,
    'expected hello.txt to exist or a final text to be returned',
  );
  if (existsSync(helloPath)) {
    assert.match(readFileSync(helloPath, 'utf8'), /hello from lunaris smoke/);
  }

  const llmCalls = events.query({ projectId: manifest.project.id, kind: 'llm.call', limit: 100 });
  assert.ok(llmCalls.length >= 1, 'expected at least one llm.call event in events.db');
  assert.ok(
    existsSync(join(root, '.lunaris', 'state', 'events.db')),
    'expected events.db to exist on disk',
  );

  const journalPath = join(root, '.lunaris', 'journal', `${goal.goalId}.jsonl`);
  const journalFromArtifacts = (outcome?.result?.artifacts ?? []).find((a) =>
    String(a).includes('journal'),
  );
  assert.ok(
    existsSync(journalPath) || (journalFromArtifacts && existsSync(journalFromArtifacts)),
    `expected journal file at ${journalPath}`,
  );

  // ---- 4. daemon server: GET /api/status -> 200 ------------------------------
  app = await buildServer({
    registryPath: join(daemonDir, 'projects.json'),
    eventsDbPath: join(daemonDir, 'events.db'),
  });
  const res = await app.inject({ method: 'GET', url: '/api/status' });
  assert.equal(res.statusCode, 200, `GET /api/status -> ${res.statusCode}: ${res.body}`);
  const status = res.json();
  assert.equal(status.name, 'lunarisd');

  console.log('smoke OK');
  console.log(`  goal status:   ${outcome.goal.status} (result: ${outcome.result.status})`);
  console.log(`  hello.txt:     ${existsSync(helloPath) ? 'written' : 'absent (final text only)'}`);
  console.log(`  llm.call rows: ${llmCalls.length}`);
  console.log(`  journal:       ${journalFromArtifacts ?? journalPath}`);
  console.log('  /api/status:   200');

  // ---- 5. Phase 2 substrate (memory / policy / analytics / daemon route) ----
  await runPhase2Smoke();

  // ---- 6. Phase 3 substrate (optimizer / plugd / scheduler / cron / route) --
  await runPhase3Smoke();
} finally {
  if (app) await app.close().catch(() => {});
  events?.close?.();
  rmSync(root, { recursive: true, force: true });
  rmSync(daemonDir, { recursive: true, force: true });
}
