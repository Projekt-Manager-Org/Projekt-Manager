/**
 * Invoice backup-pending marks (data-model.md §5.15, architecture.md
 * §11.14 "Backup gate", ADR-0026).
 *
 * A mark withholds an issued row's PDF until an off-site backup holds
 * the row. The issuance / cancellation transaction writes it; the
 * `backup` service releases it; the app reads it for the gate, the
 * release watch and the overdue alert.
 */

import { count, eq, inArray, min, sql, type SQL } from 'drizzle-orm';
import type { Database, MutatingDatabase, TransactionalDatabase } from '../db/connection.js';
import { invoiceBackupPending, invoices } from '../db/schema.js';

/** Select expression: true iff the selected `invoices` row is marked. */
export const invoiceBackupPendingColumn: SQL<boolean> = sql<boolean>`EXISTS (
  SELECT 1 FROM ${invoiceBackupPending}
  WHERE ${invoiceBackupPending.invoiceId} = ${invoices.id}
)`.mapWith(Boolean);

/** Mark a freshly issued row inside its issuance / cancellation transaction. */
export async function markInvoiceBackupPending(
  tx: MutatingDatabase,
  invoiceId: string,
): Promise<void> {
  await tx.insert(invoiceBackupPending).values({ invoiceId });
}

/** Whether the given row is marked. */
export async function isInvoiceBackupPending(
  db: TransactionalDatabase,
  invoiceId: string,
): Promise<boolean> {
  const rows = await db
    .select({ invoiceId: invoiceBackupPending.invoiceId })
    .from(invoiceBackupPending)
    .where(eq(invoiceBackupPending.invoiceId, invoiceId));
  return rows.length > 0;
}

/** Ids of every standing mark. */
export async function listInvoiceBackupPendingIds(db: TransactionalDatabase): Promise<string[]> {
  const rows = await db
    .select({ invoiceId: invoiceBackupPending.invoiceId })
    .from(invoiceBackupPending);
  return rows.map((r) => r.invoiceId);
}

/** Whether any mark stands. */
export async function hasInvoiceBackupMarks(db: TransactionalDatabase): Promise<boolean> {
  const rows = await db.select({ value: count() }).from(invoiceBackupPending);
  return (rows[0]?.value ?? 0) > 0;
}

/** Creation time of the oldest standing mark, or null when none stands. */
export async function oldestInvoiceBackupMarkAt(db: TransactionalDatabase): Promise<Date | null> {
  const rows = await db
    .select({ value: min(invoiceBackupPending.createdAt) })
    .from(invoiceBackupPending);
  return rows[0]?.value ?? null;
}

/**
 * Release the given marks. A backup run passes the ids its snapshot
 * held: an invoice is marked at most once, so a mark committed after
 * the snapshot is never among them.
 */
export async function releaseInvoiceBackupMarks(db: Database, invoiceIds: string[]): Promise<void> {
  if (invoiceIds.length === 0) return;
  await db.delete(invoiceBackupPending).where(inArray(invoiceBackupPending.invoiceId, invoiceIds));
}

/** Drop every standing mark. Returns how many were dropped. */
export async function dropAllInvoiceBackupMarks(db: Database): Promise<number> {
  const rows = await db
    .delete(invoiceBackupPending)
    .returning({ invoiceId: invoiceBackupPending.invoiceId });
  return rows.length;
}
