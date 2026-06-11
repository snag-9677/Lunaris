import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ToolContext } from './tools.js';
import { builtinTools, resolveWithinRoot, ToolError } from './tools.js';

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'lunaris-tools-'));
}

function ctx(root: string): ToolContext {
  return { projectId: 'p1', projectRoot: root };
}

function tool(name: string) {
  const t = builtinTools.get(name);
  assert.ok(t, `missing built-in tool: ${name}`);
  return t;
}

test('path confinement: write_file and read_file reject escapes outside the root', async () => {
  const root = await makeRoot();
  try {
    const write = tool('write_file');
    await assert.rejects(write.execute({ path: '../x', content: 'nope' }, ctx(root)), ToolError);
    await assert.rejects(
      write.execute({ path: 'a/../../x', content: 'nope' }, ctx(root)),
      ToolError,
    );
    await assert.rejects(
      write.execute({ path: '/tmp/lunaris-escape-test', content: 'nope' }, ctx(root)),
      ToolError,
    );
    const read = tool('read_file');
    await assert.rejects(read.execute({ path: '../../etc/hosts' }, ctx(root)), ToolError);
    assert.throws(() => resolveWithinRoot(root, '..'), ToolError);
    // Inside-root paths resolve fine, including ".." segments that stay inside.
    assert.equal(resolveWithinRoot(root, 'a/../b'), path.join(path.resolve(root), 'b'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('path confinement: in-root symlinks pointing outside the root are rejected (realpath canonicalization)', async () => {
  const root = await makeRoot();
  const outside = await mkdtemp(path.join(tmpdir(), 'lunaris-outside-'));
  try {
    await writeFile(path.join(outside, 'secret.txt'), 'top secret', 'utf8');
    // root/link.txt -> ../outside/secret.txt and root/dir-link -> ../outside
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    await symlink(outside, path.join(root, 'dir-link'));

    const read = tool('read_file');
    const write = tool('write_file');
    const list = tool('list_dir');

    // Reads/listings through escaping symlinks are rejected.
    await assert.rejects(read.execute({ path: 'link.txt' }, ctx(root)), ToolError);
    await assert.rejects(read.execute({ path: 'dir-link/secret.txt' }, ctx(root)), ToolError);
    await assert.rejects(list.execute({ path: 'dir-link' }, ctx(root)), ToolError);

    // Writes through escaping symlinks are rejected and the host file is untouched.
    await assert.rejects(write.execute({ path: 'link.txt', content: 'overwrite' }, ctx(root)), ToolError);
    await assert.rejects(write.execute({ path: 'dir-link/evil.txt', content: 'evil' }, ctx(root)), ToolError);
    assert.equal(await readFile(path.join(outside, 'secret.txt'), 'utf8'), 'top secret');
    await assert.rejects(access(path.join(outside, 'evil.txt')), 'no file may appear outside the root');

    // In-root symlink to an in-root file: reads still work, writes through links are refused.
    await writeFile(path.join(root, 'real.txt'), 'in-root', 'utf8');
    await symlink(path.join(root, 'real.txt'), path.join(root, 'alias.txt'));
    assert.equal(await read.execute({ path: 'alias.txt' }, ctx(root)), 'in-root');
    await assert.rejects(write.execute({ path: 'alias.txt', content: 'x' }, ctx(root)), ToolError);
    assert.equal(await readFile(path.join(root, 'real.txt'), 'utf8'), 'in-root');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('write_file creates parent dirs; read_file and list_dir round-trip', async () => {
  const root = await makeRoot();
  try {
    await tool('write_file').execute(
      { path: 'sub/dir/hello.txt', content: 'hi there' },
      ctx(root),
    );
    assert.equal(
      await readFile(path.join(root, 'sub', 'dir', 'hello.txt'), 'utf8'),
      'hi there',
    );
    assert.equal(
      await tool('read_file').execute({ path: 'sub/dir/hello.txt' }, ctx(root)),
      'hi there',
    );
    const listing = await tool('list_dir').execute({ path: 'sub' }, ctx(root));
    assert.equal(listing, 'dir/');
    await assert.rejects(tool('read_file').execute({ path: 'missing.txt' }, ctx(root)), ToolError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('run_bash runs in the project root and reports exit code, stdout and stderr', async () => {
  const root = await makeRoot();
  try {
    const bash = tool('run_bash');
    const ok = await bash.execute({ command: 'pwd; echo out-line; echo err-line 1>&2' }, ctx(root));
    assert.match(ok, /exit code: 0/);
    assert.match(ok, /out-line/);
    assert.match(ok, /err-line/);
    // cwd is the project root (realpath-insensitive containment check).
    const reported = ok.split('\n').find((l) => l.includes(path.basename(root)));
    assert.ok(reported, 'pwd output should mention the project root');

    const fail = await bash.execute({ command: 'exit 3' }, ctx(root));
    assert.match(fail, /exit code: 3/);

    await assert.rejects(bash.execute({ command: 42 }, ctx(root)), ToolError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
