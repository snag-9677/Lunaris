/**
 * Phase 2 CLI: analytics/memory/approvals — pure formatters, command wiring,
 * and an integration check of runApprovals against a real SqliteApprovalQueue.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteApprovalQueue } from '@lunaris/policy';
import type { ProjectAnalytics } from '@lunaris/core';
import { buildProgram } from './program.js';
import { formatAnalytics, formatApprovalLine, formatMemoryLine } from './format.js';
import { runApprovals, runAnalytics, runMemory, approvalsDbPath } from './commands.js';

test('lunaris program wires the Phase 2 subcommands', () => {
  const program = buildProgram();
  const names = program.commands.map((c) => c.name());
  for (const expected of ['analytics', 'memory', 'approvals']) {
    assert.ok(names.includes(expected), `missing subcommand: ${expected}`);
  }
  const memory = program.commands.find((c) => c.name() === 'memory');
  assert.ok(memory?.options.some((o) => o.long === '--search'));
  const approvals = program.commands.find((c) => c.name() === 'approvals');
  assert.ok(approvals?.options.some((o) => o.long === '--resolve'));
  assert.ok(approvals?.options.some((o) => o.long === '--approve'));
  assert.ok(approvals?.options.some((o) => o.long === '--deny'));
});

test('formatAnalytics renders goals, llm, tools and by-model rows', () => {
  const a: ProjectAnalytics = {
    projectId: 'proj-1',
    since: '1970-01-01T00:00:00.000Z',
    goals: { total: 4, done: 3, failed: 1, running: 0 },
    llm: { calls: 5, inputTokens: 100, outputTokens: 50, costUsd: 0.1234 },
    byModel: [{ model: 'mock/echo', calls: 5, inputTokens: 100, outputTokens: 50, costUsd: 0.1234 }],
    tools: { calls: 7, failures: 2 },
  };
  const out = formatAnalytics(a).join('\n');
  assert.match(out, /proj-1/);
  assert.match(out, /3 done/);
  assert.match(out, /75% success/);
  assert.match(out, /\$0\.1234/);
  assert.match(out, /mock\/echo/);
});

test('formatMemoryLine + formatApprovalLine render one line each', () => {
  const mem = formatMemoryLine({ type: 'semantic', statement: 'X uses Y', confidence: 0.7, strength: 0.9, tainted: true });
  assert.match(mem, /semantic/);
  assert.match(mem, /conf 0\.70/);
  assert.match(mem, /untrusted/);
  assert.match(mem, /X uses Y/);

  const tk = formatApprovalLine({ ticketId: 'abcdef0123456789', tool: 'run_bash', reason: 'git push', status: 'pending' });
  assert.match(tk, /abcdef012345/);
  assert.match(tk, /pending/);
  assert.match(tk, /run_bash/);
});

test('runApprovals lists pending then resolves via --resolve --approve', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lun-cli-approvals-'));
  // Project manifest so loadProjectManifest succeeds.
  writeFileSync(
    join(cwd, 'lunaris.toml'),
    '[project]\nid = "proj-cli"\nname = "cli"\n\n[models]\ndefault = "mock/echo"\n',
    'utf8',
  );
  mkdirSync(join(cwd, '.lunaris', 'state'), { recursive: true });
  const queue = new SqliteApprovalQueue(approvalsDbPath(cwd));
  let ticketId: string;
  try {
    const t = queue.create({ projectId: 'proj-cli', tool: 'run_bash', args: { command: 'git push' }, reason: 'irreversible' });
    ticketId = t.ticketId;
  } finally {
    queue.close();
  }

  // capture console output
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(' '));
  try {
    const listCode = await runApprovals(cwd);
    assert.equal(listCode, 0);
    assert.ok(logs.some((l) => l.includes(ticketId.slice(0, 12))), 'pending ticket listed');

    logs.length = 0;
    const resolveCode = await runApprovals(cwd, { resolve: ticketId, approve: true });
    assert.equal(resolveCode, 0);
    assert.ok(logs.some((l) => l.includes('approved')), `expected approved, got: ${logs.join('|')}`);
  } finally {
    console.log = orig;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runAnalytics + runMemory are resilient when dbs are absent', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lun-cli-empty-'));
  writeFileSync(
    join(cwd, 'lunaris.toml'),
    '[project]\nid = "proj-cli"\nname = "cli"\n\n[models]\ndefault = "mock/echo"\n',
    'utf8',
  );
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(' '));
  try {
    assert.equal(await runAnalytics(cwd), 0);
    assert.ok(logs.some((l) => l.includes('no events recorded yet')));
    logs.length = 0;
    assert.equal(await runMemory(cwd), 0);
    assert.ok(logs.some((l) => l.includes('no memory recorded yet')));
  } finally {
    console.log = orig;
    rmSync(cwd, { recursive: true, force: true });
  }
});
