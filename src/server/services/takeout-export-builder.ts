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
 * A per-row failure (unwrap / fetch / decrypt throws) FAILS THE JOB
 * (AC-325): an archive missing a row is a worthless backup, and shipping
 * it as `ready` hands the operator a restore that cannot work. No partial
 * artifact is ever labelled success — the operator re-runs the export.
 *
 * THE ENVELOPE IS THE SINGLE SOURCE OF TRUTH for what the archive
 * contains. The build iterates `envelope.attachments` and looks up only
 * the columns the envelope deliberately withholds (`originalKey`,
 * `wrappedDek` — AC-220 / ADR-0024), keyed by the envelope's own ids;
 * archive paths come from the envelope's `projects` + `fileName`. There
 * is no second `WHERE status='ready'` query, so envelope↔manifest parity
 * — the invariant the importer enforces before the wipe — holds by
 * CONSTRUCTION rather than by agreement between two reads.
 *
 * That matters because the envelope is read inside a `repeatable read
 * read only` snapshot that commits before the build starts. A second,
 * later read would see a different set: an upload completing mid-build
 * would land in the archive but not the envelope, producing a `ready`
 * archive the importer rejects — with healthy-looking counters and no
 * bad row anywhere. Deriving from the envelope makes the export a clean
 * point-in-time snapshot: a row that arrives after it is simply not in
 * this backup, which is the correct semantics.
 *
 * The manifest reflects what is IN the archive: `data.json` is the first
 * entry (no `attachmentId`), then each archived attachment (with
 * `attachmentId`); it excludes itself. `totalFiles === files.length`,
 * `totalBytes === Σ sizeBytes`, and every `sha256` is the hex SHA-256 of
 * that entry's exact bytes.
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
import { pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import { inArray } from 'drizzle-orm';

import type { Database } from '../db/connection.js';
import { attachments } from '../db/schema.js';
import type { AttachmentStorageClient } from '../storage/client.js';
import type { ServiceLogger } from './Logger.js';
import { ExportService } from './ExportService.js';
import { KeyEnvelopeService } from './KeyEnvelopeService.js';
import { decryptInvoicePayload } from './invoice/payloadCrypto.js';
import { stagedArtifactPath } from './takeout-staging.js';
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
  /** Count of `ready` attachments archived (excludes data.json / manifest.json). */
  filesTotal: number;
  /** Count archived so far — equals `filesTotal` on a successful build. */
  filesDone: number;
  /** Summed plaintext size of all `ready` attachments (the denominator). */
  bytesTotal: number;
  /** Summed plaintext bytes archived — equals `bytesTotal` on success. */
  bytesDone: number;
}

/**
 * The per-row crypto + storage columns the envelope deliberately omits
 * (AC-220 / ADR-0024). Everything else the build needs — path components,
 * plaintext size — comes from the envelope itself.
 */
interface AttachmentKeys {
  originalKey: string;
  wrappedDek: string | null;
}

/** Throttle window for progress emissions — one frame per second at most. */
const PROGRESS_THROTTLE_MS = 1000;

