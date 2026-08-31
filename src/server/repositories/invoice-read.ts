/**
 * Invoice repository — reads + write primitives.
 *
 * Reads accept `Database | TransactionalDatabase`. Writes accept
 * `MutatingDatabase` (a transaction handle only) so a caller bypassing
 * the service-layer `mutate()` helper fails at tsc — AC-179's primary
 * build-time seam (ADR-0021). The service layer captures
 * `payload.before` / `payload.after` and feeds it to `mutate()`; the
 * repo functions own the raw Drizzle calls and return the row(s) the
 * service needs for the audit payload (ADR-0026 §Audit and realtime).
 *
 * Worker exclusion follows ADR-0019: there is no `project_worker` scope
 * path on invoices, so the worker predicate returns the empty set on
 * the list query and rejects the `getInvoice` path before the row read
 * — defense in depth against the route-layer permission gate (AC-298).
 */

import { eq, and, desc, asc, inArray, count, sql, type SQL } from 'drizzle-orm';
import type { Database, MutatingDatabase, TransactionalDatabase } from '../db/connection.js';
import { invoices, projects } from '../db/schema.js';
import type { AuthUser } from '../middleware/auth.js';
import { isUnscoped, OUT_OF_SCOPE, type ScopedReadResult } from './scope.js';
import { invoiceNumberFormat } from '../errors.js';
import {
  formatInvoiceNumber,
  INVOICE_NUMBER_PATTERN,
  INVOICE_SEQUENCE_KINDS,
  type Invoice,
  type InvoiceLine,
  type InvoiceIssuerSnapshot,
  type InvoiceRecipientSnapshot,
  type InvoiceTotals,
  type InvoiceStatus,
  type InvoiceProfile,
  type TaxMode,
  type InvoiceSequenceKind,
} from '../../domain/invoice.js';

export type InvoiceRow = typeof invoices.$inferSelect;

/** Escape LIKE-pattern metacharacters so user input is treated literally. */
function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&');
}

