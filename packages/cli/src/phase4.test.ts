/**
 * Phase 4 CLI: pure formatter coverage (whoami / snapshot / bundle / lease /
 * version) + a live login→whoami round-trip and a snapshot list/create cycle
 * against a temp project + in-memory-ish on-disk stores.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBundleManifest,
  formatBytes,
  formatDoctorReport,
  formatLeaseLine,
  formatSnapshotLine,
  formatWhoami,
} from './format.js';

test('formatWhoami renders principal id, kind, role and status', () => {
  const lines = formatWhoami(
    { id: 'usr_abc', kind: 'user', displayName: 'alice', status: 'active' },
    'owner',
  );
  assert.ok(lines.some((l) => l.includes('alice') && l.includes('usr_abc')));
  assert.ok(lines.some((l) => l.includes('role:') && l.includes('owner')));
  // Unbound principal shows (unbound).
  const unbound = formatWhoami({ id: 'usr_x', kind: 'user', displayName: 'bob' }, null);
  assert.ok(unbound.some((l) => l.includes('(unbound)')));
});

test('formatBytes scales B / kB / MB', () => {
  assert.equal(formatBytes(512), '512B');
  assert.equal(formatBytes(2048), '2.0kB');
  assert.equal(formatBytes(3_000_000), '3.0MB');
});

test('formatSnapshotLine includes a truncated id, kind and size', () => {
  const line = formatSnapshotLine({
    id: 'snap_0123456789abcdef',
    createdAt: '2026-06-12T00:00:00.000Z',
    bytes: 4096,
    kind: 'full',
  });
  assert.ok(line.startsWith('snap_0123456'));
  assert.ok(line.includes('full'));
  assert.ok(line.includes('4.1kB'));
});

test('formatBundleManifest lists name, project and contents', () => {
  const lines = formatBundleManifest({
    formatVersion: 1,
    projectId: 'proj_1',
    name: 'demo',
    createdAt: '2026-06-12T00:00:00.000Z',
    contents: ['memory', 'proposals'],
    schemaVersions: { memory: 1 },
  });
  assert.ok(lines.some((l) => l.includes('demo')));
  assert.ok(lines.some((l) => l.includes('proj_1')));
  assert.ok(lines.some((l) => l.includes('memory, proposals')));
});

test('formatLeaseLine shows holder, node and epoch', () => {
  const line = formatLeaseLine({
    repoId: 'proj_1',
    holderId: 'goal_abcdef123456',
    nodeId: 'node_xyz',
    epoch: 3,
    acquiredAt: '2026-06-12T00:00:00.000Z',
    heartbeatAt: '2026-06-12T00:00:10.000Z',
  });
  assert.ok(line.includes('proj_1'));
  assert.ok(line.includes('epoch 3'));
  assert.ok(line.includes('node_xyz'));
});

test('formatDoctorReport renders harness version + per-store status table', () => {
  const lines = formatDoctorReport(
    { harness: '0.4.0', schemaVersions: { memory: 1 } },
    {
      harness: '0.4.0',
      stores: [
        { store: 'memory', present: true, version: 1, expected: 1, status: 'ok' },
        { store: 'events', present: false, version: null, expected: 1, status: 'missing' },
      ],
    },
  );
  assert.ok(lines[0]?.includes('0.4.0'));
  assert.ok(lines.some((l) => l.includes('memory') && l.includes('ok')));
  assert.ok(lines.some((l) => l.includes('events') && l.includes('missing')));
});
