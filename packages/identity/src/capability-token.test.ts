import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ed25519CapabilityTokenService, capsSatisfy } from './capability-token.js';
import type { AgentToken } from '@lunaris/core';

function svc(): Ed25519CapabilityTokenService {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return new Ed25519CapabilityTokenService({ privateKey, publicKey });
}

const base: Omit<AgentToken, 'expiresAt'> = {
  principalId: 'agt_abc',
  projectId: 'proj1',
  runId: 'run1',
  leaseEpoch: 3,
  caps: ['fs.write:/repo', 'exec', 'net', 'provider:ollama'],
};

test('mint + verify roundtrip preserves all fields', () => {
  const s = svc();
  const signed = s.mint({ ...base, ttlMs: 60_000 });
  const tok = s.verify(signed);
  assert.ok(tok);
  assert.equal(tok?.principalId, 'agt_abc');
  assert.equal(tok?.projectId, 'proj1');
  assert.equal(tok?.runId, 'run1');
  assert.equal(tok?.leaseEpoch, 3);
  assert.deepEqual(tok?.caps, base.caps);
  assert.ok(capsSatisfy(tok as AgentToken, 'exec'));
  assert.equal(capsSatisfy(tok as AgentToken, 'spawn'), false);
});

test('tamper: flipping a signature byte yields null', () => {
  const s = svc();
  const signed = s.mint({ ...base, ttlMs: 60_000 });
  const [payload, sig] = signed.split('.');
  const firstSig = (sig as string)[0];
  const flipped = (firstSig === 'A' ? 'B' : 'A') + (sig as string).slice(1);
  const tampered = `${payload}.${flipped}`;
  assert.equal(s.verify(tampered), null);
});

test('tamper: editing the payload (cap escalation) breaks the signature', () => {
  const s = svc();
  const signed = s.mint({ ...base, ttlMs: 60_000 });
  const [, sig] = signed.split('.');
  const evil = JSON.stringify({
    ...base,
    caps: [...base.caps, 'secrets.read'],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const evilPayload = Buffer.from(evil, 'utf8').toString('base64url');
  assert.equal(s.verify(`${evilPayload}.${sig}`), null);
});

test('verify enforces expiry', () => {
  const s = svc();
  const t0 = Date.now();
  const signed = s.mint({ ...base, ttlMs: 1000 });
  assert.ok(s.verify(signed, new Date(t0 + 500)));
  assert.equal(s.verify(signed, new Date(t0 + 5000)), null);
});

test('verify rejects malformed strings', () => {
  const s = svc();
  assert.equal(s.verify('no-dot'), null);
  assert.equal(s.verify('.'), null);
  assert.equal(s.verify('a.b.c'), null);
  assert.equal(s.verify(''), null);
});

test('attenuate shrinks caps and keeps run/project/epoch + expiry', () => {
  const s = svc();
  const parent = s.mint({ ...base, ttlMs: 60_000 });
  const child = s.attenuate(parent, ['exec', 'net']);
  const tok = s.verify(child);
  assert.ok(tok);
  assert.deepEqual(tok?.caps, ['exec', 'net']);
  assert.equal(tok?.projectId, 'proj1');
  assert.equal(tok?.runId, 'run1');
  assert.equal(tok?.leaseEpoch, 3);
  const parentTok = s.verify(parent) as AgentToken;
  assert.equal(tok?.expiresAt, parentTok.expiresAt);
});

test('attenuate REJECTS escalation (cap not in parent)', () => {
  const s = svc();
  const parent = s.mint({ ...base, ttlMs: 60_000 });
  assert.throws(() => s.attenuate(parent, ['exec', 'secrets.read']), /escalation/);
  assert.throws(() => s.attenuate(parent, ['spawn']), /escalation/);
});

test('attenuate rejects an invalid/expired parent', () => {
  const s = svc();
  assert.throws(() => s.attenuate('garbage.token', ['exec']), /invalid or expired/);
});

test('chained attenuation cannot re-widen', () => {
  const s = svc();
  const parent = s.mint({ ...base, ttlMs: 60_000 });
  const child = s.attenuate(parent, ['exec', 'net']);
  // grandchild may only subset the child — re-adding fs.write (in grandparent
  // but NOT child) must be rejected.
  assert.throws(() => s.attenuate(child, ['exec', 'fs.write:/repo']), /escalation/);
  const grandchild = s.attenuate(child, ['exec']);
  assert.deepEqual(s.verify(grandchild)?.caps, ['exec']);
});

test('keyPath: generates and persists a keypair, reloads it for cross-instance verify', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lunaris-cap-'));
  const keyPath = join(dir, 'sub', 'cap.pem');

  const a = new Ed25519CapabilityTokenService({ keyPath });
  const signed = a.mint({ ...base, ttlMs: 60_000 });

  // A second instance loading the SAME key file must verify the token.
  const b = new Ed25519CapabilityTokenService({ keyPath });
  const tok = b.verify(signed);
  assert.ok(tok);
  assert.equal(tok?.runId, 'run1');
});
