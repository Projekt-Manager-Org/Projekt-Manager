/**
 * Attachment state — per-project list cache, pending-upload tracking,
 * and orchestration of the client-side upload pipeline.
 *
 * Surface (ui/project-detail.md §8.15):
 *   - `byProject[projectId]` caches the `status = 'ready'` list the
 *     gallery and binary list render from.
 *   - `pendingUploads[clientId]` tracks in-flight or failed uploads so
 *     the UI can show the failure banner + retry.
 *   - `error` carries the last mutation error as a German string so
 *     the page shell can surface it via the project-level banner
 *     (behavior.md §9.5).
 *
 * Upload orchestration (`uploadFile` + `retryUpload`) runs the full
 * happy-path: pipeline → MD5 → init → PUT original → PUT thumbnail →
 * complete → refetch. Any failure marks the pending row `failed` with
 * a German message — the UI reads that state to render the banner.
 * Retries are always deliberate user actions (spec §8.15.8: "No
 * silent retry").
 */

import { downloadZip } from 'client-zip';
import { create } from 'zustand';
import { attachmentApi, type PresignedUpload } from '@/api/client';
import { STRINGS } from '@/config/strings';
import { ATTACHMENT_PIPELINE } from '@/config/attachmentPipeline';
import type { Attachment, AttachmentLabel } from '@/domain/types';
import { computeMd5Base64 } from '@/domain/attachmentChecksum';
import {
  decodeDekMaterial,
  decryptBlob,
  encodeDekMaterial,
  encryptBlob,
  generateDek,
} from '@/domain/clientEncryption';
import { runImagePipeline, exceedsRawCap, type ProcessedUpload } from '@/domain/imagePipeline';
import { handleSessionExpired } from './sessionExpired';
import { useStorageUsageStore } from './storageUsageStore';
import { useToastStore } from './toastStore';

/**
 * Outcome of a Papierkorb fetch.
 *
 * Discriminated union so the component can render four distinct surfaces
 * without inferring intent from a shared error string. `forbidden` is
 * surfaced separately from `error` because the user copy differs ("Sie
 * haben keinen Zugriff" vs "Erneut versuchen") and the retry affordance
 * makes no sense for a permission denial.
 */
export type TrashFetchOutcome =
  { kind: 'ok' } | { kind: 'forbidden' } | { kind: 'error'; message: string };

export interface PendingUpload {
  clientId: string;
  projectId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  label: AttachmentLabel;
  status: 'initializing' | 'uploading' | 'completing' | 'failed';
  attachmentId: string | null;
  errorMessage: string | null;
}

interface AttachmentState {
  byProject: Record<string, Attachment[]>;
  /**
   * Hidden (Papierkorb) rows per project, fetched lazily on tab open.
   * Separate map from `byProject` so the live gallery / binary list never
   * accidentally read trash entries. Owner / office only — workers
   * trigger 403 on the GET /trash endpoint and never fill this map.
   */
  hiddenByProject: Record<string, Attachment[]>;
  pendingUploads: Record<string, PendingUpload>;
  error: string | null;

