/**
 * Import dialog — parsing → preflight → progress → summary
 * (ui/daten.md §8.11.2, AC-259/AC-260).
 *
 * Five phases:
 *   1. parsing       — hook reads + parses zip + dry-runs API. Spinner.
 *   2. preflight     — parsed envelope-counts readout + (when target
 *                      non-empty) destructive-action confirmation
 *                      phrase input. Confirm dispatches the text-leg
 *                      and per-attachment legs.
 *   3. progress      — files-done / total + bytes-done / total + current
 *                      filename + Abbrechen action.
 *   4. summary       — restored counts + per-file failure list.
 *   5. error         — pre-flight or text-leg rejection surfaces here.
 *
 * The parent owns the file-picker step (see DatenView): it triggers a
 * hidden <input type="file"> from the Import button and only mounts
 * this dialog once a file has been selected. This file accepts the
 * file as a prop and threads it to `useImportAllRunner` for the
 * parse-on-mount flow.
 *
 * Orchestration (state machine, zip parse, dry-run, orchestrator
 * dispatch) lives in `useImportAllRunner`; phase render branches live
 * in `VollstaendigerImportDialog.views`. This file is the dialog mount
 * + a11y wiring.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ATTACHMENT_CONFIG } from '@/config/attachmentConfig';
import { endSessionExpiredSuppression, handleSessionExpired } from '@/state/sessionExpired';
import { useDialogA11y } from '@/ui/common/useDialogA11y';
import { useImportAllRunner } from './useImportAllRunner';
import {
  ErrorView,
  ParsingView,
  PreflightView,
  ProgressView,
  SummaryView,
  TokenInvalidView,
} from './VollstaendigerImportDialog.views';

interface VollstaendigerImportDialogProps {
  file: File;
  onClose: () => void;
}

function probeIsMobile(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia(`(max-width: ${ATTACHMENT_CONFIG.exportAllMobileWarningBreakpointPx}px)`)
    .matches;
}

export function VollstaendigerImportDialog({ file, onClose }: VollstaendigerImportDialogProps) {
  const [isMobile, setIsMobile] = useState<boolean>(probeIsMobile);
  const [phraseInput, setPhraseInput] = useState<string>('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialFocusButtonRef = useRef<HTMLButtonElement>(null);

  const { phase, start, cancel } = useImportAllRunner({ file });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(
      `(max-width: ${ATTACHMENT_CONFIG.exportAllMobileWarningBreakpointPx}px)`,
    );
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  const handleClose = useCallback(() => {
    cancel();
    // On the override-with-users path the server returned
    // `sessionInvalidated: true` (the user-wipe CASCADEd the session
    // row). On the token-invalid phase the bearer itself was
    // rejected — same end state, operator must re-auth. Trigger the
    // global session-expired redirect on close so the next API call
    // doesn't get a surprise 401.
    const needsReauth =
      (phase.kind === 'summary' && phase.sessionInvalidated) || phase.kind === 'token-invalid';
    // End suppression BEFORE the explicit redirect — the runner kept
    // it active across the summary phase to swallow racing 401s from
    // background fetches (storage-usage refresh, SSE-driven project
    // list reload). Without ending it first, the synchronous
    // `handleSessionExpired()` below would be no-op'd. Idempotent at
    // depth 0, so the non-invalidating paths see it as a noop.
    if (needsReauth) {
      endSessionExpiredSuppression();
    }
    onClose();
    if (needsReauth) {
      handleSessionExpired();
    }
  }, [cancel, onClose, phase]);

  // Safety net — if the operator navigates away while the runner had
  // suppression active (e.g. tab-close mid-progress on the override
  // path), drop the suppression so the next page render's
  // session-expiry handling works normally.
  useEffect(() => {
    return () => {
      endSessionExpiredSuppression();
    };
  }, []);

  const escapeAllowed =
    phase.kind === 'parsing' ||
    phase.kind === 'preflight' ||
    phase.kind === 'summary' ||
    phase.kind === 'error' ||
    phase.kind === 'token-invalid';
  useDialogA11y({
    isOpen: true,
    dialogRef,
    onOpenedFocus: useCallback(() => {
      initialFocusButtonRef.current?.focus();
    }, []),
    onEscape: escapeAllowed ? handleClose : undefined,
  });

  if (phase.kind === 'parsing') {
    return <ParsingView phase={phase} dialogRef={dialogRef} />;
  }

  if (phase.kind === 'preflight') {
    return (
      <PreflightView
        phase={phase}
        isMobile={isMobile}
        dialogRef={dialogRef}
        initialFocusRef={initialFocusButtonRef}
        phraseInput={phraseInput}
        onPhraseInputChange={setPhraseInput}
        onCancel={handleClose}
        onConfirm={() => start(phraseInput)}
      />
    );
  }

  if (phase.kind === 'progress') {
    return (
      <ProgressView
        phase={phase}
        dialogRef={dialogRef}
        initialFocusRef={initialFocusButtonRef}
        onCancel={handleClose}
      />
    );
  }

  if (phase.kind === 'summary') {
    return (
      <SummaryView
        phase={phase}
        dialogRef={dialogRef}
        initialFocusRef={initialFocusButtonRef}
        onClose={handleClose}
      />
    );
  }

  if (phase.kind === 'token-invalid') {
    return (
      <TokenInvalidView
        phase={phase}
        dialogRef={dialogRef}
        initialFocusRef={initialFocusButtonRef}
        onClose={handleClose}
      />
    );
  }

  return (
    <ErrorView
      phase={phase}
      dialogRef={dialogRef}
      initialFocusRef={initialFocusButtonRef}
      onClose={handleClose}
    />
  );
}
