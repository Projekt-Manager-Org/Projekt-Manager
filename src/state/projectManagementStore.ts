/**
 * Project management view state — list with search, create, update.
 *
 * Separate from the Kanban projectStore so management search/filtering
 * does not interfere with the Kanban board's full project list.
 */

import { create } from 'zustand';
import type { Address, Project, Customer } from '@/domain/types';
import {
  projectApi,
  customerApi,
  workerApi,
  type ProjectSortKey,
  type SortDir,
} from '@/api/client';
import { handleSessionExpired } from './sessionExpired';
import { useProjectStore } from './projectStore';
import { useStorageUsageStore } from './storageUsageStore';

export type Worker = { userId: string; displayName: string };

// Re-export the sort-key/direction types so UI components reach them
// through the state layer (the API client is off-limits to UI per
// ESLint `no-restricted-imports`).
export type { ProjectSortKey, SortDir };

// Monotonic sequence for fetchProjects. Mirrors customerStore — see that
// store's `customerFetchSeq` comment for the rationale.
let projectFetchSeq = 0;

/**
 * Result of `createProject`. Mirrors `CreateCustomerOutcome` — see that
 * type's comment for the meaning of `'conflict'`.
 */
export type CreateProjectOutcome = { status: 'ok' } | { status: 'error' } | { status: 'conflict' };

interface ProjectManagementState {
  projects: Project[];
  customers: Customer[];
  /**
   * Assignable-worker pool for the Mitarbeiter filter dropdown. Loaded
   * once via `fetchWorkers` (lazy — only when the filter is opened or
   * when a saved selection needs to be hydrated). Shape mirrors
   * `Project.assignedWorkers` so the UI can reuse the same chip type.
   */
  workers: Worker[];
  loading: boolean;
  error: string | null;
  /**
   * Whether the list should include archived (soft-deleted) projects.
   * Default `false` — archived rows are hidden. Toggled by the
   * "Archivierte einblenden" checkbox in the management toolbar (AC-152).
   */
  showArchived: boolean;
  /**
   * Mitarbeiter filter — selected worker user-ids (OR semantics) and
   * the "Nicht zugewiesen" branch flag. Both are read by `fetchProjects`
   * at request time so a sort/search change while the filter is set
   * keeps the same selection in effect.
   */
  assignedWorkerIds: string[];
  includeUnassigned: boolean;
  /**
   * Toolbar search and column sort. Lifted into the store (same shape
   * as `showArchived` / `assignedWorkerIds`) so background refetches —
   * SSE `project_changed`, post-mutation refresh from `createProject`,
   * etc. — keep the user's view intact instead of clobbering it with
   * the default-ordered, unsearched list. `sortBy: null` means "no
   * explicit sort"; the server returns its historical default order.
   */
  search: string;
  sortBy: ProjectSortKey | null;
  sortDir: SortDir;

  fetchProjects: () => Promise<void>;
  searchProjects: (search: string) => Promise<Project[]>;
  fetchCustomers: () => Promise<void>;
  fetchWorkers: () => Promise<void>;
  setShowArchived: (v: boolean) => void;
  setAssignedWorkerIds: (ids: string[]) => void;
  setIncludeUnassigned: (v: boolean) => void;
  setSearch: (v: string) => void;
  setSort: (by: ProjectSortKey | null, dir: SortDir) => void;
  createProject: (data: {
    id?: string;
    number: string;
    title: string;
    customerId: string;
    /**
     * Baustelle (work-site) address. `null` (or omitted) inherits the
     * customer's billing address via the fallback rule. See
     * data-model.md §5.1, AC-280 / AC-278.
     */
    siteAddress?: Address | null;
  }) => Promise<CreateProjectOutcome>;
  updateProject: (
    id: string,
    data: {
      title?: string;
      customerId?: string;
      estimatedValue?: number | null;
      notes?: string | null;
      /**
       * PATCH semantics: omit to leave unchanged, `null` to clear,
       * triple to overwrite. See AC-279 / AC-280.
       */
      siteAddress?: Address | null;
    },
  ) => Promise<Project | null>;
  updateDates: (
    id: string,
    dates: { plannedStart?: string | null; plannedEnd?: string | null },
  ) => Promise<Project | null>;
  deleteProject: (id: string) => Promise<boolean>;
  /**
   * Hard-delete an archived project (AC-155..158). Returns:
   *   - true on 204 success (row removed from local state)
   *   - true on 404 — treat as "already gone", remove locally, no error
   *   - false on 409 (not archived) / 403 — surfaces server message
   */
  purgeProject: (id: string) => Promise<boolean>;
  /** Restore an archived project — flips deleted=true back to false. */
  restoreProject: (id: string) => Promise<boolean>;
  clearError: () => void;
}

