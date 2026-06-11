/**
 * Project identity v2 (Phase 4). Two-level identity:
 *
 *  - projectId  — the COMMITTED lineage id, read from lunaris.toml. Travels with
 *                 every clone/fork; identifies the project's ancestry.
 *  - instanceId — MACHINE-LOCAL, minted fresh (uuidv7) the first time we touch a
 *                 working tree. Stored in <root>/.lunaris/state/instance.json,
 *                 which is gitignored. KEY INVARIANT: secrets and local state are
 *                 keyed by instanceId, so a clone never inherits another tree's
 *                 instanceId and secrets/state can never collide across clones.
 *
 * A best-effort fingerprint (git remote + root commit) lets us detect when a
 * working tree has MOVED (path changed) or FORKED (lineage diverged) since the
 * instance.json was written.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadManifest, uuidv7 } from '@lunaris/core';
import type { ProjectIdentity } from '@lunaris/core';
import { instanceFile, stateDir } from './paths.js';

interface StoredIdentity {
  instanceId: string;
  projectId: string;
  fingerprint?: string;
  /** absolute path of the working tree when this file was written (move detect). */
  root?: string;
  createdAt: string;
}

function runGit(projectRoot: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined; // not a git repo / git missing / no commits — tolerate
  }
}

/**
 * Best-effort canonical fingerprint of the project lineage: the origin remote
 * URL plus the repository's ROOT commit (first commit), which is stable across
 * a linear history and distinguishes independently-created repos. Returns
 * undefined when not a git repo (caller tolerates this).
 */
export function computeFingerprint(projectRoot: string): string | undefined {
  const remote =
    runGit(projectRoot, ['config', '--get', 'remote.origin.url']) ?? '';
  // `--max-parents=0` lists root commit(s); take the first line.
  const rootCommit = (
    runGit(projectRoot, ['rev-list', '--max-parents=0', 'HEAD']) ?? ''
  )
    .split('\n')[0]
    ?.trim();
  if (remote === '' && (rootCommit === undefined || rootCommit === '')) {
    return undefined;
  }
  return `remote:${remote}|root:${rootCommit ?? ''}`;
}

function readProjectId(projectRoot: string): string {
  return loadManifest(projectRoot).project.id;
}

function readStored(projectRoot: string): StoredIdentity | undefined {
  const file = instanceFile(projectRoot);
  if (!existsSync(file)) return undefined;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredIdentity>;
    if (typeof data.instanceId === 'string' && data.instanceId.length > 0) {
      return data as StoredIdentity;
    }
  } catch {
    // Corrupt instance.json → treated as absent; ensureInstanceId re-mints.
  }
  return undefined;
}

function toIdentity(stored: StoredIdentity): ProjectIdentity {
  const id: ProjectIdentity = {
    projectId: stored.projectId,
    instanceId: stored.instanceId,
  };
  if (stored.fingerprint !== undefined) id.fingerprint = stored.fingerprint;
  return id;
}

export interface EnsureInstanceOptions {
  /** Skip git fingerprint computation (faster / hermetic tests). */
  skipFingerprint?: boolean;
  now?: () => Date;
}

/**
 * Read or create <root>/.lunaris/state/instance.json. The first call mints a
 * fresh instanceId (uuidv7); subsequent calls return the SAME instanceId. The
 * committed projectId is (re)synced from lunaris.toml each call. Returns the
 * resolved ProjectIdentity.
 */
export function ensureInstanceId(
  projectRoot: string,
  opts: EnsureInstanceOptions = {},
): ProjectIdentity {
  const now = opts.now ?? (() => new Date());
  const projectId = readProjectId(projectRoot);
  const fingerprint = opts.skipFingerprint ? undefined : computeFingerprint(projectRoot);

  const existing = readStored(projectRoot);
  if (existing !== undefined) {
    // Reuse the machine-local instanceId; refresh projectId + (best-effort)
    // fingerprint so a renamed lineage / new remote is reflected, but NEVER
    // re-mint the instanceId.
    const merged: StoredIdentity = {
      ...existing,
      projectId,
      root: projectRoot,
    };
    if (fingerprint !== undefined) merged.fingerprint = fingerprint;
    // Only rewrite if something user-visible changed (avoid churn).
    if (
      merged.projectId !== existing.projectId ||
      merged.fingerprint !== existing.fingerprint ||
      merged.root !== existing.root
    ) {
      writeStored(projectRoot, merged);
    }
    return toIdentity(merged);
  }

  const stored: StoredIdentity = {
    instanceId: uuidv7(),
    projectId,
    root: projectRoot,
    createdAt: now().toISOString(),
  };
  if (fingerprint !== undefined) stored.fingerprint = fingerprint;
  writeStored(projectRoot, stored);
  return toIdentity(stored);
}

function writeStored(projectRoot: string, stored: StoredIdentity): void {
  mkdirSync(stateDir(projectRoot), { recursive: true });
  writeFileSync(instanceFile(projectRoot), `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
}

export interface ForkStatus {
  /** instance.json exists for this tree. */
  hasInstance: boolean;
  /** working-tree path differs from the recorded root. */
  moved: boolean;
  /**
   * lineage fingerprint differs from the recorded one (different remote/root
   * commit) — i.e. this clone has diverged from the tree that minted instance.json.
   */
  forked: boolean;
  storedFingerprint?: string;
  currentFingerprint?: string;
}

/**
 * Compare the stored fingerprint/root against the current working tree.
 *  - moved:  the absolute root path changed (a copied/relocated checkout).
 *  - forked: the git lineage fingerprint changed (different remote or root commit).
 * When no fingerprint can be computed for the current tree, forked is false
 * (we don't flag a fork we can't prove).
 */
export function detectFork(projectRoot: string): ForkStatus {
  const stored = readStored(projectRoot);
  if (stored === undefined) {
    return { hasInstance: false, moved: false, forked: false };
  }
  const current = computeFingerprint(projectRoot);
  const status: ForkStatus = {
    hasInstance: true,
    moved: stored.root !== undefined && stored.root !== projectRoot,
    forked:
      stored.fingerprint !== undefined &&
      current !== undefined &&
      stored.fingerprint !== current,
  };
  if (stored.fingerprint !== undefined) status.storedFingerprint = stored.fingerprint;
  if (current !== undefined) status.currentFingerprint = current;
  return status;
}

/** Read the resolved identity without creating instance.json (null if absent). */
export function readIdentity(projectRoot: string): ProjectIdentity | null {
  const stored = readStored(projectRoot);
  return stored ? toIdentity(stored) : null;
}
