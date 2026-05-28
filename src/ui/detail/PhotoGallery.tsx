/**
 * Photo gallery — ready photos rendered via the synthetic-origin
 * Service-Worker decrypt path (ADR-0024, spec §8.15.4 / §8.15.7).
 *
 * Each `<img src>` points at `/encrypted-storage/<projectId>/<id>.thumbnail`;
 * the SW intercepts, calls `download-url`, fetches ciphertext, decrypts,
 * and serves plaintext bytes. The component never calls `download-url`
 * itself — that is the SW's job per AC-243.
 *
 * Two failure-mode placeholders, distinguished by the SW's
 * `data-sw-error-code` attribute on the failing `<img>`:
 *   - `OBJECT_ABSENT` → AC-224 `"Datei fehlt"`
 *   - `DEK_UNWRAP_FAILED` → AC-244 `"Schlüssel nicht verfügbar"`
 *
 * List fetching goes through the attachment store; this component is a
 * thin renderer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { STRINGS } from '@/config/strings';
import { ATTACHMENT_CONFIG } from '@/config/attachmentConfig';
import type { Attachment } from '@/domain/types';
import { canDeleteAttachment } from '@/domain/attachments';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { useAttachmentStore } from '@/state/attachmentStore';
import { useAuthStore } from '@/state/authStore';
import { useConfirmStore } from '@/state/confirmStore';
import { formatDateDE } from '@/domain/dateFormat';
import { synthAttachmentUrl } from '@/sw/syntheticOrigin';
import styles from './ProjectDetail.module.css';

interface PhotoGalleryProps {
  projectId: string;
  /** Archived project — suppresses the per-row delete control. */
  archived?: boolean;
}

type RowError = 'object-absent' | 'key-unavailable';

