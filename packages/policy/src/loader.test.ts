import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadPolicy, writeDefaultPolicy, POLICY_REL_PATH } from './loader.js';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'lunaris-policy-loader-'));
}

test('loadPolicy falls back to L2 when no file exists', () => {
  const dir = tmpProject();
  try {
    const p = loadPolicy(dir);
    assert.equal(p.level, 2);
    assert.equal(p.tightenWhenTainted, true);
    assert.ok(p.rules.length > 0, 'default rules supplied');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPolicy honors the fallback level option', () => {
  const dir = tmpProject();
  try {
    assert.equal(loadPolicy(dir, { level: 0 }).level, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeDefaultPolicy then loadPolicy round-trips, refuses clobber', () => {
  const dir = tmpProject();
  try {
    const path = writeDefaultPolicy(dir, 1);
    assert.ok(existsSync(path));
    assert.ok(path.endsWith(POLICY_REL_PATH));

    const p = loadPolicy(dir);
    assert.equal(p.level, 1);

    assert.throws(() => writeDefaultPolicy(dir, 1), /Refusing to overwrite/);
    // overwrite=true is allowed.
    writeDefaultPolicy(dir, 3, true);
    assert.equal(loadPolicy(dir).level, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPolicy parses and coerces hand-written yaml; drops invalid rules', () => {
  const dir = tmpProject();
  try {
    const path = writeDefaultPolicy(dir, 2);
    const yaml = [
      'level: 3',
      'tightenWhenTainted: false',
      'allowlistedHosts:',
      '  - api.github.com',
      'rules:',
      '  - effect: queue',
      '    tools: [run_bash]',
      '    commands: ["git push*"]',
      '  - effect: bogus', // invalid effect, dropped
      '    tools: [x]',
      '  - notARule: 1', // dropped
    ].join('\n');
    // Inject our hand-written content over the generated file.
    const target = join(dir, POLICY_REL_PATH);
    assert.ok(existsSync(path));
    writeFileSync(target, yaml, 'utf8');

    const p = loadPolicy(dir);
    assert.equal(p.level, 3);
    assert.equal(p.tightenWhenTainted, false);
    assert.deepEqual(p.allowlistedHosts, ['api.github.com']);
    assert.equal(p.rules.length, 1, 'only the valid rule survives');
    assert.equal(p.rules[0]?.effect, 'queue');
    assert.deepEqual(p.rules[0]?.commands, ['git push*']);

    // sanity: confirm content was actually written
    assert.match(readFileSync(target, 'utf8'), /git push/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
