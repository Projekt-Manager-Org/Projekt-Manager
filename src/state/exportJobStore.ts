/**
 * exportJobStore — the DatenView "Vollständiger Export" subscription
 * ([ui/daten.md §8.11.1]). Backs the export dialog's resume probe, the
 * SSE-driven progress readout, and the start action.
 *
 * Modeled on `storageUsageStore`: a refcounted subscription that owns the
 * fetch lifecycle, an epoch-guarded refetch (the slowest of a burst of
 * parallel GETs must not win), and session-expiry delegation to the shared
 * handler. The job lives server-side; the SSE frame is invalidation-only
 * (ADR-0025), so every trigger refetches the latest export job over REST.
 *
 * Triggers:
 *   1. First subscriber mount — the resume probe (`getLatest`) re-attaches to
 *      an in-flight / `ready` job so a page reload loses nothing (AC-335).
 *   2. `data_exchange_job_changed` SSE frame — refetch the advanced row (AC-333).
 *   3. `start()` — POST a new job (AC-322); a 409 `EXPORT_JOB_ACTIVE` re-attaches
 *      to the already-running build rather than surfacing an error (AC-331).
 *
 * Auth-gating: `subscribe()` opens the shared `/api/events` EventSource via
 * `onSseEvent`; the consumer (DatenView) only mounts under the `authUser`-truthy
 * branch in `App.tsx` (same contract as `storageUsageStore`).
 */

import { create } from 'zustand';
import { exportJobApi, type DataExchangeJobDto } from '@/api/client';
import { DATA_EXCHANGE_JOB_CHANGED } from '@/config/sseEvents';
import { onSseEvent } from '@/sse/client';
import { handleSessionExpired } from './sessionExpired';

// Re-export the job DTO so UI components read the shape from the state layer —
// `no-restricted-imports` (AC-33) forbids them importing `@/api/client` directly.
export type { DataExchangeJobDto } from '@/api/client';

interface ExportJobStore {
  /** The latest export job, or null when none has ever run / been probed. */
  job: DataExchangeJobDto | null;
  /** Refcounted subscription; returns an unsubscribe handle. */
  subscribe: () => () => void;
  /** Start a new export job (POST), or re-attach on 409 EXPORT_JOB_ACTIVE. */
  start: () => Promise<void>;
  /**
   * URL builder for the Range-capable archive download. Exposed here so the
   * dialog never imports the API client directly (AC-33 — UI dispatches through
   * the state layer); the browser drives the download via an `<a href download>`.
   */
  downloadPath: (id: string) => string;
  /**
   * Drop the cached job on session teardown (logout / expiry). Without this the
   * module-singleton `job` would survive into the next operator's first paint
   * on the same tab — the same cross-session leak `clearDownstreamState` already
   * closes for the other downstream stores. Bumps the epoch so an in-flight
   * refetch from the prior session cannot commit after the reset.
   */
  reset: () => void;
  __resetForTests: () => void;
}

let subscriberCount = 0;
let unsubscribeSse: (() => void) | null = null;
// In-flight epoch — every refetch captures a snapshot before awaiting and only
// commits if no newer call started meanwhile. A burst (mount probe + SSE frame
// in the same tick) issues parallel GETs; without this the slowest wins.
let refetchEpoch = 0;

async function refetch(): Promise<void> {
  const epoch = ++refetchEpoch;
  const result = await exportJobApi.getLatest();
  if (epoch !== refetchEpoch) return;
  if (result.ok) {
    useExportJobStore.setState({ job: result.data.job });
    return;
  }
  // A refetch landing after session expiry (a heartbeat that didn't fire, a
  // tab restored after a long sleep) delegates to the shared handler; the
  // last-good `job` stays put until the redirect lands. Non-auth failures
  // (transient 5xx / network) leave state untouched — the next trigger retries.
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

export const useExportJobStore = create<ExportJobStore>((set) => ({
  job: null,

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

  start: async () => {
    const result = await exportJobApi.create();
    if (result.ok) {
      set({ job: result.data });
      return;
    }
    // One-active-per-kind (AC-331): a 409 EXPORT_JOB_ACTIVE means a build is
    // already running — re-attach to it (probe the latest) rather than
    // surfacing an error, so the dialog jumps straight to the progress phase.
    if (result.error.code === 'EXPORT_JOB_ACTIVE') {
      await refetch();
      return;
    }
    if (result.sessionExpired) {
      handleSessionExpired();
    }
    // Other failures leave the dialog on its preflight phase; the user retries.
  },

  downloadPath: (id: string) => exportJobApi.downloadPath(id),

  reset: () => {
    refetchEpoch += 1;
    set({ job: null });
  },

  __resetForTests: () => {
    detachListeners();
    subscriberCount = 0;
    refetchEpoch = 0;
    set({ job: null });
  },
}));
