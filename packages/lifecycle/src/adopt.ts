/**
 * adopt(projectRoot) — the post-clone hydrate step ("lun adopt").
 *
 * A repo committed with a lunaris.toml but a gitignored .lunaris/state needs a
 * one-shot bootstrap after `git clone`: create the local state directory
 * skeleton and mint a machine-local instanceId. This is exactly the moment the
 * two-level identity matters — the cloned tree inherits the committed projectId
 * (lineage) but MUST get its own fresh instanceId so its secrets/local state
 * never collide with the tree it was cloned from.
 *
 * Idempotent: running it again creates nothing new and returns the same
 * instanceId.
 */
import { existsSync, mkdirSync } from 'node:fs';
import type { ProjectIdentity } from '@lunaris/core';
import { ensureInstanceId, readIdentity } from './identity.js';
import {
  instanceFile,
  journalDir,
  lunarisDir,
  memoryDir,
  snapshotsDir,
  stateDir,
} from './paths.js';

export interface AdoptReport {
  identity: ProjectIdentity;
  /** True if the instanceId was minted by THIS call (first adopt). */
  instanceCreated: boolean;
  /** Directories created by this call (absolute paths). */
  createdDirs: string[];
  /** True if every action was a no-op (already adopted). */
  alreadyAdopted: boolean;
}

export interface AdoptOptions {
  skipFingerprint?: boolean;
  now?: () => Date;
}

/**
 * Ensure the per-project state skeleton exists and an instanceId is minted.
 * Reports what was created. Requires a readable lunaris.toml (throws via
 * loadManifest otherwise — adopt is meaningless without committed lineage).
 */
export function adopt(projectRoot: string, opts: AdoptOptions = {}): AdoptReport {
  const dirs = [
    lunarisDir(projectRoot),
    stateDir(projectRoot),
    memoryDir(projectRoot),
    journalDir(projectRoot),
    snapshotsDir(projectRoot),
  ];

  const createdDirs: string[] = [];
  for (const d of dirs) {
    if (!existsSync(d)) {
      mkdirSync(d, { recursive: true });
      createdDirs.push(d);
    }
  }

  const hadInstance = existsSync(instanceFile(projectRoot)) && readIdentity(projectRoot) !== null;

  const ensureOpts: { skipFingerprint?: boolean; now?: () => Date } = {};
  if (opts.skipFingerprint !== undefined) ensureOpts.skipFingerprint = opts.skipFingerprint;
  if (opts.now !== undefined) ensureOpts.now = opts.now;
  const identity = ensureInstanceId(projectRoot, ensureOpts);

  const instanceCreated = !hadInstance;
  return {
    identity,
    instanceCreated,
    createdDirs,
    alreadyAdopted: !instanceCreated && createdDirs.length === 0,
  };
}
