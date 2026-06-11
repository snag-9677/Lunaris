/**
 * Dep-free archive format for snapshots and bundles. We deliberately avoid a
 * USTAR/tar implementation and use a self-describing custom container that is
 * trivial to read back without any native or third-party deps:
 *
 *   gzip( JSON line(header) "\n" + concatenated base64 file entries )
 *
 * The header is a single JSON object on the first line:
 *   { format: "lunaris-archive", version: 1, entries: [{ path, bytes, b64Len }] }
 * followed by the base64 payloads concatenated in `entries` order (b64Len is the
 * length of the base64 string for that entry, so we can slice deterministically).
 *
 * Paths are stored project-root-relative with forward slashes. Reading is
 * therefore a pure string/base64 operation — no streaming tar parser required.
 */
import { gunzipSync, gzipSync } from 'node:zlib';

export const ARCHIVE_FORMAT = 'lunaris-archive';
export const ARCHIVE_VERSION = 1;

export interface ArchiveEntry {
  /** Project-root-relative path, forward-slash separated. */
  path: string;
  /** Raw (decoded) byte length. */
  bytes: number;
  /** Length of the base64 string for this entry in the payload region. */
  b64Len: number;
}

interface ArchiveHeader {
  format: string;
  version: number;
  /** Optional opaque metadata object (e.g. a BundleManifest). */
  meta?: unknown;
  entries: ArchiveEntry[];
}

export interface PackEntry {
  path: string;
  data: Buffer;
}

/** Pack entries (+ optional meta) into a single gzipped archive buffer. */
export function packArchive(entries: PackEntry[], meta?: unknown): Buffer {
  const headerEntries: ArchiveEntry[] = [];
  const payloads: string[] = [];
  for (const e of entries) {
    const b64 = e.data.toString('base64');
    headerEntries.push({ path: normalizePath(e.path), bytes: e.data.length, b64Len: b64.length });
    payloads.push(b64);
  }
  const header: ArchiveHeader = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    entries: headerEntries,
  };
  if (meta !== undefined) header.meta = meta;
  const body = `${JSON.stringify(header)}\n${payloads.join('')}`;
  return gzipSync(Buffer.from(body, 'utf8'));
}

export interface UnpackedArchive {
  meta?: unknown;
  entries: { path: string; data: Buffer }[];
}

/** Read a gzipped archive buffer back into entries (+ meta). */
export function unpackArchive(archive: Buffer): UnpackedArchive {
  const body = gunzipSync(archive).toString('utf8');
  const nl = body.indexOf('\n');
  if (nl < 0) throw new ArchiveError('malformed archive: missing header newline');
  let header: ArchiveHeader;
  try {
    header = JSON.parse(body.slice(0, nl)) as ArchiveHeader;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ArchiveError(`malformed archive header: ${msg}`);
  }
  if (header.format !== ARCHIVE_FORMAT) {
    throw new ArchiveError(`unexpected archive format: ${String(header.format)}`);
  }
  if (header.version !== ARCHIVE_VERSION) {
    throw new ArchiveError(`unsupported archive version: ${String(header.version)}`);
  }
  const payload = body.slice(nl + 1);
  const entries: { path: string; data: Buffer }[] = [];
  let cursor = 0;
  for (const e of header.entries) {
    const b64 = payload.slice(cursor, cursor + e.b64Len);
    cursor += e.b64Len;
    const data = Buffer.from(b64, 'base64');
    if (data.length !== e.bytes) {
      throw new ArchiveError(`archive entry "${e.path}" length mismatch (corrupt)`);
    }
    entries.push({ path: e.path, data });
  }
  const out: UnpackedArchive = { entries };
  if (header.meta !== undefined) out.meta = header.meta;
  return out;
}

/** Read only the header/meta of an archive without decoding payloads. */
export function readArchiveMeta(archive: Buffer): { meta?: unknown; paths: string[] } {
  const body = gunzipSync(archive).toString('utf8');
  const nl = body.indexOf('\n');
  if (nl < 0) throw new ArchiveError('malformed archive: missing header newline');
  const header = JSON.parse(body.slice(0, nl)) as ArchiveHeader;
  if (header.format !== ARCHIVE_FORMAT) {
    throw new ArchiveError(`unexpected archive format: ${String(header.format)}`);
  }
  const result: { meta?: unknown; paths: string[] } = {
    paths: header.entries.map((e) => e.path),
  };
  if (header.meta !== undefined) result.meta = header.meta;
  return result;
}

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

/** Normalize a path to forward slashes (archive paths are POSIX-style). */
export function normalizePath(p: string): string {
  return p.split('\\').join('/');
}
