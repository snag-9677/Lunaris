import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolCallCtx } from '@lunaris/core';
import { RulePolicyEngine, globMatch, isIrreversible, splitBashSegments } from './policy.js';

const clean: ToolCallCtx = { projectId: 'p1', taskId: 't1', tainted: false };
const dirty: ToolCallCtx = { projectId: 'p1', taskId: 't1', tainted: true };

test('glob matcher: ** crosses separators, * does not', () => {
  assert.equal(globMatch('src/*.ts', 'src/a.ts'), true);
  assert.equal(globMatch('src/*.ts', 'src/nested/a.ts'), false, '* must not cross /');
  assert.equal(globMatch('src/**', 'src/nested/a.ts'), true, '** crosses /');
  assert.equal(globMatch('git push*', 'git push origin main'), true);
  assert.equal(globMatch('api.github.com', 'api.github.com'), true);
  assert.equal(globMatch('*.github.com', 'api.github.com'), true);
  assert.equal(globMatch('read_*', 'read_file'), true);
  assert.equal(globMatch('read_*', 'write_file'), false);
});

test('L0 read-only: allows reads/fetch, denies writes and bash', () => {
  const e = new RulePolicyEngine({ level: 0 });
  assert.equal(e.evaluate('read_file', { path: 'a.ts' }, clean).effect, 'allow');
  assert.equal(e.evaluate('list_dir', { path: '.' }, clean).effect, 'allow');
  assert.equal(e.evaluate('web_fetch', { url: 'https://x.dev/' }, clean).effect, 'allow');
  assert.equal(e.evaluate('write_file', { path: 'a.ts' }, clean).effect, 'deny');
  assert.equal(e.evaluate('run_bash', { command: 'ls' }, clean).effect, 'deny');
});

test('L1 supervised: writes and bash are queued', () => {
  const e = new RulePolicyEngine({ level: 1 });
  assert.equal(e.evaluate('write_file', { path: 'a.ts' }, clean).effect, 'queue');
  assert.equal(e.evaluate('run_bash', { command: 'ls' }, clean).effect, 'queue');
  assert.equal(e.evaluate('read_file', { path: 'a.ts' }, clean).effect, 'allow');
});

test('L2 workspace: file/bash allowed, irreversible still queued', () => {
  const e = new RulePolicyEngine({ level: 2 });
  assert.equal(e.evaluate('write_file', { path: 'a.ts' }, clean).effect, 'allow');
  assert.equal(e.evaluate('run_bash', { command: 'npm test' }, clean).effect, 'allow');
  assert.equal(e.evaluate('web_fetch', { url: 'https://x.dev/' }, clean).effect, 'allow');
  assert.equal(
    e.evaluate('run_bash', { command: 'git push origin main' }, clean).effect,
    'queue',
    'irreversible queues even at L2',
  );
});

test('L3 full-auto: allows bash but irreversible class always queues', () => {
  const e = new RulePolicyEngine({ level: 3 });
  assert.equal(e.evaluate('run_bash', { command: 'rm -rf node_modules' }, clean).effect, 'allow');
  assert.equal(e.evaluate('write_file', { path: 'a.ts' }, clean).effect, 'allow');
  assert.equal(e.evaluate('run_bash', { command: 'git push origin main' }, clean).effect, 'queue');
  assert.equal(e.evaluate('run_bash', { command: 'npm publish' }, clean).effect, 'queue');
  assert.equal(e.evaluate('deploy_service', {}, clean).effect, 'queue');
});

test('irreversible matcher: classifies the dangerous class', () => {
  assert.equal(isIrreversible('run_bash', { command: 'git push origin main' }, []), true);
  assert.equal(isIrreversible('run_bash', { command: 'npm publish' }, []), true);
  assert.equal(isIrreversible('run_bash', { command: 'kubectl apply -f x.yaml' }, []), true);
  assert.equal(isIrreversible('run_bash', { command: 'terraform apply' }, []), true);
  assert.equal(isIrreversible('run_bash', { command: 'rm -rf /etc/passwd' }, []), true);
  assert.equal(
    isIrreversible('run_bash', { command: 'rm -rf node_modules' }, []),
    false,
    'rm -rf inside workspace is not irreversible-class',
  );
  // non-GET web_fetch to a non-allowlisted host
  assert.equal(
    isIrreversible('web_fetch', { url: 'https://evil.dev/x', method: 'POST' }, ['api.github.com']),
    true,
  );
  assert.equal(
    isIrreversible('web_fetch', { url: 'https://api.github.com/x', method: 'POST' }, [
      'api.github.com',
    ]),
    false,
    'POST to allowlisted host is fine',
  );
  assert.equal(isIrreversible('web_fetch', { url: 'https://evil.dev/x' }, []), false, 'GET ok');
  assert.equal(isIrreversible('write_file', { path: 'a.ts' }, []), false);
});

