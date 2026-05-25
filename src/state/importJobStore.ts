/**
 * importJobStore — the DatenView "Vollständiger Import" subscription
 * ([ui/daten.md §8.11.2]). Backs the import dialog's resume probe, the
 * create+resumable-upload flow, the SSE-driven processing readout, and the
 * mid-wipe re-auth path.
 *
 * Modeled on `storageUsageStore` / `exportJobStore`: a refcounted subscription
 * with an epoch-guarded refetch and session-expiry delegation. Two extra
 * concerns beyond the export side:
 *
 *   - **Two progress phases.** The client→VPS upload (`uploadOffset`) is
 *     client-known; once the upload completes the server flips the job to
 *     `running` and the per-attachment restore progress arrives over the job
 *     row (SSE-refetched).
 *   - **Mid-wipe re-auth (AC-330).** The restore wipes `users`, so the
 *     operator's session dies mid-run. The SSE-driven refetch then 401s — this
 *     is the EXPECTED path: delegate to `handleSessionExpired` (route to login).
 *     After re-login, DatenView's mount-time resume probe (`getLatest`)
 *     re-attaches to the same job. No bearer token is involved.
 *
 * The destructive guard (emptiness + override + confirmation phrase) runs
 * server-side AT create (AC-329); `create` maps its rejections to `createError`.
 */

import { create } from 'zustand';
import { importJobApi, type DataExchangeJobDto } from '@/api/client';
import { DATA_EXCHANGE_JOB_CHANGED } from '@/config/sseEvents';
import { onSseEvent } from '@/sse/client';
import { handleSessionExpired } from './sessionExpired';

// Re-export the job DTO so UI components read the shape from the state layer —
// `no-restricted-imports` (AC-33) forbids them importing `@/api/client` directly.
export type { DataExchangeJobDto } from '@/api/client';

/** Create-time rejection the dialog surfaces; null once a create succeeds. */
export type ImportCreateError = 'target_not_empty' | 'confirmation_mismatch';

interface ImportJobStore {
  /** The latest import job, or null. */
  job: DataExchangeJobDto | null;
  /** Bytes uploaded to the VPS so far (client→VPS phase). */
  uploadOffset: number;
  /** The last create-time rejection, or null. */
  createError: ImportCreateError | null;
  /**
   * Id of a terminal import job the operator dismissed. A finished job's row
   * persists after its staged file is reaped, so `latest('import')` keeps
   * returning it; without remembering the dismissal the summary modal would
   * re-pop on every Daten revisit. Held in the store (not a DatenView module
   * var) so `reset()` clears it on session teardown — a re-auth is NOT a full
   * page reload, so a module var would have leaked across operators.
   */
  dismissedJobId: string | null;
  subscribe: () => () => void;
  create: (args: { file: File; override: boolean; phrase: string | null }) => Promise<void>;
  upload: (file: File) => Promise<void>;
  /** Mark `id` as dismissed so a terminal job stops re-opening its dialog. */
  dismiss: (id: string | null) => void;
  /** Drop all cached state on session teardown (parity with exportJobStore). */
  reset: () => void;
  __resetForTests: () => void;
}

/**
 * Resumable-upload chunk size. The PATCH body streams to disk server-side
 * (bounded memory either way); 8 MiB keeps the round-trip count low for a
 * multi-GB archive without a large per-request buffer.
 */
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Circuit breaker for the resumable-upload loop: the max consecutive iterations
 * that fail to advance the offset before giving up. A server wedged returning
 * 409 with a stuck offset would otherwise spin forever; bounding it lets the
 * job fall back to its (SSE-refetched) status / the operator retrying.
 */
const MAX_UPLOAD_STALLS = 5;

let subscriberCount = 0;
let unsubscribeSse: (() => void) | null = null;
let refetchEpoch = 0;

async function refetch(): Promise<void> {
  const epoch = ++refetchEpoch;
  const result = await importJobApi.getLatest();
  if (epoch !== refetchEpoch) return;
  if (result.ok) {
    useImportJobStore.setState({ job: result.data.job });
    return;
  }
  // EXPECTED mid-wipe path (AC-330): the users-wipe CASCADE-dropped the
  // operator's session, so this poll 401s. Delegate to the shared handler
  // (route to login); keep the last-good `job`. DatenView's mount-time resume
  // probe re-attaches after re-login. Non-auth failures leave state untouched.
  if (result.sessionExpired) {
    handleSessionExpired();
  }
}

