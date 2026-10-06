/**
 * Invoice trigger — architecture.md §11.10 "Invoice trigger", AC-372.
 *
 * The `backup` service polls every minute; this decides whether a poll
 * starts a regular backup run. Due while a backup-pending invoice mark
 * stands — except within the retry delay after a failed run, so a
 * persistently failing backup does not spin up an ephemeral Postgres
 * every minute. The no-overlap guard lives in the runner.
 */

import type { Database } from '../db/connection.js';
import { getBackupStatus } from '../repositories/backupStatus.js';
import { hasInvoiceBackupMarks } from '../repositories/invoiceBackupPending.js';

export interface InvoiceTriggerInput {
  hasMarks: boolean;
  /** The last recorded backup run, or null when none has been recorded. */
  lastBackup: { ok: boolean; at: Date } | null;
  now: Date;
  retryMinutes: number;
}

export function isInvoiceTriggerDue(input: InvoiceTriggerInput): boolean {
  if (!input.hasMarks) return false;
  const { lastBackup } = input;
  if (!lastBackup || lastBackup.ok) return true;
  return input.now.getTime() - lastBackup.at.getTime() >= input.retryMinutes * 60_000;
}

/** `isInvoiceTriggerDue` over the live marks and status row. */
export async function invoiceTriggerDue(
  db: Database,
  opts: { now: Date; retryMinutes: number },
): Promise<boolean> {
  const hasMarks = await hasInvoiceBackupMarks(db);
  if (!hasMarks) return false;
  const status = await getBackupStatus(db);
  const lastBackup =
    status.lastBackupAt === undefined
      ? null
      : { ok: status.lastBackupOk, at: new Date(status.lastBackupAt) };
  return isInvoiceTriggerDue({
    hasMarks,
    lastBackup,
    now: opts.now,
    retryMinutes: opts.retryMinutes,
  });
}
