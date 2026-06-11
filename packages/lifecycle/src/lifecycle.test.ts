/**
 * Tests for @lunaris/lifecycle: identity v2, snapshot roundtrip, bundle
 * export/import (fresh instanceId collision-safety), manifest readability,
 * adopt idempotency. Uses real tmp dirs (no mocks of fs).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  adopt,
  detectFork,
  ensureInstanceId,
  exportBundle,
  importBundle,
  listSnapshots,
  packArchive,
  ProjectMismatchError,
  pruneSnapshots,
  readBundleManifest,
  readIdentity,
  restore,
  snapshot,
} from './index.js';

const tmpRoots: string[] = [];

function freshProject(name = 'demo', projectId = 'proj-fixed-001'): string {
  const root = mkdtempSync(join(tmpdir(), 'lunaris-lc-'));
  tmpRoots.push(root);
  writeFileSync(
    join(root, 'lunaris.toml'),
    [
      '[project]',
      `id = "${projectId}"`,
      `name = "${name}"`,
      '',
      '[models]',
      'default = "mock/echo"',
      '',
    ].join('\n'),
    'utf8',
  );
  return root;
}

function writeState(root: string, rel: string, content: string | Buffer): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

after(() => {
  for (const r of tmpRoots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

test('ensureInstanceId creates instance.json then reuses the same id', () => {
  const root = freshProject();
  const a = ensureInstanceId(root, { skipFingerprint: true });
  assert.ok(existsSync(join(root, '.lunaris', 'state', 'instance.json')));
  assert.equal(a.projectId, 'proj-fixed-001');
  assert.match(a.instanceId, /^[0-9a-f-]{36}$/);

  const b = ensureInstanceId(root, { skipFingerprint: true });
  assert.equal(b.instanceId, a.instanceId, 'instanceId must be stable across calls');
  assert.equal(readIdentity(root)?.instanceId, a.instanceId);
});

test('instanceId is machine-local: never present in a snapshot, and detectFork sees moves', () => {
  const root = freshProject();
  ensureInstanceId(root, { skipFingerprint: true });
  // instance.json must be excluded from snapshots by default.
  writeState(root, '.lunaris/state/memory.db', 'memdata');
  const info = snapshot(root, { kind: 'full', now: () => new Date('2026-06-12T00:00:00Z') });
  const dry = restore(root, info.id, { dryRun: true });
  assert.ok(!dry.restored.includes('.lunaris/state/instance.json'));
  assert.ok(dry.restored.includes('.lunaris/state/memory.db'));

  // No fingerprint stored (skipFingerprint) → not forked; root recorded → not moved.
  const fk = detectFork(root);
  assert.equal(fk.hasInstance, true);
  assert.equal(fk.moved, false);
  assert.equal(fk.forked, false);
});

test('snapshot then restore roundtrips a state tree byte-for-byte', () => {
  const root = freshProject();
  const bin = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  writeState(root, '.lunaris/state/memory.db', 'hello-memory');
  writeState(root, '.lunaris/memory/graph.json', '{"nodes":[1,2,3]}');
  writeState(root, '.lunaris/journal/2026.log', bin);
  writeState(root, '.lunaris/state/nested/deep/x.db', 'deep');

  const info = snapshot(root, { kind: 'pre-op' });
  assert.equal(info.kind, 'pre-op');
  assert.ok(info.bytes > 0);
  assert.equal(info.projectId, 'proj-fixed-001');

  // destroy the live state
  rmSync(join(root, '.lunaris', 'state'), { recursive: true, force: true });
  rmSync(join(root, '.lunaris', 'memory'), { recursive: true, force: true });
  rmSync(join(root, '.lunaris', 'journal'), { recursive: true, force: true });
  assert.ok(!existsSync(join(root, '.lunaris', 'state', 'memory.db')));

  const res = restore(root, info.id);
  assert.equal(res.dryRun, false);
  assert.equal(readFileSync(join(root, '.lunaris', 'state', 'memory.db'), 'utf8'), 'hello-memory');
  assert.equal(
    readFileSync(join(root, '.lunaris', 'memory', 'graph.json'), 'utf8'),
    '{"nodes":[1,2,3]}',
  );
  assert.deepEqual(readFileSync(join(root, '.lunaris', 'journal', '2026.log')), bin);
  assert.equal(readFileSync(join(root, '.lunaris', 'state', 'nested', 'deep', 'x.db'), 'utf8'), 'deep');
});

test('listSnapshots orders newest-first and pruneSnapshots keeps N', () => {
  const root = freshProject();
  writeState(root, '.lunaris/state/memory.db', 'm');
  const s1 = snapshot(root);
  const s2 = snapshot(root);
  const s3 = snapshot(root);
  const list = listSnapshots(root);
  assert.equal(list.length, 3);
  assert.equal(list[0]?.id, s3.id, 'newest first');
  assert.equal(list[2]?.id, s1.id);

  const deleted = pruneSnapshots(root, 1);
  assert.deepEqual(deleted.sort(), [s1.id, s2.id].sort());
  const remaining = listSnapshots(root);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.id, s3.id);
});

test('secrets are excluded from snapshots by default', () => {
  const root = freshProject();
  ensureInstanceId(root, { skipFingerprint: true });
  writeState(root, '.lunaris/state/memory.db', 'm');
  writeState(root, '.lunaris/secrets/keyring.json', 'TOP-SECRET');
  const info = snapshot(root);
  const dry = restore(root, info.id, { dryRun: true });
  assert.ok(!dry.restored.some((p) => p.includes('secrets')), 'no secret path in snapshot');
  assert.ok(!dry.restored.includes('.lunaris/state/instance.json'));
});

test('FIX 5: a symlink in the state tree pointing outside the project root is NOT packed into a snapshot', () => {
  const root = freshProject();
  // A real state file (must be included) and a secret target OUTSIDE the project.
  writeState(root, '.lunaris/state/memory.db', 'real-state');
  const outside = mkdtempSync(join(tmpdir(), 'lunaris-outside-'));
  tmpRoots.push(outside);
  const secretTarget = join(outside, 'passwd');
  writeFileSync(secretTarget, 'root:x:0:0:OUTSIDE-SECRET');

  // A file symlink and a directory symlink, both escaping the project root.
  symlinkSync(secretTarget, join(root, '.lunaris', 'state', 'escape.txt'));
  symlinkSync(outside, join(root, '.lunaris', 'state', 'escape-dir'));

  const info = snapshot(root);
  const dry = restore(root, info.id, { dryRun: true });

  // The real file is packed; neither symlink (nor anything reached through them).
  assert.ok(dry.restored.includes('.lunaris/state/memory.db'), 'real state file is packed');
  assert.ok(!dry.restored.includes('.lunaris/state/escape.txt'), 'file symlink must be skipped');
  assert.ok(
    !dry.restored.some((p) => p.includes('escape-dir') || p.includes('passwd')),
    'directory symlink (and its outside target) must not be followed or packed',
  );
  // And the outside secret content never appears in the archive.
  const full = restore(root, info.id, { dryRun: true });
  assert.ok(!full.restored.some((p) => p.includes('OUTSIDE')), 'no outside content packed');
});

test('export then import into a NEW dir mints a DIFFERENT instanceId (collision-safety)', () => {
  const src = freshProject('src-app', 'lineage-AAA');
  ensureInstanceId(src, { skipFingerprint: true });
  writeState(src, '.lunaris/state/memory.db', 'shared-memory');
  writeState(src, '.lunaris/state/proposals.db', 'props');
  const srcInstance = readIdentity(src)?.instanceId;
  assert.ok(srcInstance);

  const bundlePath = join(src, 'out', 'app.lunaris');
  const manifest = exportBundle(src, bundlePath, { now: () => new Date('2026-06-12T12:00:00Z') });
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.projectId, 'lineage-AAA');
  assert.ok(manifest.contents.includes('manifest'));
  assert.ok(manifest.contents.includes('memory'));
  assert.ok(manifest.contents.includes('proposals'));

  const dest = mkdtempSync(join(tmpdir(), 'lunaris-lc-dest-'));
  tmpRoots.push(dest);
  const result = importBundle(bundlePath, dest, { skipFingerprint: true });

  // committed lineage travels; instanceId must be fresh + different.
  assert.equal(result.identity.projectId, 'lineage-AAA');
  assert.notEqual(result.identity.instanceId, srcInstance, 'fresh instanceId on import');
  assert.equal(
    readFileSync(join(dest, '.lunaris', 'state', 'memory.db'), 'utf8'),
    'shared-memory',
  );
  // imported manifest carries lineage
  assert.ok(existsSync(join(dest, 'lunaris.toml')));
  assert.ok(!result.written.includes('.lunaris/state/instance.json'));
});

test('importBundle asTemplate strips memory + analytics but keeps manifest + proposals', () => {
  const src = freshProject('tmpl', 'lineage-TMPL');
  writeState(src, '.lunaris/state/memory.db', 'mem');
  writeState(src, '.lunaris/state/analytics.db', 'ana');
  writeState(src, '.lunaris/state/proposals.db', 'props');
  const bundlePath = join(src, 'tmpl.lunaris');
  exportBundle(src, bundlePath);

  const dest = mkdtempSync(join(tmpdir(), 'lunaris-lc-tmpl-'));
  tmpRoots.push(dest);
  const result = importBundle(bundlePath, dest, { asTemplate: true, skipFingerprint: true });

  assert.ok(!existsSync(join(dest, '.lunaris', 'state', 'memory.db')), 'memory stripped');
  assert.ok(!existsSync(join(dest, '.lunaris', 'state', 'analytics.db')), 'analytics stripped');
  assert.ok(existsSync(join(dest, '.lunaris', 'state', 'proposals.db')), 'proposals kept');
  assert.ok(existsSync(join(dest, 'lunaris.toml')), 'manifest kept');
  assert.ok(result.skipped.includes('.lunaris/state/memory.db'));
  assert.ok(result.skipped.includes('.lunaris/state/analytics.db'));
});

test('readBundleManifest reads the manifest without unpacking payloads', () => {
  const src = freshProject('readable', 'lineage-READ');
  writeState(src, '.lunaris/state/memory.db', 'm');
  const bundlePath = join(src, 'r.lunaris');
  const written = exportBundle(src, bundlePath, { name: 'Readable Bundle' });
  const read = readBundleManifest(bundlePath);
  assert.equal(read.projectId, 'lineage-READ');
  assert.equal(read.name, 'Readable Bundle');
  assert.equal(read.formatVersion, written.formatVersion);
  assert.deepEqual(read.schemaVersions, written.schemaVersions);
});

test('adopt is idempotent and creates the state dir skeleton', () => {
  const root = freshProject('clone', 'lineage-CLONE');
  // simulate a fresh clone: lunaris.toml committed, no .lunaris/state yet
  assert.ok(!existsSync(join(root, '.lunaris', 'state')));

  const first = adopt(root, { skipFingerprint: true });
  assert.equal(first.instanceCreated, true);
  assert.equal(first.alreadyAdopted, false);
  assert.ok(first.createdDirs.length > 0);
  assert.ok(existsSync(join(root, '.lunaris', 'state')));
  assert.ok(existsSync(join(root, '.lunaris', 'memory')));
  assert.ok(existsSync(join(root, '.lunaris', 'snapshots')));
  assert.ok(existsSync(join(root, '.lunaris', 'state', 'instance.json')));

  const second = adopt(root, { skipFingerprint: true });
  assert.equal(second.instanceCreated, false);
  assert.equal(second.alreadyAdopted, true);
  assert.deepEqual(second.createdDirs, []);
  assert.equal(second.identity.instanceId, first.identity.instanceId, 'same instanceId after re-adopt');
});

test('restore dryRun reports files without writing', () => {
  const root = freshProject();
  writeState(root, '.lunaris/state/memory.db', 'm');
  const info = snapshot(root);
  rmSync(join(root, '.lunaris', 'state'), { recursive: true, force: true });
  const dry = restore(root, info.id, { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.ok(dry.restored.includes('.lunaris/state/memory.db'));
  assert.ok(!existsSync(join(root, '.lunaris', 'state', 'memory.db')), 'dryRun wrote nothing');
});

test('FIX 7: restoring a snapshot whose meta.projectId differs from the target is rejected', () => {
  const root = freshProject('app', 'project-AAA');
  writeState(root, '.lunaris/state/memory.db', 'm');
  const info = snapshot(root);
  assert.equal(info.projectId, 'project-AAA');

  // Re-point this root at a DIFFERENT project id (e.g. the toml was swapped).
  writeFileSync(
    join(root, 'lunaris.toml'),
    ['[project]', 'id = "project-BBB"', 'name = "app"', '', '[models]', 'default = "mock/echo"', ''].join('\n'),
    'utf8',
  );

  // The snapshot belongs to project-AAA but the target is now project-BBB.
  assert.throws(
    () => restore(root, info.id),
    (err: unknown) =>
      err instanceof ProjectMismatchError &&
      err.code === 'PROJECT_MISMATCH' &&
      err.snapshotProjectId === 'project-AAA' &&
      err.targetProjectId === 'project-BBB',
    'cross-project restore must throw ProjectMismatchError',
  );
});

test('FIX 7: restore does NOT overwrite instance.json or secrets by default (only with force)', () => {
  const root = freshProject('app', 'project-CCC');
  // Establish a live instance.json with a known id.
  ensureInstanceId(root, { skipFingerprint: true });
  writeState(root, '.lunaris/state/memory.db', 'live-state-before');

  // Craft an archive that DOES carry the protected files (e.g. a snapshot taken
  // with includeExcluded, or a hand-built/imported bundle): instance.json, a
  // secret, and a normal state file. The meta.projectId matches the target so
  // the project-match guard passes and we isolate the protected-path behaviour.
  const id = 'fix7-crafted-snapshot';
  const archive = packArchive(
    [
      { path: '.lunaris/state/instance.json', data: Buffer.from('{"instanceId":"FROM-ARCHIVE"}') },
      { path: '.lunaris/secrets/keyring.json', data: Buffer.from('SECRET-FROM-ARCHIVE') },
      { path: '.lunaris/state/memory.db', data: Buffer.from('state-from-archive') },
    ],
    { id, projectId: 'project-CCC', createdAt: new Date().toISOString(), kind: 'full', paths: [] },
  );
  mkdirSync(join(root, '.lunaris', 'snapshots'), { recursive: true });
  writeFileSync(join(root, '.lunaris', 'snapshots', `${id}.tar.gz`), archive);

  // Mutate the live instance.json so we can detect a clobber.
  writeFileSync(join(root, '.lunaris', 'state', 'instance.json'), '{"instanceId":"NEW-LIVE-ID"}', 'utf8');

  // Default restore: protected paths are SKIPPED, not written back.
  const res = restore(root, id);
  assert.ok(res.skipped.includes('.lunaris/state/instance.json'), 'instance.json must be skipped');
  assert.ok(res.skipped.some((p) => p.startsWith('.lunaris/secrets/')), 'secrets must be skipped');
  assert.ok(!res.restored.includes('.lunaris/state/instance.json'), 'instance.json not in restored set');
  assert.ok(res.restored.includes('.lunaris/state/memory.db'), 'real state IS restored');
  assert.equal(readFileSync(join(root, '.lunaris', 'state', 'memory.db'), 'utf8'), 'state-from-archive');

  // The live instance.json was NOT clobbered with the archive's stale copy.
  assert.equal(
    readFileSync(join(root, '.lunaris', 'state', 'instance.json'), 'utf8'),
    '{"instanceId":"NEW-LIVE-ID"}',
    'instance.json must remain the live value',
  );
  // The secret was NOT re-introduced on disk.
  assert.ok(!existsSync(join(root, '.lunaris', 'secrets', 'keyring.json')), 'secret must not be re-introduced');

  // With force, the protected paths ARE written back (deliberate full restore).
  const forced = restore(root, id, { force: true });
  assert.ok(forced.restored.includes('.lunaris/state/instance.json'));
  assert.deepEqual(forced.skipped, []);
  assert.equal(
    readFileSync(join(root, '.lunaris', 'state', 'instance.json'), 'utf8'),
    '{"instanceId":"FROM-ARCHIVE"}',
    'force restores the archive instance.json',
  );
  assert.equal(
    readFileSync(join(root, '.lunaris', 'secrets', 'keyring.json'), 'utf8'),
    'SECRET-FROM-ARCHIVE',
  );
});
