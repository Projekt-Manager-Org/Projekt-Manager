/**
 * Shared helpers for VPS-local takeout staging artifacts: the staged-file
 * path convention (`stagedArtifactPath`) and the sweep (`sweepStagedArtifact`).
 *
 * `sweepStagedArtifact` is used at two call sites:
 *   1. Create-time pre-sweep on POST /api/export-jobs and POST /api/import-jobs:
 *      before minting a new job, clear prior staged artifacts of the same kind
 *      so files do not accumulate between back-to-back jobs.
 *   2. TTL reaper (takeout-staging-reaper.ts): scheduled sweep of aged artifacts.
 *
 * Both paths call `sweepStagedArtifact` — the logic is identical.
 *
 * Design notes (AC-589 / ADR-0024):
 *   - `force: true` on rm swallows ENOENT — a file already missing (reaper
 *     won the race, OS crash, etc.) is a no-op, not a fault.
 *   - `archive_ref` is nulled regardless of whether the file delete succeeded.
 *     Metadata-cleanliness (so the download surface 404s) trumps a missing
 *     backing file — same posture as the attachment orphan reaper.
 *   - The sweep is not a lifecycle transition (status stays), so it bypasses
 *     DataExchangeJobService, but it does change what the client shows: the
 *     job's archive is no longer available (AC-608). It emits the
 *     invalidation frame so an open Daten view refetches.
 */

import { rm } from 'node:fs/promises';
import path from 'node:path';

import type { Database } from '../db/connection.js';
import { updateDataExchangeJob } from '../repositories/dataExchangeJob.js';
import { emitDataExchangeJobChanged } from '../sse/emitters.js';
import type { ServiceLogger } from './Logger.js';

export const EVENT_TAKEOUT_SWEEP = 'takeout-staged-sweep';

/**
 * Absolute path of a job's staged artifact, by kind — the single source of
 * the staged-file naming convention (was hand-built in the import-jobs route,
 * the boot reaper, and the export builder). The two kinds use distinct names
 * so a back-to-back export+import never collide on disk:
 *   - export → `<jobId>.zip`        (the builder's finished archive)
 *   - import → `import-<jobId>.zip` (the resumable upload target)
 * Rebuildable from (kind, id) alone — callers holding only the row id (boot
 * reaper, create-time pre-sweep) need no `archive_ref`, which is null on a
 * pending row.
 */
export function stagedArtifactPath(
  stagingDir: string,
  kind: 'export' | 'import',
  jobId: string,
): string {
  return path.join(stagingDir, kind === 'import' ? `import-${jobId}.zip` : `${jobId}.zip`);
}

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
  // metadata. The client now sees `archiveAvailable: false` (AC-608).
  await updateDataExchangeJob(db, job.id, { archiveRef: null, updatedAt: new Date() });
  emitDataExchangeJobChanged();
}
