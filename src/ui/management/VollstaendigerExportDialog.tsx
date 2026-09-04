/**
 * Vollständiger Export dialog — server-side export-job flow
 * (ui/daten.md §8.11.1, AC-335). The browser triggers, polls, and downloads;
 * the archive is built on the VPS.
 *
 * Four phases, derived from the `exportJobStore` job + a local "tracking" flag:
 *   - preflight — start action + mobile-warning. Shown on a fresh open (the
 *     Export button) until Start is clicked and the job row arrives.
 *   - progress  — files/bytes/current-item readout while the build runs.
 *   - ready     — Range-capable download link.
 *   - failed    — the job's error_detail.
 *
 * `tracking` distinguishes a fresh open (Export button → preflight, even if a
 * prior terminal job sits in the store) from a mount-time resume of an active
 * build (DatenView auto-opens this dialog for pending/running jobs → progress).
 * It is captured from the job status AT MOUNT; DatenView conditionally mounts
 * the dialog, so each open is a fresh lifecycle. Closing never stops the
 * server-side job — the resume probe re-attaches.
 *
 * Orchestration lives in `exportJobStore`; phase render branches live in
 * `VollstaendigerExportDialog.views`. This file is the mount + a11y + phase
 * selection.
 */

import { useCallback, useRef, useState } from 'react';
import { ATTACHMENT_CONFIG } from '@/config/attachmentConfig';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useExportJobStore } from '@/state/exportJobStore';
import { useDialogA11y } from '@/ui/common/useDialogA11y';
import {
  FailedView,
  PreflightView,
  ProgressView,
  ReadyView,
} from './VollstaendigerExportDialog.views';

interface VollstaendigerExportDialogProps {
  onClose: () => void;
}

export function VollstaendigerExportDialog({ onClose }: VollstaendigerExportDialogProps) {
  const isMobile = useMediaQuery(
    `(max-width: ${ATTACHMENT_CONFIG.exportAllMobileWarningBreakpointPx}px)`,
  );
  const [startClicked, setStartClicked] = useState<boolean>(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const buttonFocusRef = useRef<HTMLButtonElement>(null);
  const anchorFocusRef = useRef<HTMLAnchorElement>(null);

  const job = useExportJobStore((s) => s.job);
  const start = useExportJobStore((s) => s.start);
  const downloadPath = useExportJobStore((s) => s.downloadPath);

  // Job status captured at mount (lazy useState — read freely during render):
  // a dialog opened onto an active build (DatenView auto-opens for
  // pending/running) resumes straight to progress; a fresh open (Export button,
  // job null or terminal) shows preflight first.
  const [jobStatusAtMount] = useState(() => job?.status);

  const onStart = useCallback(() => {
    setStartClicked(true);
    void (async () => {
      await start();
      // A non-409 failure produced no job — re-enable the preflight so the user
      // can retry. A 409 re-attach or a success leaves `job` set, so the
      // derivation moves to progress and Start is no longer rendered.
      if (!useExportJobStore.getState().job) setStartClicked(false);
    })();
  }, [start]);

  // Escape closes in every phase: closing never stops the server-side job —
  // the build continues and the mount-time resume probe re-attaches.
  useDialogA11y({
    isOpen: true,
    dialogRef,
    onOpenedFocus: useCallback(() => {
      (anchorFocusRef.current ?? buttonFocusRef.current)?.focus();
    }, []),
    onEscape: onClose,
  });

  const isResume = jobStatusAtMount === 'pending' || jobStatusAtMount === 'running';
  const tracking = isResume || startClicked;

  // Preflight until we have a job to track: a fresh open, or the brief window
  // after Start before the pending row arrives (Start is disabled meanwhile).
  if (!tracking || !job) {
    return (
      <PreflightView
        isMobile={isMobile}
        startDisabled={startClicked}
        dialogRef={dialogRef}
        initialFocusRef={buttonFocusRef}
        onCancel={onClose}
        onStart={onStart}
      />
    );
  }

  if (job.status === 'ready') {
    return (
      <ReadyView
        job={job}
        downloadHref={downloadPath(job.id)}
        dialogRef={dialogRef}
        initialFocusRef={anchorFocusRef}
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

  // pending | running
  return (
    <ProgressView
      job={job}
      dialogRef={dialogRef}
      initialFocusRef={buttonFocusRef}
      onClose={onClose}
    />
  );
}
