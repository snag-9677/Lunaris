import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTriggerStore, payloadToVars, verifyHmac } from './triggers.js';

test('routeEvent matches by source+eventType and enqueues with webhook:<source>', () => {
  const store = new SqliteTriggerStore(':memory:');
  store.create({
    projectId: 'p',
    source: 'github',
    eventTypes: ['push', 'pull_request'],
    promptTemplate: 'Handle {{eventType}} on {{repo.name}}',
  });
  // A rule for a different source must not fire.
  store.create({
    projectId: 'p',
    source: 'generic',
    eventTypes: ['push'],
    promptTemplate: 'other',
  });

  const calls: Array<{ projectId: string; prompt: string; source: string }> = [];
  const matched = store.routeEvent(
    'github',
    'push',
    { repo: { name: 'lunaris' } },
    (projectId, prompt, source) => calls.push({ projectId, prompt, source }),
  );

  assert.equal(matched.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.prompt, 'Handle push on lunaris');
  assert.equal(calls[0]?.source, 'webhook:github');
  assert.equal(calls[0]?.projectId, 'p');
  store.close();
});

test('routeEvent ignores disabled rules and non-matching event types', () => {
  const store = new SqliteTriggerStore(':memory:');
  store.create({
    projectId: 'p',
    source: 'github',
    eventTypes: ['push'],
    promptTemplate: 'x',
    enabled: false,
  });
  store.create({
    projectId: 'p',
    source: 'github',
    eventTypes: ['issues'],
    promptTemplate: 'y',
  });
  const calls: string[] = [];
  const matched = store.routeEvent('github', 'push', {}, (_p, prompt) => calls.push(prompt));
  assert.equal(matched.length, 0);
  assert.equal(calls.length, 0);
  store.close();
});

test('payloadToVars flattens nested objects and arrays with dotted keys', () => {
  const vars = payloadToVars({
    action: 'opened',
    repo: { name: 'lunaris', owner: { login: 'ascalon' } },
    commits: [{ id: 'abc' }],
    nothing: null,
  });
  assert.equal(vars['action'], 'opened');
  assert.equal(vars['repo.name'], 'lunaris');
  assert.equal(vars['repo.owner.login'], 'ascalon');
  assert.equal(vars['commits.0.id'], 'abc');
  assert.equal(vars['nothing'], undefined);
});

test('trigger store CRUD round-trips', () => {
  const store = new SqliteTriggerStore(':memory:');
  const r = store.create({ projectId: 'p', source: 'github', eventTypes: ['push'], promptTemplate: 'a' });
  assert.deepEqual(store.get(r.id)?.eventTypes, ['push']);
  const upd = store.update(r.id, { eventTypes: ['push', 'pull_request'], enabled: false });
  assert.deepEqual(upd?.eventTypes, ['push', 'pull_request']);
  assert.equal(upd?.enabled, false);
  assert.equal(store.list('p', 'github').length, 1);
  assert.equal(store.delete(r.id), true);
  store.close();
});

test('verifyHmac accepts a valid signature (timing-safe) in both header forms', () => {
  const secret = 's3cr3t';
  const body = JSON.stringify({ hello: 'world' });
  const digest = createHmac('sha256', secret).update(body).digest('hex');

  assert.equal(verifyHmac(secret, body, digest), true);
  assert.equal(verifyHmac(secret, body, `sha256=${digest}`), true);
});

test('verifyHmac rejects wrong signature, wrong secret, and malformed headers', () => {
  const secret = 's3cr3t';
  const body = 'payload';
  const good = createHmac('sha256', secret).update(body).digest('hex');

  assert.equal(verifyHmac('wrong', body, good), false);
  assert.equal(verifyHmac(secret, body, good.replace(/.$/, '0')), false);
  assert.equal(verifyHmac(secret, body, 'deadbeef'), false); // length mismatch
  assert.equal(verifyHmac(secret, body, ''), false);
  assert.equal(verifyHmac(secret, body, 'sha256='), false);
});
