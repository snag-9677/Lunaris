/**
 * Phase 4 `lun` commands: auth (login/whoami), lifecycle (snapshot/restore/
 * export/adopt), lease, and version.
 *
 * Auth uses the local SqliteIdentityStore (~/.lunaris/identity.db) directly —
 * the CLI is a loopback control-plane tool, so it can talk to the embedded
 * identity store rather than going through the daemon's HTTP API. The bearer
 * token from a successful login is cached at ~/.lunaris/cli-token (0600) for
 * subsequent authenticated daemon calls.
 *
 * Lifecycle/lease/version go through the workspace packages directly against the
 * project's .lunaris state, mirroring the dynamic-import + symbol-lookup style
 * the rest of commands.ts uses so a sibling package being unbuilt degrades
 * gracefully rather than crashing.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  BundleManifest,
  Capability,
  DoctorReport,
  Lease,
  Principal,
  RbacRole,
  Session,
  SnapshotInfo,
  VersionInfo,
} from '@lunaris/core';
import {
  formatBundleManifest,
  formatDoctorReport,
  formatLeaseLine,
  formatSnapshotLine,
  formatWhoami,
} from './format.js';

const MANIFEST_HINT = 'No lunaris.toml found here — run `lun init` first.';

function fail(err: unknown): 1 {
  console.error(err instanceof Error ? err.message : String(err));
  return 1;
}

async function loadModule(specifier: string): Promise<Record<string, unknown>> {
  const mod: unknown = await import(specifier);
  return mod as Record<string, unknown>;
}

function pick<T>(mod: Record<string, unknown>, names: readonly string[], what: string): T {
  for (const name of names) {
    const value = mod[name];
    if (value !== undefined) return value as T;
  }
  throw new Error(`${what} not found (looked for export(s): ${names.join(', ')})`);
}

async function loadProjectId(cwd: string): Promise<string> {
  if (!existsSync(join(cwd, 'lunaris.toml'))) throw new Error(MANIFEST_HINT);
  const core = await loadModule('@lunaris/core');
  const load = pick<(root: string) => unknown>(core, ['loadManifest', 'readManifest'], '@lunaris/core manifest loader');
  const manifest = (await Promise.resolve(load(cwd))) as { project?: { id?: string } };
  const id = manifest.project?.id;
  if (typeof id !== 'string' || id.length === 0) throw new Error(MANIFEST_HINT);
  return id;
}

/* ---------- token cache ---------- */

export function cliTokenPath(): string {
  return join(homedir(), '.lunaris', 'cli-token');
}
export function identityDbPath(): string {
  return join(homedir(), '.lunaris', 'identity.db');
}
export function leasesDbPath(): string {
  return join(homedir(), '.lunaris', 'leases.db');
}
export function eventsDbPath(): string {
  return join(homedir(), '.lunaris', 'events.db');
}

export function readCliToken(): string | undefined {
  const path = cliTokenPath();
  if (!existsSync(path)) return undefined;
  try {
    const t = readFileSync(path, 'utf8').trim();
    return t.length > 0 ? t : undefined;
  } catch {
    return undefined;
  }
}

function writeCliToken(token: string): void {
  const path = cliTokenPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort on platforms without chmod semantics */
  }
}

/* ---------- structural views of @lunaris/identity ---------- */

interface IdentityStoreLike {
  ensureLocalOwner(displayName?: string): Principal;
  authenticate(
    displayName: string,
    password: string,
    now?: Date,
  ): { ok: boolean; principal?: Principal; session?: Session; token?: string; reason?: string };
  resolveToken(token: string, now?: Date): { principal: Principal; session: Session } | null;
  roleFor(principalId: string, projectId: string): RbacRole | null;
  can(principalId: string, projectId: string, cap: Capability): boolean;
  close(): void;
}

async function openIdentity(): Promise<IdentityStoreLike> {
  const mod = await loadModule('@lunaris/identity');
  const Ctor = pick<new (dbPath: string) => IdentityStoreLike>(
    mod,
    ['SqliteIdentityStore'],
    '@lunaris/identity SqliteIdentityStore',
  );
  mkdirSync(dirname(identityDbPath()), { recursive: true });
  return new Ctor(identityDbPath());
}

