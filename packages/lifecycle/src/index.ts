/**
 * @lunaris/lifecycle — Phase 4 project lifecycle.
 * Snapshot/restore, export/import bundle, project identity v2, post-clone adopt.
 * (State sync / merge / team memory are DEFERRED past v1.)
 */
export {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  ArchiveError,
  normalizePath,
  packArchive,
  readArchiveMeta,
  unpackArchive,
} from './archive.js';
export type { ArchiveEntry, PackEntry, UnpackedArchive } from './archive.js';

export {
  instanceFile,
  journalDir,
  lunarisDir,
  memoryDir,
  relToAbs,
  secretsDir,
  snapshotsDir,
  stateDir,
  walkFiles,
} from './paths.js';

export {
  computeFingerprint,
  detectFork,
  ensureInstanceId,
  readIdentity,
} from './identity.js';
export type { EnsureInstanceOptions, ForkStatus } from './identity.js';

export {
  listSnapshots,
  ProjectMismatchError,
  pruneSnapshots,
  restore,
  snapshot,
} from './snapshot.js';
export type {
  RestoreOptions,
  RestoreResult,
  SnapshotMeta,
  SnapshotOptions,
} from './snapshot.js';

export {
  BUNDLE_FORMAT_VERSION,
  DEFAULT_SCHEMA_VERSIONS,
  exportBundle,
  importBundle,
  readBundleManifest,
} from './bundle.js';
export type {
  ExportBundleOptions,
  ImportBundleOptions,
  ImportResult,
} from './bundle.js';

export { adopt } from './adopt.js';
export type { AdoptOptions, AdoptReport } from './adopt.js';
