/**
 * Data-exchange job boot reconciliation — data-model.md §5.18, api.md
 * §14.2.4 ("Jobs — one active per kind").
 *
 * Export/import jobs run in-process (ADR-0021) and their build/restore is
 * fire-and-forget — a process restart abandons any job left `pending` or
 * `running`. Left untouched, such a row keeps the one-active-per-kind slot
 * occupied forever: every later create returns `409 *_JOB_ACTIVE`, bricking
 * the feature with no API recovery path. On boot we mark every abandoned job
 * `failed` (freeing the slot — the operator retries) and delete its
 * partially-staged plaintext archive: a crash leaves a half-written
 * `<jobId>.zip` on the VPS-local staging path, and the TTL reaper only sweeps
 * `ready` artifacts (`archive_ref IS NOT NULL`), so without this the partial
 * plaintext superset (all business data + every `passwordHash`) would persist
 * past the staging TTL.
 *
 * One-shot: run after `migrate` and before `app.listen`, parity with the boot
 * session cleanup (`deleteExpiredSessions`). NOT a scheduled sweep — a job can
 * only be abandoned by a restart, so boot is the only moment it occurs.
 *
 * Operational-log contract mirrors the staging reaper (§6.14): exactly one
 * info line with `event`, `reaped_count` (non-negative; 0 on no-op), `ran_at`
 * (ISO 8601). A per-file unlink fault is logged on the error channel and the
 * row stays `failed` — the slot-freeing UPDATE is the load-bearing effect; a
 * leftover file is a lesser concern the TTL reaper would otherwise own.
 */

import { rm } from 'node:fs/promises';
import path from 'node:path';
import { inArray } from 'drizzle-orm';

import type { Database } from '../db/connection.js';
import { dataExchangeJob } from '../db/schema.js';
import type { ServiceLogger } from './Logger.js';

export const EVENT_DATA_EXCHANGE_BOOT_REAPER = 'data-exchange-boot-reaper';

/** Operator-facing reason stamped on a boot-reaped job's `error_detail`. */
export const BOOT_REAP_DETAIL = 'reaped on boot: process restart abandoned the job';

export interface ReapAbandonedDataExchangeJobsDeps {
  db: Database;
  /** VPS-local staging directory (TAKEOUT_STAGING_DIR) — partial archives live here. */
  stagingDir: string;
  logger: ServiceLogger;
}

/**
 * Mark every `pending`/`running` data-exchange job (export AND import)
 * `failed` and delete its partially-staged archive. Returns the count
 * reaped. Idempotent: a second run finds no abandoned rows and is a no-op.
 */
export async function reapAbandonedDataExchangeJobs(
  deps: ReapAbandonedDataExchangeJobsDeps,
): Promise<number> {
  const now = new Date();
  const reaped = await deps.db
    .update(dataExchangeJob)
    .set({ status: 'failed', errorDetail: BOOT_REAP_DETAIL, finishedAt: now, updatedAt: now })
    .where(inArray(dataExchangeJob.status, ['pending', 'running']))
    .returning({ id: dataExchangeJob.id });

  for (const job of reaped) {
    // Staged archive name is deterministic (`<jobId>.zip`). A pending job
    // may have written no file yet; a running one may have a partial. The
    // archive_ref column is unset on a failed row, so the path is rebuilt
    // from the job id rather than read back. `force: true` makes the
    // absent-file case a no-op.
    const stagedPath = path.join(deps.stagingDir, `${job.id}.zip`);
    try {
      await rm(stagedPath, { force: true });
    } catch (err) {
      deps.logger.error(
        {
          event: EVENT_DATA_EXCHANGE_BOOT_REAPER,
          error_hint: err instanceof Error ? err.message : String(err),
          path: stagedPath,
        },
        EVENT_DATA_EXCHANGE_BOOT_REAPER,
      );
    }
  }

  deps.logger.info(
    {
      event: EVENT_DATA_EXCHANGE_BOOT_REAPER,
      reaped_count: reaped.length,
      ran_at: now.toISOString(),
    },
    EVENT_DATA_EXCHANGE_BOOT_REAPER,
  );
  return reaped.length;
}
