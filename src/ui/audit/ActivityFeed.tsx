/**
 * Shared activity-feed container — used by both the project-detail
 * panel (stacked list per ui/workflow-views.md §8.4.1) and the global
 * Aktivität view (table per ui/management.md §8.13.1).
 *
 * Responsibilities:
 *  - Instantiate a per-mount audit store (see `createAuditStore()`).
 *  - Trigger a fetch with the passed-in filter on mount and on filterKey change.
 *  - Render the empty state when the result set is empty — default
 *    "Keine Aktivität" (AC-185) or the caller-supplied override used by
 *    the global Aktivität view's recipient-scoped mode (AC-200).
 *  - Render rows in the requested layout.
 *  - Offer an "Ältere anzeigen" action when more rows remain.
 *
 * **Each mount owns its own store.** `createAuditStore()` is called once
 * via `useMemo` at mount time, so the global Aktivität view and an
 * overlay-mounted project-detail feed never collide through a shared
 * Zustand singleton. Each surface's `fetchList` / `appendNextPage`
 * updates only its own `entries` / `total`. See
 * `src/state/auditStore.ts` for the factory rationale.
 */

import { useEffect, useMemo, useRef } from 'react';
import { createAuditStore } from '@/state/auditStore';
import type { AuditListParams } from '@/domain/audit';
import { STRINGS } from '@/config/strings';
import { AUDIT_CHANGED } from '@/config/sseEvents';
import { onSseEvent } from '@/sse/client';
import { ActivityFeedRow } from './ActivityFeedRow';
import { ActivityFeedRowTable } from './ActivityFeedRowTable';
import styles from './ActivityFeed.module.css';
import tableStyles from './AuditTable.module.css';

interface Props {
  /**
   * Filter applied to the first fetch. For the project-detail feed this
   * is `{ ancestorType: 'project', ancestorId: '…' }` (architecture.md
   * §11.12); for the global view it is the set of active filters.
   */
  filters: AuditListParams;
  /**
   * Stable key identifying the filter context. A change refetches. The
   * component derives the key from the filters, so callers don't need
   * to specify one — but they can pass an explicit key to force a
   * refetch (e.g. on project id change).
   */
  filterKey: string;
  /** Test-id for the outer container — different between contexts. */
  testId: string;
  /**
   * Inline-style container (applies to `list` layout only). Used by the
   * project-detail panel which renders the feed inside a larger sidebar.
   */
  inline?: boolean;
  /**
   * Row layout. `list` is the stacked form used by the project-detail
   * panel (ui/workflow-views.md §8.4.1 describes a one-line-per-entry
   * list). `table` is the column form used by the global Aktivität view
   * (ui/management.md §8.13.1 names columns: timestamp, actor, entity,
   * action, payload).
   */
  layout?: 'list' | 'table';
  /**
   * Override for the empty-state cell. Used by the global Aktivität view
   * under recipient-scoped mode (AC-200) to distinguish "rules exist but
   * none admit the caller" from "genuinely empty feed". When omitted the
   * feed falls back to the default `"Keine Aktivität"` copy pinned by
   * AC-185 — the per-project feed and the `Alles anzeigen` branch of the
   * global view both rely on the default.
   */
  emptyState?: { testId: string; message: string };
}

/** Column count of the table layout — drives `colSpan` on empty/loader rows. */
const TABLE_COLUMN_COUNT = 5;