export const useProjectManagementStore = create<ProjectManagementState>((set, get) => ({
  projects: [],
  customers: [],
  workers: [],
  loading: false,
  error: null,
  showArchived: false,
  assignedWorkerIds: [],
  includeUnassigned: false,
  search: '',
  sortBy: null,
  sortDir: 'asc',

  fetchProjects: async () => {
    const seq = ++projectFetchSeq;
    set({ loading: true, error: null });
    const { showArchived, assignedWorkerIds, includeUnassigned, search, sortBy, sortDir } = get();
    // Build the param bag from current state — omit undefined fields so
    // the server sees only what we actually meant to send.
    const params: {
      search?: string;
      includeArchived?: boolean;
      assignedWorkerIds?: string[];
      includeUnassigned?: boolean;
      sortBy?: ProjectSortKey;
      sortDir?: SortDir;
    } = {};
    // Trim before forwarding — preserves the typed text but keeps
    // whitespace-only queries off the wire.
    const trimmedSearch = search.trim();
    if (trimmedSearch) params.search = trimmedSearch;
    if (showArchived) params.includeArchived = true;
    if (assignedWorkerIds.length > 0) params.assignedWorkerIds = assignedWorkerIds;
    if (includeUnassigned) params.includeUnassigned = true;
    if (sortBy) {
      params.sortBy = sortBy;
      params.sortDir = sortDir;
    }
    const result = await projectApi.list(Object.keys(params).length ? params : undefined);

    // Drop superseded responses — see customerStore.fetchCustomers.
    if (seq !== projectFetchSeq) return;

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return;
      }
      set({ loading: false, error: result.error.message });
      return;
    }

    set({ projects: result.data.data, loading: false });
  },

  setShowArchived: (v: boolean) => {
    set({ showArchived: v });
  },

  setAssignedWorkerIds: (ids: string[]) => {
    set({ assignedWorkerIds: ids });
  },

  setIncludeUnassigned: (v: boolean) => {
    set({ includeUnassigned: v });
  },

  setSearch: (v: string) => {
    set({ search: v });
  },

  setSort: (by, dir) => {
    set({ sortBy: by, sortDir: dir });
  },

  fetchWorkers: async () => {
    const result = await workerApi.list();
    if (!result.ok) {
      if (result.sessionExpired) handleSessionExpired();
      return;
    }
    set({ workers: result.data.data });
  },

  fetchCustomers: async () => {
    const result = await customerApi.list();
    if (!result.ok) {
      if (result.sessionExpired) handleSessionExpired();
      return;
    }
    set({ customers: result.data.customers });
  },

  searchProjects: async (search) => {
    const trimmed = search.trim();
    if (!trimmed) return [];
    const result = await projectApi.list({ search: trimmed });
    if (!result.ok) {
      if (result.sessionExpired) handleSessionExpired();
      return [];
    }
    return result.data.data;
  },

  createProject: async (data) => {
    set({ error: null });
    const result = await projectApi.create(data);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return { status: 'error' };
      }
      if (result.error.code === 'IDEMPOTENCY_CONFLICT') {
        // Refresh the list *before* committing the error message —
        // `fetchProjects` clears `error` while loading.
        await get().fetchProjects();
        useProjectStore.getState().fetchProjects();
        set({ error: result.error.message });
        return { status: 'conflict' };
      }
      set({ error: result.error.message });
      return { status: 'error' };
    }

    // Refetch management list and also refresh the kanban store
    await get().fetchProjects();
    useProjectStore.getState().fetchProjects();
    return { status: 'ok' };
  },

  updateProject: async (id, data) => {
    set({ error: null });
    const result = await projectApi.update(id, data);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return null;
      }
      set({ error: result.error.message });
      return null;
    }

    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? result.data : p)),
    }));
    useProjectStore.getState().fetchProjects();
    return result.data;
  },

  updateDates: async (id, dates) => {
    set({ error: null });
    const result = await projectApi.updateDates(id, dates);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return null;
      }
      set({ error: result.error.message });
      return null;
    }

    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? result.data : p)),
    }));
    useProjectStore.getState().fetchProjects();
    return result.data;
  },

  deleteProject: async (id) => {
    set({ error: null });
    const result = await projectApi.delete(id);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return false;
      }
      set({ error: result.error.message });
      return false;
    }

    // Archive is a soft-delete. When the user has "Archivierte einblenden"
    // on, keep the row visible with its archived state flipped so the UI
    // matches a fresh fetch; when off, drop it from the local list.
    set((s) => ({
      projects: s.showArchived
        ? s.projects.map((p) => (p.id === id ? { ...p, deleted: true } : p))
        : s.projects.filter((p) => p.id !== id),
    }));
    useProjectStore.getState().fetchProjects();
    return true;
  },

  purgeProject: async (id) => {
    set({ error: null });
    const result = await projectApi.purge(id);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return false;
      }
      // 404 on purge is a race — another client just removed the row, or
      // the local list is stale. Either way the user's intent ("make it
      // go away") is satisfied; drop the row locally and succeed.
      if (result.category === 'not_found') {
        set((s) => ({
          projects: s.projects.filter((p) => p.id !== id),
        }));
        useProjectStore.getState().fetchProjects();
        return true;
      }
      // 409 CONFLICT (not archived) and 403 NOT_PERMITTED surface the
      // server's German message to the user.
      set({ error: result.error.message });
      return false;
    }

    set((s) => ({
      projects: s.projects.filter((p) => p.id !== id),
    }));
    useProjectStore.getState().fetchProjects();
    // Defence in depth alongside the SSE roundtrip — the server emits
    // `storage_usage_changed` post-commit when the purge cascade moved
    // bytes (AC-270), but if the channel is unhealthy (proxy issue,
    // dropped reconnect) the actor's Footer badge / DatenView row stays
    // current via this same-tab refresh. Mirrors attachmentStore.
    void useStorageUsageStore.getState().refresh();
    return true;
  },

  restoreProject: async (id) => {
    set({ error: null });
    const result = await projectApi.restore(id);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return false;
      }
      set({ error: result.error.message });
      return false;
    }

    // Server returns the now-active project body — write it through both
    // stores so the read-only preview flips back to editable without a
    // refetch round-trip.
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? result.data : p)),
    }));
    useProjectStore.getState().fetchProjects();
    return true;
  },

  clearError: () => set({ error: null }),
}));
