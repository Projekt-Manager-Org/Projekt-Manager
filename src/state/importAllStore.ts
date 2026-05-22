/**
 * State-layer entry points for Vollständiger Import (issue #163,
 * ui/daten.md §8.11.2).
 *
 * The import orchestrator (`ui/management/importAllFromZip.ts`) and
 * its runner hook live in the UI layer; under the AC-33 boundary,
 * they cannot import the API client directly. This module is the
 * narrow state-layer adapter the runner consumes — every call here
 * forwards to `attachmentApi` / `dataApi` after normalising the
 * `ApiResult` envelope into the orchestrator's plain-promise contract.
 *
 * No store state — these are stateless helpers exposed via a `const`
 * facade rather than a Zustand `create()`. The standard upload state
 * (pending uploads, retry queue, byProject cache) belongs to
 * `attachmentStore`; the import flow is short-lived and managed by
 * the runner hook in-memory, so allocating a Zustand slice for it
 * would be cargo-culted.
 */

import { attachmentApi, dataApi } from '@/api/client';
import type { Envelope, ImportResult, DryRunPreview } from '@/domain/dataExchange';
import type { AttachmentLabel } from '@/domain/types';

/**
 * Restore-block subset of an envelope row. Mirrors
 * `importAllFromZip.RestoreBlock` to avoid a UI → UI import; the
 * runner re-exports the same shape.
 */
export interface ImportRestoreBlock {
  id: string;
  createdBy: string;
  createdAt: string;
}

/**
 * Init-payload subset matching `attachmentApi.initUpload`'s shape
 * (without the optional restore block, which the orchestrator passes
 * separately). Re-declared rather than imported so the runner does
 * not need a transitive UI → API client edge.
 *
 * `label` is the closed-enum `AttachmentLabel` — the runner narrows
 * the envelope's free-string `label` field via `validateLabel` from
 * `domain/attachments.ts` before constructing this payload, so the
 * type holds at the boundary without an unchecked cast.
 */
export interface ImportInitPayload {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  label: AttachmentLabel;
  hasThumbnail: boolean;
  dekMaterial: string;
  ciphertextSizeBytes: number;
  ciphertextContentMd5: string;
  thumbDekMaterial?: string;
  ciphertextThumbSizeBytes?: number;
  ciphertextThumbContentMd5?: string;
}

export interface ImportInitResult {
  id: string;
  originalUpload: { url: string; headers: Record<string, string> };
  thumbnailUpload?: { url: string; headers: Record<string, string> };
}

export interface ImportTextLegResult {
  ok: boolean;
  message?: string;
  /**
   * Issue #230: when override wipes users, the operator's session
   * CASCADEd away mid-transaction. The server signals this via
   * `sessionInvalidated: true` and ships a short-lived `importToken`
   * for the binary leg to use in place of the dead session. The
   * orchestrator carries the token forward on every per-attachment
   * call. Both fields default to safe values on the empty-target
   * path (no wipe, no token needed).
   */
  sessionInvalidated: boolean;
  importToken: string | null;
}

/**
 * POST `/api/import` with a stripped-attachments envelope. `override`
 * is fixed to `true` because the orchestrator only fires this on the
 * commit path (after the runner's preflight dry-run); a destructive
 * gate already validated the typed phrase. Empty-target imports also
 * pass `override=true` — the server treats it as a no-op when the
 * tables are already empty.
 */
async function postTextLeg(
  envelope: Omit<Envelope, 'attachments'>,
  confirmationPhrase: string,
): Promise<ImportTextLegResult> {
  const res = await dataApi.import(envelope as Envelope, {
    dryRun: false,
    override: true,
    confirmationPhrase,
  });
  if (!res.ok) {
    return { ok: false, message: res.error.message, sessionInvalidated: false, importToken: null };
  }
  // The commit path returns `ImportResult`, not the dry-run preview;
  // the `would_write` discriminator is absent. Narrow defensively.
  const data = res.data;
  if ('would_write' in data) {
    return {
      ok: false,
      message: 'Unexpected dry-run preview on commit path',
      sessionInvalidated: false,
      importToken: null,
    };
  }
  return {
    ok: true,
    sessionInvalidated: data.sessionInvalidated,
    importToken: data.importToken,
  };
}

