/**
 * Vollständiger Import dialog — server-side import-job flow
 * (ui/daten.md §8.11.2, AC-335/AC-161). The browser confirms, uploads the
 * archive to the VPS, then polls; the restore runs on the VPS.
 *
 * Five phases, derived from the `importJobStore` job + the picked `file`:
 *   - confirm    — destructive notice + confirmation-phrase gate + mobile
 *                  warning. Shown on a fresh open (DatenView mounts this with a
 *                  picked archive) while no job exists yet. No client dry-run
 *                  (AC-161): the phrase gate is unconditional. Start is disabled
 *                  until the typed value matches the configured phrase and while
 *                  a create/upload is in flight.
 *   - uploading  — client→VPS resumable upload (`uploadOffset` / `bytesTotal`).
 *   - processing — server restore readout (files-done/total + current item).
 *   - summary    — restored count (+ skipped).
 *   - failed     — the job's error_detail.
 *
 * Two open modes, distinguished by the job status captured AT MOUNT:
 *   - Fresh import: a picked `file`, no active job → confirm → create → upload.
 *   - Re-attach: `file` is null; DatenView auto-opens onto an already
 *     running/terminal job (after a reload or post-wipe re-login) → straight to
 *     processing/summary, no upload. The mount snapshot also keeps a fresh open
 *     on `confirm` even when a PRIOR terminal job still sits in the store.
 *
 * Mid-wipe re-auth (AC-330) needs NO code here: the restore wipes `users`, the
 * store's SSE-driven refetch 401s → `handleSessionExpired` routes to login;
 * after re-login DatenView's resume probe re-attaches.
 *
 * Orchestration lives in `importJobStore`; phase render branches live in
 * `VollstaendigerImportDialog.views`. This file is the mount + a11y + phase
 * selection.
 */

import { useCallback, useRef, useState } from 'react';
import { ATTACHMENT_CONFIG } from '@/config/attachmentConfig';
import { restorePhraseMatches } from '@/config/dataExchangeConfig';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useImportJobStore } from '@/state/importJobStore';
import { useDialogA11y } from '@/ui/common/useDialogA11y';
import {
  ConfirmView,
  FailedView,
  ProcessingView,
  SummaryView,
  UploadingView,
} from './VollstaendigerImportDialog.views';

interface VollstaendigerImportDialogProps {
  /** The picked archive for a fresh import, or null in re-attach mode. */
  file: File | null;
  onClose: () => void;
}

export function VollstaendigerImportDialog({ file, onClose }: VollstaendigerImportDialogProps) {
  const isMobile = useMediaQuery(
    `(max-width: ${ATTACHMENT_CONFIG.exportAllMobileWarningBreakpointPx}px)`,
  );
  const [phraseInput, setPhraseInput] = useState<string>('');
  const [confirmClicked, setConfirmClicked] = useState<boolean>(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputFocusRef = useRef<HTMLInputElement>(null);
  const buttonFocusRef = useRef<HTMLButtonElement>(null);

  const job = useImportJobStore((s) => s.job);
  const uploadOffset = useImportJobStore((s) => s.uploadOffset);
  const createError = useImportJobStore((s) => s.createError);
  const create = useImportJobStore((s) => s.create);

  // Job status captured at mount (lazy useState — read freely during render):
  // a dialog opened onto an active/terminal job (DatenView re-attach) resumes
  // straight to its phase; a fresh open (picked `file`, no active job at mount)
  // shows `confirm` first — even if a PRIOR terminal job still sits in the
  // store.
  const [jobStatusAtMount] = useState(() => job?.status);

  // Create → upload (the load-bearing sequence). Always `override: true` — a
  // full-account restore is always destructive. A create-time rejection
  // (`confirmation_mismatch` / `target_not_empty`) re-enables Start and surfaces
  // the mismatch copy; otherwise the upload begins, the server flips the job to
  // `running`, and the SSE refetch advances the dialog into processing → summary.
  const onConfirm = useCallback(async () => {
    if (!file) return;
    setConfirmClicked(true);
    await create({ file, override: true, phrase: phraseInput });
    const s = useImportJobStore.getState();
    if (s.createError !== null) {
      setConfirmClicked(false);
      return;
    }
    if (s.job) {
      await s.upload(file);
    }
  }, [create, file, phraseInput]);

  // Phase the dialog will render — needed by a11y (Escape is blocked only while
  // an active client upload is in flight).
  const isResume =
    jobStatusAtMount === 'pending' ||
    jobStatusAtMount === 'running' ||
    jobStatusAtMount === 'ready' ||
    jobStatusAtMount === 'failed';
  const tracking = isResume || confirmClicked;
  const inUploadingPhase = tracking && job?.status === 'pending';

  // Escape closes in every phase EXCEPT `uploading`: closing during an active
  // client upload would abandon bytes mid-stream. Confirm/processing/summary/
  // failed are safe — the job is server-side or not yet started, and the
  // resume probe re-attaches.
  useDialogA11y({
    isOpen: true,
    dialogRef,
    onOpenedFocus: useCallback(() => {
      (inputFocusRef.current ?? buttonFocusRef.current)?.focus();
    }, []),
    onEscape: inUploadingPhase ? undefined : onClose,
  });

  // Confirm until we have a job to track: a fresh open (or the brief window
  // after Start before the pending row arrives — Start is disabled meanwhile).
  if (!tracking || !job) {
    // Re-attach with no job yet AND no file = nothing to confirm; bail out
    // (the resume probe will re-open once it lands a job). A fresh open always
    // carries a `file`.
    if (!file) return null;
    return (
      <ConfirmView
        isMobile={isMobile}
        phraseInput={phraseInput}
        onPhraseInputChange={setPhraseInput}
        phraseMatches={restorePhraseMatches(phraseInput)}
        startDisabled={confirmClicked}
        showMismatch={createError !== null}
        dialogRef={dialogRef}
        initialFocusRef={inputFocusRef}
        onCancel={onClose}
        onConfirm={onConfirm}
      />
    );
  }

  if (job.status === 'ready') {
    return (
      <SummaryView
        job={job}
        dialogRef={dialogRef}
        initialFocusRef={buttonFocusRef}
        onClose={onClose}
      />
    );
  }

  if (job.status === 'failed') {
    return (
      <FailedView
        job={job}
        dialogRef={dialogRef}
        initialFocusRef={buttonFocusRef}
        onClose={onClose}
      />
    );
  }

  if (job.status === 'running') {
    return (
      <ProcessingView
        job={job}
        dialogRef={dialogRef}
        initialFocusRef={buttonFocusRef}
        onClose={onClose}
      />
    );
  }

  // pending — the client→VPS upload.
  return (
    <UploadingView
      job={job}
      uploadOffset={uploadOffset}
      dialogRef={dialogRef}
      initialFocusRef={buttonFocusRef}
      onClose={onClose}
    />
  );
}
