/**
 * Phase 3 CLI: optimizer / proposals / plugins / schedule / queue — pure
 * formatters, command wiring, and integration checks against the real
 * @lunaris/scheduler + @lunaris/plugd + @lunaris/optimizer stores.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram } from './program.js';
import {
  formatOptimizerReport,
  formatPluginLine,
  formatProposalLine,
  formatQueuedGoalLine,
  formatScheduleLine,
} from './format.js';
import { runOptimize, runPluginNew, runPlugins, runQueue, runSchedule } from './commands.js';

function writeProject(cwd: string): void {
  writeFileSync(
    join(cwd, 'lunaris.toml'),
    '[project]\nid = "proj-cli"\nname = "cli"\n\n[models]\ndefault = "mock/echo"\n',
    'utf8',
  );
}

function captureLogs(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(' '));
  return { logs, restore: () => { console.log = orig; } };
}

test('lunaris program wires the Phase 3 subcommands', () => {
  const program = buildProgram();
  const names = program.commands.map((c) => c.name());
  for (const expected of ['optimize', 'proposals', 'plugins', 'plugin', 'schedule', 'queue']) {
    assert.ok(names.includes(expected), `missing subcommand: ${expected}`);
  }
  const proposals = program.commands.find((c) => c.name() === 'proposals');
  assert.ok(proposals?.options.some((o) => o.long === '--resolve'));
  assert.ok(proposals?.options.some((o) => o.long === '--approve'));
  assert.ok(proposals?.options.some((o) => o.long === '--reject'));

  const plugin = program.commands.find((c) => c.name() === 'plugin');
  const subNames = plugin?.commands.map((c) => c.name()) ?? [];
  for (const sub of ['new', 'enable', 'disable']) assert.ok(subNames.includes(sub), `missing plugin ${sub}`);

  const schedule = program.commands.find((c) => c.name() === 'schedule');
  assert.ok(schedule?.options.some((o) => o.long === '--cron'));
  assert.ok(schedule?.options.some((o) => o.long === '--prompt'));
});

test('Phase 3 formatters render one/multi-line outputs', () => {
  const report = formatOptimizerReport({
    projectId: 'proj-1',
    generatedAt: '2026-01-01T00:00:00.000Z',
    stats: [{ taskClass: 'code', role: 'orchestrator', model: 'mock/echo', n: 4, successes: 3, successRate: 0.51, avgCostUsd: 0.0123 }],
    routing: [{ taskClass: 'code', recommendedModel: 'mock/echo', rationale: 'best mean reward', confidence: 0.8, basedOnN: 10 }],
    proposals: [{ id: 'abcdef0123456789', kind: 'routing', title: 'Route code to mock/echo', status: 'pending', confidence: 0.8 }],
    notes: ['PROPOSE-ONLY: no configuration was changed.'],
  }).join('\n');
  assert.match(report, /proj-1/);
  assert.match(report, /code\/orchestrator\/mock\/echo/);
  assert.match(report, /code → mock\/echo/);
  assert.match(report, /PROPOSE-ONLY/);

  assert.match(
    formatProposalLine({ id: 'abcdef0123456789', kind: 'routing', title: 'X', status: 'pending', confidence: 0.5 }),
    /\[routing\] pending/,
  );
  assert.match(formatPluginLine({ manifest: { id: 'dev.x', version: '0.1.0', description: 'D' }, enabled: true }), /\[on\] +dev\.x@0\.1\.0/);
  assert.match(
    formatScheduleLine({ id: 'sched12345678', cron: '* * * * *', prompt: 'do it', enabled: true, nextRunAt: '2026-01-01T00:00:00.000Z' }),
    /on +\* \* \* \* \*/,
  );
  assert.match(
    formatQueuedGoalLine({ id: 'goal12345678', prompt: 'p', priority: 3, status: 'queued', source: 'cli', attempts: 0, maxAttempts: 1 }),
    /queued +p3 +0\/1 +cli/,
  );
});

