/**
 * Phase-specific render branches for `VollstaendigerExportDialog` (the
 * server-side export-job flow, ui/daten.md §8.11.1).
 *
 * Each view renders the shared `DialogShell` with its phase body + actions.
 * The shell carries a CONSTANT `export-job-dialog` testid on the dialog div
 * (the e2e scopes dialog-presence to it) plus a per-phase testid on the body
 * (`export-job-preflight` / `-progress` / `-ready` / `-error`). Kept local to
 * this module, mirroring the retiring dialog's split — see that file's note on
 * the C-SIZE exception.
 */

import { type ReactNode, type RefObject } from 'react';
import { STRINGS } from '@/config/strings';
import type { DataExchangeJobDto } from '@/state/exportJobStore';
import { formatBytes } from '@/ui/utils/formatBytes';
import { exportDownloadFilename } from '@/ui/utils/exportDownloadFilename';
import styles from './VollstaendigerExportDialog.module.css';

interface DialogShellProps {
  dialogRef: RefObject<HTMLDivElement | null>;
  phaseTestId: string;
  titleId: string;
  bodyId: string;
  title: string;
  body: ReactNode;
  actions: ReactNode;
}

function DialogShell(props: DialogShellProps) {
  const { dialogRef, phaseTestId, titleId, bodyId, title, body, actions } = props;
  return (
    <div className={styles.overlay} data-testid="export-job-overlay">
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-testid="export-job-dialog"
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <div id={bodyId} className={styles.body} data-testid={phaseTestId}>
          {body}
        </div>
        <div className={styles.actions}>{actions}</div>
      </div>
    </div>
  );
}

export interface PreflightViewProps {
  isMobile: boolean;
  /** True once Start was clicked but the job row has not yet arrived — keeps
   *  the preflight visible (no null-job render) and blocks a double-create. */
  startDisabled: boolean;
  dialogRef: RefObject<HTMLDivElement | null>;
  initialFocusRef: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onStart: () => void;
}

export function PreflightView(props: PreflightViewProps) {
  const { isMobile, startDisabled, dialogRef, initialFocusRef, onCancel, onStart } = props;
  return (
    <DialogShell
      dialogRef={dialogRef}
      phaseTestId="export-job-preflight"
      titleId="export-job-preflight-title"
      bodyId="export-job-preflight-body"
      title={STRINGS.dataExchange.exportPreflightTitle}
      body={
        <>
          <div className={styles.readoutLine}>{STRINGS.dataExchange.exportPreflightBody}</div>
          {isMobile && (
            <div
              className={styles.mobileWarning}
              data-testid="export-job-mobile-warning"
              role="note"
            >
              {STRINGS.dataExchange.exportMobileWarning}
            </div>
          )}
        </>
      }
      actions={
        <>
          <button
            type="button"
            className={`${styles.button} ${styles.cancel}`}
            onClick={onCancel}
            data-testid="export-job-cancel"
          >
            {STRINGS.dataExchange.exportPreflightCancel}
          </button>
          <button
            ref={initialFocusRef}
            type="button"
            className={`${styles.button} ${styles.confirm}`}
            onClick={onStart}
            disabled={startDisabled}
            data-testid="export-job-start"
          >
            {STRINGS.dataExchange.exportPreflightConfirm}
          </button>
        </>
      }
    />
  );
}

export interface ProgressViewProps {
  job: DataExchangeJobDto;
  dialogRef: RefObject<HTMLDivElement | null>;
  initialFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

export function ProgressView(props: ProgressViewProps) {
  const { job, dialogRef, initialFocusRef, onClose } = props;
  return (
    <DialogShell
      dialogRef={dialogRef}
      phaseTestId="export-job-progress"
      titleId="export-job-progress-title"
      bodyId="export-job-progress-body"
      title={STRINGS.dataExchange.exportProgressTitle}
      body={
        <>
          <div
            className={styles.readoutLine}
            data-testid="export-job-progress-counter"
            data-files-total={job.filesTotal}
            data-files-done={job.filesDone}
          >
            {STRINGS.dataExchange.exportProgressCounter(job.filesDone, job.filesTotal)}
          </div>
          <div
            className={styles.readoutLine}
            data-testid="export-job-progress-bytes"
            data-bytes-total={job.bytesTotal}
            data-bytes-done={job.bytesDone}
          >
            {STRINGS.dataExchange.exportProgressBytes(
              formatBytes(job.bytesDone),
              formatBytes(job.bytesTotal),
            )}
          </div>
          <div className={styles.currentFile} data-testid="export-job-current-item">
            {STRINGS.dataExchange.exportProgressCurrentFile(job.currentItem || '—')}
          </div>
        </>
      }
      actions={
        <button
          ref={initialFocusRef}
          type="button"
          className={`${styles.button} ${styles.cancel}`}
          onClick={onClose}
          data-testid="export-job-close"
        >
          {STRINGS.dataExchange.exportSummaryClose}
        </button>
      }
    />
  );
}

export interface ReadyViewProps {
  job: DataExchangeJobDto;
  /** Range-capable download URL for this job's archive (built by the store). */
  downloadHref: string;
  dialogRef: RefObject<HTMLDivElement | null>;
  initialFocusRef: RefObject<HTMLAnchorElement | null>;
  onClose: () => void;
}

export function ReadyView(props: ReadyViewProps) {
  const { downloadHref, dialogRef, initialFocusRef, onClose } = props;
  return (
    <DialogShell
      dialogRef={dialogRef}
      phaseTestId="export-job-ready"
      titleId="export-job-ready-title"
      bodyId="export-job-ready-body"
      title={STRINGS.dataExchange.exportReadyTitle}
      body={
        <>
          {/* Range-capable authenticated download. The browser's native
              download manager handles the stream (cookies ride along on the
              same-origin GET); an interrupted download resumes via Range. */}
          <a
            ref={initialFocusRef}
            className={`${styles.button} ${styles.confirm}`}
            href={downloadHref}
            download={exportDownloadFilename()}
            data-testid="export-job-download"
          >
            {STRINGS.dataExchange.exportDownloadAction}
          </a>
        </>
      }
      actions={
        <button
          type="button"
          className={`${styles.button} ${styles.cancel}`}
          onClick={onClose}
          data-testid="export-job-close"
        >
          {STRINGS.dataExchange.exportSummaryClose}
        </button>
      }
    />
  );
}

export interface FailedViewProps {
  job: DataExchangeJobDto;
  dialogRef: RefObject<HTMLDivElement | null>;
  initialFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

export function FailedView(props: FailedViewProps) {
  const { job, dialogRef, initialFocusRef, onClose } = props;
  return (
    <DialogShell
      dialogRef={dialogRef}
      phaseTestId="export-job-error"
      titleId="export-job-error-title"
      bodyId="export-job-error-body"
      title={STRINGS.dataExchange.exportError}
      body={
        <div className={styles.readoutLine}>
          {job.errorDetail || STRINGS.dataExchange.exportError}
        </div>
      }
      actions={
        <button
          ref={initialFocusRef}
          type="button"
          className={`${styles.button} ${styles.confirm}`}
          onClick={onClose}
          data-testid="export-job-error-close"
        >
          {STRINGS.dataExchange.exportSummaryClose}
        </button>
      }
    />
  );
}
