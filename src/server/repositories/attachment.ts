/**
 * Attachment repository — CRUD + scope-aware reads.
 *
 * Writes take `MutatingDatabase` (a transaction handle only; see
 * `src/server/db/connection.ts`) so a caller bypassing the service-
 * layer `mutate()` helper fails at tsc — AC-179's primary build-time
 * seam (ADR-0021). Reads accept `Database | TxHandle` via the
 * `TransactionalDatabase` alias for parity with other repos.
 *
 * The `attachmentScopeForCaller` predicate in `scope.ts` lets worker-
 * visible rows narrow by `project_workers` membership (AC-217); this
 * module composes it into list / get-by-id queries.
 */

import { and, desc, eq, inArray, lt, notLike } from 'drizzle-orm';
import type { Database, MutatingDatabase, TransactionalDatabase } from '../db/connection.js';
import { attachments, users } from '../db/schema.js';
import type { AttachmentKind, AttachmentLabel, AttachmentStatus } from '../../domain/types.js';
import type { AuthUser } from '../middleware/auth.js';
import { attachmentScopeForCaller } from './scope.js';

export type AttachmentRow = typeof attachments.$inferSelect;

/**
 * Read-side row shape: the attachment columns plus the uploader's display
 * name resolved via FK. `uploaderDisplayName` is null when the uploader
 * row is absent (FK was set null on user delete) or when the attachment
 * has no uploader (system-created — none today, but the column nullability
 * is preserved). Service layer reshapes this into the wire `Attachment`.
 */
export type AttachmentRowWithUploader = AttachmentRow & {
  uploaderDisplayName: string | null;
};

/**
 * Drizzle's leftJoin returns a nested `{ attachments: ..., users: ... }`
 * shape; flatten it into the read-row contract before returning so
 * downstream code stays unaware of the join.
 */
function flattenWithUploader(row: {
  attachments: AttachmentRow;
  users: { displayName: string } | null;
}): AttachmentRowWithUploader {
  return { ...row.attachments, uploaderDisplayName: row.users?.displayName ?? null };
}

export interface CreatePendingAttachmentInput {
  id?: string;
  projectId: string;
  kind: AttachmentKind;
  label: AttachmentLabel;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  originalKey: string;
  thumbKey: string | null;
  /**
   * Declared thumb sizeBytes from the init payload. Persisted at creation
   * so `completeUpload` can re-assert HEAD size against the row, mirroring
   * the original-side `sizeBytes` re-assertion. Null when `hasThumbnail`
   * is false.
   */
  thumbSizeBytes: number | null;
  hasThumbnail: boolean;
  /**
   * Ciphertext byte count for the original blob — what the server signs
   * into the presigned PUT's Content-Length and re-asserts at HEAD time
   * (ADR-0024 / api.md §14.2.11). Distinct from plaintext `sizeBytes`.
   */
  ciphertextSizeBytes: number;
  /** Same for the thumbnail blob; null for non-photo / no-thumb rows. */
  ciphertextThumbSizeBytes: number | null;
  /**
   * Base64 of the operator-`age`-wrapped envelope of the per-blob DEK
   * for the original ciphertext (ADR-0024). The unwrapped DEK is never
   * persisted — this column is the entire crypto perimeter on B2.
   */
  wrappedDek: string;
  /** Same for the thumbnail; null for non-photo / no-thumb rows. */
  wrappedThumbDek: string | null;
  /**
   * Envelope-format discriminator (ADR-0024). Shared between
   * `wrappedDek` and `wrappedThumbDek`. Current value is `1`; the
   * unwrap path validates this and refuses unknown values.
   */
  wrappedDekVersion: number;
  createdBy: string | null;
  /**
   * Optional override for the row's `createdAt` timestamp. Standard
   * upload init omits this field; the schema default (`now()`) stamps
   * the row. Issue #163 / AC-256: the takeout-zip restore orchestrator
   * supplies the source row's original `createdAt` here so the
   * restored row preserves the audit-time identity. Caller must hold
   * `data:restore` for this branch (service-layer gate in
   * `AttachmentService.initUpload`).
   */
  createdAt?: Date;
}