export function ActivityFeed({
  filters,
  filterKey,
  testId,
  inline,
  layout = 'list',
  emptyState,
}: Props) {
  const emptyTestId = emptyState?.testId ?? 'audit-empty-state';
  const emptyMessage = emptyState?.message ?? STRINGS.audit.emptyState;
  // One store instance per mount. The empty dependency array is
  // intentional — we never want a remount-equivalent swap of the store
  // on a prop change. Filter changes flow through `fetchList` below.
  const useStore = useMemo(() => createAuditStore(), []);

  const entries = useStore((s) => s.entries);
  const total = useStore((s) => s.total);
  const loading = useStore((s) => s.loading);
  const loadingMore = useStore((s) => s.loadingMore);
  const error = useStore((s) => s.error);
  const fetchList = useStore((s) => s.fetchList);
  const appendNextPage = useStore((s) => s.appendNextPage);

  useEffect(() => {
    // Refetch whenever the filter context changes. Each instance has
    // its own monotonic counter, so a rapid sequence on this surface
    // (open A, open B) commits B's data; the other surface is
    // unaffected.
    void fetchList(filters);
    // filters is intentionally NOT in the deps array — callers pass a
    // stable `filterKey` that captures the relevant identity; otherwise
    // a new object literal on each render would refetch every paint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, fetchList]);

  // Keep the latest filters in a ref so the SSE handler always reads
  // them without retriggering the subscription on every filter change.
  // The filterKey-driven effect above remains the authoritative path
  // for filter changes; this ref only feeds the realtime refresh.
  const filtersRef = useRef(filters);
  useEffect(() => {
    filtersRef.current = filters;
  });

  useEffect(() => {
    // Subscribe to `audit_changed` (api.md §14.2.13). The audit
    // publisher dispatches per-row post-commit (ADR-0021), so a tx
    // with N rows produces N frames — the store's `fetchSeq` guard
    // collapses concurrent refetches into one rendered result, which
    // is the correct trade-off for an unfiltered invalidation hint.
    const unsubscribe = onSseEvent(AUDIT_CHANGED, () => {
      void fetchList(filtersRef.current);
    });
    return unsubscribe;
  }, [fetchList]);

  const hasMore = entries.length < total;
  const showLoader = loading && entries.length === 0;
  const showEmpty = !loading && entries.length === 0 && !error;

  if (layout === 'table') {
    return (
      <div className={tableStyles.tableWrapper} data-testid={testId}>
        {error && <div className={tableStyles.errorCell}>{error}</div>}
        <table className={tableStyles.table}>
          <thead>
            <tr>
              <th>{STRINGS.audit.colTimestamp}</th>
              <th>{STRINGS.audit.colActor}</th>
              <th>{STRINGS.audit.colEntity}</th>
              <th>{STRINGS.audit.colAction}</th>
              <th>{STRINGS.audit.colPayload}</th>
            </tr>
          </thead>
          <tbody>
            {showLoader && (
              <tr>
                <td colSpan={TABLE_COLUMN_COUNT} className={tableStyles.loaderCell}>
                  {STRINGS.ui.loading}
                </td>
              </tr>
            )}
            {showEmpty && (
              <tr>
                <td
                  colSpan={TABLE_COLUMN_COUNT}
                  className={tableStyles.emptyCell}
                  data-testid={emptyTestId}
                >
                  {emptyMessage}
                </td>
              </tr>
            )}
            {entries.map((entry) => (
              <ActivityFeedRowTable key={entry.id} entry={entry} />
            ))}
          </tbody>
        </table>
        {hasMore && (
          <div className={tableStyles.footerActions}>
            <button
              type="button"
              className={styles.loadMoreButton}
              onClick={() => void appendNextPage()}
              disabled={loadingMore}
            >
              {STRINGS.audit.loadOlder}
            </button>
          </div>
        )}
      </div>
    );
  }

  // Default stacked-list layout (project-detail surface).
  const containerClass = inline ? styles.inlineContainer : styles.container;
  return (
    <div className={containerClass} data-testid={testId}>
      {error && <div className={styles.error}>{error}</div>}
      {showLoader && <div className={styles.loader}>{STRINGS.ui.loading}</div>}
      {showEmpty && (
        <div className={styles.emptyState} data-testid={emptyTestId}>
          {emptyMessage}
        </div>
      )}
      {entries.map((entry) => (
        <ActivityFeedRow key={entry.id} entry={entry} />
      ))}
      {hasMore && (
        <div className={styles.footerActions}>
          <button
            type="button"
            className={styles.loadMoreButton}
            onClick={() => void appendNextPage()}
            disabled={loadingMore}
          >
            {STRINGS.audit.loadOlder}
          </button>
        </div>
      )}
    </div>
  );
}
