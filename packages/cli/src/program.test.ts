import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProgram } from './program.js';

test('lun program wires all Phase 1 subcommands', () => {
  const program = buildProgram();
  assert.equal(program.name(), 'lun');
  const names = program.commands.map((c) => c.name());
  for (const expected of ['init', 'chat', 'status', 'events', 'daemon']) {
    assert.ok(names.includes(expected), `missing subcommand: ${expected}`);
  }
});

test('subcommand options are wired (init --name, chat --model, events --tail, daemon --port)', () => {
  const program = buildProgram();
  const find = (name: string) => {
    const cmd = program.commands.find((c) => c.name() === name);
    assert.ok(cmd, `missing subcommand: ${name}`);
    return cmd;
  };
  assert.ok(find('init').options.some((o) => o.long === '--name'));
  assert.ok(find('chat').options.some((o) => o.long === '--model'));
  const tail = find('events').options.find((o) => o.long === '--tail');
  assert.ok(tail);
  assert.equal(tail.defaultValue, '20');
  assert.ok(find('daemon').options.some((o) => o.long === '--port'));
});

test('chat requires a variadic prompt argument', () => {
  const program = buildProgram();
  const chat = program.commands.find((c) => c.name() === 'chat');
  assert.ok(chat);
  const args = chat.registeredArguments;
  assert.equal(args.length, 1);
  assert.ok(args[0]);
  assert.equal(args[0].required, true);
  assert.equal(args[0].variadic, true);
});