/**
 * Dry-run `/api/import` to learn whether the importing instance is
 * non-empty (drives the destructive-action phrase prompt). Returns
 * the preview body verbatim on success and `null` on any rejection;
 * the caller renders an error state.
 */
async function fetchDryRun(envelope: Envelope): Promise<DryRunPreview | null> {
  const stripped = { ...envelope } as Partial<Envelope>;
  delete stripped.attachments;
  const res = await dataApi.import(stripped as Envelope, {
    dryRun: true,
    override: true,
  });
  if (!res.ok) return null;
  // The envelope is a discriminated union over `would_write` (preview)
  // vs `summary` (commit). Dry-run always returns the preview shape.
  if (!('would_write' in res.data)) return null;
  return res.data;
}

/**
 * POST `/api/projects/:projectId/attachments/init` with the restore
 * block. Resolves to the orchestrator's narrow init-result shape;
 * non-OK propagates as a thrown Error so the orchestrator's per-file
 * failure branch records it without needing to inspect ApiResult.
 */
async function importInit(
  projectId: string,
  payload: ImportInitPayload,
  restore: ImportRestoreBlock,
  authToken?: string,
): Promise<ImportInitResult> {
  const res = await attachmentApi.initUpload(
    projectId,
    {
      fileName: payload.fileName,
      mimeType: payload.mimeType,
      sizeBytes: payload.sizeBytes,
      label: payload.label,
      hasThumbnail: payload.hasThumbnail,
      dekMaterial: payload.dekMaterial,
      ciphertextSizeBytes: payload.ciphertextSizeBytes,
      ciphertextContentMd5: payload.ciphertextContentMd5,
      ...(payload.thumbDekMaterial !== undefined
        ? {
            thumbDekMaterial: payload.thumbDekMaterial,
            ciphertextThumbSizeBytes: payload.ciphertextThumbSizeBytes!,
            ciphertextThumbContentMd5: payload.ciphertextThumbContentMd5!,
          }
        : {}),
      restore,
    },
    undefined,
    authToken,
  );
  if (!res.ok) {
    throw new Error(res.error.message || 'init failed');
  }
  const data = res.data;
  return {
    id: data.attachment.id,
    originalUpload: {
      url: data.originalUpload.url,
      headers: data.originalUpload.headers,
    },
    ...(data.thumbnailUpload
      ? {
          thumbnailUpload: {
            url: data.thumbnailUpload.url,
            headers: data.thumbnailUpload.headers,
          },
        }
      : {}),
  };
}

/**
 * POST `/api/projects/:projectId/attachments/:attId/complete`. Throws
 * on rejection.
 */
async function importComplete(
  projectId: string,
  attachmentId: string,
  authToken?: string,
): Promise<{ id: string; status: 'ready' }> {
  const res = await attachmentApi.completeUpload(projectId, attachmentId, undefined, authToken);
  if (!res.ok) {
    throw new Error(res.error.message || 'complete failed');
  }
  return { id: res.data.id, status: 'ready' };
}

/**
 * DELETE `/api/projects/:projectId/attachments/:attId` — soft-hide
 * rollback. Best-effort: server-side rejection is logged but not
 * thrown because the orchestrator's `Promise.allSettled` rollback
 * walk doesn't differentiate failure from success (the orphan reaper
 * handles eventual cleanup either way).
 */
async function importDelete(
  projectId: string,
  attachmentId: string,
  authToken?: string,
): Promise<void> {
  await attachmentApi.delete(projectId, attachmentId, authToken);
}

/**
 * State-layer surface the import-runner hook consumes. Exported as a
 * plain `const` so the runner's `useImportAllRunner` doesn't need
 * Zustand wiring — there is no shared mutable state to subscribe to.
 */
export const importAllApi = {
  postTextLeg,
  fetchDryRun,
  importInit,
  importComplete,
  importDelete,
} as const;

// Re-export for the runner so it doesn't need to import `dataExchange`
// directly when only the result type is needed.
export type { Envelope as ImportEnvelopeType, ImportResult };
