/**
 * Binary list — tabular view of ready non-photo attachments. Per-row
 * download + bulk-fetch ZIP under the synthetic-origin Service-Worker
 * decrypt path (ADR-0024, spec §8.15.5 / §8.15.7).
 *
 * Per-row download issues a fetch against `/encrypted-storage/<projectId>/<id>.original`;
 * the SW intercepts, calls `download-url`, fetches ciphertext, decrypts,
 * and returns plaintext bytes. On a non-2xx response the row flips to
 * one of the two divergence placeholders:
 *   - `data-sw-error-code: OBJECT_ABSENT` (or absent code) → `"Datei fehlt"` (AC-224)
 *   - `data-sw-error-code: DEK_UNWRAP_FAILED` → `"Schlüssel nicht verfügbar"` (AC-244)
 *
 * Bulk-fetch caps live in `attachmentPipeline.ts` [C]; violation
 * produces a client-side message naming both caps before any request
 * is issued (AC-223). The store's `requestBulkZipBlob` decrypts each
 * ciphertext locally and assembles a streaming zip — this component
 * then triggers a Blob-URL download.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { STRINGS } from '@/config/strings';
import { ATTACHMENT_PIPELINE } from '@/config/attachmentPipeline';
import { ATTACHMENT_CONFIG } from '@/config/attachmentConfig';
import { ATTACHMENT_LABELS, canDeleteAttachment } from '@/domain/attachments';
import type { Attachment, AttachmentLabel } from '@/domain/types';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { useAttachmentStore } from '@/state/attachmentStore';
import { useAuthStore } from '@/state/authStore';
import { useConfirmStore } from '@/state/confirmStore';
import { formatDateDE } from '@/domain/dateFormat';
import { synthAttachmentUrl } from '@/sw/syntheticOrigin';
import { triggerBlobDownload } from '@/ui/utils/downloadFile';
import styles from './ProjectDetail.module.css';

function isPdf(row: { fileName: string; mimeType?: string | null }): boolean {
  if (row.mimeType === 'application/pdf') return true;
  return row.fileName.toLowerCase().endsWith('.pdf');
}

interface BinaryListProps {
  projectId: string;
  /**
   * Filename hinted to the browser when the bulk-download anchor fires.
   * Built once by the parent (`buildProjectBundleFilename`) so the
   * "Alle herunterladen" affordance on the page header and the selection-
   * bulk button here share one naming convention.
   */
  bundleFileName: string;
  /** Archived project — suppresses per-row delete controls. */
  archived?: boolean;
}

const LABEL_BY_VALUE = new Map<AttachmentLabel, string>(
  ATTACHMENT_LABELS.map((l) => [l.value, l.label]),
);

type RowError = 'object-absent' | 'key-unavailable';

/**
 * Read the SW's `data-sw-error-code` signal off a non-2xx Response.
 * Header is the canonical channel per spec §8.15.7; the body is a
 * defense-in-depth fallback so a SW that surfaces the code via JSON
 * still works without a code change here.
 */
async function readSwErrorCode(response: Response): Promise<string | null> {
  const headerCode = response.headers.get('data-sw-error-code');
  if (headerCode) return headerCode;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) return null;
  try {
    const body = (await response.clone().json()) as { code?: unknown };
    if (typeof body.code === 'string') return body.code;
  } catch {
    /* not JSON, no code surface */
  }
  return null;
}

