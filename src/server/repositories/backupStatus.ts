/**
 * BackupStatus repository.
 *
 * Wraps read/write access to the single-row `meta_backup_status` table
 * (data-model.md §5.9, ADR-0020). The row is pre-seeded by the baseline
 * migration so callers never have to distinguish "first write" from
 * "nth write" — every mutation is an upsert on the fixed `singleton`
 * primary key.
 *
 * Architecture layering (architecture.md §11.2): repositories touch the
 * DB directly. The backup service orchestrates and never reaches here
 * except through these functions.
 */

import { sql, eq } from 'drizzle-orm';
import type { Database, TransactionalDatabase } from '../db/connection.js';
import { metaBackupStatus } from '../db/schema.js';
import type { BackupStatus } from '../../domain/backupBadge.js';

// Re-export so consumers under `server/*` can import the canonical type
// from a single location without reaching into `domain/*`.
export type { BackupStatus } from '../../domain/backupBadge.js';

/**
 * Patch shape accepted by `updateBackupStatus`. The service passes only
 * the fields it needs to mutate; `updatedAt` is set server-side on every
 * write (§5.9 "managed by the server") and is therefore never accepted
 * from callers. A `Partial<BackupStatus>` that explicitly excludes
 * `updatedAt` prevents a subtle bug where a caller forwards a stale
 * timestamp from an earlier read.
 *
 * Nullable fields (`lastBackupAt`, `lastBackupError`, `lastDrillAt`,
 * `lastDrillOk`, `lastDrillError`) accept `null` explicitly so a caller can distinguish
 * "clear this field" from "omit this field" (the latter leaves the
 * column untouched). See `updateBackupStatus`.
 */
export interface BackupStatusPatch {
  lastBackupAt?: string | null;
  lastBackupOk?: boolean;
  lastBackupError?: string | null;
  lastDrillAt?: string | null;
  lastDrillOk?: boolean | null;
  lastDrillError?: string | null;
}

/**
 * Read the singleton `meta_backup_status` row. The row is guaranteed to
 * exist after the baseline migration; returning `null` would be a
 * programmer error, so we throw instead of papering over it.
 */
export async function getBackupStatus(db: TransactionalDatabase): Promise<BackupStatus> {
  const rows = await db.select().from(metaBackupStatus).limit(1);
  const row = rows[0];
  if (!row) {
    // If this ever fires, the baseline migration did not run on this database.
    throw new Error('meta_backup_status row missing — baseline migration did not execute');
  }
  return rowToStatus(row);
}

/**
 * Partial upsert on the singleton row. `updatedAt` is server-generated
 * (data-model.md §5.9). `null` is a valid, explicit value for nullable
 * columns (the error fields, `lastDrillOk`) — the patch differentiates
 * "omit this field" (no key) from "clear this field" (key set to null).
 *
 * Returns the row as written, so a caller mirroring it (AC-169) gets
 * exactly these values rather than a later read that a concurrent
 * writer could have changed.
 */
export async function updateBackupStatus(
  db: TransactionalDatabase,
  patch: BackupStatusPatch,
): Promise<BackupStatus> {
  // Build the SET clause explicitly so we only touch the columns the
  // caller asked about — a plain spread would turn `undefined` into
  // "write NULL to this column" via Drizzle's insert path and erase
  // a drill timestamp when the caller only meant to update backup fields.
  //
  // Drizzle's `timestamp` column mapper calls `toISOString()` on the
  // incoming value, so we convert ISO strings to Date here. Passing a
  // raw string would break the mapper with "value.toISOString is not a
  // function". Accepting strings in the patch shape keeps callers on
  // the standard api.md timestamp representation.
  const setClause: Record<string, unknown> = {
    updatedAt: new Date(),
  };
  if ('lastBackupAt' in patch) setClause.lastBackupAt = toDateOrNull(patch.lastBackupAt);
  if ('lastBackupOk' in patch && patch.lastBackupOk !== undefined) {
    setClause.lastBackupOk = patch.lastBackupOk;
  }
  if ('lastBackupError' in patch) setClause.lastBackupError = patch.lastBackupError ?? null;
  if ('lastDrillAt' in patch) setClause.lastDrillAt = toDateOrNull(patch.lastDrillAt);
  if ('lastDrillOk' in patch) setClause.lastDrillOk = patch.lastDrillOk ?? null;
  if ('lastDrillError' in patch) setClause.lastDrillError = patch.lastDrillError ?? null;

  const rows = await db
    .update(metaBackupStatus)
    .set(setClause)
    .where(eq(metaBackupStatus.singleton, true))
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error('meta_backup_status row missing — baseline migration did not execute');
  }
  return rowToStatus(row);
}

/**
 * Explicit helper for initializing or re-initializing the row if it is
 * ever missing — used as a safety net so tests can wipe and re-run
 * without reaching into the migration file.
 */
export async function ensureBackupStatusRow(db: Database): Promise<void> {
  await db.execute(sql`
    INSERT INTO meta_backup_status (singleton, last_backup_ok)
    VALUES (TRUE, FALSE)
    ON CONFLICT (singleton) DO NOTHING
  `);
}

type MetaBackupStatusRow = typeof metaBackupStatus.$inferSelect;

function rowToStatus(row: MetaBackupStatusRow): BackupStatus {
  return {
    lastBackupAt: row.lastBackupAt ? row.lastBackupAt.toISOString() : undefined,
    lastBackupOk: row.lastBackupOk,
    lastBackupError: row.lastBackupError ?? undefined,
    lastDrillAt: row.lastDrillAt ? row.lastDrillAt.toISOString() : undefined,
    lastDrillOk: row.lastDrillOk,
    lastDrillError: row.lastDrillError ?? undefined,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDateOrNull(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  return new Date(value);
}
