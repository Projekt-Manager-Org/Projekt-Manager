/**
 * Full-account takeout EXPORT builder — ADR-0018 / ADR-0024, api.md
 * §14.2.4 "Export job — archive layout + manifest" / "build and
 * lifecycle", data-model.md §5.18.
 *
 * Assembles the staged archive a `ready` export job serves:
 *
 *   data.json                                   — the ExportService envelope (AC-135)
 *   attachments/<nummer>-<titel>/<id>-<datei>   — every status='ready'
 *                                                 attachment as PLAINTEXT
 *   manifest.json                               — server-computed coverage +
 *                                                 per-entry SHA-256
 *
 * Bounded memory (core PR goal — multi-GB takeouts). The zip is opened
 * once and entries STREAM into it as they are built; the builder holds at
 * most ONE attachment in memory at a time, so peak memory scales with the
 * per-file cap ([C], data-model.md §5.21) — NOT with the archive size. A
 * takeout of thousands of files (or a raised per-file cap) streams to disk
 * without ever buffering the batch. The only component buffered whole is
 * `data.json` — business *rows*, bounded by row count, not attachment bytes.
 *
 * Per-attachment build: unwrap the row's `wrappedDek` against the
 * operator-loaded binary `age` identity, fetch the ciphertext from object
 * storage by `originalKey`, AES-256-GCM-decrypt (wire shape
 * `nonce(12)||ct||tag(16)`), and append the plaintext to the zip. The whole
 * attachment is buffered and its GCM tag VERIFIED (`final()`) before the
 * plaintext enters the archive — only authentic bytes are ever written
 * (authenticated-before-release; GCM cannot authenticate a partial stream).
 * A per-row failure (unwrap / fetch / decrypt throws) is logged and the row
 * is SKIPPED — excluded from both the archive and the manifest — and the
 * build still reaches `ready` (AC-325). One bad row never aborts the job.
 *
 * The manifest reflects what is IN the archive: `data.json` is the first
 * entry (no `attachmentId`), then each successfully-archived attachment
 * (with `attachmentId`); it excludes itself. `totalFiles ===
 * files.length`, `totalBytes === Σ sizeBytes`, and every `sha256` is the
 * hex SHA-256 of that entry's exact bytes.
 *
 * Plaintext stages only inside the trust radius (the VPS-local
 * `TAKEOUT_STAGING_DIR`, dir 0700 / file 0600 so the plaintext superset —
 * all business data + every `passwordHash` — is not world-readable);
 * B2 sees only per-attachment ciphertext (ADR-0024 invariant). The
 * finished zip lands at `<TAKEOUT_STAGING_DIR>/<jobId>.zip`.
 */

import crypto from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import { asc, eq } from 'drizzle-orm';

import type { Database } from '../db/connection.js';
import { attachments, projects } from '../db/schema.js';
import type { AttachmentStorageClient } from '../storage/client.js';
import type { ServiceLogger } from './Logger.js';
import { ExportService } from './ExportService.js';
import { KeyEnvelopeService } from './KeyEnvelopeService.js';
import { decryptInvoicePayload } from './invoice/payloadCrypto.js';
import type { AuthUser } from '../middleware/auth.js';

/**
 * Filename-component sanitiser (AC-245): a single zip-path segment must
 * be ≤255 chars, carry no control bytes (`\x00–\x1F`, `\x7F`), and no
 * `/` `\` `"`. A violating char is replaced with `_`; an over-length
 * result is truncated. Mirrors the attachment filename rules so the
 * archive path can never break the zip's directory grammar or smuggle a
 * separator that would inflate the segment count.
 */
