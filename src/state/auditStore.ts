/**
 * Audit-log client state — list fetching, pagination, filtering.
 *
 * The audit surface is read-only (AC-642), so this store
 * exposes no mutation actions — only fetchers and local filter state.
 * Pagination uses an offset window with append-on-next-page semantics
 * so "Ältere anzeigen" can extend the current result without collapsing
 * already-rendered rows (ui/workflow-views.md §8.4.1,
 * ui/management.md §8.13).
 *
 * **Factory, not singleton.** Two surfaces render the feed — the global
 * Aktivität view and the per-project detail panel overlay — and the
 * latter mounts ON TOP of the former without unmounting it. A singleton
 * store would have both consumers writing over each other's `entries`
 * via `fetchList(filters)`, turning the staleness-guard into a coin
 * flip on which surface wins. `createAuditStore()` returns a fresh
 * Zustand instance per consumer; each instance owns its own `fetchSeq`
 * counter, so responses from one surface never land on another.
 */

import { create } from 'zustand';
import type { AuditEntry, AuditListParams } from '@/domain/audit';
import { auditApi } from '@/api/client';
import { AUDIT_PAGE_SIZE } from '@/config/auditPageSize';
import { handleSessionExpired } from './sessionExpired';

interface AuditState {
  /** Currently rendered entries (most recent first). */
  entries: AuditEntry[];
  /** Total rows matching the current filter — server-provided. */
  total: number;
  /** Active filter / pagination parameters for the next fetch. */
  filters: AuditListParams;
  loading: boolean;
  /** True while a "load older" fetch is in flight. */
  loadingMore: boolean;
  error: string | null;

  /**
   * Replace `entries` with a fresh fetch. Resets pagination —
   * callers that change filters should use this path, not append.
   */
  fetchList: (filters?: AuditListParams) => Promise<void>;

  /**
   * Fetch the next page (older rows) using the current `limit` and an
   * offset derived from `entries.length`. Appends to `entries`; does
   * not collapse or reorder already-rendered rows (AC-628).
   */
  appendNextPage: () => Promise<void>;

  /** Reset the store to its initial state. */
  reset: () => void;
}

/**
 * Build a fresh Zustand audit store. One instance per consumer surface
 * — never reach for a shared singleton. Each instance closes over its
 * own `fetchSeq` counter so a later call on the same instance discards
 * a stale in-flight response from an earlier call without interacting
 * with any other instance.
 */
export function createAuditStore() {
  const initialState = {
    entries: [] as AuditEntry[],
    total: 0,
    filters: { limit: AUDIT_PAGE_SIZE } satisfies AuditListParams,
    loading: false,
    loadingMore: false,
    error: null as string | null,
  };

  /**
   * Monotonic counter — identical pattern to `projectStore.ts`. Local
   * to the closure: each store instance has its own counter, so two
   * concurrent feeds cannot invalidate each other. A newer call
   * increments the counter; any in-flight response whose captured
   * `seq` no longer matches is discarded.
   */
  let fetchSeq = 0;

  return create<AuditState>((set, get) => ({
    ...initialState,

    fetchList: async (filters) => {
      const merged: AuditListParams = {
        ...initialState.filters,
        ...(filters ?? get().filters),
        offset: 0,
      };
      const seq = ++fetchSeq;
      set({ loading: true, error: null, filters: merged });
      const result = await auditApi.list(merged);
      if (seq !== fetchSeq) return;
      if (!result.ok) {
        if (result.sessionExpired) {
          handleSessionExpired();
          return;
        }
        set({ loading: false, error: result.error.message });
        return;
      }
      set({
        entries: result.data.data,
        total: result.data.total,
        loading: false,
      });
    },

    appendNextPage: async () => {
      const { entries, filters, loadingMore, loading } = get();
      if (loadingMore || loading) return;
      const limit = filters.limit ?? AUDIT_PAGE_SIZE;
      const offset = entries.length;
      if (offset >= get().total && get().total > 0) return;
      // Capture the sequence at call time. A concurrent `fetchList`
      // (e.g. a filter change) increments the counter; when this
      // append's response arrives the captured seq no longer matches
      // and we drop it — otherwise the older-page rows would land on
      // top of the new filter's result set.
      const seq = ++fetchSeq;
      set({ loadingMore: true, error: null });
      const result = await auditApi.list({ ...filters, offset, limit });
      if (seq !== fetchSeq) return;
      if (!result.ok) {
        if (result.sessionExpired) {
          handleSessionExpired();
          return;
        }
        set({ loadingMore: false, error: result.error.message });
        return;
      }
      // Dedup by id — the server returns a stable order, but a concurrent
      // write between pages could land the same id in both windows. The
      // AC pins "appends older entries without collapsing", so a dup is
      // a UX bug, not a crash.
      const knownIds = new Set(entries.map((e) => e.id));
      const fresh = result.data.data.filter((e) => !knownIds.has(e.id));
      set((s) => ({
        entries: [...s.entries, ...fresh],
        total: result.data.total,
        loadingMore: false,
      }));
    },

    reset: () => set({ ...initialState, filters: { limit: AUDIT_PAGE_SIZE } }),
  }));
}

export type AuditStore = ReturnType<typeof createAuditStore>;
