/**
 * Invoice backup-release watch cadence — architecture.md §11.13.
 *
 * The `backup` service releases backup-pending marks from another
 * process, so the app polls the marks and emits `invoice_changed` when
 * one disappears. The contract is "within 15 seconds of a release"; a
 * 10-second poll leaves headroom for the client's refetch. The query is
 * a primary-key scan of a table that is empty almost always.
 */
export const INVOICE_BACKUP_WATCH_INTERVAL_MS = 10_000;
