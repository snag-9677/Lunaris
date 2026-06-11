#!/usr/bin/env node
/**
 * Lunaris Phase 3 smoke test (no network, no API keys, fully offline).
 *
 * Exercises the Phase 3 substrate against the real, built packages — no mocks of
 * the units under test, only the mock/echo model path and an echo plugin tool:
 *
 *  (a) OPTIMIZER: seed a handful of task.start/task.end + llm.call events for a
 *      "code"-class subagent into a real events.db (SqliteEventStore), run
 *      runOptimizer with a low minSuggestionN, and assert it derives >= 1
 *      OutcomeStats AND persists at least one pending ConfigProposal (the
 *      routing bandit accumulates enough pulls to suggest a model). Re-open the
 *      proposal db read-only and confirm the pending row is on disk.
 *  (b) PLUGD: scaffold a starter plugin into a temp pluginsDir, build a
 *      FilePluginHost, assert it discovers the plugin (disabled), enable() it,
 *      enabledTools() resolves its namespaced echo tool, and execute() runs it.
 *  (c) SCHEDULER QUEUE: SqliteGoalQueue.push two goals at different priority,
 *      assert lease() returns the higher-priority one first, complete() it, and
 *      that a subsequent lease returns the lower-priority goal.
 *  (d) CRON: nextRun('*\/15 * * * *', <fixed date>) lands on a quarter-hour
 *      boundary strictly after the input and within 15 minutes of it.
 *  (e) DAEMON: buildServer + register a project + inject
 *      GET /api/projects/:id/proposals — assert 200 with a proposals array.
 *
 * Exported as runPhase3Smoke() so scripts/smoke.mjs can call it after Phase 2.
 * Run standalone too: `node scripts/smoke-phase3.mjs` — exits 0 on success.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const here = (rel) => new URL(rel, import.meta.url).href;

const core = await import(here('../packages/core/dist/index.js'));
const optimizerPkg = await import(here('../packages/optimizer/dist/index.js'));
const plugdPkg = await import(here('../packages/plugd/dist/index.js'));
const schedulerPkg = await import(here('../packages/scheduler/dist/index.js'));
const daemonPkg = await import(here('../packages/daemon/dist/index.js'));

const { initManifest, loadManifest, SqliteEventStore } = core;
const { runOptimizer } = optimizerPkg;
const { FilePluginHost, scaffoldPlugin } = plugdPkg;
const { SqliteGoalQueue, nextRun } = schedulerPkg;
const { buildServer } = daemonPkg;

/** Force a freshly-initialised project onto mock/echo and return its manifest. */
function initEchoProject(root, name) {
  let manifest = initManifest(root, name);
  if (manifest.models.default !== 'mock/echo') {
    const tomlPath = join(root, 'lunaris.toml');
    const toml = readFileSync(tomlPath, 'utf8');
    writeFileSync(tomlPath, toml.replace(/default\s*=\s*"[^"]*"/, 'default = "mock/echo"'), 'utf8');
    manifest = loadManifest(root);
  }
  assert.equal(manifest.models.default, 'mock/echo', 'project must run on mock/echo');
  return manifest;
}

export async function runPhase3Smoke() {
  const root = mkdtempSync(join(tmpdir(), 'lunaris-smoke-p3-'));
  const daemonDir = mkdtempSync(join(tmpdir(), 'lunaris-smoke-p3-daemon-'));
  let events;
  let app;

  try {
    const manifest = initEchoProject(root, 'smoke-phase3');
    const projectId = manifest.project.id;

    // ---- (a) OPTIMIZER: stats + a persisted pending proposal ----------------
    const eventsDbPath = join(root, '.lunaris', 'state', 'events.db');
    events = new SqliteEventStore(eventsDbPath);

    // Seed several "code"-class subagent tasks, each: task.start + an llm.call on
    // the same taskId + a successful task.end (the ResultEnvelope). The role
    // "coder" classifies as taskClass "code"; deriveOutcomes reconstructs one
    // TaskOutcome per task. Enough successful pulls let the routing bandit emit a
    // suggestion (with minSuggestionN below), which becomes a routing proposal.
    const TASKS = 5;
    let baseTs = Date.parse('2026-06-11T00:00:00.000Z');
    for (let i = 0; i < TASKS; i++) {
      const taskId = `p3-code-${i}`;
      events.append({
        projectId,
        kind: 'task.start',
        taskId,
        agentId: 'coder',
        payload: { role: 'coder', task: 'implement a small function' },
      });
      events.append({
        projectId,
        kind: 'llm.call',
        taskId,
        agentId: 'coder',
        payload: {
          model: 'mock/echo',
          usage: { inputTokens: 100 + i, outputTokens: 30 + i, costUsd: 0.002 },
          durationMs: 25,
          stopReason: 'end',
        },
      });
      events.append({
        projectId,
        kind: 'task.end',
        taskId,
        agentId: 'coder',
        payload: { taskId, status: 'success', summary: 'done' },
      });
      baseTs += 60_000;
    }
    events.close();
    events = undefined; // closed inline; prevent the finally guard double-closing.

    const banditDbPath = join(root, '.lunaris', 'state', 'routing.db');
    const proposalDbPath = join(root, '.lunaris', 'state', 'proposals.db');
    const report = runOptimizer({
      store: eventsDbPath, // read-only sqlite path (the SQL aggregation path)
      banditDbPath,
      proposalDbPath,
      projectId,
      minSuggestionN: 3, // 5 successful pulls clear this, so a suggestion is made
    });

    assert.equal(report.projectId, projectId, 'report must echo the project id');
    assert.ok(report.stats.length >= 1, `expected >= 1 OutcomeStats, got ${report.stats.length}`);
    const codeStat = report.stats.find((s) => s.taskClass === 'code');
    assert.ok(codeStat, 'expected a "code" task-class OutcomeStats row');
    assert.equal(codeStat.model, 'mock/echo', 'code stat must be attributed to mock/echo');
    assert.equal(codeStat.n, TASKS, `expected n=${TASKS} for the code stat, got ${codeStat.n}`);
    assert.equal(codeStat.successes, TASKS, 'all seeded code tasks were successes');
    assert.ok(
      report.proposals.length >= 1,
      `expected >= 1 persisted proposal, got ${report.proposals.length}`,
    );
    const pending = report.proposals.find((p) => p.status === 'pending');
    assert.ok(pending, 'expected at least one pending proposal in the report');
    assert.ok(report.notes.some((n) => n.includes('PROPOSE-ONLY')), 'report must be propose-only');

    // The pending proposal must be durably persisted: re-open the db read-only.
    assert.ok(existsSync(proposalDbPath), `expected proposals.db at ${proposalDbPath}`);
    const persistedPending = (() => {
      const db = new DatabaseSync(proposalDbPath, { readOnly: true });
      try {
        const row = db
          .prepare(
            "SELECT COUNT(*) AS n FROM proposals WHERE project_id = ? AND status = 'pending'",
          )
          .get(projectId);
        return Number(row?.n ?? 0);
      } finally {
        db.close();
      }
    })();
    assert.ok(persistedPending >= 1, `expected >= 1 pending proposal on disk, got ${persistedPending}`);

    // ---- (b) PLUGD: scaffold -> discover -> enable -> resolve -> execute -----
    const pluginsDir = join(root, '.lunaris', 'plugins');
    const pluginId = 'dev.lunaris.smoke';
    const pluginRoot = join(pluginsDir, 'smoke-plugin');
    scaffoldPlugin(pluginRoot, { id: pluginId, name: 'Smoke Plugin' });

    const host = new FilePluginHost({ pluginsDir });
    const discovered = host.list();
    const mine = discovered.find((p) => p.manifest.id === pluginId);
    assert.ok(mine, `host must discover the scaffolded plugin ${pluginId}`);
    assert.equal(mine.enabled, false, 'a freshly scaffolded plugin starts disabled');

    host.enable(pluginId);
    const afterEnable = host.list().find((p) => p.manifest.id === pluginId);
    assert.equal(afterEnable?.enabled, true, 'enable() must flip the plugin enabled');

    const tools = await host.enabledTools();
    assert.equal(host.lastLoadErrors.length, 0, `no load errors expected: ${JSON.stringify(host.lastLoadErrors)}`);
    const echoTool = tools.find((t) => t.def.name === `${pluginId}/echo`);
    assert.ok(echoTool, `enabledTools() must resolve the namespaced ${pluginId}/echo tool`);
    assert.equal(echoTool.pluginId, pluginId, 'resolved tool must carry its pluginId');
    const echoed = await echoTool.execute({ text: 'phase3 smoke' }, {});
    assert.equal(echoed, 'phase3 smoke', `execute() must echo the input, got "${echoed}"`);

    // ---- (c) SCHEDULER QUEUE: priority lease ordering -----------------------
    const queueDbPath = join(root, '.lunaris', 'state', 'queue.db');
    const queue = new SqliteGoalQueue(queueDbPath);
    let leaseError;
    try {
      const low = queue.push({ projectId, prompt: 'low priority', priority: 1, source: 'cli' });
      const high = queue.push({ projectId, prompt: 'high priority', priority: 9, source: 'cli' });

      const first = queue.lease();
      assert.ok(first, 'lease() must return a goal when one is queued');
      assert.equal(first.id, high.id, 'lease() must return the higher-priority goal first');
      assert.equal(first.status, 'leased', 'leased goal must be marked leased');

      queue.complete(first.id, 'orch-run-1');
      const done = queue.get(first.id);
      assert.equal(done?.status, 'done', 'complete() must mark the goal done');
      assert.equal(done?.goalId, 'orch-run-1', 'complete() must record the orchestrator run id');

      const second = queue.lease();
      assert.ok(second, 'a second lease() must return the remaining queued goal');
      assert.equal(second.id, low.id, 'second lease() must return the lower-priority goal');
    } catch (err) {
      leaseError = err;
    } finally {
      queue.close();
    }
    if (leaseError) throw leaseError;

    // ---- (d) CRON: nextRun for */15 within 15 minutes of a fixed input ------
    const cronExpr = '*/15 * * * *';
    const input = new Date('2026-06-11T10:07:23.000Z');
    const next = nextRun(cronExpr, input);
    const deltaMs = next.getTime() - input.getTime();
    assert.ok(deltaMs > 0, 'nextRun must be strictly after the input');
    assert.ok(
      deltaMs <= 15 * 60_000,
      `nextRun must be within 15 minutes of the input, got ${deltaMs}ms`,
    );
    assert.equal(next.getMinutes() % 15, 0, 'nextRun minute must be a quarter-hour boundary');
    assert.equal(next.getSeconds(), 0, 'nextRun must align to the minute');

    // ---- (e) DAEMON: GET /api/projects/:id/proposals -> 200 -----------------
    app = await buildServer({
      registryPath: join(daemonDir, 'projects.json'),
      eventsDbPath: join(daemonDir, 'events.db'),
    });
    const reg = await app.inject({ method: 'POST', url: '/api/projects', payload: { root } });
    assert.equal(reg.statusCode, 201, `register project -> ${reg.statusCode}: ${reg.body}`);
    const pid = reg.json().id;

    const res = await app.inject({ method: 'GET', url: `/api/projects/${pid}/proposals` });
    assert.equal(res.statusCode, 200, `GET proposals -> ${res.statusCode}: ${res.body}`);
    const body = res.json();
    assert.ok(Array.isArray(body.proposals), 'proposals route must return a proposals array');
    // The project root carries the proposals.db seeded in (a), so the route
    // surfaces the persisted pending proposal too.
    assert.ok(
      body.proposals.some((p) => p.status === 'pending'),
      'GET proposals must surface the persisted pending proposal',
    );

    // eslint-disable-next-line no-console
    console.log('smoke-phase3 OK');
    console.log(
      `  optimizer:     ${report.stats.length} stat(s), ${report.proposals.length} proposal(s) ` +
        `(code n=${codeStat.n}, ${persistedPending} pending on disk)`,
    );
    console.log(`  plugd:         discovered + enabled ${pluginId}, echo -> "${echoed}"`);
    console.log('  queue:         high-priority leased first, completed, low next');
    console.log(`  cron:          ${cronExpr} -> ${next.toISOString()} (+${deltaMs / 60000}m)`);
    console.log(`  /api/proposals: 200 (${body.proposals.length} proposal[s])`);
  } finally {
    if (app) await app.close().catch(() => {});
    events?.close?.();
    rmSync(root, { recursive: true, force: true });
    rmSync(daemonDir, { recursive: true, force: true });
  }
}

// Allow standalone execution: `node scripts/smoke-phase3.mjs`.
if (import.meta.url === `file://${process.argv[1]}`) {
  runPhase3Smoke().then(
    () => process.exit(0),
    (err) => {
      console.error('smoke-phase3 FAILED');
      console.error(err);
      process.exit(1);
    },
  );
}
