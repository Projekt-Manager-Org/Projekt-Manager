/**
 * Upload CTA — photos + documents, side-by-side groups so the
 * Beschriftung dropdown clearly belongs to documents only. Photos
 * support multi-select (one dispatch per file, shared label `foto`).
 *
 * The "Foto aufnehmen" camera-capture affordance has moved to the
 * detail page's floating button in `ProjectDetailPage.tsx` — it's not
 * rendered here anymore.
 */

import { useMemo, useRef, useState } from 'react';
import { STRINGS } from '@/config/strings';
import { ATTACHMENT_LABELS, ATTACHMENT_MIME_WHITELIST } from '@/domain/attachments';
import type { AttachmentLabel } from '@/domain/types';
import { useAttachmentStore } from '@/state/attachmentStore';
import styles from './ProjectDetail.module.css';

interface UploadCtaProps {
  projectId: string;
}

const PHOTO_MIME_ACCEPT = ATTACHMENT_MIME_WHITELIST.filter((m) => m.startsWith('image/')).join(',');
const BINARY_MIME_ACCEPT = ATTACHMENT_MIME_WHITELIST.filter((m) => !m.startsWith('image/')).join(
  ',',
);

// Document labels are the non-photo subset of the closed enum. The
// photo block hardcodes `foto`; only documents let the user pick.
const BINARY_LABELS = ATTACHMENT_LABELS.filter((l) => l.value !== 'foto');

function mimeIsPhoto(mime: string): boolean {
  return mime.startsWith('image/');
}

