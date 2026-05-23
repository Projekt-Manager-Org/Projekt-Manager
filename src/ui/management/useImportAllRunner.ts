/**
 * Import — runner hook (issue #163, AC-259/AC-260/AC-261).
 *
 * Owns the import state machine the dialog renders against. Mirrors
 * `useExportAllRunner.ts` in shape: the hook exposes a
 * discriminated-union `phase`, `start(phrase)` / `cancel()`, and keeps
 * the dialog component declarative.
 *
 * The parent (DatenView) owns the file-picker step and only mounts the
 * dialog once a file has been selected — the hook receives the file as
 * input and auto-parses on mount.
 *
 * State machine:
 *   parsing                   (hook reads + parses zip + dry-runs API)
 *      └→ preflight           (zip parsed + manifest valid; user gates)
 *           └→ progress       (text-leg + per-attachment legs running)
 *                └→ summary | error
 *
 * Concurrency / cancellation:
 *   - The orchestrator is the single async dispatch point. The hook
 *     wires an `AbortSignal` through; cancel fires the signal and
 *     waits for the orchestrator to settle.
 *   - The orchestrator's per-file failures land in `summary.failures`
 *     so the dialog can render the "X Anhänge übersprungen" line.
 *
 * Crypto / image-pipeline reuse:
 *   The runner threads `prepareAttachment` through to the orchestrator.
 *   The prepare step runs the standard image pipeline for photos
 *   (`runImagePipeline`), generates a fresh DEK + nonce, encrypts both
 *   blobs, and computes RFC 1864 base64 MD5 of each ciphertext — the
 *   exact same shape the standard upload path runs in
 *   `attachmentStore.runUpload`. The shared `computeMd5Base64` helper
 *   lives in `domain/attachmentChecksum.ts`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { STRINGS } from '@/config/strings';
import { validateLabel } from '@/domain/attachments';
import { computeMd5Base64 } from '@/domain/attachmentChecksum';
import { encodeDekMaterial, encryptBlob, generateDek } from '@/domain/clientEncryption';
import { SCHEMA_VERSION } from '@/domain/dataExchange';
import { deriveWebpThumbnail } from '@/domain/imagePipeline';
import { importAllApi } from '@/state/importAllStore';
import {
  beginSessionExpiredSuppression,
  endSessionExpiredSuppression,
} from '@/state/sessionExpired';
import { useStorageUsageStore } from '@/state/storageUsageStore';
import {
  importAllFromZip,
  parseTakeoutZip,
  type ImportAllResult,
  type ImportEnvelope,
  type ImportEnvelopeAttachment,
  type ImportFailure,
  type InitAttachmentResult,
  type ParsedTakeoutZip,
  type PrepareAttachmentInput,
  type PrepareAttachmentResult,
  type RestoreBlock,
} from './importAllFromZip';

export type DialogPhase =
  | ParsingPhase
  | PreflightPhase
  | ProgressPhase
  | SummaryPhase
  | ErrorPhase
  | TokenInvalidPhase;

export interface ParsingPhase {
  kind: 'parsing';
}

export interface PreflightSnapshot {
  envelope: ImportEnvelope;
  attachmentCount: number;
  totalBytes: number;
  /** Whether the importing instance is currently non-empty (drives the phrase prompt). */
  targetNonEmpty: boolean;
}

export interface PreflightPhase extends PreflightSnapshot {
  kind: 'preflight';
}

export interface ProgressPhase {
  kind: 'progress';
  totalCount: number;
  totalSizeBytes: number;
  filesDone: number;
  bytesDone: number;
  currentFile: string;
}

export interface SummaryPhase {
  kind: 'summary';
  committedCount: number;
  totalAttachments: number;
  failures: ImportFailure[];
  /**
   * Set when the text-leg reported `sessionInvalidated: true` — i.e. the
   * override path wiped users and the operator's session row CASCADEd
   * away. The dialog's close handler reads this to trigger a global
   * session-expired redirect rather than leaving the UI in a state
   * where the next API call will get bounced anyway.
   */
  sessionInvalidated: boolean;
}

export interface ErrorPhase {
  kind: 'error';
  message: string;
}

/**
 * Dedicated phase for the mid-import bearer-token rejection (server
 * returned `IMPORT_TOKEN_INVALID` on a binary-leg call — token revoked,
 * expired, or the user was deactivated). At this point the operator's
 * session is gone (it was CASCADEd by the user-wipe override) and the
 * only auth they had — the bearer — is dead. Recovery requires
 * re-login; the dialog's close handler triggers the global
 * session-expired redirect.
 */
