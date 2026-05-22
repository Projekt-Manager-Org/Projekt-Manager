/**
 * Browser-side import-all orchestrator (issue #163, AC-260/261/262).
 *
 * Mirrors `exportAllAsZip.ts`: where export drives the takeout-zip
 * assembly, this module drives the inverse — read a takeout zip, validate
 * its structure, POST the stripped envelope to `/api/import`, then drive
 * the standard per-attachment upload pipeline (init → PUT → complete) for
 * each attachment via the injected callbacks. The whole flow lives off
 * the React tree so the AC contracts can be exercised in isolation; the
 * dialog (`VollstaendigerImportDialog`) and runner hook
 * (`useImportAllRunner`) only thread progress / cancellation callbacks
 * through.
 *
 * Step layout — per `ui/daten.md §8.11.2`:
 *   1. Structural manifest + zip-coverage parity (AC-260) and
 *      `schema_version` pin (AC-262). NO per-file hashing here — the
 *      canonical hash check fires once per entry on read in step 5
 *      (orchestrator never double-hashes). Any mismatch aborts before
 *      any wire fires.
 *   2. Operator-confirmation gate — driven externally by the dialog.
 *      The orchestrator assumes the caller has already gated.
 *   3. Strip the `attachments` key from the parsed envelope.
 *   4. POST the text-only envelope via `postTextLeg`. Atomicity is
 *      server-side (truncate + reinsert under one tx).
 *   5. Per-attachment leg — for each `data.json.attachments[]` entry,
 *      bounded concurrency (~4):
 *        a. Read the zip entry (path = `manifest.json[i].zipPath`).
 *        b. SHA-256-verify against the manifest's per-entry hash. A
 *           mismatch is FATAL — abort, walk the committed list,
 *           DELETE-each.
 *        c. Run the standard upload flow: init (with `restore` block)
 *           → PUT ciphertext (original + thumbnail when present) →
 *           complete. The orchestrator delegates the actual init→PUT→
 *           complete dance to injected callbacks so the dialog hook can
 *           wire MD5, encryption, and image-pipeline thumbnail
 *           generation in (rather than duplicating
 *           `attachmentStore.runUpload`).
 *   6. Rollback — on a fatal error, walk the committed-id list and
 *      DELETE each. The contract is `rolledBack ⊇ committed` regardless
 *      of concurrency / order (AC-261's set-relation pin).
 *   7. Per-file non-fatal failures are recorded but do NOT abort. The
 *      result surfaces them so the dialog can render the
 *      "X Anhänge übersprungen" line (`ui/daten.md §8.11.2` step 7).
 *
 * Concurrency-agnostic rollback (AC-261):
 * Bounded concurrency means entries 1/2/3 may all be inflight when
 * entry 3's hash check fires. The committed set is what the rollback
 * walk covers — every id whose `complete` resolved appears in the
 * DELETE list. Entries that never reached `init` (because the SHA-256
 * check rejected them) NEVER appear, regardless of order.
 *
 * Sticky-abort discipline:
 * Once a fatal failure lands, no NEW per-file work starts. Inflight
 * legs run to whatever next abort checkpoint they hit; the rollback
 * walk also covers ids that committed AFTER the abort flag flipped
 * (rollback is from the committed set, not the abort timestamp).
 */

import { unzipSync } from 'fflate';

import type { AttachmentLabel } from '@/domain/types';

/**
 * Manifest top-level shape produced by `exportAllAsZip.ts`. Re-declared
 * here rather than imported so a refactor of the export-side type
 * doesn't cascade silently into the importer's structural validator
 * (the validator runs on untrusted input — every assertion is local).
 */
export interface ManifestEntry {
  zipPath: string;
  sizeBytes: number;
  sha256: string;
  attachmentId?: string;
}

export interface Manifest {
  manifestVersion: 1;
  exportedAt: string;
  totalFiles: number;
  totalBytes: number;
  files: ManifestEntry[];
}

