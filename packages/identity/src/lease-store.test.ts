import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteLeaseStore } from './lease-store.js';

function store(ttlMs = 45_000): SqliteLeaseStore {
  return new SqliteLeaseStore(':memory:', { ttlMs, nodeId: 'node_test' });
}

const REPO = 'repo1';

test('acquire on a free repo grants a lease at epoch 1', () => {
  const s = store();
  const lease = s.acquire(REPO, 'holderA', 'node_test');
  assert.ok(lease);
  assert.equal(lease?.epoch, 1);
  assert.equal(lease?.holderId, 'holderA');
  assert.equal(s.current(REPO)?.holderId, 'holderA');
  s.close();
});

test('a second holder cannot acquire a live lease', () => {
  const s = store();
  assert.ok(s.acquire(REPO, 'holderA', 'n'));
  assert.equal(s.acquire(REPO, 'holderB', 'n'), null); // live, held by A
  s.close();
});

test('same-holder re-acquire keeps the epoch (idempotent renew)', () => {
  const s = store();
  const t0 = new Date('2026-06-12T00:00:00.000Z');
  const first = s.acquire(REPO, 'holderA', 'n', t0);
  const again = s.acquire(REPO, 'holderA', 'n', new Date(t0.getTime() + 1000));
  assert.equal(first?.epoch, 1);
  assert.equal(again?.epoch, 1); // unchanged
  s.close();
});

test('epoch increments on takeover after expiry', () => {
  const s = store(1000); // 1s ttl
  const t0 = new Date('2026-06-12T00:00:00.000Z');
  const a = s.acquire(REPO, 'holderA', 'n', t0);
  assert.equal(a?.epoch, 1);

  // B cannot take over while A is live.
  assert.equal(s.acquire(REPO, 'holderB', 'n', new Date(t0.getTime() + 500)), null);

  // After ttl, A's lease is expired; B takes over at epoch 2.
  const b = s.acquire(REPO, 'holderB', 'n', new Date(t0.getTime() + 2000));
  assert.ok(b);
  assert.equal(b?.epoch, 2);
  assert.equal(b?.holderId, 'holderB');
  s.close();
});

test('heartbeat refreshes only for the current holder and keeps the lease alive', () => {
  const s = store(1000);
  const t0 = new Date('2026-06-12T00:00:00.000Z');
  s.acquire(REPO, 'holderA', 'n', t0);

  // Wrong holder cannot heartbeat.
  assert.equal(s.heartbeat(REPO, 'holderB', new Date(t0.getTime() + 200)), false);

  // Correct holder heartbeats at +800ms, extending liveness past the original ttl.
  assert.equal(s.heartbeat(REPO, 'holderA', new Date(t0.getTime() + 800)), true);
  // At +1500ms the lease would have expired without the heartbeat; with it, still live.
  assert.ok(s.current(REPO, new Date(t0.getTime() + 1500)));
  // B still cannot take it.
  assert.equal(s.acquire(REPO, 'holderB', 'n', new Date(t0.getTime() + 1500)), null);
  s.close();
});

test('current() returns null once the lease expires', () => {
  const s = store(1000);
  const t0 = new Date('2026-06-12T00:00:00.000Z');
  s.acquire(REPO, 'holderA', 'n', t0);
  assert.ok(s.current(REPO, new Date(t0.getTime() + 500)));
  assert.equal(s.current(REPO, new Date(t0.getTime() + 2000)), null);
  s.close();
});

test('isCurrentEpoch rejects a stale epoch (fencing)', () => {
  const s = store(1000);
  const t0 = new Date('2026-06-12T00:00:00.000Z');
  s.acquire(REPO, 'holderA', 'n', t0); // epoch 1
  // Takeover after expiry -> epoch 2.
  s.acquire(REPO, 'holderB', 'n', new Date(t0.getTime() + 2000));

  const tNow = new Date(t0.getTime() + 2000);
  assert.equal(s.isCurrentEpoch(REPO, 1, tNow), false); // stale zombie epoch rejected
  assert.equal(s.isCurrentEpoch(REPO, 2, tNow), true);
  // No live lease at all -> false.
  assert.equal(s.isCurrentEpoch('other-repo', 1, tNow), false);
  s.close();
});

test('release frees the lease only for the holder', () => {
  const s = store();
  s.acquire(REPO, 'holderA', 'n');
  s.release(REPO, 'holderB'); // wrong holder: no-op
  assert.ok(s.current(REPO));
  s.release(REPO, 'holderA');
  assert.equal(s.current(REPO), null);
  // After release, a fresh acquisition increments the epoch.
  const next = s.acquire(REPO, 'holderC', 'n');
  assert.equal(next?.epoch, 2);
  s.close();
});

test('two racers: exactly one wins the same free repo', () => {
  const s = store();
  const t0 = new Date('2026-06-12T00:00:00.000Z');
  const a = s.acquire(REPO, 'racerA', 'n', t0);
  const b = s.acquire(REPO, 'racerB', 'n', t0);
  const winners = [a, b].filter((x) => x !== null);
  assert.equal(winners.length, 1);
  assert.equal(s.current(REPO, t0)?.holderId, winners[0]?.holderId);
  s.close();
});