  fetchForProject: (projectId: string) => Promise<void>;
  /**
   * Fetch the project's Papierkorb.
   *
   * Returns a discriminated outcome so the UI can render distinct
   * loading / error / forbidden / empty surfaces. The previous
   * void-returning shape forced the component to read the shared
   * `state.error` field which any other action could overwrite, and
   * left the "fetch in progress vs. fetch errored" cases visually
   * indistinguishable.
   *
   * 403 leaves `hiddenByProject` untouched; the tab is permission-gated
   * upstream, so this branch is defense-in-depth for direct API calls
   * from an unprivileged caller.
   */
  fetchTrashForProject: (projectId: string) => Promise<TrashFetchOutcome>;
  /**
   * Restore a hidden attachment. Optimistic — the row leaves
   * `hiddenByProject` and joins `byProject` immediately; rollback on
   * failure restores the maps to their prior state and surfaces a
   * German error toast. The session-expired branch rolls the maps back
   * before the central handler bounces to the login page so the user
   * does not return to a half-applied UI.
   */
  restoreAttachment: (projectId: string, attachmentId: string) => Promise<void>;
  uploadFile: (
    projectId: string,
    file: File,
    input: { label: AttachmentLabel; hasThumbnail: boolean },
  ) => Promise<void>;
  /**
   * Restart a previously-failed upload for `clientId`. Implicit contract:
   * retry only succeeds while the original `File` is still present in the
   * module-local `FILES_BY_CLIENT_ID` side-map — i.e. the same page
   * lifecycle that first invoked `uploadFile`. A page reload drops the
   * side-map entirely (File handles cannot be persisted), so a retry
   * attempted after reload has no bytes to POST and short-circuits to the
   * canonical `mutationFailed` banner. This matches the spec's "page
   * reload cancels an in-flight upload cleanly" wording — there is no
   * file-picker re-prompt; the user re-adds the file from scratch.
   *
   * Within a single lifecycle the retry reuses the cached `ProcessedUpload`
   * (see `FILES_BY_CLIENT_ID.processed`) so the canvas-heavy image pipeline
   * does not re-run for a network-level failure at init / POST / complete.
   */
  retryUpload: (clientId: string) => Promise<void>;
  dismissUpload: (clientId: string) => void;
  /**
   * Abort the in-flight upload identified by `clientId` and drop its
   * pending row. No-op if no such upload exists. Safe to call from
   * unmount / nav-away effects — any concurrent `fetch` wired to the
   * upload's AbortSignal is cancelled at the transport level.
   */
  cancelUpload: (clientId: string) => void;
  /** Cancel every in-flight upload for `projectId`. */
  cancelUploadsForProject: (projectId: string) => void;
  hideAttachment: (projectId: string, attachmentId: string) => Promise<void>;
  /**
   * Resolve a presigned-GET URL plus the unwrapped DEK for one attachment
   * variant (ADR-0024 / api.md §14.2.11). Returns the raw `{ url,
   * dekMaterial }` so callers can fetch + decrypt — typically the SW
   * decrypt handler. Returns `null` on any failure (NOT_FOUND, missing
   * permission, network) so the caller renders the "Datei fehlt" placeholder.
   */
  requestDownloadUrl: (
    projectId: string,
    attachmentId: string,
    variant: 'original' | 'thumbnail',
  ) => Promise<{ url: string; dekMaterial: string } | null>;
  /**
   * Bulk-download the requested attachments, decrypt each ciphertext
   * locally, and assemble a streaming zip in the browser (ADR-0024
   * §"Bulk download"). Returns the assembled zip as a `Blob` on success
   * or `null` on cap breach / network error / decrypt failure (the
   * `error` slot carries a German message for the UI banner).
   * Peak memory scales with the largest single file, not the whole batch
   * — `client-zip` consumes the per-entry stream and serialises one file
   * at a time into the zip output.
   */
  requestBulkZipBlob: (projectId: string, attachmentIds: string[]) => Promise<Blob | null>;
  clearError: () => void;
}

/**
 * Side-map from `clientId` → the original `File`, the thumbnail flag,
 * and — once the client pipeline has run successfully — the cached
 * `ProcessedUpload` result. Kept out of Zustand state because `File` /
 * `Blob` are not serialisable and the store must survive being
 * JSON-stringified in devtools / persistence adapters.
 *
 * Lifecycle: populated on `uploadFile`; `processed` is filled in after
 * the first successful `runImagePipeline` call so a later `retryUpload`
 * (triggered by a network failure at init / POST / complete) reuses
 * the already-encoded blobs instead of re-running the canvas work.
 * Cleared entirely on successful complete or `dismissUpload`. A page
 * reload drops the map, so `retryUpload` without a backing file cannot
 * resume — that's the spec's expected behaviour ("A page reload cancels
 * an in-flight upload cleanly" — ui/project-detail.md §8.15.4).
 */
interface PendingFileSlot {
  file: File;
  hasThumbnail: boolean;
  processed?: ProcessedUpload;
}
const FILES_BY_CLIENT_ID = new Map<string, PendingFileSlot>();

/**
 * Per-upload `AbortController` map. Stored outside Zustand state so
 * the controller survives store rehydration and stays out of the
 * serialised snapshot. One controller per clientId; aborting it
 * cancels every transport-level fetch wired to its signal and
 * short-circuits the orchestrator's subsequent steps.
 */
const ABORTERS_BY_CLIENT_ID = new Map<string, AbortController>();

/**
 * Generate a client-side id for a new upload. `crypto.randomUUID()` is
 * available in every modern browser and Node 20+. Falls back to a
 * Math.random-based id only to survive legacy test harnesses.
 */
function newClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'upload-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * PUT a blob to object storage using the presigned-PUT descriptor. The
 * descriptor's `headers` (Content-Type + Content-Length + Content-MD5)
 * are signed by SigV4; the browser sends them verbatim, the storage
 * provider verifies the signature, then verifies Content-MD5 against
 * the received bytes (`BadDigest` on mismatch). A non-2xx response is
 * surfaced as a failure so the caller marks the pending row `failed`.
 *
 * `Content-Length` is in the descriptor for transparency but stripped
 * from the actual fetch headers — the browser refuses to honor an
 * explicit value (forbidden header per the fetch spec) and computes it
 * from the body itself. The browser-computed length matches what the
 * server signed because the body is the exact `Blob` whose size went
 * into the init call.
 */
