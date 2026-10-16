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
import { isVersionConflict, versionedWrite } from './versionedWrites';

/** Write lane for one project (see `versionedWrite`). */
const laneKey = (projectId: string) => `project:${projectId}`;

/** Outcome of a versioned project write; `'conflict'` = stale write, project refetched. */
export type ProjectWriteOutcome = 'ok' | 'conflict' | 'failed';

/** Fields the detail page edits through Update project (api.md §14.2.2). */
export interface ProjectFieldsUpdate {
  title?: string;
  estimatedValue?: number | null;
  notes?: string | null;
  siteAddress?: Project['siteAddress'];
}

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
   * Update project fields (§8.15) from an edit that started at
   * `startVersion` (behavior.md §9.5). On `VERSION_CONFLICT` the project
   * is refetched before the stale-write message is set, so the caller
   * can reset its field to the refetched value.
   */
  updateProject: (
    id: string,
    startVersion: number,
    fields: ProjectFieldsUpdate,
  ) => Promise<ProjectWriteOutcome>;
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
  updateDates: (
    projectId: string,
    startVersion: number,
    start?: string | null,
    end?: string | null,
  ) => void;
  clearMutationError: () => void;

  getProjectsByState: (state: WorkflowState) => Project[];
  getSummary: () => SummaryData;
  isMutationInFlight: (projectId: string) => boolean;
}

/** Monotonic counter to discard stale fetch responses. */
let fetchSeq = 0;

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

  /** Clear the in-flight flag and surface `message` in the mutation banner. */
  function settleFailure(projectId: string, message: string): void {
    set((s) => {
      const { [projectId]: _, ...rest } = s.mutationInFlight;
      return { mutationError: message, mutationInFlight: rest };
    });
  }

  /** Clear the in-flight flag and adopt the server's row. */
  function settleSuccess(project: Project): void {
    set((s) => {
      const { [project.id]: _, ...rest } = s.mutationInFlight;
      return {
        projects: s.projects.map((p) => (p.id === project.id ? project : p)),
        mutationInFlight: rest,
      };
    });
    // Sync the management store so both views stay consistent.
    useProjectManagementStore.getState().fetchProjects();
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

    updateProject: async (id, startVersion, fields) => {
      set((s) => ({
        mutationInFlight: { ...s.mutationInFlight, [id]: true },
        mutationError: null,
      }));
      let result: ApiResult<Project>;
      try {
        result = await versionedWrite(laneKey(id), startVersion, (expectedVersion) =>
          projectApi.update(id, expectedVersion, fields),
        );
      } catch {
        settleFailure(id, STRINGS.errors.mutationFailed);
        return 'failed';
      }
      if (!result.ok) {
        if (result.sessionExpired) {
          handleSessionExpired();
          return 'failed';
        }
        const conflict = isVersionConflict(result);
        if (conflict) await get().fetchProject(id);
        settleFailure(id, result.error.message);
        return conflict ? 'conflict' : 'failed';
      }
      settleSuccess(result.data);
      return 'ok';
    },

    updateAssignedWorkers: async (
      id: string,
      assignedWorkerIds: string[],
      optimisticAssigned: { userId: string; displayName: string }[],
    ): Promise<boolean> => {
      const startVersion = get().projects.find((p) => p.id === id)?.version;
      if (startVersion === undefined) return false;

      // The lane serializes per-project writes, so `before` is captured
      // when this write's turn comes: the previous write's committed
      // result (server data or a revert), not its in-flight optimistic
      // state. A chain of rapidly-dispatched remove-Anna + remove-Bernd
      // thus rolls back to the right baseline on failure.
      let sent = false;
      let before: Project['assignedWorkers'] | undefined;
      const revert = () =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id ? { ...p, assignedWorkers: before ?? [] } : p,
          ),
        }));

      let result: ApiResult<Project>;
      try {
        result = await versionedWrite(laneKey(id), startVersion, (expectedVersion) => {
          sent = true;
          before = get().projects.find((p) => p.id === id)?.assignedWorkers;
          set((s) => ({
            projects: s.projects.map((p) =>
              p.id === id ? { ...p, assignedWorkers: optimisticAssigned } : p,
            ),
            mutationInFlight: { ...s.mutationInFlight, [id]: true },
            mutationError: null,
          }));
          return projectApi.update(id, expectedVersion, { assignedWorkerIds });
        });
      } catch {
        if (sent) revert();
        settleFailure(id, STRINGS.errors.mutationFailed);
        return false;
      }

      if (!result.ok) {
        if (result.sessionExpired) {
          handleSessionExpired();
          return false;
        }
        if (sent) revert();
        if (isVersionConflict(result)) await get().fetchProject(id);
        settleFailure(id, result.error.message || STRINGS.errors.mutationFailed);
        return false;
      }

      settleSuccess(result.data);
      return true;
    },

    transitionForward: (projectId: string) => {
      runTransition(projectId, getNextState, projectApi.transitionForward);
    },

    transitionBackward: (projectId: string) => {
      runTransition(projectId, getPreviousState, projectApi.transitionBackward);
    },

    updateDates: (
      projectId: string,
      startVersion: number,
      start?: string | null,
      end?: string | null,
    ) => {
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

      versionedWrite(laneKey(projectId), startVersion, (expectedVersion) =>
        projectApi.updateDates(projectId, expectedVersion, {
          plannedStart: start,
          plannedEnd: end,
        }),
      )
        .then(async (result) => {
          if (!result.ok) {
            if (result.sessionExpired) {
              handleSessionExpired();
              return;
            }
            // Revert optimistic update; on a stale write, show the
            // refetched dates (behavior.md §9.5).
            set((s) => ({
              projects: s.projects.map((p) => (p.id === projectId ? originalProject : p)),
            }));
            if (isVersionConflict(result)) await get().fetchProject(projectId);
            settleFailure(projectId, result.error.message);
            // NOT_FOUND on a date edit: the project disappeared from the
            // server. Refetch to drop the stale card from the local list
            // (see note in runTransition).
            if (result.category === 'not_found') {
              void get().fetchProjects();
            }
            return;
          }

          // Replace optimistic data with server response
          settleSuccess(result.data);
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
