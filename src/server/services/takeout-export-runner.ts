/**
 * Full-account takeout EXPORT job runner — ADR-0018 / ADR-0024, api.md
 * §14.2.4 ("Export job — build and lifecycle"), data-model.md §5.18.
 *
 * Owns the asynchronous, fire-and-forget build a `POST /api/export-jobs`
 * kicks off: it advances the `data_exchange_job` row through
 * `pending → running → ready | failed` via `DataExchangeJobService`,
 * driving `buildExportArchive` in between.
 *
 * The EXACTLY ONE `audit_log` row at the terminal transition (AC-332) is
 * written by `markReady` / `markFailed` ATOMICALLY with the status flip —
 * the runner only supplies the job-kind-specific content (`export_built` /
 * `export_failed`, the German label, the counts). See
 * `DataExchangeJobService.TerminalAuditRow` for why this is folded into the
 * service's transaction rather than a second write here. Progress updates
 * write no audit rows and do not route through `mutate()`.
 *
 * The runner never throws — it runs detached from the originating
 * request (which already returned 201). A wholesale build fault is
 * recorded on the row (`failed` + `error_detail`) and the audit trail,
 * not surfaced to a caller.
 */

import { rm } from 'node:fs/promises';
import path from 'node:path';

import type { Database } from '../db/connection.js';
import type { AuthUser } from '../middleware/auth.js';
import type { AttachmentStorageClient } from '../storage/client.js';
import type { ServiceLogger } from './Logger.js';
import { DataExchangeJobService } from './DataExchangeJobService.js';
import { buildExportArchive } from './takeout-export-builder.js';

export interface RunExportBuildDeps {
  db: Database;
  jobs: DataExchangeJobService;
  storage: AttachmentStorageClient;
  caller: AuthUser;
  jobId: string;
  logger: ServiceLogger;
  /** Operator-loaded binary `age` recipient (public X25519 key). */
  binaryAgeRecipient: string;
  /** Tmpfs-resident path to the operator-loaded binary `age` private identity. */
  binaryAgeIdentityPath: string;
  /** VPS-local staging directory (TAKEOUT_STAGING_DIR). */
  stagingDir: string;
}

/**
 * Drive one export build to its terminal state. Advances
 * `pending → running`, builds the staged archive, then `→ ready` (or
 * `→ failed` on a wholesale fault), and writes the single terminal
 * `audit_log` row. Resolves once the job is terminal; never rejects.
 */
export async function runExportBuild(deps: RunExportBuildDeps): Promise<void> {
  const { db, jobs, storage, caller, jobId, logger } = deps;
  try {
    await jobs.markRunning(jobId);

    const result = await buildExportArchive({
      db,
      storage,
      logger,
      caller,
      binaryAgeRecipient: deps.binaryAgeRecipient,
      binaryAgeIdentityPath: deps.binaryAgeIdentityPath,
      stagingDir: deps.stagingDir,
      jobId,
      onProgress: async (p) => {
        // Throttling lives in the builder (≈1/s); this sink just forwards
        // the counters. `filesTotal`/`bytesTotal` ride every tick so the
        // readout shows both denominators from the first frame.
        // updateProgress emits a (throttled) invalidation frame and writes
        // NO audit row.
        await jobs.updateProgress(jobId, {
          filesTotal: p.filesTotal,
          bytesTotal: p.bytesTotal,
          filesDone: p.filesDone,
          bytesDone: p.bytesDone,
          currentItem: p.currentItem,
        });
      },
    });

    // Stamp the final totals, then flip to ready with the staged archive
    // location. markReady stamps finishedAt — the staging reaper's age
    // anchor (AC-334). Re-assert the terminal counts here so a throttled
    // frame that dropped the last increment cannot leave a stale readout.
    await jobs.updateProgress(jobId, {
      filesTotal: result.filesTotal,
      bytesTotal: result.bytesTotal,
      filesDone: result.filesDone,
      bytesDone: result.bytesDone,
      currentItem: null,
    });
    await jobs.markReady(jobId, result.archiveRef, {
      action: 'export_built',
      entityLabel: 'Export erstellt',
      payload: {
        filesTotal: result.filesTotal,
        filesDone: result.filesDone,
        bytesDone: result.bytesDone,
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error(
      { event: 'takeout-export-build-failed', jobId, error_hint: detail },
      'takeout-export-build-failed',
    );
    try {
      await jobs.markFailed(jobId, detail, {
        action: 'export_failed',
        entityLabel: 'Export fehlgeschlagen',
        payload: { error: detail },
      });
    } catch (innerErr) {
      // Last-resort: the row could not be moved to failed (e.g. it was
      // deleted). Log and give up — there is no caller to surface this to.
      logger.error(
        {
          event: 'takeout-export-mark-failed-error',
          jobId,
          error_hint: innerErr instanceof Error ? innerErr.message : String(innerErr),
        },
        'takeout-export-mark-failed-error',
      );
    }
    // Best-effort: remove any partially-staged plaintext archive the failed
    // build left on disk. `archiveRef` is unset on a failed row, so the TTL
    // reaper (which sweeps ready rows by `archive_ref`) would never reclaim
    // it — without this the partial plaintext would persist past the TTL.
    // The staged name is deterministic (`<jobId>.zip`).
    try {
      await rm(path.join(deps.stagingDir, `${jobId}.zip`), { force: true });
    } catch (rmErr) {
      logger.error(
        {
          event: 'takeout-export-staged-cleanup-failed',
          jobId,
          error_hint: rmErr instanceof Error ? rmErr.message : String(rmErr),
        },
        'takeout-export-staged-cleanup-failed',
      );
    }
  }
}
