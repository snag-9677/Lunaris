/**
 * Per-project .lunaris directory layout (matches daemon/memory conventions:
 * state lives under <root>/.lunaris/state, with sibling memory/journal/etc.)
 * plus the file-tree walk + secret-exclusion helpers shared by snapshot/bundle.
 */
import { lstatSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { normalizePath } from './archive.js';

export const LUNARIS_DIR = '.lunaris';

export function lunarisDir(projectRoot: string): string {
  return join(projectRoot, LUNARIS_DIR);
}
export function stateDir(projectRoot: string): string {
  return join(projectRoot, LUNARIS_DIR, 'state');
}
export function memoryDir(projectRoot: string): string {
  return join(projectRoot, LUNARIS_DIR, 'memory');
}
export function journalDir(projectRoot: string): string {
  return join(projectRoot, LUNARIS_DIR, 'journal');
}
export function snapshotsDir(projectRoot: string): string {
  return join(projectRoot, LUNARIS_DIR, 'snapshots');
}
export function secretsDir(projectRoot: string): string {
  return join(projectRoot, LUNARIS_DIR, 'secrets');
}
export function instanceFile(projectRoot: string): string {
  return join(stateDir(projectRoot), 'instance.json');
}

/**
 * Secrets are tier T3 and the per-machine instance.json (tier T1) must never be
 * carried into a snapshot/bundle: snapshots restore on the SAME machine but we
 * still keep instanceId/secrets out by default so an accidental copy of a
 * snapshot can't leak secret material or collide instance ids. A path is
 * excluded if it is (or is under) the secrets dir, or is the instance.json,
 * or looks like a sqlite WAL/SHM sidecar (rebuildable, tier T4).
 */
export function isExcludedByDefault(projectRoot: string, absPath: string): boolean {
  const rel = normalizePath(relative(projectRoot, absPath));
  if (rel === '' || rel.startsWith('..')) return true;
  if (rel === `${LUNARIS_DIR}/state/instance.json`) return true;
  if (rel === `${LUNARIS_DIR}/secrets` || rel.startsWith(`${LUNARIS_DIR}/secrets/`)) return true;
  if (rel.endsWith('-wal') || rel.endsWith('-shm')) return true;
  return false;
}

/**
 * Recursively list regular files under `dir` (which must be inside projectRoot),
 * returning {abs, rel} where rel is project-root-relative POSIX path. Silently
 * skips a missing dir. Applies the default secret/instance exclusion unless
 * includeExcluded is set.
 *
 * FIX 5: uses lstatSync (NOT statSync) and SKIPS symlinks entirely — they are
 * neither followed nor packed. statSync follows symlinks, so a symlink in the
 * state tree (e.g. .lunaris/state/x -> /etc/passwd, or a dir symlink escaping
 * the project root) would otherwise get its target's content packed into a
 * snapshot/bundle, leaking files from outside the project. Skipped symlinks are
 * returned via the optional `skipped` collector for observability.
 */
export function walkFiles(
  projectRoot: string,
  dir: string,
  includeExcluded = false,
  skipped?: string[],
): { abs: string; rel: string }[] {
  const out: { abs: string; rel: string }[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out; // missing dir → nothing to collect
  }
  for (const name of names) {
    const abs = join(dir, name);
    let st;
    try {
      // lstatSync: do NOT follow symlinks (statSync would).
      st = lstatSync(abs);
    } catch {
      continue; // raced/removed
    }
    if (st.isSymbolicLink()) {
      // Never follow or pack a symlink (could point outside the project root).
      skipped?.push(normalizePath(relative(projectRoot, abs)));
      continue;
    }
    if (st.isDirectory()) {
      out.push(...walkFiles(projectRoot, abs, includeExcluded, skipped));
    } else if (st.isFile()) {
      if (!includeExcluded && isExcludedByDefault(projectRoot, abs)) continue;
      out.push({ abs, rel: normalizePath(relative(projectRoot, abs)) });
    }
  }
  return out;
}

/**
 * Convert a POSIX archive rel-path to an absolute OS path under destRoot,
 * rejecting traversal (`..`) and absolute components for zip-slip safety.
 */
export function relToAbs(destRoot: string, rel: string): string {
  const parts = normalizePath(rel)
    .split('/')
    .filter((s) => s.length > 0 && s !== '.');
  if (parts.some((s) => s === '..')) {
    throw new Error(`unsafe archive path (traversal): ${rel}`);
  }
  return join(destRoot, ...parts);
}
