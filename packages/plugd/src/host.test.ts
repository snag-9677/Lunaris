import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { FilePluginHost } from './host.js';
import { scaffoldPlugin } from './scaffold.js';

const tmpRoots: string[] = [];
function freshPluginsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lunaris-plugd-host-'));
  tmpRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

/** Write a minimal tool plugin under <pluginsDir>/<slug>. */
function writePlugin(
  pluginsDir: string,
  slug: string,
  id: string,
  moduleBody: string,
  opts: { module?: string; toolName?: string; exportName?: string } = {},
): void {
  const root = join(pluginsDir, slug);
  const modulePath = opts.module ?? 'tools/main.js';
  mkdirSync(join(root, 'tools'), { recursive: true });
  const toolLines = [
    '[[tools]]',
    `name = "${opts.toolName ?? 'do'}"`,
    'description = "test tool"',
    `module = "${modulePath}"`,
  ];
  if (opts.exportName) toolLines.push(`export = "${opts.exportName}"`);
  writeFileSync(
    join(root, 'plugin.toml'),
    [`id = "${id}"`, 'version = "0.1.0"', ...toolLines].join('\n'),
    'utf8',
  );
  writeFileSync(join(root, modulePath), moduleBody, 'utf8');
}

test('discovery lists plugins; enable/disable persists to the registry; no code executed at list', () => {
  const dir = freshPluginsDir();
  // A module that throws at import time proves list() never imports it.
  writePlugin(dir, 'a', 'dev.test.a', 'throw new Error("import side effect!");');

  const host = new FilePluginHost({ pluginsDir: dir });
  let listed = host.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.manifest.id, 'dev.test.a');
  assert.equal(listed[0]?.enabled, false);

  host.enable('dev.test.a');
  // Persisted to registry file.
  const registry = JSON.parse(readFileSync(join(dir, 'plugins.json'), 'utf8')) as {
    enabled: string[];
  };
  assert.deepEqual(registry.enabled, ['dev.test.a']);

  // A fresh host reads enabled state back from the registry.
  listed = new FilePluginHost({ pluginsDir: dir }).list();
  assert.equal(listed[0]?.enabled, true);

  host.disable('dev.test.a');
  assert.equal(new FilePluginHost({ pluginsDir: dir }).list()[0]?.enabled, false);
});

test('enabledTools resolves an enabled plugin tool, namespaces it, and execute() runs', async () => {
  const dir = freshPluginsDir();
  writePlugin(
    dir,
    'echo',
    'dev.test.echo',
    'export async function execute(args) { return "echo:" + (args && args.text); }\n',
    { toolName: 'shout' },
  );

  const host = new FilePluginHost({ pluginsDir: dir, enabledIds: ['dev.test.echo'] });
  const tools = await host.enabledTools();
  assert.equal(tools.length, 1);
  // Namespaced as <pluginId>/<toolName>.
  assert.equal(tools[0]?.def.name, 'dev.test.echo/shout');
  assert.equal(tools[0]?.pluginId, 'dev.test.echo');
  const out = await tools[0]?.execute({ text: 'hi' }, {});
  assert.equal(out, 'echo:hi');
  assert.equal(host.lastLoadErrors.length, 0);
});

test('enabledTools honors a named export and coerces non-string results to JSON', async () => {
  const dir = freshPluginsDir();
  writePlugin(
    dir,
    'json',
    'dev.test.json',
    'export function run(args) { return { ok: true, got: args }; }\n',
    { exportName: 'run' },
  );
  const host = new FilePluginHost({ pluginsDir: dir, enabledIds: ['dev.test.json'] });
  const tools = await host.enabledTools();
  const out = await tools[0]?.execute({ a: 1 }, {});
  assert.equal(out, JSON.stringify({ ok: true, got: { a: 1 } }));
});

test('a tool with a missing module is skipped + recorded, never throws', async () => {
  const dir = freshPluginsDir();
  const root = join(dir, 'broken');
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'plugin.toml'),
    [
      'id = "dev.test.broken"',
      'version = "0.1.0"',
      '[[tools]]',
      'name = "gone"',
      'description = "missing module"',
      'module = "tools/does-not-exist.js"',
    ].join('\n'),
    'utf8',
  );

  const host = new FilePluginHost({ pluginsDir: dir, enabledIds: ['dev.test.broken'] });
  const tools = await host.enabledTools(); // must not throw
  assert.equal(tools.length, 0);
  assert.equal(host.lastLoadErrors.length, 1);
  assert.equal(host.lastLoadErrors[0]?.pluginId, 'dev.test.broken');
  assert.equal(host.lastLoadErrors[0]?.toolName, 'gone');
});

test('a module lacking the named export is skipped + recorded', async () => {
  const dir = freshPluginsDir();
  writePlugin(
    dir,
    'noexport',
    'dev.test.noexport',
    'export const somethingElse = 1;\n', // no "execute"
  );
  const host = new FilePluginHost({ pluginsDir: dir, enabledIds: ['dev.test.noexport'] });
  const tools = await host.enabledTools();
  assert.equal(tools.length, 0);
  assert.equal(host.lastLoadErrors.length, 1);
  assert.match(host.lastLoadErrors[0]?.reason ?? '', /missing export "execute"/);
});

test('disabled plugins contribute no tools', async () => {
  const dir = freshPluginsDir();
  writePlugin(dir, 'p', 'dev.test.p', 'export const execute = () => "x";\n');
  const host = new FilePluginHost({ pluginsDir: dir }); // registry empty => none enabled
  const tools = await host.enabledTools();
  assert.equal(tools.length, 0);
});

test('missing pluginsDir yields an empty, non-throwing list', () => {
  const host = new FilePluginHost({ pluginsDir: join(tmpdir(), 'lunaris-plugd-nope-xyz') });
  assert.deepEqual(host.list(), []);
});

test('scaffoldPlugin output loads back and its echo tool executes', async () => {
  const dir = freshPluginsDir();
  const pluginRoot = join(dir, 'starter');
  scaffoldPlugin(pluginRoot, { id: 'dev.acme.starter', name: 'Starter' });
  assert.ok(existsSync(join(pluginRoot, 'plugin.toml')));
  assert.ok(existsSync(join(pluginRoot, 'tools', 'echo.js')));

  const host = new FilePluginHost({ pluginsDir: dir, enabledIds: ['dev.acme.starter'] });
  const listed = host.list();
  assert.equal(listed[0]?.manifest.id, 'dev.acme.starter');

  const tools = await host.enabledTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.def.name, 'dev.acme.starter/echo');
  const out = await tools[0]?.execute({ text: 'roundtrip' }, {});
  assert.equal(out, 'roundtrip');
  assert.equal(host.lastLoadErrors.length, 0);
});
