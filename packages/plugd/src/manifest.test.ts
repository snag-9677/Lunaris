import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  PluginManifestError,
  loadPluginManifest,
  validatePluginManifest,
} from './manifest.js';

const tmpRoots: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lunaris-plugd-mf-'));
  tmpRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

test('validate accepts a well-formed manifest with a tool + mcp server', () => {
  const m = validatePluginManifest({
    id: 'dev.acme.pg-tools',
    version: '1.2.3',
    description: 'PG tools',
    lunaris: '>=0.1',
    tools: [
      {
        name: 'query',
        description: 'run a query',
        module: 'tools/query.js',
        export: 'run',
        inputSchema: { type: 'object' },
      },
    ],
    mcpServers: [{ name: 'pg', command: 'pg-mcp', args: ['--stdio'] }],
    permissions: ['net'],
  });
  assert.equal(m.id, 'dev.acme.pg-tools');
  assert.equal(m.version, '1.2.3');
  assert.equal(m.tools?.[0]?.module, 'tools/query.js');
  assert.equal(m.tools?.[0]?.export, 'run');
  assert.equal(m.mcpServers?.[0]?.name, 'pg');
  assert.deepEqual(m.mcpServers?.[0]?.args, ['--stdio']);
  assert.deepEqual(m.permissions, ['net']);
});

test('validate rejects a bad id, bad version, and a tool missing module', () => {
  assert.throws(
    () =>
      validatePluginManifest({
        id: 'NotReverseDNS', // single label, uppercase
        version: 'banana',
        tools: [{ name: 'x', description: 'y' }], // no module
      }),
    (err: unknown) => {
      assert.ok(err instanceof PluginManifestError);
      assert.match(err.message, /id:/);
      assert.match(err.message, /version:/);
      assert.match(err.message, /tools\[0\]\.module: required/);
      return true;
    },
  );
});

test('FIX 4: validate rejects a manifest with two same-named tools', () => {
  assert.throws(
    () =>
      validatePluginManifest({
        id: 'dev.acme.dup',
        version: '0.1.0',
        tools: [
          { name: 'run', description: 'first', module: 'tools/a.js' },
          { name: 'run', description: 'second (shadows the first)', module: 'tools/b.js' },
        ],
      }),
    (err: unknown) => {
      assert.ok(err instanceof PluginManifestError);
      assert.match(err.message, /duplicate tool name "run"/);
      return true;
    },
  );
});

test('validate rejects an mcp server missing command', () => {
  assert.throws(
    () =>
      validatePluginManifest({
        id: 'dev.acme.x',
        version: '0.1.0',
        mcpServers: [{ name: 'srv' }],
      }),
    (err: unknown) =>
      err instanceof PluginManifestError && /mcpServers\[0\]\.command: required/.test(err.message),
  );
});

test('loadPluginManifest throws a clear error when plugin.toml is missing', () => {
  const dir = freshDir();
  assert.throws(
    () => loadPluginManifest(dir),
    (err: unknown) =>
      err instanceof PluginManifestError && /Plugin manifest not found/.test(err.message),
  );
});

test('loadPluginManifest parses a real plugin.toml from disk', () => {
  const dir = freshDir();
  writeFileSync(
    join(dir, 'plugin.toml'),
    [
      'id = "dev.acme.echo"',
      'version = "0.1.0"',
      '[[tools]]',
      'name = "echo"',
      'description = "echoes"',
      'module = "tools/echo.js"',
    ].join('\n'),
    'utf8',
  );
  const m = loadPluginManifest(dir);
  assert.equal(m.id, 'dev.acme.echo');
  assert.equal(m.tools?.length, 1);
  assert.equal(m.tools?.[0]?.name, 'echo');
});
