/**
 * The one way to remove `audit_log` rows (AC-642).
 *
 * The triggers in `baseline/tail/60-audit-log-append-only.sql` reject
 * DELETE and TRUNCATE unless the transaction set `pm.audit_log_removal`. This opens
 * that transaction: the setting is transaction-local, so it ends with
 * `fn` and never sticks to a pooled connection.
 *
 * Callers: retention (AC-632), the dev seed's wipe, test fixtures.
 */

import { sql } from 'drizzle-orm';
import type { Database, TxHandle } from './connection.js';

export async function withAuditLogRemoval<T>(
  db: Database,
  fn: (tx: TxHandle) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('pm.audit_log_removal', 'on', true)`);
    return fn(tx);
  });
}
