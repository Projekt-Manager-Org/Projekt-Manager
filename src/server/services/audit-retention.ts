/**
 * Audit-log retention cleanup — AC-632.
 *
 * Removes `audit_log` rows older than the configured rolling window
 * (90 days [C] by default). This is the only production path that
 * deletes from `audit_log` (AC-642); the audit_log triggers reject
 * any other.
 *
 * Contract with operators (AC-633):
 *   - Emits exactly one structured operational log line per run, at
 *     `info` level, with fields `event`, `window_days`, `removed_count`
 *     (non-negative integer; 0 on a no-op), and `ran_at` (ISO 8601).
 *   - Does NOT itself produce an `audit_log` row — scope is domain
 *     entities only (data-model.md §5.10).
 *
 * Concurrency: a single `DELETE WHERE created_at < :cutoff` runs under
 * Postgres default isolation (READ COMMITTED). Rows inserted after the
 * cutoff is computed are not eligible for this run; they roll into the
 * next run. The DELETE runs in its own transaction only so the
 * removal allowance stays local to it (`withAuditLogRemoval`); it is
 * still self-contained and idempotent.
 *
 * Dependency-injected logger: the service accepts the logger at call
 * time rather than reading from module state so
 *   (a) tests can assert exactly one call against a spy, and
 *   (b) the scheduler wires in the same `ServiceLogger` surface other
 *       services already accept (see `src/server/services/Logger.ts`).
 */

import { lt } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import { auditLog } from '../db/schema.js';
import { withAuditLogRemoval } from '../db/auditLogRemoval.js';
import type { ServiceLogger } from './Logger.js';

export interface RunAuditRetentionCleanupDeps {
  db: Database;
  logger: ServiceLogger;
  /** Retention window in days; rows with `created_at < now - windowDays` are deleted. */
  windowDays: number;
  /**
   * Wall clock for the run. Injection-only — production callers omit
   * it and get `new Date()`. Tests supply an explicit `now` so fixture
   * rows aged against `now - windowDays` behave deterministically
   * regardless of the test machine's clock skew against the DB.
   */
  now?: Date;
}

export interface AuditRetentionCleanupResult {
  /** Number of rows deleted. Non-negative; 0 on a no-op run. */
  removedCount: number;
  /** Cutoff applied to `audit_log.created_at`. Rows with `created_at < cutoff` were deleted. */
  cutoff: Date;
  /** ISO 8601 timestamp emitted in the operational log line. */
  ranAt: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * AC-633 pins this exact event discriminator — operators grep the
 * operational log for it. Exported so the scheduler (and tests) can
 * reference the same literal without drift.
 */
export const EVENT_RETENTION_CLEANUP = 'audit-retention-cleanup';

/**
 * Execute one retention sweep. Returns the applied cutoff, the number
 * of deleted rows, and the emitted `ran_at` so the scheduler (or a
 * test) can assert against it without re-reading the log line.
 *
 * @throws if `windowDays` is not a positive integer — an invalid window
 *   would corrupt the cutoff calculation (negative window would delete
 *   future rows). The scheduler catches and logs; tests surface the
 *   error directly.
 */
export async function runAuditRetentionCleanup(
  deps: RunAuditRetentionCleanupDeps,
): Promise<AuditRetentionCleanupResult> {
  if (!Number.isInteger(deps.windowDays) || deps.windowDays <= 0) {
    throw new Error(
      `runAuditRetentionCleanup: windowDays must be a positive integer, got ${deps.windowDays}`,
    );
  }

  const runAt = deps.now ?? new Date();
  const cutoff = new Date(runAt.getTime() - deps.windowDays * MS_PER_DAY);

  // The audit_log triggers accept the DELETE only under
  // `withAuditLogRemoval` (AC-642).
  const deleted = await withAuditLogRemoval(deps.db, (tx) =>
    tx.delete(auditLog).where(lt(auditLog.createdAt, cutoff)).returning({ id: auditLog.id }),
  );

  const removedCount = deleted.length;
  const ranAt = runAt.toISOString();

  // Exactly one structured log line per run (AC-633). Fields match the
  // contract (AC-633) — snake_case because this is an
  // operational-log field, not an API wire field.
  deps.logger.info(
    {
      event: EVENT_RETENTION_CLEANUP,
      window_days: deps.windowDays,
      removed_count: removedCount,
      ran_at: ranAt,
    },
    EVENT_RETENTION_CLEANUP,
  );

  return { removedCount, cutoff, ranAt };
}
