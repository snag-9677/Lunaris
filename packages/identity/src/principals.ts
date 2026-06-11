/**
 * Principal id minting + shape helpers.
 *
 * Ids are "<prefix>_<sortable>" where the sortable suffix reuses the monotonic
 * UUIDv7 generator from @lunaris/core (time-ordered, dep-free). We strip the
 * dashes so the id is a single token: e.g. "usr_0190b3c2f1a87c3d...".
 */
import { uuidv7 } from '@lunaris/core';
import type { Principal, PrincipalKind } from '@lunaris/core';

const PREFIX: Record<PrincipalKind, string> = {
  user: 'usr',
  node: 'node',
  agent: 'agt',
  service: 'svc',
};

/** Reverse lookup prefix -> kind, for parsing/validation. */
const KIND_BY_PREFIX: Record<string, PrincipalKind> = {
  usr: 'user',
  node: 'node',
  agt: 'agent',
  svc: 'service',
};

/** Mint a sortable principal id for the given kind. */
export function principalId(kind: PrincipalKind): string {
  const prefix = PREFIX[kind];
  // Drop dashes so the id is a single, copy-pasteable token.
  return `${prefix}_${uuidv7().replace(/-/g, '')}`;
}

/** Infer the kind from a principal id prefix, or null if unrecognized. */
export function kindOf(id: string): PrincipalKind | null {
  const underscore = id.indexOf('_');
  if (underscore <= 0) return null;
  const prefix = id.slice(0, underscore);
  return KIND_BY_PREFIX[prefix] ?? null;
}

export interface NewPrincipalInput {
  kind: PrincipalKind;
  displayName: string;
  parentId?: string;
  now?: Date;
}

/** Build a fresh active Principal (caller persists it). */
export function makePrincipal(input: NewPrincipalInput): Principal {
  const p: Principal = {
    id: principalId(input.kind),
    kind: input.kind,
    displayName: input.displayName,
    createdAt: (input.now ?? new Date()).toISOString(),
    status: 'active',
  };
  if (input.parentId !== undefined) p.parentId = input.parentId;
  return p;
}
