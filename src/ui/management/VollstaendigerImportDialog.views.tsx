/**
 * Phase-specific render branches for `VollstaendigerImportDialog` (the
 * server-side import-job flow, ui/daten.md §8.11.2).
 *
 * Each view renders the shared `DialogShell` with its phase body + actions.
 * The shell carries a CONSTANT `import-job-dialog` testid on the dialog div
 * (the e2e scopes dialog-presence to it) + `import-job-overlay` on the overlay,
 * plus a per-phase testid on the body (`import-job-confirm` / `-uploading` /
 * `-processing` / `-summary` / `-error`). Mirrors
 * `VollstaendigerExportDialog.views.tsx`; kept local to this module.
 */

import { type ReactNode, type RefObject } from 'react';
import { STRINGS } from '@/config/strings';
import { RESTORE_CONFIRMATION_PHRASE } from '@/config/dataExchangeConfig';
import type { DataExchangeJobDto } from '@/state/importJobStore';
import { formatBytes } from '@/ui/utils/formatBytes';
import styles from './VollstaendigerImportDialog.module.css';

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
    <div className={styles.overlay} data-testid="import-job-overlay">
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-testid="import-job-dialog"
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

export interface ConfirmViewProps {
  isMobile: boolean;
  phraseInput: string;
  onPhraseInputChange: (v: string) => void;
  /** True while the typed value matches the configured phrase (AC-161 gate). */
  phraseMatches: boolean;
  /** True while a create/upload is in flight — blocks a double-create. */
  startDisabled: boolean;
  /** Set when the server rejected the create-time destructive guard. */
  showMismatch: boolean;
  dialogRef: RefObject<HTMLDivElement | null>;
  initialFocusRef: RefObject<HTMLInputElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmView(props: ConfirmViewProps) {
  const {
    isMobile,
    phraseInput,
    onPhraseInputChange,
    phraseMatches,
    startDisabled,
    showMismatch,
    dialogRef,
    initialFocusRef,
    onCancel,
    onConfirm,
  } = props;
  return (
    <DialogShell
      dialogRef={dialogRef}
      phaseTestId="import-job-confirm"
      titleId="import-job-confirm-title"
      bodyId="import-job-confirm-body"
      title={STRINGS.dataExchange.importPreflightTitle}
      body={
        <>
          {/* A full-account restore is ALWAYS destructive — no client dry-run
              (AC-161), so the phrase gate is unconditional. */}
          <div
            className={styles.destructiveNotice}
            data-testid="import-job-destructive-notice"
            role="note"
          >
            {STRINGS.dataExchange.restoreDestructiveNotice}
          </div>
          <label className={styles.readoutLine} htmlFor="import-job-phrase-input">
            {STRINGS.dataExchange.restorePhrasePrompt(RESTORE_CONFIRMATION_PHRASE)}
          </label>
          <input
            ref={initialFocusRef}
            id="import-job-phrase-input"
            type="text"
            className={styles.phraseInput}
            value={phraseInput}
            onChange={(e) => onPhraseInputChange(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            data-testid="import-job-phrase-input"
          />
          {showMismatch && (
            <div
              className={styles.destructiveNotice}
              data-testid="import-job-confirm-mismatch"
              role="alert"
            >
              {STRINGS.dataExchange.importConfirmMismatch}
            </div>
          )}
          {isMobile && (
            <div
              className={styles.mobileWarning}
              data-testid="import-job-mobile-warning"
              role="note"
            >
              {STRINGS.dataExchange.importMobileWarning}
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
            data-testid="import-job-cancel"
          >
            {STRINGS.dataExchange.importPreflightCancel}
          </button>
          <button
            type="button"
            className={`${styles.button} ${styles.confirm}`}
            onClick={onConfirm}
            disabled={!phraseMatches || startDisabled}
            data-testid="import-job-start"
          >
            {STRINGS.dataExchange.importPreflightConfirm}
          </button>
        </>
      }
    />
  );
}

export interface UploadingViewProps {
  job: DataExchangeJobDto;
  /** Bytes uploaded to the VPS so far (client→VPS phase). */
  uploadOffset: number;
  dialogRef: RefObject<HTMLDivElement | null>;
  initialFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

export function UploadingView(props: UploadingViewProps) {
  const { job, uploadOffset, dialogRef, initialFocusRef, onClose } = props;
  return (
    <DialogShell
      dialogRef={dialogRef}
      phaseTestId="import-job-uploading"
      titleId="import-job-uploading-title"
      bodyId="import-job-uploading-body"
      title={STRINGS.dataExchange.importUploadingTitle}
      body={
        <div
          className={styles.readoutLine}
          data-testid="import-job-upload-bytes"
          data-bytes-total={job.bytesTotal}
          data-bytes-done={uploadOffset}
        >
          {STRINGS.dataExchange.importProgressBytes(
            formatBytes(uploadOffset),
            formatBytes(job.bytesTotal),
          )}
        </div>
      }
      actions={
        <button
          ref={initialFocusRef}
          type="button"
          className={`${styles.button} ${styles.cancel}`}
          onClick={onClose}
          data-testid="import-job-close"
        >
          {STRINGS.dataExchange.importSummaryClose}
        </button>
      }
    />
  );
}

export interface ProcessingViewProps {
  job: DataExchangeJobDto;
  dialogRef: RefObject<HTMLDivElement | null>;
  initialFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

export function ProcessingView(props: ProcessingViewProps) {
  const { job, dialogRef, initialFocusRef, onClose } = props;
  return (
    <DialogShell
      dialogRef={dialogRef}
      phaseTestId="import-job-processing"
      titleId="import-job-processing-title"
      bodyId="import-job-processing-body"
      title={STRINGS.dataExchange.importProcessingTitle}
      body={
        <>
          <div
            className={styles.readoutLine}
            data-testid="import-job-processing-counter"
            data-files-total={job.filesTotal}
            data-files-done={job.filesDone}
          >
            {STRINGS.dataExchange.importProgressCounter(job.filesDone, job.filesTotal)}
          </div>
          <div className={styles.currentFile} data-testid="import-job-current-item">
            {STRINGS.dataExchange.importProgressCurrentFile(job.currentItem || '—')}
          </div>
        </>
      }
      actions={
        <button
          ref={initialFocusRef}
          type="button"
          className={`${styles.button} ${styles.cancel}`}
          onClick={onClose}
          data-testid="import-job-close"
        >
          {STRINGS.dataExchange.importSummaryClose}
        </button>
      }
    />
  );
}

export interface SummaryViewProps {
  job: DataExchangeJobDto;
  dialogRef: RefObject<HTMLDivElement | null>;
  initialFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

export function SummaryView(props: SummaryViewProps) {
  const { job, dialogRef, initialFocusRef, onClose } = props;
  return (
    <DialogShell
      dialogRef={dialogRef}
      phaseTestId="import-job-summary"
      titleId="import-job-summary-title"
      bodyId="import-job-summary-body"
      title={STRINGS.dataExchange.importSummaryTitle}
      body={
        <div className={styles.readoutLine} data-testid="import-job-restored">
          {STRINGS.dataExchange.importSummaryCommitted(job.filesDone)}
        </div>
      }
      actions={
        <button
          ref={initialFocusRef}
          type="button"
          className={`${styles.button} ${styles.confirm}`}
          onClick={onClose}
          data-testid="import-job-close"
        >
          {STRINGS.dataExchange.importSummaryClose}
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
      phaseTestId="import-job-error"
      titleId="import-job-error-title"
      bodyId="import-job-error-body"
      title={STRINGS.dataExchange.importError}
      body={
        <div className={styles.readoutLine}>
          {job.errorDetail || STRINGS.dataExchange.importError}
        </div>
      }
      actions={
        <button
          ref={initialFocusRef}
          type="button"
          className={`${styles.button} ${styles.confirm}`}
          onClick={onClose}
          data-testid="import-job-error-close"
        >
          {STRINGS.dataExchange.importSummaryClose}
        </button>
      }
    />
  );
}
