import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyProjectEnv, parseEnvFile, sampleEnvFile, PROJECT_ENV_FILE } from './env.js';

test('parseEnvFile handles comments, quotes, export prefix, blanks', () => {
  const parsed = parseEnvFile(
    [
      '# comment',
      '',
      'ANTHROPIC_API_KEY=sk-ant-123',
      'export DEEPSEEK_API_KEY="dk-456"',
      "OPENAI_API_KEY='oai-789'",
      'BAD LINE NO EQUALS',
      '=novalue',
      '  SPACED = trimmed ',
    ].join('\n'),
  );
  assert.equal(parsed['ANTHROPIC_API_KEY'], 'sk-ant-123');
  assert.equal(parsed['DEEPSEEK_API_KEY'], 'dk-456');
  assert.equal(parsed['OPENAI_API_KEY'], 'oai-789');
  assert.equal(parsed['SPACED'], 'trimmed');
  assert.equal('BAD LINE NO EQUALS' in parsed, false);
});

test('applyProjectEnv sets missing vars but never overwrites existing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lun-env-'));
  writeFileSync(join(dir, PROJECT_ENV_FILE), 'FOO_KEY=fromfile\nBAR_KEY=alsofile\n');
  const env: Record<string, string | undefined> = { BAR_KEY: 'fromshell' };
  const applied = applyProjectEnv(dir, { env });
  assert.deepEqual(applied, ['FOO_KEY']); // BAR_KEY skipped (already set)
  assert.equal(env['FOO_KEY'], 'fromfile');
  assert.equal(env['BAR_KEY'], 'fromshell'); // shell wins
});

test('applyProjectEnv is a no-op when no .aienv exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lun-env-'));
  assert.deepEqual(applyProjectEnv(dir, { env: {} }), []);
});

test('sampleEnvFile lists the default provider key names', () => {
  const s = sampleEnvFile();
  for (const k of ['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY']) {
    assert.ok(s.includes(k), `sample missing ${k}`);
  }
});