export interface TokenInvalidPhase {
  kind: 'token-invalid';
  message: string;
}

/**
 * Result the hook needs from the dry-run preview to decide whether the
 * confirmation phrase prompt is required. Subset of `DryRunPreview`.
 */
interface PreviewLite {
  targetNonEmpty: boolean;
}

/**
 * Wrap the bytes via a Blob so the shared `computeMd5Base64` helper
 * (which expects a Blob, matching the upload pipeline's signature) can
 * read them in 2 MiB chunks.
 */
function bytesToBlob(bytes: Uint8Array): Blob {
  // The Blob constructor on TS 5.x narrows the input from
  // `Uint8Array<ArrayBufferLike>` — wrap via the underlying ArrayBuffer
  // slice to satisfy the type. Runtime is identical.
  return new Blob([bytes.buffer.slice(0) as ArrayBuffer], {
    type: 'application/octet-stream',
  });
}

/**
 * Build the orchestrator's `prepareAttachment` callback. Encapsulates
 * DEK generation, MD5 of each ciphertext, and (for photos) the image
 * pipeline thumbnail derivation. Mirrors `attachmentStore.runUpload`'s
 * Step 3+4 shape.
 */
async function prepareAttachment(input: PrepareAttachmentInput): Promise<PrepareAttachmentResult> {
  const { entry, plaintext } = input;

  // The original is forwarded verbatim — the takeout-zip plaintext is
  // already the post-pipeline output of the source export (downscale +
  // re-encode happened on the way OUT, not on the way IN). Re-running
  // the pipeline here would lossy-re-encode the JPEG and break the
  // byte-equality contract pinned by AC-241 / AC-259. The thumbnail
  // is derived from those same bytes via the canvas helper so the
  // gallery has something to render after restore (mirrors the spec
  // wording in issue #163: "Thumbnails restore naturally — the
  // browser-side pipeline … derives thumbs").
  const originalBlob = bytesToBlob(plaintext);

  // Derive thumbnail for photos only — `deriveWebpThumbnail` returns
  // null in non-browser runtimes (jsdom, the unit tests don't reach
  // this branch) so the caller falls back to a no-thumbnail upload.
  const thumbnailBlob = entry.kind === 'photo' ? await deriveWebpThumbnail(originalBlob) : null;
  const willUploadThumb = thumbnailBlob !== null;

  // Encrypt original.
  const originalDek = generateDek();
  const originalCiphertext = await encryptBlob(plaintext, originalDek);
  const originalCiphertextBlob = new Blob([originalCiphertext.buffer.slice(0) as ArrayBuffer], {
    type: 'application/octet-stream',
  });

  // Encrypt thumbnail (if any).
  let thumbCiphertext: Uint8Array | undefined;
  let thumbCiphertextBlob: Blob | undefined;
  let thumbDek: Uint8Array | undefined;
  if (willUploadThumb && thumbnailBlob) {
    thumbDek = generateDek();
    thumbCiphertext = await encryptBlob(
      new Uint8Array(await thumbnailBlob.arrayBuffer()),
      thumbDek,
    );
    thumbCiphertextBlob = new Blob([thumbCiphertext.buffer.slice(0) as ArrayBuffer], {
      type: 'application/octet-stream',
    });
  }

  // MD5 of each ciphertext for `Content-MD5`.
  const ciphertextMd5 = await computeMd5Base64(originalCiphertextBlob);
  const thumbCiphertextMd5 = thumbCiphertextBlob
    ? await computeMd5Base64(thumbCiphertextBlob)
    : undefined;

  // Narrow the envelope's free-string `label` to the closed
  // `AttachmentLabel` enum at the boundary. `validateLabel` throws on
  // an unknown value — caught by the orchestrator and recorded as a
  // per-file failure rather than aborting the whole run.
  const label = validateLabel(entry.label);

  return {
    initPayload: {
      fileName: entry.fileName,
      mimeType: entry.mimeType,
      sizeBytes: plaintext.byteLength,
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
    originalCiphertext,
    ...(thumbCiphertext ? { thumbnailCiphertext: thumbCiphertext } : {}),
  };
}

/**
 * Adapter factory from the state-layer `importAllApi.importInit` to
 * the orchestrator's plain-promise contract. `getAuthToken` returns
 * the most recent `importToken` (issue #230); empty string / undefined
 * means use the session cookie. A non-OK result propagates as a
 * thrown error so the orchestrator's per-file failure branch records
 * it.
 */
function makeInitAttachment(getAuthToken: () => string | undefined) {
  return async function initAttachment(
    entry: ImportEnvelopeAttachment,
    restore: RestoreBlock,
    payload?: NonNullable<PrepareAttachmentResult>['initPayload'],
  ): Promise<InitAttachmentResult> {
    if (!payload) {
      throw new Error('initAttachment: prepared payload missing');
    }
    return importAllApi.importInit(entry.projectId, payload, restore, getAuthToken());
  };
}

/**
 * PUT a presigned ciphertext. Strips the forbidden `Content-Length`
 * header (browsers refuse it, matching the standard-upload helper in
 * `attachmentStore.putPresigned`).
 */
async function putCiphertext(
  url: string,
  headers: Record<string, string>,
  ciphertext: Uint8Array,
): Promise<void> {
  const safeHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'content-length') continue;
    safeHeaders[k] = v;
  }
  const body = new Blob([ciphertext.buffer.slice(0) as ArrayBuffer], {
    type: 'application/octet-stream',
  });
  const res = await fetch(url, { method: 'PUT', headers: safeHeaders, body });
  if (!res.ok) {
    throw new Error(`PUT failed: status=${res.status}`);
  }
}

