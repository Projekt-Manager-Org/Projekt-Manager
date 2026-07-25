/**
 * InvoiceDetailView — `/rechnungen/:id` per-invoice viewer (ui/invoices.md §8.16.3).
 *
 * Pins:
 *   - Permission gating mirrors `invoice:read` (worker rejected).
 *   - Issued + cancelled rows render the snapshot fields (number, dates,
 *     issuer/recipient/lines/totals) and the PDF download action.
 *   - The PDF download label flips to "ZUGFeRD herunterladen" when
 *     `profile === 'zugferd-en16931'`.
 *   - Storno row renders the `Original anzeigen` link to its
 *     `cancellationOf`.
 *   - Issued-original viewer renders the Stornieren button for
 *     `invoice:write` holders; cancelled / storno rows do not.
 *   - A draft id redirects to `/projects/:projectId`.
 *
 * Network surface is mocked at the API-client boundary; the
 * detail-store + per-project-cancel store run against the mocked
 * `invoicesApi`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import type { ApiResult } from '@/api/client';
import type { Invoice } from '@/domain/invoice';

type InvoiceResult = ApiResult<Invoice>;

const getByIdMock = vi.fn<(id: string) => Promise<InvoiceResult>>();
const listMock = vi.fn();

vi.mock('@/api/client', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    invoicesApi: {
      list: (...args: unknown[]) => listMock(...args),
      listByProject: vi.fn().mockResolvedValue({ ok: true, data: { data: [], total: 0 } }),
      getById: (...args: unknown[]) => getByIdMock(...(args as [string])),
      createDraft: vi.fn(),
      updateDraft: vi.fn(),
      deleteDraft: vi.fn(),
      issue: vi.fn(),
      cancel: vi.fn(),
      pdfUrl: (id: string) => `/api/invoices/${id}/pdf`,
    },
  };
});

const { InvoiceDetailView } = await import('@/ui/invoices/InvoiceDetailView');
const { useAuthStore } = await import('@/state/authStore');
const { useInvoiceDetailStore } = await import('@/state/invoiceDetailStore');

function setAuthUser(roles: string[]): void {
  useAuthStore.setState({
    authUser: {
      id: 'u-1',
      username: 'tester',
      displayName: 'Test',
      roles,
      email: null,
      themePreference: 'system',
      pushMuted: false,
    },
    authError: null,
    sessionChecked: true,
  });
}

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    number: 'RE-2026-0001',
    status: 'issued',
    projectId: 'proj-1',
    cancellationOf: null,
    issuer: {
      companyName: 'Test GmbH',
      address: { street: 'Hauptstr. 1', zip: '10115', city: 'Berlin' },
      taxId: '12/345/67890',
      ustId: 'DE123456789',
      iban: null,
      footerText: null,
    },
    recipient: {
      name: 'Kunde GmbH',
      address: { street: 'Gartenweg 2', zip: '10117', city: 'Berlin' },
      ustId: null,
    },
    lines: [
      {
        description: 'Anstrich Fassade',
        quantity: 1,
        unit: 'pauschal',
        unitPrice: 1500,
        lineTotal: 1500,
        taxRate: 19,
      },
    ],
    taxMode: 'standard',
    profile: 'zugferd-en16931',
    totals: {
      perRate: [{ taxRate: 19, netSubtotal: 1500, taxAmount: 285 }],
      netGrandTotal: 1500,
      taxGrandTotal: 285,
      grossGrandTotal: 1785,
    },
    issueDate: '2026-04-10',
    performanceDate: '2026-04-10',
    cancellationReason: null,
    renderedPdfBinaryDescriptorId: 'pdf-1',
    createdAt: '2026-04-10T00:00:00Z',
    updatedAt: '2026-04-10T00:00:00Z',
    createdBy: null,
    updatedBy: null,
    ...overrides,
  };
}

beforeEach(() => {
  getByIdMock.mockReset();
  listMock.mockReset();
  listMock.mockResolvedValue({ ok: true, data: { data: [], total: 0 } });
  useAuthStore.setState({ authUser: null, authError: null, sessionChecked: true });
  useInvoiceDetailStore.setState({ byId: {}, siblingsById: {}, statusById: {}, errorById: {} });
});

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/rechnungen/:id" element={<InvoiceDetailView />} />
        <Route path="/projects/:id" element={<div data-testid="stub-project-page" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('InvoiceDetailView — permission gate (§8.16.3, AC-149)', () => {
  it('renders NotPermittedView for a caller without invoice:read', async () => {
    setAuthUser(['worker']);
    getByIdMock.mockResolvedValue({ ok: true, data: makeInvoice() });
    renderAt('/rechnungen/inv-1');

    await waitFor(() => {
      expect(screen.getByTestId('not-permitted-view')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('invoice-detail-view')).toBeNull();
  });
});

describe('InvoiceDetailView — issued row', () => {
  it('renders the snapshot fields and the PDF download action', async () => {
    setAuthUser(['owner']);
    getByIdMock.mockResolvedValue({ ok: true, data: makeInvoice() });
    renderAt('/rechnungen/inv-1');

    await screen.findByTestId('invoice-detail-view');

    expect(screen.getByTestId('invoice-detail-number')).toHaveTextContent('RE-2026-0001');
    expect(screen.getByTestId('invoice-detail-status')).toHaveTextContent('Ausgestellt');
    expect(screen.getByTestId('invoice-detail-issuer-name')).toHaveTextContent('Test GmbH');
    expect(screen.getByTestId('invoice-detail-recipient-name')).toHaveTextContent('Kunde GmbH');
    expect(screen.getByTestId('invoice-detail-lines')).toHaveTextContent('Anstrich Fassade');
    expect(screen.getByTestId('invoice-detail-totals')).toHaveTextContent('1.785,00');
  });

  it('labels the PDF action "ZUGFeRD herunterladen" for the zugferd profile', async () => {
    setAuthUser(['owner']);
    getByIdMock.mockResolvedValue({ ok: true, data: makeInvoice({ profile: 'zugferd-en16931' }) });
    renderAt('/rechnungen/inv-1');

    const action = await screen.findByTestId('invoice-detail-download-pdf');
    expect(action).toHaveTextContent('ZUGFeRD herunterladen');
  });

  it('shows the Stornieren button when caller holds invoice:write', async () => {
    setAuthUser(['owner']);
    getByIdMock.mockResolvedValue({ ok: true, data: makeInvoice() });
    renderAt('/rechnungen/inv-1');

    await screen.findByTestId('invoice-detail-view');
    expect(screen.getByTestId('invoice-detail-cancel-button')).toBeInTheDocument();
  });

  it('hides the Stornieren button for invoice:read-only callers (bookkeeper)', async () => {
    setAuthUser(['bookkeeper']);
    getByIdMock.mockResolvedValue({ ok: true, data: makeInvoice() });
    renderAt('/rechnungen/inv-1');

    await screen.findByTestId('invoice-detail-view');
    expect(screen.queryByTestId('invoice-detail-cancel-button')).toBeNull();
  });
});

describe('InvoiceDetailView — cancelled original', () => {
  it('renders cancelled status and hides the Stornieren button', async () => {
    setAuthUser(['owner']);
    getByIdMock.mockResolvedValue({
      ok: true,
      data: makeInvoice({ status: 'cancelled', cancellationReason: 'Tippfehler' }),
    });
    renderAt('/rechnungen/inv-1');

    await screen.findByTestId('invoice-detail-view');
    expect(screen.getByTestId('invoice-detail-status')).toHaveTextContent('Storniert');
    expect(screen.getByTestId('invoice-detail-cancellation-reason')).toHaveTextContent(
      'Tippfehler',
    );
    expect(screen.queryByTestId('invoice-detail-cancel-button')).toBeNull();
  });

  it('renders the storno-siblings list (§8.16.1 — original links to every Storno)', async () => {
    setAuthUser(['owner']);
    const storno = makeInvoice({
      id: 'storno-1',
      number: 'ST-2026-0001',
      status: 'issued',
      cancellationOf: 'inv-1',
    });
    getByIdMock.mockResolvedValue({
      ok: true,
      data: makeInvoice({ status: 'cancelled', cancellationReason: 'Tippfehler' }),
    });
    listMock.mockResolvedValue({ ok: true, data: { data: [storno], total: 1 } });
    renderAt('/rechnungen/inv-1');

    await screen.findByTestId('invoice-detail-view');
    await waitFor(() => {
      expect(screen.getByTestId('invoice-detail-storno-siblings')).toHaveTextContent(
        'ST-2026-0001',
      );
    });
  });
});

describe('InvoiceDetailView — Storno row', () => {
  it('renders the "Original anzeigen" link to its cancellationOf and a Storno label', async () => {
    setAuthUser(['owner']);
    getByIdMock.mockResolvedValue({
      ok: true,
      data: makeInvoice({
        id: 'storno-1',
        number: 'ST-2026-0001',
        status: 'issued',
        cancellationOf: 'inv-orig',
      }),
    });
    renderAt('/rechnungen/storno-1');

    await screen.findByTestId('invoice-detail-view');
    expect(screen.getByTestId('invoice-detail-status')).toHaveTextContent('Storno');
    const link = screen.getByTestId('invoice-detail-view-original');
    expect(link).toHaveAttribute('href', '/rechnungen/inv-orig');
  });

  it('does NOT expose the Stornieren button (cancelling a Storno is not a thing)', async () => {
    setAuthUser(['owner']);
    getByIdMock.mockResolvedValue({
      ok: true,
      data: makeInvoice({
        id: 'storno-1',
        number: 'ST-2026-0001',
        status: 'issued',
        cancellationOf: 'inv-orig',
      }),
    });
    renderAt('/rechnungen/storno-1');

    await screen.findByTestId('invoice-detail-view');
    expect(screen.queryByTestId('invoice-detail-cancel-button')).toBeNull();
  });
});

describe('InvoiceDetailView — draft deep-link', () => {
  it('redirects a draft id to its project (§8.16.3 — drafts out of scope)', async () => {
    setAuthUser(['owner']);
    getByIdMock.mockResolvedValue({
      ok: true,
      data: makeInvoice({ status: 'draft', number: null }),
    });
    renderAt('/rechnungen/inv-1');

    await waitFor(() => {
      expect(screen.getByTestId('stub-project-page')).toBeInTheDocument();
    });
  });
});

describe('InvoiceDetailView — not-found surface', () => {
  it('renders a "not found" message when the API returns NOT_FOUND', async () => {
    setAuthUser(['owner']);
    getByIdMock.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'gone' },
      category: 'not_found',
      sessionExpired: false,
    });
    renderAt('/rechnungen/missing-id');

    await waitFor(() => {
      expect(screen.getByTestId('invoice-detail-not-found')).toBeInTheDocument();
    });
  });
});