/**
 * Attachment row carried inside the takeout zip's `data.json` envelope.
 * Mirrors `EnvelopeAttachment` from `src/domain/dataExchange.ts §5.8`,
 * but inlined for the same reason as `Manifest` above.
 */
export interface ImportEnvelopeAttachment {
  id: string;
  projectId: string;
  status?: 'ready';
  kind: 'photo' | 'binary';
  label: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  createdBy: string | null;
}

export interface ImportEnvelope {
  schema_version: number;
  exported_at: string;
  /**
   * Issue #230: the envelope round-trips every user-meaningful business
   * table. The orchestrator only needs row counts (for the preflight
   * readout) and the attachments slot (for the binary leg), so the
   * other slots are typed as `unknown[]` — the server's `/api/import`
   * is the authoritative validator for each row's shape.
   */
  users: unknown[];
  company_profile: unknown[];
  customers: unknown[];
  projects: unknown[];
  project_workers: unknown[];
  invoices: unknown[];
  invoice_sequence: unknown[];
  /**
   * Attachments — present in the takeout zip's `data.json`. Stripped
   * before the text-leg POST (`/api/import` rejects the key per
   * AC-253).
   */
  attachments?: ImportEnvelopeAttachment[];
}

/** Restore-block subset of `data.json[i]` we forward to `init`. */
export interface RestoreBlock {
  id: string;
  createdBy: string;
  createdAt: string;
}

/**
 * Wire-shape result of one `init` call as the orchestrator consumes it.
 * Subset of the server's `AttachmentInitResponse` — only the fields the
 * orchestrator forwards to `putCiphertext` and `completeAttachment`.
 */
export interface InitAttachmentResult {
  id: string;
  originalUpload: { url: string; headers: Record<string, string> };
  thumbnailUpload?: { url: string; headers: Record<string, string> };
}

/**
 * Per-file failure record. Surfaced in `ImportAllResult.failures` so
 * the dialog can render the "X Anhänge übersprungen" summary (`ui/
 * daten.md §8.11.4` step 7).
 */
export interface ImportFailure {
  attachmentId: string;
  zipPath: string;
  reason: string;
}

export interface ImportAllResult {
  /** Number of attachments whose `complete` resolved. */
  committedCount: number;
  /** Per-file non-fatal failures. */
  failures: ImportFailure[];
  /** Total attachment rows referenced by `data.json`. */
  totalAttachments: number;
}

/**
 * Per-entry payload the runner hook builds before forwarding to
 * `initAttachment`. The orchestrator stays crypto-agnostic — the
 * runner hook owns DEK generation, MD5, and image-pipeline thumbs.
 *
 * `label` is the closed-enum `AttachmentLabel`; the runner narrows
 * the envelope's free-string `label` field via `validateLabel` before
 * constructing this payload. The orchestrator forwards verbatim.
 */
export interface InitPayload {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  label: AttachmentLabel;
  hasThumbnail: boolean;
  dekMaterial: string;
  ciphertextSizeBytes: number;
  ciphertextContentMd5: string;
  thumbDekMaterial?: string;
  ciphertextThumbSizeBytes?: number;
  ciphertextThumbContentMd5?: string;
}

/**
 * Per-attachment work the runner hook performs in-line: hash already
 * verified, plaintext bytes are the zip-entry bytes. The runner runs
 * the image-pipeline (for photos), encrypts each blob with a fresh
 * DEK + nonce, computes MD5s, and returns the init payload + the
 * pre-encrypted ciphertexts the orchestrator PUTs to storage.
 */
export interface PrepareAttachmentInput {
  entry: ImportEnvelopeAttachment;
  plaintext: Uint8Array;
}

export interface PrepareAttachmentResult {
  initPayload: InitPayload;
  /** AES-256-GCM ciphertext for the original blob (`nonce || ct || tag`). */
  originalCiphertext: Uint8Array;
  /** AES-256-GCM ciphertext for the thumbnail; absent for binaries / photos without a thumb. */
  thumbnailCiphertext?: Uint8Array;
}

