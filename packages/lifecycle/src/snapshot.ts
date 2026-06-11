/**
 * Snapshot / restore of per-project Lunaris state. A snapshot is a gzipped
 * archive (see archive.ts) of .lunaris/state/**, .lunaris/memory/** and
 * .lunaris/journal/**, EXCLUDING secrets (T3) and instance.json (T1) by
 * default. Snapshots are written to <root>/.lunaris/snapshots/<id>.tar.gz.
 *
 * Stop-the-world coordination (quiescing the orchestrator) is the daemon
 * caller's concern; this module only reads/writes files. Restore extracts the
 * archive back over the project root; dryRun reports the file list without
 * touching disk.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadManifest, uuidv7 } from '@lunaris/core';
import type { SnapshotInfo } from '@lunaris/core';
import { type PackEntry, packArchive, readArchiveMeta, unpackArchive } from './archive.js';
import { journalDir, LUNARIS_DIR, memoryDir, relToAbs, snapshotsDir, stateDir, walkFiles } from './paths.js';

/**
 * FIX 7: paths that restore() must NOT write back unless `force` is set. A
 * snapshot taken with includeExcluded would carry secrets (T3) and the
 * machine-local instance.json (T1); blindly extracting them would re-introduce
 * secret material and collide instance ids. These are skipped by default.
 */
function isProtectedOnRestore(rel: string): boolean {
  if (rel === `${LUNARIS_DIR}/state/instance.json`) return true;
  if (rel === `${LUNARIS_DIR}/secrets` || rel.startsWith(`${LUNARIS_DIR}/secrets/`)) return true;
  return false;
}

export interface SnapshotMeta {
  id: string;
  projectId: string;
  createdAt: string;
  kind: 'full' | 'pre-op';
  paths: string[];
}

export interface SnapshotOptions {
  kind?: 'full' | 'pre-op';
  now?: () => Date;
  /** Include normally-excluded secret/instance files (default false). */
  includeExcluded?: boolean;
}

function collectStateFiles(
  projectRoot: string,
  includeExcluded: boolean,
): { abs: string; rel: string }[] {
  const dirs = [stateDir(projectRoot), memoryDir(projectRoot), journalDir(projectRoot)];
  const files: { abs: string; rel: string }[] = [];
  const seen = new Set<string>();
  for (const d of dirs) {
    for (const f of walkFiles(projectRoot, d, includeExcluded)) {
      if (!seen.has(f.rel)) {
        seen.add(f.rel);
        files.push(f);
      }
    }
  }
  return files;
}

/**
 * Snapshot the per-project state into <root>/.lunaris/snapshots/<id>.tar.gz.
 * Returns SnapshotInfo. The snapshot id is a uuidv7 (time-ordered, so
 * listSnapshots can order by id).
 */
