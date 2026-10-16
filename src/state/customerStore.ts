/**
 * Customer data state — list, create, update.
 *
 * Follows the same pattern as projectStore: all API communication via
 * the centralized client, session expiry delegated to authStore.
 */

import { create } from 'zustand';
import type { Customer } from '@/domain/types';
import { customerApi, type CustomerSortKey, type SortDir } from '@/api/client';
import { handleSessionExpired } from './sessionExpired';
import { useStorageUsageStore } from './storageUsageStore';
import { isVersionConflict } from './versionedWrites';

// Re-export the sort-key/direction types so UI components reach them
// through the state layer (the API client is off-limits to UI per
// ESLint `no-restricted-imports`).
export type { CustomerSortKey, SortDir };

// Monotonic sequence for fetchCustomers. Each call captures a fresh
// number; if a newer call has since been issued the older response is
// dropped instead of overwriting the user's current list. Guards against
// (a) two debounced searches racing on the wire, and (b) an SSE-driven
// refetch overlapping with a user-triggered one.
let customerFetchSeq = 0;

/**
 * Result of `createCustomer`. `'ok'` — row committed (fresh or idempotent
 * replay). `'error'` — generic failure; caller keeps the form open. `'conflict'`
 * — server returned IDEMPOTENCY_CONFLICT; the same client id was already used
 * with a different body, so the form instance is unrecoverable. The caller
 * should close the form and refresh the list.
 */
export type CreateCustomerOutcome = { status: 'ok' } | { status: 'error' } | { status: 'conflict' };

/**
 * Result of `fetchCustomerDetail` — the counts-bearing customer payload
 * from `GET /api/customers/:id`. `null` signals the store already wrote
 * a user-facing error message (or a session-expired redirect has been
 * triggered). The caller should abort its flow when null comes back.
 */
export type CustomerDetail = Customer & {
  projectCount: number;
  archivedProjectCount: number;
};

/** Outcome of `updateCustomer`. */
export type CustomerUpdateOutcome =
  { status: 'ok' } | { status: 'conflict'; customer: Customer } | { status: 'failed' };

interface CustomerState {
  customers: Customer[];
  total: number;
  loading: boolean;
  error: string | null;
  /**
   * Toolbar search and column sort. Lifted into the store so background
   * refetches — e.g. `createCustomer`'s post-commit refresh — keep the
   * user's view intact instead of resetting to default-order unfiltered.
   * `sortBy` defaults to `'name'` and `sortDir` to `'asc'` to match the
   * baseline established at mount.
   */
  search: string;
  sortBy: CustomerSortKey;
  sortDir: SortDir;

  fetchCustomers: () => Promise<void>;
  fetchCustomerDetail: (id: string) => Promise<CustomerDetail | null>;
  searchCustomers: (search: string) => Promise<Customer[]>;
  setSearch: (v: string) => void;
  setSort: (by: CustomerSortKey, dir: SortDir) => void;
  createCustomer: (data: {
    id?: string;
    name: string;
    phone?: string | null;
    email?: string | null;
    address?: { street: string; zip: string; city: string } | null;
    notes?: string | null;
  }) => Promise<CreateCustomerOutcome>;
  /**
   * Update from an edit that started at `startVersion` (behavior.md
   * §9.5). `'conflict'` carries the refetched customer the form resets
   * to; `error` holds the stale-write message.
   */
  updateCustomer: (
    id: string,
    startVersion: number,
    data: {
      name?: string;
      phone?: string | null;
      email?: string | null;
      address?: { street: string; zip: string; city: string } | null;
      notes?: string | null;
    },
  ) => Promise<CustomerUpdateOutcome>;
  deleteCustomer: (id: string) => Promise<boolean>;
  clearError: () => void;
}

