/**
 * Periodic attachment hidden reaper scheduler — AC-426.
 *
 * Thin caller over `createPeriodicSweeper` (see
 * `src/server/periodicSweeper.ts`): the timer drive, sustained-
 * failure backoff, and `stop()` drain are shared with the audit
 * retention scheduler and the orphan reaper scheduler.
 *
 * Single-process invariant (ADR-0021). Multi-replica deployments
 * would need a lease at this caller site.
 *
 * The reaper service routes deletions through `mutate()` (AC-177);
 * the architecture-check allowlist in `scripts/check-audit-mutations.sh`
 * therefore does not name this module nor the reaper service — both
 * write through the helper like any other audited path.
 */

import type { Database } from './db/connection.js';
import { createPeriodicSweeper, type PeriodicSweeperHandle } from './periodicSweeper.js';
import { runAttachmentHiddenReaper } from './services/attachment-hidden-reaper.js';
import type { ServiceLogger } from './services/Logger.js';

export const EVENT_SWEEP_FAILED = 'attachment-hidden-reaper-sweep-failed';
export const EVENT_SUSTAINED_FAILURE = 'attachment-hidden-reaper-sustained-failure';
export const EVENT_RECOVERED = 'attachment-hidden-reaper-recovered';

export interface StartAttachmentHiddenReaperSchedulerOptions {
  db: Database;
  intervalMinutes: number;
  ttlMinutes: number;
  logger: ServiceLogger;
}

export type AttachmentHiddenReaperScheduler = PeriodicSweeperHandle;

export function startAttachmentHiddenReaperScheduler(
  opts: StartAttachmentHiddenReaperSchedulerOptions,
): AttachmentHiddenReaperScheduler {
  return createPeriodicSweeper({
    intervalMs: opts.intervalMinutes * 60 * 1000,
    logger: opts.logger,
    events: {
      sweepFailed: EVENT_SWEEP_FAILED,
      sustainedFailure: EVENT_SUSTAINED_FAILURE,
      recovered: EVENT_RECOVERED,
    },
    sweep: () =>
      runAttachmentHiddenReaper({
        db: opts.db,
        logger: opts.logger,
        ttlMinutes: opts.ttlMinutes,
      }),
  });
}
