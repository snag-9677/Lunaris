/**
 * Phase 4 auth/RBAC wiring for the daemon.
 *
 * Preserves the Phase-1 zero-config UX: by default the daemon runs with auth
 * OFF on loopback and an *implicit owner* — every request is allowed (current
 * behaviour). When LUNARIS_AUTH=on, a bearer token is required on /api routes
 * and dangerous routes are gated by RBAC capability checks.
 *
 * Identity lives in a SqliteIdentityStore at ~/.lunaris/identity.db. The store's
 * value-level surface is owned by @lunaris/identity (not types.ts), so it is
 * imported statically here as a workspace dep. A loopback owner is bootstrapped
 * via ensureLocalOwner() so the single-user default works with no login.
 *
 * SECURITY: tokens are opaque bearer strings; only their sha256 is stored in the
 * identity db. We never log token material. Capability checks map a route to a
 * Capability and call identity.can(principalId, projectId, cap); 401 for missing/
 * invalid token, 403 when the role lacks the capability.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SqliteIdentityStore } from '@lunaris/identity';
import type { Capability, Principal, RbacRole, Session } from '@lunaris/core';

export type AuthMode = 'off' | 'on';

/** Resolve the auth mode from config/env (default off for the loopback default). */
export function resolveAuthMode(explicit?: AuthMode): AuthMode {
  if (explicit !== undefined) return explicit;
  const raw = (process.env['LUNARIS_AUTH'] ?? 'off').trim().toLowerCase();
  return raw === 'on' || raw === '1' || raw === 'true' ? 'on' : 'off';
}

export function defaultIdentityDbPath(): string {
  return join(homedir(), '.lunaris', 'identity.db');
}

/** What the auth hook attaches to a request once resolved. */
export interface AuthContext {
  principal: Principal;
  /** Present for token-authenticated requests; absent for the implicit owner. */
  session?: Session;
  /** True when this is the implicit loopback owner (auth OFF). */
  implicit: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

/**
 * Extract a bearer token from the Authorization header ONLY.
 *
 * FIX 3: the long-lived bearer token must NEVER be read from the URL/query
 * string — doing so writes the full session token into request logs (Fastify
 * logs req.url). WebSocket upgrades (which can't easily set Authorization) are
 * authenticated with a separate short-lived single-use ws-ticket (see
 * /api/ws-ticket + /api/ws in server.ts), not this function. The legacy `query`
 * parameter is retained for signature compatibility but is intentionally
 * ignored.
 */
export function bearerFromRequest(
  headers: Record<string, string | string[] | undefined>,
  _query?: unknown,
): string | undefined {
  const raw = headers['authorization'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m && typeof m[1] === 'string' && m[1].length > 0) return m[1];
  }
  return undefined;
}

/**
 * Map (HTTP method + path) to the Capability it requires, or undefined when the
 * route needs no special capability beyond being authenticated. Read routes map
 * to project.read; mutating/dangerous routes map to their specific capability.
 * Returns null for routes that are not capability-gated at all (login/version).
 */
export function capabilityForRoute(method: string, path: string): Capability | null | undefined {
  const m = method.toUpperCase();

  // Always-open (no capability needed beyond reaching the hook).
  if (path === '/api/login' || path === '/api/whoami' || path === '/api/version') return null;
  // Minting a WS ticket only needs an authenticated principal (no extra cap).
  if (path === '/api/ws-ticket') return null;
  // FIX 6: registering a project root (POST /api/projects) is a privileged
  // control-plane mutation — a viewer must NOT be able to register arbitrary
  // project roots (it adds a path the daemon will operate on). Gate it behind
  // change_autonomy. The listing (GET) and status stay at project.read.
  if (path === '/api/projects' && m === 'POST') return 'change_autonomy';
  if (path === '/api/status' || path === '/api/projects') return 'project.read';

  // Goal submission (POST .../goals or .../queue) — the core run-control power.
  if (/\/goals$/.test(path) && m === 'POST') return 'goal.submit';
  if (/\/queue$/.test(path) && m === 'POST') return 'goal.submit';

  // Approvals resolve.
  if (/^\/api\/approvals\/[^/]+\/resolve$/.test(path) && m === 'POST') return 'approve';

  // Autonomy level change.
  if (/\/policy$/.test(path) && m === 'PUT') return 'change_autonomy';

  // Optimizer promote (resolve a proposal applies/records a config change).
  if (/^\/api\/proposals\/[^/]+\/resolve$/.test(path) && m === 'POST') return 'optimizer.promote';
  if (/\/optimize$/.test(path) && m === 'POST') return 'optimizer.promote';

  // Memory prune is dangerous (destroys learned state).
  if (/\/memory\/prune$/.test(path) && m === 'POST') return 'memory.prune';

  // Lifecycle: snapshot/restore/export mutate or read project state.
  if (/\/restore$/.test(path) && m === 'POST') return 'change_autonomy';
  if (/\/snapshot$/.test(path) && m === 'POST') return 'change_autonomy';
  if (/\/export$/.test(path) && m === 'POST') return 'change_autonomy';

  // Plugin enable/disable + schedule/trigger create/delete change project config.
  if (/\/plugins\/[^/]+\/(enable|disable)$/.test(path) && m === 'POST') return 'change_autonomy';
  if (/\/(schedules|triggers)(\/[^/]+)?$/.test(path) && (m === 'POST' || m === 'DELETE')) return 'change_autonomy';

  // Any other GET under /api is a read.
  if (m === 'GET') return 'project.read';

  // Default: require project.read so an authenticated principal is still vetted.
  return 'project.read';
}

/** Best-effort extraction of a project id from a path like /api/projects/:id/... */
export function projectIdFromPath(path: string): string | undefined {
  const m = /^\/api\/projects\/([^/]+)/.exec(path);
  return m ? m[1] : undefined;
}

export interface IdentityLike {
  ensureLocalOwner(displayName?: string): Principal;
  authenticate(displayName: string, password: string, now?: Date): {
    ok: boolean;
    principal?: Principal;
    session?: Session;
    token?: string;
    reason?: string;
  };
  resolveToken(token: string, now?: Date): { principal: Principal; session: Session } | null;
  can(principalId: string, projectId: string, cap: Capability): boolean;
  roleFor(principalId: string, projectId: string): RbacRole | null;
  revokeSession(sessionId: string): void;
  close(): void;
}

export interface IdentitySetup {
  identity: IdentityLike;
  owner: Principal;
}

/**
 * Construct the identity store and bootstrap a loopback owner. Returns the store
 * + the owner principal (used as the implicit principal when auth is OFF).
 */
export function setupIdentity(dbPath?: string, ownerName = 'local'): IdentitySetup {
  const identity = new SqliteIdentityStore(dbPath ?? defaultIdentityDbPath()) as unknown as IdentityLike;
  const owner = identity.ensureLocalOwner(ownerName);
  return { identity, owner };
}
