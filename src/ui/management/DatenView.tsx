/**
 * Daten view — full-account Export + Import as server-side jobs
 * (ADR-0018 / ADR-0024, ui/daten.md §8.11). The browser triggers, polls, and
 * downloads/uploads; the VPS builds/restores. Replaces the retiring
 * browser-streaming pipeline.
 *
 * Two actions, gated independently:
 *   - Export — `data:export`. Opens the export-job dialog (preflight → start).
 *   - Import — `data:restore`. Triggers the OS file picker; the dialog mounts
 *     once a zip is chosen (confirm → resumable upload → server processing).
 *
 * Resume (ui/daten.md §8.11.1 step 1 / §8.11.2 step 4): the view subscribes to
 * each job store on mount (the store's mount probe re-attaches to an existing
 * job — a page reload or post-wipe re-login loses nothing). Dialog open-state
 * is DERIVED, never set from an effect: a dialog is open when the user opened
 * it (and has not closed it) OR a resume condition holds. An ACTIVE export
 * (`pending`/`running`) auto-opens its progress dialog and falls back to the
 * inline section affordance (download / error) once terminal — so a finished
 * export never pops a modal over the import action. An active OR terminal
 * import auto-opens its dialog so the processing readout and restored-counts
 * summary re-attach after the user-wipe re-auth.
 */

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { STRINGS } from '@/config/strings';
import { usePermission } from '@/hooks/usePermission';
import { useExportJobStore } from '@/state/exportJobStore';
import { useImportJobStore } from '@/state/importJobStore';
import { exportDownloadFilename } from '@/ui/utils/exportDownloadFilename';
import { StorageUsageRow } from './StorageUsageRow';
import { VollstaendigerExportDialog } from './VollstaendigerExportDialog';
import { VollstaendigerImportDialog } from './VollstaendigerImportDialog';
import styles from './Management.module.css';

export function DatenView() {
  const canExport = usePermission('data:export');
  const canImport = usePermission('data:restore');

  // User intent toggles. Dialog open-state is DERIVED from these + the job
  // (below), so we never setState from an effect (react-hooks/set-state-in-effect).
  const [exportUserOpened, setExportUserOpened] = useState<boolean>(false);
  const [exportUserClosed, setExportUserClosed] = useState<boolean>(false);
  const [importUserOpened, setImportUserOpened] = useState<boolean>(false);
  const [importUserClosed, setImportUserClosed] = useState<boolean>(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const exportJob = useExportJobStore((s) => s.job);
  const exportDownloadPath = useExportJobStore((s) => s.downloadPath);
  const importJob = useImportJobStore((s) => s.job);
  // Cross-mount import dismissal lives in the store (not a module var) so it
  // resets with the store on session teardown — a re-auth is not a full reload.
  const dismissedImportJobId = useImportJobStore((s) => s.dismissedJobId);

  // Subscribe to each store only when the role holds the permission — defense
  // in depth on top of the server gate; a role without it must not probe the
  // gated job endpoint. The effects only wire the subscription (no setState).
  useEffect(() => {
    if (!canExport) return;
    return useExportJobStore.getState().subscribe();
  }, [canExport]);

  useEffect(() => {
    if (!canImport) return;
    return useImportJobStore.getState().subscribe();
  }, [canImport]);

  // Derived open-state. Export auto-opens only for an active build (progress);
  // a terminal export is surfaced inline below, so it never pops a modal over
  // the import action. Import auto-opens for any in-flight OR terminal job (the
  // dialog hosts the processing readout + the restored-counts summary the
  // operator re-attaches to after re-auth). An explicit close wins for the rest
  // of the visit; a fresh mount (route revisit / reload) re-attaches.
  const exportAutoOpen =
    !!exportJob && (exportJob.status === 'pending' || exportJob.status === 'running');
  const exportDialogOpen = !exportUserClosed && (exportUserOpened || exportAutoOpen);
  const importDialogOpen =
    !importUserClosed &&
    (importUserOpened || (!!importJob && importJob.id !== dismissedImportJobId));

  const openExportDialog = () => {
    setExportUserClosed(false);
    setExportUserOpened(true);
  };
  const closeExportDialog = () => {
    setExportUserClosed(true);
    setExportUserOpened(false);
  };

  const handleImportClick = () => {
    // Reset the value first so re-picking the same file still fires `change`.
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };
  const handleFilePicked = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    if (file) {
      setImportFile(file);
      setImportUserClosed(false);
      setImportUserOpened(true);
    }
  };
  const closeImportDialog = () => {
    // Remember the dismissal (store-held) across mounts so this terminal job
    // does not re-pop on the next Daten visit.
    useImportJobStore.getState().dismiss(importJob?.id ?? null);
    setImportUserClosed(true);
    setImportUserOpened(false);
    setImportFile(null);
  };

  return (
    <div className={styles.container} data-testid="daten-view">
      <StorageUsageRow />

      {canExport && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>{STRINGS.dataExchange.exportHeading}</h3>
          <p className={styles.sectionDescription}>{STRINGS.dataExchange.exportDescription}</p>

          {/* Terminal-job affordances live inline (the dialog hosts only the
              active build); guarded by !exportDialogOpen so they never
              co-render with the dialog's own ready view — one
              `export-job-download` at a time. */}
          {!exportDialogOpen && exportJob?.status === 'ready' && (
            <div className={styles.inlineGroup} data-testid="export-job-status">
              <a
                className={styles.submitButton}
                href={exportDownloadPath(exportJob.id)}
                download={exportDownloadFilename()}
                data-testid="export-job-download"
              >
                {STRINGS.dataExchange.exportDownloadAction}
              </a>
            </div>
          )}
          {!exportDialogOpen && exportJob?.status === 'failed' && (
            <div className={styles.inlineGroup} data-testid="export-job-status">
              <span>{exportJob.errorDetail || STRINGS.dataExchange.exportError}</span>
            </div>
          )}

          <div className={styles.inlineGroup}>
            <button
              className={styles.submitButton}
              onClick={openExportDialog}
              data-testid="data-export-button"
            >
              {STRINGS.dataExchange.exportAction}
            </button>
          </div>
        </div>
      )}

      {exportDialogOpen && <VollstaendigerExportDialog onClose={closeExportDialog} />}

      {canImport && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>{STRINGS.dataExchange.importHeading}</h3>
          <p className={styles.sectionDescription}>{STRINGS.dataExchange.importDescription}</p>
          <div className={styles.inlineGroup}>
            <button
              className={styles.submitButton}
              onClick={handleImportClick}
              data-testid="data-import-button"
            >
              {STRINGS.dataExchange.importAction}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip"
              onChange={handleFilePicked}
              hidden
              data-testid="data-import-file-input"
            />
          </div>
        </div>
      )}

      {importDialogOpen && (
        <VollstaendigerImportDialog file={importFile} onClose={closeImportDialog} />
      )}
    </div>
  );
}
