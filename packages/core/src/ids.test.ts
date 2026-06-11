import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newCallId, newGoalId, uuidv7 } from './ids.js';

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('uuidv7 produces RFC 9562 v7 ids whose timestamp matches now', () => {
  const before = Date.now();
  const id = uuidv7();
  const after = Date.now();
  assert.match(id, UUID_V7_RE);

  const tsMs = parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
  assert.ok(tsMs >= before && tsMs <= after + 1, 'embedded timestamp is current');
});

test('uuidv7 ids are unique and strictly increasing within the process', () => {
  const ids = Array.from({ length: 5000 }, () => uuidv7());
  assert.equal(new Set(ids).size, ids.length, 'all unique');
  for (let i = 1; i < ids.length; i++) {
    assert.ok(ids[i]! > ids[i - 1]!, `ids[${i}] sorts after ids[${i - 1}]`);
  }
});

test('newCallId and newGoalId return valid v7 ids', () => {
  assert.match(newCallId(), UUID_V7_RE);
  assert.match(newGoalId(), UUID_V7_RE);
});
