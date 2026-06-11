#!/usr/bin/env node
/**
 * Lunaris Phase 2 smoke test (no network, no API keys, fully offline).
 *
 * Exercises the autonomy substrate added in Phase 2 against the real, built
 * packages — no mocks of the units under test, only the mock/echo model path:
 *
 *  (a) Memory: build a SqliteMemoryStore on disk, propose a couple of memories
 *      and assert the retention gate accepts the high-signal one and rejects a
 *      low-signal one, that brief() produces an advisory block citing records,
 *      and that the memory.db file has the accepted records persisted.
 *  (b) Policy: build a PolicyEngine at L0 and assert a write tool is
 *      denied (or queued), and at L2 the same write tool is allowed.
 *  (c) Analytics: run computeAnalytics over a real events.db (seeded via the
 *      SqliteEventStore) and assert goals/llm/tool numbers are non-trivial.
 *  (d) Daemon: buildServer + inject GET /api/projects/:id/analytics, assert 200
 *      with a sane body that reflects the seeded events.
 *
 * Exported as runPhase2Smoke() so scripts/smoke.mjs can call it after Phase 1.
 * Run standalone too: `node scripts/smoke-phase2.mjs` — exits 0 on success.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const here = (rel) => new URL(rel, import.meta.url).href;

const core = await import(here('../packages/core/dist/index.js'));
const memoryPkg = await import(here('../packages/memory/dist/index.js'));
const policyPkg = await import(here('../packages/policy/dist/index.js'));
const daemonPkg = await import(here('../packages/daemon/dist/index.js'));

const { initManifest, loadManifest, computeAnalytics, SqliteEventStore } = core;
const { SqliteMemoryStore } = memoryPkg;
const { RulePolicyEngine, defaultPolicy } = policyPkg;
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

export async function runPhase2Smoke() {
  const root = mkdtempSync(join(tmpdir(), 'lunaris-smoke-p2-'));
  const daemonDir = mkdtempSync(join(tmpdir(), 'lunaris-smoke-p2-daemon-'));
  let events;
  let app;

  try {
    const manifest = initEchoProject(root, 'smoke-phase2');
    const projectId = manifest.project.id;

    // ---- (a) MEMORY: retention gate + brief() + persisted records ----------
    const memDbPath = join(root, '.lunaris', 'state', 'memory.db');
    const memory = new SqliteMemoryStore({ dbPath: memDbPath, projectId });

    // High-signal, reusable, procedural memory — should pass the retention gate.
    const accepted = memory.propose({
      type: 'procedural',
      statement:
        'Always run pnpm -r build before pnpm -r test; the test runner executes compiled dist files.',
      entities: ['pnpm', 'build', 'test'],
    });
    assert.equal(accepted.accepted, true, `expected high-signal memory accepted: ${accepted.reason}`);
    assert.ok(typeof accepted.recordId === 'string' && accepted.recordId.length > 0, 'accepted memory must carry a recordId');

    // A second, distinct high-signal semantic fact — also accepted.
    const accepted2 = memory.propose({
      type: 'semantic',
      statement: 'The Lunaris daemon binds 127.0.0.1 only and refuses non-loopback hosts.',
      entities: ['Lunaris', 'daemon'],
    });
    assert.equal(accepted2.accepted, true, `expected second memory accepted: ${accepted2.reason}`);

    // A near-duplicate of the first accepted memory — the retention gate must
    // reject it (low novelty / reinforce existing) to keep the store selective.
    const rejected = memory.propose({
      type: 'procedural',
      statement:
        'Always run pnpm -r build before pnpm -r test; the test runner executes compiled dist files.',
      entities: ['pnpm', 'build', 'test'],
    });
    assert.equal(rejected.accepted, false, 'expected near-duplicate memory rejected by the retention gate');
    assert.ok(rejected.reason.length > 0, 'rejection must carry a reason');

    // brief() returns an advisory block that cites the accepted records.
    const brief = memory.brief('how should I build and test the project before running it?');
    assert.ok(/advisory/i.test(brief.text), 'brief must mark itself advisory (guide-not-oracle)');
    assert.ok(brief.recordIds.length >= 1, 'brief must cite at least one record');
    assert.ok(brief.text.includes('pnpm') || brief.text.length > 50, 'brief must surface memory content');
    memory.close();

    // Assert the memory.db file exists and holds exactly the accepted records.
    assert.ok(existsSync(memDbPath), `expected memory.db at ${memDbPath}`);
    const memCount = (() => {
      const db = new DatabaseSync(memDbPath, { readOnly: true });
      try {
        const row = db.prepare('SELECT COUNT(*) AS n FROM memory_records WHERE project_id = ?').get(projectId);
        return Number(row?.n ?? 0);
      } finally {
        db.close();
      }
    })();
    assert.equal(memCount, 2, `expected 2 persisted memory records, got ${memCount}`);

    // ---- (b) POLICY: write denied/queued at L0, allowed at L2 ---------------
    const ctx = { projectId, tainted: false };
    const writeArgs = { path: 'src/app.ts', content: 'x' };

    const l0 = defaultPolicy(0).engine;
    const l0Decision = l0.evaluate('write_file', writeArgs, ctx);
    assert.ok(
      l0Decision.effect === 'deny' || l0Decision.effect === 'queue',
      `L0 must deny/queue write_file, got "${l0Decision.effect}" (${l0Decision.reason})`,
    );

    const l2 = new RulePolicyEngine({ level: 2 });
    const l2Decision = l2.evaluate('write_file', writeArgs, ctx);
    assert.equal(
      l2Decision.effect,
      'allow',
      `L2 must allow write_file, got "${l2Decision.effect}" (${l2Decision.reason})`,
    );

    // ---- (c) ANALYTICS: computeAnalytics over a real events.db --------------
    const eventsDbPath = join(root, '.lunaris', 'state', 'events.db');
    events = new SqliteEventStore(eventsDbPath);
    const goalA = 'p2-goal-done';
    const goalB = 'p2-goal-running';
    events.append({ projectId, kind: 'goal.created', payload: { goalId: goalA } });
    events.append({ projectId, kind: 'goal.created', payload: { goalId: goalB } });
    events.append({ projectId, kind: 'goal.done', payload: { goalId: goalA } });
    events.append({
      projectId,
      kind: 'llm.call',
      payload: { model: 'mock/echo', usage: { inputTokens: 120, outputTokens: 45, costUsd: 0.013 } },
    });
    events.append({
      projectId,
      kind: 'llm.call',
      payload: { model: 'mock/echo', usage: { inputTokens: 80, outputTokens: 20, costUsd: 0.007 } },
    });
    events.append({ projectId, kind: 'tool.call', payload: { name: 'write_file', ok: true } });
    events.append({ projectId, kind: 'tool.call', payload: { name: 'run_bash', ok: false, error: 'boom' } });
    events.close();
    events = undefined; // closed inline; prevent the finally guard double-closing.

    // Re-run over the db file path (the SQL aggregation path), opened read-only.
    const analytics = computeAnalytics(eventsDbPath, projectId);
    assert.equal(analytics.projectId, projectId);
    assert.equal(analytics.goals.total, 2, 'expected 2 goals total');
    assert.equal(analytics.goals.done, 1, 'expected 1 done goal');
    assert.equal(analytics.goals.running, 1, 'expected 1 running goal');
    assert.equal(analytics.llm.calls, 2, 'expected 2 llm.call events');
    assert.ok(analytics.llm.inputTokens >= 200, `expected input tokens >= 200, got ${analytics.llm.inputTokens}`);
    assert.ok(analytics.llm.costUsd > 0, 'expected non-zero cost');
    assert.equal(analytics.byModel.length, 1, 'expected one model row');
    assert.equal(analytics.byModel[0]?.model, 'mock/echo');
    assert.equal(analytics.tools.calls, 2, 'expected 2 tool.call events');
    assert.equal(analytics.tools.failures, 1, 'expected 1 failed tool.call');

    // ---- (d) DAEMON: GET /api/projects/:id/analytics -> 200, sane body ------
    app = await buildServer({
      registryPath: join(daemonDir, 'projects.json'),
      eventsDbPath: join(daemonDir, 'events.db'),
    });

    const reg = await app.inject({ method: 'POST', url: '/api/projects', payload: { root } });
    assert.equal(reg.statusCode, 201, `register project -> ${reg.statusCode}: ${reg.body}`);
    const project = reg.json();
    const pid = project.id;

    // The analytics route reads the daemon's shared live store; seed it there.
    const live = app.lunaris.events;
    live.append({ projectId: pid, kind: 'goal.created', payload: { goalId: 'd-goal-1' } });
    live.append({ projectId: pid, kind: 'goal.done', payload: { goalId: 'd-goal-1' } });
    live.append({
      projectId: pid,
      kind: 'llm.call',
      payload: { model: 'mock/echo', usage: { inputTokens: 33, outputTokens: 12, costUsd: 0.004 } },
    });
    live.append({ projectId: pid, kind: 'tool.call', payload: { name: 'write_file', ok: true } });

    const res = await app.inject({ method: 'GET', url: `/api/projects/${pid}/analytics` });
    assert.equal(res.statusCode, 200, `GET analytics -> ${res.statusCode}: ${res.body}`);
    const body = res.json();
    assert.equal(body.projectId, pid, 'analytics body must echo the project id');
    assert.equal(body.goals.total, 1, 'expected 1 goal in daemon analytics');
    assert.equal(body.goals.done, 1, 'expected 1 done goal in daemon analytics');
    assert.equal(body.llm.calls, 1, 'expected 1 llm.call in daemon analytics');
    assert.ok(body.llm.costUsd > 0, 'expected non-zero daemon cost');
    assert.equal(body.tools.calls, 1, 'expected 1 tool.call in daemon analytics');
    assert.ok(Array.isArray(body.byModel) && body.byModel.length === 1, 'expected one byModel row');

    // eslint-disable-next-line no-console
    console.log('smoke-phase2 OK');
    console.log(`  memory:        2 accepted (1 rejected), brief cites ${brief.recordIds.length} record(s)`);
    console.log(`  policy:        L0 write_file=${l0Decision.effect}, L2 write_file=${l2Decision.effect}`);
    console.log(
      `  analytics(db): goals ${analytics.goals.total} (done ${analytics.goals.done}, running ${analytics.goals.running}), ` +
        `llm ${analytics.llm.calls} ($${analytics.llm.costUsd.toFixed(3)}), tools ${analytics.tools.calls}/${analytics.tools.failures} fail`,
    );
    console.log(`  /api/analytics: 200 (goals ${body.goals.total}, llm ${body.llm.calls}, tools ${body.tools.calls})`);
  } finally {
    if (app) await app.close().catch(() => {});
    events?.close?.();
    rmSync(root, { recursive: true, force: true });
    rmSync(daemonDir, { recursive: true, force: true });
  }
}

// Allow standalone execution: `node scripts/smoke-phase2.mjs`.
if (import.meta.url === `file://${process.argv[1]}`) {
  runPhase2Smoke().then(
    () => process.exit(0),
    (err) => {
      console.error('smoke-phase2 FAILED');
      console.error(err);
      process.exit(1);
    },
  );
}
