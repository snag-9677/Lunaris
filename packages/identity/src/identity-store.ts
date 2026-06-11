/**
 * SqliteIdentityStore: identity + RBAC control plane backed by node:sqlite
 * (DatabaseSync), WAL mode for file-backed stores — matching SqliteEventStore /
 * SqliteApprovalQueue / SqliteGoalQueue.
 *
 * Security notes:
 *  - Passwords are stored only as scrypt hashes (credentials table).
 *  - Bearer tokens are opaque random 32-byte hex; only their SHA-256 hash is
 *    stored in the sessions table. resolveToken hashes the presented token and
 *    looks the hash up — the raw token never lives at rest.
 *  - No secret material (passwords, raw tokens) is logged or returned except the
 *    one-time token handed back from authenticate().
 *  - createUser/authenticate hash passwords with scryptSync, keeping the
 *    synchronous IdentityStore contract from core/types.ts.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { uuidv7 } from '@lunaris/core';
import type {
  AuthResult,
  Capability,
  IdentityStore,
  Principal,
  PrincipalKind,
  RbacRole,
  Session,
} from '@lunaris/core';
import { makePrincipal } from './principals.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { roleGrants } from './rbac.js';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * FIX 4: a fixed precomputed scrypt hash used ONLY to perform a dummy
 * verifyPassword on the unknown-user / no-credential branches of authenticate(),
 * so every login path pays the same scrypt cost before returning the same
 * generic failure. This avoids leaking principal existence via response timing
 * (an unknown user used to return immediately, skipping scrypt entirely).
 *
 * It is the hash of a random throwaway password; no real credential ever matches
 * it, and verifyPassword's result is intentionally discarded.
 */
const DUMMY_PASSWORD_HASH = hashPassword('lunaris:timing-equalizer:do-not-use');

interface PrincipalRow {
  id: string;
  kind: PrincipalKind;
  display_name: string;
  created_at: string;
  status: Principal['status'];
  parent_id: string | null;
}

interface SessionRow {
  id: string;
  principal_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  step_up_at: string | null;
}

interface BindingRow {
  scope: string;
  role: RbacRole;
}

function rowToPrincipal(row: PrincipalRow): Principal {
  const p: Principal = {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    createdAt: row.created_at,
    status: row.status,
  };
  if (row.parent_id !== null) p.parentId = row.parent_id;
  return p;
}

