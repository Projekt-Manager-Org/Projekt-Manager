import { useState, useCallback } from 'react';
import { STATE_CONFIGS } from '@/config/stateConfig';
import type { WorkflowState } from '@/config/stateConfig';
import { useProjectStore } from '@/state/projectStore';
import { useUIStore } from '@/state/uiStore';
import { STRINGS } from '@/config/strings';
import { useCollapseTier } from './useCollapseTier';
import { KanbanColumn } from './KanbanColumn';
import styles from './KanbanBoard.module.css';

export function KanbanBoard() {
  const projects = useProjectStore((s) => s.projects);
  const filterNoDates = useUIStore((s) => s.filterNoDates);
  const clearFilters = useUIStore((s) => s.clearFilters);
  // Select the function (stable ref); call below to compute the
  // summary fresh each render. Selecting `getSummary()` directly would
  // return a new object every render and re-trigger the selector.
  const getSummary = useProjectStore((s) => s.getSummary);
  const summary = getSummary();
  const activeTier = useCollapseTier();
  // Per-column override of the auto-collapse tier. `true` = forced collapsed,
  // `false` = forced expanded, absent = follow the tier.
  const [userOverride, setUserOverride] = useState<Map<WorkflowState, boolean>>(new Map());

  const toggleCollapsed = useCallback((key: WorkflowState, currentlyCollapsed: boolean) => {
    setUserOverride((prev) => {
      const next = new Map(prev);
      next.set(key, !currentlyCollapsed);
      return next;
    });
  }, []);

  const filteredProjects = filterNoDates
    ? projects.filter((p) => !p.plannedStart && !p.plannedEnd)
    : projects;

  // Aged-buffer counts keyed by state so the matching column header can
  // surface the warning inline (AC-463).
  const agedByState = new Map(summary.agedBufferCounts.map((b) => [b.state, b]));

  return (
    <>
      {filterNoDates && (
        <div className={styles.filterBanner} data-testid="kanban-filter-banner">
          <span>{STRINGS.ui.projectsNoDates(filteredProjects.length)}</span>
          <button
            type="button"
            onClick={clearFilters}
            data-testid="kanban-filter-clear"
            aria-label={STRINGS.ui.clearFilter}
          >
            ×
          </button>
        </div>
      )}
      <div className={styles.board} data-testid="kanban-board">
        {STATE_CONFIGS.map((config) => {
          const columnProjects = filteredProjects
            .filter((p) => p.status === config.key)
            .sort(
              (a, b) =>
                new Date(a.statusChangedAt).getTime() - new Date(b.statusChangedAt).getTime(),
            );

          const autoCollapsed = activeTier > 0 && config.collapseTier >= activeTier;
          const override = userOverride.get(config.key);
          const collapsed = override ?? autoCollapsed;

          return (
            <KanbanColumn
              key={config.key}
              config={config}
              projects={columnProjects}
              collapsed={collapsed}
              agedBuffer={agedByState.get(config.key) ?? null}
              onToggleExpand={() => toggleCollapsed(config.key, collapsed)}
            />
          );
        })}
      </div>
    </>
  );
}