export function BinaryList({ projectId, bundleFileName, archived = false }: BinaryListProps) {
  // Select the raw per-project slice then filter in useMemo so the
  // selector output is referentially stable across renders.
  const rows = useAttachmentStore((s) => s.byProject[projectId]);
  const binaries = useMemo<Attachment[]>(
    () => (rows ?? []).filter((a) => a.status === 'ready' && a.kind === 'binary'),
    [rows],
  );
  const fetchForProject = useAttachmentStore((s) => s.fetchForProject);
  const requestBulkZipBlob = useAttachmentStore((s) => s.requestBulkZipBlob);
  const hideAttachment = useAttachmentStore((s) => s.hideAttachment);
  const authUser = useAuthStore((s) => s.authUser);

  const handleDelete = async (bin: Attachment) => {
    const ok = await useConfirmStore.getState().request(STRINGS.attachments.deleteConfirmMessage, {
      title: STRINGS.attachments.deleteConfirmTitle,
    });
    if (!ok) return;
    await hideAttachment(projectId, bin.id);
  };

  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Per-row error verdict observed at click-time. Spec §8.15.7 forbids
  // caching across list refetches — the effect below prunes entries no
  // longer in the live binaries list.
  const [rowErrors, setRowErrors] = useState<Record<string, RowError>>({});
  const [capError, setCapError] = useState<string | null>(null);

  useEffect(() => {
    void fetchForProject(projectId);
  }, [fetchForProject, projectId]);

  // Drop stale row-error verdicts on list change so a refetch re-probes
  // (spec §8.15.7 "no client-side caching of either verdict"). React's
  // documented "adjust state on prop change during render" pattern
  // (https://react.dev/reference/react/useState#storing-information-from-previous-renders);
  // the effect-based equivalent triggers an extra render and is flagged
  // by `react-hooks/set-state-in-effect`.
  const [prevBinaries, setPrevBinaries] = useState(binaries);
  if (prevBinaries !== binaries) {
    setPrevBinaries(binaries);
    const ids = new Set(binaries.map((b) => b.id));
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

  // Intersect the user's `selected` set with rows that are still
  // eligible (present + not erroring). Derived on render so the set
  // never disagrees with the live table; a pure useMemo avoids the
  // setState-in-effect cascade the linter guards against.
  const effectiveSelected = useMemo(() => {
    const next = new Set<string>();
    for (const id of selected) {
      if (binaries.some((b) => b.id === id) && !rowErrors[id]) next.add(id);
    }
    return next;
  }, [selected, binaries, rowErrors]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectableIds = binaries.filter((b) => !rowErrors[b.id]).map((b) => b.id);
  const allSelected =
    selectableIds.length > 0 && selectableIds.every((id) => effectiveSelected.has(id));

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectableIds));
    }
  };

  /**
   * Probe the synthetic-origin URL via `fetch`. The SW intercepts,
   * decrypts, and returns plaintext on success; on a storage 404 or
   * unwrap failure it surfaces a non-2xx Response carrying the code on
   * `data-sw-error-code`. Either way the response status is the seam
   * by which the component decides between "trigger download" and
   * "flip to placeholder" (spec §8.15.7 — lazy, click-triggered for
   * binaries).
   */
  const probeAndFetch = async (
    attachmentId: string,
  ): Promise<{ ok: true; blob: Blob } | { ok: false; verdict: RowError }> => {
    const url = synthAttachmentUrl(projectId, attachmentId, 'original');
    let response: Response;
    try {
      response = await fetch(url);
    } catch {
      return { ok: false, verdict: 'object-absent' };
    }
    if (!response.ok) {
      const code = await readSwErrorCode(response);
      const verdict: RowError = code === 'DEK_UNWRAP_FAILED' ? 'key-unavailable' : 'object-absent';
      return { ok: false, verdict };
    }
    const blob = await response.blob();
    return { ok: true, blob };
  };

  const handleDownload = async (attachmentId: string) => {
    const row = binaries.find((b) => b.id === attachmentId);
    const fileName = row?.fileName ?? '';
    const probe = await probeAndFetch(attachmentId);
    if (!probe.ok) {
      setRowErrors((prev) => ({ ...prev, [attachmentId]: probe.verdict }));
      return;
    }
    triggerBlobDownload(probe.blob, fileName);
  };

  const [preview, setPreview] = useState<{ url: string; fileName: string } | null>(null);
  // Track the blob URL lifecycle: `URL.createObjectURL` must be paired
  // with `revokeObjectURL` or the browser leaks the buffer. We revoke
  // eagerly on close and on unmount.
  const closePreview = useCallback(() => {
    setPreview((prev) => {
      if (prev && prev.url.startsWith('blob:')) URL.revokeObjectURL(prev.url);
      return null;
    });
  }, []);

  // Esc closes the preview via the shared, stack-aware escape registry.
  useEscapeKey(closePreview, Boolean(preview));

  // Revoke on unmount — covers the case where the component unmounts
  // while the preview is still open (e.g. navigation away).
  useEffect(() => {
    return () => {
      if (preview && preview.url.startsWith('blob:')) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);

  /**
   * Inline PDF preview. The synthetic-origin URL is set directly on
   * `<iframe src>`; the SW intercepts, decrypts, and returns plaintext
   * with `Content-Type: application/pdf` so the browser renders it
   * inline. No separate fetch + Blob URL plumbing needed — the SW is
   * the seam (ADR-0024 § Service-Worker decryption).
   */
  const handleView = (bin: Attachment): void => {
    setPreview({ url: synthAttachmentUrl(projectId, bin.id, 'original'), fileName: bin.fileName });
  };

  const handleBulkDownload = async () => {
    const ids = Array.from(effectiveSelected);
    const selectedRows = binaries.filter((b) => ids.includes(b.id));
    const totalBytes = selectedRows.reduce((acc, r) => acc + r.sizeBytes, 0);
    const { bulkDownloadMaxFiles, bulkDownloadMaxBytes } = ATTACHMENT_PIPELINE;
    if (ids.length > bulkDownloadMaxFiles || totalBytes > bulkDownloadMaxBytes) {
      setCapError(
        STRINGS.attachments.bulkLimitExceeded(
          bulkDownloadMaxFiles,
          Math.round(bulkDownloadMaxBytes / (1024 * 1024)),
        ),
      );
      return;
    }
    setCapError(null);
    // Store-side: bulk-fetch + decrypt-each + streaming-zip → single
    // Blob ready for download. `null` on cap breach (server-side
    // re-validation) or any decrypt / network failure — the store has
    // already populated `error` for the page banner; here we just
    // return so the click is a no-op.
    const blob = await requestBulkZipBlob(projectId, ids);
    if (!blob) return;
    triggerBlobDownload(blob, bundleFileName);
  };

  return (
    <section
      aria-label={STRINGS.attachments.binaryList}
      data-testid="project-detail-binaries"
      className={styles.binarySection}
    >
      <h3 className={styles.regionHeading}>{STRINGS.attachments.binaryList}</h3>

      {capError && (
        <div className={styles.errorBanner} data-testid="binary-bulk-limit-error">
          {capError}
        </div>
      )}

      {binaries.length === 0 ? (
        <div className={styles.emptyState}>{STRINGS.ui.noResults}</div>
      ) : (
        <>
          <div className={styles.binaryTableScroll}>
            <table className={styles.binaryTable}>
              <thead>
                <tr>
                  <th>
                    <label>
                      <input
                        type="checkbox"
                        data-testid="binary-select-all"
                        checked={allSelected}
                        onChange={toggleSelectAll}
                        aria-label={STRINGS.attachments.selectAll}
                      />
                    </label>
                  </th>
                  <th>{STRINGS.attachments.colFileName}</th>
                  <th>{STRINGS.attachments.colLabel}</th>
                  <th className={styles.colUploader}>{STRINGS.attachments.colUploader}</th>
                  <th className={styles.colUploaded}>{STRINGS.attachments.colUploaded}</th>
                  <th>{STRINGS.ui.actions}</th>
                </tr>
              </thead>
              <tbody>
                {binaries.map((bin) => {
                  const error = rowErrors[bin.id];
                  const isErroring = Boolean(error);
                  const uploader = bin.createdBy?.displayName ?? null;
                  const canDelete =
                    authUser !== null &&
                    !archived &&
                    canDeleteAttachment(
                      bin,
                      authUser,
                      ATTACHMENT_CONFIG.workerSelfDeleteGraceMinutes,
                    );
                  return (
                    <tr
                      key={bin.id}
                      data-testid={`attachment-binary-row-${bin.id}`}
                      data-attachment-id={bin.id}
                    >
                      <td>
                        {isErroring ? (
                          <input
                            type="checkbox"
                            data-testid={`binary-select-${bin.id}`}
                            disabled
                            aria-label={bin.fileName}
                          />
                        ) : (
                          <input
                            type="checkbox"
                            data-testid={`binary-select-${bin.id}`}
                            checked={effectiveSelected.has(bin.id)}
                            onChange={() => toggleSelect(bin.id)}
                            aria-label={bin.fileName}
                          />
                        )}
                      </td>
                      <td>{bin.fileName}</td>
                      <td>{LABEL_BY_VALUE.get(bin.label) ?? bin.label}</td>
                      <td className={styles.colUploader}>{uploader ?? ''}</td>
                      <td className={styles.colUploaded}>{formatDateDE(bin.createdAt)}</td>
                      <td>
                        <div className={styles.rowActions}>
                          {error === 'object-absent' && (
                            <span
                              className={styles.missingBadge}
                              data-testid={`binary-missing-${bin.id}`}
                            >
                              {STRINGS.attachments.fileMissing}
                            </span>
                          )}
                          {error === 'key-unavailable' && (
                            <span
                              className={styles.missingBadge}
                              data-testid={`binary-key-unavailable-${bin.id}`}
                            >
                              {STRINGS.attachments.keyUnavailable}
                            </span>
                          )}
                          {isPdf(bin) && (
                            <button
                              type="button"
                              className={styles.viewButton}
                              data-testid={`attachment-view-${bin.id}`}
                              disabled={isErroring}
                              onClick={() => handleView(bin)}
                            >
                              {STRINGS.attachments.view}
                            </button>
                          )}
                          <button
                            type="button"
                            className={styles.downloadButton}
                            data-testid="attachment-download"
                            disabled={isErroring}
                            onClick={() => void handleDownload(bin.id)}
                          >
                            {STRINGS.attachments.download}
                          </button>
                          {canDelete && (
                            <button
                              type="button"
                              className={styles.deleteButton}
                              data-testid="attachment-delete"
                              onClick={() => void handleDelete(bin)}
                              aria-label={STRINGS.ui.delete}
                            >
                              {STRINGS.ui.delete}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {effectiveSelected.size > 0 && (
            <button
              type="button"
              className={styles.bulkDownloadButton}
              data-testid="binary-bulk-download"
              onClick={() => void handleBulkDownload()}
            >
              {STRINGS.attachments.bulkDownload}
            </button>
          )}
        </>
      )}

      {preview && (
        <div
          className={styles.pdfPreview}
          data-testid="pdf-preview"
          role="dialog"
          aria-modal="true"
          aria-label={preview.fileName}
        >
          <button
            type="button"
            className={styles.previewClose}
            onClick={closePreview}
            aria-label={STRINGS.ui.close}
            data-testid="pdf-preview-close"
          >
            ×
          </button>
          <iframe className={styles.pdfPreviewFrame} src={preview.url} title={preview.fileName} />
        </div>
      )}
    </section>
  );
}
