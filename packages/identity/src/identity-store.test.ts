import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteIdentityStore } from './identity-store.js';

function freshStore(): SqliteIdentityStore {
  return new SqliteIdentityStore(':memory:');
}

test('createUser + authenticate issues a resolvable token', () => {
  const store = freshStore();
  const user = store.createUser('alice', 'hunter2');
  assert.match(user.id, /^usr_/);

  const res = store.authenticate('alice', 'hunter2');
  assert.equal(res.ok, true);
  assert.ok(res.token);
  assert.ok(res.session);
  assert.equal(res.principal?.id, user.id);

  const resolved = store.resolveToken(res.token as string);
  assert.ok(resolved);
  assert.equal(resolved?.principal.id, user.id);
  assert.equal(resolved?.session.id, res.session?.id);
  store.close();
});

test('authenticate rejects wrong password and unknown user', () => {
  const store = freshStore();
  store.createUser('bob', 'pw');
  assert.equal(store.authenticate('bob', 'WRONG').ok, false);
  assert.equal(store.authenticate('nobody', 'pw').ok, false);
  store.close();
});

test('FIX 4: unknown-user / no-credential paths return a generic failure and pay the scrypt cost (no timing oracle)', () => {
  const store = freshStore();
  // A real user with a password and a credential-less user.
  store.createUser('real', 'pw');
  store.createUser('nocred'); // no password => no credentials row

  // Unknown principal: generic ok:false (no token/session leaked).
  const unknown = store.authenticate('ghost', 'whatever');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.token, undefined);
  assert.equal(unknown.session, undefined);

  // Credential-less principal: also a generic ok:false.
  const noCred = store.authenticate('nocred', 'whatever');
  assert.equal(noCred.ok, false);
  assert.equal(noCred.token, undefined);

  // The dummy scrypt work must actually run: the unknown-user path should cost
  // roughly the same as a real wrong-password verification (which derives a key),
  // not be near-instant. Measure both and assert the unknown path is not an order
  // of magnitude faster (loose bound to stay non-flaky across machines).
  const t0 = process.hrtime.bigint();
  store.authenticate('real', 'WRONG'); // real verify path (derives a key)
  const realMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const t1 = process.hrtime.bigint();
  store.authenticate('ghost', 'WRONG'); // unknown path (must run dummy verify)
  const unknownMs = Number(process.hrtime.bigint() - t1) / 1e6;

  // If the dummy work were skipped, unknownMs would be ~0; require it to be at
  // least a small fraction of the real scrypt cost.
  assert.ok(
    unknownMs >= realMs * 0.25,
    `unknown-user path (${unknownMs.toFixed(1)}ms) should pay scrypt cost comparable to real (${realMs.toFixed(1)}ms)`,
  );
  store.close();
});

test('token expiry is enforced (inject now past expiry => null)', () => {
  const store = new SqliteIdentityStore(':memory:', { sessionTtlMs: 1000 });
  store.createUser('carol', 'pw');
  const t0 = new Date('2026-06-12T00:00:00.000Z');
  const res = store.authenticate('carol', 'pw', t0);
  const token = res.token as string;

  // Within ttl: resolvable.
  assert.ok(store.resolveToken(token, new Date(t0.getTime() + 500)));
  // Past ttl: null.
  assert.equal(store.resolveToken(token, new Date(t0.getTime() + 2000)), null);
  store.close();
});

test('revokeSession invalidates the token', () => {
  const store = freshStore();
  store.createUser('dave', 'pw');
  const res = store.authenticate('dave', 'pw');
  const token = res.token as string;
  assert.ok(store.resolveToken(token));
  store.revokeSession(res.session?.id as string);
  assert.equal(store.resolveToken(token), null);
  store.close();
});

