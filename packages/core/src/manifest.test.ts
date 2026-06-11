import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ManifestError, initManifest, loadManifest } from './manifest.js';

const tmpRoots: string[] = [];
function tmpProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lunaris-core-test-'));
  tmpRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

test('initManifest then loadManifest round-trips a valid manifest', () => {
  const dir = tmpProjectDir();
  const created = initManifest(dir, 'My "quoted" Project');
  const loaded = loadManifest(dir);

  assert.deepEqual(loaded, created);
  assert.equal(loaded.project.name, 'My "quoted" Project');
  assert.match(
    loaded.project.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'project id is a UUIDv7',
  );
  assert.equal(loaded.models.default, 'mock/echo');
  assert.deepEqual(loaded.budgets, { perCallUsd: 0.5, perDayUsd: 10 });
  assert.equal(loaded.providers?.['anthropic']?.keyEnv, 'ANTHROPIC_API_KEY');
  assert.equal(loaded.providers?.['deepseek']?.baseUrl, 'https://api.deepseek.com');
  // Ollama baseUrl is no longer hardcoded in the starter manifest — it comes
  // from OLLAMA_BASE_URL in .aienv (default applied by the gateway adapter).
  assert.equal(loaded.providers?.['ollama']?.baseUrl, undefined);

  assert.ok(existsSync(join(dir, '.lunaris', 'journal')), '.lunaris/journal created');
  assert.ok(existsSync(join(dir, '.lunaris', 'state')), '.lunaris/state created');
  assert.ok(existsSync(join(dir, '.aienv.sample')), '.aienv.sample created');
});

test('initManifest refuses to overwrite an existing manifest', () => {
  const dir = tmpProjectDir();
  initManifest(dir, 'first');
  assert.throws(() => initManifest(dir, 'second'), ManifestError);
});

test('loadManifest gives a clear error for a missing file', () => {
  const dir = tmpProjectDir();
  assert.throws(() => loadManifest(dir), (err: unknown) => {
    assert.ok(err instanceof ManifestError);
    assert.match(err.message, /Manifest not found/);
    assert.match(err.message, /lunaris\.toml/);
    return true;
  });
});

test('loadManifest reports field-level validation errors', () => {
  const dir = tmpProjectDir();
  // Missing models.default, and a model ref without a provider prefix in roles.
  writeFileSync(
    join(dir, 'lunaris.toml'),
    `[project]
id = "p1"
name = "broken"

[models.roles]
coder = "no-slash"
`,
    'utf8',
  );
  assert.throws(() => loadManifest(dir), (err: unknown) => {
    assert.ok(err instanceof ManifestError);
    assert.match(err.message, /models\.default/);
    assert.match(err.message, /models\.roles\.coder/);
    return true;
  });
});

test('loadManifest reports TOML syntax errors with the file path', () => {
  const dir = tmpProjectDir();
  writeFileSync(join(dir, 'lunaris.toml'), '[project\nid = "x"', 'utf8');
  assert.throws(() => loadManifest(dir), (err: unknown) => {
    assert.ok(err instanceof ManifestError);
    assert.match(err.message, /Invalid TOML/);
    return true;
  });
});
