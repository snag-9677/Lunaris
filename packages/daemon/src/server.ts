/**
 * lunarisd HTTP + WS server.
 *
 * SECURITY (Phase 1, spec §15/§17): the daemon binds 127.0.0.1 ONLY. The
 * listen() method is wrapped so any attempt to bind a non-loopback host is
 * refused, and the host is hard-forced to 127.0.0.1 regardless.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyListenOptions } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { computeAnalytics, loadManifest, SqliteEventStore } from '@lunaris/core';
import type {
  ApprovalTicket,
  AutonomyLevel,
  EventStore,
  Goal,
  LunarisManifest,
  MemoryRecord,
  Principal,
  PolicyRule,
  QueuedGoalStatus,
  ResolvedTool,
} from '@lunaris/core';
import { ProjectRegistry } from './registry.js';
import { acquireRunLease, approvalsDbPath, defaultGoalRunner, LeaseHeldError, memoryDbPath } from './goal-runner.js';
import type { AcquiredLease, GoalRunner } from './goal-runner.js';
import {
  banditDbPath,
  isSafePathSegment,
  loadOptimizerPkg,
  loadPlugdPkg,
  loadSchedulerPkg,
  pluginsDir,
  proposalDbPath,
  queueDbPath,
  scheduleDbPath,
  triggerDbPath,
  webhookSecretFor,
} from './phase3.js';
import {
  bearerFromRequest,
  capabilityForRoute,
  defaultIdentityDbPath,
  projectIdFromPath,
  resolveAuthMode,
  setupIdentity,
} from './auth.js';
import type { AuthContext, AuthMode, IdentityLike } from './auth.js';
import {
  buildVersionReport,
  globalStorePaths,
  leasesDbPath,
  projectStorePaths,
} from './phase4.js';
import { loadLifecyclePkg } from './lifecycle-routes.js';

const LOOPBACK_HOST = '127.0.0.1';
const ALLOWED_HOSTS = new Set<string>([LOOPBACK_HOST, 'localhost', '::1']);

/** Lifetime of a single-use WebSocket ticket (FIX 3). */
const WS_TICKET_TTL_MS = 30_000;

/**
 * FIX 3: replace the value of any `ticket` query param in a URL with [REDACTED]
 * for logging, preserving the rest of the URL (path + other params). Pure string
 * op so it never throws on a malformed URL.
 */
