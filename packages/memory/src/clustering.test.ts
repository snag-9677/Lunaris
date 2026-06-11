import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectCommunities } from './clustering.js';

test('two disconnected triangles form two communities', () => {
  const nodes = ['a', 'b', 'c', 'x', 'y', 'z'];
  const edges = [
    { a: 'a', b: 'b', weight: 1 },
    { a: 'b', b: 'c', weight: 1 },
    { a: 'a', b: 'c', weight: 1 },
    { a: 'x', b: 'y', weight: 1 },
    { a: 'y', b: 'z', weight: 1 },
    { a: 'x', b: 'z', weight: 1 },
  ];
  const m = detectCommunities(nodes, edges);
  assert.equal(m.get('a'), m.get('b'));
  assert.equal(m.get('b'), m.get('c'));
  assert.equal(m.get('x'), m.get('y'));
  assert.notEqual(m.get('a'), m.get('x'));
});

test('isolated node gets its own community; result is deterministic', () => {
  const nodes = ['a', 'b', 'lonely'];
  const edges = [{ a: 'a', b: 'b', weight: 2 }];
  const m1 = detectCommunities(nodes, edges);
  const m2 = detectCommunities(nodes, edges);
  assert.deepEqual([...m1.entries()], [...m2.entries()]);
  assert.equal(m1.get('a'), m1.get('b'));
  assert.notEqual(m1.get('lonely'), m1.get('a'));
});

test('empty graph yields empty map', () => {
  assert.equal(detectCommunities([], []).size, 0);
});

test('community ids are dense 0-based', () => {
  const m = detectCommunities(['a', 'b', 'c'], [{ a: 'a', b: 'b', weight: 1 }]);
  const ids = new Set(m.values());
  const sorted = [...ids].sort((x, y) => x - y);
  assert.deepEqual(sorted, [0, 1]);
});
