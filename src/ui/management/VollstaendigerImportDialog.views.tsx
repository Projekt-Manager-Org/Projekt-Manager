/**
 * Phase-specific render branches for `VollstaendigerImportDialog`.
 *
 * Mirrors `VollstaendigerExportDialog.views.tsx` — extracted to keep
 * the dialog file under the C-SIZE ceiling. Each phase view renders
 * the shared `DialogShell` with its phase-specific body and actions.
 */

import { type ReactNode, type RefObject } from 'react';
import { STRINGS } from '@/config/strings';
import { RESTORE_CONFIRMATION_PHRASE } from '@/config/dataExchangeConfig';
import { formatBytes } from '@/ui/utils/formatBytes';
import type {
  ParsingPhase,
  PreflightPhase,
  ProgressPhase,
  SummaryPhase,
  ErrorPhase,
} from './useImportAllRunner';
import styles from './VollstaendigerImportDialog.module.css';

interface DialogShellProps {
  dialogRef: RefObject<HTMLDivElement | null>;
  testId: string;
  titleId: string;
  bodyId: string;
  title: string;
  body: ReactNode;
  actions: ReactNode;
}

function DialogShell(props: DialogShellProps) {
  const { dialogRef, testId, titleId, bodyId, title, body, actions } = props;
  return (
    <div className={styles.overlay} data-testid="import-all-overlay">
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-testid={testId}
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <div id={bodyId} className={styles.body}>
          {body}
        </div>
        <div className={styles.actions}>{actions}</div>
      </div>
    </div>
  );
}

export interface ParsingViewProps {
  phase: ParsingPhase;
  dialogRef: RefObject<HTMLDivElement | null>;
}

export function ParsingView(props: ParsingViewProps) {
  const { dialogRef } = props;
  return (
    <DialogShell
      dialogRef={dialogRef}
      testId="import-parsing"
      titleId="import-parsing-title"
      bodyId="import-parsing-body"
      title={STRINGS.dataExchange.importPreflightTitle}
      body={<div className={styles.readoutLine}>{STRINGS.dataExchange.importParsing}</div>}
      actions={null}
    />
  );
}

