/**
 * Periodic threshold monitor scheduler — architecture.md §12.2.
 *
 * Thin caller over `createPeriodicSweeper` (see
 * `src/server/periodicSweeper.ts`): the timer drive, sustained-failure
 * backoff, and `stop()` drain are shared with the reaper schedulers.
 *
 * Single-process invariant (ADR-0021). A multi-replica deployment would
 * need a lease at this caller site — otherwise every replica would
 * notify the same owner for the same condition.
 *
 * The sweep body publishes notification events but writes no rows, so
 * it never crosses the `mutate()` audit boundary — consistent with the
 * other non-mutation system-bus publishers (ADR-0021).
 */

import type { Database } from './db/connection.js';
import { createPeriodicSweeper, type PeriodicSweeperHandle } from './periodicSweeper.js';
import { runThresholdMonitor } from './services/threshold-monitor.js';
import type { ServiceLogger } from './services/Logger.js';

export const EVENT_SWEEP_FAILED = 'threshold-monitor-sweep-failed';
export const EVENT_SUSTAINED_FAILURE = 'threshold-monitor-sustained-failure';
export const EVENT_RECOVERED = 'threshold-monitor-recovered';

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