test('explicit allow rule precedes the level default', () => {
  // L0 would deny run_bash, but an explicit allow rule for a safe command wins.
  const e = new RulePolicyEngine({
    level: 0,
    rules: [
      { effect: 'allow', tools: ['run_bash'], commands: ['ls*'], reason: 'safe listing' },
    ],
  });
  const d = e.evaluate('run_bash', { command: 'ls -la' }, clean);
  assert.equal(d.effect, 'allow');
  assert.equal(d.ruleIndex, 0);
  assert.equal(d.reason, 'safe listing');
  // A bash command not matching the rule falls through to the L0 default (deny).
  assert.equal(e.evaluate('run_bash', { command: 'cat x' }, clean).effect, 'deny');
});

test('explicit allow rule overrides the irreversible-class overlay', () => {
  const e = new RulePolicyEngine({
    level: 2,
    rules: [{ effect: 'allow', tools: ['run_bash'], commands: ['git push*'] }],
  });
  assert.equal(
    e.evaluate('run_bash', { command: 'git push origin main' }, clean).effect,
    'allow',
    'explicit allow precedes the irreversible queue',
  );
});

// ---------------- FIX 1: allow rules cannot blanket-bypass the irreversible overlay ----------------

test('FIX 1: a broad git* allow rule still queues git push', () => {
  // An allow rule meant for `git status` (git*) must NOT auto-allow `git push`.
  const e = new RulePolicyEngine({
    level: 2,
    rules: [{ effect: 'allow', tools: ['run_bash'], commands: ['git*'], reason: 'git is fine' }],
  });
  // The benign sibling the rule was written for is still allowed.
  assert.equal(e.evaluate('run_bash', { command: 'git status' }, clean).effect, 'allow');
  // But the irreversible action is downgraded to queue despite the matching allow.
  const push = e.evaluate('run_bash', { command: 'git push origin main' }, clean);
  assert.equal(push.effect, 'queue', 'broad git* allow must not override the irreversible overlay');
  assert.match(push.reason, /too broad|irreversible/);
});

test('FIX 1: a broad * allow rule still queues irreversible actions', () => {
  const e = new RulePolicyEngine({
    level: 3,
    rules: [{ effect: 'allow', tools: ['run_bash'], commands: ['*'], reason: 'allow all bash' }],
  });
  assert.equal(e.evaluate('run_bash', { command: 'npm test' }, clean).effect, 'allow');
  assert.equal(e.evaluate('run_bash', { command: 'git push origin main' }, clean).effect, 'queue');
});

test('FIX 1: a narrow `git push*` allow rule does override the overlay', () => {
  const e = new RulePolicyEngine({
    level: 2,
    rules: [{ effect: 'allow', tools: ['run_bash'], commands: ['git push*'], reason: 'CI may push' }],
  });
  const d = e.evaluate('run_bash', { command: 'git push origin main' }, clean);
  assert.equal(d.effect, 'allow', 'a narrow allow that names the irreversible verb wins');
  assert.equal(d.ruleIndex, 0);
});

test('FIX 1: a tool-only allow rule (no command globs) does not override the overlay', () => {
  const e = new RulePolicyEngine({
    level: 3,
    rules: [{ effect: 'allow', tools: ['run_bash'], reason: 'all bash' }],
  });
  assert.equal(e.evaluate('run_bash', { command: 'npm test' }, clean).effect, 'allow');
  assert.equal(e.evaluate('run_bash', { command: 'git push' }, clean).effect, 'queue');
});

test('FIX 1: deploy / publish / kubectl apply still queue at L3 under a broad allow', () => {
  const e = new RulePolicyEngine({
    level: 3,
    rules: [{ effect: 'allow', tools: ['run_bash'], commands: ['*'], reason: 'allow all' }],
  });
  assert.equal(e.evaluate('run_bash', { command: 'npm publish' }, clean).effect, 'queue');
  assert.equal(e.evaluate('run_bash', { command: 'kubectl apply -f x.yaml' }, clean).effect, 'queue');
  assert.equal(e.evaluate('run_bash', { command: 'terraform apply' }, clean).effect, 'queue');
  assert.equal(e.evaluate('run_bash', { command: './scripts/deploy.sh' }, clean).effect, 'queue');
});