test('RBAC matrix: operator can change_autonomy, viewer cannot; owner has all', () => {
  const store = freshStore();
  const owner = store.createUser('own', 'pw');
  const op = store.createUser('op', 'pw');
  const viewer = store.createUser('view', 'pw');
  store.bind(owner.id, 'global', 'owner');
  store.bind(op.id, 'global', 'operator');
  store.bind(viewer.id, 'global', 'viewer');

  const proj = 'proj1';
  // owner: everything
  assert.equal(store.can(owner.id, proj, 'secrets.write'), true);
  assert.equal(store.can(owner.id, proj, 'fleet.manage'), true);
  assert.equal(store.can(owner.id, proj, 'change_autonomy'), true);

  // operator: run control yes, secrets/providers/fleet no
  assert.equal(store.can(op.id, proj, 'change_autonomy'), true);
  assert.equal(store.can(op.id, proj, 'kill_switch'), true);
  assert.equal(store.can(op.id, proj, 'secrets.write'), false);
  assert.equal(store.can(op.id, proj, 'fleet.manage'), false);

  // viewer: read only
  assert.equal(store.can(viewer.id, proj, 'project.read'), true);
  assert.equal(store.can(viewer.id, proj, 'change_autonomy'), false);
  assert.equal(store.can(viewer.id, proj, 'goal.submit'), false);
  store.close();
});

test('RBAC: maintainer is denied fleet.manage/secrets.write/providers.write but allowed the rest', () => {
  const store = freshStore();
  const m = store.createUser('m', 'pw');
  store.bind(m.id, 'global', 'maintainer');
  assert.equal(store.can(m.id, 'p', 'memory.prune'), true);
  assert.equal(store.can(m.id, 'p', 'secrets.read'), true);
  assert.equal(store.can(m.id, 'p', 'optimizer.promote'), true);
  assert.equal(store.can(m.id, 'p', 'secrets.write'), false);
  assert.equal(store.can(m.id, 'p', 'providers.write'), false);
  assert.equal(store.can(m.id, 'p', 'fleet.manage'), false);
  store.close();
});

test('project binding shadows global binding', () => {
  const store = freshStore();
  const u = store.createUser('eve', 'pw');
  store.bind(u.id, 'global', 'viewer');
  store.bind(u.id, 'project:alpha', 'operator');

  assert.equal(store.roleFor(u.id, 'alpha'), 'operator');
  assert.equal(store.roleFor(u.id, 'beta'), 'viewer'); // falls back to global

  assert.equal(store.can(u.id, 'alpha', 'change_autonomy'), true); // operator in alpha
  assert.equal(store.can(u.id, 'beta', 'change_autonomy'), false); // viewer in beta
  store.close();
});

test('step-up freshness window', () => {
  const store = freshStore();
  store.createUser('frank', 'pw');
  const t0 = new Date('2026-06-12T00:00:00.000Z');
  const res = store.authenticate('frank', 'pw', t0);
  const sid = res.session?.id as string;

  assert.equal(store.hasFreshStepUp(sid, 60_000, t0), false); // none yet
  store.stepUp(sid, t0);
  assert.equal(store.hasFreshStepUp(sid, 60_000, new Date(t0.getTime() + 30_000)), true);
  assert.equal(store.hasFreshStepUp(sid, 60_000, new Date(t0.getTime() + 90_000)), false);
  store.close();
});

test('ensureLocalOwner is idempotent and grants global owner', () => {
  const store = freshStore();
  const owner = store.ensureLocalOwner();
  assert.match(owner.id, /^usr_/);
  assert.equal(store.roleFor(owner.id, 'anything'), 'owner');
  assert.equal(store.can(owner.id, 'anything', 'fleet.manage'), true);

  const again = store.ensureLocalOwner();
  assert.equal(again.id, owner.id); // idempotent
  store.close();
});

test('unbound principal has no capabilities', () => {
  const store = freshStore();
  const u = store.createUser('grace', 'pw');
  assert.equal(store.roleFor(u.id, 'p'), null);
  assert.equal(store.can(u.id, 'p', 'project.read'), false);
  store.close();
});