export function PhotoGallery({ projectId, archived = false }: PhotoGalleryProps) {
  // Select the raw per-project slice then filter inline so the
  // selector output is referentially stable across renders — a new
  // filtered array each render confuses Zustand's snapshot cache and
  // triggers React's "getSnapshot should be cached" warning.
  const rows = useAttachmentStore((s) => s.byProject[projectId]);
  const photos = useMemo<Attachment[]>(
    () => (rows ?? []).filter((a) => a.status === 'ready' && a.kind === 'photo'),
    [rows],
  );
  const fetchForProject = useAttachmentStore((s) => s.fetchForProject);
  const hideAttachment = useAttachmentStore((s) => s.hideAttachment);
  const authUser = useAuthStore((s) => s.authUser);

  const handleDelete = async (photo: Attachment) => {
    const ok = await useConfirmStore.getState().request(STRINGS.attachments.deleteConfirmMessage, {
      title: STRINGS.attachments.deleteConfirmTitle,
    });
    if (!ok) return;
    await hideAttachment(projectId, photo.id);
  };

  // Per-row error state, set by `<img onError>`. Spec §8.15.7 forbids
  // caching this verdict — a list refetch that re-emits the same row id
  // wipes the entry; the SW re-probes on the next render.
  const [rowErrors, setRowErrors] = useState<Record<string, RowError>>({});
  const [lightbox, setLightbox] = useState<{ attachmentId: string; url: string } | null>(null);
  // Focus-restore target: the thumbnail button that opened the lightbox.
  // Captured at open-time; restored when the lightbox closes so keyboard
  // users don't get dropped at document root.
  const lightboxOpenerRef = useRef<HTMLElement | null>(null);
  const lightboxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void fetchForProject(projectId);
  }, [fetchForProject, projectId]);

  // Drop stale row-error verdicts when the underlying photo set changes
  // — spec §8.15.7 forbids client-side caching of the missing/unwrap
  // verdict across list refetches. React's documented "adjust state on
  // prop change during render" pattern (https://react.dev/reference/react/useState#storing-information-from-previous-renders);
  // an effect-based reset would re-render once, then setState, then
  // re-render again — wasted work flagged by `react-hooks/set-state-in-effect`.
  const [prevPhotos, setPrevPhotos] = useState(photos);
  if (prevPhotos !== photos) {
    setPrevPhotos(photos);
    const ids = new Set(photos.map((p) => p.id));
    setRowErrors((prev) => {
      let changed = false;
      const next: Record<string, RowError> = {};
      for (const [id, err] of Object.entries(prev)) {
        if (ids.has(id)) {
          next[id] = err;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }

  const handleImgError = (photoId: string, target: HTMLElement | null) => {
    // SW signals divergence via `data-sw-error-code` on the failing
    // `<img>` element (spec §8.15.7 "Failure-mode signal contract").
    // The two pinned values are `OBJECT_ABSENT` and `DEK_UNWRAP_FAILED`.
    const code = target?.getAttribute('data-sw-error-code');
    const verdict: RowError = code === 'DEK_UNWRAP_FAILED' ? 'key-unavailable' : 'object-absent';
    setRowErrors((prev) => ({ ...prev, [photoId]: verdict }));
  };

  const handleOpenLightbox = (photo: Attachment, trigger: HTMLElement | null): void => {
    // Capture the trigger so focus can return on close.
    lightboxOpenerRef.current = trigger;
    setLightbox({
      attachmentId: photo.id,
      url: synthAttachmentUrl(projectId, photo.id, 'original'),
    });
  };

  const closeLightbox = useCallback((): void => {
    setLightbox(null);
  }, []);

  // Esc-to-close via the shared, stack-aware escape registry — so a
  // lightbox opened over a modal dismisses only the lightbox.
  useEscapeKey(closeLightbox, Boolean(lightbox));

  // Focus management: pull focus into the lightbox on open, restore it
  // to the trigger on close.
  useEffect(() => {
    if (!lightbox) {
      const opener = lightboxOpenerRef.current;
      if (opener && typeof opener.focus === 'function') {
        opener.focus();
      }
      lightboxOpenerRef.current = null;
      return;
    }
    lightboxRef.current?.focus();
  }, [lightbox]);

  /**
   * Accessible label for the thumbnail button. AC-image is the filename,
   * which is noise for screen-reader users. Prefer the date (human-readable)
   * and fall back to the German label; the filename is suppressed.
   */
  const thumbButtonLabel = (photo: Attachment): string => {
    const dateText = formatDateDE(photo.createdAt);
    return `${STRINGS.attachments.photoGallery} — ${dateText}`;
  };

  return (
    <section
      aria-label={STRINGS.attachments.photoGallery}
      data-testid="project-detail-photos"
      className={styles.photoSection}
    >
      <h3 className={styles.regionHeading}>{STRINGS.attachments.photoGallery}</h3>
      {photos.length === 0 ? (
        <div className={styles.emptyState}>{STRINGS.ui.noResults}</div>
      ) : (
        <ul className={styles.photoGrid}>
          {photos.map((photo) => {
            const error = rowErrors[photo.id];
            if (error === 'key-unavailable') {
              // AC-244: envelope unwrap failed. Distinct placeholder
              // because the operator remediation is to restore the
              // matching binary `age` identity, not to investigate
              // storage. `data-bulk-eligible="false"` excludes the row
              // from any future bulk-fetch selection (spec §8.15.7).
              return (
                <li
                  key={photo.id}
                  className={styles.photoMissing}
                  data-testid={`photo-key-unavailable-${photo.id}`}
                  data-bulk-eligible="false"
                >
                  {STRINGS.attachments.keyUnavailable}
                </li>
              );
            }
            if (error === 'object-absent') {
              // AC-224: storage 404 on the ciphertext fetch. Same
              // exclusion rule — drop from bulk-fetch selection.
              return (
                <li
                  key={photo.id}
                  className={styles.photoMissing}
                  data-testid={`photo-missing-${photo.id}`}
                  data-bulk-eligible="false"
                >
                  {STRINGS.attachments.fileMissing}
                </li>
              );
            }
            const canDelete =
              authUser !== null &&
              !archived &&
              canDeleteAttachment(photo, authUser, ATTACHMENT_CONFIG.workerSelfDeleteGraceMinutes);
            const thumbSrc = synthAttachmentUrl(projectId, photo.id, 'thumbnail');
            return (
              <li key={photo.id} className={styles.photoItem} data-testid="attachment-thumbnail">
                <button
                  type="button"
                  className={styles.photoThumb}
                  data-testid={`photo-thumb-${photo.id}`}
                  aria-label={thumbButtonLabel(photo)}
                  onClick={(e) => handleOpenLightbox(photo, e.currentTarget as HTMLElement)}
                >
                  {/* alt="" because the button's aria-label carries the
                      accessible name; a non-empty alt would double-announce.
                      The SW intercepts this `<img>`'s ciphertext fetch and
                      returns plaintext bytes through the Fetch response. */}
                  <img
                    src={thumbSrc}
                    alt=""
                    onError={(e) => handleImgError(photo.id, e.currentTarget)}
                  />
                </button>
                {canDelete && (
                  <button
                    type="button"
                    data-testid="attachment-delete"
                    className={styles.deleteButton}
                    onClick={() => void handleDelete(photo)}
                    aria-label={STRINGS.ui.delete}
                  >
                    {STRINGS.ui.delete}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {lightbox && (
        <div
          ref={lightboxRef}
          className={styles.lightbox}
          data-testid="photo-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={STRINGS.attachments.photoGallery}
          // Negative-tab-index makes the container programmatically
          // focusable so the open-effect can pull focus inside; Tab
          // cycles through the close button and wraps within the container.
          tabIndex={-1}
        >
          <button
            type="button"
            className={styles.previewClose}
            onClick={closeLightbox}
            aria-label={STRINGS.ui.close}
            data-testid="photo-lightbox-close"
          >
            ×
          </button>
          <img src={lightbox.url} alt="" />
        </div>
      )}
    </section>
  );
}