/** ISO 8601 date string for a JS `Date` or null (yyyy-mm-dd; UTC anchor). */
function dateToIso(value: Date | null | undefined): string | null {
  if (!value) return null;
  const y = value.getUTCFullYear();
  const m = String(value.getUTCMonth() + 1).padStart(2, '0');
  const d = String(value.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Convert a raw `invoices` row to the API-facing `Invoice` shape. JSONB
 * columns round-trip through `unknown` from Drizzle — the column-level
 * TypeScript types in `schema.ts` use `$type<>()` on a handful of
 * columns but not on the invoice snapshots, so we cast through the
 * documented shape here. Casts are localised to this projection
 * function (the entrypoint for "raw row → wire shape").
 */
export function toInvoiceResponse(row: InvoiceRow): Invoice {
  return {
    id: row.id,
    number: row.number,
    status: row.status as InvoiceStatus,
    projectId: row.projectId,
    cancellationOf: row.cancellationOf,
    issuer: row.issuer as InvoiceIssuerSnapshot,
    recipient: row.recipient as InvoiceRecipientSnapshot,
    lines: row.lines as InvoiceLine[],
    taxMode: row.taxMode as TaxMode,
    profile: row.profile as InvoiceProfile,
    totals: row.totals as InvoiceTotals,
    issueDate: dateToIso(row.issueDate),
    performanceDate: dateToIso(row.performanceDate),
    cancellationReason: row.cancellationReason,
    renderedPdfBinaryDescriptorId: row.renderedPdfBinaryDescriptorId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
  };
}

export interface ListInvoicesOpts {
  offset?: number;
  limit?: number;
  status?: InvoiceStatus;
  year?: number;
  projectId?: string;
  customerId?: string;
  /** Default `true` — when false, hide `status = 'cancelled'` originals. */
  includeCancelled?: boolean;
  search?: string;
}

/**
 * List invoices visible to the caller. Worker callers always see the
 * empty set (AC-298, AT-119) — the scope predicate has no
 * `project_worker` path on the invoice row, so the worker branch
 * short-circuits before issuing the SELECT.
 *
 * Ordering: `issueDate DESC, createdAt DESC, id` (api.md §14.2.14). Drafts
 * have null `issueDate` and sort by `createdAt DESC` via NULLS LAST.
 *
 * Search matches `number` and the snapshotted `recipient.name` (JSONB
 * extraction).
 */
export async function listInvoices(
  db: Database,
  caller: AuthUser,
  opts: ListInvoicesOpts = {},
): Promise<{ data: Invoice[]; total: number }> {
  // Worker scope: no path to any invoice (ADR-0019). The defense-in-
  // depth predicate returns an empty list regardless of opts.
  if (!isUnscoped(caller)) {
    return { data: [], total: 0 };
  }

  const conditions: SQL[] = [];
  if (opts.status) conditions.push(eq(invoices.status, opts.status));
  if (opts.year !== undefined) {
    // `EXTRACT(YEAR FROM issue_date)` works on the persisted issue date
    // but is null for drafts; the route documents `year` as a filter
    // that only matches issued/cancelled rows, which is what consumers
    // expect when bookkeeping by year.
    conditions.push(sql`EXTRACT(YEAR FROM ${invoices.issueDate}) = ${opts.year}`);
  }
  if (opts.projectId) conditions.push(eq(invoices.projectId, opts.projectId));
  if (opts.includeCancelled === false) {
    // Hide originals only — Stornos are surfaced regardless (they are
    // their own document for the auditor).
    conditions.push(
      sql`NOT (${invoices.status} = 'cancelled' AND ${invoices.cancellationOf} IS NULL)`,
    );
  }
  if (opts.search) {
    const pattern = `%${escapeLike(opts.search)}%`;
    conditions.push(
      sql`(${invoices.number} ILIKE ${pattern}
           OR ${invoices.recipient}->>'name' ILIKE ${pattern})`,
    );
  }

  if (opts.customerId) {
    // Resolve the customer's project ids first so the SELECT has the
    // same shape as the project-scoped path. Single round-trip; the
    // customer surface is bounded.
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.customerId, opts.customerId));
    const customerProjectIds = rows.map((r) => r.id);
    if (customerProjectIds.length === 0) {
      return { data: [], total: 0 };
    }
    conditions.push(inArray(invoices.projectId, customerProjectIds));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const orderBy = [
    sql`${invoices.issueDate} DESC NULLS LAST`,
    desc(invoices.createdAt),
    asc(invoices.id),
  ];

  const baseQuery = whereClause
    ? db
        .select()
        .from(invoices)
        .where(whereClause)
        .orderBy(...orderBy)
    : db
        .select()
        .from(invoices)
        .orderBy(...orderBy);
  const paginated =
    opts.limit !== undefined ? baseQuery.limit(opts.limit).offset(opts.offset ?? 0) : baseQuery;
  const countQuery = whereClause
    ? db.select({ value: count() }).from(invoices).where(whereClause)
    : db.select({ value: count() }).from(invoices);

  const [rows, countResult] = await Promise.all([paginated, countQuery]);
  return {
    data: rows.map(toInvoiceResponse),
    total: countResult[0]?.value ?? 0,
  };
}

/**
 * Distinct calendar years that appear in `issueDate` across the
 * caller-visible invoices. Drafts (null `issueDate`) are excluded by
 * the WHERE clause. Drives the year filter dropdown on `/rechnungen`
 * (ui/invoices.md §8.16.1) — the dropdown MUST be derived independent
 * of the current filter, otherwise picking year=N drops every other
 * year from the dropdown on the very next render.
 *
 * Ordered descending so the most recent year sits at the top of the
 * picker.
 */
export async function listInvoiceYears(db: Database, caller: AuthUser): Promise<number[]> {
  if (!isUnscoped(caller)) return [];
  const rows = await db.execute<{ year: number }>(
    sql`SELECT DISTINCT EXTRACT(YEAR FROM ${invoices.issueDate})::int AS year
        FROM ${invoices}
        WHERE ${invoices.issueDate} IS NOT NULL
        ORDER BY year DESC`,
  );
  return rows.rows.map((r) => r.year);
}

/**
 * Get an invoice by id with the worker-exclusion three-way semantic
 * (AC-298 — `null` / OUT_OF_SCOPE / row), mirroring the project-scope
 * policy (AC-147).
 *
 * Existence is not secret — workers receive 403 on hit, 404 on miss;
 * this is the documented role-boundary policy per AC-147 (and AC-298
 * for invoices). The row existence check runs before the scope check
 * so the three-way semantic surfaces correctly.
 */
export async function getInvoice(
  db: Database,
  caller: AuthUser,
  id: string,
): Promise<ScopedReadResult<Invoice>> {
  const rows = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  if (rows.length === 0) return null;
  if (!isUnscoped(caller)) return OUT_OF_SCOPE;
  return toInvoiceResponse(rows[0]!);
}

/**
 * Fetch a raw invoice row inside a transaction. Used by the service
 * layer to read `payload.before` inside the same snapshot as the
 * mutation. Returns null on miss; callers map to `NOT_FOUND`.
 */
export async function getInvoiceRowForMutation(
  tx: TransactionalDatabase,
  id: string,
): Promise<InvoiceRow | null> {
  const rows = await tx.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Count issued + cancelled invoice rows for a given project. Drafts are
 * excluded by construction (AC-307 / AC-308): drafts cascade-delete and
 * have no legal weight. Returns 0 when the project carries no invoices.
 */
export async function countIssuedOrCancelledForProject(
  db: TransactionalDatabase,
  projectId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(invoices)
    .where(
      and(eq(invoices.projectId, projectId), inArray(invoices.status, ['issued', 'cancelled'])),
    );
  return rows[0]?.value ?? 0;
}

/**
 * Count issued + cancelled invoice rows across a customer's project
 * graph (active + archived). AC-307: drives the customer-delete reject
 * decision and the `invoiceCount` exposed on the customer GET response.
 */
export async function countIssuedOrCancelledForCustomer(
  db: TransactionalDatabase,
  customerId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(invoices)
    .innerJoin(projects, eq(invoices.projectId, projects.id))
    .where(
      and(eq(projects.customerId, customerId), inArray(invoices.status, ['issued', 'cancelled'])),
    );
  return rows[0]?.value ?? 0;
}

/**
 * Allocate the next value in the gapless `(year, kind)` sequence inside
 * the supplied transaction (data-model.md §6.13). Implementation pattern
 * — a single atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING`:
 *
 *   INSERT INTO invoice_sequence (year, kind, next_value) VALUES (y, k, 2)
 *     ON CONFLICT (year, kind) DO UPDATE
 *       SET next_value = invoice_sequence.next_value + 1,
 *           updated_at = NOW()
 *     RETURNING next_value;
 *
 * Whichever branch runs, the returned `next_value` is the POST-increment
 * value; the caller hands out `next_value - 1`. The pattern is the
 * canonical Postgres upsert for sequence-style claim:
 *
 *   - First allocation of `(year, kind)`: the INSERT succeeds at
 *     `next_value = 2`; we return 1 (post-increment − 1).
 *   - Subsequent allocation: the INSERT's PK collision triggers the
 *     `DO UPDATE`, post-increment runs, `next_value` returned is the
 *     new value; we return one less.
 *
 * Concurrency: the INSERT (or its conflict-triggered UPDATE) takes a
 * row-exclusive lock on the inserted / updated row that is held until
 * the transaction commits — equivalent to `SELECT FOR UPDATE` for
 * serialization purposes. A concurrent first-of-year racer hitting the
 * PK blocks on the existing INSERT's lock; when the first transaction
 * commits, the second's `ON CONFLICT` branch runs against the now-
 * existing row and produces the next value. A rollback returns the
 * value to the sequence (AC-288 gapless guarantee).
 *
 * The previous two-step shape (UPDATE-then-INSERT-on-miss) leaked PG
 * `23505 unique_violation` to the caller when two transactions raced
 * the first-of-year INSERT path (review finding M1). The atomic upsert
 * collapses both branches into one statement so PK contention is
 * resolved inside Postgres, not at the application layer.
 *
 * Caller passes the year and kind; the formatted string is built at the
 * call site via `formatInvoiceNumber`. Returns the integer suffix value.
 */
export async function allocateNextSequenceValue(
  tx: TransactionalDatabase,
  year: number,
  kind: InvoiceSequenceKind,
): Promise<number> {
  // Validate at the boundary — defense against a programming error
  // landing a non-pinned `kind` and falling through to a free-text
  // INSERT against the CHECK constraint.
  if (!INVOICE_SEQUENCE_KINDS.includes(kind)) {
    throw new Error(`allocateNextSequenceValue: invalid kind ${String(kind)}`);
  }

  // Single atomic upsert. The seed INSERT value is 2 so the
  // post-increment subtraction below produces 1 on first allocation;
  // the DO UPDATE branch increments by 1 every subsequent call.
  const result = await tx.execute(
    sql`INSERT INTO invoice_sequence (year, kind, next_value)
        VALUES (${year}, ${kind}, 2)
        ON CONFLICT (year, kind) DO UPDATE
          SET next_value = invoice_sequence.next_value + 1,
              updated_at = NOW()
        RETURNING next_value`,
  );

  const post = Number((result.rows[0] as { next_value: string | number }).next_value);
  return post - 1;
}

/**
 * Convenience — allocate + format in one call. Returns the canonical
 * `RE-YYYY-NNNN` / `ST-YYYY-NNNN` string.
 *
 * The formatted number is checked against `INVOICE_NUMBER_PATTERN`
 * before it leaves — the application-side half of the defense in depth
 * api.md §14.4.1 describes for `INVOICE_NUMBER_FORMAT`. The DB CHECK is
 * the primary enforcement, but it fires on INSERT: without this the
 * violation would surface as an opaque 500 from the constraint rather
 * than as the typed code the spec publishes. Reachable only via a
 * corrupt `invoice_sequence` row or an out-of-range year, so it is not
 * expected to fire — that is the point of a detector.
 */
export async function allocateInvoiceNumber(
  tx: TransactionalDatabase,
  year: number,
  kind: InvoiceSequenceKind,
): Promise<{ value: number; number: string }> {
  const value = await allocateNextSequenceValue(tx, year, kind);
  const number = formatInvoiceNumber(kind, year, value);
  if (!INVOICE_NUMBER_PATTERN.test(number)) {
    throw invoiceNumberFormat();
  }
  return { value, number };
}

// ---------------------------------------------------------------------
// Write functions — INSERT / UPDATE / DELETE primitives.
//
// All accept `MutatingDatabase` (transaction handle only). The
// service-layer `mutate()` helper supplies the tx; the audit-row
// payload is constructed by the service from `before`/`after` it has
// in hand. Repo just writes.
// ---------------------------------------------------------------------

/**
 * Fields for inserting a fresh draft invoice. The full schema row is
 * constrained at insert time — every column needed for `status='draft'`
 * is passed in by the service after it has resolved the project, the
 * recipient overlay, and the placeholder issuer.
 */
export interface InsertInvoiceDraftFields {
  id: string;
  projectId: string;
  performanceDate: Date | null;
  taxMode: TaxMode;
  profile: InvoiceProfile;
  issuer: InvoiceIssuerSnapshot;
  recipient: InvoiceRecipientSnapshot;
  lines: InvoiceLine[];
  totals: InvoiceTotals;
  createdBy: string;
  updatedBy: string;
}

/**
 * INSERT a fresh draft row. The service supplies a pre-allocated id
 * and the snapshotted columns; this just writes the row and returns
 * it for the audit `after` payload.
 */
export async function insertInvoiceDraft(
  tx: MutatingDatabase,
  fields: InsertInvoiceDraftFields,
): Promise<InvoiceRow> {
  const rows = await tx
    .insert(invoices)
    .values({
      id: fields.id,
      projectId: fields.projectId,
      status: 'draft',
      number: null,
      issueDate: null,
      performanceDate: fields.performanceDate,
      taxMode: fields.taxMode,
      profile: fields.profile,
      issuer: fields.issuer,
      recipient: fields.recipient,
      lines: fields.lines,
      totals: fields.totals,
      cancellationOf: null,
      cancellationReason: null,
      renderedPdfBinaryDescriptorId: null,
      createdBy: fields.createdBy,
      updatedBy: fields.updatedBy,
    })
    .returning();
  return rows[0]!;
}

/**
 * Fields to patch on an existing draft row. The service has already
 * resolved overlays (recipient merge, totals re-derivation,
 * performanceDate semantics) and passes the post-patch values verbatim.
 */
export interface UpdateInvoiceDraftFields {
  taxMode: TaxMode;
  lines: InvoiceLine[];
  totals: InvoiceTotals;
  recipient: InvoiceRecipientSnapshot;
  performanceDate: Date | null;
  updatedBy: string;
}

/**
 * UPDATE a draft row with the post-patch values. The service is
 * responsible for the status-frozen precondition (only drafts may be
 * patched); the repo writes whatever the service hands in.
 */
export async function updateInvoiceDraft(
  tx: MutatingDatabase,
  id: string,
  fields: UpdateInvoiceDraftFields,
): Promise<InvoiceRow> {
  const rows = await tx
    .update(invoices)
    .set({
      taxMode: fields.taxMode,
      lines: fields.lines,
      totals: fields.totals,
      recipient: fields.recipient,
      performanceDate: fields.performanceDate,
      updatedAt: new Date(),
      updatedBy: fields.updatedBy,
    })
    .where(eq(invoices.id, id))
    .returning();
  return rows[0]!;
}

/**
 * Hard-delete a draft row. The service is responsible for the
 * status-frozen precondition; the repo just executes the DELETE.
 */
export async function deleteInvoiceDraft(tx: MutatingDatabase, id: string): Promise<void> {
  await tx.delete(invoices).where(eq(invoices.id, id));
}

/**
 * Fields written in the single combined UPDATE that flips a draft to
 * `issued`. The service does all the snapshotting (issuer block from
 * the live profile, totals re-derived from lines+taxMode, descriptor
 * id from the binary-pipeline persistRendered call) and passes the
 * final values verbatim.
 */
export interface ApplyIssuanceUpdateFields {
  number: string;
  issueDate: Date;
  issuer: InvoiceIssuerSnapshot;
  recipient: InvoiceRecipientSnapshot;
  lines: InvoiceLine[];
  totals: InvoiceTotals;
  taxMode: TaxMode;
  profile: InvoiceProfile;
  renderedPdfBinaryDescriptorId: string;
  updatedBy: string;
}

/**
 * The single UPDATE that flips draft→issued and writes the descriptor
 * in one statement (so the immutability trigger sees a single transition
 * from draft, not an UPDATE of an already-issued row). Called from the
 * issuance atom AFTER render + binary persist; ordering matters because
 * the persistence-layer immutability trigger blocks UPDATE-after-INSERT
 * on issued rows.
 */
export async function applyIssuanceUpdate(
  tx: MutatingDatabase,
  id: string,
  fields: ApplyIssuanceUpdateFields,
): Promise<InvoiceRow> {
  const rows = await tx
    .update(invoices)
    .set({
      status: 'issued',
      number: fields.number,
      issueDate: fields.issueDate,
      issuer: fields.issuer,
      recipient: fields.recipient,
      lines: fields.lines,
      totals: fields.totals,
      taxMode: fields.taxMode,
      profile: fields.profile,
      renderedPdfBinaryDescriptorId: fields.renderedPdfBinaryDescriptorId,
      updatedAt: fields.issueDate,
      updatedBy: fields.updatedBy,
    })
    .where(eq(invoices.id, id))
    .returning();
  return rows[0]!;
}

/**
 * Flip the parent project's status to `'abgerechnet'` inside the
 * issuance transaction. NO separate `mutate()` call: per ADR-0026 the
 * project status flip is a side-effect of the issuance, not its own
 * audit event. The invoice audit row's ancestor pair surfaces the
 * change under the project's activity feed.
 */
export async function flipParentProjectStatusToAbgerechnet(
  tx: MutatingDatabase,
  projectId: string,
  userId: string,
  when: Date,
): Promise<void> {
  await tx
    .update(projects)
    .set({
      status: 'abgerechnet',
      statusChangedAt: when,
      updatedAt: when,
      updatedBy: userId,
    })
    .where(eq(projects.id, projectId));
}

/**
 * Fields for inserting a Storno (cancellation) sibling row. The service
 * snapshots issuer/recipient/taxMode/profile/performanceDate from the
 * original byte-for-byte (AC-290), negates the lines, re-derives totals,
 * and pre-allocates a number from the `(year, 'storno')` sequence. The
 * descriptor id comes from a separate render+persist that ran earlier
 * in the cancel atom (same immutability-trigger reason as issuance:
 * INSERT-then-UPDATE-descriptor is blocked).
 */
export interface InsertStornoInvoiceFields {
  id: string;
  projectId: string;
  number: string;
  issueDate: Date;
  performanceDate: Date | null;
  taxMode: typeof invoices.$inferInsert.taxMode;
  profile: typeof invoices.$inferInsert.profile;
  issuer: typeof invoices.$inferInsert.issuer;
  recipient: typeof invoices.$inferInsert.recipient;
  lines: typeof invoices.$inferInsert.lines;
  totals: typeof invoices.$inferInsert.totals;
  cancellationOf: string;
  cancellationReason: string | null;
  renderedPdfBinaryDescriptorId: string;
  createdBy: string;
  updatedBy: string;
}

/**
 * INSERT a Storno (cancellation) sibling row at `status='issued'`. The
 * service has resolved every snapshotted field; this just writes the
 * row and returns it for the audit `after` payload.
 */
export async function insertStornoInvoice(
  tx: MutatingDatabase,
  fields: InsertStornoInvoiceFields,
): Promise<InvoiceRow> {
  const rows = await tx
    .insert(invoices)
    .values({
      id: fields.id,
      projectId: fields.projectId,
      status: 'issued',
      number: fields.number,
      issueDate: fields.issueDate,
      performanceDate: fields.performanceDate,
      taxMode: fields.taxMode,
      profile: fields.profile,
      issuer: fields.issuer,
      recipient: fields.recipient,
      lines: fields.lines,
      totals: fields.totals,
      cancellationOf: fields.cancellationOf,
      cancellationReason: fields.cancellationReason,
      renderedPdfBinaryDescriptorId: fields.renderedPdfBinaryDescriptorId,
      createdBy: fields.createdBy,
      updatedBy: fields.updatedBy,
    })
    .returning();
  return rows[0]!;
}

/**
 * Flip an original from `'issued'` to `'cancelled'` inside the cancel
 * atom. The DB-level immutability backstop (Phase A schema trigger)
 * allows exactly this one transition; touching any other column on an
 * issued row fails the constraint. `cancellation_reason` is deliberately
 * NOT written on the original — the reason is frozen on the Storno only
 * (per the brief).
 */
export async function applyCancellationFlip(
  tx: MutatingDatabase,
  id: string,
  userId: string,
  when: Date,
): Promise<InvoiceRow> {
  const rows = await tx
    .update(invoices)
    .set({
      status: 'cancelled',
      updatedAt: when,
      updatedBy: userId,
    })
    .where(eq(invoices.id, id))
    .returning();
  return rows[0]!;
}