export const useCustomerStore = create<CustomerState>((set, get) => ({
  customers: [],
  total: 0,
  loading: false,
  error: null,
  search: '',
  sortBy: 'name',
  sortDir: 'asc',

  fetchCustomers: async () => {
    const seq = ++customerFetchSeq;
    set({ loading: true, error: null });
    const { search, sortBy, sortDir } = get();
    const params: { search?: string; sortBy?: CustomerSortKey; sortDir?: SortDir } = {
      sortBy,
      sortDir,
    };
    // Trim before forwarding — preserves the user's typed text in the
    // input while keeping whitespace-only queries off the wire (mirrors
    // `searchCustomers`).
    const trimmedSearch = search.trim();
    if (trimmedSearch) params.search = trimmedSearch;
    const result = await customerApi.list(params);

    // Drop superseded responses — including the error path, so a slow-
    // failing old request can't flash an error after the user has moved
    // on to a fresh search/sort.
    if (seq !== customerFetchSeq) return;

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return;
      }
      set({ loading: false, error: result.error.message });
      return;
    }

    set({
      customers: result.data.customers,
      total: result.data.total,
      loading: false,
    });
  },

  searchCustomers: async (search) => {
    const trimmed = search.trim();
    if (!trimmed) return [];
    const result = await customerApi.list({ search: trimmed });
    if (!result.ok) {
      if (result.sessionExpired) handleSessionExpired();
      return [];
    }
    return result.data.customers;
  },

  createCustomer: async (data) => {
    set({ error: null });
    const result = await customerApi.create(data);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return { status: 'error' };
      }
      if (result.error.code === 'IDEMPOTENCY_CONFLICT') {
        // The underlying row already exists with a different body. Refresh
        // the list so the user sees what's there, then signal the caller
        // to close its form (the form instance cannot be safely retried).
        //
        // We refresh the list *before* setting the error — `fetchCustomers`
        // resets `error` to null during a list fetch (loading indicator
        // pattern), so the order matters: fetch first, then commit the
        // conflict message to state.
        await get().fetchCustomers();
        set({ error: result.error.message });
        return { status: 'conflict' };
      }
      set({ error: result.error.message });
      return { status: 'error' };
    }

    // Refetch to get consistent list
    await get().fetchCustomers();
    return { status: 'ok' };
  },

  updateCustomer: async (id, startVersion, data) => {
    set({ error: null });
    const result = await customerApi.update(id, startVersion, data);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return { status: 'failed' };
      }
      if (isVersionConflict(result)) {
        const fresh = await customerApi.get(id);
        if (fresh.ok) {
          set((s) => ({
            customers: s.customers.map((c) => (c.id === id ? fresh.data : c)),
            error: result.error.message,
          }));
          return { status: 'conflict', customer: fresh.data };
        }
      }
      set({ error: result.error.message });
      return { status: 'failed' };
    }

    // Update in-place
    set((s) => ({
      customers: s.customers.map((c) => (c.id === id ? result.data : c)),
    }));
    return { status: 'ok' };
  },

  deleteCustomer: async (id) => {
    set({ error: null });
    const result = await customerApi.delete(id);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return false;
      }
      set({ error: result.error.message });
      return false;
    }

    set((s) => ({
      customers: s.customers.filter((c) => c.id !== id),
      total: s.total - 1,
    }));
    // Defence in depth alongside the SSE roundtrip — the server emits
    // `storage_usage_changed` post-commit when the atomic archived-
    // project purge cascade moved bytes (AC-270). The customer may
    // have had no archived projects (no event) or the SSE channel may
    // be unhealthy; this refresh keeps the actor's Footer badge /
    // DatenView row current either way. Cheap idempotent GET.
    void useStorageUsageStore.getState().refresh();
    return true;
  },

  fetchCustomerDetail: async (id) => {
    set({ error: null });
    const result = await customerApi.get(id);
    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return null;
      }
      // Surface the error to the caller; the UI shows it via the store's
      // existing `error` channel. Do not fall back silently — callers
      // depend on this payload for destructive-flow warnings.
      set({ error: result.error.message });
      return null;
    }
    return result.data;
  },

  setSearch: (v: string) => {
    set({ search: v });
  },

  setSort: (by, dir) => {
    set({ sortBy: by, sortDir: dir });
  },

  clearError: () => set({ error: null }),
}));
