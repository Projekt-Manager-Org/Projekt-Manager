/**
 * Shared subscription that powers the Footer storage badge
 * (ui/index.md §8.1.2) and the DatenView storage row
 * (ui/daten.md §8.11.3).
 *
 * Four refresh triggers, one fetch path:
 *   1. First subscriber mount — `subscribe()` triggers `getGlobal()`.
 *   2. `visibilitychange` → `visible` — refetch when the tab returns.
 *      Hidden alone is not a trigger; refreshing while the tab is
 *      hidden burns cycles for an off-screen UI nobody is reading.
 *   3. Post-mutation `refresh()` — orchestrators that move counter
 *      bytes invoke this after their successful path.
 *   4. `storage_usage_changed` SSE frame — cross-session invalidation
 *      from another browser/tab's mutation.
 *
 * Subscribers are reference-counted: the listeners (`visibilitychange`,
 * SSE) are attached on first subscribe and torn down on last
 * unsubscribe. A second subscriber joining a loaded store does NOT
 * trigger a refetch — Footer + DatenView mounted in the same render
 * pass produce a single network call.
 *
 * Auth-gating contract — the SSE attach path inside `attachListeners()`
 * opens the shared `/api/events` EventSource, which the server's
 * `authenticate` preHandler rejects with 401 before any session cookie
 * exists. Per WHATWG the EventSource then transitions to CLOSED, and
 * the client's recovery would read that as an expired session.
 *
 * The mitigation is two-layer:
 *   1. Both consumers (`StorageUsageBadge` in `Footer`, `StorageUsageRow`
 *      in `DatenView`) only mount under the `authUser`-truthy branch
 *      in `App.tsx`. New consumers MUST keep that placement — pulling
 *      a `subscribe()` call out of the authenticated tree resurrects
 *      the bug.
 *   2. `src/sse/client.ts`'s `ensureSource()` is defensive: a cached
 *      source in CLOSED state is recreated on the next subscribe and
 *      every still-tracked DOM listener re-attached. So even a
 *      mid-stream session revocation that drops the connection is
 *      self-healing on the next mount cycle.
 */

import { create } from 'zustand';
import { storageUsageApi, type StorageUsageDto } from '@/api/client';
import { STORAGE_USAGE_CHANGED } from '@/config/sseEvents';
import { onSseEvent } from '@/sse/client';
import { handleSessionExpired } from './sessionExpired';

interface StorageUsageStore {
  data: StorageUsageDto | null;
  subscribe: () => () => void;
  refresh: () => Promise<void>;
  __resetForTests: () => void;
}

let subscriberCount = 0;
let visibilityHandler: (() => void) | null = null;
let unsubscribeSse: (() => void) | null = null;
// In-flight epoch — every refetch() captures a snapshot before
// awaiting and only commits its result if no newer call has started
// in the meantime. A burst of triggers (mount + visibilitychange +
// SSE arriving in the same tick) issues N parallel GETs; without
// this gate the slowest response wins because `setState` blindly
// overwrites with whichever promise resolves last.
let refetchEpoch = 0;

async function refetch(): Promise<void> {
  const epoch = ++refetchEpoch;
  const result = await storageUsageApi.getGlobal();
  if (epoch !== refetchEpoch) return;
  if (result.ok) {
    useStorageUsageStore.setState({ data: result.data });
    return;
  }
  // SSE delivers an invalidation hint, then we refetch — but if the
  // refetch lands after session expiry (a heartbeat that didn't fire in
  // time, a tab restored after a long sleep) the prior `data` would
  // otherwise sit in the badge / DatenView row indefinitely. Delegate
  // to the shared session-expiry handler — same surface every other
  // store uses (state/extractionActions.ts, state/attachmentStore.ts).
  // Non-session-expiry failures (transient 5xx, network blip) leave
  // `data` as-is; the next mount / visibilitychange / SSE / explicit
  // refresh() retries.
  if (result.sessionExpired) {
    handleSessionExpired();
  }
}

function attachListeners(): void {
  visibilityHandler = (): void => {
    if (document.visibilityState === 'visible') {
      void refetch();
    }
  };
  document.addEventListener('visibilitychange', visibilityHandler);
  unsubscribeSse = onSseEvent(STORAGE_USAGE_CHANGED, () => {
    void refetch();
  });
}

function detachListeners(): void {
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
  }
  if (unsubscribeSse) {
    unsubscribeSse();
    unsubscribeSse = null;
  }
}

export const useStorageUsageStore = create<StorageUsageStore>((set) => ({
  data: null,

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

  refresh: async () => {
    await refetch();
  },

  __resetForTests: () => {
    detachListeners();
    subscriberCount = 0;
    refetchEpoch = 0;
    set({ data: null });
  },
}));