/**
 * List attachments on a project, ANDed with the caller's scope predicate
 * so a worker sees only rows on projects they are assigned to. Excludes
 * `pending` rows — the list surface in api.md §14.2.11 returns ready-only
 * rows; the service layer is responsible for that filter so repositories
 * stay composable.
 *
 * Invoice-rendered PDFs (written by `InvoiceService.persistRenderedBinary`
 * under the `invoices/<projectId>/<descriptorId>.orig` key prefix) are
 * hidden from this list. They are surfaced via the dedicated
 * `GET /api/invoices/:id/pdf` route; double-rendering them under the
 * generic attachment list would confuse the project-detail UI's
 * attachments block (ADR-0026 storage reuse note). The `originalKey`
 * prefix is the cleanest schema-free discriminator: the `label='rechnung'`
 * value is also user-selectable for human-uploaded Rechnung PDFs, and
 * `kind='binary'` covers every non-photo upload. The key namespace is
 * the renderer's own and never collides with user uploads.
 */
export async function listByProject(
  db: Database,
  projectId: string,
  caller: AuthUser,
): Promise<AttachmentRowWithUploader[]> {
  const scope = attachmentScopeForCaller(caller);
  const conditions = [
    eq(attachments.projectId, projectId),
    eq(attachments.status, 'ready'),
    notLike(attachments.originalKey, 'invoices/%'),
  ];
  if (scope) conditions.push(scope);
  const rows = await db
    .select({ attachments, users: { displayName: users.displayName } })
    .from(attachments)
    .leftJoin(users, eq(attachments.createdBy, users.id))
    .where(and(...conditions))
    .orderBy(desc(attachments.createdAt), desc(attachments.id));
  return rows.map(flattenWithUploader);
}

/**
 * Get a single attachment by id WITHOUT the scope predicate. Used by
 * the service layer's get-by-id which decides `404 / 403 / 200` with a
 * distinct scope lookup (parallel to `getProject` in `project-read.ts`).
 */
export async function getById(
  db: TransactionalDatabase,
  id: string,
): Promise<AttachmentRowWithUploader | null> {
  const rows = await db
    .select({ attachments, users: { displayName: users.displayName } })
    .from(attachments)
    .leftJoin(users, eq(attachments.createdBy, users.id))
    .where(eq(attachments.id, id))
    .limit(1);
  const row = rows[0];
  return row ? flattenWithUploader(row) : null;
}

export async function createPending(
  db: MutatingDatabase,
  input: CreatePendingAttachmentInput,
): Promise<AttachmentRow> {
  const rows = await db
    .insert(attachments)
    .values({
      ...(input.id !== undefined ? { id: input.id } : {}),
      projectId: input.projectId,
      status: 'pending',
      kind: input.kind,
      label: input.label,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      originalKey: input.originalKey,
      thumbKey: input.thumbKey,
      thumbSizeBytes: input.thumbSizeBytes,
      hasThumbnail: input.hasThumbnail,
      ciphertextSizeBytes: input.ciphertextSizeBytes,
      ciphertextThumbSizeBytes: input.ciphertextThumbSizeBytes,
      wrappedDek: input.wrappedDek,
      wrappedThumbDek: input.wrappedThumbDek,
      wrappedDekVersion: input.wrappedDekVersion,
      createdBy: input.createdBy,
      // Standard init omits createdAt — the column defaults to `now()`.
      // Issue #163 / AC-256: restore-mode init supplies the source row's
      // timestamp here.
      ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
    })
    .returning();
  return rows[0]!;
}

/**
 * Flip `pending` → `ready` conditionally and persist the per-version-id
 * pair captured at HEAD-verify time (ADR-0022). Returns the updated row
 * when the status transition was applied; returns null when the row is
 * gone OR already at `ready` — the service layer distinguishes those
 * cases via a follow-up read (404 vs 409 per AC-212).
 *
 * The WHERE predicate on `status = 'pending'` is the atomic guard that
 * turns the two-call flow (read → write) into a single CAS.
 *
 * `thumbVersionId` is set in tandem with `versionId` for photos
 * (`hasThumbnail=true`); for binaries it is null, mirroring `thumbKey`.
 * Both are captured from the bucket's HEAD response — the version that
 * is current immediately post-upload is what restore must recreate.
 */
export async function markReady(
  db: MutatingDatabase,
  id: string,
  versions: { versionId: string | null; thumbVersionId: string | null },
): Promise<AttachmentRowWithUploader | null> {
  const rows = await db
    .update(attachments)
    .set({
      status: 'ready',
      versionId: versions.versionId,
      thumbVersionId: versions.thumbVersionId,
    })
    .where(and(eq(attachments.id, id), eq(attachments.status, 'pending')))
    .returning();
  if (!rows[0]) return null;
  // Re-read inside the same tx to pick up the uploader display name via
  // the JOIN; UPDATE...RETURNING cannot select joined columns directly.
  return getById(db, id);
}