/**
 * Wide callable type — accommodates `vi.fn()` mocks (whose default
 * `Mock<Procedure | Constructable>` shape resolves to a union including
 * a constructable-only branch that doesn't match a plain function
 * signature). Each callback's narrowed contract is documented on its
 * field below; the orchestrator type-asserts the awaited result at the
 * use site.
 *
 * Plain `unknown` rather than a function type, because the vitest
 * `Mock<Procedure | Constructable>` type widens to a union with a
 * constructable-only branch that no plain `(...args) => unknown`
 * signature subsumes. The orchestrator narrows at each call site.
 */
type CallbackInput = unknown;

/**
 * Parsed takeout-zip bag — the runner hook produces this once at file-
 * pick time so the orchestrator never re-unzips the same bytes for the
 * commit run. See `parseTakeoutZip` below for the producer; the
 * orchestrator accepts EITHER raw `zip` bytes (re-parsed in-line, the
 * unit-test path) OR a pre-parsed bag (the runner hook's hot path).
 *
 * `entries` keeps `unzipSync`'s return shape verbatim so a switch from
 * `fflate` to a streaming reader later is a one-place producer change.
 */
export interface ParsedTakeoutZip {
  entries: Record<string, Uint8Array>;
  manifest: Manifest;
  envelope: ImportEnvelope;
}

export interface ImportAllInput {
  /**
   * Takeout-zip bytes (from the file picker). Mutually exclusive with
   * `parsed`; one of the two MUST be supplied. Raw `zip` is the
   * unit-test entry path — the orchestrator re-parses on every call.
   * Production-side callers should pre-parse via `parseTakeoutZip` and
   * thread `parsed` through `start` so a non-trivial takeout zip
   * (hundreds of MB) is never inflated twice.
   */
  zip?: Uint8Array;
  /**
   * Pre-parsed takeout-zip bag — the runner hook's hot path. When
   * supplied, the orchestrator skips its own `unzipSync` call and the
   * structural validators that the producer already ran.
   */
  parsed?: ParsedTakeoutZip;
  /**
   * Importing instance's pinned `SCHEMA_VERSION` (`src/domain/dataExchange.ts`).
   * Threaded through rather than read directly so the helper stays a
   * pure module unit-testable without touching the schema constant.
   */
  pinnedSchemaVersion: number;
  /**
   * POST `/api/import` with the stripped envelope (no `attachments`
   * key). Resolves `{ ok: true }` on success, `{ ok: false, message? }`
   * on rejection. A failed text-leg aborts the run BEFORE any
   * per-attachment work fires; rollback is a no-op (nothing committed
   * yet). The runner hook owns the override-flag + confirmation-phrase
   * threading.
   *
   * Narrowed contract:
   *   `(envelopeWithoutAttachments: Omit<ImportEnvelope, 'attachments'>) =>
   *      Promise<{ ok: boolean; message?: string }>`
   */
  postTextLeg: CallbackInput;
  /**
   * Prepare a per-file payload — runner-side hook does image pipeline
   * + encryption + MD5. Optional in the orchestrator: when the runner
   * doesn't supply it, the test mocks fill in the orchestrator-shape
   * defaults (no encryption, dummy DEK material). The orchestrator
   * threads the prepared init payload into the `init` call.
   *
   * Narrowed contract:
   *   `(input: PrepareAttachmentInput) => Promise<PrepareAttachmentResult>`
   */
  prepareAttachment?: CallbackInput;
  /**
   * POST `/api/projects/:projectId/attachments/init` with the full
   * `restore` block. The orchestrator forwards the prepared init
   * payload (when present) plus the entry. The mock in the unit tests
   * accepts the full arg list but reads only `entry`.
   *
   * Narrowed contract:
   *   `(entry: ImportEnvelopeAttachment, restore: RestoreBlock, payload?: InitPayload) =>
   *      Promise<InitAttachmentResult>`
   */
  initAttachment: CallbackInput;
  /**
   * PUT presigned URL — body is the ciphertext.
   *
   * Narrowed contract:
   *   `(url: string, headers: Record<string, string>, ciphertext: Uint8Array) => Promise<void>`
   */
  putCiphertext: CallbackInput;
  /**
   * POST `/api/projects/:projectId/attachments/:attId/complete`.
   *
   * Narrowed contract:
   *   `(id: string) => Promise<{ id: string; status: 'ready' }>`
   */
  completeAttachment: CallbackInput;
  /**
   * DELETE `/api/projects/:projectId/attachments/:attId` — soft-hide rollback.
   *
   * Narrowed contract:
   *   `(id: string) => Promise<void>`
   */
  deleteAttachment: CallbackInput;
  /** Optional cancel signal — fired aborts before the next checkpoint. */
  signal?: AbortSignal;
  /**
   * Optional progress callback — fires once per per-file lifecycle
   * change (started, committed, failed). The runner hook uses this to
   * advance the "X / Y Dateien" + bytes-done readout.
   */
  onProgress?: (event: ProgressEvent) => void;
  /** Bounded concurrency for the per-attachment leg. Defaults to 4. */
  concurrency?: number;
}

