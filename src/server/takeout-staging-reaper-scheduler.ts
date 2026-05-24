/**
 * Periodic takeout staging reaper scheduler — data-model.md §6.15,
 * AC-334.
 *
 * Thin caller over `createPeriodicSweeper` (see
 * `src/server/periodicSweeper.ts`): the timer drive, sustained-failure
 * backoff, and `stop()` drain are shared with the audit retention and
 * attachment reaper schedulers.
 *
 * Single-process invariant (ADR-0021). Multi-replica deployments would
 * need a lease at this caller site.
 *
 * The reaper service (`runTakeoutStagingReaper`) is the contract surface
 * the AC-334 test drives directly; this module only drives the schedule.
 */

import type { Database } from './db/connection.js';
import type { AttachmentStorageClient } from './storage/client.js';
import { createPeriodicSweeper, type PeriodicSweeperHandle } from './periodicSweeper.js';
import { runTakeoutStagingReaper } from './services/takeout-staging-reaper.js';
import type { ServiceLogger } from './services/Logger.js';

export const EVENT_SWEEP_FAILED = 'takeout-staging-reaper-sweep-failed';
export const EVENT_SUSTAINED_FAILURE = 'takeout-staging-reaper-sustained-failure';
export const EVENT_RECOVERED = 'takeout-staging-reaper-recovered';

export interface StartTakeoutStagingReaperSchedulerOptions {
  db: Database;
  storage: AttachmentStorageClient;
  intervalMinutes: number;
  ttlMinutes: number;
  logger: ServiceLogger;
}

export type TakeoutStagingReaperScheduler = PeriodicSweeperHandle;

export function startTakeoutStagingReaperScheduler(
  opts: StartTakeoutStagingReaperSchedulerOptions,
): TakeoutStagingReaperScheduler {
  return createPeriodicSweeper({
    intervalMs: opts.intervalMinutes * 60 * 1000,
    logger: opts.logger,
    events: {
      sweepFailed: EVENT_SWEEP_FAILED,
      sustainedFailure: EVENT_SUSTAINED_FAILURE,
      recovered: EVENT_RECOVERED,
    },
    sweep: () =>
      runTakeoutStagingReaper({
        db: opts.db,
        storage: opts.storage,
        logger: opts.logger,
        ttlMinutes: opts.ttlMinutes,
      }),
  });
}
