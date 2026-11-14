/**
 * Takeout staging reaper — ADR-0018 / ADR-0024, AC-589.
 *
 * Sweeps staged full-account takeout archives off the VPS-local staging
 * path once they age past the takeout staging TTL:
 *
 *   - `ready` EXPORT jobs whose `finished_at` is older than `now - ttlMinutes`
 *     and whose `archive_ref` is non-null.
 *   - Terminal (`ready` OR `failed`) IMPORT jobs with the same age predicate
 *     and a non-null `archive_ref`.
 *
 * It also ends a `pending` import whose upload made no progress for the TTL
 * (AC-599): `failed` with its audit row (AC-332), partial upload deleted. The
 * upload route bumps `updated_at` on every chunk, so it is the progress clock.
 *
 * `archive_ref` is nulled after the staged file is deleted — the row
 * PERSISTS as operational metadata so the download surface resolves the
 * swept artifact to `404` rather than a missing-job `404`.
 *
 * `finished_at` is the staging clock: it is the moment the job reached its
 * terminal state (the test backdates `finished_at` to exercise this).
 *
 * Operational-log contract (mirrors attachment-orphan-reaper.ts):
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
import { DataExchangeJobService } from './DataExchangeJobService.js';
import { stagedArtifactPath, sweepStagedArtifact } from './takeout-staging.js';

/** Operator-facing reason stamped on a stalled import's `error_detail`. */
export const STALLED_UPLOAD_DETAIL = 'upload stalled: no progress for the takeout staging TTL';

const MS_PER_MINUTE = 60 * 1000;

export const EVENT_TAKEOUT_STAGING_REAPER = 'takeout-staging-reaper';

export interface RunTakeoutStagingReaperDeps {
  db: Database;
  /**
   * Storage client — part of the contract surface for parity with the
   * other reapers (AC-589 test). Staged takeout archives live on a
   * VPS-local filesystem path, not on object storage (ADR-0024:
   * plaintext stages only inside the trust radius), so the sweep deletes
   * a file rather than a storage key; the client is unused today but kept
   * on the signature so a future staging-on-storage variant slots in
   * without a signature change.
   */
  storage: AttachmentStorageClient;
  /** VPS-local staging directory (TAKEOUT_STAGING_DIR) — a stalled upload's partial file lives here. */
  stagingDir: string;
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

  const stalled = await failStalledUploads(deps, cutoff);

  for (const job of aged) {
    if (job.archiveRef) {
      // Shared sweep helper: best-effort rm + null archive_ref, matching the
      // create-time pre-sweep so both call sites use the same code path.
      await sweepStagedArtifact(deps.db, { id: job.id, archiveRef: job.archiveRef }, deps.logger);
    }
  }

  deps.logger.info(
    {
      event: EVENT_TAKEOUT_STAGING_REAPER,
      ttl_minutes: deps.ttlMinutes,
      removed_count: aged.length + stalled,
      ran_at: runAt.toISOString(),
    },
    EVENT_TAKEOUT_STAGING_REAPER,
  );
}

/**
 * Fail every `pending` import whose last progress is older than `cutoff`, and
 * delete its partial upload. The age is re-checked in the flip itself, so a
 * chunk that lands meanwhile keeps the job. Returns the count failed.
 */
async function failStalledUploads(
  deps: RunTakeoutStagingReaperDeps,
  cutoff: Date,
): Promise<number> {
  const stillStalled = and(
    eq(dataExchangeJob.status, 'pending'),
    lt(dataExchangeJob.updatedAt, cutoff),
  )!;
  const candidates = await deps.db
    .select({ id: dataExchangeJob.id })
    .from(dataExchangeJob)
    .where(and(eq(dataExchangeJob.kind, 'import'), stillStalled));

  const jobs = new DataExchangeJobService(deps.db);
  let failed = 0;
  for (const { id } of candidates) {
    if (!(await jobs.failIfStill(id, 'import', STALLED_UPLOAD_DETAIL, stillStalled))) continue;
    failed += 1;
    const stagedPath = stagedArtifactPath(deps.stagingDir, 'import', id);
    try {
      await rm(stagedPath, { force: true });
    } catch (err) {
      deps.logger.error(
        {
          event: EVENT_TAKEOUT_STAGING_REAPER,
          error_hint: err instanceof Error ? err.message : String(err),
          path: stagedPath,
        },
        EVENT_TAKEOUT_STAGING_REAPER,
      );
    }
  }
  return failed;
}
