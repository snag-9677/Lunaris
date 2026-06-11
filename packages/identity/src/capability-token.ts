/**
 * Ed25519CapabilityTokenService: attenuable agent capability tokens (spec §15).
 *
 * Wire format: base64url(payloadJSON) + "." + base64url(signature)
 *  - payloadJSON is the AgentToken (principalId, projectId, runId, leaseEpoch,
 *    caps, expiresAt).
 *  - signature is an Ed25519 signature over the UTF-8 bytes of the base64url
 *    payload segment (so verification re-encodes the decoded token canonically;
 *    we instead verify over the exact received payload segment to avoid
 *    canonicalization pitfalls).
 *
 * Verification is fully offline against the public key. Tokens expire. The
 * private key never leaves this process and is never logged or embedded in any
 * token. Attenuation can only SHRINK the capability set (strict subset), keeps
 * projectId/runId/leaseEpoch, and never extends expiry — escalation throws.
 */
import { generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import type { AgentToken, CapabilityTokenService } from '@lunaris/core';

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export type Ed25519KeyOptions =
  | { keyPath: string; privateKey?: undefined; publicKey?: undefined }
  | { keyPath?: undefined; privateKey: string | KeyObject; publicKey: string | KeyObject };

function loadOrGenerateKeys(opts: Ed25519KeyOptions): {
  privateKey: KeyObject;
  publicKey: KeyObject;
} {
  if (opts.keyPath !== undefined) {
    const path = opts.keyPath;
    if (existsSync(path)) {
      const pem = readFileSync(path, 'utf8');
      const privateKey = createPrivateKey(pem);
      const publicKey = createPublicKey(privateKey);
      return { privateKey, publicKey };
    }
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    mkdirSync(dirname(path), { recursive: true });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    // Persist private key PEM with restrictive perms (owner read/write only).
    writeFileSync(path, pem, { mode: 0o600 });
    return { privateKey, publicKey };
  }
  const privateKey =
    typeof opts.privateKey === 'string' ? createPrivateKey(opts.privateKey) : opts.privateKey;
  const publicKey =
    typeof opts.publicKey === 'string' ? createPublicKey(opts.publicKey) : opts.publicKey;
  return { privateKey, publicKey };
}

export class Ed25519CapabilityTokenService implements CapabilityTokenService {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(opts: Ed25519KeyOptions) {
    const keys = loadOrGenerateKeys(opts);
    this.privateKey = keys.privateKey;
    this.publicKey = keys.publicKey;
  }

  /** Public key PEM, for distributing to offline verifiers. */
  publicKeyPem(): string {
    return this.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  private signPayloadSegment(payloadSeg: string): string {
    // Ed25519 takes null algorithm; sign over the payload segment bytes.
    const sig = edSign(null, Buffer.from(payloadSeg, 'utf8'), this.privateKey);
    return b64urlEncode(sig);
  }

  mint(t: Omit<AgentToken, 'expiresAt'> & { ttlMs?: number }): string {
    const ttlMs = t.ttlMs ?? DEFAULT_TTL_MS;
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    return this.mintWith({
      principalId: t.principalId,
      projectId: t.projectId,
      runId: t.runId,
      leaseEpoch: t.leaseEpoch,
      caps: [...t.caps],
      expiresAt,
    });
  }

  /** Sign an exact AgentToken (used by mint + attenuate). */
  private mintWith(token: AgentToken): string {
    const payloadSeg = b64urlEncode(Buffer.from(JSON.stringify(token), 'utf8'));
    const sigSeg = this.signPayloadSegment(payloadSeg);
    return `${payloadSeg}.${sigSeg}`;
  }

  verify(signed: string, now?: Date): AgentToken | null {
    const dot = signed.indexOf('.');
    if (dot <= 0 || dot === signed.length - 1) return null;
    const payloadSeg = signed.slice(0, dot);
    const sigSeg = signed.slice(dot + 1);
    if (signed.indexOf('.', dot + 1) !== -1) return null; // exactly one dot

    let sig: Buffer;
    try {
      sig = b64urlDecode(sigSeg);
    } catch {
      return null;
    }
    let valid: boolean;
    try {
      valid = edVerify(null, Buffer.from(payloadSeg, 'utf8'), this.publicKey, sig);
    } catch {
      return null;
    }
    if (!valid) return null;

    let token: AgentToken;
    try {
      token = JSON.parse(b64urlDecode(payloadSeg).toString('utf8')) as AgentToken;
    } catch {
      return null;
    }
    if (!isAgentTokenShape(token)) return null;

    const at = (now ?? new Date()).getTime();
    if (at >= new Date(token.expiresAt).getTime()) return null; // expired
    return token;
  }

  /**
   * Re-sign a STRICT subset of the parent's caps. Throws if:
   *  - the parent does not verify (bad sig / expired), or
   *  - any requested cap is not present in the parent (escalation).
   * The child keeps the parent's principalId/projectId/runId/leaseEpoch and
   * never extends expiry (expiresAt clamped to <= parent's).
   */
  attenuate(signed: string, caps: string[]): string {
    const parent = this.verify(signed);
    if (parent === null) {
      throw new Error('attenuate: parent token invalid or expired');
    }
    const parentCaps = new Set(parent.caps);
    for (const cap of caps) {
      if (!parentCaps.has(cap)) {
        throw new Error(`attenuate: capability escalation rejected ("${cap}" not in parent)`);
      }
    }
    // De-dupe while preserving requested order; result is a subset of parent.
    const child: AgentToken = {
      principalId: parent.principalId,
      projectId: parent.projectId,
      runId: parent.runId,
      leaseEpoch: parent.leaseEpoch,
      caps: [...new Set(caps)],
      expiresAt: parent.expiresAt, // never extends; inherits parent expiry
    };
    return this.mintWith(child);
  }
}

function isAgentTokenShape(t: unknown): t is AgentToken {
  if (typeof t !== 'object' || t === null) return false;
  const o = t as Record<string, unknown>;
  return (
    typeof o.principalId === 'string' &&
    typeof o.projectId === 'string' &&
    typeof o.runId === 'string' &&
    typeof o.leaseEpoch === 'number' &&
    Array.isArray(o.caps) &&
    o.caps.every((c) => typeof c === 'string') &&
    typeof o.expiresAt === 'string'
  );
}

/** Helper: true iff a verified token grants `requiredCap`. */
export function capsSatisfy(token: AgentToken, requiredCap: string): boolean {
  return token.caps.includes(requiredCap);
}
