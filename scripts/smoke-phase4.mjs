#!/usr/bin/env node
/**
 * Lunaris Phase 4 smoke test (no network, no API keys, fully offline).
 *
 * Exercises the Phase 4 substrate against the real, built packages:
 *
 *  (a) IDENTITY + RBAC: SqliteIdentityStore — create an owner (global owner) +
 *      a viewer (global viewer). authenticate the owner with its password, get
 *      a bearer token, and resolve it via resolveToken back to the owner
 *      principal + a live session. Assert the owner CAN goal.submit and the
 *      viewer CANNOT change_autonomy (and can only project.read).
 *  (b) CAPABILITY TOKENS: Ed25519CapabilityTokenService — mint + verify a
 *      roundtrip (decoded fields match). Tamper a byte of the payload segment
 *      => verify returns null. Attenuate to a strict subset works (and keeps
 *      project/run/epoch + expiry); escalating to a cap not in the parent
 *      throws / returns falsy.
 *  (c) LEASES + FENCING: SqliteLeaseStore — acquire for holderA, a second
 *      acquire for holderB while A's lease is still fresh => null. Inject a
 *      `now` past the ttl so the lease is expired => holderB acquires and the
 *      epoch is incremented. isCurrentEpoch rejects the old epoch and accepts
 *      the new one.
 *  (d) LIFECYCLE: write a tmp state tree, snapshot it, delete the live state,
 *      restore => bytes equal. Then export a bundle and import it into a NEW
 *      dir => the destination instanceId differs from the source's.
 *  (e) CORE DOCTOR: over a tmp sqlite db, report 'ok' when on-disk version ==
 *      expected and 'behind' when on-disk version < expected.
 *  (f) DAEMON: buildServer + inject GET /api/version => 200 (VersionInfo +
 *      doctor report).
 *
 * Exported as runPhase4Smoke() so scripts/smoke.mjs can call it after Phase 3.
 * Run standalone too: `node scripts/smoke-phase4.mjs` — exits 0 on success.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const here = (rel) => new URL(rel, import.meta.url).href;

const core = await import(here('../packages/core/dist/index.js'));
const identityPkg = await import(here('../packages/identity/dist/index.js'));
const lifecyclePkg = await import(here('../packages/lifecycle/dist/index.js'));
const daemonPkg = await import(here('../packages/daemon/dist/index.js'));

const { ensureSchemaMeta, setStoreVersion, doctor, SCHEMA_VERSIONS } = core;
const { SqliteIdentityStore, Ed25519CapabilityTokenService, SqliteLeaseStore } = identityPkg;
const {
  ensureInstanceId,
  exportBundle,
  importBundle,
  readIdentity,
  restore,
  snapshot,
} = lifecyclePkg;
const { buildServer } = daemonPkg;

/** Write a project-root-relative state file (parent dirs created). */
function writeState(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

/** Build a minimal committed lunaris.toml under root. */
function freshProject(root, name, projectId) {
  mkdirSync(root, { recursive: true });
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

export async function runPhase4Smoke() {
  const root = mkdtempSync(join(tmpdir(), 'lunaris-smoke-p4-'));
  const daemonDir = mkdtempSync(join(tmpdir(), 'lunaris-smoke-p4-daemon-'));
  let identity;
  let leases;
  let app;

  try {
    // ---- (a) IDENTITY + RBAC -------------------------------------------------
    const PROJECT = 'proj-p4-001';
    identity = new SqliteIdentityStore(':memory:');

    const owner = identity.createUser('owner-alice', 'sk-owner-pass');
    identity.bind(owner.id, 'global', 'owner');
    const viewer = identity.createUser('viewer-vic', 'sk-viewer-pass');
    identity.bind(viewer.id, 'global', 'viewer');

    const auth = identity.authenticate('owner-alice', 'sk-owner-pass');
    assert.equal(auth.ok, true, 'owner must authenticate with the right password');
    assert.ok(auth.token, 'authenticate must hand back a bearer token');
    assert.equal(auth.principal?.id, owner.id, 'authenticated principal is the owner');

    const resolved = identity.resolveToken(auth.token);
    assert.ok(resolved, 'resolveToken must resolve a live token');
    assert.equal(resolved.principal.id, owner.id, 'resolved token maps back to the owner');
    assert.equal(resolved.session.principalId, owner.id, 'resolved session belongs to the owner');

    // a tampered / unknown token resolves to null
    assert.equal(identity.resolveToken(`${auth.token}deadbeef`), null, 'tampered token => null');

    // owner CAN goal.submit; viewer CANNOT change_autonomy (but CAN project.read)
    assert.equal(identity.can(owner.id, PROJECT, 'goal.submit'), true, 'owner can goal.submit');
    assert.equal(identity.can(owner.id, PROJECT, 'change_autonomy'), true, 'owner can change_autonomy');
    assert.equal(
      identity.can(viewer.id, PROJECT, 'change_autonomy'),
      false,
      'viewer must NOT change_autonomy',
    );
    assert.equal(identity.can(viewer.id, PROJECT, 'goal.submit'), false, 'viewer must NOT goal.submit');
    assert.equal(identity.can(viewer.id, PROJECT, 'project.read'), true, 'viewer can project.read');

    identity.close();
    identity = undefined; // closed inline; prevent finally double-close

    // ---- (b) CAPABILITY TOKENS: mint/verify, tamper, attenuate --------------
    const keyPath = join(root, '.lunaris', 'state', 'cap-key.pem');
    const cap = new Ed25519CapabilityTokenService({ keyPath });

    const minted = cap.mint({
      principalId: 'agt_smoke',
      projectId: PROJECT,
      runId: 'run-p4-1',
      leaseEpoch: 1,
      caps: ['fs.write:/repo', 'exec', 'net'],
      ttlMs: 60_000,
    });
    const verified = cap.verify(minted);
    assert.ok(verified, 'a freshly minted token must verify');
    assert.equal(verified.principalId, 'agt_smoke', 'roundtrip preserves principalId');
    assert.equal(verified.projectId, PROJECT, 'roundtrip preserves projectId');
    assert.equal(verified.runId, 'run-p4-1', 'roundtrip preserves runId');
    assert.equal(verified.leaseEpoch, 1, 'roundtrip preserves leaseEpoch');
    assert.deepEqual(verified.caps, ['fs.write:/repo', 'exec', 'net'], 'roundtrip preserves caps');

    // tamper a byte in the payload segment => verify must reject (null)
    const dot = minted.indexOf('.');
    const payloadSeg = minted.slice(0, dot);
    const flippedChar = payloadSeg[5] === 'A' ? 'B' : 'A';
    const tampered = payloadSeg.slice(0, 5) + flippedChar + payloadSeg.slice(6) + minted.slice(dot);
    assert.equal(cap.verify(tampered), null, 'tampered payload byte => verify null');

    // attenuate to a strict subset => works, keeps project/run/epoch + expiry
    const attenuated = cap.attenuate(minted, ['exec']);
    const attVerified = cap.verify(attenuated);
    assert.ok(attVerified, 'attenuated token must verify');
    assert.deepEqual(attVerified.caps, ['exec'], 'attenuation shrinks the cap set');
    assert.equal(attVerified.projectId, PROJECT, 'attenuation keeps projectId');
    assert.equal(attVerified.runId, 'run-p4-1', 'attenuation keeps runId');
    assert.equal(attVerified.leaseEpoch, 1, 'attenuation keeps leaseEpoch');
    assert.equal(attVerified.expiresAt, verified.expiresAt, 'attenuation never extends expiry');

    // escalation (a cap not in the parent) must throw / be rejected
    let escalationRejected = false;
    try {
      cap.attenuate(minted, ['exec', 'fleet.manage']);
    } catch {
      escalationRejected = true;
    }
    assert.equal(escalationRejected, true, 'attenuation escalation must throw');
    // chained attenuation cannot re-widen either
    let rewidenRejected = false;
    try {
      cap.attenuate(attenuated, ['exec', 'net']);
    } catch {
      rewidenRejected = true;
    }
    assert.equal(rewidenRejected, true, 'chained attenuation cannot re-widen');

    // ---- (c) LEASES + FENCING ------------------------------------------------
    const leasesDbPath = join(root, '.lunaris', 'state', 'leases.db');
    const REPO = 'repo-p4';
    const TTL = 45_000;
    leases = new SqliteLeaseStore(leasesDbPath, { ttlMs: TTL, nodeId: 'node-test' });

    const t0 = new Date('2026-06-12T00:00:00.000Z');
    const leaseA = leases.acquire(REPO, 'holderA', 'node-test', t0);
    assert.ok(leaseA, 'holderA must acquire a free lease');
    const epochA = leaseA.epoch;
    assert.equal(epochA, 1, 'first acquisition gets epoch 1');

    // holderB cannot acquire while A's lease is still fresh
    const blocked = leases.acquire(REPO, 'holderB', 'node-test', new Date(t0.getTime() + 1_000));
    assert.equal(blocked, null, 'a fresh lease held by another => null');

    // expire the lease (now past ttl), holderB acquires + epoch increments
    const tExpired = new Date(t0.getTime() + TTL + 5_000);
    const leaseB = leases.acquire(REPO, 'holderB', 'node-test', tExpired);
    assert.ok(leaseB, 'holderB must acquire once A is expired');
    assert.equal(leaseB.holderId, 'holderB', 'expired lease is taken over by holderB');
    assert.ok(leaseB.epoch > epochA, `epoch must increment on takeover (${leaseB.epoch} > ${epochA})`);

    // fencing: the OLD epoch is rejected, the NEW one accepted
    assert.equal(
      leases.isCurrentEpoch(REPO, epochA, tExpired),
      false,
      'isCurrentEpoch must reject the stale epoch',
    );
    assert.equal(
      leases.isCurrentEpoch(REPO, leaseB.epoch, tExpired),
      true,
      'isCurrentEpoch must accept the current epoch',
    );

    leases.close();
    leases = undefined; // closed inline; prevent finally double-close

    // ---- (d) LIFECYCLE: snapshot/restore + export/import fresh instanceId ----
    const lcRoot = join(root, 'lc-src');
    freshProject(lcRoot, 'p4-app', 'lineage-P4');
    ensureInstanceId(lcRoot, { skipFingerprint: true });
    const srcInstance = readIdentity(lcRoot)?.instanceId;
    assert.ok(srcInstance, 'source must have an instanceId');

    const binBlob = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    writeState(lcRoot, '.lunaris/state/memory.db', 'hello-memory-p4');
    writeState(lcRoot, '.lunaris/state/proposals.db', 'props-p4');
    writeState(lcRoot, '.lunaris/memory/graph.json', '{"nodes":[1,2,3]}');
    writeState(lcRoot, '.lunaris/journal/2026.log', binBlob);

    const snapInfo = snapshot(lcRoot, { kind: 'full' });
    assert.ok(snapInfo.bytes > 0, 'snapshot must produce bytes');
    assert.equal(snapInfo.projectId, 'lineage-P4', 'snapshot records the project id');

    // destroy live state, then restore and compare bytes
    rmSync(join(lcRoot, '.lunaris', 'state'), { recursive: true, force: true });
    rmSync(join(lcRoot, '.lunaris', 'memory'), { recursive: true, force: true });
    rmSync(join(lcRoot, '.lunaris', 'journal'), { recursive: true, force: true });
    assert.ok(!existsSync(join(lcRoot, '.lunaris', 'state', 'memory.db')), 'state destroyed');

    const restoreRes = restore(lcRoot, snapInfo.id);
    assert.equal(restoreRes.dryRun, false, 'restore is a real write');
    assert.equal(
      readFileSync(join(lcRoot, '.lunaris', 'state', 'memory.db'), 'utf8'),
      'hello-memory-p4',
      'restored memory.db bytes must equal the original',
    );
    assert.deepEqual(
      readFileSync(join(lcRoot, '.lunaris', 'journal', '2026.log')),
      binBlob,
      'restored binary journal must be byte-for-byte equal',
    );
    // instance.json (machine-local) must NOT travel through a snapshot
    assert.ok(
      !restoreRes.restored.includes('.lunaris/state/instance.json'),
      'instance.json must be excluded from snapshots',
    );

    // export then import into a NEW dir => fresh (different) instanceId
    const bundlePath = join(root, 'out', 'p4.lunaris');
    const bundleManifest = exportBundle(lcRoot, bundlePath);
    assert.equal(bundleManifest.projectId, 'lineage-P4', 'bundle carries committed lineage');

    const destRoot = join(root, 'lc-dest');
    const importRes = importBundle(bundlePath, destRoot, { skipFingerprint: true });
    assert.equal(importRes.identity.projectId, 'lineage-P4', 'imported tree keeps the lineage id');
    assert.notEqual(
      importRes.identity.instanceId,
      srcInstance,
      'import must mint a DIFFERENT instanceId (collision-safety)',
    );
    assert.equal(
      readFileSync(join(destRoot, '.lunaris', 'state', 'memory.db'), 'utf8'),
      'hello-memory-p4',
      'imported memory.db survives the roundtrip',
    );

    // ---- (e) CORE DOCTOR: ok vs behind --------------------------------------
    const okDbPath = join(root, '.lunaris', 'state', 'doctor-ok.db');
    const behindDbPath = join(root, '.lunaris', 'state', 'doctor-behind.db');
    const expectedEvents = SCHEMA_VERSIONS.events;
    {
      mkdirSync(join(root, '.lunaris', 'state'), { recursive: true });
      const okDb = new DatabaseSync(okDbPath);
      ensureSchemaMeta(okDb);
      setStoreVersion(okDb, 'events', expectedEvents); // == expected => ok
      okDb.close();

      const behindDb = new DatabaseSync(behindDbPath);
      ensureSchemaMeta(behindDb);
      setStoreVersion(behindDb, 'events', expectedEvents - 1); // < expected => behind
      behindDb.close();
    }
    const report = doctor({ events: okDbPath });
    const okStore = report.stores.find((s) => s.store === 'events');
    assert.ok(okStore, 'doctor must report the events store');
    assert.equal(okStore.status, 'ok', 'on-disk == expected => ok');

    const behindReport = doctor({ events: behindDbPath });
    const behindStore = behindReport.stores.find((s) => s.store === 'events');
    assert.equal(behindStore?.status, 'behind', 'on-disk < expected => behind');

    // ---- (f) DAEMON: GET /api/version -> 200 --------------------------------
    app = await buildServer({
      registryPath: join(daemonDir, 'projects.json'),
      eventsDbPath: join(daemonDir, 'events.db'),
      identityDbPath: ':memory:',
      authMode: 'off',
    });
    const res = await app.inject({ method: 'GET', url: '/api/version' });
    assert.equal(res.statusCode, 200, `GET /api/version -> ${res.statusCode}: ${res.body}`);
    const vbody = res.json();
    assert.match(vbody.version.harness, /^\d+\.\d+\.\d+/, 'version.harness must be a semver');
    assert.ok(typeof vbody.version.schemaVersions === 'object', 'schemaVersions must be present');
    assert.ok(Array.isArray(vbody.doctor.stores), 'doctor report must carry a stores array');

    // eslint-disable-next-line no-console
    console.log('smoke-phase4 OK');
    console.log(
      `  identity:      owner authenticates + resolveToken; owner can goal.submit, viewer cannot change_autonomy`,
    );
    console.log(
      `  cap-token:     mint/verify roundtrip, tamper => null, attenuate exec, escalation rejected`,
    );
    console.log(
      `  leases:        holderA epoch ${epochA}; holderB blocked while fresh; takeover epoch ${leaseB.epoch}; stale epoch fenced`,
    );
    console.log(
      `  lifecycle:     snapshot/restore byte-equal; import minted fresh instanceId (…${importRes.identity.instanceId.slice(-8)} != …${srcInstance.slice(-8)})`,
    );
    console.log(`  doctor:        events ok @${expectedEvents}, behind @${expectedEvents - 1}`);
    console.log('  /api/version:  200');
  } finally {
    if (app) await app.close().catch(() => {});
    identity?.close?.();
    leases?.close?.();
    rmSync(root, { recursive: true, force: true });
    rmSync(daemonDir, { recursive: true, force: true });
  }
}

// Allow standalone execution: `node scripts/smoke-phase4.mjs`.
if (import.meta.url === `file://${process.argv[1]}`) {
  runPhase4Smoke().then(
    () => process.exit(0),
    (err) => {
      console.error('smoke-phase4 FAILED');
      console.error(err);
      process.exit(1);
    },
  );
}