function rowToSession(row: SessionRow): Session {
  const s: Session = {
    id: row.id,
    principalId: row.principal_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
  if (row.step_up_at !== null) s.stepUpAt = row.step_up_at;
  return s;
}

/** Hash a bearer token for at-rest storage / lookup (raw token never stored). */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SqliteIdentityStoreOptions {
  /** Session lifetime in ms (default 12h). */
  sessionTtlMs?: number;
}

export class SqliteIdentityStore implements IdentityStore {
  private readonly db: DatabaseSync;
  private readonly sessionTtlMs: number;

  /** @param dbPath sqlite file path (parent dirs created) or ':memory:'. */
  constructor(dbPath: string, opts: SqliteIdentityStoreOptions = {}) {
    this.sessionTtlMs = opts.sessionTtlMs ?? SESSION_TTL_MS;
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS principals (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,
        display_name TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        status       TEXT NOT NULL,
        parent_id    TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_principals_name ON principals (display_name);

      CREATE TABLE IF NOT EXISTS credentials (
        principal_id TEXT PRIMARY KEY,
        password     TEXT NOT NULL,
        FOREIGN KEY (principal_id) REFERENCES principals (id)
      );

      CREATE TABLE IF NOT EXISTS role_bindings (
        principal_id TEXT NOT NULL,
        scope        TEXT NOT NULL,
        role         TEXT NOT NULL,
        PRIMARY KEY (principal_id, scope)
      );
      CREATE INDEX IF NOT EXISTS idx_bindings_principal ON role_bindings (principal_id);

      CREATE TABLE IF NOT EXISTS sessions (
        id           TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        token_hash   TEXT NOT NULL UNIQUE,
        created_at   TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        step_up_at   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_principal ON sessions (principal_id);
    `);
  }

  // ---------- principals ----------

  private insertPrincipal(p: Principal): void {
    this.db
      .prepare(
        `INSERT INTO principals (id, kind, display_name, created_at, status, parent_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.kind, p.displayName, p.createdAt, p.status, p.parentId ?? null);
  }

  getPrincipal(id: string): Principal | null {
    const row = this.db
      .prepare(`SELECT * FROM principals WHERE id = ?`)
      .get(id) as unknown as PrincipalRow | undefined;
    return row ? rowToPrincipal(row) : null;
  }

  private getPrincipalByName(displayName: string): Principal | null {
    const row = this.db
      .prepare(`SELECT * FROM principals WHERE display_name = ?`)
      .get(displayName) as unknown as PrincipalRow | undefined;
    return row ? rowToPrincipal(row) : null;
  }

  /**
   * Mint a usr_ principal; if a password is supplied, store a scrypt credential.
   * A password is optional (the loopback single-user default may have none).
   */
  createUser(displayName: string, password?: string): Principal {
    const principal = makePrincipal({ kind: 'user', displayName });
    this.insertPrincipal(principal);
    if (password !== undefined) {
      const stored = hashPassword(password);
      this.db
        .prepare(`INSERT INTO credentials (principal_id, password) VALUES (?, ?)`)
        .run(principal.id, stored);
    }
    return principal;
  }

  /** Create a non-user principal (node/agent/service). */
  createPrincipal(kind: PrincipalKind, displayName: string, parentId?: string): Principal {
    const input: Parameters<typeof makePrincipal>[0] = { kind, displayName };
    if (parentId !== undefined) input.parentId = parentId;
    const principal = makePrincipal(input);
    this.insertPrincipal(principal);
    return principal;
  }

  // ---------- auth / sessions ----------

  authenticate(displayName: string, password: string, now?: Date): AuthResult {
    const principal = this.getPrincipalByName(displayName);
    if (principal === null) {
      // FIX 4: pay the same scrypt cost as a real verification before returning,
      // so an unknown principal is not distinguishable from a wrong password by
      // response timing. The result is intentionally discarded.
      verifyPassword(password, DUMMY_PASSWORD_HASH);
      return { ok: false, reason: 'unknown principal' };
    }
    if (principal.status !== 'active') {
      // Equalize timing here too: a suspended principal otherwise skips scrypt.
      verifyPassword(password, DUMMY_PASSWORD_HASH);
      return { ok: false, reason: 'principal suspended' };
    }
    const credRow = this.db
      .prepare(`SELECT password FROM credentials WHERE principal_id = ?`)
      .get(principal.id) as unknown as { password: string } | undefined;
    if (credRow === undefined) {
      // FIX 4: a credential-less principal otherwise returns before any scrypt
      // work; run the dummy derivation so it costs the same as a real login.
      verifyPassword(password, DUMMY_PASSWORD_HASH);
      return { ok: false, reason: 'no credential' };
    }
    const ok = verifyPassword(password, credRow.password);
    if (!ok) {
      return { ok: false, reason: 'bad credentials' };
    }
    const { session, token } = this.issueSession(principal.id, now);
    return { ok: true, principal, session, token };
  }

  /** Mint a fresh session + opaque bearer token for an already-trusted principal. */
  issueSession(principalId: string, now?: Date): { session: Session; token: string } {
    const created = now ?? new Date();
    const token = randomBytes(32).toString('hex');
    const session: Session = {
      id: uuidv7(),
      principalId,
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + this.sessionTtlMs).toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO sessions (id, principal_id, token_hash, created_at, expires_at, step_up_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(session.id, session.principalId, hashToken(token), session.createdAt, session.expiresAt);
    return { session, token };
  }

  resolveToken(token: string, now?: Date): { principal: Principal; session: Session } | null {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE token_hash = ?`)
      .get(hashToken(token)) as unknown as SessionRow | undefined;
    if (row === undefined) return null;
    const session = rowToSession(row);
    const at = (now ?? new Date()).getTime();
    if (at >= new Date(session.expiresAt).getTime()) {
      return null; // expired
    }
    const principal = this.getPrincipal(session.principalId);
    if (principal === null || principal.status !== 'active') return null;
    return { principal, session };
  }

  revokeSession(sessionId: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
  }

  /** Record a fresh step-up (second-factor) timestamp on a session. */
  stepUp(sessionId: string, now?: Date): void {
    const ts = (now ?? new Date()).toISOString();
    this.db.prepare(`UPDATE sessions SET step_up_at = ? WHERE id = ?`).run(ts, sessionId);
  }

  /** True iff the session has a step-up within `withinMs` of `now`. */
  hasFreshStepUp(sessionId: string, withinMs: number, now?: Date): boolean {
    const row = this.db
      .prepare(`SELECT step_up_at FROM sessions WHERE id = ?`)
      .get(sessionId) as unknown as { step_up_at: string | null } | undefined;
    if (row === undefined || row.step_up_at === null) return false;
    const at = (now ?? new Date()).getTime();
    return at - new Date(row.step_up_at).getTime() <= withinMs;
  }

  // ---------- RBAC ----------

  bind(principalId: string, scope: string, role: RbacRole): void {
    // One binding per (principal, scope); re-bind updates the role.
    this.db
      .prepare(
        `INSERT INTO role_bindings (principal_id, scope, role) VALUES (?, ?, ?)
         ON CONFLICT (principal_id, scope) DO UPDATE SET role = excluded.role`,
      )
      .run(principalId, scope, role);
  }

  /**
   * Effective role for a principal in a project: a project-scoped binding
   * (`project:<id>`) shadows a global binding; otherwise the global binding is
   * used. Returns null if neither exists.
   */
  roleFor(principalId: string, projectId: string): RbacRole | null {
    const rows = this.db
      .prepare(`SELECT scope, role FROM role_bindings WHERE principal_id = ?`)
      .all(principalId) as unknown as BindingRow[];
    const projectScope = `project:${projectId}`;
    let global: RbacRole | null = null;
    for (const r of rows) {
      if (r.scope === projectScope) return r.role; // project binding wins
      if (r.scope === 'global') global = r.role;
    }
    return global;
  }

  can(principalId: string, projectId: string, cap: Capability): boolean {
    const principal = this.getPrincipal(principalId);
    if (principal === null || principal.status !== 'active') return false;
    const role = this.roleFor(principalId, projectId);
    if (role === null) return false;
    return roleGrants(role, cap);
  }

  // ---------- bootstrap ----------

  /**
   * Implicit-owner bootstrap for the loopback single-user default: if no user
   * principal exists, mint one owner with a global owner binding and no
   * password (loopback trust). Idempotent — returns the existing owner if any
   * user already exists. Returns the owner principal.
   */
  ensureLocalOwner(displayName = 'local'): Principal {
    const existing = this.db
      .prepare(`SELECT * FROM principals WHERE kind = 'user' ORDER BY id ASC LIMIT 1`)
      .get() as unknown as PrincipalRow | undefined;
    if (existing !== undefined) return rowToPrincipal(existing);

    const owner = makePrincipal({ kind: 'user', displayName });
    this.insertPrincipal(owner);
    this.bind(owner.id, 'global', 'owner');
    return owner;
  }

  close(): void {
    this.db.close();
  }
}
