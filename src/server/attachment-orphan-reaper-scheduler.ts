/**
 * Periodic attachment orphan reaper scheduler — AC-408.
 *
 * Thin caller over `createPeriodicSweeper` (see
 * `src/server/periodicSweeper.ts`): the timer drive, sustained-
 * failure backoff, and `stop()` drain are shared with the audit
 * retention and bulk-download reaper schedulers.
 *
 * Single-process invariant (ADR-0021). Multi-replica deployments
 * would need a lease at this caller site.
 *
 * The reaper service is the sole deleter of `pending` rows via this
 * path; the architecture-check allowlist in
 * `scripts/check-audit-mutations.sh` names the service file, not this
 * scheduler, because this module only drives the schedule.
 */

import type { Database } from './db/connection.js';
import type { AttachmentStorageClient } from './storage/client.js';
import { createPeriodicSweeper, type PeriodicSweeperHandle } from './periodicSweeper.js';
import { runAttachmentOrphanReaper } from './services/attachment-orphan-reaper.js';
import type { ServiceLogger } from './services/Logger.js';

export type { AttachmentStorageClient };

export const EVENT_SWEEP_FAILED = 'attachment-orphan-reaper-sweep-failed';
export const EVENT_SUSTAINED_FAILURE = 'attachment-orphan-reaper-sustained-failure';
export const EVENT_RECOVERED = 'attachment-orphan-reaper-recovered';

export interface StartAttachmentOrphanReaperSchedulerOptions {
  db: Database;
  storage: AttachmentStorageClient;
  intervalMinutes: number;
  ttlMinutes: number;
  logger: ServiceLogger;
}

export type AttachmentOrphanReaperScheduler = PeriodicSweeperHandle;

export function startAttachmentOrphanReaperScheduler(
  opts: StartAttachmentOrphanReaperSchedulerOptions,
): AttachmentOrphanReaperScheduler {
  return createPeriodicSweeper({
    intervalMs: opts.intervalMinutes * 60 * 1000,
    logger: opts.logger,
    events: {
      sweepFailed: EVENT_SWEEP_FAILED,
      sustainedFailure: EVENT_SUSTAINED_FAILURE,
      recovered: EVENT_RECOVERED,
    },
    sweep: () =>
      runAttachmentOrphanReaper({
        db: opts.db,
        storage: opts.storage,
        logger: opts.logger,
        ttlMinutes: opts.ttlMinutes,
      }),
  });
}
