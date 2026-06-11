import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteMemoryStore, extractEntities } from './store.js';
import type { EmbedFn } from './store.js';

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

test('retention gate accepts a novel useful statement and records scores + id', () => {
  const store = new SqliteMemoryStore({ dbPath: ':memory:', projectId: 'p1' });
  const d = store.propose({
    type: 'procedural',
    statement: 'Always run the BuildPipeline with pnpm build before invoking the smoke test harness.',
    entities: ['BuildPipeline'],
  });
  assert.equal(d.accepted, true, d.reason);
  assert.ok(d.recordId);
  assert.ok(d.scores.novelty >= 0.15);
  assert.ok(d.scores.utility > 0);
  assert.ok(d.scores.generality >= 0);

  const all = store.search('BuildPipeline pnpm build', 8);
  assert.equal(all.length, 1);
  assert.equal(all[0]?.strength, 1.0);
  store.close();
});

test('near-duplicate proposal is rejected and reinforces the original', () => {
  const store = new SqliteMemoryStore({ dbPath: ':memory:', projectId: 'p1' });
  const first = store.propose({
    type: 'semantic',
    statement: 'The Gateway adapter normalizes provider streaming events into UnifiedEvent objects.',
    entities: ['Gateway'],
  });
  assert.equal(first.accepted, true);
  // Weaken it first so the reinforcement from a duplicate has headroom under the
  // strength cap of 1.0 (a fresh record is already at 1.0).
  assert.ok(first.recordId);
  if (first.recordId) store.reinforce(first.recordId, false); // strength 1.0 -> 0.7
  const before = store.search('Gateway adapter normalizes streaming', 1)[0];
  assert.ok(before);
  assert.ok((before.strength ?? 1) < 1);

  // Same idea, slightly reworded => should be detected as a duplicate.
  const dup = store.propose({
    type: 'semantic',
    statement: 'The Gateway adapter normalizes provider streaming events into UnifiedEvent objects today.',
    entities: ['Gateway'],
  });
  assert.equal(dup.accepted, false);
  assert.equal(dup.reason, 'duplicate-reinforced');
  assert.equal(dup.recordId, first.recordId);

  // Only one record exists, and its strength was bumped by reinforcement.
  const after = store.search('Gateway adapter normalizes streaming', 8);
  assert.equal(after.length, 1);
  assert.ok((after[0]?.strength ?? 0) > (before.strength ?? 0));
  store.close();
});

test('low-utility one-off specific is rejected by the retention gate', () => {
  const store = new SqliteMemoryStore({ dbPath: ':memory:', projectId: 'p1' });
  const d = store.propose({
    type: 'episodic',
    statement: 'ok 123456 /tmp/x',
    entities: [],
  });
  assert.equal(d.accepted, false);
  assert.match(d.reason, /below-threshold|low-novelty|low-quality/);
  store.close();
});

test('FIX 6: an empty / no-token statement is rejected up front', () => {
  const store = new SqliteMemoryStore({ dbPath: ':memory:', projectId: 'p1' });
  for (const statement of ['', '   ', '\n\t ', '!!! ... ???', 'the an of to']) {
    const d = store.propose({ type: 'semantic', statement, entities: [] });
    assert.equal(d.accepted, false, `"${statement}" must be rejected`);
    assert.equal(d.reason, 'empty-statement', `"${statement}" reason should be empty-statement`);
    assert.deepEqual(d.scores, { novelty: 0, utility: 0, generality: 0 });
  }
  // The store stayed empty (no junk inserted).
  assert.deepEqual(store.search('', 8), []);
  store.close();
});

test('search ranks by similarity * strength', () => {
  const store = new SqliteMemoryStore({ dbPath: ':memory:', projectId: 'p1' });
  const a = store.propose({
    type: 'semantic',
    statement: 'The Orchestrator loop drives subagent task iterations until a ResultEnvelope is produced.',
    entities: ['Orchestrator'],
  });
  store.propose({
    type: 'semantic',
    statement: 'The Memory store keeps advisory graph records about each project for retrieval.',
    entities: ['Memory'],
  });
  assert.ok(a.accepted);

  const hits = store.search('orchestrator subagent task loop iterations', 8);
  assert.ok(hits.length >= 1);
  assert.match(hits[0]?.statement ?? '', /Orchestrator/);

  // Weaken the top hit; a different query should now favour the other record.
  if (a.recordId) {
    store.reinforce(a.recordId, false);
    store.reinforce(a.recordId, false);
    store.reinforce(a.recordId, false);
  }
  const hits2 = store.search('memory advisory graph project records', 8);
  assert.match(hits2[0]?.statement ?? '', /Memory store/);
  store.close();
});