const PATH_SEGMENT_MAX = 255;
// eslint-disable-next-line no-control-regex
const UNSAFE_PATH_BYTES = /[\x00-\x1f\x7f/\\"]/g;

export function sanitisePathSegment(raw: string): string {
  const replaced = raw.replace(UNSAFE_PATH_BYTES, '_');
  const truncated =
    replaced.length > PATH_SEGMENT_MAX ? replaced.slice(0, PATH_SEGMENT_MAX) : replaced;
  // `.` / `..` carry no unsafe byte but are relative-navigation tokens —
  // map them to `_` so a segment can never smuggle path traversal into the
  // archive entry name (archiver only strips a *leading* `../`).
  if (truncated === '.' || truncated === '..') return '_';
  return truncated;
}

interface ManifestFileEntry {
  zipPath: string;
  sizeBytes: number;
  sha256: string;
  attachmentId?: string;
}

interface Manifest {
  manifestVersion: 1;
  exportedAt: string;
  totalFiles: number;
  totalBytes: number;
  files: ManifestFileEntry[];
}

export interface BuildExportArchiveDeps {
  db: Database;
  storage: AttachmentStorageClient;
  logger: ServiceLogger;
  /** Unscoped caller — threaded to ExportService's scope tripwire (ADR-0019). */
  caller: AuthUser;
  /** Operator-loaded binary `age` recipient (public X25519 key). */
  binaryAgeRecipient: string;
  /** Tmpfs-resident path to the operator-loaded binary `age` private identity. */
  binaryAgeIdentityPath: string;
  /** VPS-local staging directory (TAKEOUT_STAGING_DIR). */
  stagingDir: string;
  /** The job id — names the staged zip and threads into progress. */
  jobId: string;
  /**
   * Progress sink. The builder throttles calls (~1/s) so a many-file
   * job does not emit a frame per file (AC-333). `filesTotal` /
   * `filesDone` / `bytesTotal` / `bytesDone` count only attachments —
   * `data.json` and `manifest.json` are archive entries, not attachment
   * "files".
   */
  onProgress: (p: {
    filesTotal: number;
    bytesTotal: number;
    filesDone: number;
    bytesDone: number;
    currentItem: string | null;
  }) => Promise<void>;
}

export interface BuildExportArchiveResult {
  /** Absolute path of the staged zip — recorded as `archiveRef` on markReady. */
  archiveRef: string;
  /** Count of `ready` attachments considered (excludes data.json / manifest.json). */
  filesTotal: number;
  /** Count successfully archived (excludes skipped rows). */
  filesDone: number;
  /** Summed plaintext size of all `ready` attachments attempted (the denominator). */
  bytesTotal: number;
  /** Summed plaintext bytes of the archived attachments. */
  bytesDone: number;
}

/** A `ready` attachment plus the owning project's number/title for the path. */
interface ReadyAttachmentRow {
  id: string;
  originalKey: string;
  filename: string;
  sizeBytes: number;
  wrappedDek: string | null;
  projectNumber: string;
  projectTitle: string;
}

/** Throttle window for progress emissions — one frame per second at most. */
const PROGRESS_THROTTLE_MS = 1000;

/**
 * Build the staged export archive and return its location + counters.
 * Throws only on a WHOLESALE failure (envelope read, disk write,
 * archive finalize) — the caller maps that to `failed` and unlinks the
 * partial staged file. Per-row attachment failures are absorbed (logged
 * + skipped) and never throw.
 */
export async function buildExportArchive(
  deps: BuildExportArchiveDeps,
): Promise<BuildExportArchiveResult> {
  const exportedAt = new Date().toISOString();

  // 1. Materialize the envelope. ExportService runs its own
  //    REPEATABLE READ READ ONLY snapshot; serialize once to a Buffer so
  //    the manifest hashes the exact bytes that land in the zip. Buffered
  //    whole by design — it is business rows, bounded by row count.
  const envelope = await new ExportService(deps.db).export(deps.caller);
  const dataJsonBytes = Buffer.from(JSON.stringify(envelope), 'utf-8');

  // 2. Enumerate every `status='ready'` attachment with its project's
  //    (number, title) — the path is `attachments/<nummer>-<titel>/…`.
  //    Ordered by attachment id for a deterministic archive layout.
  const readyRows = await loadReadyAttachments(deps.db);
  const filesTotal = readyRows.length;
  // bytesTotal is the live readout's denominator (data-model.md §5.18,
  // ui/daten.md §8.11): the summed plaintext size of every ready row we
  // will attempt, known up front from the row metadata.
  const bytesTotal = readyRows.reduce((sum, r) => sum + r.sizeBytes, 0);

  // 3. Open the staged zip and stream entries into it AS THEY ARE BUILT.
  //    Dir 0700 / file 0600 keep the staged plaintext off other UIDs on
  //    the box (ADR-0024 trust radius); mirrors KeyEnvelopeService / vapid.
  await mkdir(deps.stagingDir, { recursive: true, mode: 0o700 });
  // `mode` only applies on creation — enforce 0700 even if the dir
  // pre-existed (a prior version, or a crash, may have left it 0755).
  await chmod(deps.stagingDir, 0o700);
  const archiveRef = path.join(deps.stagingDir, `${deps.jobId}.zip`);
  const out = createWriteStream(archiveRef, { mode: 0o600 });
  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on('warning', (err: Error) => {
    deps.logger.error(
      { event: 'takeout-export-archive-warning', error_hint: err.message },
      'takeout-export-archive-warning',
    );
  });
  // `pipeline` wires archive → file; it resolves on the file's close and
  // rejects on either side's error. It — NOT `archive.finalize()` — is THE
  // completion signal: archiver's `finalize()` promise never settles on a
  // write-side fault (ENOSPC/EIO), so awaiting it would hang the build past
  // the catch. The handled `.catch` keeps a between-appends rejection from
  // surfacing as an unhandled rejection (which would crash the process);
  // the append loop still observes the rejection via the race below.
  const piped = pipeline(archive, out);
  piped.catch(() => {});

  /**
   * Append one entry and wait until the archiver has PROCESSED it (its
   * `entry` event) before returning. `archive.append` only enqueues and
   * never applies backpressure, so without this wait the queue grows with
   * the file count (∝ archive size, worst for incompressible PDFs/JPEGs) —
   * defeating the bounded-memory goal. Waiting per entry keeps at most ONE
   * attachment in flight. The wait is raced against `piped` so a write
   * fault rejects here (→ catch) instead of hanging on a never-fired event.
   */
  const appendEntry = async (bytes: Buffer, name: string): Promise<void> => {
    const processed = once(archive, 'entry');
    archive.append(bytes, { name });
    await Promise.race([processed, piped]);
  };

  // A fresh per-build KeyEnvelopeService against the operator-loaded
  // identity path (borrowed file — no close()).
  const envelopeService = new KeyEnvelopeService({
    recipient: deps.binaryAgeRecipient,
    identityPath: deps.binaryAgeIdentityPath,
  });

  const manifestFiles: ManifestFileEntry[] = [];
  let filesDone = 0;
  let bytesDone = 0;
  let lastProgressAt = 0;

  const emitProgress = async (currentItem: string | null, force: boolean): Promise<void> => {
    const now = Date.now();
    if (!force && now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
    lastProgressAt = now;
    await deps.onProgress({ filesTotal, bytesTotal, filesDone, bytesDone, currentItem });
  };

  try {
    // data.json is the first archive entry (and first manifest entry).
    await appendEntry(dataJsonBytes, 'data.json');
    manifestFiles.push({
      zipPath: 'data.json',
      sizeBytes: dataJsonBytes.length,
      sha256: sha256Hex(dataJsonBytes),
    });

    for (const row of readyRows) {
      // Buffer ONE attachment and GCM-verify it before it enters the
      // archive. The await on the storage fetch paces the loop: the local
      // disk write of the previous entry drains while the next is fetched,
      // so the archiver queue stays shallow (bounded memory).
      const plaintext = await decryptAttachment(row, deps.storage, envelopeService, deps.logger);
      if (plaintext === null) {
        // Per-row failure already logged in decryptAttachment — skip the
        // row (absent from archive AND manifest) and keep building.
        await emitProgress(row.filename, false);
        continue;
      }

      const dirSegment = sanitisePathSegment(`${row.projectNumber}-${row.projectTitle}`);
      const fileSegment = sanitisePathSegment(`${row.id}-${row.filename}`);
      const zipPath = `attachments/${dirSegment}/${fileSegment}`;
      await appendEntry(plaintext, zipPath);
      manifestFiles.push({
        zipPath,
        sizeBytes: plaintext.length,
        sha256: sha256Hex(plaintext),
        attachmentId: row.id,
      });

      filesDone += 1;
      bytesDone += plaintext.length;
      await emitProgress(row.filename, false);
    }

    // manifest.json is appended LAST and is NOT in `manifestFiles` (it
    // reflects what is in the archive and excludes itself).
    const manifest: Manifest = {
      manifestVersion: 1,
      exportedAt,
      totalFiles: manifestFiles.length,
      totalBytes: manifestFiles.reduce((sum, f) => sum + f.sizeBytes, 0),
      files: manifestFiles,
    };
    await appendEntry(Buffer.from(JSON.stringify(manifest), 'utf-8'), 'manifest.json');

    // Fire finalize (NOT awaited — archiver's finalize() promise never
    // settles on a write-side fault; see the `piped` note above) and await
    // the pipeline, which is the real completion signal.
    archive.finalize();
    await piped;
  } catch (err) {
    // Tear down the open streams so a wholesale fault cannot leak an fd or
    // wedge the file handle; the runner unlinks the partial staged archive.
    archive.destroy();
    out.destroy();
    throw err;
  }

  // Final progress frame so the readout settles on the terminal counts.
  await emitProgress(null, true);

  return { archiveRef, filesTotal, filesDone, bytesTotal, bytesDone };
}

/**
 * Load every `status='ready'` attachment joined to its project's number
 * and title, ordered by attachment id (deterministic archive layout).
 */
async function loadReadyAttachments(db: Database): Promise<ReadyAttachmentRow[]> {
  const rows = await db
    .select({
      id: attachments.id,
      originalKey: attachments.originalKey,
      filename: attachments.filename,
      sizeBytes: attachments.sizeBytes,
      wrappedDek: attachments.wrappedDek,
      projectNumber: projects.number,
      projectTitle: projects.title,
    })
    .from(attachments)
    .innerJoin(projects, eq(attachments.projectId, projects.id))
    .where(eq(attachments.status, 'ready'))
    .orderBy(asc(attachments.id));
  return rows;
}

/**
 * Decrypt one ready attachment to plaintext, or return `null` on any
 * per-row fault (missing wrapped DEK, unwrap failure, storage fetch
 * failure, AES-256-GCM verify failure). The null path is logged on the
 * error channel and the caller skips the row (AC-325).
 */
async function decryptAttachment(
  row: ReadyAttachmentRow,
  storage: AttachmentStorageClient,
  envelopeService: KeyEnvelopeService,
  logger: ServiceLogger,
): Promise<Buffer | null> {
  try {
    if (!row.wrappedDek) {
      throw new Error('wrapped_dek missing on ready row');
    }
    const dek = await envelopeService.unwrap(Buffer.from(row.wrappedDek, 'base64'));
    const { data } = await storage.download(row.originalKey);
    const ciphertext = data instanceof Buffer ? data : Buffer.from(data);
    const plaintext = decryptInvoicePayload(ciphertext, dek);
    return Buffer.from(plaintext);
  } catch (err) {
    logger.error(
      {
        event: 'takeout-export-row-skipped',
        attachment_id: row.id,
        error_hint: err instanceof Error ? err.message : String(err),
      },
      'takeout-export-row-skipped',
    );
    return null;
  }
}

function sha256Hex(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
