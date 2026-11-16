/**
 * Periodic threshold monitor scheduler — verification.md §15.33.
 *
 * Thin caller over `createPeriodicSweeper` (see
 * `src/server/periodicSweeper.ts`): the timer drive, sustained-failure
 * backoff, and `stop()` drain are shared with the reaper schedulers.
 *
 * Single-process invariant (ADR-0021). A multi-replica deployment would
 * need a lease at this caller site — otherwise every replica would
 * notify the same owner for the same condition.
 *
 * The sweep body never crosses the `mutate()` audit boundary —
 * consistent with the other non-mutation system-bus publishers
 * (ADR-0021). Note it is not row-free: push dispatch prunes dead
 * subscriptions in its own transaction (`PushDispatcher`), which is
 * delivery housekeeping written outside `mutate()` on the audit-driven
 * path too.
 */

import type { Database } from './db/connection.js';
import { createPeriodicSweeper, type PeriodicSweeperHandle } from './periodicSweeper.js';
import { runThresholdMonitor } from './services/threshold-monitor.js';
import type { ServiceLogger } from './services/Logger.js';

export const EVENT_SWEEP_FAILED = 'threshold-monitor-sweep-failed';
export const EVENT_SUSTAINED_FAILURE = 'threshold-monitor-sustained-failure';
export const EVENT_RECOVERED = 'threshold-monitor-recovered';
/** Logged once at startup when no storage capacity is declared (AC-669). */
export const EVENT_STORAGE_CHECK_DISABLED = 'threshold-monitor-storage-check-disabled';

export interface StartThresholdMonitorSchedulerOptions {
  db: Database;
  intervalMinutes: number;
  /** Declared capacity in bytes, or null when undeclared. */
  quotaBytes: number | null;
  logger: ServiceLogger;
}

export type ThresholdMonitorScheduler = PeriodicSweeperHandle;

export function startThresholdMonitorScheduler(
  opts: StartThresholdMonitorSchedulerOptions,
): ThresholdMonitorScheduler {
  if (opts.quotaBytes === null) {
    opts.logger.info({ reason: 'STORAGE_QUOTA_GB unset' }, EVENT_STORAGE_CHECK_DISABLED);
  }
  return createPeriodicSweeper({
    intervalMs: opts.intervalMinutes * 60 * 1000,
    logger: opts.logger,
    events: {
      sweepFailed: EVENT_SWEEP_FAILED,
      sustainedFailure: EVENT_SUSTAINED_FAILURE,
      recovered: EVENT_RECOVERED,
    },
    sweep: () =>
      runThresholdMonitor({
        db: opts.db,
        logger: opts.logger,
        quotaBytes: opts.quotaBytes,
      }),
  });
}