export function UploadCta({ projectId }: UploadCtaProps) {
  const pendingUploads = useAttachmentStore((s) => s.pendingUploads);
  const uploadFile = useAttachmentStore((s) => s.uploadFile);
  const retryUpload = useAttachmentStore((s) => s.retryUpload);
  const dismissUpload = useAttachmentStore((s) => s.dismissUpload);

  // Document label picker. Initialized to a sensible default; photo
  // uploads ignore this value and use `foto` unconditionally.
  const [binaryLabel, setBinaryLabel] = useState<AttachmentLabel>('sonstiges');
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  const [ackedClientIds, setAckedClientIds] = useState<Set<string>>(new Set());
  const [validationError, setValidationError] = useState<string | null>(null);

  const myPending = useMemo(() => {
    return Object.values(pendingUploads).filter((p) => p.projectId === projectId);
  }, [pendingUploads, projectId]);

  const failed = myPending.find((p) => p.status === 'failed' && !ackedClientIds.has(p.clientId));

  const isAllowedMime = (mime: string): boolean =>
    (ATTACHMENT_MIME_WHITELIST as readonly string[]).includes(mime);

  const dispatchUpload = (file: File, label: AttachmentLabel): void => {
    if (!isAllowedMime(file.type)) {
      setValidationError(STRINGS.attachments.uploadMimeNotAllowed);
      return;
    }
    setValidationError(null);
    void uploadFile(projectId, file, {
      label,
      hasThumbnail: mimeIsPhoto(file.type),
    });
  };

  const dispatchPhotos = (files: File[]) => {
    for (const file of files) {
      dispatchUpload(file, 'foto');
    }
  };

  const dispatchBinary = (file: File) => {
    dispatchUpload(file, binaryLabel);
  };

  const handlePhotoPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    dispatchPhotos(files);
    e.target.value = '';
  };

  const handleBinaryPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    dispatchBinary(file);
    e.target.value = '';
  };

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;
    // Split by MIME: photos use the `foto` label, docs use the picker's
    // current selection. A mixed drop is ergonomically valid — users
    // dragging from Finder may bundle both.
    const photos = files.filter((f) => mimeIsPhoto(f.type));
    const binaries = files.filter((f) => !mimeIsPhoto(f.type));
    if (photos.length > 0) dispatchPhotos(photos);
    if (binaries.length > 0) binaries.forEach(dispatchBinary);
  };

  const handleRetry = () => {
    if (!failed) return;
    setAckedClientIds((prev) => {
      if (!prev.has(failed.clientId)) return prev;
      const next = new Set(prev);
      next.delete(failed.clientId);
      return next;
    });
    void retryUpload(failed.clientId);
  };

  const handleDismiss = () => {
    if (failed) dismissUpload(failed.clientId);
  };

  const bannerMessage = failed?.errorMessage ?? null;
  // Retry is only actionable for transient errors. A size-cap failure
  // will fail again for the same file, so we drop the retry button
  // and leave only the dismiss affordance — the user has to pick a
  // smaller file, there is nothing to retry.
  const retryActionable = bannerMessage !== STRINGS.attachments.uploadFileTooLarge;

  return (
    <section
      aria-label={STRINGS.attachments.upload}
      data-testid="project-detail-upload-cta"
      className={styles.uploadSection}
    >
      <h3 className={styles.regionHeading}>{STRINGS.attachments.upload}</h3>

      <div
        className={`${styles.uploadDropZone}${dragActive ? ' ' + styles.uploadDropZoneActive : ''}`}
        data-testid="upload-drop-zone"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <p className={styles.uploadDropHint}>{STRINGS.attachments.uploadDrop}</p>

        <div className={styles.uploadGroups}>
          {/* Photos group — multi-select, no label picker. */}
          <div className={styles.uploadGroup} data-testid="upload-group-photos">
            <h4 className={styles.uploadGroupHeading}>{STRINGS.attachments.photoSectionTitle}</h4>
            <div className={styles.uploadGroupControls}>
              <label className={styles.fileLabel}>
                {STRINGS.attachments.uploadPickPhotos}
                <input
                  type="file"
                  data-testid="attachment-photo-input"
                  accept={PHOTO_MIME_ACCEPT}
                  multiple
                  onChange={handlePhotoPick}
                  className={styles.fileInput}
                />
              </label>
            </div>
          </div>

          {/* Documents group — label picker belongs to this block. */}
          <div className={styles.uploadGroup} data-testid="upload-group-binary">
            <h4 className={styles.uploadGroupHeading}>{STRINGS.attachments.binarySectionTitle}</h4>
            <div className={styles.uploadGroupControls}>
              <label className={styles.fileLabel}>
                {STRINGS.attachments.uploadPickBinary}
                <input
                  type="file"
                  data-testid="attachment-binary-input"
                  accept={BINARY_MIME_ACCEPT}
                  onChange={handleBinaryPick}
                  className={styles.fileInput}
                />
              </label>

              <label className={styles.labelWrapper}>
                <span>{STRINGS.attachments.uploadLabel}</span>
                <select
                  data-testid="upload-label-select"
                  value={binaryLabel}
                  onChange={(e) => setBinaryLabel(e.target.value as AttachmentLabel)}
                  className={styles.labelSelect}
                >
                  {BINARY_LABELS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        </div>
      </div>

      <div
        role="status"
        aria-live="polite"
        data-testid="upload-progress-region"
        className={styles.progressRegion}
      >
        {myPending
          .filter((p) => p.status !== 'failed')
          .map((p) => (
            <div key={p.clientId} className={styles.progressRow}>
              {progressLabel(p.status)} — {p.fileName}
            </div>
          ))}
      </div>

      {validationError && (
        <div className={styles.errorBanner} data-testid="upload-validation-banner" role="alert">
          <span>{validationError}</span>
          <button
            type="button"
            className={styles.dismissButton}
            onClick={() => setValidationError(null)}
            aria-label={STRINGS.attachments.uploadDismiss}
          >
            ×
          </button>
        </div>
      )}

      {bannerMessage && (
        <div className={styles.errorBanner} data-testid="upload-error-banner" role="alert">
          <span>{bannerMessage}</span>
          {retryActionable && (
            <button
              type="button"
              className={styles.retryButton}
              data-testid="upload-retry"
              onClick={handleRetry}
            >
              {STRINGS.attachments.uploadRetry}
            </button>
          )}
          <button
            type="button"
            className={styles.dismissButton}
            onClick={handleDismiss}
            aria-label={STRINGS.attachments.uploadDismiss}
          >
            ×
          </button>
        </div>
      )}
    </section>
  );
}

function progressLabel(status: 'initializing' | 'uploading' | 'completing' | 'failed'): string {
  switch (status) {
    case 'initializing':
      return STRINGS.attachments.uploadProgressInit;
    case 'uploading':
      return STRINGS.attachments.uploadProgressUpload;
    case 'completing':
      return STRINGS.attachments.uploadProgressComplete;
    default:
      return '';
  }
}