/**
 * Hard-delete by id. Returns the deleted row (for audit-payload capture)
 * or null when the row did not exist.
 *
 * Used by the orphan reaper (pending rows that never reached the audit
 * chain) and by the project-delete cascade (the project row's audit
 * carries the destruction; per-attachment audit rows would duplicate
 * that). User-initiated removals go through `markHidden` instead —
 * those are reversible and need their own audit row.
 */
export async function deleteById(db: MutatingDatabase, id: string): Promise<AttachmentRow | null> {
  const rows = await db.delete(attachments).where(eq(attachments.id, id)).returning();
  return rows[0] ?? null;
}

/**
 * Flip `ready` → `hidden`, stamp `hidden_at = now()`. Returns the updated
 * row when the transition was applied; null when the row is gone or
 * already in another state. Atomic CAS via the WHERE on `status='ready'`.
 *
 * Pending rows can never reach hidden — they are reaped by the orphan
 * reaper (their backing upload never completed; there is nothing to
 * restore). Hidden rows are idempotent at the API level — a second
 * DELETE returns 409 because this returns null.
 */
export async function markHidden(
  db: MutatingDatabase,
  id: string,
): Promise<AttachmentRowWithUploader | null> {
  const rows = await db
    .update(attachments)
    .set({ status: 'hidden', hiddenAt: new Date() })
    .where(and(eq(attachments.id, id), eq(attachments.status, 'ready')))
    .returning();
  if (!rows[0]) return null;
  return getById(db, id);
}

/**
 * Flip `hidden` → `ready` and clear `hidden_at`. Atomic CAS on
 * `status='hidden'` — the WHERE predicate turns the read+write into a
 * single conditional update. Returns the updated row when the
 * transition was applied; null on CAS-loss (the row was not in
 * `hidden` at the moment of the UPDATE).
 *
 * The version_id pair is intentionally NOT touched here. Restore is a
 * two-phase operation: this CAS locks the row first, then the service
 * issues `copyFromVersion` (storage round-trip), then writes the
 * fresh version-ids via `setVersionIds`. Splitting the writes lets a
 * storage failure roll back the status flip via the surrounding
 * transaction without producing orphan storage versions.
 */
export async function markRestored(
  db: MutatingDatabase,
  id: string,
): Promise<AttachmentRowWithUploader | null> {
  const rows = await db
    .update(attachments)
    .set({ status: 'ready', hiddenAt: null })
    .where(and(eq(attachments.id, id), eq(attachments.status, 'hidden')))
    .returning();
  if (!rows[0]) return null;
  return getById(db, id);
}

/**
 * Overwrite the `version_id` / `thumb_version_id` pair on a row that
 * the caller already holds a row-level lock on (typically via a prior
 * CAS in the same transaction). No status predicate — this is the
 * second phase of the restore flow where the surrounding transaction's
 * lock guarantees no concurrent writer is racing the same row.
 *
 * Returns the updated row (with uploader display name re-fetched) or
 * null when the id does not exist.
 */
export async function setVersionIds(
  db: MutatingDatabase,
  id: string,
  versions: { versionId: string | null; thumbVersionId: string | null },
): Promise<AttachmentRowWithUploader | null> {
  const rows = await db
    .update(attachments)
    .set({ versionId: versions.versionId, thumbVersionId: versions.thumbVersionId })
    .where(eq(attachments.id, id))
    .returning();
  if (!rows[0]) return null;
  return getById(db, id);
}

/**
 * List rows in the project's Papierkorb — `status='hidden'`, ordered by
 * `hiddenAt` desc so the most-recent removals surface first. Same scope
 * predicate as the live list (worker visibility narrowing) so the type
 * shape is consistent; the calling service layer enforces "owner / office
 * only" via `attachment:trash` permission, so workers never reach this.
 */
export async function listHiddenByProject(
  db: Database,
  projectId: string,
  caller: AuthUser,
): Promise<AttachmentRowWithUploader[]> {
  const scope = attachmentScopeForCaller(caller);
  // Same invoice-rendered-PDF exclusion as the live list — the
  // Papierkorb is the user-facing trash surface for documents the
  // operator uploaded; rendered invoice PDFs cannot reach `hidden`
  // through any user action today, but the symmetric filter guards
  // against a future code path that does (and against direct-SQL
  // poisoning).
  const conditions = [
    eq(attachments.projectId, projectId),
    eq(attachments.status, 'hidden'),
    notLike(attachments.originalKey, 'invoices/%'),
  ];
  if (scope) conditions.push(scope);
  const rows = await db
    .select({ attachments, users: { displayName: users.displayName } })
    .from(attachments)
    .leftJoin(users, eq(attachments.createdBy, users.id))
    .where(and(...conditions))
    .orderBy(desc(attachments.hiddenAt), desc(attachments.id));
  return rows.map(flattenWithUploader);
}