/* ---------- lun login ---------- */

export interface LoginOptions {
  user?: string;
  password?: string;
}

export async function runLogin(opts: LoginOptions = {}): Promise<number> {
  try {
    const user = opts.user ?? 'local';
    const password = opts.password ?? '';
    const identity = await openIdentity();
    try {
      // Bootstrap a loopback owner if no users exist yet (zero-config default).
      identity.ensureLocalOwner('local');
      const result = identity.authenticate(user, password);
      if (!result.ok || result.token === undefined || result.principal === undefined) {
        if (opts.password === undefined && result.reason === 'no credential') {
          // The default loopback owner is passwordless and used implicitly when
          // auth is OFF; explicit login only applies to password-backed users.
          console.error(
            'no password set for this user — the loopback owner is used implicitly (auth off). ' +
              'Set LUNARIS_AUTH=on and create a password-backed user to log in.',
          );
        } else {
          console.error('login failed: invalid credentials');
        }
        return 1;
      }
      writeCliToken(result.token);
      console.log(`logged in as ${result.principal.displayName} (${result.principal.id})`);
      console.log(`token cached at ${cliTokenPath()}`);
      return 0;
    } finally {
      identity.close();
    }
  } catch (err) {
    return fail(err);
  }
}

/* ---------- lun whoami ---------- */

export async function runWhoami(cwd: string): Promise<number> {
  try {
    const identity = await openIdentity();
    try {
      const token = readCliToken();
      let principal: Principal | undefined;
      if (token !== undefined) {
        const resolved = identity.resolveToken(token);
        if (resolved !== null) principal = resolved.principal;
      }
      if (principal === undefined) {
        // Fall back to the implicit loopback owner (auth-off default).
        principal = identity.ensureLocalOwner('local');
      }
      const role = identity.roleFor(principal.id, 'global');
      for (const line of formatWhoami(principal, role)) console.log(line);
      return 0;
    } finally {
      identity.close();
    }
  } catch (err) {
    return fail(err);
  }
}

/* ---------- structural view of @lunaris/lifecycle ---------- */

interface LifecyclePkgLike {
  snapshot(projectRoot: string, opts?: { kind?: 'full' | 'pre-op' }): SnapshotInfo;
  listSnapshots(projectRoot: string): SnapshotInfo[];
  restore(projectRoot: string, snapshotId: string, opts?: { dryRun?: boolean }): { restored: string[]; dryRun: boolean };
  exportBundle(projectRoot: string, outPath: string, opts?: { name?: string }): BundleManifest;
  adopt(projectRoot: string, opts?: { skipFingerprint?: boolean }): {
    identity: { projectId: string; instanceId: string };
    instanceCreated: boolean;
    createdDirs: string[];
    alreadyAdopted: boolean;
  };
}

async function openLifecycle(): Promise<LifecyclePkgLike> {
  return (await loadModule('@lunaris/lifecycle')) as unknown as LifecyclePkgLike;
}

/* ---------- lun snapshot [list|create] ---------- */

export interface SnapshotOptions {
  action?: 'list' | 'create';
}

export async function runSnapshot(cwd: string, opts: SnapshotOptions = {}): Promise<number> {
  try {
    await loadProjectId(cwd);
    const pkg = await openLifecycle();
    if (opts.action === 'create') {
      const info = pkg.snapshot(cwd, { kind: 'full' });
      console.log(`created ${formatSnapshotLine(info)}`);
      return 0;
    }
    const list = pkg.listSnapshots(cwd);
    if (list.length === 0) {
      console.log('no snapshots');
    } else {
      for (const s of list) console.log(formatSnapshotLine(s));
    }
    return 0;
  } catch (err) {
    return fail(err);
  }
}

/* ---------- lun restore <id> [--dry-run] ---------- */

export async function runRestore(cwd: string, snapshotId: string, dryRun = false): Promise<number> {
  try {
    await loadProjectId(cwd);
    const pkg = await openLifecycle();
    const result = pkg.restore(cwd, snapshotId, { dryRun });
    const verb = result.dryRun ? 'would restore' : 'restored';
    console.log(`${verb} ${result.restored.length} file(s)${result.dryRun ? ' (dry run)' : ''}`);
    for (const f of result.restored) console.log(`  ${f}`);
    return 0;
  } catch (err) {
    return fail(err);
  }
}