/**
 * Build the staged export archive and return its location + counters.
 * Throws on ANY failure — wholesale (envelope read, disk write, archive
 * finalize) or per-row (a single attachment that will not decrypt). The
 * caller maps that to `failed` and unlinks the partial staged file.
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

  // 2. The archive set IS the envelope's attachment set. Look up only the
  //    withheld crypto/storage columns, keyed by the envelope's ids, and
  //    index the envelope's projects for the `<nummer>-<titel>` path
  //    segment. ExportService already orders attachments by id, so the
  //    archive layout stays deterministic without a second sort.
  const keysById = await loadAttachmentKeys(
    deps.db,
    envelope.attachments.map((a) => a.id),
  );
  const projectById = new Map(envelope.projects.map((p) => [p.id, p]));
  const filesTotal = envelope.attachments.length;
  // bytesTotal is the live readout's denominator (data-model.md §5.18,
  // ui/daten.md §8.11): the summed plaintext size of every row in the
  // envelope, known up front from its metadata.
  const bytesTotal = envelope.attachments.reduce((sum, a) => sum + a.sizeBytes, 0);

  // 3. Open the staged zip and stream entries into it AS THEY ARE BUILT.
  //    Dir 0700 / file 0600 keep the staged plaintext off other UIDs on
  //    the box (ADR-0024 trust radius); mirrors KeyEnvelopeService / vapid.
  await mkdir(deps.stagingDir, { recursive: true, mode: 0o700 });
  // `mode` only applies on creation — enforce 0700 even if the dir
  // pre-existed (a prior version, or a crash, may have left it 0755).
  await chmod(deps.stagingDir, 0o700);
  const archiveRef = stagedArtifactPath(deps.stagingDir, 'export', deps.jobId);
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

    for (const att of envelope.attachments) {
      // A row present in the envelope snapshot but gone by the time the
      // keys are read (hard-deleted mid-build) cannot be archived, and an
      // archive missing an envelope row is unrestorable — fail, naming it.
      const keys = keysById.get(att.id);
      if (!keys) {
        throw new Error(`attachment ${att.id} vanished between the snapshot and the build`);
      }
      const project = projectById.get(att.projectId);
      if (!project) {
        throw new Error(`attachment ${att.id} references project ${att.projectId} not in envelope`);
      }

      // Buffer ONE attachment and GCM-verify it before it enters the
      // archive. The await on the storage fetch paces the loop: the local
      // disk write of the previous entry drains while the next is fetched,
      // so the archiver queue stays shallow (bounded memory).
      const plaintext = await decryptAttachment(
        att.id,
        keys,
        deps.storage,
        envelopeService,
        deps.logger,
      );

      const dirSegment = sanitisePathSegment(`${project.number}-${project.title}`);
      const fileSegment = sanitisePathSegment(`${att.id}-${att.fileName}`);
      const zipPath = `attachments/${dirSegment}/${fileSegment}`;
      await appendEntry(plaintext, zipPath);
      manifestFiles.push({
        zipPath,
        sizeBytes: plaintext.length,
        sha256: sha256Hex(plaintext),
        attachmentId: att.id,
      });

      filesDone += 1;
      bytesDone += plaintext.length;
      await emitProgress(att.fileName, false);
    }

    // Envelope↔manifest coverage — the invariant the importer enforces
    // before the wipe. Structural (the loop pushes exactly one entry per
    // envelope attachment, and ids are unique), so a count match implies
    // set equality; kept as a one-line tripwire against a future edit
    // that reintroduces a second source for the archive set.
    if (filesDone !== filesTotal) {
      throw new Error(`archived ${filesDone} of ${filesTotal} envelope attachments`);
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
 * Load the withheld crypto/storage columns for exactly the envelope's
 * attachment ids. No status filter and no project join: the envelope
 * already settled WHICH rows travel (`status='ready'` inside its own
 * snapshot, AC-220), so re-deriving that set here is what let the two
 * reads disagree. An id with no row is caught by the caller.
 */
async function loadAttachmentKeys(
  db: Database,
  ids: string[],
): Promise<Map<string, AttachmentKeys>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: attachments.id,
      originalKey: attachments.originalKey,
      wrappedDek: attachments.wrappedDek,
    })
    .from(attachments)
    .where(inArray(attachments.id, ids));
  return new Map(rows.map((r) => [r.id, { originalKey: r.originalKey, wrappedDek: r.wrappedDek }]));
}

/**
 * Decrypt one attachment to plaintext. Any per-row fault (missing wrapped
 * DEK, unwrap failure, storage fetch failure, AES-256-GCM verify failure)
 * is logged and RETHROWN naming the row — it fails the whole build
 * (AC-325). A backup that silently omits a file is not a backup.
 *
 * Transient storage faults are already retried inside the S3 client (SDK
 * default: 3 attempts, standard mode with backoff), so reaching this
 * catch on a fetch means the object is genuinely unreachable.
 */
async function decryptAttachment(
  attachmentId: string,
  keys: AttachmentKeys,
  storage: AttachmentStorageClient,
  envelopeService: KeyEnvelopeService,
  logger: ServiceLogger,
): Promise<Buffer> {
  try {
    if (!keys.wrappedDek) {
      throw new Error('wrapped_dek missing on ready row');
    }
    const dek = await envelopeService.unwrap(Buffer.from(keys.wrappedDek, 'base64'));
    const { data } = await storage.download(keys.originalKey);
    const ciphertext = data instanceof Buffer ? data : Buffer.from(data);
    const plaintext = decryptInvoicePayload(ciphertext, dek);
    return Buffer.from(plaintext);
  } catch (err) {
    const hint = err instanceof Error ? err.message : String(err);
    logger.error(
      { event: 'takeout-export-row-failed', attachment_id: attachmentId, error_hint: hint },
      'takeout-export-row-failed',
    );
    // The id rides `error_detail` on the failed job so the operator can
    // find the offending row without digging through logs.
    throw new Error(`attachment ${attachmentId} could not be read: ${hint}`, { cause: err });
  }
}

function sha256Hex(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
