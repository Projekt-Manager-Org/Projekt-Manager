/**
 * `invoiceStore` — stale-write recovery (behavior.md §9.5).
 *
 * A `VERSION_CONFLICT` refetches the project's invoices and hands back the
 * fresh row. When that refetch fails nothing was reloaded, so the outcome
 * is a generic error — never a conflict whose message claims the current
 * version was loaded, carrying the stale cached row.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiFailure } from '@/api/client';
import type { Invoice } from '@/domain/invoice';
import { STRINGS } from '@/config/strings';

const updateDraftMock = vi.fn();
const listByProjectMock = vi.fn();

vi.mock('@/api/client', () => ({
  invoicesApi: {
    updateDraft: (...args: unknown[]) => updateDraftMock(...args),
    listByProject: (...args: unknown[]) => listByProjectMock(...args),
  },
}));

vi.mock('@/state/sessionExpired', () => ({
  handleSessionExpired: vi.fn(),
}));

const { useInvoiceStore } = await import('@/state/invoiceStore');

const PROJECT_ID = 'p1';
// Only `id` and `version` matter to the store's conflict path.
const draft = (version: number) => ({ id: 'i1', version }) as Invoice;

function failure(code: string, message: string): ApiFailure {
  return {
    ok: false,
    error: { code, message },
    category: 'server_error',
    sessionExpired: false,
  };
}

beforeEach(() => {
  updateDraftMock.mockReset();
  listByProjectMock.mockReset();
  useInvoiceStore.setState({
    byProject: { [PROJECT_ID]: [draft(1)] },
    loadingByProject: {},
    errorByProject: {},
  });
  updateDraftMock.mockResolvedValue(failure('VERSION_CONFLICT', 'stale'));
});

describe('invoiceStore — VERSION_CONFLICT recovery', () => {
  it('returns the refetched row when the refetch succeeds', async () => {
    listByProjectMock.mockResolvedValue({ ok: true, data: { data: [draft(2)] } });

    const outcome = await useInvoiceStore.getState().updateDraft('i1', PROJECT_ID, 1, {});

    expect(outcome).toEqual({ status: 'conflict', errorMessage: 'stale', invoice: draft(2) });
  });

  it('returns a generic error, not the stale cached row, when the refetch fails', async () => {
    listByProjectMock.mockResolvedValue(failure('INTERNAL_ERROR', 'down'));

    const outcome = await useInvoiceStore.getState().updateDraft('i1', PROJECT_ID, 1, {});

    expect(outcome).toEqual({ status: 'error', errorMessage: STRINGS.errors.mutationFailed });
  });
});