test('FIX 3: empty/whitespace query returns strongest records (browse mode)', () => {
  const store = new SqliteMemoryStore({ dbPath: ':memory:', projectId: 'p1' });
  const weak = store.propose({
    type: 'semantic',
    statement: 'The Gateway adapter normalizes provider streaming events into UnifiedEvent objects.',
    entities: ['Gateway'],
  });
  store.propose({
    type: 'procedural',
    statement: 'Always run the BuildPipeline with pnpm build before invoking the smoke test harness.',
    entities: ['BuildPipeline'],
  });
  store.propose({
    type: 'semantic',
    statement: 'The Orchestrator loop drives subagent task iterations until a ResultEnvelope is produced.',
    entities: ['Orchestrator'],
  });
  assert.ok(weak.recordId);
  // Weaken one record so ordering by strength is observable.
  if (weak.recordId) store.reinforce(weak.recordId, false); // 1.0 -> 0.7

  // Empty and whitespace queries both browse the store by strength.
  for (const q of ['', '   ', '\t']) {
    const recs = store.search(q, 8);
    assert.equal(recs.length, 3, `query ${JSON.stringify(q)} should return all records`);
    // Strongest-first: the weakened record must not be on top.
    assert.notEqual(recs[0]?.id, weak.recordId, 'weakened record should not lead the browse list');
    // Strength is monotonically non-increasing.
    for (let i = 1; i < recs.length; i++) {
      assert.ok((recs[i - 1]?.strength ?? 0) >= (recs[i]?.strength ?? 0), 'ordered by strength DESC');
    }
  }
  // Limit is respected.
  assert.equal(store.search('', 2).length, 2);
  store.close();
});

test('FIX 3: empty query on an empty store returns []', () => {
  const store = new SqliteMemoryStore({ dbPath: ':memory:', projectId: 'p1' });
  assert.deepEqual(store.search('', 8), []);
  store.close();
});

test('brief respects budget, includes guide header, type groups, age + untrusted markers', () => {
  const clock = fixedClock('2026-06-11T00:00:00.000Z');
  const store = new SqliteMemoryStore({ dbPath: ':memory:', projectId: 'p1', now: clock });

  store.propose({
    type: 'semantic',
    statement: 'The DaemonService exposes a local HTTP control plane on port 7777.',
    entities: ['DaemonService'],
  });
  store.propose({
    type: 'procedural',
    statement: 'Always configure the PolicyEngine autonomy level before enabling autonomous task runs.',
    entities: ['PolicyEngine'],
  });
  // A tainted episodic record from untrusted web content.
  store.propose({
    type: 'episodic',
    statement: 'The WebFetch ingestion failed with a timeout error against the ExampleHost endpoint.',
    entities: ['WebFetch', 'ExampleHost'],
    tainted: true,
  });

  const brief = store.brief('PolicyEngine autonomy DaemonService WebFetch', 1500);
  assert.match(brief.text, /^Advisory memory — verify before relying; may be stale\/wrong:/);
  assert.match(brief.text, /Facts:/);
  assert.match(brief.text, /How-to:/);
  assert.match(brief.text, /Past episodes:/);
  assert.match(brief.text, /\(untrusted-source\)/);
  assert.match(brief.text, /\[conf 0\.\d{2}, age \d+d\]/);
  assert.ok(brief.recordIds.length >= 1);

  // Budget enforcement: a tiny budget yields only the header (no lines fit).
  const tiny = store.brief('PolicyEngine autonomy', 60);
  assert.ok(tiny.text.length <= 60 + 80, 'tiny brief stays near budget');
  assert.equal(tiny.recordIds.length, 0);
  store.close();
});

test('decay + prune deletes weak records using injected now', () => {
  const createClock = fixedClock('2026-01-01T00:00:00.000Z');
  const store = new SqliteMemoryStore({
    dbPath: ':memory:',
    projectId: 'p1',
    now: createClock,
    halfLifeDays: 30,
  });
  const d = store.propose({
    type: 'semantic',
    statement: 'The Lunaris harness coordinates multiple autonomous coding agents per project.',
    entities: ['Lunaris'],
  });
  assert.ok(d.accepted);

  // Prune far in the future (~10 half-lives) => strength decays well below 0.05.
  const pruned = store.prune(new Date('2026-11-01T00:00:00.000Z'));
  assert.equal(pruned, 1);
  assert.equal(store.search('Lunaris harness agents', 8).length, 0);
  store.close();
});

