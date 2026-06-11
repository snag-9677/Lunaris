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
  QueuedGoalStatus,
  ResolvedTool,
} from '@lunaris/core';
import { ProjectRegistry } from './registry.js';
import { approvalsDbPath, defaultGoalRunner, memoryDbPath } from './goal-runner.js';
import type { GoalRunner } from './goal-runner.js';
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

  const app = Fastify({ logger: options.logger ?? false });
  enforceLoopbackOnly(app);
  app.decorate('lunaris', { events, registry });

  app.addHook('onClose', async () => {
    (events as EventStore & { close?: () => void }).close?.();
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
