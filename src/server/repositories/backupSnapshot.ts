/**
 * Backup snapshot repository — the database reads of the backup pipeline
 * (ADR-0020). The pipeline's orchestration, and the reasons behind each
 * setting, stay in `services/backup.ts`.
 *
 * Each function returns what its query returned: `undefined` when the
 * query yielded no row.
 */

import { sql } from 'drizzle-orm';
import type { Database, TransactionalDatabase, TxHandle } from '../db/connection.js';

/** `COUNT(*)` of one table. */
export async function countTableRows(
  db: TransactionalDatabase,
  table: string,
): Promise<number | undefined> {
  const result = await db.execute(sql.raw(`SELECT COUNT(*)::int AS c FROM "${table}"`));
  return (result.rows[0] as { c: number } | undefined)?.c;
}

/**
 * The ADR-0020 canonical checksum of one table:
 * `md5(string_agg(md5(row(t.*)::text), '' ORDER BY <pk>))`, the empty
 * string for an empty table.
 */
export async function checksumTable(
  db: TransactionalDatabase,
  table: string,
  pkColumns: readonly string[],
): Promise<string | undefined> {
  const orderBy = pkColumns.map((c) => `"${c}"`).join(', ');
  const result = await db.execute(
    sql.raw(
      `SELECT md5(COALESCE(string_agg(md5(row(t.*)::text), '' ORDER BY ${orderBy}), '')) AS checksum ` +
        `FROM "${table}" t`,
    ),
  );
  return (result.rows[0] as { checksum: string } | undefined)?.checksum;
}

/** `SET LOCAL TIME ZONE 'UTC'`: this transaction only. */
export async function setLocalTimeZoneUtc(tx: TxHandle): Promise<void> {
  await tx.execute(sql`SET LOCAL TIME ZONE 'UTC'`);
}

/** `lock_timeout` and `statement_timeout` for this transaction only. */
export async function setLocalTimeouts(
  tx: TxHandle,
  lockTimeoutMs: number,
  statementTimeoutMs: number,
): Promise<void> {
  await tx.execute(sql`SELECT set_config('lock_timeout', ${String(lockTimeoutMs)}, true)`);
  await tx.execute(
    sql`SELECT set_config('statement_timeout', ${String(statementTimeoutMs)}, true)`,
  );
}

/** `pg_export_snapshot()`: the id of this transaction's snapshot. */
export async function exportSnapshot(tx: TxHandle): Promise<string | undefined> {
  const result = await tx.execute(sql`SELECT pg_export_snapshot() AS id`);
  return (result.rows[0] as { id: string } | undefined)?.id;
}

/** The cluster's `data_checksums` setting: `on` or `off`. */
export async function showDataChecksums(db: Database): Promise<string | undefined> {
  const result = await db.execute<{ data_checksums: string }>(sql`SHOW data_checksums`);
  return result.rows[0]?.data_checksums;
}