function attachListeners(): void {
  unsubscribeSse = onSseEvent(DATA_EXCHANGE_JOB_CHANGED, () => {
    void refetch();
  });
}

function detachListeners(): void {
  if (unsubscribeSse) {
    unsubscribeSse();
    unsubscribeSse = null;
  }
}

export const useImportJobStore = create<ImportJobStore>((set, get) => ({
  job: null,
  uploadOffset: 0,
  createError: null,
  dismissedJobId: null,

  subscribe: () => {
    subscriberCount += 1;
    if (subscriberCount === 1) {
      attachListeners();
      void refetch();
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      subscriberCount = Math.max(0, subscriberCount - 1);
      if (subscriberCount === 0) {
        detachListeners();
      }
    };
  },

  create: async ({ file, override, phrase }) => {
    // Clear any prior rejection so a retry starts clean.
    set({ createError: null });
    const result = await importJobApi.create({ uploadLength: file.size, override, phrase });
    if (result.ok) {
      set({ job: result.data, createError: null, uploadOffset: 0 });
      return;
    }
    // Destructive guard rejections (AC-329) — surfaced for the dialog to act on,
    // no job minted server-side.
    if (result.error.code === 'TARGET_NOT_EMPTY') {
      set({ createError: 'target_not_empty' });
      return;
    }
    if (result.error.code === 'RESTORE_CONFIRMATION_MISMATCH') {
      set({ createError: 'confirmation_mismatch' });
      return;
    }
    // One-active-per-kind (AC-331): re-attach to the running import (parity
    // with the export side) — the active job owns the single slot, so there is
    // nothing to upload. No createError: the dialog shows the running job's
    // progress, not an error.
    if (result.error.code === 'IMPORT_JOB_ACTIVE') {
      await refetch();
      return;
    }
    if (result.sessionExpired) {
      handleSessionExpired();
    }
  },

  upload: async (file) => {
    const id = get().job?.id;
    if (!id) return;
    const total = file.size;

    // Resume from the server's authoritative offset (HEAD) — a re-attached
    // upload must not re-send bytes the VPS already holds (AC-326). A failed
    // HEAD (transient blip) keeps the last-known offset rather than snapping to
    // 0 — re-sending from 0 would 409 on the first chunk and yo-yo the
    // progress bar; the in-loop re-HEAD recovers the true offset either way.
    const head = await importJobApi.headOffset(id);
    let offset = head.ok ? head.offset : get().uploadOffset;
    set({ uploadOffset: offset });

    let stalls = 0;
    while (offset < total) {
      const before = offset;
      const chunk = file.slice(offset, Math.min(offset + UPLOAD_CHUNK_BYTES, total));
      const res = await importJobApi.patchChunk(id, { offset, chunk });
      if (res.ok) {
        offset = res.offset;
        set({ uploadOffset: offset });
        // A 2xx that does NOT advance the offset (a misbehaving server/proxy
        // returning 200 without an Upload-Offset header → patchChunk falls back
        // to the request offset) would otherwise spin `while (offset < total)`
        // forever. Feed the SAME stall breaker the 409 path uses.
        if (offset <= before) {
          stalls += 1;
          if (stalls >= MAX_UPLOAD_STALLS) break;
        } else {
          stalls = 0;
        }
        continue;
      }
      // Stale offset (409 UPLOAD_OFFSET_CONFLICT): the server left its offset
      // unchanged. Re-read the authoritative offset and resume (retry-safe).
      if (res.status === 409) {
        const reHead = await importJobApi.headOffset(id);
        offset = reHead.ok ? reHead.offset : offset;
        set({ uploadOffset: offset });
        // No forward progress this round — bound the retries so a wedged server
        // cannot spin the loop forever.
        if (offset <= before) {
          stalls += 1;
          if (stalls >= MAX_UPLOAD_STALLS) break;
        } else {
          stalls = 0;
        }
        continue;
      }
      // 413 (past length) / 401 / network — stop. The job status (SSE-refetched)
      // or the re-auth flow takes over from here.
      break;
    }
  },

  dismiss: (id) => {
    set({ dismissedJobId: id });
  },

  reset: () => {
    refetchEpoch += 1;
    set({ job: null, uploadOffset: 0, createError: null, dismissedJobId: null });
  },

  __resetForTests: () => {
    detachListeners();
    subscriberCount = 0;
    refetchEpoch = 0;
    set({ job: null, uploadOffset: 0, createError: null, dismissedJobId: null });
  },
}));
