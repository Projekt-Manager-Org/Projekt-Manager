/**
 * Takeout staging reaper — ADR-0018 / ADR-0024, data-model.md §6.15,
 * AC-334.
 *
 * Sweeps staged full-account takeout archives off the VPS-local staging
 * path once they age past the takeout staging TTL:
 *
 *   - `ready` EXPORT jobs whose `finished_at` is older than `now - ttlMinutes`
 *     and whose `archive_ref` is non-null.
 *   - Terminal (`ready` OR `failed`) IMPORT jobs with the same age predicate
 *     and a non-null `archive_ref`. Abandoned `pending`/`running` imports are
 *     flipped to `failed` by the boot reaper first and then swept here.
 *
 * `archive_ref` is nulled after the staged file is deleted — the row
 * PERSISTS as operational metadata so the download surface resolves the
 * swept artifact to `404` rather than a missing-job `404`.
 *
 * `finished_at` is the staging clock: it is the moment the job reached its
 * terminal state (the test backdates `finished_at` to exercise this).
 *
 * Operational-log contract (mirrors attachment-orphan-reaper.ts §6.11):
 * exactly one info line per run with fields `event`, `ttl_minutes`,
 * `removed_count` (non-negative; 0 on no-op), `ran_at` (ISO 8601). A
 * file delete that fails (already gone, transient FS error) is logged on
 * the error channel and the `archive_ref` is still nulled — the
 * metadata-cleanliness goal trumps a missing backing file, parity with
 * the orphan reaper's storage-delete posture.
 */

import { rm } from 'node:fs/promises';
import { and, eq, inArray, isNotNull, lt, or } from 'drizzle-orm';

import type { Database } from '../db/connection.js';
import { dataExchangeJob } from '../db/schema.js';
import type { AttachmentStorageClient } from '../storage/client.js';
import type { ServiceLogger } from './Logger.js';

const MS_PER_MINUTE = 60 * 1000;

export const EVENT_TAKEOUT_STAGING_REAPER = 'takeout-staging-reaper';

export interface RunTakeoutStagingReaperDeps {
  db: Database;
  /**
   * Storage client — part of the contract surface for parity with the
   * other reapers (AC-334 test). Staged takeout archives live on a
   * VPS-local filesystem path, not on object storage (ADR-0024:
   * plaintext stages only inside the trust radius), so the sweep deletes
   * a file rather than a storage key; the client is unused today but kept
   * on the signature so a future staging-on-storage variant slots in
   * without a signature change.
   */
  storage: AttachmentStorageClient;
  logger: ServiceLogger;
  ttlMinutes: number;
  /**
   * Injectable wall clock. Production omits; tests supply so a backdated
   * `finished_at` fixture behaves deterministically regardless of clock
   * skew (mirrors the orphan reaper).
   */
  now?: Date;
}

export async function runTakeoutStagingReaper(deps: RunTakeoutStagingReaperDeps): Promise<void> {
  if (!Number.isInteger(deps.ttlMinutes) || deps.ttlMinutes <= 0) {
    throw new Error(
      `runTakeoutStagingReaper: ttlMinutes must be a positive integer, got ${deps.ttlMinutes}`,
    );
  }
  void deps.storage; // contract-surface dependency; see RunTakeoutStagingReaperDeps.

  const runAt = deps.now ?? new Date();
  const cutoff = new Date(runAt.getTime() - deps.ttlMinutes * MS_PER_MINUTE);

  // Select aged terminal artifacts with a non-null archiveRef:
  //   - export jobs: status='ready' (exports only reach ready when built)
  //   - import jobs: status IN ('ready','failed') (a failed import may have
  //     an archiveRef if the upload completed before processing failed; a
  //     ready import always has one set by the runner)
  // The DELETE-of-file follows the SELECT and the archive_ref null is the
  // authoritative "swept" signal; a file-delete fault cannot revive the ref.
  const aged = await deps.db
    .select({ id: dataExchangeJob.id, archiveRef: dataExchangeJob.archiveRef })
    .from(dataExchangeJob)
    .where(
      and(
        or(
          // export: only ever ready when it has an archive
          and(eq(dataExchangeJob.kind, 'export'), eq(dataExchangeJob.status, 'ready')),
          // import: both terminal states can carry an archiveRef
          and(
            eq(dataExchangeJob.kind, 'import'),
            inArray(dataExchangeJob.status, ['ready', 'failed']),
          ),
        ),
        isNotNull(dataExchangeJob.archiveRef),
        lt(dataExchangeJob.finishedAt, cutoff),
      ),
    );

  for (const job of aged) {
    if (job.archiveRef) {
      await bestEffortRemoveFile(job.archiveRef, deps.logger);
    }
    // Null the reference + bump updatedAt; the row stays as operational
    // metadata. NOT routed through the job service's emitter — a reap is
    // not a lifecycle transition the UI re-attaches to.
    await deps.db
      .update(dataExchangeJob)
      .set({ archiveRef: null, updatedAt: new Date() })
      .where(eq(dataExchangeJob.id, job.id));
  }

  deps.logger.info(
    {
      event: EVENT_TAKEOUT_STAGING_REAPER,
      ttl_minutes: deps.ttlMinutes,
      removed_count: aged.length,
      ran_at: runAt.toISOString(),
    },
    EVENT_TAKEOUT_STAGING_REAPER,
  );
}

async function bestEffortRemoveFile(filePath: string, logger: ServiceLogger): Promise<void> {
  try {
    // `force: true` swallows ENOENT — an already-missing staged file is a
    // no-op, not a fault. Other FS errors fall to the catch below.
    await rm(filePath, { force: true });
  } catch (err) {
    logger.error(
      {
        event: EVENT_TAKEOUT_STAGING_REAPER,
        error_hint: err instanceof Error ? err.message : String(err),
        path: filePath,
      },
      EVENT_TAKEOUT_STAGING_REAPER,
    );
  }
}
