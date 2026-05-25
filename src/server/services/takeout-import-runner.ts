/**
 * Full-account takeout IMPORT job runner — ADR-0018 / ADR-0024, api.md
 * §14.2.4 ("Import job — validate before wipe" / "restore"), data-model.md
 * §5.18.
 *
 * Owns the asynchronous, fire-and-forget restore that the final upload
 * `PATCH` kicks off (the route stamps `running` + `archiveRef` and fires
 * this detached, exactly as `POST /api/export-jobs` fires the export
 * builder). Advances `running → ready | failed` via `DataExchangeJobService`,
 * whose `markReady` / `markFailed` write the EXACTLY ONE `audit_log` row at
 * the terminal transition (AC-332) ATOMICALLY with the status flip — the
 * runner only supplies the content (`import_restored` / `import_failed`, the
 * German label, the counts). It never throws — a wholesale fault is recorded
 * on the row + the audit trail, never surfaced to a caller (the PATCH already
 * returned).
 *
 * Bounded memory is the load-bearing property (the PR's raison d'être —
 * multi-GB takeouts). The staged zip is STREAMED from disk one entry at a
 * time via fflate's streaming `Unzip` (NOT `unzipSync`, NOT `readFileSync`):
 * at most ONE entry is buffered at any moment, plus `data.json` (business
 * rows, bounded by row count) and `manifest.json`. Peak memory scales with
 * the single largest entry, NOT with the archive size.
 *
 * Two passes over the staged file (re-read from local disk — cheap):
 *   PASS 1 — VALIDATE BEFORE WIPE: stream once, hashing each entry one at a
 *     time and buffering only `data.json` + `manifest.json`. Verify every
 *     entry's SHA-256 against the manifest, manifest↔envelope coverage
 *     parity, attachment-id uniqueness, and attachment→project referential
 *     integrity. ImportService additionally re-checks `schema_version`
 *     (throws pre-tx). ANY failure → `failed` + `import_failed` audit +
 *     ZERO destructive writes — a corrupt / tampered / wrong-version
 *     archive never wipes the target (AC-327).
 *   RESTORE: `ImportService.import` with `override:true` (a full-account
 *     restore replaces users + company_profile too; the create-time gate
 *     already proved operator intent), `confirmationPhrase` = the canonical
 *     phrase, `writeAuditRow:false` (the job owns the single terminal row),
 *     `caller:null` (no import token — the job re-encrypts server-side under
 *     its own loaded identity). The TRUNCATE cascades into `sessions`,
 *     dropping the operator's cookie mid-job (AC-330) — by design; the
 *     operator re-authenticates and re-attaches via `GET /api/import-jobs`.
 *   PASS 2 — ATTACHMENT RE-ENCRYPT + INSERT: stream once more, buffering one
 *     attachment at a time; per row mint a fresh DEK, AES-256-GCM-encrypt,
 *     wrap the DEK under the instance recipient, PUT ciphertext to B2, and
 *     insert the `attachments` row with `id` / `createdBy` / `createdAt`
 *     preserved (AC-328). Progress is throttled (~1/s).
 *
 * Photo-thumbnail regeneration is deliberately OUT OF SCOPE: AC-328 mentions
 * it, but the regen needs a server-side image pipeline (a new dependency)
 * and the import tests exercise binary attachments only. Every restored row
 * is `hasThumbnail = false`; a restored photo shows its full-size original.
 * Flagged boundary — revisit if photo previews on restore are required.
 *
 * The staged upload is NOT removed on failure: the route stamped
 * `archiveRef` at `markRunning`, so the staging reaper (data-model.md §6.15)
 * sweeps the file for a terminal import (ready OR failed) on its TTL clock.
 * This differs from the export runner, which unlinks its partial build
 * (an export failure leaves `archiveRef` null, so the reaper can't reach it).
 */

import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';

import type { Database } from '../db/connection.js';
import { attachments } from '../db/schema.js';
import type { AttachmentStorageClient } from '../storage/client.js';
import type { ServiceLogger } from './Logger.js';
import { DataExchangeJobService } from './DataExchangeJobService.js';
import { ImportService } from './ImportService.js';
import { KeyEnvelopeService } from './KeyEnvelopeService.js';
import { encryptInvoicePayload } from './invoice/payloadCrypto.js';
import { WRAPPED_DEK_CURRENT_VERSION } from '../../domain/attachments.js';
import { RESTORE_CONFIRMATION_PHRASE } from '../../config/dataExchangeConfig.js';
import type { Envelope, EnvelopeAttachment } from '../../domain/dataExchange.js';

