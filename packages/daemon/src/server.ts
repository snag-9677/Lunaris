/**
 * lunarisd HTTP + WS server.
 *
 * SECURITY (Phase 1, spec §15/§17): the daemon binds 127.0.0.1 ONLY. The
 * listen() method is wrapped so any attempt to bind a non-loopback host is
 * refused, and the host is hard-forced to 127.0.0.1 regardless.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
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
  PolicyRule,
} from '@lunaris/core';
import { ProjectRegistry } from './registry.js';
import { approvalsDbPath, defaultGoalRunner, memoryDbPath } from './goal-runner.js';
import type { GoalRunner } from './goal-runner.js';

const LOOPBACK_HOST = '127.0.0.1';
const ALLOWED_HOSTS = new Set<string>([LOOPBACK_HOST, 'localhost', '::1']);

export interface LunarisServerContext {
  events: EventStore;
  registry: ProjectRegistry;
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

  const app = Fastify({ logger: options.logger ?? false });
  enforceLoopbackOnly(app);
  app.decorate('lunaris', { events, registry });

  app.addHook('onClose', async () => {
    (events as EventStore & { close?: () => void }).close?.();
  });

  await app.register(websocket);

  // ---- API routes ----

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
      events.append({ projectId: project.id, kind: 'goal.created', payload: goal });

      // Run asynchronously: respond immediately; terminal state lands as an
      // event — goal.done (carrying the ResultEnvelope) when the run resolves,
      // goal.failed when it rejects.
      void Promise.resolve()
        .then(() => runGoal({ goal, manifest, events, projectRoot: project.root }))
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
        );

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

  // ---- WS: live event stream ----

  app.get('/api/ws', { websocket: true }, (socket) => {
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
