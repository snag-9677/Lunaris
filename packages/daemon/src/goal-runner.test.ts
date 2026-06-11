/**
 * FIX 1+2 (daemon side): the per-run capability token minted by acquireRunLease
 * must carry the ROLE-STYLE top-level run caps the orchestrator's subagentCaps()
 * actually narrows — NOT the rbac:* control-plane vocabulary (which was a silent
 * no-op for attenuation) — and it must expose the signing service so the runner
 * can thread it into the AgentLoop as `capTokens`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Goal } from '@lunaris/core';
import { Ed25519CapabilityTokenService, SqliteLeaseStore, stableNodeId } from '@lunaris/identity';
import { acquireRunLease, TOP_LEVEL_RUN_CAPS } from './goal-runner.js';
import type { GoalLeaseRuntime } from './goal-runner.js';

function makeRuntime(dir: string): GoalLeaseRuntime {
  return {
    leaseStore: new SqliteLeaseStore(':memory:'),
    tokenService: new Ed25519CapabilityTokenService({ keyPath: join(dir, 'agent-key.pem') }),
    nodeId: stableNodeId(),
  };
}

function makeGoal(): Goal {
  return {
    goalId: 'goal-fix12',
    projectId: 'proj-fix12',
    prompt: 'do work',
    createdAt: new Date().toISOString(),
    status: 'running',
  };
}

test('FIX 1+2: acquireRunLease mints a role-style run token (not rbac:*) and exposes the token service', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lunarisd-gr-test-'));
  const runtime = makeRuntime(dir);
  let held;
  try {
    held = acquireRunLease(makeGoal(), runtime);

    // The runner threads this service into the loop as `capTokens`.
    assert.equal(held.tokenService, runtime.tokenService, 'tokenService must be exposed for attenuation');

    // The token verifies against the signing key and carries the role-style caps.
    const decoded = runtime.tokenService.verify(held.agentToken);
    assert.ok(decoded, 'minted run token must verify');
    assert.deepEqual([...decoded!.caps].sort(), [...TOP_LEVEL_RUN_CAPS].sort());

    // NOT the rbac:* control-plane vocabulary (the old dead-code minting).
    for (const cap of decoded!.caps) {
      assert.ok(!cap.startsWith('rbac:'), `run token must not carry rbac:* caps, saw ${cap}`);
    }
    // Top-level run holds spawn (children lose it via attenuation).
    assert.ok(decoded!.caps.includes('spawn'), 'top-level run holds spawn');
    assert.equal(decoded!.principalId, 'agt_goal-fix12');
    assert.equal(decoded!.projectId, 'proj-fix12');
    assert.equal(decoded!.leaseEpoch, held.epoch);
  } finally {
    held?.stop();
    runtime.leaseStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
