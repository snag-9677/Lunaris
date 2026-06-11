import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from './passwords.js';

test('hashPassword produces self-describing scrypt format', () => {
  const stored = hashPassword('correct horse battery staple');
  const parts = stored.split('$');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'scrypt');
  assert.equal(parts[1], String(1 << 15));
  assert.match(parts[2] as string, /^[0-9a-f]+$/);
  assert.match(parts[3] as string, /^[0-9a-f]+$/);
});

test('verifyPassword accepts the right password and rejects the wrong one', () => {
  const stored = hashPassword('s3cret-pass');
  assert.equal(verifyPassword('s3cret-pass', stored), true);
  assert.equal(verifyPassword('s3cret-Pass', stored), false);
  assert.equal(verifyPassword('', stored), false);
});

test('distinct hashes for the same password (random salt)', () => {
  const a = hashPassword('same');
  const b = hashPassword('same');
  assert.notEqual(a, b);
  assert.equal(verifyPassword('same', a), true);
  assert.equal(verifyPassword('same', b), true);
});

test('verifyPassword returns false (never throws) on malformed stored strings', () => {
  assert.equal(verifyPassword('x', 'not-a-hash'), false);
  assert.equal(verifyPassword('x', 'scrypt$32768$$'), false);
  assert.equal(verifyPassword('x', 'scrypt$0$aa$bb'), false); // bad N
  assert.equal(verifyPassword('x', 'scrypt$32768$zz$bb'), false); // non-hex salt
  assert.equal(verifyPassword('x', 'bcrypt$10$aa$bb'), false); // wrong algo
});
