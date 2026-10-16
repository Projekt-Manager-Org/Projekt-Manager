/**
 * Accessible confirmation dialog. Mounted once at the App root; controlled
 * by `useConfirmStore`. See state/confirmStore.ts for the imperative API.
 *
 * Accessibility behaviours (focus trap / restoration / scroll lock /
 * Escape) are owned by the shared `useDialogA11y` hook. This component
 * supplies the dialog-specific bits: `aria-labelledby` / `aria-describedby`
 * targets, the initial-focus ref, and the Escape callback (resolve(false)).
 */

import { useCallback, useRef } from 'react';
import { useConfirmStore } from '@/state/confirmStore';
import { useDialogA11y } from './useDialogA11y';
import styles from './ConfirmDialog.module.css';

const TITLE_ID = 'confirm-dialog-title';
const MESSAGE_ID = 'confirm-dialog-message';

export function ConfirmDialog() {
  const isOpen = useConfirmStore((s) => s.isOpen);
  const title = useConfirmStore((s) => s.title);
  const message = useConfirmStore((s) => s.message);
  const confirmLabel = useConfirmStore((s) => s.confirmLabel);
  const cancelLabel = useConfirmStore((s) => s.cancelLabel);
  const details = useConfirmStore((s) => s.details);
  const resolve = useConfirmStore((s) => s.resolve);

  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  const onEscape = useCallback(() => resolve(false), [resolve]);
  const onOpenedFocus = useCallback(() => confirmBtnRef.current?.focus(), []);

  useDialogA11y({ isOpen, dialogRef, onOpenedFocus, onEscape });

  if (!isOpen) return null;

  return (
    <div className={styles.overlay} data-testid="confirm-overlay">
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        aria-describedby={MESSAGE_ID}
        data-testid="confirm-dialog"
      >
        <h2 id={TITLE_ID} className={styles.title}>
          {title}
        </h2>
        <p id={MESSAGE_ID} className={styles.message}>
          {message}
        </p>
        {details}
        <div className={styles.actions}>
          <button
            type="button"
            className={`${styles.button} ${styles.cancel}`}
            onClick={() => resolve(false)}
            data-testid="confirm-cancel"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            className={`${styles.button} ${styles.confirm}`}
            onClick={() => resolve(true)}
            data-testid="confirm-ok"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
