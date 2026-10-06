/**
 * Invoice backup-release watch scheduler — architecture.md §11.13.
 *
 * Thin caller over `createPeriodicSweeper`: drives
 * `createInvoiceBackupWatcher` against the live marks and emits
 * `invoice_changed` on a release, so open surfaces enable the download
 * without a reload. Runs whether or not the backup feature is enabled —
 * withholding and the release watch follow the marks alone (§11.14).
 *
 * Single-process invariant (ADR-0021), like the other schedulers: the
 * watcher's baseline lives in this process.
 */

import type { Database } from './db/connection.js';
import { createPeriodicSweeper, type PeriodicSweeperHandle } from './periodicSweeper.js';
import { createInvoiceBackupWatcher } from './services/invoice-backup-watcher.js';
import { listInvoiceBackupPendingIds } from './repositories/invoiceBackupPending.js';
import { emitInvoiceChanged } from './sse/emitters.js';
import type { ServiceLogger } from './services/Logger.js';
import { INVOICE_BACKUP_WATCH_INTERVAL_MS } from '../config/invoiceBackupWatch.js';

export const EVENT_SWEEP_FAILED = 'invoice-backup-watch-sweep-failed';
export const EVENT_SUSTAINED_FAILURE = 'invoice-backup-watch-sustained-failure';
export const EVENT_RECOVERED = 'invoice-backup-watch-recovered';

export function startInvoiceBackupWatchScheduler(opts: {
  db: Database;
  logger: ServiceLogger;
}): PeriodicSweeperHandle {
  const watcher = createInvoiceBackupWatcher({
    listPendingIds: () => listInvoiceBackupPendingIds(opts.db),
    emit: emitInvoiceChanged,
  });
  return createPeriodicSweeper({
    intervalMs: INVOICE_BACKUP_WATCH_INTERVAL_MS,
    logger: opts.logger,
    events: {
      sweepFailed: EVENT_SWEEP_FAILED,
      sustainedFailure: EVENT_SUSTAINED_FAILURE,
      recovered: EVENT_RECOVERED,
    },
    sweep: watcher.sweep,
  });
}