export function snapshot(projectRoot: string, opts: SnapshotOptions = {}): SnapshotInfo {
  const now = opts.now ?? (() => new Date());
  const kind = opts.kind ?? 'full';
  const projectId = loadManifest(projectRoot).project.id;
  const id = uuidv7();
  const createdAt = now().toISOString();

  const collected = collectStateFiles(projectRoot, opts.includeExcluded ?? false);
  const entries: PackEntry[] = collected.map((f) => ({ path: f.rel, data: readFileSync(f.abs) }));

  const meta: SnapshotMeta = {
    id,
    projectId,
    createdAt,
    kind,
    paths: entries.map((e) => e.path),
  };
  const archive = packArchive(entries, meta);

  const dir = snapshotsDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.tar.gz`);
  writeFileSync(path, archive);

  return { id, projectId, createdAt, bytes: archive.length, kind, path };
}

function snapshotPath(projectRoot: string, id: string): string {
  return join(snapshotsDir(projectRoot), `${id}.tar.gz`);
}

/** List snapshots, newest first (ids are uuidv7 → lexicographically time-ordered). */
export function listSnapshots(projectRoot: string): SnapshotInfo[] {
  const dir = snapshotsDir(projectRoot);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const infos: SnapshotInfo[] = [];
  for (const name of names) {
    if (!name.endsWith('.tar.gz')) continue;
    const id = name.slice(0, -'.tar.gz'.length);
    const path = join(dir, name);
    let bytes = 0;
    let createdAt = '';
    let projectId = '';
    let kind: 'full' | 'pre-op' = 'full';
    try {
      bytes = statSync(path).size;
      const m = readArchiveMeta(readFileSync(path)).meta as SnapshotMeta | undefined;
      if (m) {
        createdAt = m.createdAt;
        projectId = m.projectId;
        kind = m.kind;
      }
    } catch {
      continue; // unreadable / corrupt snapshot — skip from listing
    }
    infos.push({ id, projectId, createdAt, bytes, kind, path });
  }
  infos.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return infos;
}

export interface RestoreResult {
  /** project-root-relative paths that were (or would be) written. */
  restored: string[];
  dryRun: boolean;
  /**
   * FIX 7: protected paths (secrets/instance.json) present in the archive that
   * were SKIPPED because `force` was not set. Empty when none were skipped.
   */
  skipped: string[];
}

export interface RestoreOptions {
  dryRun?: boolean;
  /**
   * FIX 7: write back ALL archive entries, including secrets/** and
   * instance.json. Off by default so a restore never re-introduces secret
   * material or collides instance ids. Use only for a deliberate full restore.
   */
  force?: boolean;
}

/** Thrown when a snapshot's recorded projectId does not match the target project. */
export class ProjectMismatchError extends Error {
  readonly code = 'PROJECT_MISMATCH';
  constructor(
    readonly snapshotProjectId: string,
    readonly targetProjectId: string,
  ) {
    super(
      `snapshot belongs to project "${snapshotProjectId}" but the target project is "${targetProjectId}"; refusing to restore across projects`,
    );
    this.name = 'ProjectMismatchError';
  }
}

/**
 * Extract a snapshot back into place under projectRoot. Files are written to
 * their recorded relative paths (parent dirs created). dryRun returns the file
 * list without writing anything. Stop-the-world / process quiescing is the
 * daemon's responsibility — by the time restore runs, nothing should be
 * concurrently writing the state dirs.
 *
 * FIX 7:
 *  - The snapshot's recorded meta.projectId MUST equal the target project's id
 *    (from lunaris.toml); a mismatch throws ProjectMismatchError BEFORE any
 *    write, so a snapshot can never be restored over a different project.
 *  - secrets/** and state/instance.json are NOT written back unless `force` is
 *    set, so a snapshot taken with includeExcluded cannot re-introduce secret
 *    material or collide instance ids on restore.
 */
export function restore(
  projectRoot: string,
  snapshotId: string,
  opts: RestoreOptions = {},
): RestoreResult {
  const path = snapshotPath(projectRoot, snapshotId);
  const archive = unpackArchive(readFileSync(path));

  // FIX 7: refuse to restore a snapshot whose project differs from the target.
  const meta = archive.meta as { projectId?: unknown } | undefined;
  const snapshotProjectId = typeof meta?.projectId === 'string' ? meta.projectId : undefined;
  if (snapshotProjectId !== undefined) {
    const targetProjectId = loadManifest(projectRoot).project.id;
    if (snapshotProjectId !== targetProjectId) {
      throw new ProjectMismatchError(snapshotProjectId, targetProjectId);
    }
  }

  const force = opts.force === true;
  const restored: string[] = [];
  const skipped: string[] = [];
  for (const e of archive.entries) {
    // FIX 7: never re-introduce secrets/instance.json unless explicitly forced.
    if (!force && isProtectedOnRestore(e.path)) {
      skipped.push(e.path);
      continue;
    }
    restored.push(e.path);
    if (opts.dryRun) continue;
    const abs = relToAbs(projectRoot, e.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, e.data);
  }
  return { restored, dryRun: opts.dryRun ?? false, skipped };
}

/**
 * Keep the newest `keep` snapshots; delete the rest. Returns the deleted ids.
 * `keep` is clamped to >= 0.
 */
export function pruneSnapshots(projectRoot: string, keep: number): string[] {
  const k = Math.max(0, Math.floor(keep));
  const all = listSnapshots(projectRoot); // newest first
  const toDelete = all.slice(k);
  const deleted: string[] = [];
  for (const s of toDelete) {
    try {
      rmSync(s.path, { force: true });
      deleted.push(s.id);
    } catch {
      // best-effort prune
    }
  }
  return deleted;
}
