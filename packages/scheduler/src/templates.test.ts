import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTemplateStore, renderTemplate } from './templates.js';

test('renderTemplate fills known placeholders and tolerates whitespace', () => {
  const out = renderTemplate('Hello {{name}}, you owe {{ amount }}.', {
    name: 'Ada',
    amount: '42',
  });
  assert.equal(out, 'Hello Ada, you owe 42.');
});

test('renderTemplate leaves unknown placeholders intact', () => {
  const out = renderTemplate('{{known}} and {{missing}}', { known: 'yes' });
  assert.equal(out, 'yes and {{missing}}');
});

test('renderTemplate handles dotted keys', () => {
  const out = renderTemplate('repo={{repo.name}}', { 'repo.name': 'lunaris' });
  assert.equal(out, 'repo=lunaris');
});

test('template store CRUD round-trips', () => {
  const store = new SqliteTemplateStore(':memory:');
  const created = store.create({ name: 'daily', promptTemplate: 'Summarize {{date}}' });
  assert.equal(store.get(created.id)?.name, 'daily');

  const updated = store.update(created.id, { promptTemplate: 'Recap {{date}}' });
  assert.equal(updated?.promptTemplate, 'Recap {{date}}');
  assert.equal(updated?.name, 'daily'); // unchanged field preserved

  assert.equal(store.list().length, 1);
  assert.equal(store.delete(created.id), true);
  assert.equal(store.get(created.id), undefined);
  assert.equal(store.delete('nope'), false);
  store.close();
});

test('update of unknown template returns undefined', () => {
  const store = new SqliteTemplateStore(':memory:');
  assert.equal(store.update('missing', { name: 'x' }), undefined);
  store.close();
});