test('FIX 1: a narrow publish allow rule overrides for that verb only', () => {
  const e = new RulePolicyEngine({
    level: 2,
    rules: [{ effect: 'allow', tools: ['run_bash'], commands: ['npm publish*'] }],
  });
  assert.equal(e.evaluate('run_bash', { command: 'npm publish --access public' }, clean).effect, 'allow');
});

// ---------------- FIX 2: chained-command holes + broadened rm detection ----------------

test('FIX 2: splitBashSegments splits on shell separators', () => {
  assert.deepEqual(splitBashSegments('ls; git push'), ['ls', 'git push']);
  assert.deepEqual(splitBashSegments('npm run build && git push'), ['npm run build', 'git push']);
  assert.deepEqual(splitBashSegments('cat x | grep y'), ['cat x', 'grep y']);
  assert.deepEqual(splitBashSegments('a || b'), ['a', 'b']);
  assert.deepEqual(splitBashSegments('a\nb'), ['a', 'b']);
});

test('FIX 2: `ls; git push` queues despite an `ls*` allow rule', () => {
  const e = new RulePolicyEngine({
    level: 2,
    rules: [{ effect: 'allow', tools: ['run_bash'], commands: ['ls*'], reason: 'listing ok' }],
  });
  // The benign segment alone is still allowed by the rule.
  assert.equal(e.evaluate('run_bash', { command: 'ls -la' }, clean).effect, 'allow');
  // A chained irreversible segment is caught: the `ls*` rule no longer matches
  // (git push is not covered), and the irreversible overlay queues it.
  assert.equal(
    e.evaluate('run_bash', { command: 'ls; git push' }, clean).effect,
    'queue',
    'chained git push must not slip past an ls* allow rule',
  );
});

test('FIX 2: chained-command irreversibility via isIrreversible', () => {
  assert.equal(isIrreversible('run_bash', { command: 'ls; git push' }, []), true);
  assert.equal(isIrreversible('run_bash', { command: 'npm run build && git push' }, []), true);
  assert.equal(isIrreversible('run_bash', { command: 'echo hi | cat' }, []), false);
});

test('FIX 2: `git -C path push` is irreversible', () => {
  assert.equal(isIrreversible('run_bash', { command: 'git -C /repo push' }, []), true);
  assert.equal(isIrreversible('run_bash', { command: 'git --no-pager push origin main' }, []), true);
  // a narrow allow rule still must explicitly name the verb to override
  const e = new RulePolicyEngine({
    level: 2,
    rules: [{ effect: 'allow', tools: ['run_bash'], commands: ['git*'] }],
  });
  assert.equal(e.evaluate('run_bash', { command: 'git -C /repo push' }, clean).effect, 'queue');
});

test('FIX 2: broadened rm detection (long flags, combined flags, $VAR, ~)', () => {
  // long flags
  assert.equal(isIrreversible('run_bash', { command: 'rm --recursive --force /tmp/x' }, []), true);
  // $VAR target is unvettable -> conservative irreversible
  assert.equal(isIrreversible('run_bash', { command: 'rm -rf $HOME' }, []), true);
  // ~ home
  assert.equal(isIrreversible('run_bash', { command: 'rm -rf ~/Documents' }, []), true);
  // absolute
  assert.equal(isIrreversible('run_bash', { command: 'rm -fr /etc/passwd' }, []), true);
  // -R + --force combo
  assert.equal(isIrreversible('run_bash', { command: 'rm -R --force /var/data' }, []), true);
  // parent escape
  assert.equal(isIrreversible('run_bash', { command: 'rm -rf ../sibling' }, []), true);
  // rm with no parseable target -> conservative
  assert.equal(isIrreversible('run_bash', { command: 'rm -rf' }, []), true);
  // in-root relative target with both flags is NOT irreversible-class
  assert.equal(
    isIrreversible('run_bash', { command: 'rm --recursive --force node_modules' }, []),
    false,
    'in-root relative rm -rf is not irreversible-class',
  );
  assert.equal(isIrreversible('run_bash', { command: 'rm -rf build/cache' }, []), false);
  // rm without BOTH recursive and force is not matched as rm-rf-class
  assert.equal(isIrreversible('run_bash', { command: 'rm -f /tmp/x' }, []), false, 'force-only is not recursive');
});

test('FIX 2: a chained rm-rf $VAR queues even with a benign-prefixed allow rule', () => {
  const e = new RulePolicyEngine({
    level: 3,
    rules: [{ effect: 'allow', tools: ['run_bash'], commands: ['*'] }],
  });
  assert.equal(e.evaluate('run_bash', { command: 'echo start && rm -rf $HOME' }, clean).effect, 'queue');
});