test('runSchedule add → list → rm round-trips through the real store', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lun-cli-sched-'));
  writeProject(cwd);
  const cap = captureLogs();
  try {
    // add
    assert.equal(await runSchedule(cwd, { cron: '* * * * *', prompt: 'nightly' }), 0);
    const created = cap.logs.find((l) => l.startsWith('created '));
    assert.ok(created, `expected created line, got: ${cap.logs.join('|')}`);
    const id = created!.split(' ')[1]!;

    // list
    cap.logs.length = 0;
    assert.equal(await runSchedule(cwd, {}), 0);
    assert.ok(cap.logs.some((l) => l.includes(id.slice(0, 12))), 'schedule listed');

    // rm
    cap.logs.length = 0;
    assert.equal(await runSchedule(cwd, { rm: id }), 0);
    assert.ok(cap.logs.some((l) => l.includes('removed')), `expected removed, got: ${cap.logs.join('|')}`);
  } finally {
    cap.restore();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runQueue push → list shows the queued goal', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lun-cli-queue-'));
  writeProject(cwd);
  const cap = captureLogs();
  try {
    assert.equal(await runQueue(cwd, { push: 'do a thing', priority: 2 }), 0);
    assert.ok(cap.logs.some((l) => l.startsWith('queued ')), `expected queued line, got: ${cap.logs.join('|')}`);

    cap.logs.length = 0;
    assert.equal(await runQueue(cwd, {}), 0);
    assert.ok(cap.logs.some((l) => l.includes('do a thing')), 'queued goal listed');
    assert.ok(cap.logs.some((l) => l.includes('p2')), 'priority shown');
  } finally {
    cap.restore();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runPlugins / runPluginNew scaffold then list shows it', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lun-cli-plugins-'));
  writeProject(cwd);
  const cap = captureLogs();
  try {
    // empty
    assert.equal(await runPlugins(cwd), 0);
    assert.ok(cap.logs.some((l) => l.includes('no plugins')), `expected empty notice, got: ${cap.logs.join('|')}`);

    // scaffold a plugin into .lunaris/plugins/echo
    cap.logs.length = 0;
    assert.equal(await runPluginNew(cwd, 'echo', 'dev.test.echo', 'Echo'), 0);
    assert.ok(cap.logs.some((l) => l.includes('scaffolded plugin dev.test.echo')), `got: ${cap.logs.join('|')}`);

    // list shows it (disabled by default)
    cap.logs.length = 0;
    assert.equal(await runPlugins(cwd), 0);
    assert.ok(cap.logs.some((l) => l.includes('dev.test.echo')), 'plugin listed');
  } finally {
    cap.restore();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runOptimize is resilient when no events exist, and prints a report when they do', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lun-cli-opt-'));
  writeProject(cwd);
  const cap = captureLogs();
  try {
    // no events => graceful message
    assert.equal(await runOptimize(cwd), 0);
    assert.ok(cap.logs.some((l) => l.includes('nothing to optimize')), `got: ${cap.logs.join('|')}`);

    // seed events via the real event store, then re-run.
    const core = (await import('@lunaris/core')) as unknown as {
      SqliteEventStore: new (p: string) => {
        append(e: { projectId: string; kind: string; taskId?: string; agentId?: string; payload: unknown }): unknown;
        close?: () => void;
      };
    };
    const store = new core.SqliteEventStore(join(cwd, '.lunaris', 'state', 'events.db'));
    const goalId = 'g-cli-opt';
    store.append({ projectId: 'proj-cli', kind: 'goal.created', payload: { goalId, projectId: 'proj-cli', prompt: 'x', createdAt: new Date().toISOString(), status: 'running' } });
    store.append({ projectId: 'proj-cli', kind: 'llm.call', taskId: goalId, agentId: 'orchestrator', payload: { model: 'mock/echo', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 }, durationMs: 5, stopReason: 'end' } });
    store.append({ projectId: 'proj-cli', kind: 'goal.done', payload: { goalId, result: { taskId: goalId, status: 'success', summary: 'ok' } } });
    store.close?.();

    cap.logs.length = 0;
    assert.equal(await runOptimize(cwd), 0);
    const out = cap.logs.join('\n');
    assert.match(out, /optimizer report/);
    assert.match(out, /PROPOSE-ONLY/);
  } finally {
    cap.restore();
    rmSync(cwd, { recursive: true, force: true });
  }
});
