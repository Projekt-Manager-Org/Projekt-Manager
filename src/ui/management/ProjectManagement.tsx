/**
 * Project management view — list, search, create, edit, delete projects.
 *
 * Test IDs follow the established naming convention (kebab-case).
 * See e2e/management-flows.spec.ts steps 19, 21.
 * See e2e/visual-regression-management.spec.ts for delete flow.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { STRINGS } from '@/config/strings';
import { STATE_CONFIGS, STATE_FALLBACK_COLOR } from '@/config/stateConfig';
import type { Project } from '@/domain/types';
import { usePermission } from '@/hooks/usePermission';
import { useProjectManagementStore, type ProjectSortKey } from '@/state/projectManagementStore';
import { useConfirmStore } from '@/state/confirmStore';
import { SortableHeader, type SortDirection } from '@/ui/common/SortableHeader';
import { ProjectCreateForm } from './ProjectCreateForm';
import { WorkerFilter } from './WorkerFilter';
import styles from './Management.module.css';

export function ProjectManagement() {
  const canCreate = usePermission('project:create');
  const canDelete = usePermission('project:delete');
  const canPurge = usePermission('project:purge');
  const projects = useProjectManagementStore((s) => s.projects);
  const loading = useProjectManagementStore((s) => s.loading);
  const error = useProjectManagementStore((s) => s.error);
  const showArchived = useProjectManagementStore((s) => s.showArchived);
  const assignedWorkerIds = useProjectManagementStore((s) => s.assignedWorkerIds);
  const includeUnassigned = useProjectManagementStore((s) => s.includeUnassigned);
  const search = useProjectManagementStore((s) => s.search);
  const sortBy = useProjectManagementStore((s) => s.sortBy);
  const sortDir = useProjectManagementStore((s) => s.sortDir);
  const fetchProjects = useProjectManagementStore((s) => s.fetchProjects);
  const fetchCustomers = useProjectManagementStore((s) => s.fetchCustomers);
  const setShowArchived = useProjectManagementStore((s) => s.setShowArchived);
  const setSearch = useProjectManagementStore((s) => s.setSearch);
  const setSort = useProjectManagementStore((s) => s.setSort);
  const deleteProject = useProjectManagementStore((s) => s.deleteProject);
  const purgeProject = useProjectManagementStore((s) => s.purgeProject);
  const clearError = useProjectManagementStore((s) => s.clearError);
  const requestConfirm = useConfirmStore((s) => s.request);
  const navigate = useNavigate();

  const [formOpen, setFormOpen] = useState(false);

  useEffect(() => {
    fetchProjects();
    fetchCustomers();
  }, [fetchProjects, fetchCustomers]);

  // Debounced search — skip initial render (fetchProjects above handles it).
  const prevSearch = useRef(search);
  useEffect(() => {
    if (search === prevSearch.current) return;
    prevSearch.current = search;
    const timer = setTimeout(() => {
      fetchProjects();
    }, 300);
    return () => clearTimeout(timer);
  }, [search, fetchProjects]);

  // Sort change — no debounce, click is discrete.
  const prevSort = useRef({ sortBy, sortDir });
  useEffect(() => {
    if (prevSort.current.sortBy === sortBy && prevSort.current.sortDir === sortDir) return;
    prevSort.current = { sortBy, sortDir };
    fetchProjects();
  }, [sortBy, sortDir, fetchProjects]);

  // Refetch when showArchived toggles. The store reads `showArchived` from
  // its own state at request time, so we only need to trigger a refetch
  // here — no need to forward the flag as an argument.
  const prevShowArchived = useRef(showArchived);
  useEffect(() => {
    if (showArchived === prevShowArchived.current) return;
    prevShowArchived.current = showArchived;
    fetchProjects();
  }, [showArchived, fetchProjects]);

  // Refetch when the Mitarbeiter (assignee) filter changes. The selection
  // is a SET — reordering the same ids must not refetch. Compare by
  // Set membership so [a,b] and [b,a] are equivalent.
  const prevAssignedWorkerIds = useRef(assignedWorkerIds);
  const prevIncludeUnassigned = useRef(includeUnassigned);
  useEffect(() => {
    const prevSet = new Set(prevAssignedWorkerIds.current);
    const idsChanged =
      prevAssignedWorkerIds.current.length !== assignedWorkerIds.length ||
      assignedWorkerIds.some((id) => !prevSet.has(id));
    const flagChanged = prevIncludeUnassigned.current !== includeUnassigned;
    if (!idsChanged && !flagChanged) return;
    prevAssignedWorkerIds.current = assignedWorkerIds;
    prevIncludeUnassigned.current = includeUnassigned;
    fetchProjects();
  }, [assignedWorkerIds, includeUnassigned, fetchProjects]);

  const handleSort = (column: ProjectSortKey, direction: SortDirection) => {
    setSort(column, direction);
  };

  const handleArchive = async (e: React.MouseEvent, project: Project) => {
    e.stopPropagation();
    const confirmed = await requestConfirm(
      STRINGS.projects.archiveConfirm(`${project.number} — ${project.title}`),
    );
    if (!confirmed) return;
    await deleteProject(project.id);
  };

  const handlePurge = async (e: React.MouseEvent, project: Project) => {
    e.stopPropagation();
    const confirmed = await requestConfirm(
      STRINGS.projects.purgeConfirm(`${project.number} — ${project.title}`),
    );
    if (!confirmed) return;
    await purgeProject(project.id);
  };

  const handleRowClick = (project: Project) => {
    clearError();
    navigate(`/projects/${project.id}`);
  };

  const openCreateForm = () => {
    clearError();
    setFormOpen(true);
  };

  const stateLabel = (status: string) => {
    const cfg = STATE_CONFIGS.find((c) => c.key === status);
    return cfg?.label ?? status;
  };

  const stateColor = (status: string) => {
    const cfg = STATE_CONFIGS.find((c) => c.key === status);
    return cfg?.color ?? STATE_FALLBACK_COLOR;
  };

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        {canCreate && (
          <button
            className={styles.createButton}
            onClick={openCreateForm}
            data-testid="project-create-button"
          >
            {STRINGS.ui.create}
          </button>
        )}
        <label className={styles.checkboxLabel}>
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            data-testid="project-show-archived-toggle"
          />
          {STRINGS.projects.showArchived}
        </label>
        <WorkerFilter />
        <input
          className={styles.searchInput}
          placeholder={STRINGS.ui.search}
          aria-label={STRINGS.ui.search}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="project-search"
        />
      </div>

      {error && !formOpen && <div className={styles.error}>{error}</div>}

      <table className={styles.table} data-testid="project-table">
        <thead>
          <tr>
            <SortableHeader<ProjectSortKey>
              column="number"
              activeColumn={sortBy}
              direction={sortDir}
              onSort={handleSort}
              testId="project-sort-number"
            >
              {STRINGS.ui.number}
            </SortableHeader>
            <SortableHeader<ProjectSortKey>
              column="title"
              activeColumn={sortBy}
              direction={sortDir}
              onSort={handleSort}
              testId="project-sort-title"
            >
              {STRINGS.ui.title}
            </SortableHeader>
            <SortableHeader<ProjectSortKey>
              column="customer"
              activeColumn={sortBy}
              direction={sortDir}
              onSort={handleSort}
              testId="project-sort-customer"
            >
              {STRINGS.ui.customer}
            </SortableHeader>
            <th>{STRINGS.ui.workers}</th>
            <SortableHeader<ProjectSortKey>
              column="status"
              activeColumn={sortBy}
              direction={sortDir}
              onSort={handleSort}
              testId="project-sort-status"
            >
              {STRINGS.ui.status}
            </SortableHeader>
            <SortableHeader<ProjectSortKey>
              column="plannedStart"
              activeColumn={sortBy}
              direction={sortDir}
              onSort={handleSort}
              testId="project-sort-dates"
            >
              {STRINGS.ui.dates}
            </SortableHeader>
            <SortableHeader<ProjectSortKey>
              column="estimatedValue"
              activeColumn={sortBy}
              direction={sortDir}
              onSort={handleSort}
              testId="project-sort-value"
            >
              {STRINGS.ui.value}
            </SortableHeader>
            {(canDelete || canPurge) && <th>{STRINGS.ui.actions}</th>}
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => {
            const rowClassName = p.deleted
              ? `${styles.clickableRow} ${styles.rowInactive}`
              : styles.clickableRow;
            // AC-159: the purge action is gated on archive state + toggle
            // + permission. The archive action is gated on permission +
            // non-archived row. A caller with only `project:delete` still
            // gets the actions cell for non-archived rows; a caller with
            // only `project:purge` gets the cell for archived rows when
            // the show-archived toggle is on.
            const showArchiveBtn = canDelete && !p.deleted;
            const showPurgeBtn = canPurge && p.deleted && showArchived;
            const renderActionsCell = showArchiveBtn || showPurgeBtn;
            return (
              <tr key={p.id} className={rowClassName} onClick={() => handleRowClick(p)}>
                <td data-label={STRINGS.ui.number}>{p.number}</td>
                <td data-label={STRINGS.ui.title}>{p.title}</td>
                <td data-label={STRINGS.ui.customer}>{p.customer?.name ?? '—'}</td>
                <td data-label={STRINGS.ui.workers}>
                  {p.assignedWorkers && p.assignedWorkers.length > 0
                    ? p.assignedWorkers.map((w) => w.displayName).join(', ')
                    : '—'}
                </td>
                <td data-label={STRINGS.ui.status}>
                  <span className={styles.badge} style={{ backgroundColor: stateColor(p.status) }}>
                    {stateLabel(p.status)}
                  </span>
                  {p.deleted && (
                    <>
                      {' '}
                      <span
                        className={`${styles.badge} ${styles.badgeArchived}`}
                        data-testid="project-archived-badge"
                      >
                        {STRINGS.projects.archivedBadge}
                      </span>
                    </>
                  )}
                </td>
                <td data-label={STRINGS.ui.dates}>
                  {p.plannedStart
                    ? `${new Date(p.plannedStart).toLocaleDateString('de-DE')}${p.plannedEnd ? ' – ' + new Date(p.plannedEnd).toLocaleDateString('de-DE') : ''}`
                    : STRINGS.projects.noDate}
                </td>
                <td data-label={STRINGS.ui.value}>
                  {p.estimatedValue != null
                    ? p.estimatedValue.toLocaleString('de-DE', {
                        style: 'currency',
                        currency: 'EUR',
                      })
                    : '—'}
                </td>
                {(canDelete || canPurge) && (
                  <td>
                    {renderActionsCell && showArchiveBtn && (
                      <button
                        className={styles.actionButton}
                        onClick={(e) => handleArchive(e, p)}
                        data-testid="project-archive-button"
                      >
                        {STRINGS.projects.archive}
                      </button>
                    )}
                    {renderActionsCell && showPurgeBtn && (
                      <button
                        className={styles.dangerButton}
                        onClick={(e) => handlePurge(e, p)}
                        data-testid="project-purge-button"
                      >
                        {STRINGS.projects.purge}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>

      {!loading && projects.length === 0 && (
        <div className={styles.noResults}>{STRINGS.ui.noResults}</div>
      )}

      {formOpen && <ProjectCreateForm onClose={() => setFormOpen(false)} />}
    </div>
  );
}
