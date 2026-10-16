/**
 * Project data state — fetching, mutations, optimistic updates.
 *
 * All API communication goes through the centralized API client.
 * Session expiry is detected by the client and delegated to the auth store.
 */

import { create } from 'zustand';
import { flushSync } from 'react-dom';
import { STRINGS } from '@/config/strings';
import type { WorkflowState } from '@/config/stateConfig';
import type { Project, SummaryData } from '@/domain/types';
import { getNextState, getPreviousState } from '@/domain/transitions';
import { computeSummary } from '@/domain/summary';
import { projectApi, type ApiResult } from '@/api/client';
import { handleSessionExpired } from './sessionExpired';
import { useProjectManagementStore } from './projectManagementStore';

/**
 * Outcome of `fetchProject(id)`. Distinguishes the meaningful branches
 * the project-detail page cares about: authorization failure (AC-149
 * mirror), not-found, and everything-else. Archived (soft-deleted)
 * projects flow through `kind: 'ok'` with `project.deleted = true` —
 * the page renders them as a read-only preview.
 */
export type FetchProjectOutcome =
  | { kind: 'ok'; project: Project }
  | { kind: 'not_permitted' }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string };

interface ProjectState {
  projects: Project[];
  mutationError: string | null;
  mutationInFlight: Record<string, boolean>;

  fetchProjects: () => Promise<void>;
  /**
   * Fetch a single project by id and merge it into the local cache.
   * Used by the project-detail page route (spec §8.15); the three
   * failure branches are distinguished so the page can pick the
   * matching surface.
   */
  fetchProject: (id: string) => Promise<FetchProjectOutcome>;
  /**
   * Replace the project's assigned-worker set (§8.15.3). Applies
   * optimistically per behavior.md §9.5 and reverts on failure.
   * Returns true when the server-confirmed row has been written back.
   */
  updateAssignedWorkers: (
    id: string,
    assignedWorkerIds: string[],
    optimisticAssigned: { userId: string; displayName: string }[],
  ) => Promise<boolean>;
  transitionForward: (projectId: string) => void;
  transitionBackward: (projectId: string) => void;
  updateDates: (projectId: string, start?: string | null, end?: string | null) => void;
  clearMutationError: () => void;

  getProjectsByState: (state: WorkflowState) => Project[];
  getSummary: () => SummaryData;
  isMutationInFlight: (projectId: string) => boolean;
}

/** Monotonic counter to discard stale fetch responses. */
let fetchSeq = 0;

/**
 * Per-project serialization for `updateAssignedWorkers`. A second
 * worker-assignment mutation that fires before the first has settled
 * would otherwise capture the first's optimistic state as its own
 * `before` snapshot — a failure would then roll back to the wrong
 * baseline. Chaining the second call onto the first's promise makes
 * the two operations strictly sequential: the second's `before` is
 * whatever the server wrote back (or the revert), which is a true
 * server-authoritative snapshot. The queue is empty once all chained
 * calls settle; we drop the entry so the map does not grow unbounded.
 */
const ASSIGNED_WORKERS_QUEUE = new Map<string, Promise<unknown>>();