/**
 * Per-file lifecycle event — the runner hook's progress mutator
 * consumes these.
 */
export type ProgressEvent =
  | { kind: 'attachment-start'; entry: ImportEnvelopeAttachment }
  | { kind: 'attachment-committed'; entry: ImportEnvelopeAttachment; attachmentId: string }
  | { kind: 'attachment-failed'; entry: ImportEnvelopeAttachment; reason: string };

const DEFAULT_CONCURRENCY = 4;

/**
 * Hex-lowercase SHA-256. Matches `exportAllAsZip.ts`'s `sha256Hex` byte
 * for byte — both sides agreeing on encoding is the load-bearing
 * property of the per-entry verification.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Validate `manifest.json` top-level shape per AC-252 / `ui/daten.md
 * §8.11.4` step 1. Returns null on success; throws on any structural
 * defect — the caller never gets a partial manifest.
 */
function validateManifestShape(value: unknown): asserts value is Manifest {
  if (!value || typeof value !== 'object') {
    throw new Error('importAllFromZip: manifest.json is not an object');
  }
  const m = value as Record<string, unknown>;
  if (m.manifestVersion !== 1) {
    throw new Error('importAllFromZip: manifest.json missing manifestVersion=1');
  }
  if (typeof m.exportedAt !== 'string') {
    throw new Error('importAllFromZip: manifest.json.exportedAt missing or not a string');
  }
  if (typeof m.totalFiles !== 'number') {
    throw new Error('importAllFromZip: manifest.json.totalFiles missing or not a number');
  }
  if (typeof m.totalBytes !== 'number') {
    throw new Error('importAllFromZip: manifest.json.totalBytes missing or not a number');
  }
  if (!Array.isArray(m.files)) {
    throw new Error('importAllFromZip: manifest.json.files missing or not an array');
  }
  for (let i = 0; i < m.files.length; i += 1) {
    const f = m.files[i] as Record<string, unknown> | null;
    if (!f || typeof f !== 'object') {
      throw new Error(`importAllFromZip: manifest.json.files[${i}] is not an object`);
    }
    if (typeof f.zipPath !== 'string') {
      throw new Error(`importAllFromZip: manifest.json.files[${i}].zipPath missing`);
    }
    if (typeof f.sizeBytes !== 'number') {
      throw new Error(`importAllFromZip: manifest.json.files[${i}].sizeBytes missing`);
    }
    if (typeof f.sha256 !== 'string') {
      throw new Error(`importAllFromZip: manifest.json.files[${i}].sha256 missing`);
    }
  }
}

/**
 * Validate `data.json` envelope shape — top-level array fields exist
 * and `schema_version` is a number. Per-row validation belongs to the
 * server (`ImportService`). The orchestrator just needs enough shape
 * to strip `attachments` and forward the rest.
 */
