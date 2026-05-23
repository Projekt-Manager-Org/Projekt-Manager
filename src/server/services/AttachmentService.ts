/**
 * Attachment service — init / complete / hide / restore / list /
 * Papierkorb listing / download-url / bulk-fetch.
 *
 * The state machine is pinned by api.md §14.2.11, data-model.md §5.13,
 * ADR-0022 (capability split + Papierkorb), and ADR-0024
 * (per-attachment envelope encryption):
 *
 *   init        → row created at `status = 'pending'`; the supplied DEK
 *                 material is wrapped against the operator-loaded
 *                 binary `age` recipient and persisted as `wrappedDek`
 *                 (and `wrappedThumbDek` for photos). Presigned PUT(s)
 *                 are signed against the *ciphertext* triplet —
 *                 sentinel `application/octet-stream` content-type,
 *                 `ciphertextSizeBytes` length, and
 *                 `ciphertextContentMd5` body hash. Audit row
 *                 (`attachment:add`) via `mutate()`.
 *   complete    → HEAD verify both objects against the persisted
 *                 ciphertext sizes + sentinel content-type, flip to
 *                 `status = 'ready'`, persist version-ids (ADR-0022).
 *                 No audit row (AC-219).
 *   hide        → see ADR-0022 — DeleteObject (no versionId) writes a
 *                 delete marker; CAS `ready → hidden` + audit row
 *                 commit atomically inside `mutate()`. Storage-first
 *                 ordering so a transient storage outage surfaces as
 *                 5xx (the user retries).
 *   restore     → flip `hidden → ready` via CAS, then `copyFromVersion`
 *                 to promote the persisted version back to current,
 *                 then write the freshly-issued version-ids — all
 *                 inside one `mutate()` tx. Audit row
 *                 (`attachment:restore`).
 *   download-url → unwrap `wrappedDek` (or `wrappedThumbDek` for
 *                  variant=thumbnail) per request via
 *                  `KeyEnvelopeService`, return
 *                  `{ url, expiresAt, dekMaterial }`. Per-row unwrap
 *                  failure surfaces as 422 DEK_UNWRAP_FAILED — the SW
 *                  branch discriminator (AC-244).
 *   bulk-fetch  → batch download-url. Returns `{ data: BulkFetchEntry[] }`
 *                 with one entry per requested id, in the order
 *                 requested. Caps on count + summed plaintext size;
 *                 whole-batch reject on any cap breach or per-id
 *                 validation failure (no partial-serve). The legacy
 *                 server-zip `bulk-download` path retires under
 *                 ADR-0024 — bulk assembly is browser-side streaming
 *                 zip.
 *
 * Worker scoping: the repository predicate narrows reads; the service
 * layer additionally rejects worker write/init on an unassigned project
 * (AC-214) and enforces the self-delete grace window (AC-215).
 *
 * Archive interaction: hide is gated on the project NOT being archived
 * (read-only preview); restore is permitted on archived projects so
 * binaries in an archived project's trash are not silently reaped by
 * lifecycle.
 *
 * The unwrapped DEK is NEVER persisted — the column does not exist;
 * each `download-url` / `bulk-fetch` call constructs a per-request
 * `KeyEnvelopeService` against the operator-loaded identity path
 * (`BINARY_AGE_IDENTITY_PATH`), unwraps in-memory, and returns the
 * base64 to the caller. ADR-0024 §"Service-Worker decryption".
 */

import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import type { AuthUser } from '../middleware/auth.js';
import type { ServiceLogger } from './Logger.js';
import type { Attachment, AttachmentLabel } from '../../domain/types.js';
import {
  ATTACHMENT_LABELS,
  ATTACHMENT_MIME_WHITELIST,
  classifyKind,
  isKnownWrappedDekVersion,
  isSafeFileName,
  WRAPPED_DEK_CURRENT_VERSION,
} from '../../domain/attachments.js';
import { callerHasPermission } from '../../config/permissions.js';
import { users } from '../db/schema.js';
import {
  type AttachmentStorageClient,
  type PresignedPutDescriptor,
  StorageObjectNotFoundError,
} from '../storage/client.js';
import { isProjectInScope } from '../repositories/scope.js';
import {
  createPending,
  markHidden,
  markRestored,
  setVersionIds,
  getById,
  listByProject,
  listByIdsForProject,
  listHiddenByProject,
  markReady,
  type AttachmentRow,
  type AttachmentRowWithUploader,
} from '../repositories/attachment.js';
import { getProjectRowById } from '../repositories/project.js';
import { mutate } from './mutate.js';
import { emitStorageUsageChanged } from '../sse/emitters.js';
import {
  bulkLimitExceeded,
  conflict,
  dekUnwrapFailed,
  extractPgConstraint,
  extractSqlState,
  gone,
  notFound,
  notPermitted,
  serverError,
  validationError,
} from '../errors.js';
import { STRINGS } from '../../config/strings.js';
import { ATTACHMENT_CONFIG } from '../../config/attachmentConfig.js';
import { getEnv } from '../config/env.js';
import { KeyEnvelopeService, KeyEnvelopeUnwrapError } from './KeyEnvelopeService.js';

const FILE_NAME_MAX = 255;
/**
 * Sentinel storage `Content-Type` for every ciphertext object on B2
 * (ADR-0024 §"Storage"). The plaintext `mimeType` lives on the row
 * (drives download Content-Disposition) but never crosses the wire to
 * storage — the SigV4-signed PUT and the complete()-time HEAD assertion
 * both pin this constant.
 */
const CIPHERTEXT_CONTENT_TYPE = 'application/octet-stream';
/** AES-256-GCM key length — the spec contract for `dekMaterial` after base64-decode. */
const DEK_BYTE_LENGTH = 32;

const LABEL_VALUES = new Set<string>(ATTACHMENT_LABELS.map((entry) => entry.value));
const MIME_WHITELIST = new Set<string>(ATTACHMENT_MIME_WHITELIST);

/**
 * Wire shape returned by `POST /api/projects/:id/attachments/init` for
 * each upload (original + optional thumbnail). Identical to the storage
 * client's `PresignedPutDescriptor` — re-exported under a verb-neutral
 * name so the API contract reads naturally.
 */
export type PresignedUpload = PresignedPutDescriptor;

/**
 * Optional import-mode block on `init` (issue #163, api.md §14.2.11,
 * AC-255 / AC-256). When present, the takeout-zip restore orchestrator
 * is asking the server to pin the new row's identity to values from the
 * source envelope rather than minting them server-side. The block is
 * gated on the caller holding BOTH `data:restore` AND `attachment:write`
 * — the standard `attachment:write` route gate admits the upload at all,
 * the service-layer `data:restore` check admits the override on
 * server-managed identity fields. Validation rules (AC-257):
 *   - `id` must parse as a UUID.
 *   - `createdBy` must reference an existing `users` row.
 *   - `createdAt` must parse as ISO 8601.
 * A bad-input branch returns 422 VALIDATION_ERROR; an `id` collision
 * against an existing row returns 409 CONFLICT.
 */
export interface RestoreBlockInput {
  id: string;
  createdBy: string;
  createdAt: string;
}

