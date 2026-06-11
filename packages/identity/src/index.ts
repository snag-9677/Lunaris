export { principalId, kindOf, makePrincipal } from './principals.js';
export type { NewPrincipalInput } from './principals.js';

export { hashPassword, verifyPassword } from './passwords.js';

export { ROLE_CAPS, roleGrants, allCapabilities } from './rbac.js';

export { SqliteIdentityStore } from './identity-store.js';
export type { SqliteIdentityStoreOptions } from './identity-store.js';

export { Ed25519CapabilityTokenService, capsSatisfy } from './capability-token.js';
export type { Ed25519KeyOptions } from './capability-token.js';

export { SqliteLeaseStore, stableNodeId } from './lease-store.js';
export type { SqliteLeaseStoreOptions } from './lease-store.js';
