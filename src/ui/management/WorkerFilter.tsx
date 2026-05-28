/**
 * Mitarbeiter (assignee) filter for the project management page.
 *
 * Trigger button + popover. The popover holds a `Nicht zugewiesen`
 * branch checkbox plus a checkbox per assignable worker; selecting any
 * combination ORs into the projects list query (assignedWorkerIds with
 * OR semantics, optionally unioned with the unassigned branch — see
 * `ListProjectsOpts` on the server).
 *
 * Source list: `useProjectManagementStore.workers`, populated lazily on
 * first open via `fetchWorkers`. The store also owns the selected state
 * (`assignedWorkerIds`, `includeUnassigned`) so the selection persists
 * across refetches triggered by sort / search / archive changes — the
 * filter is part of the management-view state, not local to this widget.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { STRINGS } from '@/config/strings';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { useProjectManagementStore } from '@/state/projectManagementStore';
import styles from './Management.module.css';

const SEARCH_VISIBLE_THRESHOLD = 10;

export function WorkerFilter() {
  const workers = useProjectManagementStore((s) => s.workers);
  const fetchWorkers = useProjectManagementStore((s) => s.fetchWorkers);
  const assignedWorkerIds = useProjectManagementStore((s) => s.assignedWorkerIds);
  const includeUnassigned = useProjectManagementStore((s) => s.includeUnassigned);
  const setAssignedWorkerIds = useProjectManagementStore((s) => s.setAssignedWorkerIds);
  const setIncludeUnassigned = useProjectManagementStore((s) => s.setIncludeUnassigned);

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();

  const selectedCount = assignedWorkerIds.length + (includeUnassigned ? 1 : 0);

  // Lazy-load the worker pool on first open. The pool is small and stable
  // for the session — one fetch suffices.
  useEffect(() => {
    if (open && workers.length === 0) {
      void fetchWorkers();
    }
  }, [open, workers.length, fetchWorkers]);

  // Escape closes the popover via the shared, stack-aware escape registry.
  useEscapeKey(() => setOpen(false), open);

  // Click-outside closes the popover. The listener attaches only while
  // open so we don't pay for it on the resting state.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  const toggleWorker = (userId: string) => {
    if (assignedWorkerIds.includes(userId)) {
      setAssignedWorkerIds(assignedWorkerIds.filter((id) => id !== userId));
    } else {
      setAssignedWorkerIds([...assignedWorkerIds, userId]);
    }
  };

  const clearAll = () => {
    setAssignedWorkerIds([]);
    setIncludeUnassigned(false);
  };

  const filteredWorkers = search.trim()
    ? workers.filter((w) => w.displayName.toLowerCase().includes(search.trim().toLowerCase()))
    : workers;

  const showSearch = workers.length >= SEARCH_VISIBLE_THRESHOLD;

  const buttonLabel =
    selectedCount > 0
      ? STRINGS.projects.filterWorkersCount(selectedCount)
      : STRINGS.projects.filterWorkers;

  return (
    <div className={styles.workerFilterWrapper} ref={wrapperRef}>
      <button
        type="button"
        className={styles.actionButton}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popoverId}
        data-testid="worker-filter-toggle"
        data-active={selectedCount > 0 ? 'true' : 'false'}
      >
        {buttonLabel}
      </button>
      {selectedCount > 0 && (
        // Sibling, not child, of the toggle <button>. HTML disallows interactive
        // descendants inside a <button> (nested-button anti-pattern: dual focus
        // targets, ambiguous SR output, browser-dependent event delivery).
        <button
          type="button"
          className={styles.workerFilterClear}
          onClick={clearAll}
          aria-label={STRINGS.ui.clearFilter}
          data-testid="worker-filter-clear"
        >
          ×
        </button>
      )}

      {open && (
        <div
          className={styles.workerFilterPopover}
          role="dialog"
          aria-label={STRINGS.projects.filterWorkers}
          id={popoverId}
          data-testid="worker-filter-popover"
        >
          {showSearch && (
            <input
              type="text"
              className={styles.workerFilterSearch}
              placeholder={STRINGS.projects.filterWorkersSearchPlaceholder}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="worker-filter-search"
              autoFocus
            />
          )}

          <label
            className={styles.workerFilterOption}
            data-testid="worker-filter-option-unassigned"
          >
            <input
              type="checkbox"
              checked={includeUnassigned}
              onChange={(e) => setIncludeUnassigned(e.target.checked)}
            />
            <span>{STRINGS.projects.filterUnassigned}</span>
          </label>

          <div className={styles.workerFilterDivider} aria-hidden="true" />

          <div className={styles.workerFilterList}>
            {workers.length === 0 ? (
              <div className={styles.workerFilterEmpty}>{STRINGS.projects.filterNoWorkers}</div>
            ) : filteredWorkers.length === 0 ? (
              <div className={styles.workerFilterEmpty}>{STRINGS.ui.noResults}</div>
            ) : (
              filteredWorkers.map((w) => (
                <label
                  key={w.userId}
                  className={styles.workerFilterOption}
                  data-testid={`worker-filter-option-${w.userId}`}
                >
                  <input
                    type="checkbox"
                    checked={assignedWorkerIds.includes(w.userId)}
                    onChange={() => toggleWorker(w.userId)}
                  />
                  <span>{w.displayName}</span>
                </label>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
