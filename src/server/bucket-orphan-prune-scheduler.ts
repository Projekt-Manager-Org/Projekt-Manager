/**
 * Periodic bucket-orphan prune scheduler (issue #169 item A).
 *
 * Thin caller over `createPeriodicSweeper` (see
 * `src/server/periodicSweeper.ts`): the timer drive, sustained-failure
 * backoff, and `stop()` drain are shared with the audit retention and
 * attachment reaper schedulers.
 *
 * Why the sweep lives in the app process rather than an ops command:
 * the diff is only sound when the bucket and the database belong to the
 * same deployment (see `storage/pruneBucketOrphans.ts` header). Here
 * that holds by construction — both come from the one env this process
 * was started with. A standalone script has to be *told* which pair to
 * use, and the deployed image ships neither `scripts/` nor `tsx`, so it
 * could only ever run from a checkout pointed at production by hand.
 * `scripts/prune-bucket-orphans.ts` remains for on-demand inspection.
 *
 * Report-only by default (`apply: false`): the sweep computes and logs
 * the diff without touching the bucket until an operator sets
 * `STORAGE_PRUNE_APPLY=true`. Orphans are inert — they cost bucket
 * space and nothing else — so there is no hurry to start hiding, and
 * the log gives the operator real evidence before authorising it.
 *
 * Single-process invariant (ADR-0021). Multi-replica deployments would
 * need a lease at this caller site.
 */

import type { Database } from './db/connection.js';
import type { AttachmentStorageClient } from './storage/client.js';
import { createPeriodicSweeper, type PeriodicSweeperHandle } from './periodicSweeper.js';
import {
  pruneBucketOrphans,
  type BucketObject,
  type PruneBucketOrphansLogger,
} from './storage/pruneBucketOrphans.js';
import type { ServiceLogger } from './services/Logger.js';

export const EVENT_BUCKET_ORPHAN_PRUNE = 'bucket-orphan-prune';
export const EVENT_BUCKET_ORPHAN_PRUNE_DETAIL = 'bucket-orphan-prune-detail';
export const EVENT_SWEEP_FAILED = 'bucket-orphan-prune-sweep-failed';
export const EVENT_SUSTAINED_FAILURE = 'bucket-orphan-prune-sustained-failure';
export const EVENT_RECOVERED = 'bucket-orphan-prune-recovered';

export interface StartBucketOrphanPruneSchedulerOptions {
  db: Database;
  storage: AttachmentStorageClient;
  listBucketObjects: () => Promise<BucketObject[]>;
  bucketLabel: string;
  intervalMinutes: number;
  /** Grace window shielding the PUT-before-INSERT writers. */
  minAgeMinutes: number;
  /** `false` (the default deployment shape) reports without hiding. */
  apply: boolean;
  logger: ServiceLogger;
}

export type BucketOrphanPruneScheduler = PeriodicSweeperHandle;

export function startBucketOrphanPruneScheduler(
  opts: StartBucketOrphanPruneSchedulerOptions,
): BucketOrphanPruneScheduler {
  // Per-key and summary prose from the prune itself, kept on its own
  // event so the once-per-run line below stays greppable as one line.
  const pruneLogger: PruneBucketOrphansLogger = {
    info: (message) =>
      opts.logger.info(
        { event: EVENT_BUCKET_ORPHAN_PRUNE_DETAIL, message },
        EVENT_BUCKET_ORPHAN_PRUNE_DETAIL,
      ),
    warn: (message) =>
      opts.logger.info(
        { event: EVENT_BUCKET_ORPHAN_PRUNE_DETAIL, message },
        EVENT_BUCKET_ORPHAN_PRUNE_DETAIL,
      ),
  };

  return createPeriodicSweeper({
    intervalMs: opts.intervalMinutes * 60 * 1000,
    logger: opts.logger,
    events: {
      sweepFailed: EVENT_SWEEP_FAILED,
      sustainedFailure: EVENT_SUSTAINED_FAILURE,
      recovered: EVENT_RECOVERED,
    },
    sweep: async () => {
      const result = await pruneBucketOrphans({
        db: opts.db,
        storage: opts.storage,
        listBucketObjects: opts.listBucketObjects,
        logger: pruneLogger,
        bucketLabel: opts.bucketLabel,
        apply: opts.apply,
        minAgeMinutes: opts.minAgeMinutes,
        // Unattended and destructive: the mismatch refusal is exactly
        // the guard an absent operator would otherwise have been.
        requireReferencedRows: true,
      });

      // One structured line per run — same contract as the other
      // sweepers, so `orphan_count` is trendable straight from the logs.
      opts.logger.info(
        {
          event: EVENT_BUCKET_ORPHAN_PRUNE,
          bucket: opts.bucketLabel,
          apply: opts.apply,
          min_age_minutes: opts.minAgeMinutes,
          bucket_object_count: result.bucketObjectCount,
          preserved_count: result.preservedCount,
          skipped_recent_count: result.skippedRecentCount,
          orphan_count: result.orphanCount,
          ran_at: new Date().toISOString(),
        },
        EVENT_BUCKET_ORPHAN_PRUNE,
      );
    },
  });
}
