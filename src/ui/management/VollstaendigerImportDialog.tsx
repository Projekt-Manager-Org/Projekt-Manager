/**
 * Vollständiger Import dialog — server-side import-job flow
 * (ui/daten.md §8.11.2, AC-161). The browser confirms, uploads the
 * archive to the VPS, then polls; the restore runs on the VPS.
 *
 * Five phases, derived from the `importJobStore` job + the picked `file`:
 *   - confirm    — destructive notice + confirmation-phrase gate + mobile
 *                  warning. Shown on a fresh open (DatenView mounts this with a
 *                  picked archive) while no job exists yet. The phrase gate is
 *                  unconditional (AC-161). Start is disabled until the typed
 *                  value matches the configured phrase and while a
 *                  create/upload is in flight.
 *   - uploading  — client→VPS resumable upload (`uploadOffset` / `bytesTotal`).
 *   - processing — server restore readout (files-done/total + current item).
 *   - summary    — restored count.
 *   - failed     — the job's error_detail.
 *
 * Three open modes, distinguished by the job status captured AT MOUNT:
 *   - Fresh import: a picked `file`, no active job → confirm → create → upload.
 *   - Continue: a picked `file` while an upload is `pending` → confirm →
 *     create re-attaches → upload resumes at the server's offset (AC-609).
 *   - Re-attach: `file` is null; DatenView auto-opens onto an already
 *     pending/running/terminal job (after a reload or post-wipe re-login) →
 *     straight to its phase, no upload.
 *
 * A picked `file` never shows an earlier job's result, so a PRIOR TERMINAL job never
 * takes over the dialog — `latest('import')` keeps returning the finished row,
 * and letting it render its summary made the restore usable exactly once per
 * deployment.
 *
 * Mid-wipe re-auth (AC-597) needs NO code here: the restore wipes `users`, the
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
  const uploading = useImportJobStore((s) => s.uploading);
  const createError = useImportJobStore((s) => s.createError);
  const create = useImportJobStore((s) => s.create);

  // Job present at mount (lazy useState — read freely during render): a dialog
  // opened onto an active/terminal job (DatenView re-attach, `file === null`)
  // resumes straight to its phase.
  const [priorJob] = useState(() => job);

  // A picked `file` is an explicit NEW-import intent, so a PRIOR TERMINAL job
  // must not hijack the dialog into its summary. It used to: `latest('import')`
  // keeps returning the finished row, so after one successful restore every
  // subsequent open rendered that summary and the confirm gate was
  // unreachable — the restore was a once-per-deployment action. `showingPriorJob`
  // also covers the window between Start and the new job row landing, so the
  // stale summary cannot flash either.
  const priorTerminal =
    file !== null && (priorJob?.status === 'ready' || priorJob?.status === 'failed');
  const showingPriorJob = priorTerminal && job?.id === priorJob?.id;

  // A picked file while an upload is in progress continues that upload
  // (AC-609): confirm first, then create answers IMPORT_JOB_ACTIVE, the store
  // re-attaches and `upload` resumes at the server's offset. A file of another
  // size cannot be that archive (AC-610) — judged on the live job, until Start.
  const priorPending = file !== null && priorJob?.status === 'pending';
  const sizeMismatch =
    file !== null && !confirmClicked && job?.status === 'pending' && file.size !== job.bytesTotal;

  // Create → upload (the load-bearing sequence). Always `override: true` — a
  // full-account restore is always destructive. A create-time rejection
  // (`confirmation_mismatch` / `target_not_empty`) re-enables Start and surfaces
  // the mismatch copy; otherwise the upload begins, the server flips the job to
  // `running`, and the SSE refetch advances the dialog into processing → summary.
  const onConfirm = useCallback(async () => {
    if (!file || sizeMismatch) return;
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
  }, [create, file, phraseInput, sizeMismatch]);

  // Phase the dialog will render.
  const isResume =
    !priorTerminal &&
    !priorPending &&
    (priorJob?.status === 'pending' ||
      priorJob?.status === 'running' ||
      priorJob?.status === 'ready' ||
      priorJob?.status === 'failed');
  const tracking = isResume || confirmClicked;

  // Escape closes in every phase EXCEPT an active client upload: closing then
  // would abandon bytes mid-stream. Confirm/processing/summary/
  // failed are safe — the job is server-side or not yet started, and the
  // resume probe re-attaches.
  useDialogA11y({
    isOpen: true,
    dialogRef,
    onOpenedFocus: useCallback(() => {
      (inputFocusRef.current ?? buttonFocusRef.current)?.focus();
    }, []),
    onEscape: uploading ? undefined : onClose,
  });

  // Confirm until we have a job to track: a fresh open (or the brief window
  // after Start before the pending row arrives — Start is disabled meanwhile).
  if (!tracking || !job || showingPriorJob) {
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
        sizeMismatch={sizeMismatch}
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
      uploading={uploading}
      dialogRef={dialogRef}
      initialFocusRef={buttonFocusRef}
      onClose={onClose}
    />
  );
}