/* ---------- lun export [--out <path>] ---------- */

export async function runExport(cwd: string, outPath?: string): Promise<number> {
  try {
    const projectId = await loadProjectId(cwd);
    const pkg = await openLifecycle();
    const out = outPath ?? join(cwd, '.lunaris', `${projectId}.bundle.tar.gz`);
    mkdirSync(dirname(out), { recursive: true });
    const manifest = pkg.exportBundle(cwd, out);
    console.log(`exported bundle → ${out}`);
    for (const line of formatBundleManifest(manifest)) console.log(line);
    return 0;
  } catch (err) {
    return fail(err);
  }
}

/* ---------- lun adopt ---------- */

export async function runAdopt(cwd: string): Promise<number> {
  try {
    if (!existsSync(join(cwd, 'lunaris.toml'))) throw new Error(MANIFEST_HINT);
    const pkg = await openLifecycle();
    const report = pkg.adopt(cwd);
    if (report.alreadyAdopted) {
      console.log(`already adopted (instance ${report.identity.instanceId})`);
    } else {
      console.log(`adopted project ${report.identity.projectId}`);
      console.log(`  instance: ${report.identity.instanceId}`);
      for (const d of report.createdDirs) console.log(`  created ${d}`);
    }
    return 0;
  } catch (err) {
    return fail(err);
  }
}

/* ---------- lun lease ---------- */

interface LeaseStoreLike {
  current(repoId: string, now?: Date): Lease | null;
  close(): void;
}

export async function runLease(cwd: string): Promise<number> {
  try {
    const projectId = await loadProjectId(cwd);
    if (!existsSync(leasesDbPath())) {
      console.log('no lease held (no leases db yet)');
      return 0;
    }
    const mod = await loadModule('@lunaris/identity');
    const Ctor = pick<new (dbPath: string) => LeaseStoreLike>(
      mod,
      ['SqliteLeaseStore'],
      '@lunaris/identity SqliteLeaseStore',
    );
    const store = new Ctor(leasesDbPath());
    try {
      const lease = store.current(projectId);
      if (lease === null) {
        console.log(`no live lease for ${projectId}`);
      } else {
        console.log(formatLeaseLine(lease));
      }
      return 0;
    } finally {
      store.close();
    }
  } catch (err) {
    return fail(err);
  }
}

/* ---------- lun version ---------- */

interface DoctorFn {
  (dbPaths: Record<string, string>): DoctorReport;
}

export async function runVersion(cwd: string): Promise<number> {
  try {
    const core = await loadModule('@lunaris/core');
    const currentVersionInfo = pick<() => VersionInfo>(
      core,
      ['currentVersionInfo'],
      '@lunaris/core currentVersionInfo',
    );
    const doctor = pick<DoctorFn>(core, ['doctor'], '@lunaris/core doctor');
    const version = currentVersionInfo();

    // Discover db paths: project-local state + global stores under ~/.lunaris.
    const dbPaths: Record<string, string> = {};
    const stateDir = join(cwd, '.lunaris', 'state');
    const projectStores: Record<string, string> = {
      memory: join(stateDir, 'memory.db'),
      approvals: join(stateDir, 'approvals.db'),
      proposals: join(stateDir, 'proposals.db'),
      routing_arms: join(stateDir, 'bandit.db'),
      queued_goals: join(stateDir, 'queue.db'),
      schedules: join(stateDir, 'schedules.db'),
      trigger_rules: join(stateDir, 'triggers.db'),
      events: join(stateDir, 'events.db'),
    };
    const globalStores: Record<string, string> = {
      identity: identityDbPath(),
      leases: leasesDbPath(),
    };
    for (const [store, path] of Object.entries({ ...projectStores, ...globalStores })) {
      if (existsSync(path)) dbPaths[store] = path;
    }

    const report = doctor(dbPaths);
    for (const line of formatDoctorReport(version, report)) console.log(line);
    return 0;
  } catch (err) {
    return fail(err);
  }
}
