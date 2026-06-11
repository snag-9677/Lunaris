/**
 * Loose structural view of @lunaris/lifecycle for the daemon's snapshot/restore/
 * export routes. Matches the lazy-load convention of phase3.ts so the daemon
 * still boots if the package is unbuilt during an incremental dev build.
 */
import type { BundleManifest, SnapshotInfo } from '@lunaris/core';

export interface RestoreResultLike {
  restored: string[];
  dryRun: boolean;
  /** FIX 7: protected paths (secrets/instance.json) skipped unless force. */
  skipped?: string[];
}

export interface LifecyclePkgLike {
  snapshot(
    projectRoot: string,
    opts?: { kind?: 'full' | 'pre-op'; now?: () => Date; includeExcluded?: boolean },
  ): SnapshotInfo;
  listSnapshots(projectRoot: string): SnapshotInfo[];
  restore(
    projectRoot: string,
    snapshotId: string,
    opts?: { dryRun?: boolean; force?: boolean },
  ): RestoreResultLike;
  exportBundle(
    projectRoot: string,
    outPath: string,
    opts?: { name?: string; now?: () => Date; schemaVersions?: Record<string, number> },
  ): BundleManifest;
  adopt(
    projectRoot: string,
    opts?: { skipFingerprint?: boolean; now?: () => Date },
  ): unknown;
}

export async function loadLifecyclePkg(): Promise<LifecyclePkgLike | undefined> {
  try {
    return (await import('@lunaris/lifecycle')) as unknown as LifecyclePkgLike;
  } catch {
    return undefined;
  }
}