/**
 * Read a `File` into a `Uint8Array`. Works in browser and jsdom.
 */
async function readFileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

export interface UseImportAllRunnerInput {
  /**
   * The takeout zip to import. The hook reads + parses it on mount and
   * on file change (rare — parents typically pick once and unmount on
   * close).
   */
  file: File;
}

export interface UseImportAllRunnerResult {
  phase: DialogPhase;
  /**
   * Begin the import run. Caller passes the typed phrase; the runner
   * passes it to the text-leg POST when `targetNonEmpty` was true.
   */
  start: (phrase: string) => void;
  /** Abort any in-flight orchestrator run. The parent unmounts to close. */
  cancel: () => void;
}

/**
 * Drive the import state machine.
 */
export function useImportAllRunner(input: UseImportAllRunnerInput): UseImportAllRunnerResult {
  const { file } = input;
  const [phase, setPhase] = useState<DialogPhase>({ kind: 'parsing' });
  const abortRef = useRef<AbortController | null>(null);

  // Parsed-zip bag populated by the parse-on-mount effect and consumed
  // by `start`. Holding the parsed bag (entries map + manifest +
  // envelope) — not the raw zip bytes — means the orchestrator never
  // re-unzips at commit time. At hundreds-of-MB takeout sizes this is
  // the difference between one peak inflation and two.
  const parsedRef = useRef<ParsedTakeoutZip | null>(null);

  // Parse the zip + dry-run on mount or when `file` changes. The
  // dialog mounts at `parsing`; this effect transitions to `preflight`
  // (or `error`) once the async work settles.
  useEffect(() => {
    let cancelled = false;
    // Reset to `parsing` when `file` changes — the async block below
    // then settles into `preflight` or `error`. Fires once per file
    // change, not a cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhase({ kind: 'parsing' });

    void (async () => {
      let bytes: Uint8Array;
      try {
        bytes = await readFileBytes(file);
      } catch (err) {
        if (cancelled) return;
        console.warn('[import] file read failed', err);
        setPhase({ kind: 'error', message: STRINGS.dataExchange.importError });
        return;
      }

      // Parse + structurally validate ONCE. The bag is held in
      // `parsedRef` and threaded through `start` to the orchestrator
      // so the same bytes are never inflated twice — at hundreds-of-MB
      // takeout sizes that's a peak-memory halving.
      let bag: ParsedTakeoutZip;
      try {
        bag = parseTakeoutZip(bytes);
      } catch (err) {
        if (cancelled) return;
        console.warn('[import] zip parse failed', err);
        setPhase({
          kind: 'error',
          message: STRINGS.dataExchange.importValidationFailed,
        });
        return;
      }

      if (bag.envelope.schema_version !== SCHEMA_VERSION) {
        if (cancelled) return;
        setPhase({ kind: 'error', message: STRINGS.errors.schemaVersionMismatch });
        return;
      }

      const attachmentCount = (bag.envelope.attachments ?? []).length;
      const totalBytes = bag.manifest.files
        .filter((f) => f.attachmentId !== undefined)
        .reduce((sum, f) => sum + f.sizeBytes, 0);

      // Dry-run the importing instance to learn whether the target is
      // non-empty (drives the phrase prompt). The runner POSTs the
      // stripped envelope (no `attachments` key) — the same shape the
      // orchestrator's text leg sends — so the dry-run preview is
      // representative of the commit path.
      let preview: PreviewLite;
      try {
        const dryRun = await importAllApi.fetchDryRun(bag.envelope as never);
        if (cancelled) return;
        if (!dryRun) {
          setPhase({ kind: 'error', message: STRINGS.dataExchange.importError });
          return;
        }
        preview = { targetNonEmpty: dryRun.target_non_empty === true };
      } catch (err) {
        if (cancelled) return;
        console.warn('[import] dry-run failed', err);
        setPhase({ kind: 'error', message: STRINGS.dataExchange.importError });
        return;
      }

      if (cancelled) return;
      parsedRef.current = bag;
      setPhase({
        kind: 'preflight',
        envelope: bag.envelope,
        attachmentCount,
        totalBytes,
        targetNonEmpty: preview.targetNonEmpty,
      });
    })();

    return () => {
      cancelled = true;
      abortRef.current?.abort();
      abortRef.current = null;
      parsedRef.current = null;
    };
  }, [file]);

  const cancel = useCallback(() => {
    // Fire-and-forget abort: signal the orchestrator so the rollback
    // walk (DELETE-each-committed-id) starts in the background. The
    // parent unmounts the dialog after calling cancel — the effect
    // cleanup will null the refs.
    //
    // Edge case (accepted): if the user cancels mid-run on a target
    // that was non-empty pre-import and re-opens the dialog before
    // the rollback walk finishes, the next dry-run may still see
    // committed rows from the cancelled run. The window closes within
    // the time it takes to DELETE each committed id (single
    // round-trip per id, so usually sub-second for a small batch).
    // Awaiting the rollback here would block the dialog close on a
    // network walk and trade a brittle UX for a correctness fix that
    // isn't structurally needed — the orphan reaper handles eventual
    // B2 cleanup either way (data-model.md §6.11).
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const start = useCallback((phrase: string) => {
    const bag = parsedRef.current;
    if (!bag) return;
    const envelope = bag.envelope;

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const totalCount = (envelope.attachments ?? []).length;
    // The preflight readout's totalBytes is what the dialog seeds;
    // re-read it from the latest preflight phase for the progress
    // hand-off.
    let totalSizeBytes = 0;
    setPhase((prev) => {
      if (prev.kind === 'preflight') {
        totalSizeBytes = prev.totalBytes;
      }
      return {
        kind: 'progress',
        totalCount,
        totalSizeBytes,
        filesDone: 0,
        bytesDone: 0,
        currentFile: '',
      };
    });

    let filesDone = 0;
    let bytesDone = 0;

    // Captured at text-leg time, consumed by every subsequent
    // per-attachment call. When the import wipes users
    // (`sessionInvalidated: true` on the response), the operator's
    // session row CASCADEd away with their `users` row; the bearer
    // token here lets the binary leg continue against the dead
    // session. Empty-target / non-invalidating paths leave it null
    // and the per-attachment calls fall back to the still-valid
    // session cookie.
    let bearerImportToken: string | null = null;
    let wasSessionInvalidated = false;
    // Suppression bridges the window between the text-leg wiping
    // `users` (and cascading the session) and the dialog's close
    // handler firing the redirect. Without it, the very next
    // background fetch (projectStore, SSE-driven refresh) sees a 401
    // and triggers the global session-expired redirect, which
    // unmounts the dialog before the bearer-authed binary leg can
    // run — dropping every attachment on the floor.
    let suppressed = false;

    void (async () => {
      try {
        const result: ImportAllResult = await importAllFromZip({
          // Hot path — the parsed bag is reused verbatim. The
          // orchestrator skips its own `unzipSync` call and the
          // structural validators that `pickFile` already ran.
          parsed: bag,
          pinnedSchemaVersion: SCHEMA_VERSION,
          postTextLeg: async (envelopeWithoutAttachments: Omit<ImportEnvelope, 'attachments'>) => {
            // Activate suppression BEFORE the POST is sent: the server
            // publishes `project_changed` SSE events as it commits each
            // restored project row. Those land on the client mid-flight,
            // trigger projectStore.fetchProjects, hit `/api/projects`
            // with the wiped session cookie, and would otherwise fire
            // handleSessionExpired before the orchestrator's response
            // handler ever runs. Roll back if the server reports no
            // invalidation, so non-wipe paths don't silently swallow
            // unrelated 401s.
            if (!suppressed) {
              beginSessionExpiredSuppression();
              suppressed = true;
            }
            const res = await importAllApi.postTextLeg(envelopeWithoutAttachments as never, phrase);
            if (res.ok) {
              bearerImportToken = res.importToken;
              wasSessionInvalidated = res.sessionInvalidated;
              if (!res.sessionInvalidated && suppressed) {
                endSessionExpiredSuppression();
                suppressed = false;
              }
            } else if (suppressed) {
              endSessionExpiredSuppression();
              suppressed = false;
            }
            // Narrow back to the orchestrator's
            // `{ ok, message? }` contract — it never reads the
            // bearer token (auth is the runner's concern).
            return { ok: res.ok, message: res.message };
          },
          prepareAttachment,
          initAttachment: makeInitAttachment(() => bearerImportToken ?? undefined),
          putCiphertext,
          completeAttachment: async (id: string) => {
            // Resolve the projectId from the entry list — the
            // orchestrator passes only the attachment id; the state
            // adapter requires both.
            const entry = (envelope.attachments ?? []).find((a) => a.id === id);
            if (!entry) {
              throw new Error(`completeAttachment: unknown attachment id ${id}`);
            }
            return importAllApi.importComplete(entry.projectId, id, bearerImportToken ?? undefined);
          },
          deleteAttachment: async (id: string) => {
            const entry = (envelope.attachments ?? []).find((a) => a.id === id);
            if (!entry) return;
            await importAllApi.importDelete(entry.projectId, id, bearerImportToken ?? undefined);
          },
          signal: ctrl.signal,
          onProgress: (event) => {
            if (event.kind === 'attachment-start') {
              setPhase((prev) => {
                if (prev.kind !== 'progress') return prev;
                return { ...prev, currentFile: event.entry.fileName };
              });
            } else if (event.kind === 'attachment-committed') {
              filesDone += 1;
              bytesDone += event.entry.sizeBytes;
              setPhase((prev) => {
                if (prev.kind !== 'progress') return prev;
                return { ...prev, filesDone, bytesDone };
              });
            } else if (event.kind === 'attachment-failed') {
              // Skipped entries still advance the file counter so the
              // user sees the run finish even when some entries
              // skipped.
              filesDone += 1;
              setPhase((prev) => {
                if (prev.kind !== 'progress') return prev;
                return { ...prev, filesDone };
              });
            }
          },
        });
        if (ctrl.signal.aborted) return;
        setPhase({
          kind: 'summary',
          committedCount: result.committedCount,
          totalAttachments: result.totalAttachments,
          failures: result.failures,
          sessionInvalidated: wasSessionInvalidated,
        });
        // Post-import: every committed attachment moved counters
        // (pending → ready). One refresh after the orchestrator
        // settles is enough — the per-attachment SSE broadcasts
        // reach the same store via the round-trip path.
        if (result.committedCount > 0) {
          void useStorageUsageStore.getState().refresh();
        }
      } catch (err) {
        if (ctrl.signal.aborted) return;
        // Token-invalid escalates to a dedicated phase so the
        // operator gets a re-auth prompt instead of an opaque
        // "import failed" message followed by N identical per-entry
        // failures.
        const errCode = (err as { code?: unknown } | null)?.code;
        if (errCode === 'IMPORT_TOKEN_INVALID') {
          console.warn('[import] bearer token invalid mid-import', err);
          setPhase({
            kind: 'token-invalid',
            message: STRINGS.auth.importTokenInvalid,
          });
        } else {
          console.warn('[import] orchestrator failed', err);
          setPhase({
            kind: 'error',
            message:
              err instanceof Error
                ? `${STRINGS.dataExchange.importError} ${err.message}`
                : STRINGS.dataExchange.importError,
          });
        }
      } finally {
        bearerImportToken = null;
        // End suppression here only on the non-invalidating paths
        // (empty target, early failure before the session was wiped).
        // When the text leg invalidated the session, hand suppression
        // off to the dialog — the summary phase is shown to the user,
        // and any 401-triggering refresh (storage-usage, SSE-driven
        // fetch) that races during that window would otherwise fire
        // the global redirect before the user can close the dialog.
        // The dialog's close path ends suppression and drives the
        // redirect itself.
        if (suppressed && !wasSessionInvalidated) {
          endSessionExpiredSuppression();
          suppressed = false;
        }
        if (abortRef.current === ctrl) abortRef.current = null;
      }
    })();
  }, []);

  return { phase, start, cancel };
}
