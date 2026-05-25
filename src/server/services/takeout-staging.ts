/**
 * Shared sweep helper for VPS-local takeout staging artifacts.
 *
 * Used at two call sites:
 *   1. Create-time pre-sweep on POST /api/export-jobs and POST /api/import-jobs:
 *      before minting a new job, clear prior staged artifacts of the same kind
 *      so files do not accumulate between back-to-back jobs.
 *   2. TTL reaper (takeout-staging-reaper.ts): scheduled sweep of aged artifacts.
 *
 * Both paths call `sweepStagedArtifact` — the logic is identical.
 *
 * Design notes (data-model.md §6.15 / ADR-0024):
 *   - `force: true` on rm swallows ENOENT — a file already missing (reaper
 *     won the race, OS crash, etc.) is a no-op, not a fault.
 *   - `archive_ref` is nulled regardless of whether the file delete succeeded.
 *     Metadata-cleanliness (so the download surface 404s) trumps a missing
 *     backing file — same posture as the attachment orphan reaper.
 *   - NOT routed through DataExchangeJobService's SSE emitter: a sweep is not
 *     a lifecycle transition the UI re-attaches to; the reaper deliberately
 *     does a bare DB update, and this helper matches that.
 */

import { rm } from 'node:fs/promises';
import { eq } from 'drizzle-orm';

import type { Database } from '../db/connection.js';
import { dataExchangeJob } from '../db/schema.js';
import type { ServiceLogger } from './Logger.js';

export const EVENT_TAKEOUT_SWEEP = 'takeout-staged-sweep';

/**
 * Delete the staged file (best-effort) and null `archive_ref` + bump
 * `updatedAt`. The row persists as operational metadata so the download
 * endpoint 404s the artifact rather than returning a missing-job 404.
 */
export async function sweepStagedArtifact(
  db: Database,
  job: { id: string; archiveRef: string },
  logger: ServiceLogger,
): Promise<void> {
  try {
    // `force: true` swallows ENOENT — an already-missing staged file is a
    // no-op, not a fault. Other FS errors fall to the catch below.
    await rm(job.archiveRef, { force: true });
  } catch (err) {
    logger.error(
      {
        event: EVENT_TAKEOUT_SWEEP,
        error_hint: err instanceof Error ? err.message : String(err),
        path: job.archiveRef,
        job_id: job.id,
      },
      EVENT_TAKEOUT_SWEEP,
    );
  }

  // Null the reference + bump updatedAt; the row stays as operational
  // metadata. NOT routed through the job service's emitter — a sweep is
  // not a lifecycle transition the UI re-attaches to.
  await db
    .update(dataExchangeJob)
    .set({ archiveRef: null, updatedAt: new Date() })
    .where(eq(dataExchangeJob.id, job.id));
}
