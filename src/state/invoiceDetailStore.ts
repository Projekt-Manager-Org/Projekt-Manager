/**
 * Per-invoice detail state for the viewer at `/rechnungen/:id`
 * (ui/invoices.md §8.16.3).
 *
 * Distinct from `invoiceStore` (per-project cache) and
 * `invoiceListStore` (cross-project paginated list) because the viewer
 * lives at a parametrized route and may surface invoices the user has
 * not yet seen on either of the other two surfaces — deep-link or
 * direct nav. Keying the cache by id (rather than by project) keeps
 * the SSE-refresh path simple: a single id, a single fetch.
 *
 * Siblings (the Storno children of an `issued` original) are fetched
 * on demand via `invoicesApi.list({ projectId, includeCancelled: 'true' })`
 * and filtered client-side by `cancellationOf === :id`. The list
 * endpoint does not expose a `cancellationOf` filter,
 * and the typical sibling count is small (most issued invoices have
 * zero Storno children; the rest have one), so a per-project list
 * fetch is the right tradeoff vs. a dedicated server-side filter that
 * the only consumer here would use.
 */

import { create } from 'zustand';
import { invoicesApi } from '@/api/client';
import type { Invoice } from '@/domain/invoice';
import { handleSessionExpired } from './sessionExpired';

export type InvoiceDetailKind = 'loading' | 'ok' | 'not_found' | 'not_permitted' | 'error';

export interface InvoiceDetailState {
  /** Per-id cache of the fetched invoice. Empty while loading. */
  byId: Record<string, Invoice>;
  /** Per-id list of Storno siblings (issued status, `cancellationOf === id`). */
  siblingsById: Record<string, Invoice[]>;
  /** Per-id load status — `loading` between fetch start and resolution. */
  statusById: Record<string, InvoiceDetailKind>;
  /** Per-id error message — populated on `error` only. */
  errorById: Record<string, string | null>;

  fetch: (invoiceId: string) => Promise<void>;
  /** SSE-driven refresh — refetch all ids the user has already loaded. */
  refreshAll: () => void;
}

export const useInvoiceDetailStore = create<InvoiceDetailState>((set, get) => ({
  byId: {},
  siblingsById: {},
  statusById: {},
  errorById: {},

  fetch: async (invoiceId) => {
    set((s) => ({
      statusById: { ...s.statusById, [invoiceId]: 'loading' },
      errorById: { ...s.errorById, [invoiceId]: null },
    }));
    const result = await invoicesApi.getById(invoiceId);
    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return;
      }
      const kind: InvoiceDetailKind =
        result.category === 'not_found'
          ? 'not_found'
          : result.category === 'authorization'
            ? 'not_permitted'
            : 'error';
      set((s) => ({
        statusById: { ...s.statusById, [invoiceId]: kind },
        errorById: { ...s.errorById, [invoiceId]: result.error.message },
      }));
      return;
    }
    const invoice = result.data;

    // Sibling fetch — only relevant for an issued original (a Storno
    // sibling row, by definition, has `cancellationOf` non-null and
    // never carries its own siblings). The list call's
    // `includeCancelled=true` keeps the original visible in the response
    // alongside any Storno rows; without it, server-side filtering
    // would drop cancelled originals. Filter client-side to the
    // `cancellationOf === id` set — small N (typically 0 or 1).
    let siblings: Invoice[] = [];
    if (invoice.cancellationOf === null) {
      const list = await invoicesApi.list({
        projectId: invoice.projectId,
        includeCancelled: 'true',
        limit: 100,
      });
      if (list.ok) {
        siblings = list.data.data.filter((row) => row.cancellationOf === invoiceId);
      }
      // Don't surface a sibling-fetch failure as a viewer error — the
      // main invoice loaded fine; the sibling list is an enhancement.
      // The viewer renders without the indented-chevron block if the
      // fetch failed.
    }

    set((s) => ({
      byId: { ...s.byId, [invoiceId]: invoice },
      siblingsById: { ...s.siblingsById, [invoiceId]: siblings },
      statusById: { ...s.statusById, [invoiceId]: 'ok' },
    }));
  },

  refreshAll: () => {
    const ids = Object.keys(get().statusById);
    for (const id of ids) {
      void get().fetch(id);
    }
  },
}));
