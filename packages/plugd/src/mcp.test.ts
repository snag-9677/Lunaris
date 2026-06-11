import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LoadedPlugin } from '@lunaris/core';
import { resolveMcpServers } from './mcp.js';

function plugin(id: string, enabled: boolean, servers: LoadedPlugin['manifest']['mcpServers']): LoadedPlugin {
  return {
    manifest: { id, version: '0.1.0', mcpServers: servers },
    root: `/tmp/${id}`,
    enabled,
  };
}

test('resolveMcpServers flattens + namespaces servers of enabled plugins only', () => {
  const plugins: LoadedPlugin[] = [
    plugin('dev.a.one', true, [
      { name: 'pg', command: 'pg-mcp', args: ['--stdio'], env: { PGHOST: 'localhost' } },
    ]),
    plugin('dev.b.two', false, [{ name: 'redis', command: 'redis-mcp' }]),
  ];
  const defs = resolveMcpServers(plugins);
  assert.equal(defs.length, 1);
  assert.equal(defs[0]?.name, 'dev.a.one/pg');
  assert.equal(defs[0]?.command, 'pg-mcp');
  assert.deepEqual(defs[0]?.args, ['--stdio']);
  assert.deepEqual(defs[0]?.env, { PGHOST: 'localhost' });
});

test('resolveMcpServers handles plugins with no mcpServers', () => {
  const defs = resolveMcpServers([plugin('dev.a.none', true, undefined)]);
  assert.deepEqual(defs, []);
});

test('resolveMcpServers copies args/env so callers cannot mutate the source manifest', () => {
  const src = plugin('dev.a.one', true, [{ name: 's', command: 'c', args: ['x'], env: { K: 'v' } }]);
  const defs = resolveMcpServers([src]);
  defs[0]?.args?.push('mutated');
  (defs[0] as { env: Record<string, string> }).env.K = 'mutated';
  assert.deepEqual(src.manifest.mcpServers?.[0]?.args, ['x']);
  assert.deepEqual(src.manifest.mcpServers?.[0]?.env, { K: 'v' });
});
