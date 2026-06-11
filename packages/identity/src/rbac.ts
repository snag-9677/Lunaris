/**
 * RBAC role -> capability matrix.
 *
 *  owner       all capabilities.
 *  maintainer  all EXCEPT fleet.manage, secrets.write, providers.write.
 *  operator    goal.submit, kill_switch, resume, approve, change_autonomy,
 *              project.read  (day-to-day run control, no secret/provider/fleet).
 *  viewer      project.read only.
 *  auditor     project.read only (read access for audit; distinct role name).
 *
 * The matrix is the single source of truth for can(); the store never grants a
 * capability not listed here for the principal's effective role.
 */
import type { Capability, RbacRole } from '@lunaris/core';

const ALL_CAPS: Capability[] = [
  'project.read',
  'goal.submit',
  'kill_switch',
  'resume',
  'approve',
  'change_autonomy',
  'secrets.read',
  'secrets.write',
  'providers.write',
  'memory.prune',
  'optimizer.promote',
  'fleet.manage',
];

const MAINTAINER_DENIED: ReadonlySet<Capability> = new Set<Capability>([
  'fleet.manage',
  'secrets.write',
  'providers.write',
]);

const OPERATOR_CAPS: ReadonlySet<Capability> = new Set<Capability>([
  'goal.submit',
  'kill_switch',
  'resume',
  'approve',
  'change_autonomy',
  'project.read',
]);

const READ_ONLY: ReadonlySet<Capability> = new Set<Capability>(['project.read']);

/** Capabilities granted to a role, as a frozen set. */
export const ROLE_CAPS: Readonly<Record<RbacRole, ReadonlySet<Capability>>> = Object.freeze({
  owner: new Set<Capability>(ALL_CAPS),
  maintainer: new Set<Capability>(ALL_CAPS.filter((c) => !MAINTAINER_DENIED.has(c))),
  operator: OPERATOR_CAPS,
  viewer: READ_ONLY,
  auditor: READ_ONLY,
});

/** True iff the role grants the capability. */
export function roleGrants(role: RbacRole, cap: Capability): boolean {
  const caps = ROLE_CAPS[role];
  return caps !== undefined && caps.has(cap);
}

/** All capabilities (for owner-token minting etc.). */
export function allCapabilities(): Capability[] {
  return [...ALL_CAPS];
}