export interface InitUploadInput {
  fileName: string;
  mimeType: string;
  /** Plaintext byte count — drives the per-file cap + export envelope. */
  sizeBytes: number;
  label: AttachmentLabel;
  hasThumbnail: boolean;
  /** Base64 of the 32-byte AES-256-GCM DEK for the original blob. */
  dekMaterial: string;
  /** Ciphertext byte count for the original blob — what the server signs as Content-Length. */
  ciphertextSizeBytes: number;
  /** RFC 1864 base64 MD5 of the ciphertext bytes. */
  ciphertextContentMd5: string;
  /** Base64 of the 32-byte DEK for the thumbnail — required when `hasThumbnail = true`. */
  thumbDekMaterial?: string;
  /** Ciphertext byte count for the thumbnail — required when `hasThumbnail = true`. */
  ciphertextThumbSizeBytes?: number;
  /** RFC 1864 base64 MD5 of the thumbnail ciphertext — required when `hasThumbnail = true`. */
  ciphertextThumbContentMd5?: string;
  /** Import-mode block (issue #163). See `RestoreBlockInput`. */
  restore?: RestoreBlockInput;
}

export interface InitUploadResult {
  attachment: Attachment;
  originalUpload: PresignedUpload;
  thumbnailUpload?: PresignedUpload;
}

export interface DownloadUrlResult {
  url: string;
  expiresAt: string;
  /** Base64 of the unwrapped 32-byte DEK that decrypts the requested variant. */
  dekMaterial: string;
  /**
   * Plaintext MIME type of the requested variant. The Service-Worker
   * decrypt path sets this as the `Content-Type` on the response it
   * synthesises so `<iframe src>` PDF previews render inline instead
   * of triggering a download (the browser only renders inline for the
   * matching content type — `application/octet-stream` collapses to
   * download). Originals use the stored `mimeType`; thumbnails are
   * always `image/jpeg` per the photo-thumbnail pipeline.
   */
  mimeType: string;
}

export type DownloadVariant = 'original' | 'thumbnail';

/**
 * Per-attachment entry in a bulk-fetch response (api.md §14.2.11
 * `BulkFetchEntry`). Photos carry both the original and the thumbnail
 * triplet; binaries set the thumbnail fields to null (or omit them —
 * both shapes are admissible per the spec).
 */
export interface BulkFetchEntry {
  attachmentId: string;
  originalUrl: string;
  /** Base64 of the unwrapped 32-byte DEK for the original. */
  originalDekMaterial: string;
  ciphertextSizeBytes: number;
  thumbUrl?: string;
  /** Base64 of the unwrapped 32-byte DEK for the thumbnail; null for non-photo. */
  thumbDekMaterial?: string;
  ciphertextThumbSizeBytes?: number;
}

export interface BulkFetchResponse {
  data: BulkFetchEntry[];
}

export interface AttachmentServiceDeps {
  db: Database;
  storage: AttachmentStorageClient;
  /**
   * Operator-loaded binary `age` recipient (public X25519 key). Used to
   * wrap each DEK at init. Sourced from `BINARY_AGE_RECIPIENT` env at
   * the route layer.
   */
  binaryAgeRecipient: string;
  /**
   * Path to the operator-loaded binary `age` private identity (tmpfs
   * resident). Used to unwrap each row's `wrappedDek` per request on
   * `download-url` / `bulk-fetch`. Sourced from
   * `BINARY_AGE_IDENTITY_PATH` env.
   */
  binaryAgeIdentityPath: string;
}

interface ResolvedCaps {
  perFileCapBytes: number;
  perThumbCapBytes: number;
  bulkDownloadMaxFiles: number;
  bulkDownloadMaxBytes: number;
  workerSelfDeleteGraceMinutes: number;
}

function resolveCaps(): ResolvedCaps {
  // `validateEnvRuntime` has already run by the time a route handler reaches
  // the service; reading through `getEnv` keeps the config override
  // path consistent with the other `[C]` surfaces (auditRetention etc.).
  let env: ReturnType<typeof getEnv> | null;
  try {
    env = getEnv();
  } catch {
    // Tests that construct a service outside of startApp() fall through
    // to the build-time defaults. Production paths always call
    // `validateEnvRuntime()` before the first request.
    env = null;
  }
  return {
    perFileCapBytes: env?.ATTACHMENT_PER_FILE_CAP_BYTES ?? ATTACHMENT_CONFIG.perFileCapBytes,
    perThumbCapBytes: env?.ATTACHMENT_THUMB_CAP_BYTES ?? ATTACHMENT_CONFIG.perThumbCapBytes,
    bulkDownloadMaxFiles: env?.ATTACHMENT_BULK_MAX_FILES ?? ATTACHMENT_CONFIG.bulkDownloadMaxFiles,
    bulkDownloadMaxBytes: env?.ATTACHMENT_BULK_MAX_BYTES ?? ATTACHMENT_CONFIG.bulkDownloadMaxBytes,
    workerSelfDeleteGraceMinutes:
      env?.ATTACHMENT_WORKER_SELF_DELETE_GRACE_MINUTES ??
      ATTACHMENT_CONFIG.workerSelfDeleteGraceMinutes,
  };
}

function isOwnerOrOffice(user: AuthUser): boolean {
  return user.roles.includes('owner') || user.roles.includes('office');
}

function callerIsWorkerOnly(user: AuthUser): boolean {
  // A caller is "worker-only" for delete-grace purposes when none of
  // the roles grants unscoped write (owner, office). Bookkeeper also
  // lacks `attachment:hide` entirely — the permission gate rejects
  // them before the service runs, so the grace logic doesn't fire for
  // bookkeepers.
  return !isOwnerOrOffice(user);
}

function toAttachment(row: AttachmentRowWithUploader): Attachment {
  return {
    id: row.id,
    projectId: row.projectId,
    status: row.status as Attachment['status'],
    kind: row.kind as Attachment['kind'],
    label: row.label as AttachmentLabel,
    fileName: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    originalKey: row.originalKey,
    thumbKey: row.thumbKey,
    hasThumbnail: row.hasThumbnail,
    hiddenAt: row.hiddenAt ? row.hiddenAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    createdBy:
      row.createdBy && row.uploaderDisplayName
        ? { id: row.createdBy, displayName: row.uploaderDisplayName }
        : null,
  };
}

function storageKey(projectId: string, attachmentId: string, suffix: 'orig' | 'thumb'): string {
  return `attachments/${projectId}/${attachmentId}.${suffix}`;
}

/**
 * RFC 1864 base64 of an MD5 digest is exactly 24 chars: 21 of
 * [A-Za-z0-9+/], one of [AQgw] at position 22 (only those four
 * carry zero-bit alignment for a 16-byte digest), then `==`. The
 * tighter alphabet at position 22 rejects malformed values that the
 * coarser `[A-Za-z0-9+/]{22}==` would accept.
 */
const MD5_BASE64_RE = /^[A-Za-z0-9+/]{21}[AQgw]==$/;

function isMd5Base64(value: unknown): value is string {
  return typeof value === 'string' && MD5_BASE64_RE.test(value);
}

/**
 * Decode `dekMaterial` (base64) and assert the post-decode byte length
 * matches the AES-256-GCM key shape. Returns the raw 32-byte buffer on
 * success; throws a 422 VALIDATION_ERROR on any malformed input. Used
 * at init for both the original and thumbnail DEK material.
 */
function decodeDekMaterial(value: unknown, fieldHint: string): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) {
    throw validationError(STRINGS.errors.invalidInput);
  }
  // Reject anything that isn't valid base64. Buffer.from with 'base64'
  // silently drops non-base64 bytes, so a malformed input would decode
  // to a too-short buffer — caught by the length check below — but the
  // explicit alphabet test catches malformed input one layer earlier
  // (cleaner failure surface for `@@@-not-base64-@@@` style payloads).
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw validationError(STRINGS.errors.invalidInput);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== DEK_BYTE_LENGTH) {
    throw validationError(STRINGS.errors.invalidInput);
  }
  // Round-trip check: re-encode and compare. Catches non-canonical
  // base64 that would silently truncate (e.g. extra whitespace, off-by-one
  // padding). The encoded form here uses no whitespace, so any divergence
  // signals input that wouldn't reproduce.
  if (decoded.toString('base64') !== value) {
    throw validationError(STRINGS.errors.invalidInput);
  }
  void fieldHint;
  return decoded;
}