async function putPresigned(
  descriptor: PresignedUpload,
  blob: Blob,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; aborted: boolean }> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(descriptor.headers)) {
    if (k.toLowerCase() === 'content-length') continue;
    headers[k] = v;
  }
  try {
    const res = await fetch(descriptor.url, { method: 'PUT', headers, body: blob, signal });
    return { ok: res.ok, status: res.status, aborted: false };
  } catch (err) {
    // `AbortError` surfaces here when the signal fires mid-flight.
    // DOMException-name check keeps the store free of DOM typings.
    const aborted =
      err instanceof DOMException ? err.name === 'AbortError' : signal?.aborted === true;
    return { ok: false, status: 0, aborted };
  }
}

export const useAttachmentStore = create<AttachmentState>((set, get) => {
  // Helpers that close over `set` / `get` — defined inside the factory
  // so the zustand API is still exposed as a plain object of actions.

  function updatePending(clientId: string, patch: Partial<PendingUpload>): void {
    set((s) => {
      const current = s.pendingUploads[clientId];
      if (!current) return s;
      return {
        pendingUploads: {
          ...s.pendingUploads,
          [clientId]: { ...current, ...patch },
        },
      };
    });
  }

  /**
   * Mark a pending upload as failed and surface the toast.
   *
   * `cause` is developer-only diagnostic context — surfaced via
   * `console.warn` so a developer triaging a failed upload can see WHICH
   * stage and why, while the user-facing copy stays generic. Optional so
   * the existing call sites that haven't been wired up yet still get a
   * baseline log via the pending row's status.
   */
  function markFailed(
    clientId: string,
    message: string,
    cause?: { stage: string; details?: unknown },
  ): void {
    const pending = get().pendingUploads[clientId];
    if (pending) {
      console.warn('[upload] failed', {
        clientId,
        fileName: pending.fileName,
        mimeType: pending.mimeType,
        sizeBytes: pending.sizeBytes,
        stage: cause?.stage ?? pending.status,
        userMessage: message,
        details: cause?.details,
      });
    }
    updatePending(clientId, { status: 'failed', errorMessage: message });
    if (pending) {
      useToastStore
        .getState()
        .show('error', STRINGS.attachments.uploadFailureToast(pending.fileName, message));
    }
  }

  function removePending(clientId: string): void {
    set((s) => {
      const { [clientId]: _removed, ...rest } = s.pendingUploads;
      return { pendingUploads: rest };
    });
    FILES_BY_CLIENT_ID.delete(clientId);
    ABORTERS_BY_CLIENT_ID.delete(clientId);
  }

  /**
   * Core upload orchestration — shared by `uploadFile` (fresh) and
   * `retryUpload` (same `clientId`, fresh run-through).
   *
   * Each run registers a fresh `AbortController` so cancellation (explicit
   * `cancelUpload`, project-change, unmount) tears down every in-flight
   * fetch at the transport level. After any terminal state the controller
   * is released via `removePending` or the explicit `delete` on a failed
   * row kept in state.
   */
  async function runUpload(clientId: string, projectId: string): Promise<void> {
    const slot = FILES_BY_CLIENT_ID.get(clientId);
    const pending = get().pendingUploads[clientId];
    if (!pending) return;
    if (!slot) {
      // No File backing — happens when retry is attempted after a reload
      // drops the side-map. We cannot re-upload without bytes; keep the
      // pending row but surface a clear failure for the user.
      markFailed(clientId, STRINGS.errors.mutationFailed, { stage: 'retry-after-reload' });
      return;
    }

    const { file, hasThumbnail } = slot;
    const label = pending.label;

    // Fast-fail obviously-oversized inputs before any decode / re-encode
    // work. The post-pipeline check against `perFileSizeCapBytes` below
    // still guards the hard cap — photos under the liberal raw cap may
    // still compress to above the per-file limit.
    if (exceedsRawCap(file)) {
      markFailed(clientId, STRINGS.attachments.uploadFileTooLarge, {
        stage: 'pre-pipeline-raw-cap',
        details: { fileSize: file.size, rawCap: ATTACHMENT_PIPELINE.rawInputCapBytes },
      });
      return;
    }

    // Abort any prior controller for this clientId (a retry that starts
    // while a previous attempt's transport is still unwinding) then
    // install a fresh one.
    ABORTERS_BY_CLIENT_ID.get(clientId)?.abort();
    const aborter = new AbortController();
    ABORTERS_BY_CLIENT_ID.set(clientId, aborter);
    const signal = aborter.signal;

    const wasAborted = (): boolean => signal.aborted;

    try {
      // Step 1 — client image pipeline. Reuse the cached result from a
      // prior successful pipeline run if one exists (a retry after a
      // network failure at init / POST / complete shouldn't re-encode
      // the photo), otherwise run it and cache the output for any
      // subsequent retry.
      let processed = slot.processed;
      if (!processed) {
        processed = await runImagePipeline(file, { hasThumbnail });
        FILES_BY_CLIENT_ID.set(clientId, { ...slot, processed });
      }
      if (wasAborted()) return;

      // Step 2 — per-file size cap. Enforced server-side at init by
      // the same cap (the route/service rejects with 422) and at the
      // signed `Content-Length` header on the PUT itself; mismatch
      // here is a client bug, not a security gap
      // (ui/project-detail.md §8.15.4).
      if (processed.sizeBytes > ATTACHMENT_PIPELINE.perFileSizeCapBytes) {
        markFailed(clientId, STRINGS.attachments.uploadFileTooLarge, {
          stage: 'post-pipeline-size-cap',
          details: {
            sizeBytes: processed.sizeBytes,
            cap: ATTACHMENT_PIPELINE.perFileSizeCapBytes,
          },
        });
        return;
      }

      // Step 3 — encrypt each blob with a fresh per-blob 32-byte AES-256
      // GCM DEK (ADR-0024 §Encryption). The output bytes — `nonce(12) ||
      // ct || tag(16)` — are what gets PUT to storage; the plaintext
      // never leaves the browser. The DEK material is shipped with the
      // init body so the server can wrap it under the operator's binary
      // `age` recipient and persist the wrapped envelope on the row.
      const willUploadThumb = hasThumbnail && processed.thumbnail !== null;
      const originalDek = generateDek();
      const originalCiphertext = await encryptBlob(
        new Uint8Array(await processed.original.arrayBuffer()),
        originalDek,
      );
      // Blob constructor refuses `Uint8Array<ArrayBufferLike>` since TS
      // 5.x (the type widens to admit `SharedArrayBuffer`-backed views).
      // Wrap via the underlying buffer slice — runtime is identical, the
      // narrowing happens at the type boundary.
      const originalCiphertextBlob = new Blob([originalCiphertext.buffer.slice(0) as ArrayBuffer], {
        type: 'application/octet-stream',
      });
      const thumbDek = willUploadThumb ? generateDek() : null;
      const thumbCiphertext =
        willUploadThumb && thumbDek
          ? await encryptBlob(
              new Uint8Array(await (processed.thumbnail as Blob).arrayBuffer()),
              thumbDek,
            )
          : null;
      const thumbCiphertextBlob = thumbCiphertext
        ? new Blob([thumbCiphertext.buffer.slice(0) as ArrayBuffer], {
            type: 'application/octet-stream',
          })
        : null;
      if (wasAborted()) return;

      // Step 4 — compute MD5 over each ciphertext. The init route signs
      // the PUT URLs with `Content-MD5` bound to these exact values; the
      // storage provider verifies the body's MD5 against the signed
      // header on receipt (`BadDigest` on mismatch). MD5 is also the
      // integrity header B2 demands on every PutObject under bucket-
      // default Compliance retention (ADR-0022). The hash is over
      // ciphertext bytes — that is what gets PUT.
      const ciphertextMd5 = await computeMd5Base64(originalCiphertextBlob);
      const thumbCiphertextMd5 = thumbCiphertextBlob
        ? await computeMd5Base64(thumbCiphertextBlob)
        : undefined;
      if (wasAborted()) return;

      // Step 5 — init (creates a `pending` row + presigned PUT
      // descriptors). Sizes + MD5s + DEK material travel with the request
      // so the server can sign each PUT with the exact body it commits to
      // and wrap each per-blob DEK under the operator's binary identity.
      const initResult = await attachmentApi.initUpload(
        projectId,
        {
          fileName: file.name,
          mimeType: processed.mimeType,
          sizeBytes: processed.sizeBytes,
          label,
          hasThumbnail: willUploadThumb,
          dekMaterial: encodeDekMaterial(originalDek),
          ciphertextSizeBytes: originalCiphertextBlob.size,
          ciphertextContentMd5: ciphertextMd5,
          ...(willUploadThumb && thumbDek && thumbCiphertextBlob && thumbCiphertextMd5
            ? {
                thumbDekMaterial: encodeDekMaterial(thumbDek),
                ciphertextThumbSizeBytes: thumbCiphertextBlob.size,
                ciphertextThumbContentMd5: thumbCiphertextMd5,
              }
            : {}),
        },
        signal,
      );
      if (wasAborted()) return;
      if (!initResult.ok) {
        if (initResult.sessionExpired) {
          handleSessionExpired();
          return;
        }
        markFailed(clientId, initResult.error.message || STRINGS.errors.mutationFailed, {
          stage: 'init',
          details: initResult.error,
        });
        return;
      }
      const initData = initResult.data;

      updatePending(clientId, {
        status: 'uploading',
        attachmentId: initData.attachment.id,
        mimeType: processed.mimeType,
        sizeBytes: processed.sizeBytes,
      });

      // Step 6 — PUT the ciphertext bytes for the original to storage.
      // The presigned URL was signed against `ciphertextSizeBytes` and
      // `ciphertextContentMd5` from the init body, so the body PUT here
      // must be the exact ciphertext blob those values describe.
      const originalResp = await putPresigned(
        initData.originalUpload,
        originalCiphertextBlob,
        signal,
      );
      if (originalResp.aborted || wasAborted()) return;
      if (!originalResp.ok) {
        markFailed(clientId, STRINGS.errors.mutationFailed, {
          stage: 'original-upload-put',
          details: { status: originalResp.status, url: initData.originalUpload.url },
        });
        return;
      }

      // Step 7 — PUT the ciphertext thumbnail bytes (when present).
      if (thumbCiphertextBlob && initData.thumbnailUpload) {
        const thumbResp = await putPresigned(initData.thumbnailUpload, thumbCiphertextBlob, signal);
        if (thumbResp.aborted || wasAborted()) return;
        if (!thumbResp.ok) {
          markFailed(clientId, STRINGS.errors.mutationFailed, {
            stage: 'thumbnail-upload-put',
            details: { status: thumbResp.status, url: initData.thumbnailUpload.url },
          });
          return;
        }
      }

      // Step 8 — complete (server verifies bytes via HEAD).
      updatePending(clientId, { status: 'completing' });
      const completeResult = await attachmentApi.completeUpload(
        projectId,
        initData.attachment.id,
        signal,
      );
      if (wasAborted()) return;
      if (!completeResult || !completeResult.ok) {
        if (completeResult && completeResult.sessionExpired) {
          handleSessionExpired();
          return;
        }
        const message =
          (completeResult && completeResult.error?.message) || STRINGS.errors.mutationFailed;
        markFailed(clientId, message, {
          stage: 'complete',
          details: completeResult?.error,
        });
        return;
      }

      // Step 9 — success. Fire a success toast with the file name (the
      // pending row is about to be dropped, so grab it before removal),
      // remove the pending entry, sweep any stale failed rows for this
      // project, and refresh the list.
      const succeeded = get().pendingUploads[clientId];
      if (succeeded) {
        useToastStore
          .getState()
          .show('success', STRINGS.attachments.uploadSuccessToast(succeeded.fileName));
      }
      removePending(clientId);
      // A successful upload means the user has moved on; any failed
      // rows left from earlier attempts for the same project render a
      // banner the user will never act on. Drop them here so the UI
      // doesn't pin stale "Datei zu groß" / network-error surfaces
      // indefinitely. Scoped to the same project so a failure on
      // project A is not erased by a success on project B.
      set((s) => {
        const next: Record<string, PendingUpload> = {};
        for (const [id, entry] of Object.entries(s.pendingUploads)) {
          if (entry.projectId === projectId && entry.status === 'failed') {
            FILES_BY_CLIENT_ID.delete(id);
            ABORTERS_BY_CLIENT_ID.delete(id);
            continue;
          }
          next[id] = entry;
        }
        return { pendingUploads: next };
      });
      await get().fetchForProject(projectId);
      // Post-mutation: counters moved (pending → ready). Defence in
      // depth alongside the SSE roundtrip — if the channel is
      // unhealthy (proxy issue, dropped reconnect) the badge stays
      // current for the same-tab caller.
      void useStorageUsageStore.getState().refresh();
    } catch (err) {
      // Ignore aborts — the caller intentionally tore the run down; no
      // user-visible failure banner. Everything else marks failed.
      const aborted = err instanceof DOMException ? err.name === 'AbortError' : signal.aborted;
      if (aborted) return;
      // Tagged error from the pipeline — surface the specific cause so
      // "compression crashed" is diagnosable from "compressed output too
      // big", rather than collapsing both into the size-cap banner. The
      // pipeline already logged a detailed structured warning before
      // throwing, so re-logging here would only echo it.
      if (err instanceof Error && err.message === 'IMAGE_PROCESSING_FAILED') {
        markFailed(clientId, STRINGS.attachments.uploadImageProcessingFailed, {
          stage: 'image-pipeline',
        });
        return;
      }
      markFailed(clientId, STRINGS.errors.mutationFailed, {
        stage: 'unexpected',
        details: err instanceof Error ? `${err.name}: ${err.message}` : err,
      });
    } finally {
      // Release the controller if it's still the one we installed. If a
      // retry has already replaced it, leave that entry alone.
      if (ABORTERS_BY_CLIENT_ID.get(clientId) === aborter) {
        ABORTERS_BY_CLIENT_ID.delete(clientId);
      }
    }
  }

  return {
    byProject: {},
    hiddenByProject: {},
    pendingUploads: {},
    error: null,

    fetchForProject: async (projectId: string) => {
      let result;
      try {
        result = await attachmentApi.list(projectId);
      } catch {
        set({ error: STRINGS.errors.mutationFailed });
        return;
      }
      if (!result.ok) {
        if (result.sessionExpired) {
          handleSessionExpired();
          return;
        }
        set({ error: result.error.message || STRINGS.errors.mutationFailed });
        return;
      }
      set((s) => ({
        byProject: { ...s.byProject, [projectId]: result.data.data },
        error: null,
      }));
    },

    fetchTrashForProject: async (projectId: string) => {
      let result;
      try {
        result = await attachmentApi.listTrash(projectId);
      } catch {
        set({ error: STRINGS.errors.mutationFailed });
        return { kind: 'error', message: STRINGS.errors.mutationFailed };
      }
      if (!result.ok) {
        if (result.sessionExpired) {
          handleSessionExpired();
          return { kind: 'error', message: STRINGS.auth.sessionExpiredLogin };
        }
        // 403 (caller lacks attachment:trash) leaves the map untouched —
        // the UI gates the tab on permission anyway, so this branch only
        // fires on a direct API call by an unprivileged caller.
        if (result.category === 'authorization') {
          set({ error: result.error.message || STRINGS.auth.notPermitted });
          return { kind: 'forbidden' };
        }
        const message = result.error.message || STRINGS.errors.mutationFailed;
        set({ error: message });
        return { kind: 'error', message };
      }
      set((s) => ({
        hiddenByProject: { ...s.hiddenByProject, [projectId]: result.data.data },
        error: null,
      }));
      return { kind: 'ok' };
    },

    restoreAttachment: async (projectId, attachmentId) => {
      // Optimistic move: row leaves Papierkorb and joins the live list.
      // Rollback both maps on failure.
      const beforeHidden = get().hiddenByProject[projectId];
      const beforeLive = get().byProject[projectId];
      const target = (beforeHidden ?? []).find((a) => a.id === attachmentId);
      if (!target) return;
      const optimistic: Attachment = { ...target, status: 'ready', hiddenAt: null };
      set((s) => ({
        hiddenByProject: {
          ...s.hiddenByProject,
          [projectId]: (s.hiddenByProject[projectId] ?? []).filter((a) => a.id !== attachmentId),
        },
        byProject: {
          ...s.byProject,
          [projectId]: [optimistic, ...(s.byProject[projectId] ?? [])],
        },
      }));

      // Roll back both maps and surface the toast on a terminal failure.
      // Centralised here so the network-error, server-error, and
      // session-expired branches share the same recovery — the previous
      // session-expired branch bounced to login WITHOUT rolling back the
      // optimistic move, leaving an inconsistent UI behind.
      const rollback = (message: string | null): void => {
        set((s) => ({
          hiddenByProject: { ...s.hiddenByProject, [projectId]: beforeHidden ?? [] },
          byProject: { ...s.byProject, [projectId]: beforeLive ?? [] },
          error: message,
        }));
        if (message) useToastStore.getState().show('error', message);
      };

      let result;
      try {
        result = await attachmentApi.restore(projectId, attachmentId);
      } catch {
        rollback(STRINGS.attachments.restoreFailed);
        return;
      }
      if (!result.ok) {
        if (result.sessionExpired) {
          // Roll the optimistic move back BEFORE the central handler
          // navigates away. Suppress the toast — the login redirect is
          // the user-facing signal here, a duplicate error toast would
          // be noise.
          rollback(null);
          handleSessionExpired();
          return;
        }
        rollback(result.error.message || STRINGS.attachments.restoreFailed);
        return;
      }
      // Server response carries the authoritative row (with new
      // version-ids). Replace the optimistic placeholder.
      const restored = result.data;
      set((s) => ({
        byProject: {
          ...s.byProject,
          [projectId]: (s.byProject[projectId] ?? []).map((a) =>
            a.id === attachmentId ? restored : a,
          ),
        },
        error: null,
      }));
      // Post-mutation: counters moved (hidden → ready). Defence in
      // depth alongside the SSE roundtrip.
      void useStorageUsageStore.getState().refresh();
    },

    uploadFile: async (projectId, file, input) => {
      const clientId = newClientId();
      // Synchronous insert — the UploadCta test relies on the pending
      // row being visible before the first microtask boundary (the test
      // calls `await Promise.resolve()` and asserts the initializing
      // state). Using a non-async insert keeps the contract clean.
      FILES_BY_CLIENT_ID.set(clientId, { file, hasThumbnail: input.hasThumbnail });
      set((s) => ({
        pendingUploads: {
          ...s.pendingUploads,
          [clientId]: {
            clientId,
            projectId,
            fileName: file.name,
            mimeType: file.type,
            sizeBytes: file.size,
            label: input.label,
            status: 'initializing',
            attachmentId: null,
            errorMessage: null,
          },
        },
      }));

      await runUpload(clientId, projectId);
    },

    retryUpload: async (clientId) => {
      const pending = get().pendingUploads[clientId];
      if (!pending) return;
      // Clear the failed state synchronously so the UI's banner
      // disappears during the retry (spec §8.15.8 — retry restarts
      // from init).
      updatePending(clientId, { status: 'initializing', errorMessage: null });
      await runUpload(clientId, pending.projectId);
    },

    dismissUpload: (clientId) => {
      // Dismiss also aborts any transport still in flight — the user
      // said "forget this" and we should not let a racing POST land a
      // row after the dismiss.
      ABORTERS_BY_CLIENT_ID.get(clientId)?.abort();
      removePending(clientId);
    },

    cancelUpload: (clientId) => {
      ABORTERS_BY_CLIENT_ID.get(clientId)?.abort();
      removePending(clientId);
    },

    cancelUploadsForProject: (projectId) => {
      const state = get();
      for (const [id, entry] of Object.entries(state.pendingUploads)) {
        if (entry.projectId !== projectId) continue;
        ABORTERS_BY_CLIENT_ID.get(id)?.abort();
      }
      // Drop all pending rows for the project in one batched update so
      // React sees a single re-render instead of N.
      set((s) => {
        const next: Record<string, PendingUpload> = {};
        for (const [id, entry] of Object.entries(s.pendingUploads)) {
          if (entry.projectId === projectId) {
            FILES_BY_CLIENT_ID.delete(id);
            ABORTERS_BY_CLIENT_ID.delete(id);
            continue;
          }
          next[id] = entry;
        }
        return { pendingUploads: next };
      });
    },

    hideAttachment: async (projectId, attachmentId) => {
      // Optimistic move: row leaves the live list and joins Papierkorb.
      // Mirrors `restoreAttachment` below — both cache slices stay
      // consistent so a tab switch right after the action shows the
      // up-to-date view without a refetch flash. ProjectDetailPage
      // eagerly fetches the trash for owner / office (to populate the
      // tab badge), so `hiddenByProject[projectId]` is usually a
      // populated array — Papierkorb's mount-time fetch only fires
      // when items is undefined, so a one-sided update would leave
      // Papierkorb showing the stale prefetch result indefinitely.
      // Roll back BOTH maps on every terminal failure path —
      // network-error, server-error, session-expired — so a failed
      // hide doesn't leave the row missing from one side and present
      // on the other.
      const beforeLive = get().byProject[projectId];
      const beforeHidden = get().hiddenByProject[projectId];
      const target = (beforeLive ?? []).find((a) => a.id === attachmentId);
      if (!target) return;
      // Synthetic hidden row — DELETE returns 204 (no body) so we have
      // no authoritative `hiddenAt` to replace this with on success.
      // The next listTrash call (page reload, navigation, restore-
      // triggered refetch) substitutes the server's value. The
      // relative-time label in Papierkorb collapses both to "vor
      // wenigen Sekunden gelöscht", so the user-visible difference is
      // nil.
      const optimistic: Attachment = {
        ...target,
        status: 'hidden',
        hiddenAt: new Date().toISOString(),
      };
      set((s) => ({
        byProject: {
          ...s.byProject,
          [projectId]: (s.byProject[projectId] ?? []).filter((a) => a.id !== attachmentId),
        },
        // Prepend so the just-hidden row sits at the top of Papierkorb
        // — matches the server's `ORDER BY hidden_at DESC` ordering
        // (src/server/repositories/attachment.ts:listHiddenByProject).
        hiddenByProject: {
          ...s.hiddenByProject,
          [projectId]: [optimistic, ...(s.hiddenByProject[projectId] ?? [])],
        },
      }));

      const rollback = (message: string | null): void => {
        set((s) => ({
          byProject: { ...s.byProject, [projectId]: beforeLive ?? [] },
          hiddenByProject: { ...s.hiddenByProject, [projectId]: beforeHidden ?? [] },
          error: message,
        }));
      };

      let result;
      try {
        result = await attachmentApi.delete(projectId, attachmentId);
      } catch {
        rollback(STRINGS.errors.mutationFailed);
        return;
      }
      if (!result.ok) {
        if (result.sessionExpired) {
          // Roll the optimistic removal back BEFORE the central handler
          // navigates away. Suppress the error string — the login
          // redirect is the user-facing signal here, an additional
          // banner would be noise on the way out.
          rollback(null);
          handleSessionExpired();
          return;
        }
        rollback(result.error.message || STRINGS.errors.mutationFailed);
        return;
      }
      // Clear any prior error banner — same shape as fetchForProject
      // and restoreAttachment, so a stale message from an earlier
      // mutation does not linger after a successful hide.
      set({ error: null });
      // Post-mutation: counters moved (ready → hidden). Defence in
      // depth alongside the SSE roundtrip.
      void useStorageUsageStore.getState().refresh();
    },

    requestDownloadUrl: async (projectId, attachmentId, variant) => {
      let result;
      try {
        result = await attachmentApi.downloadUrl(projectId, attachmentId, variant);
      } catch {
        return null;
      }
      if (!result.ok) {
        if (result.sessionExpired) {
          handleSessionExpired();
          return null;
        }
        // NOT_FOUND is the "Datei fehlt" signal (ui/project-detail.md
        // §8.15.7). Every other failure is also a "can't render this
        // row" for the caller, so the single null return covers both.
        return null;
      }
      // Forward `url` + `dekMaterial` verbatim. The state layer never
      // touches the DEK — the SW decrypt handler is the only consumer
      // (ADR-0024). Don't surface `expiresAt` here: the SW reissues a
      // fresh pair on every intercept, so a TTL hint at this layer
      // would be ignored.
      return { url: result.data.url, dekMaterial: result.data.dekMaterial };
    },

    requestBulkZipBlob: async (projectId, attachmentIds) => {
      // 1. Bulk-fetch the per-blob descriptors (presigned-GET URL +
      //    unwrapped DEK + ciphertext byte count, ordered by request).
      let result;
      try {
        result = await attachmentApi.bulkFetch(projectId, attachmentIds);
      } catch {
        set({ error: STRINGS.errors.mutationFailed });
        return null;
      }
      if (!result.ok) {
        if (result.sessionExpired) {
          handleSessionExpired();
          return null;
        }
        // BULK_LIMIT_EXCEEDED, NOT_PERMITTED, NOT_FOUND, validation
        // failures all collapse here; the German message comes from the
        // server (or the canonical fallback) so the UI banner picks it
        // up via the shared `error` slot.
        set({ error: result.error.message || STRINGS.errors.mutationFailed });
        return null;
      }
      const entries = result.data.data;

      // 2. Decrypt each ciphertext, wrap as a one-chunk ReadableStream,
      //    and feed `client-zip` an async-iter of `{ name, input }`.
      //    Walking `entries` in order preserves the request-order
      //    contract (AC-216). `client-zip` consumes the iterator one
      //    file at a time, so peak memory scales with the largest
      //    in-flight file rather than the whole batch — see ADR-0024
      //    §"Bulk download". Wrapping the decrypted `Uint8Array` as a
      //    single-chunk stream (not chunking) is intentional: the per-
      //    file streaming property is preserved by the zip generator's
      //    serialisation, and chunking is overkill at the 20-file /
      //    20-MB cap.
      const liveAttachments = get().byProject[projectId] ?? [];
      const fileNameById = new Map(liveAttachments.map((a) => [a.id, a.fileName]));

      async function* zipInputs(): AsyncIterable<{
        name: string;
        input: ReadableStream<Uint8Array>;
      }> {
        for (const entry of entries) {
          const ciphertextResp = await fetch(entry.originalUrl);
          if (!ciphertextResp.ok) {
            throw new Error(`bulk-fetch GET failed: status=${ciphertextResp.status}`);
          }
          const ciphertext = new Uint8Array(await ciphertextResp.arrayBuffer());
          const dek = decodeDekMaterial(entry.originalDekMaterial);
          const plaintext = await decryptBlob(ciphertext, dek);
          // Fall back to the attachment id when the live list cache
          // doesn't contain a name for this entry (e.g. the user
          // dispatched bulk-fetch on a stale cache). Filename-collision
          // dedup is the caller's responsibility per api.md §14.2.11
          // design notes — `client-zip` happily writes duplicate names.
          const name = fileNameById.get(entry.attachmentId) ?? entry.attachmentId;
          yield {
            name,
            input: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(plaintext);
                controller.close();
              },
            }),
          };
        }
      }

      try {
        return await downloadZip(zipInputs()).blob();
      } catch (err) {
        // Decrypt failure or transport error mid-iter — both surface
        // here. The placeholder copy is the canonical mutation-failed
        // string; logging the structured cause keeps developer triage
        // cheap (matches the upload-failure logging discipline).
        console.warn('[bulk-zip] failed', {
          projectId,
          count: attachmentIds.length,
          details: err instanceof Error ? `${err.name}: ${err.message}` : err,
        });
        set({ error: STRINGS.errors.mutationFailed });
        return null;
      }
    },

    clearError: () => set({ error: null }),
  };
});