export const useProjectStore = create<ProjectState>((set, get) => {
  /**
   * Shared transition runner used by both forward and backward transitions.
   *
   * The two directions used to be near-duplicate methods. They differ only in:
   *   - which `getNextState`/`getPreviousState` to call
   *   - which `projectApi.transition*` to invoke
   * Everything else (in-flight tracking, optimistic-style commit, error
   * handling, session-expiry delegation) is identical.
   *
   * `flushSync` is used unconditionally on success: in the forward case the
   * card moves to a new column, and React must commit the re-enabled
   * controls to the DOM *before* the layout shift; in the backward case the
   * cost is negligible and consistency is more valuable than micro-perf.
   */
  function runTransition(
    projectId: string,
    computeNext: (current: WorkflowState) => WorkflowState | null,
    apiCall: (id: string, expectedStatus: WorkflowState) => Promise<ApiResult<Project>>,
  ): void {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return;

    const next = computeNext(project.status);
    if (!next) return;

    set((s) => ({
      mutationInFlight: { ...s.mutationInFlight, [projectId]: true },
      mutationError: null,
    }));

    apiCall(projectId, project.status)
      .then((result) => {
        if (!result.ok) {
          if (result.sessionExpired) {
            handleSessionExpired();
            return;
          }
          set((s) => {
            const { [projectId]: _, ...rest } = s.mutationInFlight;
            return {
              mutationError: result.error.message,
              mutationInFlight: rest,
            };
          });
          // NOT_FOUND on a mutation means the local cache is out of sync
          // with the server (the project was deleted or never existed).
          // Refetch the list so the stale card disappears and the user
          // sees the real state. Matches api.md §14.4.1's Client behavior
          // column for the Not Found category.
          if (result.category === 'not_found') {
            void get().fetchProjects();
          }
          return;
        }

        // Use the server response data — it has the authoritative status,
        // timestamps, and updatedBy. Client-computed values would drift
        // from the DB due to clock skew and miss server-side fields.
        const updated = result.data;

        // Re-enable controls first (flushSync forces React to commit the
        // enabled state to the DOM before the card moves to a new column).
        flushSync(() => {
          set((s) => {
            const { [projectId]: _, ...rest } = s.mutationInFlight;
            return { mutationInFlight: rest };
          });
        });
        // Then apply the server response — card moves to new column.
        set((s) => ({
          projects: s.projects.map((p) => (p.id === projectId ? updated : p)),
        }));
        // Sync the management store so both views stay consistent.
        useProjectManagementStore.getState().fetchProjects();
      })
      .catch(() => {
        set((s) => {
          const { [projectId]: _, ...rest } = s.mutationInFlight;
          return {
            mutationError: STRINGS.errors.mutationFailed,
            mutationInFlight: rest,
          };
        });
      });
  }

  return {
    projects: [],
    mutationError: null,
    mutationInFlight: {},

    fetchProjects: async () => {
      const seq = ++fetchSeq;
      const result = await projectApi.list();
      // Discard if a newer fetch was initiated while this one was in flight
      if (seq !== fetchSeq) return;
      if (!result.ok) return;
      set({ projects: result.data.data ?? result.data });
    },

    fetchProject: async (id: string): Promise<FetchProjectOutcome> => {
      const result = await projectApi.get(id);
      if (!result.ok) {
        if (result.sessionExpired) {
          handleSessionExpired();
          return { kind: 'error', message: result.error.message || STRINGS.errors.mutationFailed };
        }
        if (result.category === 'authorization') return { kind: 'not_permitted' };
        if (result.category === 'not_found') return { kind: 'not_found' };
        return { kind: 'error', message: result.error.message || STRINGS.errors.mutationFailed };
      }
      const project = result.data;
      set((s) => {
        const present = s.projects.some((p) => p.id === project.id);
        return {
          projects: present
            ? s.projects.map((p) => (p.id === project.id ? project : p))
            : [...s.projects, project],
        };
      });
      return { kind: 'ok', project };
    },

    updateAssignedWorkers: async (
      id: string,
      assignedWorkerIds: string[],
      optimisticAssigned: { userId: string; displayName: string }[],
    ): Promise<boolean> => {
      // Serialize per-project mutations so the second call's `before`
      // snapshot is the first's committed result (server data or a
      // revert), not the first's in-flight optimistic state. A chain of
      // rapidly-dispatched remove-Anna + remove-Bernd thus rolls back
      // to the right baseline on failure.
      const prior = ASSIGNED_WORKERS_QUEUE.get(id) ?? Promise.resolve();
      const task = prior.then(async () => {
        const before = get().projects.find((p) => p.id === id)?.assignedWorkers;
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id ? { ...p, assignedWorkers: optimisticAssigned } : p,
          ),
          mutationInFlight: { ...s.mutationInFlight, [id]: true },
          mutationError: null,
        }));

        let result;
        try {
          result = await projectApi.update(id, { assignedWorkerIds });
        } catch {
          set((s) => {
            const { [id]: _, ...rest } = s.mutationInFlight;
            return {
              projects: s.projects.map((p) =>
                p.id === id ? { ...p, assignedWorkers: before ?? [] } : p,
              ),
              mutationError: STRINGS.errors.mutationFailed,
              mutationInFlight: rest,
            };
          });
          return false;
        }

        if (!result.ok) {
          if (result.sessionExpired) {
            handleSessionExpired();
            return false;
          }
          set((s) => {
            const { [id]: _, ...rest } = s.mutationInFlight;
            return {
              projects: s.projects.map((p) =>
                p.id === id ? { ...p, assignedWorkers: before ?? [] } : p,
              ),
              mutationError: result.error.message || STRINGS.errors.mutationFailed,
              mutationInFlight: rest,
            };
          });
          return false;
        }

        set((s) => {
          const { [id]: _, ...rest } = s.mutationInFlight;
          return {
            projects: s.projects.map((p) => (p.id === id ? result.data : p)),
            mutationInFlight: rest,
          };
        });
        return true;
      });

      // Register the task so a rapid follow-up waits for it. The finally
      // hook drops the queue entry only when no newer chain has already
      // replaced it — otherwise we would orphan the tail of the chain.
      ASSIGNED_WORKERS_QUEUE.set(id, task);
      try {
        return await task;
      } finally {
        if (ASSIGNED_WORKERS_QUEUE.get(id) === task) {
          ASSIGNED_WORKERS_QUEUE.delete(id);
        }
      }
    },

    transitionForward: (projectId: string) => {
      runTransition(projectId, getNextState, projectApi.transitionForward);
    },

    transitionBackward: (projectId: string) => {
      runTransition(projectId, getPreviousState, projectApi.transitionBackward);
    },

    updateDates: (projectId: string, start?: string | null, end?: string | null) => {
      const project = get().projects.find((p) => p.id === projectId);
      if (!project) return;

      const originalProject = { ...project };

      // Optimistic update
      set((s) => ({
        projects: s.projects.map((p) => {
          if (p.id !== projectId) return p;
          return {
            ...p,
            plannedStart: start === null ? null : (start ?? p.plannedStart),
            plannedEnd: end === null ? null : (end ?? p.plannedEnd),
            updatedAt: new Date().toISOString(),
          };
        }),
        mutationInFlight: { ...s.mutationInFlight, [projectId]: true },
        mutationError: null,
      }));

      projectApi
        .updateDates(projectId, { plannedStart: start, plannedEnd: end })
        .then((result) => {
          if (!result.ok) {
            if (result.sessionExpired) {
              handleSessionExpired();
              return;
            }
            // Revert optimistic update
            set((s) => {
              const { [projectId]: _, ...rest } = s.mutationInFlight;
              return {
                projects: s.projects.map((p) => (p.id === projectId ? originalProject : p)),
                mutationError: result.error.message,
                mutationInFlight: rest,
              };
            });
            // NOT_FOUND on a date edit: the project disappeared from the
            // server. Refetch to drop the stale card from the local list
            // (see note in runTransition).
            if (result.category === 'not_found') {
              void get().fetchProjects();
            }
            return;
          }

          // Replace optimistic data with server response
          set((s) => {
            const { [projectId]: _, ...rest } = s.mutationInFlight;
            return {
              projects: s.projects.map((p) => (p.id === projectId ? result.data : p)),
              mutationInFlight: rest,
            };
          });
          // Sync the management store
          useProjectManagementStore.getState().fetchProjects();
        })
        .catch(() => {
          set((s) => {
            const { [projectId]: _, ...rest } = s.mutationInFlight;
            return {
              projects: s.projects.map((p) => (p.id === projectId ? originalProject : p)),
              mutationError: STRINGS.errors.mutationFailed,
              mutationInFlight: rest,
            };
          });
        });
    },

    clearMutationError: () => {
      set({ mutationError: null });
    },

    getProjectsByState: (state: WorkflowState) => {
      return get().projects.filter((p) => p.status === state);
    },

    getSummary: () => {
      return computeSummary(get().projects);
    },

    isMutationInFlight: (projectId: string) => {
      return !!get().mutationInFlight[projectId];
    },
  };
});
