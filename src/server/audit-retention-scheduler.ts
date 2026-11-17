/**
 * Periodic audit-log retention cleanup scheduler.
 *
 * Thin caller over `createPeriodicSweeper` (see
 * `src/server/periodicSweeper.ts`) — the timer drive, sustained-
 * failure backoff, and `stop()` drain are shared with the attachment
 * orphan reaper and bulk-download reaper schedulers.
 *
 * Separate from the session reaper because:
 *   - cadence differs (reaper = minutes; retention = daily by default);
 *   - log shape differs (reaper = `info(msg: string)`; retention =
 *     `ServiceLogger.info(ctx, event)` per AC-633);
 *   - the failure-counter state is per-job by design — a sustained
 *     session-reap failure should not silence retention, and vice
 *     versa.
 *
 * Single-process invariant (ADR-0021). Multi-replica deployments
 * would emit N log lines per run — revisit when that topology is
 * considered.
 *
 * The retention service itself is the sole deleter of `audit_log`
 * rows — see `src/server/services/audit-retention.ts`; the DB
 * triggers reject a delete outside `withAuditLogRemoval` (AC-642).
 * This module only drives the schedule; it does not touch the table
 * directly.
 */

import type { Database } from './db/connection.js';
import { createPeriodicSweeper, type PeriodicSweeperHandle } from './periodicSweeper.js';
import { runAuditRetentionCleanup } from './services/audit-retention.js';
import type { ServiceLogger } from './services/Logger.js';

/**
 * Operational-log event names emitted by the scheduler. Kebab-case to
 * stay consistent with the audit subsystem's AC-pinned events
 * `audit-retention-cleanup` (AC-633) and `audit-publisher-handler-error`
 * (AC-183). Not AC-pinned themselves — rename with care regardless,
 * operators grep the log for these strings.
 */
export const EVENT_SWEEP_FAILED = 'audit-retention-sweep-failed';
export const EVENT_SUSTAINED_FAILURE = 'audit-retention-sustained-failure';
export const EVENT_RECOVERED = 'audit-retention-recovered';

export interface StartAuditRetentionSchedulerOptions {
  db: Database;
  intervalMinutes: number;
  /** Retention window in days — resolved by the caller from env + [C] default. */
  windowDays: number;
  logger: ServiceLogger;
}

export type AuditRetentionScheduler = PeriodicSweeperHandle;

export function startAuditRetentionScheduler(
  opts: StartAuditRetentionSchedulerOptions,
): AuditRetentionScheduler {
  return createPeriodicSweeper({
    intervalMs: opts.intervalMinutes * 60 * 1000,
    logger: opts.logger,
    events: {
      sweepFailed: EVENT_SWEEP_FAILED,
      sustainedFailure: EVENT_SUSTAINED_FAILURE,
      recovered: EVENT_RECOVERED,
    },
    // The service emits its own AC-633 log line. The shared sweeper
    // only adds recovery/failure lines around it. Wrapper drops the
    // non-void return so it matches the factory's `Promise<void>`
    // contract — the result object is consumed by the service's own
    // log line, not by the scheduler.
    sweep: async () => {
      await runAuditRetentionCleanup({
        db: opts.db,
        logger: opts.logger,
        windowDays: opts.windowDays,
      });
    },
  });
}
