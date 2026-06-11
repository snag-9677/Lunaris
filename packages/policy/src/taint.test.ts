import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaintTracker, classifyToolOutputTaints } from './taint.js';

test('TaintTracker marks and reports per-task taint', () => {
  const t = new TaintTracker();
  assert.equal(t.isTainted('task-a'), false);
  t.markTainted('task-a', 'web_fetch');
  assert.equal(t.isTainted('task-a'), true);
  assert.equal(t.isTainted('task-b'), false, 'taint is per-task');

  assert.equal(t.sources('task-a').length, 1);
  assert.equal(t.sources('task-a')[0]?.source, 'web_fetch');
  assert.match(t.sources('task-a')[0]!.at, /\d{4}-\d{2}-\d{2}T/);
});

test('TaintTracker accumulates multiple sources and clears', () => {
  const t = new TaintTracker();
  t.markTainted('x', 'web_fetch');
  t.markTainted('x', 'untrusted_file');
  assert.deepEqual(
    t.sources('x').map((m) => m.source),
    ['web_fetch', 'untrusted_file'],
  );
  t.clear('x');
  assert.equal(t.isTainted('x'), false);
  assert.deepEqual(t.sources('x'), []);
});

test('classifyToolOutputTaints flags untrusted-content tools', () => {
  // web_fetch is the canonical untrusted source — always taints.
  assert.equal(classifyToolOutputTaints('web_fetch'), 'web_fetch');
  // An explicitly-untrusted read taints by name.
  assert.equal(classifyToolOutputTaints('read_untrusted_file'), 'untrusted_file');
  // FIX 4: a plain workspace read_file is NOT a blanket taint source.
  assert.equal(classifyToolOutputTaints('read_file', { args: { path: 'src/app.ts' } }), undefined);
  assert.equal(classifyToolOutputTaints('read_file'), undefined);
  // ...but reading a path that prior web-derived content was written to DOES taint.
  assert.equal(
    classifyToolOutputTaints('read_file', {
      args: { path: 'notes.txt' },
      derivedPaths: new Set(['notes.txt']),
    }),
    'untrusted_file',
  );
  // A read of a path NOT in the derived set stays trusted even when others are.
  assert.equal(
    classifyToolOutputTaints('read_file', {
      args: { path: 'src/app.ts' },
      derivedPaths: new Set(['notes.txt']),
    }),
    undefined,
  );
  assert.equal(classifyToolOutputTaints('run_bash'), undefined);
  assert.equal(classifyToolOutputTaints('list_dir'), undefined);
});