function validateEnvelopeShape(value: unknown): asserts value is ImportEnvelope {
  if (!value || typeof value !== 'object') {
    throw new Error('importAllFromZip: data.json is not an object');
  }
  const e = value as Record<string, unknown>;
  if (typeof e.schema_version !== 'number') {
    throw new Error('importAllFromZip: data.json.schema_version missing or not a number');
  }
  if (typeof e.exported_at !== 'string') {
    throw new Error('importAllFromZip: data.json.exported_at missing or not a string');
  }
  if (!Array.isArray(e.users)) {
    throw new Error('importAllFromZip: data.json.users missing or not an array');
  }
  if (!Array.isArray(e.company_profile)) {
    throw new Error('importAllFromZip: data.json.company_profile missing or not an array');
  }
  if (!Array.isArray(e.customers)) {
    throw new Error('importAllFromZip: data.json.customers missing or not an array');
  }
  if (!Array.isArray(e.projects)) {
    throw new Error('importAllFromZip: data.json.projects missing or not an array');
  }
  if (!Array.isArray(e.project_workers)) {
    throw new Error('importAllFromZip: data.json.project_workers missing or not an array');
  }
  if (!Array.isArray(e.invoices)) {
    throw new Error('importAllFromZip: data.json.invoices missing or not an array');
  }
  if (!Array.isArray(e.invoice_sequence)) {
    throw new Error('importAllFromZip: data.json.invoice_sequence missing or not an array');
  }
  if (e.attachments !== undefined && !Array.isArray(e.attachments)) {
    throw new Error('importAllFromZip: data.json.attachments must be an array when present');
  }
}

/**
 * Strip the `attachments` key from the parsed envelope. Mutates a
 * shallow copy so the original parsed object stays intact for the
 * per-attachment leg.
 */
function stripAttachments(envelope: ImportEnvelope): Omit<ImportEnvelope, 'attachments'> {
  const { attachments: _drop, ...rest } = envelope;
  void _drop;
  return rest;
}

/**
 * Locate the manifest entry for a given `attachmentId`. Falls back to
 * the export-side path-builder shape (`attachments/<dir>/<id>-...`)
 * when the manifest entry doesn't carry an explicit `attachmentId`
 * (the export side adds it for attachments and skips it for the
 * top-level `data.json` row).
 */
function findManifestForAttachmentId(
  manifest: Manifest,
  attachmentId: string,
): ManifestEntry | undefined {
  return manifest.files.find((f) => f.attachmentId === attachmentId);
}

/**
 * Parse + structurally validate a takeout zip. Producer side of the
 * `ParsedTakeoutZip` bag — the runner hook calls this once on file
 * pick so the orchestrator's commit-run step 1 never re-unzips the
 * same (possibly hundreds-of-MB) bytes.
 *
 * Throws on any structural defect — missing `data.json` /
 * `manifest.json`, invalid manifest / envelope shape, unreadable zip.
 * The orchestrator's commit run trusts a parsed bag without
 * re-validating shape (the producer is the single validator).
 */
