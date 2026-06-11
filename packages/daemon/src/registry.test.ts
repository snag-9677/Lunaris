import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProjectRegistry } from './registry.js';

function tmpRegistryPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'lunarisd-registry-test-'));
  return {
    path: join(dir, 'projects.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('registry: load returns empty registry when file is missing', () => {
  const { path, cleanup } = tmpRegistryPath();
  try {
    const registry = new ProjectRegistry(path);
    assert.deepEqual(registry.load(), { projects: [] });
    assert.deepEqual(registry.list(), []);
    assert.equal(registry.get('nope'), undefined);
  } finally {
    cleanup();
  }
});

test('registry: save/load round-trip, list and get', () => {
  const { path, cleanup } = tmpRegistryPath();
  try {
    const registry = new ProjectRegistry(path);
    const a = { id: 'proj-a', name: 'Project A', root: '/tmp/a' };
    const b = { id: 'proj-b', name: 'Project B', root: '/tmp/b' };
    registry.save({ projects: [a, b] });

    const reloaded = new ProjectRegistry(path);
    assert.deepEqual(reloaded.load(), { projects: [a, b] });
    assert.equal(reloaded.list().length, 2);
    assert.deepEqual(reloaded.get('proj-b'), b);
    assert.equal(reloaded.get('proj-c'), undefined);
  } finally {
    cleanup();
  }
});