function attachmentAuditLabel(row: AttachmentRow): string {
  return row.filename;
}

export class AttachmentService {
  private readonly db: Database;
  private readonly storage: AttachmentStorageClient;
  private readonly binaryAgeRecipient: string;
  private readonly binaryAgeIdentityPath: string;

  constructor(deps: AttachmentServiceDeps) {
    this.db = deps.db;
    this.storage = deps.storage;
    this.binaryAgeRecipient = deps.binaryAgeRecipient;
    this.binaryAgeIdentityPath = deps.binaryAgeIdentityPath;
  }

  /**
   * Construct a per-request `KeyEnvelopeService` against the
   * operator-loaded identity path. The path-shape construction is
   * cheap (no temp file) and does not need `close()` — the file is
   * borrowed (`ownsIdentityFile = false`).
   */
  private envelopeService(): KeyEnvelopeService {
    return new KeyEnvelopeService({
      recipient: this.binaryAgeRecipient,
      identityPath: this.binaryAgeIdentityPath,
    });
  }

  /**
   * Init: validate inputs, ensure caller scope, wrap each supplied DEK
   * against the operator-loaded recipient, write a pending row via
   * `mutate()`, issue presigned PUT descriptors (one per blob).
   *
   * Issue #163 / api.md §14.2.11: when the body carries an optional
   * `restore: { id, createdBy, createdAt }` block, the takeout-zip
   * orchestrator is asking the server to pin the new row's identity to
   * the source envelope's values. The block is gated on the caller
   * holding BOTH `data:restore` AND `attachment:write` (the latter is
   * the route-level preHandler; the former is the service-level check
   * below — placed here because the AND-gate semantics depend on the
   * block being present, AC-255). Validation runs before the row
   * insert; an `id` collision against an existing row surfaces as 409
   * CONFLICT (AC-257).
   */
  async initUpload(
    caller: AuthUser,
    projectId: string,
    input: InitUploadInput,
    log: ServiceLogger,
    correlationId: string | null,
  ): Promise<InitUploadResult> {
    // Project existence check — 404 takes precedence over scope (AC-214
    // + AC-147 pattern).
    const projectRow = await getProjectRowById(this.db, projectId);
    if (!projectRow) throw notFound(STRINGS.entities.project);
    if (projectRow.deleted) throw notFound(STRINGS.entities.project);

    // Worker scope: reject the service call if the caller is scoped and
    // not assigned to the project. Route-level permission gate has
    // already accepted them.
    if (!(await isProjectInScope(this.db, caller, projectId))) {
      throw notPermitted();
    }

    // AC-255: AND-gate on the optional `restore` block. The route-level
    // `attachment:write` preHandler has already accepted the caller; this
    // is the second leg — when `restore` is supplied, `data:restore` is
    // additionally required. A caller missing it gets 403 NOT_PERMITTED
    // and no row is persisted (the rejection happens before the wrap +
    // insert pipeline runs).
    //
    // Bearer-authenticated callers (the import binary leg) are bounded by
    // the token's declared scope (AC-313 / AC-315) — the token carries
    // `data:restore` explicitly, so a regression that drops it from the
    // mint surface fails here, not at the caller's role set.
    if (input.restore !== undefined && !callerHasPermission(caller, 'data:restore')) {
      throw notPermitted();
    }

    // Input validation — each branch produces `422 VALIDATION_ERROR` and
    // persists no row (AC-245).
    const caps = resolveCaps();
    if (typeof input.fileName !== 'string' || input.fileName.length === 0) {
      throw validationError(STRINGS.validation.requiredString('fileName'));
    }
    if (input.fileName.length > FILE_NAME_MAX) {
      throw validationError(STRINGS.validation.maxLength('fileName', FILE_NAME_MAX));
    }
    // Reject control chars + path separators. Keeps header injection out
    // of the presigned-GET Content-Disposition (defence-in-depth; the
    // storage client ALSO sanitizes), and matches the spec's "sanitized
    // filename" intent by never letting a path-traversal-style name
    // reach the DB.
    if (!isSafeFileName(input.fileName)) {
      throw validationError(STRINGS.errors.invalidInput);
    }
    if (!LABEL_VALUES.has(input.label)) {
      throw validationError(STRINGS.errors.invalidInput);
    }
    if (!MIME_WHITELIST.has(input.mimeType)) {
      throw validationError(STRINGS.attachments.uploadMimeNotAllowed);
    }
    if (
      !Number.isInteger(input.sizeBytes) ||
      input.sizeBytes <= 0 ||
      input.sizeBytes > caps.perFileCapBytes
    ) {
      throw validationError(STRINGS.attachments.uploadFileTooLarge);
    }
    if (!Number.isInteger(input.ciphertextSizeBytes) || input.ciphertextSizeBytes <= 0) {
      throw validationError(STRINGS.errors.invalidInput);
    }
    // RFC 1864 base64 of 16-byte MD5 → 24 chars, last two `==`.
    if (!isMd5Base64(input.ciphertextContentMd5)) {
      throw validationError(STRINGS.errors.invalidInput);
    }
    // 32-byte DEK after base64-decode. The validator throws on malformed input.
    const dekBytes = decodeDekMaterial(input.dekMaterial, 'dekMaterial');

    const kind = classifyKind(input.mimeType);
    // The client signals `hasThumbnail`. A photo without a thumbnail is
    // legal (no gallery render), but a binary with a thumbnail is not.
    const hasThumbnail = kind === 'photo' ? input.hasThumbnail : false;

    // Thumbnail triplet — required when a thumbnail is being signed.
    let ciphertextThumbSizeBytes: number | undefined;
    let ciphertextThumbContentMd5: string | undefined;
    let thumbDekBytes: Uint8Array | undefined;
    if (hasThumbnail) {
      if (
        typeof input.ciphertextThumbSizeBytes !== 'number' ||
        !Number.isInteger(input.ciphertextThumbSizeBytes) ||
        input.ciphertextThumbSizeBytes <= 0
      ) {
        throw validationError(STRINGS.errors.invalidInput);
      }
      // Per-thumb cap (AC-245). Mirrors the original-side
      // perFileCapBytes guard above; an oversized thumbnail
      // ciphertext rejects with the same shape (uploadFileTooLarge),
      // and persists no row.
      if (input.ciphertextThumbSizeBytes > caps.perThumbCapBytes) {
        throw validationError(STRINGS.attachments.uploadFileTooLarge);
      }
      if (!isMd5Base64(input.ciphertextThumbContentMd5)) {
        throw validationError(STRINGS.errors.invalidInput);
      }
      thumbDekBytes = decodeDekMaterial(input.thumbDekMaterial, 'thumbDekMaterial');
      ciphertextThumbSizeBytes = input.ciphertextThumbSizeBytes;
      ciphertextThumbContentMd5 = input.ciphertextThumbContentMd5;
    }

    // AC-257: validate the restore-block runtime invariants. Schema
    // already rejected malformed UUID / non-ISO timestamps at the route
    // layer (`format: 'uuid'` / `format: 'date-time'`); the
    // user-existence and date-parseable defenses are runtime-only.
    // The `format: 'date-time'` test alone allows shapes Date.parse
    // accepts but our schema considers OK — re-asserting `Date.parse`
    // here avoids a downstream NaN landing on the row.
    let restoreCreatedAt: Date | undefined;
    if (input.restore !== undefined) {
      const parsedAt = Date.parse(input.restore.createdAt);
      if (Number.isNaN(parsedAt)) {
        throw validationError(STRINGS.errors.invalidInput, {
          restore: { createdAt: 'must be a parseable ISO 8601 timestamp' },
        });
      }
      restoreCreatedAt = new Date(parsedAt);

      const userRows = await this.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, input.restore.createdBy))
        .limit(1);
      if (userRows.length === 0) {
        throw validationError(STRINGS.errors.invalidInput, {
          restore: { createdBy: 'references an unknown user' },
        });
      }
    }

    // Wrap each DEK against the operator-loaded recipient. The wrapping
    // uses only the public recipient; no identity file is consulted, so
    // construction with `identityPath` (borrowed file) is the right
    // shape — the file is irrelevant to `wrap()`. Errors here are
    // operator conditions (missing `age` binary, malformed recipient)
    // and bubble as 5xx — the per-row 422 surface is for unwrap-time
    // failures only (api.md §14.2.11 design notes).
    const envelope = this.envelopeService();
    const wrappedDekBytes = await envelope.wrap(dekBytes);
    const wrappedDekBase64 = Buffer.from(wrappedDekBytes).toString('base64');
    let wrappedThumbDekBase64: string | null = null;
    if (thumbDekBytes !== undefined) {
      const wrappedThumbBytes = await envelope.wrap(thumbDekBytes);
      wrappedThumbDekBase64 = Buffer.from(wrappedThumbBytes).toString('base64');
    }

    // AC-256 vs standard path: id is supplied verbatim under restore,
    // server-minted otherwise. Storage keys are derived from
    // `(projectId, attachmentId)` either way — restore preserves the
    // logical row identity, NOT the prior instance's storage keys
    // (the orchestrator re-uploads bytes; B2 paths are local to the
    // importing instance).
    const attachmentId = input.restore?.id ?? crypto.randomUUID();
    const originalKey = storageKey(projectId, attachmentId, 'orig');
    const thumbKey = hasThumbnail ? storageKey(projectId, attachmentId, 'thumb') : null;

    // AC-256: under the `restore` block the row is persisted with the
    // supplied id / createdBy / createdAt; the standard path keeps
    // server-minted identity (id randomized above, createdBy from
    // session, createdAt from schema default `now()`).
    const persistedCreatedBy = input.restore?.createdBy ?? caller.id;
    const row = await mutate(
      this.db,
      { actorKind: 'user', actorId: caller.id, correlationId: correlationId ?? null },
      {
        entityType: 'attachment',
        action: 'attachment:add',
        run: async (tx) => {
          let inserted: AttachmentRow;
          try {
            inserted = await createPending(tx, {
              id: attachmentId,
              projectId,
              kind,
              label: input.label,
              filename: input.fileName,
              mimeType: input.mimeType,
              sizeBytes: input.sizeBytes,
              originalKey,
              thumbKey,
              // Plaintext-thumb-size column kept for legacy tests that
              // still seed it; the real defence in depth at complete-time
              // is the ciphertext-side `ciphertextThumbSizeBytes`. Set
              // null here so a non-thumb row stays clean and a photo
              // row's thumb column reflects the ciphertext figure
              // through `ciphertextThumbSizeBytes`.
              thumbSizeBytes: null,
              hasThumbnail,
              ciphertextSizeBytes: input.ciphertextSizeBytes,
              ciphertextThumbSizeBytes: ciphertextThumbSizeBytes ?? null,
              wrappedDek: wrappedDekBase64,
              wrappedThumbDek: wrappedThumbDekBase64,
              // ADR-0024 envelope-format discriminator. Both wrapped
              // envelopes on this row are produced by `envelope.wrap()`
              // above (the same `age` X25519 KEM + ChaCha20-Poly1305
              // shape) — the version pin is shared. A future v2 change
              // updates the constant + this site simultaneously.
              wrappedDekVersion: WRAPPED_DEK_CURRENT_VERSION,
              createdBy: persistedCreatedBy,
              ...(restoreCreatedAt !== undefined ? { createdAt: restoreCreatedAt } : {}),
            });
          } catch (err) {
            // AC-257: an `id` collision under the restore block
            // surfaces as 409 CONFLICT (not 422). Postgres reports the
            // PK collision via SQLSTATE 23505 / `attachments_pkey`. The
            // standard path uses `crypto.randomUUID()` so a collision
            // here is effectively impossible — but the catch is
            // harmless on that path and load-bearing on the restore
            // path.
            const constraint = extractPgConstraint(err);
            const sqlState = extractSqlState(err);
            if (sqlState === '23505' && constraint === 'attachments_pkey') {
              throw conflict(STRINGS.errors.invalidInput);
            }
            throw err;
          }
          return {
            entityId: attachmentId,
            entityLabel: attachmentAuditLabel(inserted),
            value: inserted,
            before: {},
            after: {
              projectId,
              attachmentId,
              label: input.label,
              mimeType: input.mimeType,
              sizeBytes: input.sizeBytes,
            },
            // Nested entity: ancestor = project (architecture.md §11.12)
            // so the per-project activity feed picks this row up.
            ancestorEntityType: 'project',
            ancestorEntityId: projectId,
          };
        },
      },
    );

    log.info({ attachmentId: row.id, projectId }, 'attachment_init');

    // Sign one presigned PUT per blob against the *ciphertext* triplet
    // (sentinel content-type, ciphertext size, ciphertext MD5). The
    // SigV4 binding rejects any client-side divergence on these three
    // fields before the bytes reach the storage provider; the provider
    // additionally verifies Content-MD5 against received bytes
    // (`BadDigest` on mismatch).
    const originalUpload = await this.storage.createPresignedPut(
      originalKey,
      CIPHERTEXT_CONTENT_TYPE,
      input.ciphertextSizeBytes,
      input.ciphertextContentMd5,
    );
    const thumbnailUpload =
      thumbKey && ciphertextThumbSizeBytes !== undefined && ciphertextThumbContentMd5 !== undefined
        ? await this.storage.createPresignedPut(
            thumbKey,
            CIPHERTEXT_CONTENT_TYPE,
            ciphertextThumbSizeBytes,
            ciphertextThumbContentMd5,
          )
        : undefined;

    return {
      // Newly created row — uploader display name comes from the live
      // caller; saves a follow-up read since `createPending` returns the
      // base row and we already know who acted.
      attachment: toAttachment({ ...row, uploaderDisplayName: caller.displayName }),
      originalUpload,
      ...(thumbnailUpload ? { thumbnailUpload } : {}),
    };
  }

  /**
   * Complete: HEAD-check both objects, assert size against the row's
   * persisted `ciphertextSizeBytes` + sentinel content-type, flip
   * `pending` → `ready`. No audit row (AC-219).
   */
  async completeUpload(
    caller: AuthUser,
    projectId: string,
    attachmentId: string,
    log: ServiceLogger,
  ): Promise<Attachment> {
    // Scope check early — spec requires worker on unassigned project to
    // receive 403 even when the attachment id does not exist (AC-214).
    if (!(await isProjectInScope(this.db, caller, projectId))) {
      throw notPermitted();
    }

    // Race guard: a project archived between init and complete must not
    // produce a `ready` row. initUpload blocks archived rows up front,
    // but the storage round-trip leaves a window where archive can land
    // before the flip. The pending row stays for the reaper.
    const projectRow = await getProjectRowById(this.db, projectId);
    if (!projectRow || projectRow.deleted) {
      throw notFound(STRINGS.entities.project);
    }

    const row = await getById(this.db, attachmentId);
    if (!row || row.projectId !== projectId) {
      // Reaper already removed the row (or wrong-project mismatch). AC-212
      // pins 404 here so the client discards pending state.
      throw notFound(STRINGS.entities.resource);
    }
    if (row.status === 'ready') {
      // Idempotent one-way transition — double-ack returns 409.
      throw conflict(STRINGS.errors.invalidInput);
    }

    const caps = resolveCaps();
    // HEAD the original first. Capture VersionId for the restore path
    // (ADR-0022) — the bucket is versioned, every PUT produces a fresh
    // version-id, and the version that is current immediately post-
    // upload is exactly what `copyFromVersion` must recreate later.
    let versionId: string | null;
    try {
      const head = await this.storage.headObject(row.originalKey);
      // Declared-ciphertext-size pin first (ADR-0024 / AC-212). The
      // presigned PUT's signed `Content-Length` already rejects a size
      // deviation at the signature layer, so reaching this branch means
      // a signature bypass — refuse the flip so a size-substituted
      // upload cannot become canonical.
      if (row.ciphertextSizeBytes !== null && head.size !== row.ciphertextSizeBytes) {
        throw conflict(STRINGS.errors.invalidInput);
      }
      // Defence in depth: a global cap breach on plaintext is still a
      // conflict even if the declared ciphertext size matched (e.g.
      // cap dropped since init). Reads the row's plaintext sizeBytes,
      // which is what the per-file cap gates.
      if (row.sizeBytes > caps.perFileCapBytes) {
        throw conflict(STRINGS.errors.invalidInput);
      }
      // Sentinel content-type — under e2e the storage object is
      // ciphertext under the fixed `application/octet-stream` type.
      // Anything else means the uploader sent a different MIME (e.g.
      // image/jpeg from a pre-e2e client) — refuse the flip.
      if (head.contentType !== CIPHERTEXT_CONTENT_TYPE) {
        throw conflict(STRINGS.errors.invalidInput);
      }
      versionId = head.versionId ?? null;
    } catch (err) {
      if (err instanceof StorageObjectNotFoundError) {
        throw conflict(STRINGS.errors.invalidInput);
      }
      throw err;
    }

    let thumbVersionId: string | null = null;
    if (row.hasThumbnail && row.thumbKey) {
      try {
        // Defence in depth: the presigned PUT already pins
        // Content-Length and the sentinel content-type via SigV4.
        // Re-assert at HEAD so a signature bypass is still caught at
        // state-flip time.
        const thumbHead = await this.storage.headObject(row.thumbKey);
        // Declared-ciphertext-size pin first.
        if (
          row.ciphertextThumbSizeBytes !== null &&
          thumbHead.size !== row.ciphertextThumbSizeBytes
        ) {
          throw conflict(STRINGS.errors.invalidInput);
        }
        // Plaintext-thumb-size column — kept for legacy seed paths
        // that populated it; defence in depth against the per-thumb
        // plaintext cap.
        if (row.thumbSizeBytes !== null && row.thumbSizeBytes > caps.perThumbCapBytes) {
          throw conflict(STRINGS.errors.invalidInput);
        }
        // Sentinel content-type — no `startsWith('image/')` carve-out
        // under e2e. Both blobs are opaque ciphertext under the fixed
        // type (api.md §14.2.11 / ADR-0024 §"Complete() flow rework").
        if (thumbHead.contentType !== CIPHERTEXT_CONTENT_TYPE) {
          throw conflict(STRINGS.errors.invalidInput);
        }
        thumbVersionId = thumbHead.versionId ?? null;
      } catch (err) {
        if (err instanceof StorageObjectNotFoundError) {
          throw conflict(STRINGS.errors.invalidInput);
        }
        throw err;
      }
    }

    // Flip pending → ready via a MutatingDatabase (no audit row, so we
    // use db.transaction directly — AC-219). A racing reaper between
    // the HEAD checks and this write surfaces as 404 on the next read,
    // which matches the client contract. The reaper may delete this
    // row during the HEAD→markReady gap; a storage object verified by
    // HEAD but not-yet-marked-ready can remain orphaned for up to one
    // reaper tick before the next sweep cleans it up.
    const updated = await this.db.transaction(async (tx) =>
      markReady(tx, attachmentId, { versionId, thumbVersionId }),
    );
    if (!updated) {
      // Either the row disappeared between the get + markReady calls
      // (reaper race — 404) or it's already ready (racing client — 409).
      const again = await getById(this.db, attachmentId);
      if (!again || again.projectId !== projectId) {
        throw notFound(STRINGS.entities.resource);
      }
      if (again.status === 'ready') {
        throw conflict(STRINGS.errors.invalidInput);
      }
      // Shouldn't reach here — but if it does, surface as conflict so
      // the client retries cleanly.
      throw conflict(STRINGS.errors.invalidInput);
    }

    // Post-commit: pending → ready flips a row's contribution to the
    // counters from 0 to its sizeBytes (data-model.md §5.14). Broadcast
    // AFTER db.transaction resolves so a tx that aborts emits nothing
    // (architecture.md §11.13, AC-270).
    emitStorageUsageChanged();

    log.info({ attachmentId, projectId }, 'attachment_ready');
    return toAttachment(updated);
  }

  /**
   * Hide (user-initiated DELETE; soft-hide per ADR-0022). Validates
   * caller scope, the project's read-write status (archive gate), and
   * the worker self-delete grace window (AC-215).
   *
   * Storage-first ordering, outside the DB transaction. The
   * `DeleteObject` (no versionId) writes a delete marker on the
   * versioned bucket; the prior version is preserved so restore can
   * promote it back. A storage failure throws and propagates as 5xx
   * — no DB change happens, the user retries from scratch. Storage
   * hide is idempotent: repeating against an already-hidden key just
   * appends another delete marker, lifecycle reaps both. Running
   * storage AHEAD of `mutate()` keeps the bucket lifecycle's
   * NONCURRENT-only reap consistent with the row's `hidden` status:
   * the alternative (DB CAS first, swallow storage faults) leaks the
   * underlying object as the "current" version forever, with no UI
   * affordance to retry. After storage succeeds, the CAS flip
   * (`ready` → `hidden`) and the audit row commit atomically inside
   * `mutate()`.
   */
  async hideAttachment(
    caller: AuthUser,
    projectId: string,
    attachmentId: string,
    log: ServiceLogger,
    correlationId: string | null,
  ): Promise<void> {
    if (!(await isProjectInScope(this.db, caller, projectId))) {
      throw notPermitted();
    }

    // Archived projects are read-only previews — server-side defence
    // matching the project-mutation gate (AC-95). The detail-page UI
    // already hides the trash affordance, but a direct API call must
    // not slip through. 404 mirrors the project-mutation contract: the
    // attachment "is gone" from the perspective of editable surfaces.
    const projectRow = await getProjectRowById(this.db, projectId);
    if (!projectRow || projectRow.deleted) {
      throw notFound(STRINGS.entities.project);
    }

    const row = await getById(this.db, attachmentId);
    if (!row || row.projectId !== projectId) {
      throw notFound(STRINGS.entities.resource);
    }

    // Worker self-delete grace (AC-215). Owner / office bypass.
    if (callerIsWorkerOnly(caller)) {
      if (row.createdBy !== caller.id) {
        throw notPermitted();
      }
      const caps = resolveCaps();
      const ageMinutes = (Date.now() - row.createdAt.getTime()) / 60_000;
      if (ageMinutes > caps.workerSelfDeleteGraceMinutes) {
        throw notPermitted();
      }
    }

    // Storage hide BEFORE the DB CAS. A throw here surfaces as 5xx
    // and leaves the row in `ready`; the user retries. Doing this
    // inside `mutate()`'s `run` would couple a non-transactional side
    // effect to the SQL tx — a later rollback (e.g. the CAS losing
    // its predicate to a racing hide) cannot undo a successful
    // `DeleteObject`, producing the symmetric orphan in the opposite
    // direction.
    await this.storage.hide(row.originalKey);
    if (row.thumbKey) {
      await this.storage.hide(row.thumbKey);
    }

    await mutate(
      this.db,
      { actorKind: 'user', actorId: caller.id, correlationId: correlationId ?? null },
      {
        entityType: 'attachment',
        action: 'attachment:hide',
        run: async (tx) => {
          const hidden = await markHidden(tx, attachmentId);
          if (!hidden) {
            // Lost the CAS — the row was not in `ready` at the moment of
            // the UPDATE. Either it was already hidden (double-click,
            // racing client), or never reached ready (stuck pending),
            // or was reaped between the read and write. 409 in all
            // cases — the client refetches and sees the actual state.
            // The storage delete marker we just wrote is harmless
            // (idempotent) and aligns with the racing hide that
            // already won the CAS.
            throw conflict(STRINGS.errors.invalidInput);
          }
          return {
            entityId: attachmentId,
            entityLabel: attachmentAuditLabel(hidden),
            value: null,
            before: {
              projectId,
              attachmentId: row.id,
              label: row.label,
              mimeType: row.mimeType,
              sizeBytes: row.sizeBytes,
            },
            after: {
              hiddenAt: hidden.hiddenAt?.toISOString() ?? null,
            },
            ancestorEntityType: 'project',
            ancestorEntityId: projectId,
          };
        },
      },
    );

    // Post-commit: ready → hidden moves the row out of the ready
    // counters into the hidden bucket (data-model.md §5.14). Broadcast
    // AFTER mutate() resolves; emission inside `run` would leak on a
    // post-mutate fault and pre-empt the abort guarantee (AC-270).
    emitStorageUsageChanged();

    log.info({ attachmentId, projectId }, 'attachment_hidden');
  }

  async listForProject(caller: AuthUser, projectId: string): Promise<Attachment[]> {
    // 404 / 403 order mirrors the project-detail policy (AC-147) —
    // a missing project is 404, an existing project out-of-scope is 403.
    // Archived projects ARE listed: the detail page renders them as a
    // read-only preview (api.md §14.2.2), so the attachment listing has
    // to surface alongside the rest of the body. Mutation paths
    // (initUpload, hideAttachment) keep the archived gate.
    const projectRow = await getProjectRowById(this.db, projectId);
    if (!projectRow) throw notFound(STRINGS.entities.project);
    if (!(await isProjectInScope(this.db, caller, projectId))) {
      throw notPermitted();
    }
    const rows = await listByProject(this.db, projectId, caller);
    return rows.map(toAttachment);
  }

  /**
   * Papierkorb listing — hidden rows on the project, newest hide first.
   * Route gate (`attachment:trash`) restricts to owner / office; this
   * method assumes the gate has run and only enforces project scope.
   */
  async listHiddenForProject(caller: AuthUser, projectId: string): Promise<Attachment[]> {
    const projectRow = await getProjectRowById(this.db, projectId);
    if (!projectRow) throw notFound(STRINGS.entities.project);
    if (!(await isProjectInScope(this.db, caller, projectId))) {
      throw notPermitted();
    }
    const rows = await listHiddenByProject(this.db, projectId, caller);
    return rows.map(toAttachment);
  }

  /**
   * Restore: flip `hidden` → `ready` via CAS, then `copyFromVersion`
   * from the persisted version-id pair, then write the freshly-issued
   * current-version ids. The whole sequence runs inside `mutate()` so
   * the audit chain records the restore atomically with the storage
   * advance — a CAS-loss aborts before any storage call (no orphan
   * current versions); a storage failure rolls back the status flip
   * and the audit row (the user retries cleanly).
   *
   * Atomicity choice: copies run AFTER the CAS, inside the surrounding
   * transaction. The trade-off is that a transient storage fault rolls
   * the audit row back too; the user repeats the call. The alternative
   * (copy first, compensate on CAS-loss) was rejected because the
   * compensation can itself fail.
   *
   * Asymmetry with hide (intentional): restore is permitted on archived
   * projects; hide is not. Archive is a reversible state (re-activate
   * is a design feature elsewhere); destruction-by-lifecycle is not.
   * If restore were forbidden during archival, binaries in an archived
   * project's trash would silently reap after L days with no recovery
   * path. Hide on an archived project stays forbidden — read-only
   * previews must not accept new mutations.
   *
   * Failure modes (each maps to a distinct status-code surface):
   *   - Row not in 'hidden' state → 409 (transient: client refetches
   *     and sees the actual state).
   *   - Row missing or wrong project → 404 (project itself missing
   *     also surfaces as 404).
   *   - Storage CopyObject failure → 500 (genuine provider fault; the
   *     transaction rolls back, the row stays hidden, the user can
   *     retry).
   *   - `versionId` is null on a 'hidden' row → 422
   *     (Datenintegritätsproblem — restore is structurally impossible).
   *   - `hasThumbnail=true` with `thumb_version_id` null → 422
   *     (gallery preview would be permanently lost; surface the
   *     integrity violation rather than silently restore a broken
   *     row).
   *   - CAS-loss inside the tx → 409 (transient race).
   */
  async restoreAttachment(
    caller: AuthUser,
    projectId: string,
    attachmentId: string,
    log: ServiceLogger,
    correlationId: string | null,
  ): Promise<Attachment> {
    if (!(await isProjectInScope(this.db, caller, projectId))) {
      throw notPermitted();
    }
    // Existence check, but NOT an archive gate — restore is the
    // un-loss move, permitted on archived projects so binaries in the
    // trash are not silently reaped by lifecycle. Hide-side keeps the
    // archive gate (read-only previews refuse new mutations).
    const projectRow = await getProjectRowById(this.db, projectId);
    if (!projectRow) {
      throw notFound(STRINGS.entities.project);
    }
    const row = await getById(this.db, attachmentId);
    if (!row || row.projectId !== projectId) {
      throw notFound(STRINGS.entities.resource);
    }
    if (row.status !== 'hidden') {
      throw conflict(STRINGS.errors.invalidInput);
    }
    if (!row.versionId) {
      // No source version → restore is structurally impossible. Every
      // hide records the version_id at complete-time; a 'hidden' row
      // without one is a data-integrity issue. 422 (not 409) — 409
      // implies "retry" and the row will not become restorable on its
      // own.
      throw validationError(STRINGS.attachments.restoreMissingVersionId(attachmentId));
    }
    if (row.hasThumbnail && row.thumbKey && !row.thumbVersionId) {
      // The gallery thumb is part of the photo's restorable state.
      // Silently skipping the thumb copy would permanently lose the
      // gallery preview without any error signal — surface the integrity
      // violation as 422 so the operator can inspect.
      throw validationError(STRINGS.attachments.restoreMissingThumbVersionId(attachmentId));
    }

    // Snapshot the source version-ids — the inside-tx copies run from
    // these. After the CAS commits we know nobody else can race the
    // same row (the row-level lock on the UPDATE blocks concurrent CAS
    // attempts until this tx ends).
    const sourceVersionId = row.versionId;
    const sourceThumbVersionId = row.thumbKey ? row.thumbVersionId : null;

    const restored = await mutate(
      this.db,
      { actorKind: 'user', actorId: caller.id, correlationId: correlationId ?? null },
      {
        entityType: 'attachment',
        action: 'attachment:restore',
        run: async (tx) => {
          // Phase 1 — CAS the status. Holding the row lock from here
          // means no concurrent restorer can advance storage while we
          // copy below.
          const flipped = await markRestored(tx, attachmentId);
          if (!flipped) {
            // CAS lost — racing restore committed first, or the row
            // shifted out of 'hidden' between our read and this write.
            // No storage call has happened yet, so there is nothing to
            // compensate. The user retries.
            throw conflict(STRINGS.errors.invalidInput);
          }

          // Phase 2 — copy. A failure here throws out of the tx and
          // rolls back Phase 1 (status returns to 'hidden') AND the
          // audit row. The bucket retains only the prior hidden version.
          //
          // The bucket lifecycle (provider-side, ADR-0022) and the row
          // reaper (app-side, data-model.md §6.12) both fire on the same
          // `L` window but on independent clocks. A row may briefly
          // outlive its bytes — the source version is gone from storage
          // while the row is still at `status='hidden'`. Surface that as
          // 410 GONE so the user sees a meaningful "permanently
          // unavailable" message instead of a generic 500.
          let newVersionId: string | null;
          let newThumbVersionId: string | null = null;
          try {
            newVersionId =
              (await this.storage.copyFromVersion(row.originalKey, sourceVersionId)) ?? null;
            if (row.thumbKey && sourceThumbVersionId) {
              newThumbVersionId =
                (await this.storage.copyFromVersion(row.thumbKey, sourceThumbVersionId)) ?? null;
            }
          } catch (err) {
            if (err instanceof StorageObjectNotFoundError) {
              throw gone(STRINGS.attachments.restoreBytesGone(attachmentId));
            }
            throw err;
          }

          // Phase 3 — write the freshly-issued version-ids. We hold the
          // row lock from Phase 1, so this is a plain UPDATE with no
          // CAS predicate; setVersionIds returns null only if the id
          // does not exist (would be a programmer error here).
          const updated = await setVersionIds(tx, attachmentId, {
            versionId: newVersionId,
            thumbVersionId: newThumbVersionId,
          });
          if (!updated) {
            throw new Error('restoreAttachment: row vanished mid-transaction');
          }

          return {
            entityId: attachmentId,
            entityLabel: attachmentAuditLabel(updated),
            value: updated,
            before: {
              hiddenAt: row.hiddenAt?.toISOString() ?? null,
              versionId: sourceVersionId,
              thumbVersionId: sourceThumbVersionId,
            },
            after: {
              versionId: newVersionId,
              thumbVersionId: newThumbVersionId,
            },
            ancestorEntityType: 'project',
            ancestorEntityId: projectId,
          };
        },
      },
    );

    // Post-commit: hidden → ready moves the row from the hidden bucket
    // back into the ready counters (data-model.md §5.14). Broadcast
    // AFTER mutate() resolves so a tx rollback (storage copy fault,
    // CAS-loss) emits nothing (AC-270).
    emitStorageUsageChanged();

    log.info({ attachmentId, projectId }, 'attachment_restored');
    return toAttachment(restored);
  }

  /**
   * Issue a presigned-GET URL plus the unwrapped DEK material that
   * decrypts the requested variant. ADR-0024 / api.md §14.2.11.
   *
   * The unwrap runs per request via a fresh `KeyEnvelopeService` against
   * the operator-loaded identity path. Per-row unwrap failures
   * (envelope corrupt, recipient mismatch) surface as
   * `422 DEK_UNWRAP_FAILED`; wholesale failures (operator identity not
   * loaded) bubble as 5xx — the boot probe is supposed to make that
   * unreachable in normal operation.
   */
  async issueDownloadUrl(
    caller: AuthUser,
    projectId: string,
    attachmentId: string,
    variant: DownloadVariant,
  ): Promise<DownloadUrlResult> {
    if (variant !== 'original' && variant !== 'thumbnail') {
      throw validationError(STRINGS.errors.invalidInput);
    }

    const row = await getById(this.db, attachmentId);
    if (!row || row.projectId !== projectId) {
      throw notFound(STRINGS.entities.resource);
    }

    // Scope: worker hitting an attachment on an unassigned project is
    // 403 (AC-217 three-way result). The attachment row existence is
    // already confirmed above, so this branch cannot collapse to 404.
    if (!(await isProjectInScope(this.db, caller, projectId))) {
      throw notPermitted();
    }

    // Pending rows are invisible to consumers — matches `listByProject`
    // which only surfaces ready rows. Issuing a download URL for an
    // unverified upload would leak partially-uploaded bytes past the
    // HEAD-verify gate. 404 mirrors the reaper-removed branch. Hidden
    // rows likewise — they carry a delete marker on the current
    // version, so the presigned GET would 404 from storage anyway.
    if (row.status !== 'ready') {
      throw notFound(STRINGS.entities.resource);
    }

    if (variant === 'thumbnail') {
      if (row.kind !== 'photo' || !row.thumbKey) {
        throw validationError(STRINGS.errors.invalidInput);
      }
    }

    // Variant-specific column selection. A thumbnail variant request
    // requires `wrappedThumbDek`; the schema CHECK ensures `wrappedDek`
    // exists on every ready row, but `wrappedThumbDek` may be null for
    // photos without a thumb (legacy seed). Surface that specific shape
    // as DEK_UNWRAP_FAILED — there is no decryptable envelope to return.
    const wrappedBase64 = variant === 'thumbnail' ? row.wrappedThumbDek : row.wrappedDek;
    if (!wrappedBase64) {
      throw dekUnwrapFailed();
    }
    // ADR-0024 envelope-format guard. The column says which wrapping
    // format the bytes were written under; the unwrap path validates
    // and refuses anything outside the known set BEFORE invoking
    // `age`. A row on a legacy / future format must not be silently
    // fed to the v1 parser. Surfaced as the same DEK_UNWRAP_FAILED
    // code as a corrupted envelope: from the SW's point of view both
    // are "this row cannot be rendered today", and the operator
    // diagnoses by reading the column directly.
    if (!isKnownWrappedDekVersion(row.wrappedDekVersion)) {
      throw dekUnwrapFailed();
    }
    const wrappedBytes = Buffer.from(wrappedBase64, 'base64');

    const envelope = this.envelopeService();
    let dekBytes: Uint8Array;
    try {
      dekBytes = await envelope.unwrap(wrappedBytes);
    } catch (err) {
      if (err instanceof KeyEnvelopeUnwrapError) {
        // Per-row failure — corrupt envelope or recipient mismatch.
        // Propagate as 422 with the documented code so the SW renders
        // the placeholder (AC-244).
        throw dekUnwrapFailed();
      }
      throw err;
    }
    const dekMaterial = Buffer.from(dekBytes).toString('base64');

    const presigned =
      variant === 'thumbnail'
        ? await this.storage.createPresignedGet(row.thumbKey!)
        : await this.storage.createPresignedGet(row.originalKey, undefined, row.filename);

    // Thumbnails are produced by the photo-thumbnail pipeline and are
    // always JPEG (src/server/services/AttachmentService.ts thumbnail
    // pre-encode); originals carry whatever MIME the client uploaded.
    const variantMime = variant === 'thumbnail' ? 'image/jpeg' : row.mimeType;

    return {
      url: presigned.url,
      expiresAt: presigned.expiresAt,
      dekMaterial,
      mimeType: variantMime,
    };
  }

  /**
   * Bulk fetch — per-file presigned-GETs + unwrapped DEK material for
   * each requested attachment. ADR-0024 / api.md §14.2.11. The browser
   * fetches each ciphertext, decrypts with the DEK, and assembles the
   * archive locally (streaming-zip).
   *
   * Caps:
   *   - count: `attachmentIds.length` ≤ `bulkDownloadMaxFiles`
   *   - bytes: summed plaintext `sizeBytes` ≤ `bulkDownloadMaxBytes`
   *
   * Rejection on either cap returns 422 BULK_LIMIT_EXCEEDED. A per-id
   * validation failure (cross-project id, non-ready status) rejects
   * the whole batch as 422 VALIDATION_ERROR — no partial-serve.
   *
   * Order is preserved: the response carries one entry per requested
   * id, in the order the client supplied. A regression that re-sorted
   * by createdAt would break the SW's progress accounting.
   */
  async bulkFetch(
    caller: AuthUser,
    projectId: string,
    attachmentIds: string[],
  ): Promise<BulkFetchResponse> {
    if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) {
      throw validationError(STRINGS.errors.invalidInput);
    }

    // Reject duplicate ids in the request BEFORE the DB read. Without
    // this guard, `[id, id, id]` produces a single-row fetch and
    // surfaces as a generic "id not in project" — making the failure
    // indistinguishable from an actually-invalid id. Deduplicating on
    // the server is also wrong (would silently collapse the response
    // to fewer entries than requested, breaking the SW's index-aligned
    // progress accounting). Fail fast with a distinct message.
    if (new Set(attachmentIds).size !== attachmentIds.length) {
      throw validationError(STRINGS.errors.invalidInput);
    }

    const caps = resolveCaps();
    // Count cap fires FIRST — failing fast on count keeps a flood of
    // fake ids from triggering a DB round-trip.
    if (attachmentIds.length > caps.bulkDownloadMaxFiles) {
      throw bulkLimitExceeded({
        limits: {
          maxFiles: caps.bulkDownloadMaxFiles,
          maxBytes: caps.bulkDownloadMaxBytes,
        },
      });
    }

    const projectRow = await getProjectRowById(this.db, projectId);
    if (!projectRow) throw notFound(STRINGS.entities.project);
    if (!(await isProjectInScope(this.db, caller, projectId))) {
      throw notPermitted();
    }

    const rows = await listByIdsForProject(this.db, projectId, attachmentIds, caller);
    // Every requested id must exist on this project.
    if (rows.length !== attachmentIds.length) {
      throw validationError(STRINGS.errors.invalidInput);
    }
    // No pending or hidden rows in the batch (api.md §14.2.11 design
    // notes "Non-`ready` rows are ineligible for bulk fetch").
    if (rows.some((r) => r.status !== 'ready')) {
      throw validationError(STRINGS.errors.invalidInput);
    }

    // Plaintext-bytes cap. The user-visible quantity is plaintext —
    // that's what the operator ultimately decrypts and downloads.
    const totalBytes = rows.reduce((sum, r) => sum + r.sizeBytes, 0);
    if (totalBytes > caps.bulkDownloadMaxBytes) {
      throw bulkLimitExceeded({
        limits: {
          maxFiles: caps.bulkDownloadMaxFiles,
          maxBytes: caps.bulkDownloadMaxBytes,
        },
      });
    }

    // Order-preserve the response by indexing rows by id and walking
    // the input order. `listByIdsForProject` returns rows in
    // DB-insertion order, which is not what the user sees.
    const rowById = new Map(rows.map((r) => [r.id, r] as const));
    const orderedRows = attachmentIds.map((id) => rowById.get(id)!);

    const envelope = this.envelopeService();
    const entries: BulkFetchEntry[] = [];
    for (const row of orderedRows) {
      // Per-row format gate (ADR-0024). The version pin is shared by
      // both wrapped envelopes on a row; check once before the
      // variant-specific unwraps. A row on a legacy / future format is
      // a data-integrity break — surface as 500 along with the other
      // bulk-fetch unwrap failures.
      if (!isKnownWrappedDekVersion(row.wrappedDekVersion)) {
        throw serverError();
      }
      // Original-side unwrap. Any failure here — including a missing
      // `wrappedDek` column on a 'ready' row — propagates as 500 per
      // api.md §14.2.11 ("any unwrap failure in the batch → 500
      // SERVER_ERROR"). The boot probe is supposed to make
      // `KeyEnvelopeUnwrapError` unreachable, so a hit here signals a
      // data-integrity break (corrupt envelope on a ready row, or a
      // partial key rotation that left some envelopes wrapped to a
      // different recipient). The single documented per-row 422
      // surface is `download-url`, not bulk.
      let originalDekBytes: Uint8Array;
      try {
        if (!row.wrappedDek) {
          throw new Error('wrapped_dek missing on ready row');
        }
        originalDekBytes = await envelope.unwrap(Buffer.from(row.wrappedDek, 'base64'));
      } catch {
        throw serverError();
      }
      const originalUpload = await this.storage.createPresignedGet(
        row.originalKey,
        undefined,
        row.filename,
      );
      const entry: BulkFetchEntry = {
        attachmentId: row.id,
        originalUrl: originalUpload.url,
        originalDekMaterial: Buffer.from(originalDekBytes).toString('base64'),
        ciphertextSizeBytes: row.ciphertextSizeBytes ?? row.sizeBytes,
      };
      // Photos with a thumbKey MUST carry a `wrappedThumbDek` envelope
      // — silently omitting the thumb would produce a partial-payload
      // entry that the SW cannot reconcile. Surface the missing column
      // as 500 (data integrity), the same shape as an unwrap failure.
      // Only when the row legitimately has no thumbnail (no `thumbKey`)
      // should the thumb fields be absent from the entry.
      if (row.kind === 'photo' && row.thumbKey) {
        let thumbDekBytes: Uint8Array;
        try {
          if (!row.wrappedThumbDek) {
            throw new Error('wrapped_thumb_dek missing on photo row with thumbKey');
          }
          thumbDekBytes = await envelope.unwrap(Buffer.from(row.wrappedThumbDek, 'base64'));
        } catch {
          throw serverError();
        }
        const thumbUpload = await this.storage.createPresignedGet(row.thumbKey);
        entry.thumbUrl = thumbUpload.url;
        entry.thumbDekMaterial = Buffer.from(thumbDekBytes).toString('base64');
        entry.ciphertextThumbSizeBytes = row.ciphertextThumbSizeBytes ?? undefined;
      }
      entries.push(entry);
    }
    return { data: entries };
  }
}

/**
 * Exported for the purge-cascade path in `ProjectCrudService` — the
 * cascade collects keys pre-commit via `listKeysForProject` and then
 * calls this helper after the DB transaction returns.
 */
export async function bestEffortHideStorageKeys(
  storage: AttachmentStorageClient,
  keys: Array<{ originalKey: string; thumbKey: string | null }>,
  log: ServiceLogger,
): Promise<void> {
  for (const entry of keys) {
    try {
      await storage.hide(entry.originalKey);
    } catch (err) {
      log.error(
        {
          event: 'attachment_storage_hide_failed',
          key: entry.originalKey,
          error_hint: err instanceof Error ? err.message : String(err),
        },
        'attachment_storage_hide_failed',
      );
    }
    if (entry.thumbKey) {
      try {
        await storage.hide(entry.thumbKey);
      } catch (err) {
        log.error(
          {
            event: 'attachment_storage_hide_failed',
            key: entry.thumbKey,
            error_hint: err instanceof Error ? err.message : String(err),
          },
          'attachment_storage_hide_failed',
        );
      }
    }
  }
}