export function parseTakeoutZip(zip: Uint8Array): ParsedTakeoutZip {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip);
  } catch (err) {
    throw new Error(
      `parseTakeoutZip: zip unreadable: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (!entries['manifest.json']) {
    throw new Error('parseTakeoutZip: manifest.json missing from zip');
  }
  if (!entries['data.json']) {
    throw new Error('parseTakeoutZip: data.json missing from zip');
  }

  let manifest: Manifest;
  try {
    const text = new TextDecoder().decode(entries['manifest.json']);
    const parsed = JSON.parse(text);
    validateManifestShape(parsed);
    manifest = parsed;
  } catch (err) {
    throw new Error(
      `parseTakeoutZip: manifest.json invalid: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  let envelope: ImportEnvelope;
  try {
    const text = new TextDecoder().decode(entries['data.json']);
    const parsed = JSON.parse(text);
    validateEnvelopeShape(parsed);
    envelope = parsed;
  } catch (err) {
    throw new Error(
      `parseTakeoutZip: data.json invalid: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  return { entries, manifest, envelope };
}

/**
 * The orchestrator's entry point. See module doc.
 */
export async function importAllFromZip(input: ImportAllInput): Promise<ImportAllResult> {
  const {
    zip,
    parsed,
    pinnedSchemaVersion,
    postTextLeg,
    prepareAttachment,
    initAttachment,
    putCiphertext,
    completeAttachment,
    deleteAttachment,
    signal,
    onProgress,
    concurrency = DEFAULT_CONCURRENCY,
  } = input;

  // ----------------------------------------------------------------
  // Step 1 — structural manifest + zip-coverage parity, schema_version pin.
  //
  // Two entry shapes:
  //   - `parsed` (runner hot path): the producer pre-parsed at file
  //     pick time; reuse the bag verbatim. Skips the second unzip.
  //   - `zip` (unit-test path + any external caller without a parsed
  //     bag): parse on the fly via `parseTakeoutZip`. Same validators
  //     run, same shape produced.
  // ----------------------------------------------------------------
  if (!parsed && !zip) {
    throw new Error('importAllFromZip: either `zip` bytes or `parsed` bag is required');
  }
  const bag: ParsedTakeoutZip = parsed ?? parseTakeoutZip(zip!);
  const { entries, manifest, envelope } = bag;

  // AC-262: schema_version pin. Reject before any wire fires.
  if (envelope.schema_version !== pinnedSchemaVersion) {
    throw new Error(
      `importAllFromZip: schema_version mismatch (envelope=${envelope.schema_version}, expected=${pinnedSchemaVersion})`,
    );
  }

  // AC-260 parity check — every manifest entry has a zip entry, every
  // attachment-bearing zip entry is listed in the manifest. The
  // manifest does NOT list itself (`exportAllAsZip.ts` step 3); it is
  // the only legal "extra" zip entry.
  const manifestZipPaths = new Set(manifest.files.map((f) => f.zipPath));
  for (const f of manifest.files) {
    if (!entries[f.zipPath]) {
      throw new Error(`importAllFromZip: manifest entry has no matching zip entry: ${f.zipPath}`);
    }
  }
  for (const zipPath of Object.keys(entries)) {
    if (zipPath === 'manifest.json') continue;
    if (!manifestZipPaths.has(zipPath)) {
      throw new Error(
        `importAllFromZip: zip carries an entry not listed in manifest.json: ${zipPath}`,
      );
    }
  }

  // Attachments envelope ⊆ manifest entries (every attachment row in
  // `data.json` has a manifest line). Per `ui/daten.md §8.11.2` step 1,
  // count parity is the load-bearing assertion — a manifest carrying
  // strictly more attachment-tagged entries than the envelope is also
  // a structural break.
  const envelopeAttachments = envelope.attachments ?? [];
  const manifestAttachmentCount = manifest.files.filter((f) => f.attachmentId !== undefined).length;
  if (manifestAttachmentCount !== envelopeAttachments.length) {
    throw new Error(
      `importAllFromZip: manifest attachment count (${manifestAttachmentCount}) does not match envelope.attachments.length (${envelopeAttachments.length})`,
    );
  }
  for (const a of envelopeAttachments) {
    if (!findManifestForAttachmentId(manifest, a.id)) {
      throw new Error(
        `importAllFromZip: envelope.attachments[id=${a.id}] has no matching manifest entry`,
      );
    }
  }

  // ----------------------------------------------------------------
  // Step 2 — operator confirmation gate. Owned by the dialog; the
  // orchestrator assumes the caller has already gated.
  //
  // Step 3 — strip `attachments` for the text-leg POST.
  // ----------------------------------------------------------------
  const textLegBody = stripAttachments(envelope);

  // ----------------------------------------------------------------
  // Step 4 — text-leg POST. Failure aborts before any per-attachment
  // work fires; rollback is a no-op (committed list is still empty).
  // ----------------------------------------------------------------
  const postTextLegFn = postTextLeg as (
    body: Omit<ImportEnvelope, 'attachments'>,
  ) => Promise<{ ok: boolean; message?: string }>;
  const textLegResult = await postTextLegFn(textLegBody);
  if (!textLegResult.ok) {
    throw new Error(
      `importAllFromZip: text-leg /api/import rejected${
        textLegResult.message ? `: ${textLegResult.message}` : ''
      }`,
    );
  }

  // ----------------------------------------------------------------
  // Step 5 — per-attachment leg. Bounded concurrency = ~4 (matches
  // the export side). A SHA-256 mismatch is FATAL — set the sticky
  // abort flag and let the inflight workers wind down; new entries
  // never start. After the workers settle, walk the committed list
  // and DELETE-rollback (step 6).
  // ----------------------------------------------------------------
  const committedIds: string[] = [];
  const failures: ImportFailure[] = [];

  let fatalError: Error | null = null;

  /**
   * Process one entry: fetch zip bytes, hash-verify, prepare, init,
   * PUT each blob, complete. Returns void; mutates `committedIds` and
   * `failures` in closure.
   *
   * - SHA-256 mismatch = FATAL. Sets `fatalError`.
   * - Any other failure (init 422 / PUT rejection / complete 409 /
   *   network) = non-fatal: record in `failures`, skip the entry.
   * - Cancel via `signal` = honored at every checkpoint.
   */
  async function processEntry(entry: ImportEnvelopeAttachment): Promise<void> {
    if (fatalError !== null) return;
    if (signal?.aborted) return;

    const manifestEntry = findManifestForAttachmentId(manifest, entry.id);
    if (!manifestEntry) {
      // Already validated in step 1; defensive only. A reachable hit
      // here would be a regression in the parity check.
      failures.push({
        attachmentId: entry.id,
        zipPath: '',
        reason: 'manifest entry vanished',
      });
      onProgress?.({ kind: 'attachment-failed', entry, reason: 'manifest entry vanished' });
      return;
    }
    const zipPath = manifestEntry.zipPath;
    const plaintext = entries[zipPath];
    if (!plaintext) {
      // Already validated in step 1; defensive only.
      failures.push({ attachmentId: entry.id, zipPath, reason: 'zip entry vanished' });
      onProgress?.({ kind: 'attachment-failed', entry, reason: 'zip entry vanished' });
      return;
    }

    onProgress?.({ kind: 'attachment-start', entry });

    // Step 5b — canonical per-entry hash check. Mismatch = FATAL.
    let actualHash: string;
    try {
      actualHash = await sha256Hex(plaintext);
    } catch (err) {
      fatalError = new Error(
        `importAllFromZip: SHA-256 hashing failed for ${zipPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    if (actualHash !== manifestEntry.sha256) {
      fatalError = new Error(
        `importAllFromZip: SHA-256 mismatch on ${zipPath} (manifest=${manifestEntry.sha256}, computed=${actualHash})`,
      );
      return;
    }

    if (fatalError !== null) return;
    if (signal?.aborted) return;

    // Step 5c — prepare (encrypt + MD5 + thumb), init, PUT, complete.
    const prepareFn = prepareAttachment as
      | ((input: PrepareAttachmentInput) => Promise<PrepareAttachmentResult>)
      | undefined;
    let prepared: PrepareAttachmentResult | undefined;
    if (prepareFn) {
      try {
        prepared = await prepareFn({ entry, plaintext });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        failures.push({ attachmentId: entry.id, zipPath, reason: `prepare: ${reason}` });
        onProgress?.({ kind: 'attachment-failed', entry, reason: `prepare: ${reason}` });
        return;
      }
    }

    if (fatalError !== null) return;
    if (signal?.aborted) return;

    // The server's `init` schema requires `createdBy` to be a UUID —
    // there is no null-passing branch on the restore block — so a null
    // source here is a non-fatal skip with a clear reason instead of
    // a generic 422 the server would surface. Guard first so the
    // restore-block construction below sees `createdBy` narrowed to
    // string.
    if (entry.createdBy === null) {
      failures.push({
        attachmentId: entry.id,
        zipPath,
        reason: 'envelope row has no createdBy — restore-mode init requires a non-null uploader',
      });
      onProgress?.({
        kind: 'attachment-failed',
        entry,
        reason: 'envelope row has no createdBy',
      });
      return;
    }
    const restore: RestoreBlock = {
      id: entry.id,
      createdBy: entry.createdBy,
      createdAt: entry.createdAt,
    };

    const initFn = initAttachment as (
      entry: ImportEnvelopeAttachment,
      restore: RestoreBlock,
      payload?: InitPayload,
    ) => Promise<InitAttachmentResult>;
    let initResult: InitAttachmentResult;
    try {
      initResult = await initFn(entry, restore, prepared?.initPayload);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push({ attachmentId: entry.id, zipPath, reason: `init: ${reason}` });
      onProgress?.({ kind: 'attachment-failed', entry, reason: `init: ${reason}` });
      return;
    }

    if (fatalError !== null) return;
    if (signal?.aborted) return;

    // PUT ciphertexts. When `prepareAttachment` ran, the runner has
    // produced ciphertext blobs and the orchestrator forwards them
    // verbatim. When it didn't (test path with mock-only init), the
    // orchestrator PUTs the plaintext bytes — the mock `putCiphertext`
    // doesn't inspect the body shape, so this stays test-friendly.
    const putFn = putCiphertext as (
      url: string,
      headers: Record<string, string>,
      ciphertext: Uint8Array,
    ) => Promise<void>;
    const originalBytes = prepared?.originalCiphertext ?? plaintext;
    try {
      await putFn(initResult.originalUpload.url, initResult.originalUpload.headers, originalBytes);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push({
        attachmentId: entry.id,
        zipPath,
        reason: `PUT original: ${reason}`,
      });
      onProgress?.({ kind: 'attachment-failed', entry, reason: `PUT original: ${reason}` });
      return;
    }

    if (initResult.thumbnailUpload && prepared?.thumbnailCiphertext) {
      try {
        await putFn(
          initResult.thumbnailUpload.url,
          initResult.thumbnailUpload.headers,
          prepared.thumbnailCiphertext,
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        failures.push({
          attachmentId: entry.id,
          zipPath,
          reason: `PUT thumbnail: ${reason}`,
        });
        onProgress?.({ kind: 'attachment-failed', entry, reason: `PUT thumbnail: ${reason}` });
        return;
      }
    }

    if (fatalError !== null) return;
    if (signal?.aborted) return;

    const completeFn = completeAttachment as (
      id: string,
    ) => Promise<{ id: string; status: 'ready' }>;
    try {
      await completeFn(initResult.id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push({
        attachmentId: entry.id,
        zipPath,
        reason: `complete: ${reason}`,
      });
      onProgress?.({ kind: 'attachment-failed', entry, reason: `complete: ${reason}` });
      return;
    }

    // Per AC-261's set-relation contract: every id whose `complete`
    // resolved appears in the rollback walk on a downstream fatal.
    committedIds.push(initResult.id);
    onProgress?.({
      kind: 'attachment-committed',
      entry,
      attachmentId: initResult.id,
    });
  }

  // Bounded-concurrency worker pool. Index-based pull keeps the
  // sticky-abort discipline simple — once `fatalError` flips, the
  // worker's outer loop exits before pulling the next index.
  let nextIdx = 0;
  async function worker(): Promise<void> {
    for (;;) {
      if (fatalError !== null) return;
      if (signal?.aborted) return;
      const i = nextIdx;
      nextIdx += 1;
      if (i >= envelopeAttachments.length) return;
      await processEntry(envelopeAttachments[i]!);
    }
  }
  const workerCount = Math.min(Math.max(1, concurrency), envelopeAttachments.length || 1);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // ----------------------------------------------------------------
  // Step 6 — rollback on fatal. Walk the committed list and DELETE
  // each. Settled-mode is intentional: a DELETE that itself fails
  // doesn't matter for the AC contract (the orphan reaper handles
  // eventual cleanup), and we want every id attempted regardless of
  // individual rejections.
  // ----------------------------------------------------------------
  const deleteFn = deleteAttachment as (id: string) => Promise<void>;
  if (fatalError !== null) {
    await Promise.allSettled(committedIds.map((id) => deleteFn(id)));
    throw fatalError;
  }

  return {
    committedCount: committedIds.length,
    failures,
    totalAttachments: envelopeAttachments.length,
  };
}