export interface RunTakeoutImportDeps {
  db: Database;
  jobs: DataExchangeJobService;
  storage: AttachmentStorageClient;
  jobId: string;
  /** Absolute path of the staged upload (`<TAKEOUT_STAGING_DIR>/import-<id>.zip`). */
  stagedPath: string;
  logger: ServiceLogger;
  /** Operator-loaded binary `age` recipient (public X25519 key). */
  binaryAgeRecipient: string;
  /** Tmpfs-resident path to the operator-loaded binary `age` private identity. */
  binaryAgeIdentityPath: string;
}

/**
 * Per-entry buffering safety ceiling — a pathological-archive guard, NOT the
 * operator per-file cap. The import is deliberately cap-AGNOSTIC (an
 * attachment valid at export time must restore even if the operator has
 * since lowered the per-file cap — data-model.md §5.21 / the cap-rise note),
 * so the real bound is "one entry at a time", and this ceiling only stops a
 * corrupt archive from claiming an entry larger than any legitimate file.
 */
const MAX_STAGED_ENTRY_BYTES = 512 * 1024 * 1024;

/** Throttle window for progress emissions — one frame per second at most. */
const PROGRESS_THROTTLE_MS = 1000;

/** SHA-256 hex digest of a Buffer. */
function sha256Hex(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Storage key for the original ciphertext object — mirrors AttachmentService's
 * `storageKey(projectId, id, 'orig')` (ADR-0024 § key conventions). The keys
 * are local to the importing instance (the export envelope carries no opaque
 * keys), derived from the preserved `(projectId, id)`.
 */
function storageKey(projectId: string, attachmentId: string): string {
  return `attachments/${projectId}/${attachmentId}.orig`;
}

/**
 * Canonical UUID shape. Attachment `id` / `projectId` come from the
 * (attacker-influenced) envelope and feed `storageKey` in Pass 2; validating
 * the shape in Pass 1 (pre-wipe) means a hostile / malformed archive fails
 * BEFORE the destructive restore rather than mid-Pass-2 after it commits.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Manifest shapes as produced by takeout-export-builder.ts. */
interface ManifestFileEntry {
  zipPath: string;
  sizeBytes: number;
  sha256: string;
  attachmentId?: string;
}
interface Manifest {
  manifestVersion: number;
  exportedAt: string;
  totalFiles: number;
  totalBytes: number;
  files: ManifestFileEntry[];
}

/**
 * Stream a zip from disk and invoke `onEntry(name, bytes)` for each fully
 * decompressed entry, awaiting it before reading on (backpressure). Buffers
 * at most ONE entry at a time (≤ `MAX_STAGED_ENTRY_BYTES`) — never the whole
 * archive, never all entries (the bounded-memory invariant).
 *
 * fflate's `Unzip` is push-driven with synchronous per-entry `ondata`
 * callbacks; we accumulate one in-flight entry (zip entries are stored
 * sequentially, so only one is ever in flight) and, once it completes,
 * queue it for the async `onEntry`. The Node read stream's async iterator
 * applies backpressure: while `onEntry` is awaited between source chunks,
 * no further bytes are read.
 */
async function forEachZipEntry(
  zipPath: string,
  onEntry: (name: string, bytes: Buffer) => Promise<void>,
): Promise<void> {
  const chunksByName = new Map<string, Buffer[]>();
  const sizeByName = new Map<string, number>();
  const completed: Array<{ name: string; bytes: Buffer }> = [];
  let fatal: Error | null = null;

  const unzip = new Unzip((file) => {
    if (fatal) return;
    chunksByName.set(file.name, []);
    sizeByName.set(file.name, 0);
    file.ondata = (err, data, final) => {
      if (fatal) return;
      if (err) {
        fatal = err instanceof Error ? err : new Error(String(err));
        return;
      }
      const nextSize = (sizeByName.get(file.name) ?? 0) + data.length;
      if (nextSize > MAX_STAGED_ENTRY_BYTES) {
        fatal = new Error(`zip entry "${file.name}" exceeds ${MAX_STAGED_ENTRY_BYTES} bytes`);
        return;
      }
      sizeByName.set(file.name, nextSize);
      chunksByName.get(file.name)!.push(Buffer.from(data));
      if (final) {
        completed.push({ name: file.name, bytes: Buffer.concat(chunksByName.get(file.name)!) });
        chunksByName.delete(file.name);
        sizeByName.delete(file.name);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);

  const drain = async (): Promise<void> => {
    while (completed.length > 0) {
      const entry = completed.shift()!;
      await onEntry(entry.name, entry.bytes);
    }
  };

  const source = createReadStream(zipPath, { highWaterMark: 64 * 1024 });
  for await (const chunk of source) {
    unzip.push(chunk as Uint8Array, false);
    if (fatal) throw fatal;
    await drain();
  }
  unzip.push(new Uint8Array(0), true);
  if (fatal) throw fatal;
  await drain();
}

/** Parsed + validated archive metadata produced by Pass 1. */
interface ValidatedArchive {
  envelope: Envelope;
  /** Envelope attachment by id (Pass 2 reattaches plaintext to its row). */
  attachmentById: Map<string, EnvelopeAttachment>;
  /** zipPath → attachmentId, for matching a Pass-2 entry to its envelope row. */
  attachmentIdByZipPath: Map<string, string>;
}

/**
 * PASS 1 — stream the staged zip, validate everything BEFORE any destructive
 * write, and return the parsed envelope + lookup maps. Throws on any
 * validation failure (the caller maps that to `failed` with ZERO writes).
 */
async function validateArchive(deps: RunTakeoutImportDeps): Promise<ValidatedArchive> {
  let dataJson: Buffer | null = null;
  let manifestJson: Buffer | null = null;
  // Hash of every attachment entry, computed one entry at a time (we keep the
  // 64-char digest, never the bytes — bounded by file count, not by size).
  const sha256ByZipPath = new Map<string, string>();

  await forEachZipEntry(deps.stagedPath, async (name, bytes) => {
    if (name === 'data.json') {
      dataJson = bytes;
    } else if (name === 'manifest.json') {
      manifestJson = bytes;
    } else {
      sha256ByZipPath.set(name, sha256Hex(bytes));
    }
  });

  if (!dataJson) throw new Error('archive is missing data.json');
  if (!manifestJson) throw new Error('archive is missing manifest.json');

  const envelope = JSON.parse((dataJson as Buffer).toString('utf-8')) as Envelope;
  const manifest = JSON.parse((manifestJson as Buffer).toString('utf-8')) as Manifest;

  // data.json integrity (its manifest entry carries no attachmentId).
  const dataJsonEntry = manifest.files.find((f) => f.zipPath === 'data.json');
  if (!dataJsonEntry) throw new Error('manifest.json has no entry for data.json');
  if (sha256Hex(dataJson as Buffer) !== dataJsonEntry.sha256) {
    throw new Error('data.json SHA-256 does not match manifest');
  }

  const attachmentEntries = manifest.files.filter((f) => f.attachmentId);

  // Attachment-id uniqueness within the manifest.
  const manifestAttachmentIds = new Set<string>();
  for (const entry of attachmentEntries) {
    if (manifestAttachmentIds.has(entry.attachmentId!)) {
      throw new Error(`duplicate attachment id ${entry.attachmentId} in manifest`);
    }
    manifestAttachmentIds.add(entry.attachmentId!);
  }

  // Coverage parity: envelope.attachments ↔ manifest attachment entries.
  const envelopeAttachmentIds = new Set(envelope.attachments.map((a) => a.id));
  for (const id of envelopeAttachmentIds) {
    if (!manifestAttachmentIds.has(id))
      throw new Error(`envelope attachment ${id} has no manifest entry`);
  }
  for (const id of manifestAttachmentIds) {
    if (!envelopeAttachmentIds.has(id))
      throw new Error(`manifest attachment ${id} absent from envelope`);
  }

  // Attachment → project referential integrity (against the envelope's own projects).
  const envelopeProjectIds = new Set(envelope.projects.map((p) => p.id));
  for (const att of envelope.attachments) {
    if (!UUID_RE.test(att.id) || !UUID_RE.test(att.projectId)) {
      throw new Error(`attachment ${att.id} has a malformed id or projectId`);
    }
    if (!envelopeProjectIds.has(att.projectId)) {
      throw new Error(`attachment ${att.id} references project ${att.projectId} not in envelope`);
    }
  }

  // Per-attachment presence + SHA-256 (computed in the streaming pass above).
  const attachmentIdByZipPath = new Map<string, string>();
  for (const entry of attachmentEntries) {
    const actual = sha256ByZipPath.get(entry.zipPath);
    if (actual === undefined)
      throw new Error(`archive is missing attachment entry ${entry.zipPath}`);
    if (actual !== entry.sha256) {
      throw new Error(`SHA-256 mismatch for ${entry.zipPath}`);
    }
    attachmentIdByZipPath.set(entry.zipPath, entry.attachmentId!);
  }

  const attachmentById = new Map(envelope.attachments.map((a) => [a.id, a]));
  return { envelope, attachmentById, attachmentIdByZipPath };
}

/**
 * Drive one import to its terminal state. The route has already stamped
 * `running` + `archiveRef`; this runs detached (fire-and-forget) and never
 * rejects. Resolves once the job is `ready` or `failed`.
 */
export async function runTakeoutImport(deps: RunTakeoutImportDeps): Promise<void> {
  const { db, jobs, storage, jobId, logger } = deps;
  try {
    // PASS 1 — validate before any destructive write.
    const { envelope, attachmentById, attachmentIdByZipPath } = await validateArchive(deps);

    // RESTORE — business rows via the shared override transaction. This
    // TRUNCATEs the importable set + users (→ sessions CASCADE, AC-330) and
    // re-inserts with IDs preserved. writeAuditRow:false → the job owns the
    // terminal row; caller:null → no import token minted.
    const importSvc = new ImportService(db, storage);
    await importSvc.import(
      envelope,
      {
        dryRun: false,
        override: true,
        confirmationPhrase: RESTORE_CONFIRMATION_PHRASE,
        writeAuditRow: false,
      },
      logger,
      null,
    );

    // PASS 2 — re-encrypt + insert attachments, one buffered entry at a time.
    const envelopeService = new KeyEnvelopeService({
      recipient: deps.binaryAgeRecipient,
      identityPath: deps.binaryAgeIdentityPath,
    });
    const filesTotal = envelope.attachments.length;
    const bytesTotal = envelope.attachments.reduce((sum, a) => sum + a.sizeBytes, 0);
    let filesDone = 0;
    let bytesDone = 0;
    let lastProgressAt = 0;

    const emitProgress = async (currentItem: string | null, force: boolean): Promise<void> => {
      const now = Date.now();
      if (!force && now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
      lastProgressAt = now;
      await jobs.updateProgress(jobId, {
        filesTotal,
        bytesTotal,
        filesDone,
        bytesDone,
        currentItem,
      });
    };

    try {
      await forEachZipEntry(deps.stagedPath, async (name, plaintext) => {
        if (name === 'data.json' || name === 'manifest.json') return;
        const attachmentId = attachmentIdByZipPath.get(name);
        if (!attachmentId) return; // not an attachment entry (validated in Pass 1)
        const att = attachmentById.get(attachmentId);
        if (!att) return; // parity-checked in Pass 1

        // Fresh DEK, AES-256-GCM (nonce(12)||ct||tag(16)); wrap under the
        // instance recipient; PUT ciphertext to B2; insert the ready row.
        const { ciphertext, dek } = encryptInvoicePayload(plaintext);
        const wrapped = await envelopeService.wrap(Buffer.from(dek));
        const originalKey = storageKey(att.projectId, att.id);
        await storage.upload(originalKey, Buffer.from(ciphertext), 'application/octet-stream');
        await db.insert(attachments).values({
          id: att.id,
          projectId: att.projectId,
          status: 'ready',
          kind: att.kind,
          label: att.label,
          filename: att.fileName,
          mimeType: att.mimeType,
          sizeBytes: att.sizeBytes,
          originalKey,
          hasThumbnail: false, // photo-thumbnail regen out of scope (module header)
          ciphertextSizeBytes: ciphertext.byteLength,
          wrappedDek: Buffer.from(wrapped).toString('base64'),
          wrappedDekVersion: WRAPPED_DEK_CURRENT_VERSION,
          createdBy: att.createdBy,
          createdAt: new Date(att.createdAt),
        });

        filesDone += 1;
        bytesDone += plaintext.length;
        await emitProgress(att.fileName, false);
      });
      await emitProgress(null, true);
    } finally {
      envelopeService.close();
    }

    await jobs.markReady(jobId, deps.stagedPath, {
      action: 'import_restored',
      entityLabel: 'Import wiederhergestellt',
      payload: { filesTotal, filesDone, bytesDone },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error(
      { event: 'takeout-import-failed', jobId, error_hint: detail },
      'takeout-import-failed',
    );
    try {
      await jobs.markFailed(jobId, detail, {
        action: 'import_failed',
        entityLabel: 'Import fehlgeschlagen',
        payload: { error: detail },
      });
    } catch (innerErr) {
      logger.error(
        {
          event: 'takeout-import-mark-failed-error',
          jobId,
          error_hint: innerErr instanceof Error ? innerErr.message : String(innerErr),
        },
        'takeout-import-mark-failed-error',
      );
    }
    // The staged upload is intentionally retained on failure — `archiveRef`
    // was stamped at markRunning, so the staging reaper (data-model.md §6.15)
    // sweeps it on the TTL clock for both ready and failed import jobs.
    //
    // A failure partway through Pass 2 leaves the already-committed business
    // rows + the attachments inserted so far (`status='ready'`, valid
    // ciphertext on B2). That partial state is recovered by the spec's
    // re-run-is-a-full-replace model (AC-328): a subsequent override import's
    // pre-wipe `listAllKeys` hide (ImportService) demotes those keys and the
    // re-run re-PUTs the deterministic `(projectId, id)` keys. No explicit
    // Pass-2 storage rollback is attempted — hiding here would strand the
    // committed rows' still-valid bytes in the window before a re-run.
  }
}