export interface PreflightViewProps {
  phase: PreflightPhase;
  isMobile: boolean;
  dialogRef: RefObject<HTMLDivElement | null>;
  initialFocusRef: RefObject<HTMLButtonElement | null>;
  phraseInput: string;
  onPhraseInputChange: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function PreflightView(props: PreflightViewProps) {
  const {
    phase,
    isMobile,
    dialogRef,
    initialFocusRef,
    phraseInput,
    onPhraseInputChange,
    onCancel,
    onConfirm,
  } = props;
  const users = (phase.envelope.users ?? []).length;
  const companyProfile = (phase.envelope.company_profile ?? []).length;
  const customers = (phase.envelope.customers ?? []).length;
  const projects = (phase.envelope.projects ?? []).length;
  const assignments = (phase.envelope.project_workers ?? []).length;
  const invoices = (phase.envelope.invoices ?? []).length;
  const invoiceSequence = (phase.envelope.invoice_sequence ?? []).length;
  return (
    <DialogShell
      dialogRef={dialogRef}
      testId="import-all-preflight"
      titleId="import-all-preflight-title"
      bodyId="import-all-preflight-body"
      title={STRINGS.dataExchange.importPreflightTitle}
      body={
        <>
          <div className={styles.readoutLine} data-testid="import-all-preflight-user-count">
            {STRINGS.dataExchange.importPreflightUsers(users)}
          </div>
          {companyProfile > 0 && (
            <div className={styles.readoutLine} data-testid="import-all-preflight-company-profile">
              {STRINGS.dataExchange.importPreflightCompanyProfile}
            </div>
          )}
          <div className={styles.readoutLine} data-testid="import-all-preflight-customer-count">
            {STRINGS.dataExchange.importPreflightCustomers(customers)}
          </div>
          <div className={styles.readoutLine} data-testid="import-all-preflight-project-count">
            {STRINGS.dataExchange.importPreflightProjects(projects)}
          </div>
          <div className={styles.readoutLine} data-testid="import-all-preflight-assignment-count">
            {STRINGS.dataExchange.importPreflightAssignments(assignments)}
          </div>
          <div className={styles.readoutLine} data-testid="import-all-preflight-invoice-count">
            {STRINGS.dataExchange.importPreflightInvoices(invoices)}
          </div>
          {invoiceSequence > 0 && (
            <div className={styles.readoutLine} data-testid="import-all-preflight-invoice-sequence">
              {STRINGS.dataExchange.importPreflightInvoiceSequence(invoiceSequence)}
            </div>
          )}
          <div className={styles.readoutLine} data-testid="import-all-preflight-attachment-count">
            {STRINGS.dataExchange.importPreflightAttachmentCount(phase.attachmentCount)}
          </div>
          <div
            className={styles.readoutLine}
            data-testid="import-all-preflight-size"
            data-bytes-total={phase.totalBytes}
          >
            {STRINGS.dataExchange.importPreflightSize(formatBytes(phase.totalBytes))}
          </div>
          {phase.targetNonEmpty && (
            <>
              <div
                className={styles.destructiveNotice}
                data-testid="import-all-preflight-destructive-notice"
                role="note"
              >
                {STRINGS.dataExchange.restoreDestructiveNotice}
              </div>
              <label className={styles.readoutLine} htmlFor="import-all-phrase-input">
                {STRINGS.dataExchange.restorePhrasePrompt(RESTORE_CONFIRMATION_PHRASE)}
              </label>
              <input
                id="import-all-phrase-input"
                type="text"
                className={styles.phraseInput}
                value={phraseInput}
                onChange={(e) => onPhraseInputChange(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                data-testid="import-all-phrase-input"
              />
            </>
          )}
          {isMobile && (
            <div
              className={styles.mobileWarning}
              data-testid="import-all-preflight-mobile-warning"
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
            data-testid="import-all-preflight-cancel"
          >
            {STRINGS.dataExchange.importPreflightCancel}
          </button>
          <button
            ref={initialFocusRef}
            type="button"
            className={`${styles.button} ${styles.confirm}`}
            onClick={onConfirm}
            data-testid="import-all-preflight-confirm"
          >
            {STRINGS.dataExchange.importPreflightConfirm}
          </button>
        </>
      }
    />
  );
}

export interface ProgressViewProps {
  phase: ProgressPhase;
  dialogRef: RefObject<HTMLDivElement | null>;
  initialFocusRef: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
}

export function ProgressView(props: ProgressViewProps) {
  const { phase, dialogRef, initialFocusRef, onCancel } = props;
  return (
    <DialogShell
      dialogRef={dialogRef}
      testId="import-all-progress"
      titleId="import-all-progress-title"
      bodyId="import-all-progress-body"
      title={STRINGS.dataExchange.importProgressTitle}
      body={
        <>
          <div
            className={styles.readoutLine}
            data-testid="import-all-progress-counter"
            data-files-total={phase.totalCount}
            data-files-done={phase.filesDone}
          >
            {STRINGS.dataExchange.importProgressCounter(phase.filesDone, phase.totalCount)}
          </div>
          <div
            className={styles.readoutLine}
            data-testid="import-all-progress-bytes"
            data-bytes-total={phase.totalSizeBytes}
            data-bytes-done={phase.bytesDone}
          >
            {STRINGS.dataExchange.importProgressBytes(
              formatBytes(phase.bytesDone),
              formatBytes(phase.totalSizeBytes),
            )}
          </div>
          <div className={styles.currentFile} data-testid="import-all-progress-current-file">
            {STRINGS.dataExchange.importProgressCurrentFile(phase.currentFile || '—')}
          </div>
        </>
      }
      actions={
        <button
          ref={initialFocusRef}
          type="button"
          className={`${styles.button} ${styles.cancel}`}
          onClick={onCancel}
          data-testid="import-all-cancel"
        >
          {STRINGS.dataExchange.importCancel}
        </button>
      }
    />
  );
}

export interface SummaryViewProps {
  phase: SummaryPhase;
  dialogRef: RefObject<HTMLDivElement | null>;
  initialFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

export function SummaryView(props: SummaryViewProps) {
  const { phase, dialogRef, initialFocusRef, onClose } = props;
  return (
    <DialogShell
      dialogRef={dialogRef}
      testId="import-all-summary"
      titleId="import-all-summary-title"
      bodyId="import-all-summary-body"
      title={STRINGS.dataExchange.importSummaryTitle}
      body={
        <>
          <div className={styles.readoutLine} data-testid="import-all-summary-committed">
            {STRINGS.dataExchange.importSummaryCommitted(phase.committedCount)}
          </div>
          {phase.failures.length > 0 && (
            <>
              <div className={styles.skippedLine} data-testid="import-all-summary-skipped">
                {STRINGS.dataExchange.importSummarySkipped(phase.failures.length)}
              </div>
              <ul className={styles.failureList} data-testid="import-all-summary-failures">
                {phase.failures.map((f) => (
                  <li key={f.attachmentId}>
                    <code>{f.zipPath || f.attachmentId}</code>: {f.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      }
      actions={
        <button
          ref={initialFocusRef}
          type="button"
          className={`${styles.button} ${styles.confirm}`}
          onClick={onClose}
          data-testid="import-all-summary-close"
        >
          {STRINGS.dataExchange.importSummaryClose}
        </button>
      }
    />
  );
}

export interface ErrorViewProps {
  phase: ErrorPhase;
  dialogRef: RefObject<HTMLDivElement | null>;
  initialFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

export function ErrorView(props: ErrorViewProps) {
  const { phase, dialogRef, initialFocusRef, onClose } = props;
  return (
    <DialogShell
      dialogRef={dialogRef}
      testId="import-all-error"
      titleId="import-all-error-title"
      bodyId="import-all-error-body"
      title={STRINGS.dataExchange.importError}
      body={<div className={styles.readoutLine}>{phase.message}</div>}
      actions={
        <button
          ref={initialFocusRef}
          type="button"
          className={`${styles.button} ${styles.confirm}`}
          onClick={onClose}
          data-testid="import-all-error-close"
        >
          {STRINGS.dataExchange.importSummaryClose}
        </button>
      }
    />
  );
}
