/**
 * Standalone /rechnungen list view (ui/invoices.md §8.16.1).
 *
 * Argumented C-SIZE exception (review/conventions-code.md §C-SIZE,
 * 200 LOC guideline): this file is ~210 LOC. It hosts one cohesive
 * list surface — filter bar, table, deep-link chip, debounced search,
 * URL ⇄ filter sync, and the single refetch effect. SSE invalidation
 * lives in `invoiceSseSubscription.ts`; the table row and filter bar
 * are already extracted to sibling files. Further splitting would
 * scatter the URL-sync + fetch responsibility without consolidating
 * state ownership.
 *
 * Cross-project, paginated table with year/status/search filters and the
 * Storno grouping rule shared with the per-project block (see
 * `@/domain/invoiceGrouping`). Permission gating mirrors the route guard
 * in `App.tsx` — defense in depth; the server's repository predicate
 * (ADR-0019) is authoritative.
 *
 * Row navigation: draft rows open `/projects/:projectId` (the only
 * surface where a draft is editable); issued / cancelled / Storno rows
 * open `/rechnungen/:id` — the per-invoice viewer (§8.16.3). The PDF
 * download affordance lives inline on each non-draft row.
 *
 * Mutate actions (create / edit / issue / cancel) are NOT exposed here
 * — those live on the per-project block. This surface is read-mostly
 * per the spec's "Future-work seam" note.
 */

import { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { STRINGS } from '@/config/strings';
import { usePermission } from '@/hooks/usePermission';
import { orderInvoicesWithStornoGrouping } from '@/domain/invoiceGrouping';
import { useInvoiceListStore } from '@/state/invoiceListStore';
import { useProjectStore } from '@/state/projectStore';
import { NotPermittedView } from '@/ui/common/NotPermittedView';
import { triggerBlobDownload } from '@/ui/utils/downloadFile';
import { CompanyProfileSection } from '@/ui/management/CompanyProfileSection';
import { InvoiceListFilterBar } from './InvoiceListFilterBar';
import { InvoiceListRow } from './InvoiceListRow';
import styles from './InvoiceListView.module.css';

const SEARCH_DEBOUNCE_MS = 250;

/** Years offered in the filter — the server-side distinct set merged
 *  with the current calendar year so the user can pre-filter for
 *  "this year" before any invoice has been issued in it. */
function buildYearOptions(serverYears: readonly number[]): readonly number[] {
  const set = new Set<number>(serverYears);
  set.add(new Date().getFullYear());
  return Array.from(set).sort((a, b) => b - a);
}

export function InvoiceListView() {
  const canRead = usePermission('invoice:read');

  const filters = useInvoiceListStore((s) => s.filters);
  const invoices = useInvoiceListStore((s) => s.invoices);
  const total = useInvoiceListStore((s) => s.total);
  const loading = useInvoiceListStore((s) => s.loading);
  const error = useInvoiceListStore((s) => s.error);
  const hasInitialized = useInvoiceListStore((s) => s.hasInitialized);
  const selectedIds = useInvoiceListStore((s) => s.selectedIds);
  const exporting = useInvoiceListStore((s) => s.exporting);
  const exportError = useInvoiceListStore((s) => s.exportError);
  const availableYears = useInvoiceListStore((s) => s.availableYears);
  const searchDraft = useInvoiceListStore((s) => s.searchDraft);
  const setFilter = useInvoiceListStore((s) => s.setFilter);
  const setSearchDraft = useInvoiceListStore((s) => s.setSearchDraft);
  const fetch = useInvoiceListStore((s) => s.fetch);
  const fetchMore = useInvoiceListStore((s) => s.fetchMore);
  const fetchYears = useInvoiceListStore((s) => s.fetchYears);
  const resetFilters = useInvoiceListStore((s) => s.resetFilters);
  const exportZip = useInvoiceListStore((s) => s.exportZip);

  // The visible search input reads/writes `searchDraft` in the store;
  // a debounce effect below promotes it to `filters.search` (the
  // dimension the server actually receives). `searchDraft` is in the
  // store rather than React-local state so `resetFilters()` can clear
  // both atomically — otherwise a local mirror would re-commit its
  // stale value back through the debounce after a reset.

  // URL → store, one-way. The `?projectId=` query is set by the per-
  // project block's cross-link; the chip's clear button strips the param
  // and re-runs this effect to null the filter. The store is never the
  // source of truth for `projectId` — only the URL is — so there is no
  // bidirectional risk. The fetch effect below picks up the resulting
  // filter change.
  //
  // Entering with `?projectId=X` from the per-project cross-link also
  // resets year/status/search to defaults — otherwise stale filters
  // from a previous /rechnungen visit would silently narrow the
  // per-project view (user lands on a partial picture without an
  // obvious cue why).
  const [searchParams, setSearchParams] = useSearchParams();
  const urlProjectId = searchParams.get('projectId');
  useEffect(() => {
    if (filters.projectId !== urlProjectId) {
      // Reset other filters when arriving with a fresh project id —
      // the searchInput mirror picks up the cleared `filters.search`
      // via the sync-during-render hook above.
      if (urlProjectId !== null) resetFilters();
      setFilter('projectId', urlProjectId);
    }
  }, [urlProjectId, filters.projectId, setFilter, resetFilters]);

  // Project chip resolves number/title from the project store so the user
  // sees *which* project the filter constrains, not just that one is set.
  // Deep-linking /rechnungen?projectId=… may land before the project is
  // cached, so we trigger a fetch when missing — `fetchProject` upserts
  // into the same store the lookup reads from.
  const filterProject = useProjectStore((s) =>
    filters.projectId ? (s.projects.find((p) => p.id === filters.projectId) ?? null) : null,
  );
  const fetchProject = useProjectStore((s) => s.fetchProject);
  useEffect(() => {
    if (!filters.projectId || filterProject) return;
    void fetchProject(filters.projectId);
  }, [filters.projectId, filterProject, fetchProject]);

  // Unified refetch — one effect keyed on every filter dimension the
  // server cares about plus the read-permission gate. Replaces the
  // previous split between an "initial fetch" effect, a prev-ref dance
  // for year/status, and a debounced search effect. The search debounce
  // (below) writes `filters.search` after a 250 ms idle, which then
  // re-triggers this effect; the chain stays clear. SSE invalidation
  // (App.tsx subscription) is independent of this effect.
  useEffect(() => {
    if (!canRead) return;
    void fetch();
  }, [canRead, filters.projectId, filters.year, filters.status, filters.search, fetch]);

  // Year dropdown source — fetched once on mount and refreshed by SSE
  // (see invoiceSseSubscription.ts). Independent of the active filter.
  useEffect(() => {
    if (!canRead) return;
    void fetchYears();
  }, [canRead, fetchYears]);

  const clearProjectFilter = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('projectId');
    setSearchParams(next, { replace: true });
  };

  const hasAnyFilter =
    filters.year !== null ||
    filters.status !== null ||
    filters.search.length > 0 ||
    searchDraft.length > 0 ||
    filters.projectId !== null;

  const resetAllFilters = () => {
    resetFilters();
    if (urlProjectId !== null) {
      const next = new URLSearchParams(searchParams);
      next.delete('projectId');
      setSearchParams(next, { replace: true });
    }
  };

  // Search is debounced so typing does not hammer the endpoint. The
  // debounce only writes `filters.search` to the store; the unified
  // fetch effect above observes the change and dispatches the GET.
  useEffect(() => {
    if (searchDraft === filters.search) return;
    const timer = setTimeout(() => {
      setFilter('search', searchDraft);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchDraft, filters.search, setFilter]);

  const years = useMemo(() => buildYearOptions(availableYears), [availableYears]);

  const ordered = useMemo(() => orderInvoicesWithStornoGrouping(invoices), [invoices]);

  // Count of issued/cancelled invoices visible in the current filter —
  // the "Alle herunterladen (N)" label reflects what the server will
  // actually ship (drafts excluded server-side). When there are more
  // matching rows than visible (paginated), the server still exports
  // every match — N is just the most accurate count we can show
  // without an extra round trip.
  const exportableCount = useMemo(
    () => invoices.filter((i) => i.status !== 'draft').length,
    [invoices],
  );
  const selectedCount = selectedIds.size;
  const hasSelection = selectedCount > 0;
  const exportLabel = hasSelection
    ? STRINGS.invoices.exportSelectedAction(selectedCount)
    : STRINGS.invoices.exportAllAction(exportableCount);
  const exportDisabled = exporting || (!hasSelection && exportableCount === 0);

  const handleExport = async () => {
    if (exportDisabled) return;
    const result = await exportZip();
    if (result.ok) triggerBlobDownload(result.blob, result.filename);
  };

  // Storno display lookup — the row needs the original's `number` to
  // render the `Storno zu RE-…` subline.
  const invoicesById = useMemo(() => {
    const map = new Map<string, (typeof invoices)[number]>();
    for (const inv of invoices) map.set(inv.id, inv);
    return map;
  }, [invoices]);

  if (!canRead) return <NotPermittedView />;

  const showEmpty = hasInitialized && !loading && ordered.length === 0;
  const hasMore = invoices.length < total;

  return (
    <div className={styles.container} data-testid="invoice-list-view">
      {/* Firmendaten — collapsed by default; the values are referenced
          here because the invoice issuer snapshot is frozen from this
          profile at issue time (ADR-0026). Native `<details>` keeps the
          surface a11y-correct without a custom toggle component. */}
      <details className={styles.companyProfileDetails} data-testid="company-profile-details">
        <summary className={styles.companyProfileSummary}>{STRINGS.companyProfile.heading}</summary>
        <CompanyProfileSection />
      </details>

      <InvoiceListFilterBar
        years={years}
        year={filters.year}
        status={filters.status}
        search={searchDraft}
        hasAnyFilter={hasAnyFilter}
        onYearChange={(y) => setFilter('year', y)}
        onStatusChange={(s) => setFilter('status', s)}
        onSearchChange={setSearchDraft}
        onResetAll={resetAllFilters}
      />

      <div className={styles.exportBar} data-testid="invoice-export-bar">
        <button
          type="button"
          className={styles.exportButton}
          onClick={() => void handleExport()}
          disabled={exportDisabled}
          data-testid="invoice-export-button"
        >
          {exporting ? STRINGS.invoices.exportInProgress : exportLabel}
        </button>
        {exportError && (
          <span className={styles.exportError} role="alert" data-testid="invoice-export-error">
            {exportError}
          </span>
        )}
      </div>

      {filters.projectId && (
        <div className={styles.projectChip} data-testid="invoice-list-project-chip">
          <span className={styles.projectChipLabel}>{STRINGS.invoices.filterProjectChip}</span>
          {filterProject ? (
            <span className={styles.projectChipValue} data-testid="invoice-list-project-chip-name">
              {filterProject.number} — {filterProject.title}
            </span>
          ) : null}
          <button
            type="button"
            className={styles.projectChipClear}
            onClick={clearProjectFilter}
            data-testid="invoice-list-project-chip-clear"
            aria-label={STRINGS.invoices.filterProjectClear}
          >
            {STRINGS.invoices.filterProjectClear}
          </button>
        </div>
      )}

      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}

      {showEmpty ? (
        <div className={styles.empty} data-testid="invoice-list-empty">
          {STRINGS.invoices.listEmpty}
        </div>
      ) : (
        <div className={styles.list} data-testid="invoice-list-cross-project">
          {ordered.map((invoice) => (
            <InvoiceListRow
              key={invoice.id}
              invoice={invoice}
              originalNumber={
                invoice.cancellationOf
                  ? (invoicesById.get(invoice.cancellationOf)?.number ?? null)
                  : null
              }
            />
          ))}
        </div>
      )}

      {hasMore && (
        <button
          type="button"
          className={styles.loadMore}
          onClick={() => void fetchMore()}
          disabled={loading}
          data-testid="invoice-list-load-more"
        >
          {STRINGS.invoices.loadMore}
        </button>
      )}
    </div>
  );
}
