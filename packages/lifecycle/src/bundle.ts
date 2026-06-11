/**
 * Project bundles (.lunaris) — a portable, shareable export of a project that
 * can be imported elsewhere (or used as a template). A bundle is a gzipped
 * archive (see archive.ts) carrying a BundleManifest in its meta plus:
 *   - the committed lunaris.toml manifest
 *   - selected state: memory + optimizer proposals (+ analytics events)
 * Secrets (T3) and the machine-local instance.json (T1) are NEVER included.
 *
 * importBundle ALWAYS mints a FRESH instanceId for the destination (collision
 * safety — two trees imported from the same bundle must not share an instanceId,
 * which would alias their secrets/local state). `asTemplate` additionally strips
 * memory + analytics so the destination starts with a clean slate.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { loadManifest } from '@lunaris/core';
import type { BundleManifest, ProjectIdentity } from '@lunaris/core';
import { type PackEntry, packArchive, readArchiveMeta, unpackArchive } from './archive.js';
import { ensureInstanceId } from './identity.js';
import { relToAbs, stateDir, walkFiles } from './paths.js';

export const BUNDLE_FORMAT_VERSION = 1;

/** State files (relative to .lunaris/state) we treat as memory/analytics for templating. */
const MEMORY_BASENAMES = ['memory.db'];
const ANALYTICS_BASENAMES = ['analytics.db', 'events.db', 'outcomes.db'];
const PROPOSAL_BASENAMES = ['proposals.db'];

/** Current per-store schema versions stamped into the manifest. Bumped on migrations. */
export const DEFAULT_SCHEMA_VERSIONS: Record<string, number> = {
  memory: 1,
  proposals: 1,
  events: 1,
};

export interface ExportBundleOptions {
  name?: string;
  now?: () => Date;
  schemaVersions?: Record<string, number>;
}

function classifyState(rel: string): 'memory' | 'analytics' | 'proposals' | 'other' {
  const base = rel.split('/').pop() ?? rel;
  const stem = base.replace(/-(wal|shm)$/, '');
  if (MEMORY_BASENAMES.includes(stem)) return 'memory';
  if (PROPOSAL_BASENAMES.includes(stem)) return 'proposals';
  if (ANALYTICS_BASENAMES.includes(stem)) return 'analytics';
  return 'other';
}

/**
 * Produce a .lunaris bundle at outPath. Contents: the committed manifest plus
 * selected state (memory, optimizer proposals, analytics). Returns the
 * BundleManifest that was embedded.
 */
export function exportBundle(
  projectRoot: string,
  outPath: string,
  opts: ExportBundleOptions = {},
): BundleManifest {
  const now = opts.now ?? (() => new Date());
  const manifest = loadManifest(projectRoot);

  const entries: PackEntry[] = [];
  const contents = new Set<string>();

  // 1. committed manifest (always travels with the bundle)
  const tomlPath = join(projectRoot, 'lunaris.toml');
  if (existsSync(tomlPath)) {
    entries.push({ path: 'lunaris.toml', data: readFileSync(tomlPath) });
    contents.add('manifest');
  }

  // 2. selected state (secrets + instance.json already excluded by walkFiles)
  for (const f of walkFiles(projectRoot, stateDir(projectRoot))) {
    const cls = classifyState(f.rel);
    if (cls === 'other') continue;
    entries.push({ path: f.rel, data: readFileSync(f.abs) });
    contents.add(cls);
  }

  const bundleManifest: BundleManifest = {
    formatVersion: BUNDLE_FORMAT_VERSION,
    projectId: manifest.project.id,
    name: opts.name ?? manifest.project.name,
    createdAt: now().toISOString(),
    contents: [...contents].sort(),
    schemaVersions: opts.schemaVersions ?? DEFAULT_SCHEMA_VERSIONS,
  };

  const archive = packArchive(entries, bundleManifest);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, archive);
  return bundleManifest;
}

/** Read just the BundleManifest from a bundle without unpacking payloads. */
export function readBundleManifest(bundlePath: string): BundleManifest {
  const { meta } = readArchiveMeta(readFileSync(bundlePath));
  if (meta === undefined || typeof meta !== 'object') {
    throw new Error(`bundle has no manifest: ${bundlePath}`);
  }
  const m = meta as BundleManifest;
  if (typeof m.projectId !== 'string' || typeof m.formatVersion !== 'number') {
    throw new Error(`invalid bundle manifest: ${bundlePath}`);
  }
  return m;
}

export interface ImportBundleOptions {
  /** Strip memory + analytics; keep manifest + proposals only. */
  asTemplate?: boolean;
  /** Overwrite existing state files in destRoot (default false: skip existing). */
  overwrite?: boolean;
  now?: () => Date;
  /** Skip git fingerprint computation when minting the new instanceId. */
  skipFingerprint?: boolean;
}

export interface ImportResult {
  manifest: BundleManifest;
  /** identity minted for destRoot — instanceId is ALWAYS fresh. */
  identity: ProjectIdentity;
  /** files written into destRoot (relative). */
  written: string[];
  /** files skipped because they were template-stripped. */
  skipped: string[];
}

/**
 * Unpack a bundle into destRoot, write its manifest, and mint a FRESH
 * instanceId for the destination (never reusing any source instanceId — the
 * bundle never carries one). asTemplate strips memory + analytics so the new
 * project starts clean.
 */
export function importBundle(
  bundlePath: string,
  destRoot: string,
  opts: ImportBundleOptions = {},
): ImportResult {
  const archive = unpackArchive(readFileSync(bundlePath));
  const manifest = (archive.meta ?? undefined) as BundleManifest | undefined;
  if (manifest === undefined) {
    throw new Error(`bundle has no manifest: ${bundlePath}`);
  }

  mkdirSync(destRoot, { recursive: true });
  mkdirSync(stateDir(destRoot), { recursive: true });

  const written: string[] = [];
  const skipped: string[] = [];
  for (const e of archive.entries) {
    // Never import a stray instance.json (it must be machine-local + fresh).
    if (e.path === '.lunaris/state/instance.json') {
      skipped.push(e.path);
      continue;
    }
    if (opts.asTemplate) {
      const cls = classifyState(e.path);
      if (cls === 'memory' || cls === 'analytics') {
        skipped.push(e.path);
        continue;
      }
    }
    const abs = relToAbs(destRoot, e.path);
    if (!opts.overwrite && existsSync(abs)) {
      skipped.push(e.path);
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, e.data);
    written.push(e.path);
  }

  // Mint a fresh, machine-local instanceId for the destination tree. The
  // committed projectId is read from the just-written lunaris.toml.
  const ensureOpts: { skipFingerprint?: boolean; now?: () => Date } = {};
  if (opts.skipFingerprint !== undefined) ensureOpts.skipFingerprint = opts.skipFingerprint;
  if (opts.now !== undefined) ensureOpts.now = opts.now;
  const identity = ensureInstanceId(destRoot, ensureOpts);

  return { manifest, identity, written, skipped };
}
