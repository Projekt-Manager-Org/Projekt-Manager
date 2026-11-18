/**
 * Storno confirmation dialog (ui/invoices.md §8.16.3 — `Stornorechnung
 * erstellen`).
 *
 * Standalone from the shared `ConfirmDialog` because the cancel flow
 * needs a free-text `Grund` input that the snapshot atom records on
 * `Invoice.cancellationReason`. The dialog enforces the reason as
 * required client-side (AC-707); the server accepts a cancel without
 * one.
 */

import { useCallback, useRef, useState } from 'react';
import { STRINGS } from '@/config/strings';
import { useDialogA11y } from '@/ui/common/useDialogA11y';
import styles from './InvoiceSection.module.css';

interface Props {
  isOpen: boolean;
  submitting: boolean;
  errorMessage: string | null;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}

const TITLE_ID = 'invoice-cancel-dialog-title';

export function InvoiceCancelDialog({
  isOpen,
  submitting,
  errorMessage,
  onConfirm,
  onClose,
}: Props) {
  const [reason, setReason] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const onEscape = useCallback(() => {
    if (submitting) return;
    onClose();
  }, [submitting, onClose]);

  const onOpenedFocus = useCallback(() => textareaRef.current?.focus(), []);

  useDialogA11y({ isOpen, dialogRef, onOpenedFocus, onEscape });

  if (!isOpen) return null;

  const handleConfirm = () => {
    const trimmed = reason.trim();
    if (!trimmed) {
      setLocalError(STRINGS.invoices.cancelReasonRequired);
      return;
    }
    setLocalError(null);
    onConfirm(trimmed);
  };

  return (
    <div className={styles.cancelDialogOverlay} data-testid="invoice-cancel-overlay">
      <div
        ref={dialogRef}
        className={styles.cancelDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        data-testid="invoice-cancel-dialog"
      >
        <h2 id={TITLE_ID} className={styles.formTitle}>
          {STRINGS.invoices.cancelDialogTitle}
        </h2>
        <p className={styles.cancelDialogWarning}>{STRINGS.invoices.cancelDialogWarning}</p>
        <label className={styles.formLabel} htmlFor="invoice-cancel-reason">
          {STRINGS.invoices.cancelReasonLabel}
        </label>
        <textarea
          id="invoice-cancel-reason"
          ref={textareaRef}
          className={styles.cancelReasonInput}
          placeholder={STRINGS.invoices.cancelReasonPlaceholder}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={submitting}
          data-testid="invoice-cancel-reason-input"
          required
        />
        {(localError ?? errorMessage) && (
          <div className={styles.errorBanner} role="alert">
            {localError ?? errorMessage}
          </div>
        )}
        <div className={styles.formActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={onClose}
            disabled={submitting}
          >
            {STRINGS.ui.cancel}
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={handleConfirm}
            disabled={submitting}
            data-testid="invoice-cancel-confirm"
          >
            {STRINGS.invoices.cancelConfirm}
          </button>
        </div>
      </div>
    </div>
  );
}
