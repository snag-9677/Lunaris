import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createdFilesFrom,
  exitCodeForStatus,
  formatEventLine,
  normalizeResult,
  parseTail,
  resolveModel,
  tailEvents,
  toolLineFor,
  truncate,
} from './format.js';

test('truncate leaves short strings alone and ellipsizes long ones', () => {
  assert.equal(truncate('hello', 10), 'hello');
  const out = truncate('a'.repeat(100), 10);
  assert.equal(out.length, 10);
  assert.ok(out.endsWith('…'));
});

test('formatEventLine renders ts, kind and truncated payload', () => {
  const line = formatEventLine(
    { ts: '2026-06-11T00:00:00Z', kind: 'llm.call', payload: { model: 'mock/echo', n: 1 } },
    80,
  );
  assert.equal(line, '2026-06-11T00:00:00Z  llm.call  {"model":"mock/echo","n":1}');

  const long = formatEventLine(
    { ts: '2026-06-11T00:00:00Z', kind: 'tool.call', payload: { blob: 'x'.repeat(500) } },
    40,
  );
  assert.ok(long.length < 120);
  assert.ok(long.includes('tool.call'));

  // No payload → no trailing separator.
  assert.equal(
    formatEventLine({ ts: '2026-06-11T00:00:00Z', kind: 'task.start', payload: undefined }),
    '2026-06-11T00:00:00Z  task.start',
  );
});

test('tailEvents returns the last n events in chronological order', () => {
  const events = [
    { ts: '2026-06-11T00:00:03Z', eventId: 'c', kind: 'three' },
    { ts: '2026-06-11T00:00:01Z', eventId: 'a', kind: 'one' },
    { ts: '2026-06-11T00:00:02Z', eventId: 'b', kind: 'two' },
  ];
  assert.deepEqual(
    tailEvents(events, 2).map((e) => e.kind),
    ['two', 'three'],
  );
  assert.equal(tailEvents(events, 99).length, 3);
  assert.deepEqual(tailEvents(events, 0), []);
  // Same ts → eventId (UUIDv7, time-ordered) breaks the tie.
  const sameTs = [
    { ts: '2026-06-11T00:00:01Z', eventId: '2', kind: 'later' },
    { ts: '2026-06-11T00:00:01Z', eventId: '1', kind: 'earlier' },
  ];
  assert.deepEqual(
    tailEvents(sameTs, 2).map((e) => e.kind),
    ['earlier', 'later'],
  );
});

test('parseTail parses positive integers and falls back otherwise', () => {
  assert.equal(parseTail('5'), 5);
  assert.equal(parseTail(undefined), 20);
  assert.equal(parseTail('garbage'), 20);
  assert.equal(parseTail('-3'), 20);
  assert.equal(parseTail('0', 7), 7);
});

test('toolLineFor emits [tool] lines only for tool.call events', () => {
  assert.equal(toolLineFor({ kind: 'tool.call', payload: { name: 'write_file' } }), '[tool] write_file');
  assert.equal(toolLineFor({ kind: 'tool.call', payload: { tool: 'bash' } }), '[tool] bash');
  assert.equal(toolLineFor({ kind: 'tool.call', payload: {} }), '[tool] ?');
  assert.equal(toolLineFor({ kind: 'llm.call', payload: { name: 'nope' } }), undefined);
  assert.equal(toolLineFor({ kind: 'task.start', payload: undefined }), undefined);
});

test('resolveModel prefers override, then role binding, then default', () => {
  const manifest = {
    models: { default: 'mock/echo', roles: { orchestrator: 'anthropic/claude-sonnet-4-6' } },
  };
  assert.equal(resolveModel(manifest, 'deepseek/deepseek-chat'), 'deepseek/deepseek-chat');
  assert.equal(resolveModel(manifest), 'anthropic/claude-sonnet-4-6');
  assert.equal(resolveModel({ models: { default: 'mock/echo' } }), 'mock/echo');
});

test('exitCodeForStatus maps success to 0 and everything else to 1', () => {
  assert.equal(exitCodeForStatus('success'), 0);
  assert.equal(exitCodeForStatus('partial'), 1);
  assert.equal(exitCodeForStatus('failed'), 1);
  assert.equal(exitCodeForStatus(undefined), 1);
});

test('normalizeResult tolerates envelope variants', () => {
  assert.deepEqual(normalizeResult({ status: 'success', summary: 'done' }), {
    status: 'success',
    summary: 'done',
  });
  assert.deepEqual(normalizeResult({ status: 'failed', finalText: 'boom' }), {
    status: 'failed',
    summary: 'boom',
  });
  assert.deepEqual(normalizeResult('plain text'), { summary: 'plain text' });
  assert.deepEqual(normalizeResult(null), {});
  // AgentRunOutcome shape: status comes from the nested ResultEnvelope,
  // summary prefers the final text and falls back to the envelope's summary.
  assert.deepEqual(
    normalizeResult({ goal: {}, finalText: 'all done', result: { status: 'success', summary: 'ok' } }),
    { status: 'success', summary: 'all done' },
  );
  assert.deepEqual(
    normalizeResult({ finalText: '', result: { status: 'partial', summary: 'ran out of budget' } }),
    { status: 'partial', summary: 'ran out of budget' },
  );
});

test('createdFilesFrom normalizes initManifest return shapes', () => {
  assert.deepEqual(createdFilesFrom(['lunaris.toml', '.lunaris/']), ['lunaris.toml', '.lunaris/']);
  assert.deepEqual(createdFilesFrom({ createdFiles: ['lunaris.toml'] }), ['lunaris.toml']);
  assert.deepEqual(createdFilesFrom({ manifestPath: '/p/lunaris.toml' }), ['/p/lunaris.toml']);
  assert.deepEqual(createdFilesFrom('lunaris.toml'), ['lunaris.toml']);
  assert.deepEqual(createdFilesFrom(42), []);
});