export function redactTicketParam(url: string): string {
  return url.replace(/([?&]ticket=)[^&#]*/gi, '$1[REDACTED]');
}

/**
 * A short-lived, single-use WebSocket ticket (FIX 3). The long-lived bearer
 * token must never appear in a URL (it lands in request logs), so the WS upgrade
 * is authenticated with one of these instead: minted via POST /api/ws-ticket
 * (which requires the bearer token in the Authorization header) and consumed
 * exactly once by the /api/ws handler.
 */
interface WsTicket {
  principalId: string;
  sessionId?: string;
  expiresAt: number;
  used: boolean;
}

export interface LunarisServerContext {
  events: EventStore;
  registry: ProjectRegistry;
  identity: IdentityLike;
  /** Implicit loopback owner principal (used when auth is OFF). */
  owner: Principal;
  authMode: AuthMode;
}

declare module 'fastify' {
  interface FastifyInstance {
    lunaris: LunarisServerContext;
  }
}

export interface BuildServerOptions {
  /** Path to projects.json (default ~/.lunaris/projects.json). */
  registryPath?: string;
  /** Path to the shared sqlite event store (default ~/.lunaris/events.db). */
  eventsDbPath?: string;
  /** Static UI root (default <repo>/packages/ui/dist, served only if it exists). */
  uiDistPath?: string;
  /** Goal execution strategy; defaults to ModelGateway + AgentLoop wiring. */
  runGoal?: GoalRunner;
  logger?: boolean;
  /**
   * Auth mode override; defaults to env LUNARIS_AUTH (off|on), default 'off' to
   * preserve the Phase-1 zero-config loopback UX (implicit owner, all allowed).
   */
  authMode?: AuthMode;
  /** Identity db path (default ~/.lunaris/identity.db). ':memory:' for tests. */
  identityDbPath?: string;
  /**
   * Inject a pre-built identity store (tests). Takes precedence over
   * identityDbPath; the implicit owner is taken from ensureLocalOwner().
   */
  identity?: IdentityLike;
}

function packageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function defaultUiDistPath(): string {
  // compiled file lives at packages/daemon/dist/server.js → ../../ui/dist
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui', 'dist');
}

/* ---------- Phase 2 package surfaces (value-level; bound loosely) ---------- */

interface MemoryStoreLike {
  search(query: string, limit?: number): MemoryRecord[];
  entities(): unknown[];
  relations(): unknown[];
  close?(): void;
}
interface MemoryPkgLike {
  SqliteMemoryStore: new (opts: { dbPath: string; projectId: string }) => MemoryStoreLike;
}
interface ApprovalQueueLike {
  list(projectId?: string, status?: ApprovalTicket['status']): ApprovalTicket[];
  resolve(ticketId: string, approved: boolean, by: string, currentPlanEpoch?: number): ApprovalTicket | undefined;
  close(): void;
}
interface PolicyPkgLike {
  loadPolicy: (
    projectDir: string,
    options?: { level?: AutonomyLevel },
  ) => { level: AutonomyLevel; rules: PolicyRule[]; tightenWhenTainted: boolean; allowlistedHosts: string[] };
  writeDefaultPolicy: (projectDir: string, level: AutonomyLevel, overwrite?: boolean) => string;
  SqliteApprovalQueue: new (dbPath: string) => ApprovalQueueLike;
}

/** Open a read-only memory store for a project (returns undefined if the db/pkg is unavailable). */
async function openMemory(projectRoot: string, projectId: string): Promise<MemoryStoreLike | undefined> {
  const path = memoryDbPath(projectRoot);
  if (!existsSync(path)) return undefined;
  try {
    const mod = (await import('@lunaris/memory')) as unknown as MemoryPkgLike;
    return new mod.SqliteMemoryStore({ dbPath: path, projectId });
  } catch {
    return undefined;
  }
}

async function loadPolicyPkg(): Promise<PolicyPkgLike | undefined> {
  try {
    return (await import('@lunaris/policy')) as unknown as PolicyPkgLike;
  } catch {
    return undefined;
  }
}

/** Resolve the enabled plugin tools for a project (best-effort; [] on any failure). */
async function resolveProjectPluginTools(projectRoot: string): Promise<ResolvedTool[]> {
  const dir = pluginsDir(projectRoot);
  if (!existsSync(dir)) return [];
  const pkg = await loadPlugdPkg();
  if (!pkg) return [];
  try {
    const host = new pkg.FilePluginHost({ pluginsDir: dir });
    return await host.enabledTools();
  } catch {
    return [];
  }
}

/** Wrap listen() so the daemon can never bind a non-loopback interface. */
function enforceLoopbackOnly(app: FastifyInstance): void {
  const rawListen = app.listen.bind(app) as (
    opts: FastifyListenOptions,
    cb?: (err: Error | null, address: string) => void,
  ) => Promise<string> | void;

  const guarded = (first?: unknown, second?: unknown): Promise<string> | void => {
    let opts: FastifyListenOptions = {};
    let cb: ((err: Error | null, address: string) => void) | undefined;
    if (typeof first === 'function') {
      cb = first as (err: Error | null, address: string) => void;
    } else if (typeof first === 'object' && first !== null) {
      opts = first as FastifyListenOptions;
      if (typeof second === 'function') {
        cb = second as (err: Error | null, address: string) => void;
      }
    }
    if (opts.host !== undefined && !ALLOWED_HOSTS.has(opts.host)) {
      throw new Error(
        `lunarisd binds ${LOOPBACK_HOST} only (Phase 1 security rule); refusing host "${opts.host}"`,
      );
    }
    const forced: FastifyListenOptions = { ...opts, host: LOOPBACK_HOST };
    return cb ? rawListen(forced, cb) : rawListen(forced);
  };

  app.listen = guarded as typeof app.listen;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const startedAt = Date.now();
  const version = packageVersion();

  const registry = new ProjectRegistry(options.registryPath);

  const eventsDbPath = options.eventsDbPath ?? join(homedir(), '.lunaris', 'events.db');
  mkdirSync(dirname(eventsDbPath), { recursive: true });
  // Structural cast: SqliteEventStore's ctor shape is owned by @lunaris/core.
  const StoreCtor = SqliteEventStore as unknown as new (path: string) => EventStore;
  const events: EventStore = new StoreCtor(eventsDbPath);

  const runGoal = options.runGoal ?? defaultGoalRunner;

  // ---- Identity / auth (Phase 4) ----
  // Default: auth OFF on loopback with an implicit owner (Phase-1 UX). When ON,
  // a bearer token is required on /api routes and dangerous routes are RBAC-gated.
  const authMode: AuthMode = resolveAuthMode(options.authMode);
  const identityDbPath = options.identityDbPath ?? defaultIdentityDbPath();
  let identity: IdentityLike;
  let owner: Principal;
  if (options.identity !== undefined) {
    identity = options.identity;
    owner = identity.ensureLocalOwner('local');
  } else {
    if (identityDbPath !== ':memory:') mkdirSync(dirname(identityDbPath), { recursive: true });
    const setup = setupIdentity(identityDbPath);
    identity = setup.identity;
    owner = setup.owner;
  }

  // ---- Lease + capability-token runtime (Phase 4) ----
  // Shared across runs; goal submission acquires the per-repo lease (repoId =
  // projectId), heartbeats for the run, and releases at the end. Constructed
  // lazily so a daemon without write access to ~/.lunaris still boots; on any
  // failure (e.g. unbuilt package) the daemon falls back to no-lease runs.
  let leaseRuntime: import('./phase4.js').LeaseRuntime | undefined;
  try {
    const { makeLeaseRuntime } = await import('./phase4.js');
    // When running against an in-memory identity db (tests), keep the lease
    // store in memory and the signing key off the real ~/.lunaris dir.
    if (options.identityDbPath === ':memory:') {
      const ephemeralKey = join(
        mkdtempSync(join(tmpdir(), 'lunarisd-agentkey-')),
        'agent-key.pem',
      );
      leaseRuntime = makeLeaseRuntime({ leasesPath: ':memory:', keyPath: ephemeralKey });
    } else {
      leaseRuntime = makeLeaseRuntime();
    }
  } catch {
    leaseRuntime = undefined;
  }

  // FIX 3: when the logger is on, install a custom request serializer that
  // strips the `ticket` query param from the logged URL (and redacts the
  // Authorization header) as defense-in-depth. The PRIMARY fix is that the WS
  // handler no longer accepts the long-lived bearer token in the URL at all
  // (see /api/ws-ticket + /api/ws below) — it accepts only a short single-use
  // ticket — but we also keep that ticket out of request logs entirely.
  const loggerOpt = options.logger
    ? {
        serializers: {
          req(req: { method: string; url: string; headers?: Record<string, unknown> }): {
            method: string;
            url: string;
            host: string | undefined;
          } {
            const host = req.headers?.['host'];
            return {
              method: req.method,
              url: redactTicketParam(req.url),
              host: typeof host === 'string' ? host : undefined,
            };
          },
        },
      }
    : false;
  const app = Fastify(loggerOpt === false ? { logger: false } : { logger: loggerOpt });
  enforceLoopbackOnly(app);
  app.decorate('lunaris', { events, registry, identity, owner, authMode });

  app.addHook('onClose', async () => {
    (events as EventStore & { close?: () => void }).close?.();
    // Only close an identity store we own (never one injected by a test).
    if (options.identity === undefined) {
      try {
        identity.close();
      } catch {
        /* ignore */
      }
    }
    try {
      leaseRuntime?.leaseStore.close();
    } catch {
      /* ignore */
    }
  });

  await app.register(websocket);

  // Capture the raw request body (needed for webhook HMAC verification) while
  // preserving normal JSON parsing for every other route. The parser stores the
  // exact bytes on req.rawBody, then JSON.parses for the typed body (falling
  // back to the raw string when the payload is not valid JSON).
  //
  // Webhooks (e.g. GitHub) can send application/x-www-form-urlencoded or
  // application/octet-stream, so we register the same raw-capturing parser for
  // those content types too — otherwise rawBody is unset for them and HMAC
  // verification would run over the wrong bytes. JSON API routes are unaffected.
  const rawCapturingParser = (
    req: import('fastify').FastifyRequest,
    body: string,
    done: (err: Error | null, body?: unknown) => void,
  ): void => {
    (req as unknown as { rawBody?: string }).rawBody = body;
    if (body.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body) as unknown);
    } catch {
      // Webhooks may send non-JSON; keep the route working by passing the raw
      // string through. (API routes that require JSON still validate fields.)
      done(null, body as unknown);
    }
  };
  for (const contentType of [
    'application/json',
    'application/x-www-form-urlencoded',
    'application/octet-stream',
  ]) {
    app.addContentTypeParser(contentType, { parseAs: 'string' }, rawCapturingParser);
  }

  // ---- WS ticket store (FIX 3) ----
  // In-memory single-use tickets bound to the authenticated principal/session.
  // Tickets expire after WS_TICKET_TTL_MS and are consumed exactly once. The
  // long-lived bearer token is NEVER used as a WS ticket.
  const wsTickets = new Map<string, WsTicket>();
  const pruneWsTickets = (now: number): void => {
    for (const [id, t] of wsTickets) {
      if (t.used || now >= t.expiresAt) wsTickets.delete(id);
    }
  };
  /** Validate + consume a single-use WS ticket. Returns the principalId or null. */
  const consumeWsTicket = (ticket: string | undefined, now: number): string | null => {
    if (typeof ticket !== 'string' || ticket.length === 0) return null;
    const t = wsTickets.get(ticket);
    if (t === undefined) return null;
    // Always remove on lookup so a ticket can be presented at most once.
    wsTickets.delete(ticket);
    if (t.used || now >= t.expiresAt) return null;
    return t.principalId;
  };

  // ---- Auth preHandler (Phase 4) ----
  //
  // When auth is OFF: attach the implicit owner to every request; all allowed.
  // When auth is ON: /api/login is open; every other /api route requires a valid
  // bearer token (401 otherwise). The resolved principal is then checked against
  // the route's mapped Capability for the path's project (403 on denial).
  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    // Only guard /api/* (and not the login route itself); webhooks/static/WS
    // have their own handling. WS auth is enforced inside the /api/ws handler.
    if (!path.startsWith('/api/') || path === '/api/ws') return;

    if (authMode === 'off') {
      req.auth = { principal: owner, implicit: true } satisfies AuthContext;
      return;
    }

    // Login is always reachable; it issues the token.
    if (path === '/api/login') return;

    const token = bearerFromRequest(
      req.headers as Record<string, string | string[] | undefined>,
      req.query,
    );
    if (token === undefined) {
      return reply.code(401).send({ error: 'authentication required' });
    }
    const resolved = identity.resolveToken(token);
    if (resolved === null) {
      return reply.code(401).send({ error: 'invalid or expired token' });
    }
    req.auth = { principal: resolved.principal, session: resolved.session, implicit: false } satisfies AuthContext;

    // Capability gate. null => no capability required (whoami/version).
    const cap = capabilityForRoute(req.method, path);
    if (cap === null || cap === undefined) return;
    const projectId = projectIdFromPath(path) ?? 'global';
    if (!identity.can(resolved.principal.id, projectId, cap)) {
      return reply.code(403).send({ error: `missing capability: ${cap}` });
    }
  });

  // ---- API routes ----

  // ---- Auth: login / whoami (Phase 4) ----

  app.post<{ Body: { user?: unknown; password?: unknown } }>('/api/login', async (req, reply) => {
    const body = (req.body ?? {}) as { user?: unknown; password?: unknown };
    if (typeof body.user !== 'string' || body.user.length === 0 || typeof body.password !== 'string') {
      return reply.code(400).send({ error: 'body must be {"user": "...", "password": "..."}' });
    }
    const result = identity.authenticate(body.user, body.password);
    if (!result.ok || result.token === undefined || result.principal === undefined) {
      // Do not leak which factor failed.
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    return reply.code(200).send({
      token: result.token,
      principal: result.principal,
      expiresAt: result.session?.expiresAt,
    });
  });

  app.get('/api/whoami', async (req) => {
    const principal = req.auth?.principal ?? owner;
    const role = identity.roleFor(principal.id, 'global');
    return {
      authMode,
      principal,
      role,
      implicit: req.auth?.implicit ?? true,
    };
  });

  // ---- WS ticket: POST /api/ws-ticket (FIX 3) ----
  //
  // Mint a short-lived (30s) single-use ticket bound to the authenticated
  // principal/session for the WebSocket upgrade. This exists so the long-lived
  // bearer token never has to travel in the ?ticket= query string (where it
  // would be written to request logs). Reaching this route already required a
  // valid bearer token in the Authorization header (the auth preHandler), so we
  // simply bind the ticket to req.auth's principal.
  app.post('/api/ws-ticket', async (req, reply) => {
    const principal = req.auth?.principal ?? owner;
    const now = Date.now();
    pruneWsTickets(now);
    const ticket = randomUUID();
    wsTickets.set(ticket, {
      principalId: principal.id,
      ...(req.auth?.session !== undefined ? { sessionId: req.auth.session.id } : {}),
      expiresAt: now + WS_TICKET_TTL_MS,
      used: false,
    });
    return reply.code(201).send({ ticket, expiresInMs: WS_TICKET_TTL_MS });
  });

  // ---- Version + schema doctor (Phase 4) ----

  app.get('/api/version', async () => {
    const eventsPath = options.eventsDbPath ?? join(homedir(), '.lunaris', 'events.db');
    const globals = globalStorePaths(eventsPath, identityDbPath, leasesDbPath());
    const perProject: Record<string, string> = {};
    for (const project of registry.list()) {
      for (const [store, path] of Object.entries(projectStorePaths(project.root))) {
        // Namespace project stores so multiple projects don't collide in the map.
        perProject[`${project.id}:${store}`] = path;
      }
    }
    const { version, doctor: report } = buildVersionReport({ ...globals, ...perProject });
    return { version, doctor: report };
  });

  app.get('/api/status', async () => ({
    name: 'lunarisd',
    version,
    projects: registry.list().length,
    uptime: Math.round((Date.now() - startedAt) / 1000),
  }));

  app.get('/api/projects', async () => registry.list());

  app.post<{ Body: { root?: unknown } }>('/api/projects', async (req, reply) => {
    const body = (req.body ?? {}) as { root?: unknown };
    if (typeof body.root !== 'string' || body.root.length === 0) {
      return reply.code(400).send({ error: 'body must be {"root": "/abs/path/to/project"}' });
    }
    try {
      const project = await registry.register(body.root);
      return await reply.code(201).send(project);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: `failed to register project: ${message}` });
    }
  });

  app.post<{ Params: { id: string }; Body: { prompt?: unknown } }>(
    '/api/projects/:id/goals',
    async (req, reply) => {
      const project = registry.get(req.params.id);
      if (!project) {
        return reply.code(404).send({ error: `unknown project: ${req.params.id}` });
      }
      const body = (req.body ?? {}) as { prompt?: unknown };
      if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
        return reply.code(400).send({ error: 'body must be {"prompt": "..."}' });
      }

      let manifest: LunarisManifest;
      try {
        manifest = await loadManifest(project.root);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: `failed to load manifest: ${message}` });
      }

      const goal: Goal = {
        goalId: randomUUID(),
        projectId: project.id,
        prompt: body.prompt,
        createdAt: new Date().toISOString(),
        status: 'running',
      };

      // Lease + fencing (Phase 4): atomically acquire the repo lease (repoId =
      // projectId) BEFORE dispatching. If a live lease is held by another run,
      // reject with 409 (one orchestrator per repo) instead of double-running.
      // The acquired lease (epoch + scoped agent token + isFenced) is threaded
      // into the run and released when it finishes.
      let acquiredLease: AcquiredLease | undefined;
      if (leaseRuntime !== undefined) {
        try {
          acquiredLease = acquireRunLease(goal, leaseRuntime);
        } catch (err) {
          if (err instanceof LeaseHeldError) {
            return reply.code(409).send({ error: err.message, holder: err.holder });
          }
          throw err;
        }
      }

      events.append({ projectId: project.id, kind: 'goal.created', payload: goal });

      // Run asynchronously: respond immediately; terminal state lands as an
      // event — goal.done (carrying the ResultEnvelope) when the run resolves,
      // goal.failed when it rejects. Plugin tools (if any enabled) are resolved
      // up front so daemon-run goals get the project's plugin tools.
      void Promise.resolve()
        .then(async () => {
          const pluginTools = await resolveProjectPluginTools(project.root);
          return runGoal({
            goal,
            manifest,
            events,
            projectRoot: project.root,
            ...(pluginTools.length > 0 ? { pluginTools } : {}),
            ...(leaseRuntime !== undefined ? { lease: leaseRuntime } : {}),
            ...(acquiredLease !== undefined ? { acquiredLease } : {}),
          });
        })
        .then(
          (result) => {
            try {
              events.append({
                projectId: project.id,
                kind: 'goal.done',
                payload: { goalId: goal.goalId, ...(result !== undefined ? { result } : {}) },
              });
            } catch (err) {
              app.log.error({ err }, 'goal finished but goal.done event append failed');
            }
          },
          (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            try {
              events.append({
                projectId: project.id,
                kind: 'goal.failed',
                payload: { goalId: goal.goalId, error: message },
              });
            } catch {
              app.log.error({ err }, 'goal failed and event append also failed');
            }
          },
        )
        .finally(() => {
          // Release the lease once the run is fully done (the runner also stops
          // it via withLease/ownLease; release is idempotent in the store).
          acquiredLease?.stop();
        });

      return reply.code(202).send({ goalId: goal.goalId });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string; kind?: string } }>(
    '/api/projects/:id/events',
    async (req, reply) => {
      const project = registry.get(req.params.id);
      if (!project) {
        return reply.code(404).send({ error: `unknown project: ${req.params.id}` });
      }
      const rawLimit = Number(req.query.limit ?? '100');
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 1000) : 100;
      return events.query({ projectId: project.id, kind: req.query.kind, limit });
    },
  );

  // ---- Analytics ----

  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/api/projects/:id/analytics',
    async (req, reply) => {
      const project = registry.get(req.params.id);
      if (!project) {
        return reply.code(404).send({ error: `unknown project: ${req.params.id}` });
      }
      const since = typeof req.query.since === 'string' && req.query.since.length > 0 ? req.query.since : undefined;
      // Read off the live shared store (covers both in-memory and file-backed).
      return computeAnalytics(events, project.id, since);
    },
  );

  // ---- Memory: search / recent + graph ----

  app.get<{ Params: { id: string }; Querystring: { q?: string; limit?: string } }>(
    '/api/projects/:id/memory',
    async (req, reply) => {
      const project = registry.get(req.params.id);
      if (!project) {
        return reply.code(404).send({ error: `unknown project: ${req.params.id}` });
      }
      const store = await openMemory(project.root, project.id);
      if (!store) return { records: [] };
      try {
        const rawLimit = Number(req.query.limit ?? '50');
        const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 500) : 50;
        // A query searches; an empty query returns the strongest recent records
        // (search('', ...) yields nothing, so use a permissive token wildcard).
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        const records = q.length > 0 ? store.search(q, limit) : store.search(' ', limit);
        return { records };
      } finally {
        store.close?.();
      }
    },
  );

  app.get<{ Params: { id: string } }>('/api/projects/:id/memory/graph', async (req, reply) => {
    const project = registry.get(req.params.id);
    if (!project) {
      return reply.code(404).send({ error: `unknown project: ${req.params.id}` });
    }
    const store = await openMemory(project.root, project.id);
    if (!store) return { entities: [], relations: [] };
    try {
      return { entities: store.entities(), relations: store.relations() };
    } finally {
      store.close?.();
    }
  });

  // ---- Approvals ----

  app.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    '/api/projects/:id/approvals',
    async (req, reply) => {
      const project = registry.get(req.params.id);
      if (!project) {
        return reply.code(404).send({ error: `unknown project: ${req.params.id}` });
      }
      const pkg = await loadPolicyPkg();
      const dbPath = approvalsDbPath(project.root);
      if (!pkg || !existsSync(dbPath)) return { tickets: [] };
      const validStatuses = new Set(['pending', 'approved', 'denied', 'stale']);
      const status =
        typeof req.query.status === 'string' && validStatuses.has(req.query.status)
          ? (req.query.status as ApprovalTicket['status'])
          : undefined;
      const queue = new pkg.SqliteApprovalQueue(dbPath);
      try {
        return { tickets: queue.list(project.id, status) };
      } finally {
        queue.close();
      }
    },
  );

  app.post<{ Params: { ticketId: string }; Body: { approved?: unknown; by?: unknown; projectId?: unknown } }>(
    '/api/approvals/:ticketId/resolve',
    async (req, reply) => {
      const body = (req.body ?? {}) as { approved?: unknown; by?: unknown; projectId?: unknown };
      if (typeof body.approved !== 'boolean') {
        return reply.code(400).send({ error: 'body must be {"approved": true|false, "by"?: string, "projectId"?: string}' });
      }
      const pkg = await loadPolicyPkg();
      if (!pkg) return reply.code(503).send({ error: '@lunaris/policy unavailable' });
      const by = typeof body.by === 'string' && body.by.length > 0 ? body.by : 'ui';

      // Approval dbs are per-project; resolve in the project whose queue holds it.
      // If a projectId is supplied, target it; otherwise scan registered projects.
      const candidates = typeof body.projectId === 'string'
        ? registry.list().filter((p) => p.id === body.projectId)
        : registry.list();
      for (const project of candidates) {
        const dbPath = approvalsDbPath(project.root);
        if (!existsSync(dbPath)) continue;
        const queue = new pkg.SqliteApprovalQueue(dbPath);
        try {
          const resolved = queue.resolve(req.params.ticketId, body.approved, by);
          if (resolved !== undefined) return resolved;
        } finally {
          queue.close();
        }
      }
      return reply.code(404).send({ error: `unknown ticket: ${req.params.ticketId}` });
    },
  );

  // ---- Policy: read / update level + rules ----

  app.get<{ Params: { id: string } }>('/api/projects/:id/policy', async (req, reply) => {
    const project = registry.get(req.params.id);
    if (!project) {
      return reply.code(404).send({ error: `unknown project: ${req.params.id}` });
    }
    const pkg = await loadPolicyPkg();
    if (!pkg) return reply.code(503).send({ error: '@lunaris/policy unavailable' });
    return pkg.loadPolicy(project.root);
  });

  app.put<{ Params: { id: string }; Body: { level?: unknown } }>(
    '/api/projects/:id/policy',
    async (req, reply) => {
      const project = registry.get(req.params.id);
      if (!project) {
        return reply.code(404).send({ error: `unknown project: ${req.params.id}` });
      }
      const body = (req.body ?? {}) as { level?: unknown };
      const level = body.level;
      if (level !== 0 && level !== 1 && level !== 2 && level !== 3) {
        return reply.code(400).send({ error: 'body must be {"level": 0|1|2|3}' });
      }
      const pkg = await loadPolicyPkg();
      if (!pkg) return reply.code(503).send({ error: '@lunaris/policy unavailable' });
      // writeDefaultPolicy refuses to clobber; pass overwrite to set the level.
      pkg.writeDefaultPolicy(project.root, level as AutonomyLevel, true);
      return pkg.loadPolicy(project.root);
    },
  );

  // ---- Optimizer (propose-only): run / list proposals / resolve ----

  app.post<{ Params: { id: string }; Body: { sinceIso?: unknown; minSuggestionN?: unknown } }>(
    '/api/projects/:id/optimize',
    async (req, reply) => {
      const project = registry.get(req.params.id);
      if (!project) {
        return reply.code(404).send({ error: `unknown project: ${req.params.id}` });
      }
      const pkg = await loadOptimizerPkg();
      if (!pkg) return reply.code(503).send({ error: '@lunaris/optimizer unavailable' });
      const body = (req.body ?? {}) as { sinceIso?: unknown; minSuggestionN?: unknown };
      const sinceIso = typeof body.sinceIso === 'string' && body.sinceIso.length > 0 ? body.sinceIso : undefined;
      const minN =
        typeof body.minSuggestionN === 'number' && Number.isFinite(body.minSuggestionN)
          ? Math.max(1, Math.trunc(body.minSuggestionN))
          : undefined;
      mkdirSync(join(project.root, '.lunaris', 'state'), { recursive: true });
      try {
        // Read the LIVE shared event store (covers in-memory + file-backed).
        return pkg.runOptimizer({
          store: events,
          banditDbPath: banditDbPath(project.root),
          proposalDbPath: proposalDbPath(project.root),
          projectId: project.id,
          ...(sinceIso !== undefined ? { sinceIso } : {}),
          ...(minN !== undefined ? { minSuggestionN: minN } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: `optimize failed: ${message}` });
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    '/api/projects/:id/proposals',
    async (req, reply) => {
      const project = registry.get(req.params.id);
      if (!project) {
        return reply.code(404).send({ error: `unknown project: ${req.params.id}` });
      }
      const pkg = await loadOptimizerPkg();
      const dbPath = proposalDbPath(project.root);
      if (!pkg || !existsSync(dbPath)) return { proposals: [] };
      const valid = new Set(['pending', 'approved', 'rejected']);
      const status =
        typeof req.query.status === 'string' && valid.has(req.query.status)
          ? (req.query.status as 'pending' | 'approved' | 'rejected')
          : undefined;
      const store = new pkg.SqliteProposalStore(dbPath);
      try {
        return { proposals: store.list(project.id, status) };
      } finally {
        store.close();
      }
    },
  );

  app.post<{ Params: { proposalId: string }; Body: { approved?: unknown; projectId?: unknown } }>(
    '/api/proposals/:proposalId/resolve',
    async (req, reply) => {
      const body = (req.body ?? {}) as { approved?: unknown; projectId?: unknown };
      if (typeof body.approved !== 'boolean') {
        return reply.code(400).send({ error: 'body must be {"approved": true|false, "projectId"?: string}' });
      }
      const pkg = await loadOptimizerPkg();
      if (!pkg) return reply.code(503).send({ error: '@lunaris/optimizer unavailable' });
      // Proposal dbs are per-project; resolve in the project whose store holds it.
      const candidates =
        typeof body.projectId === 'string'
          ? registry.list().filter((p) => p.id === body.projectId)
          : registry.list();
      for (const project of candidates) {
        const dbPath = proposalDbPath(project.root);
        if (!existsSync(dbPath)) continue;
        const store = new pkg.SqliteProposalStore(dbPath);
        try {
          const resolved = store.resolve(req.params.proposalId, body.approved);
          // Propose-only: resolve records approved/rejected, never auto-applies.
          if (resolved !== undefined) return resolved;
        } finally {
          store.close();
        }
      }
      return reply.code(404).send({ error: `unknown proposal: ${req.params.proposalId}` });
    },
  );

  // ---- Plugins: list / enable / disable (per-project FilePluginHost) ----

  app.get<{ Params: { id: string } }>('/api/projects/:id/plugins', async (req, reply) => {
    const project = registry.get(req.params.id);
    if (!project) {
      return reply.code(404).send({ error: `unknown project: ${req.params.id}` });
    }
    const pkg = await loadPlugdPkg();
    if (!pkg) return { plugins: [] };
    try {
      const host = new pkg.FilePluginHost({ pluginsDir: pluginsDir(project.root) });
      // list() never imports plugin code; defensive when the dir is absent.
      return { plugins: host.list() };
    } catch {
      return { plugins: [] };
    }
  });

  app.post<{ Params: { id: string; pluginId: string } }>(
    '/api/projects/:id/plugins/:pluginId/enable',
    async (req, reply) => {
      const project = registry.get(req.params.id);
      if (!project) {
        return reply.code(404).send({ error: `unknown project: ${req.params.id}` });
      }
      if (!isSafePathSegment(req.params.pluginId)) {
        return reply.code(400).send({ error: 'invalid plugin id' });
      }
      const pkg = await loadPlugdPkg();
      if (!pkg) return reply.code(503).send({ error: '@lunaris/plugd unavailable' });
      const host = new pkg.FilePluginHost({ pluginsDir: pluginsDir(project.root) });
      host.enable(req.params.pluginId);
      return { plugins: host.list() };
    },
  );

  app.post<{ Params: { id: string; pluginId: string } }>(
    '/api/projects/:id/plugins/:pluginId/disable',
    async (req, reply) => {
      const project = registry.get(req.params.id);
      if (!project) {
        return reply.code(404).send({ error: `unknown project: ${req.params.id}` });
      }
      if (!isSafePathSegment(req.params.pluginId)) {
        return reply.code(400).send({ error: 'invalid plugin id' });
      }
      const pkg = await loadPlugdPkg();
      if (!pkg) return reply.code(503).send({ error: '@lunaris/plugd unavailable' });
      const host = new pkg.FilePluginHost({ pluginsDir: pluginsDir(project.root) });
      host.disable(req.params.pluginId);
      return { plugins: host.list() };
    },
  );

  // ---- Goal queue: list / push ----

  app.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    '/api/projects/:id/queue',
    async (req, reply) => {
      const project = registry.get(req.params.id);
      if (!project) {
        return reply.code(404).send({ error: `unknown project: ${req.params.id}` });
      }
      const pkg = await loadSchedulerPkg();
      const dbPath = queueDbPath(project.root);
      if (!pkg || !existsSync(dbPath)) return { goals: [] };
      const valid = new Set(['queued', 'leased', 'done', 'failed', 'dead']);
      const status =
        typeof req.query.status === 'string' && valid.has(req.query.status)
          ? (req.query.status as QueuedGoalStatus)
          : undefined;
      const queue = new pkg.SqliteGoalQueue(dbPath);
      try {
        return { goals: queue.list(project.id, status) };
      } finally {
        queue.close();
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { prompt?: unknown; priority?: unknown; source?: unknown } }>(
    '/api/projects/:id/queue',
    async (req, reply) => {
      const project = registry.get(req.params.id);
      if (!project) {
        return reply.code(404).send({ error: `unknown project: ${req.params.id}` });
      }
      const body = (req.body ?? {}) as { prompt?: unknown; priority?: unknown; source?: unknown };
      if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
        return reply.code(400).send({ error: 'body must be {"prompt": "...", "priority"?: number}' });
      }
      const pkg = await loadSchedulerPkg();
      if (!pkg) return reply.code(503).send({ error: '@lunaris/scheduler unavailable' });
      const priority = typeof body.priority === 'number' && Number.isFinite(body.priority) ? Math.trunc(body.priority) : 0;
      const source = typeof body.source === 'string' && body.source.length > 0 ? body.source : 'ui';
      const queue = new pkg.SqliteGoalQueue(queueDbPath(project.root));
      try {
        return await reply.code(201).send(queue.push({ projectId: project.id, prompt: body.prompt, priority, source }));
      } finally {
        queue.close();
      }
    },
  );

  // ---- Schedules: list / create / delete ----

  app.get<{ Params: { id: string } }>('/api/projects/:id/schedules', async (req, reply) => {
    const project = registry.get(req.params.id);
    if (!project) {
      return reply.code(404).send({ error: `unknown project: ${req.params.id}` });
    }
    const pkg = await loadSchedulerPkg();
    const dbPath = scheduleDbPath(project.root);
    if (!pkg || !existsSync(dbPath)) return { schedules: [] };
    const store = new pkg.SqliteScheduleStore(dbPath);
    try {
      return { schedules: store.list(project.id) };
    } finally {
      store.close();
    }
  });

  app.post<{ Params: { id: string }; Body: { cron?: unknown; prompt?: unknown; vars?: unknown; enabled?: unknown } }>(
    '/api/projects/:id/schedules',
    async (req, reply) => {
      const project = registry.get(req.params.id);
      if (!project) {
        return reply.code(404).send({ error: `unknown project: ${req.params.id}` });
      }
      const body = (req.body ?? {}) as { cron?: unknown; prompt?: unknown; vars?: unknown; enabled?: unknown };
      if (typeof body.cron !== 'string' || body.cron.length === 0) {
        return reply.code(400).send({ error: 'body must be {"cron": "* * * * *", "prompt": "..."}' });
      }
      if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
        return reply.code(400).send({ error: 'body must include a non-empty "prompt"' });
      }
      const pkg = await loadSchedulerPkg();
      if (!pkg) return reply.code(503).send({ error: '@lunaris/scheduler unavailable' });
      const vars =
        body.vars !== null && typeof body.vars === 'object' ? (body.vars as Record<string, string>) : undefined;
      const enabled = typeof body.enabled === 'boolean' ? body.enabled : undefined;
      const store = new pkg.SqliteScheduleStore(scheduleDbPath(project.root));
      try {
        return await reply.code(201).send(
          store.create({
            projectId: project.id,
            cron: body.cron,
            prompt: body.prompt,
            ...(vars !== undefined ? { vars } : {}),
            ...(enabled !== undefined ? { enabled } : {}),
          }),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: `invalid schedule: ${message}` });
      } finally {
        store.close();
      }
    },
  );

  app.delete<{ Params: { id: string; scheduleId: string } }>(
    '/api/projects/:id/schedules/:scheduleId',
    async (req, reply) => {
      const project = registry.get(req.params.id);
      if (!project) {
        return reply.code(404).send({ error: `unknown project: ${req.params.id}` });
      }
      const pkg = await loadSchedulerPkg();
      const dbPath = scheduleDbPath(project.root);
      if (!pkg || !existsSync(dbPath)) return reply.code(404).send({ error: `unknown schedule: ${req.params.scheduleId}` });
      const store = new pkg.SqliteScheduleStore(dbPath);
      try {
        const ok = store.delete(req.params.scheduleId);
        if (!ok) return reply.code(404).send({ error: `unknown schedule: ${req.params.scheduleId}` });
        return { deleted: req.params.scheduleId };
      } finally {
        store.close();
      }
    },
  );

  // ---- Trigger rules: list / create / delete ----

  app.get<{ Params: { id: string } }>('/api/projects/:id/triggers', async (req, reply) => {
    const project = registry.get(req.params.id);
    if (!project) {
      return reply.code(404).send({ error: `unknown project: ${req.params.id}` });
    }
    const pkg = await loadSchedulerPkg();
    const dbPath = triggerDbPath(project.root);
    if (!pkg || !existsSync(dbPath)) return { triggers: [] };
    const store = new pkg.SqliteTriggerStore(dbPath);
    try {
      return { triggers: store.list(project.id) };
    } finally {
      store.close();
    }
  });

  app.post<{
    Params: { id: string };
    Body: { source?: unknown; eventTypes?: unknown; promptTemplate?: unknown; enabled?: unknown };
  }>('/api/projects/:id/triggers', async (req, reply) => {
    const project = registry.get(req.params.id);
    if (!project) {
      return reply.code(404).send({ error: `unknown project: ${req.params.id}` });
    }
    const body = (req.body ?? {}) as {
      source?: unknown;
      eventTypes?: unknown;
      promptTemplate?: unknown;
      enabled?: unknown;
    };
    if (typeof body.source !== 'string' || body.source.length === 0) {
      return reply.code(400).send({ error: 'body must be {"source": "github", "eventTypes": [...], "promptTemplate": "..."}' });
    }
    const eventTypes = Array.isArray(body.eventTypes)
      ? body.eventTypes.filter((x): x is string => typeof x === 'string')
      : [];
    if (eventTypes.length === 0) {
      return reply.code(400).send({ error: '"eventTypes" must be a non-empty string array' });
    }
    if (typeof body.promptTemplate !== 'string' || body.promptTemplate.length === 0) {
      return reply.code(400).send({ error: '"promptTemplate" must be a non-empty string' });
    }
    const pkg = await loadSchedulerPkg();
    if (!pkg) return reply.code(503).send({ error: '@lunaris/scheduler unavailable' });
    const enabled = typeof body.enabled === 'boolean' ? body.enabled : undefined;
    const store = new pkg.SqliteTriggerStore(triggerDbPath(project.root));
    try {
      return await reply.code(201).send(
        store.create({
          projectId: project.id,
          source: body.source,
          eventTypes,
          promptTemplate: body.promptTemplate,
          ...(enabled !== undefined ? { enabled } : {}),
        }),
      );
    } finally {
      store.close();
    }
  });

  app.delete<{ Params: { id: string; triggerId: string } }>(
    '/api/projects/:id/triggers/:triggerId',
    async (req, reply) => {
      const project = registry.get(req.params.id);
      if (!project) {
        return reply.code(404).send({ error: `unknown project: ${req.params.id}` });
      }
      const pkg = await loadSchedulerPkg();
      const dbPath = triggerDbPath(project.root);
      if (!pkg || !existsSync(dbPath)) return reply.code(404).send({ error: `unknown trigger: ${req.params.triggerId}` });
      const store = new pkg.SqliteTriggerStore(dbPath);
      try {
        const ok = store.delete(req.params.triggerId);
        if (!ok) return reply.code(404).send({ error: `unknown trigger: ${req.params.triggerId}` });
        return { deleted: req.params.triggerId };
      } finally {
        store.close();
      }
    },
  );

  // ---- Webhook intake: POST /hooks/:projectId/:source ----
  //
  // Reads the RAW body (parsing is suppressed for this route via a content-type
  // parser below) and verifies an HMAC-SHA256 signature against a per-project
  // secret. If no secret is configured, the request is accepted ONLY from
  // loopback (the daemon binds 127.0.0.1, so this is normally always true) and
  // a warning is logged. Matched trigger rules enqueue goals.
  app.post<{ Params: { projectId: string; source: string }; Headers: Record<string, string> }>(
    '/hooks/:projectId/:source',
    async (req, reply) => {
      const project = registry.get(req.params.projectId);
      if (!project) {
        return reply.code(404).send({ error: `unknown project: ${req.params.projectId}` });
      }
      const pkg = await loadSchedulerPkg();
      if (!pkg) return reply.code(503).send({ error: '@lunaris/scheduler unavailable' });

      const raw = (req as unknown as { rawBody?: string }).rawBody ?? '';
      const secret = webhookSecretFor(project.id);
      const headers = req.headers as Record<string, string | string[] | undefined>;
      const sigHeader =
        (headers['x-hub-signature-256'] as string | undefined) ??
        (headers['x-signature-256'] as string | undefined) ??
        (headers['x-lunaris-signature'] as string | undefined) ??
        '';

      if (secret !== undefined && secret.length > 0) {
        if (!pkg.verifyHmac(secret, raw, sigHeader)) {
          return reply.code(401).send({ error: 'invalid webhook signature' });
        }
      } else {
        const ip = req.ip ?? '';
        const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
        if (!loopback) {
          return reply.code(401).send({ error: 'no webhook secret configured; non-loopback request refused' });
        }
        app.log.warn(
          { projectId: project.id, source: req.params.source },
          'webhook accepted without HMAC (no secret configured, loopback only)',
        );
      }

      // Parse the body as JSON (best-effort); eventType from a header or payload.
      let payload: unknown = {};
      if (raw.length > 0) {
        try {
          payload = JSON.parse(raw);
        } catch {
          payload = { body: raw };
        }
      }
      const eventType =
        (headers['x-github-event'] as string | undefined) ??
        (headers['x-event-type'] as string | undefined) ??
        (typeof (payload as { eventType?: unknown }).eventType === 'string'
          ? ((payload as { eventType: string }).eventType)
          : 'generic');

      const queue = new pkg.SqliteGoalQueue(queueDbPath(project.root));
      const store = new pkg.SqliteTriggerStore(triggerDbPath(project.root));
      try {
        const matched = store.routeEvent(req.params.source, eventType, payload, (projectId, prompt, src) => {
          queue.push({ projectId, prompt, source: src, priority: 0 });
        });
        return { matched: matched.length, eventType };
      } finally {
        store.close();
        queue.close();
      }
    },
  );

  // ---- Lifecycle: snapshot / restore / export (Phase 4) ----

  app.post<{ Params: { id: string }; Body: { kind?: unknown } }>(
    '/api/projects/:id/snapshot',
    async (req, reply) => {
      const project = registry.get(req.params.id);
      if (!project) {
        return reply.code(404).send({ error: `unknown project: ${req.params.id}` });
      }
      const pkg = await loadLifecyclePkg();
      if (!pkg) return reply.code(503).send({ error: '@lunaris/lifecycle unavailable' });
      const body = (req.body ?? {}) as { kind?: unknown };
      const kind = body.kind === 'pre-op' ? 'pre-op' : 'full';
      try {
        return await reply.code(201).send(pkg.snapshot(project.root, { kind }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: `snapshot failed: ${message}` });
      }
    },
  );

  app.get<{ Params: { id: string } }>('/api/projects/:id/snapshots', async (req, reply) => {
    const project = registry.get(req.params.id);
    if (!project) {
      return reply.code(404).send({ error: `unknown project: ${req.params.id}` });
    }
    const pkg = await loadLifecyclePkg();
    if (!pkg) return { snapshots: [] };
    try {
      return { snapshots: pkg.listSnapshots(project.root) };
    } catch {
      return { snapshots: [] };
    }
  });

  app.post<{ Params: { id: string }; Body: { snapshotId?: unknown; dryRun?: unknown; force?: unknown } }>(
    '/api/projects/:id/restore',
    async (req, reply) => {
      const project = registry.get(req.params.id);
      if (!project) {
        return reply.code(404).send({ error: `unknown project: ${req.params.id}` });
      }
      const body = (req.body ?? {}) as { snapshotId?: unknown; dryRun?: unknown; force?: unknown };
      if (typeof body.snapshotId !== 'string' || body.snapshotId.length === 0) {
        return reply.code(400).send({ error: 'body must be {"snapshotId": "...", "dryRun"?: boolean, "force"?: boolean}' });
      }
      const pkg = await loadLifecyclePkg();
      if (!pkg) return reply.code(503).send({ error: '@lunaris/lifecycle unavailable' });
      const dryRun = body.dryRun === true;
      // FIX 7: `force` is required to write back secrets/instance.json; off by
      // default so a restore never re-introduces secret material.
      const force = body.force === true;
      try {
        return pkg.restore(project.root, body.snapshotId, { dryRun, force });
      } catch (err) {
        // FIX 7: a cross-project restore is a client error (409), not a 404.
        if (err instanceof Error && (err as { code?: string }).code === 'PROJECT_MISMATCH') {
          return reply.code(409).send({ error: err.message });
        }
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(404).send({ error: `restore failed: ${message}` });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { outPath?: unknown; name?: unknown } }>(
    '/api/projects/:id/export',
    async (req, reply) => {
      const project = registry.get(req.params.id);
      if (!project) {
        return reply.code(404).send({ error: `unknown project: ${req.params.id}` });
      }
      const pkg = await loadLifecyclePkg();
      if (!pkg) return reply.code(503).send({ error: '@lunaris/lifecycle unavailable' });
      const body = (req.body ?? {}) as { outPath?: unknown; name?: unknown };
      const outPath =
        typeof body.outPath === 'string' && body.outPath.length > 0
          ? body.outPath
          : join(project.root, '.lunaris', `${project.id}.bundle.tar.gz`);
      const name = typeof body.name === 'string' && body.name.length > 0 ? body.name : project.name;
      try {
        const manifest = pkg.exportBundle(project.root, outPath, { name });
        return await reply.code(201).send({ outPath, manifest });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: `export failed: ${message}` });
      }
    },
  );

  // ---- WS: live event stream ----

  app.get('/api/ws', { websocket: true }, (socket, req) => {
    // WS auth (FIX 3): when auth is ON, require a short-lived SINGLE-USE ticket
    // (minted via POST /api/ws-ticket) on the upgrade — NOT the long-lived bearer
    // token, which must never appear in a URL/log. The bearer token is therefore
    // explicitly rejected here: it is not a valid ws-ticket.
    if (authMode === 'on') {
      const query = req.query as Record<string, unknown> | undefined;
      const ticket = query !== undefined && typeof query['ticket'] === 'string' ? query['ticket'] : undefined;
      const principalId = consumeWsTicket(ticket, Date.now());
      if (principalId === null) {
        try {
          socket.close(1008, 'unauthorized');
        } catch {
          /* ignore */
        }
        return;
      }
    }
    let active = true;
    const unsubscribe = events.subscribe((e) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(e));
      }
    });
    const stop = (): void => {
      if (active) {
        active = false;
        unsubscribe();
      }
    };
    socket.on('close', stop);
    socket.on('error', stop);
  });

  // ---- Static UI (root route) ----

  const uiDist = options.uiDistPath ?? defaultUiDistPath();
  if (existsSync(uiDist)) {
    await app.register(fastifyStatic, { root: uiDist });
  } else {
    app.get('/', async () => ({
      name: 'lunarisd',
      version,
      ui: false,
      hint: 'UI not built; API under /api, events over ws://127.0.0.1/api/ws',
    }));
  }

  return app;
}