test('decay reduces but keeps a recent strong record', () => {
  const createClock = fixedClock('2026-06-01T00:00:00.000Z');
  const store = new SqliteMemoryStore({ dbPath: ':memory:', projectId: 'p1', now: createClock });
  store.propose({
    type: 'procedural',
    statement: 'Prefer the MockAdapter when running offline tests against the Gateway.',
    entities: ['MockAdapter', 'Gateway'],
  });
  // One half-life later: strength ~0.5, still above the 0.05 prune floor.
  const pruned = store.prune(new Date('2026-07-01T00:00:00.000Z'));
  assert.equal(pruned, 0);
  const recs = store.search('MockAdapter Gateway offline tests', 8);
  assert.equal(recs.length, 1);
  assert.ok((recs[0]?.strength ?? 1) < 1 && (recs[0]?.strength ?? 0) > 0.05);
  store.close();
});

test('offline lexical-similarity path works with no embed fn (default)', () => {
  const store = new SqliteMemoryStore({ dbPath: ':memory:', projectId: 'p1' });
  store.propose({
    type: 'semantic',
    statement: 'The ProviderAdapter streams completions as UnifiedEvent records.',
    entities: ['ProviderAdapter'],
  });
  // Lexically related query retrieves it; an unrelated query does not.
  assert.equal(store.search('ProviderAdapter streams UnifiedEvent', 8).length, 1);
  assert.equal(store.search('completely unrelated kitchen recipe banana', 8).length, 0);
  store.close();
});

test('embedding path is used when embeddings are warmed', async () => {
  // Deterministic 2-d "embedding": maps any text containing 'cat' near one axis.
  const embed: EmbedFn = async (text: string) => {
    const t = text.toLowerCase();
    return [t.includes('cat') ? 1 : 0, t.includes('dog') ? 1 : 0, 0.001];
  };
  const store = new SqliteMemoryStore({ dbPath: ':memory:', projectId: 'p1', embed });
  store.propose({ type: 'semantic', statement: 'The Felidae taxonomy entry concerns cats.', entities: ['Felidae'] });
  store.propose({ type: 'semantic', statement: 'The Canidae taxonomy entry concerns dogs.', entities: ['Canidae'] });

  await store.warm([
    'a query about cat behaviour',
    'The Felidae taxonomy entry concerns cats.',
    'The Canidae taxonomy entry concerns dogs.',
  ]);
  const hits = store.search('a query about cat behaviour', 8);
  assert.match(hits[0]?.statement ?? '', /Felidae/);
  store.close();
});

test('entities/relations are extracted and clustered into communities', () => {
  const store = new SqliteMemoryStore({ dbPath: ':memory:', projectId: 'p1' });
  store.propose({
    type: 'semantic',
    statement: 'The Gateway calls the AnthropicAdapter and the OpenAIAdapter to stream tokens.',
    entities: ['Gateway', 'AnthropicAdapter', 'OpenAIAdapter'],
  });
  store.propose({
    type: 'semantic',
    statement: 'The Orchestrator schedules the Daemon to persist EventStore envelopes.',
    entities: ['Orchestrator', 'Daemon', 'EventStore'],
  });

  const ents = store.entities();
  const names = ents.map((e) => e.name);
  assert.ok(names.includes('Gateway'));
  assert.ok(names.includes('AnthropicAdapter'));
  // Every entity got a community id assigned by recluster().
  assert.ok(ents.every((e) => typeof e.communityId === 'number'));

  // Co-occurring entities in the same record share a community.
  const byName = new Map(ents.map((e) => [e.name, e.communityId]));
  assert.equal(byName.get('Gateway'), byName.get('AnthropicAdapter'));
  assert.notEqual(byName.get('Gateway'), byName.get('Orchestrator'));

  const rels = store.relations();
  assert.ok(rels.some((r) => r.rel === 'co-occurs'));
  store.close();
});

test('extractEntities finds proper nouns, identifiers, and calls', () => {
  const got = extractEntities('Call buildGraph() on the Foo.bar config via the OrchestratorLoop', ['Manual']);
  assert.ok(got.includes('Manual'));
  assert.ok(got.includes('Foo.bar'));
  assert.ok(got.includes('OrchestratorLoop'));
  assert.ok(got.includes('buildGraph'));
});
