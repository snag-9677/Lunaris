/**
 * Password hashing/verification with node:crypto scrypt — no native deps.
 *
 * Stored format: "scrypt$<N>$<saltHex>$<hashHex>"
 *  - N is the scrypt cost parameter (work factor); r/keylen are fixed below so
 *    the stored string is self-describing for the parts that may evolve.
 *  - Verification is constant-time via crypto.timingSafeEqual to avoid leaking
 *    hash-match progress through timing.
 *
 * scryptSync is used (not the async callback form) so the IdentityStore can
 * implement the synchronous createUser/authenticate contract in core/types.ts.
 * scrypt is intentionally CPU-bound; at the interactive cost below a single
 * derivation is ~tens of ms, acceptable for a local control plane.
 *
 * No secret material (passwords, raw salts) is ever logged.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** scrypt cost. 2^15 = 32768 — interactive-login appropriate. */
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

// scrypt's default maxmem (32MB) is too small for N=32768,r=8 (~128*N*r bytes
// plus overhead), so raise it explicitly.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function deriveKey(password: string, salt: Buffer, n: number): Buffer {
  return scryptSync(password, salt, KEY_LEN, {
    N: n,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
}

/** Hash a plaintext password into the self-describing stored format. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN);
  const key = deriveKey(password, salt, SCRYPT_N);
  return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/**
 * Verify a plaintext password against a stored "scrypt$N$salt$hash" string.
 * Returns false (never throws) on any malformed input. Comparison is
 * constant-time over the derived key bytes.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const n = Number.parseInt(parts[1] ?? '', 10);
  if (!Number.isInteger(n) || n <= 1 || (n & (n - 1)) !== 0) return false;

  const saltHex = parts[2] ?? '';
  const hashHex = parts[3] ?? '';
  if (saltHex.length === 0 || hashHex.length === 0) return false;
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return false;

  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');

  let derived: Buffer;
  try {
    derived = deriveKey(password, salt, n);
  } catch {
    return false;
  }
  // Lengths must match before timingSafeEqual (it throws on length mismatch).
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