test('rule predicates: path and domain globs gate matching', () => {
  const e = new RulePolicyEngine({
    level: 2,
    rules: [
      { effect: 'deny', tools: ['write_file'], paths: ['secrets/**'], reason: 'no secrets' },
      { effect: 'deny', tools: ['web_fetch'], domains: ['*.internal'], reason: 'no internal' },
    ],
  });
  assert.equal(e.evaluate('write_file', { path: 'secrets/x.txt' }, clean).effect, 'deny');
  assert.equal(e.evaluate('write_file', { path: 'src/x.ts' }, clean).effect, 'allow');
  assert.equal(e.evaluate('web_fetch', { url: 'https://db.internal/x' }, clean).effect, 'deny');
  assert.equal(e.evaluate('web_fetch', { url: 'https://example.com/x' }, clean).effect, 'allow');
});

test('taint overlay: allow→queue for bash/network, secret tools denied', () => {
  const e = new RulePolicyEngine({ level: 2 });
  // L2 would allow bash/fetch when clean; taint tightens to queue.
  assert.equal(e.evaluate('run_bash', { command: 'npm test' }, clean).effect, 'allow');
  assert.equal(e.evaluate('run_bash', { command: 'npm test' }, dirty).effect, 'queue');
  assert.equal(e.evaluate('web_fetch', { url: 'https://x.dev/' }, dirty).effect, 'queue');
  // File writes are not network/bash → not tightened by the overlay.
  assert.equal(e.evaluate('write_file', { path: 'a.ts' }, dirty).effect, 'allow');
  // Secret tools denied under taint.
  assert.equal(e.evaluate('read_secret', { path: 'k' }, dirty).effect, 'deny');
  // ...but allowed (by level default) when not tainted is not asserted here;
  // secret tools have no special clean-path handling beyond the level default.
});

test('FIX 5: taint overlay denies secret-adjacent tool names by pattern', () => {
  const e = new RulePolicyEngine({ level: 3 });
  // Hardcoded list still denied.
  assert.equal(e.evaluate('read_secret', {}, dirty).effect, 'deny');
  // Pattern-matched secret-adjacent names denied under taint.
  assert.equal(e.evaluate('fetch_api_token', {}, dirty).effect, 'deny');
  assert.equal(e.evaluate('aws_credentials', {}, dirty).effect, 'deny');
  // `vault` matches the word-boundary pattern (\bvault\b).
  assert.equal(e.evaluate('vault', {}, dirty).effect, 'deny');
  assert.equal(e.evaluate('vault-read', {}, dirty).effect, 'deny');
  assert.equal(e.evaluate('print_secret_value', {}, dirty).effect, 'deny');
  // An unrelated tool name is NOT swept up by the pattern.
  assert.equal(e.evaluate('list_dir', { path: '.' }, dirty).effect, 'allow');
  // When NOT tainted, the secret-adjacent name is governed by the level default only.
  assert.notEqual(e.evaluate('fetch_api_token', {}, clean).effect, 'deny');
});

test('FIX 5: a secret-adjacent tool is denied under taint even with an explicit allow rule', () => {
  const e = new RulePolicyEngine({
    level: 3,
    rules: [{ effect: 'allow', tools: ['*'], reason: 'allow everything' }],
  });
  assert.equal(e.evaluate('read_credential_store', {}, dirty).effect, 'deny');
});

test('taint overlay: explicit allow on tainted bash is still tightened', () => {
  const e = new RulePolicyEngine({
    level: 2,
    rules: [{ effect: 'allow', tools: ['run_bash'], commands: ['npm*'] }],
  });
  assert.equal(e.evaluate('run_bash', { command: 'npm test' }, clean).effect, 'allow');
  assert.equal(
    e.evaluate('run_bash', { command: 'npm test' }, dirty).effect,
    'queue',
    'tainted bash queued even with explicit allow',
  );
});

test('tightenWhenTainted=false disables the taint overlay', () => {
  const e = new RulePolicyEngine({ level: 2, tightenWhenTainted: false });
  assert.equal(e.evaluate('run_bash', { command: 'npm test' }, dirty).effect, 'allow');
});

test('whenTainted rule only matches in the matching taint state', () => {
  const e = new RulePolicyEngine({
    level: 2,
    rules: [
      { effect: 'deny', tools: ['read_secret'], whenTainted: true, reason: 'tainted secret read' },
    ],
  });
  const d = e.evaluate('read_secret', {}, dirty);
  assert.equal(d.effect, 'deny');
  assert.equal(d.ruleIndex, 0);
});
