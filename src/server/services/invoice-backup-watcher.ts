/**
 * Invoice backup-release watcher — architecture.md §11.13 "Emitters of
 * `invoice_changed`", AC-376.
 *
 * Backup-pending marks are released by the `backup` service, another
 * process, so no in-process mutation site can emit. Each sweep reads
 * the standing marks and emits once when any mark seen on the previous
 * sweep is gone. A new mark is not its business — issuance emitted for
 * it already.
 */

export interface InvoiceBackupWatcherDeps {
  listPendingIds: () => Promise<string[]>;
  emit: () => void;
}

export interface InvoiceBackupWatcher {
  /** Rejects when the read fails; the baseline is then kept for the next sweep. */
  sweep: () => Promise<void>;
}

export function createInvoiceBackupWatcher(deps: InvoiceBackupWatcherDeps): InvoiceBackupWatcher {
  let seen: ReadonlySet<string> | null = null;
  return {
    async sweep() {
      const current = new Set(await deps.listPendingIds());
      const released = seen !== null && [...seen].some((id) => !current.has(id));
      seen = current;
      if (released) deps.emit();
    },
  };
}