/**
 * List pending rows older than the cutoff time. Used by the orphan
 * reaper (data-model.md §6.11).
 */
export async function listOrphans(db: Database, cutoffTime: Date): Promise<AttachmentRow[]> {
  return db
    .select()
    .from(attachments)
    .where(and(eq(attachments.status, 'pending'), lt(attachments.createdAt, cutoffTime)));
}

/**
 * Fetch attachments on a project regardless of status — used by the
 * bulk-download service to detect pending rows inside the batch
 * (AC-216 "any id referencing a row with status = 'pending' …").
 *
 * The caller's scope predicate is ANDed into the query per ADR-0019,
 * so a scoped caller hitting ids on an unassigned project gets an
 * empty result set at the repo layer. The service layer's
 * `isProjectInScope` precondition still runs first — defence in depth.
 */
export async function listByIdsForProject(
  db: Database,
  projectId: string,
  ids: string[],
  caller: AuthUser,
): Promise<AttachmentRow[]> {
  if (ids.length === 0) return [];
  const scope = attachmentScopeForCaller(caller);
  const conditions = [eq(attachments.projectId, projectId), inArray(attachments.id, ids)];
  if (scope) conditions.push(scope);
  return db
    .select()
    .from(attachments)
    .where(and(...conditions));
}

/**
 * Collect every attachment key (original + thumb) for a project, with
 * status. Used by the purge cascade so the storage-side cleanup can
 * fire after the DB transaction commits (AC-218), and so the caller
 * can gate `storage_usage_changed` emission on whether the cascade
 * removed any byte-bearing rows (AC-270 — pending rows contribute zero
 * to every counter, so a purge whose attachments were all `pending`
 * does not move the global figure).
 */
export async function listKeysForProject(
  db: TransactionalDatabase,
  projectId: string,
): Promise<Array<{ originalKey: string; thumbKey: string | null; status: AttachmentStatus }>> {
  const rows = await db
    .select({
      originalKey: attachments.originalKey,
      thumbKey: attachments.thumbKey,
      status: attachments.status,
    })
    .from(attachments)
    .where(eq(attachments.projectId, projectId));
  return rows as Array<{ originalKey: string; thumbKey: string | null; status: AttachmentStatus }>;
}

/**
 * Collect every attachment key in the table. Used by the override-import
 * path so the bytes left over from the prior dataset can be hidden after
 * the TRUNCATE commits — without this, the orphaned objects sit as
 * current versions of unreferenced keys and the lifecycle policy
 * (which only reaps noncurrent versions) leaves them forever.
 */
export async function listAllKeys(
  db: TransactionalDatabase,
): Promise<Array<{ originalKey: string; thumbKey: string | null }>> {
  return db
    .select({ originalKey: attachments.originalKey, thumbKey: attachments.thumbKey })
    .from(attachments);
}

/**
 * Delete pending rows older than cutoff directly. Returns the deleted
 * rows (for storage-side cleanup + count). The reaper is allowlisted in
 * `scripts/check-audit-mutations.sh` — rows never entered the domain,
 * so removal is housekeeping, not an audit event.
 */
export async function deleteOrphans(db: Database, cutoffTime: Date): Promise<AttachmentRow[]> {
  return db
    .delete(attachments)
    .where(and(eq(attachments.status, 'pending'), lt(attachments.createdAt, cutoffTime)))
    .returning();
}

/**
 * List rows eligible for the hidden reaper (data-model.md §6.12): rows
 * at `status = 'hidden'` whose age past `hiddenAt` exceeds the TTL.
 *
 * Read outside the per-row transaction so the reaper can iterate one-
 * mutate-per-row without holding a long-lived lock; the per-row CAS in
 * `deleteHiddenForReap` re-asserts `status = 'hidden'` at delete time
 * to fence a concurrent restore that landed between this read and the
 * delete.
 */
export async function findHiddenForReap(db: Database, cutoffTime: Date): Promise<AttachmentRow[]> {
  return db
    .select()
    .from(attachments)
    .where(and(eq(attachments.status, 'hidden'), lt(attachments.hiddenAt, cutoffTime)));
}

/**
 * CAS DELETE inside the per-row `mutate()` transaction. The
 * `status = 'hidden'` predicate guards against a concurrent restore
 * that flipped the row to `ready` after `findHiddenForReap` snapshot
 * it. Returns the deleted row on success, or `undefined` on CAS-loss
 * — the caller throws a sentinel so the surrounding `mutate()`
 * transaction rolls back the audit insert.
 */
export async function deleteHiddenForReap(
  tx: MutatingDatabase,
  id: string,
): Promise<AttachmentRow | undefined> {
  const rows = await tx
    .delete(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.status, 'hidden')))
    .returning();
  return rows[0];
}

/**
 * Fields for the rendered-invoice-PDF descriptor row written by
 * `InvoiceBinaryService.persistRendered`. The schema's
 * `attachments_wrapped_dek_required_when_ready` CHECK demands the
 * wrapped envelope + ciphertext size are non-null at `status='ready'`
 * — the service computes both upfront (DEK wrap + AES-GCM ciphertext
 * byte count) and passes them in here. The bucket's default-retention
 * envelope (`INVOICE_OBJECT_LOCK_DAYS`, asserted at boot per AC-296)
 * attaches Object Lock at PUT time; the row is just the descriptor.
 */
export interface InsertRenderedInvoiceBinaryFields {
  id: string;
  projectId: string;
  filename: string;
  sizeBytes: number;
  originalKey: string;
  ciphertextSizeBytes: number;
  /**
   * VersionId resolved by the service via a post-PUT HEAD against the
   * bucket. The HEAD is cheap (no body fetch) and lets the Papierkorb
   * restore primitive address the current version later. Null on
   * unversioned buckets (defense in depth — boot-time assertions make
   * those unreachable).
   */
  versionId: string | null;
  /**
   * Base64 of the operator-`age`-wrapped envelope of the per-blob DEK
   * for the rendered PDF ciphertext (ADR-0024). Required at
   * `status='ready'` by the schema CHECK; never persisted unwrapped.
   */
  wrappedDek: string;
  wrappedDekVersion: number;
  createdBy: string;
}

/**
 * INSERT the rendered-invoice-PDF descriptor row at `status='ready'`.
 * Called from inside the issuance / cancel transactions, so a fault
 * after the bucket PUT rolls back the row insert and leaves the object
 * behind.
 *
 * That orphan is NOT reaped by the attachment-orphan reaper. The reaper
 * deletes rows matching `status = 'pending'` (`deleteOrphans`) and hides
 * their keys; a rolled-back insert leaves no row at all, so there is
 * nothing for it to match and the object leaks indefinitely. An earlier
 * version of this comment claimed the opposite — it was wrong.
 *
 * Cleanup today is `npm run storage:prune` (issue #169 item A), the
 * operator-run bucket/DB reconciliation. The real fix is to write a
 * `pending` row BEFORE the PUT and flip it to `ready` after, the way
 * `AttachmentService.initUpload` already does, which would bring this
 * path back under the reaper — tracked as issue #169 item B.
 *
 * Pinned fields:
 *   - `kind='binary'` / `label='rechnung'` — rendered invoice PDFs
 *     are surfaced via `GET /api/invoices/:id/pdf`, NOT in the
 *     generic attachment list (the list filters on the `invoices/`
 *     key prefix; see `listByProject`).
 *   - `mimeType='application/pdf'`.
 *   - `hasThumbnail=false` / `thumb*` columns null — invoices have
 *     no thumbnail today.
 *   - `hiddenAt=null` — never enters the trash flow.
 */
export async function insertRenderedInvoiceBinary(
  tx: MutatingDatabase,
  fields: InsertRenderedInvoiceBinaryFields,
): Promise<void> {
  await tx.insert(attachments).values({
    id: fields.id,
    projectId: fields.projectId,
    status: 'ready',
    kind: 'binary',
    label: 'rechnung',
    filename: fields.filename,
    mimeType: 'application/pdf',
    sizeBytes: fields.sizeBytes,
    originalKey: fields.originalKey,
    thumbKey: null,
    thumbSizeBytes: null,
    hasThumbnail: false,
    ciphertextSizeBytes: fields.ciphertextSizeBytes,
    ciphertextThumbSizeBytes: null,
    versionId: fields.versionId,
    thumbVersionId: null,
    wrappedDek: fields.wrappedDek,
    wrappedThumbDek: null,
    wrappedDekVersion: fields.wrappedDekVersion,
    hiddenAt: null,
    createdBy: fields.createdBy,
  });
}

export type { AttachmentStatus };
