/**
 * InvoiceSection — draft-editor close navigation (UX fix).
 *
 * When the editor is opened by clicking a draft row on the standalone
 * `/rechnungen?projectId=<id>` filtered list, the row navigates here
 * via router state carrying a `returnTo` URL. The editor's onClose
 * honors that state and returns the user to the filtered list —
 * otherwise (in-page CTAs, fresh load) the close stays on the project
 * page and just strips the `editDraft` URL param.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import type { ApiResult } from '@/api/client';
import type { Customer, Project } from '@/domain/types';
import type { Invoice } from '@/domain/invoice';

type InvoiceListResult = ApiResult<{ data: Invoice[]; total: number }>;
const listByProjectMock = vi.fn<(projectId: string) => Promise<InvoiceListResult>>();

vi.mock('@/api/client', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    invoicesApi: {
      list: vi.fn().mockResolvedValue({ ok: true, data: { data: [], total: 0 } }),
      listByProject: (...args: unknown[]) =>
        listByProjectMock(...(args as Parameters<typeof listByProjectMock>)),
      getById: vi.fn(),
      createDraft: vi.fn(),
      updateDraft: vi.fn(),
      deleteDraft: vi.fn(),
      issue: vi.fn(),
      cancel: vi.fn(),
      pdfUrl: (id: string) => `/api/invoices/${id}/pdf`,
    },
    authApi: {
      login: vi.fn(),
      logout: vi.fn(),
      me: vi.fn().mockResolvedValue({ ok: false }),
    },
  };
});

const { InvoiceSection } = await import('@/ui/detail/invoice/InvoiceSection');
const { useAuthStore } = await import('@/state/authStore');
const { useInvoiceStore } = await import('@/state/invoiceStore');
const { useProjectStore } = await import('@/state/projectStore');

const CUSTOMER: Customer = {
  id: 'c-1',
  name: 'Kunde GmbH',
  phone: null,
  email: null,
  address: { street: 'Gartenweg 2', zip: '10117', city: 'Berlin' },
  notes: null,
  createdAt: '2026-03-30T00:00:00Z',
  updatedAt: '2026-03-30T00:00:00Z',
  createdBy: null,
  updatedBy: null,
};

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-abc',
    number: 'P-042',
    title: 'Dachsanierung',
    status: 'rechnung_faellig',
    statusChangedAt: '2026-04-01T00:00:00Z',
    plannedStart: '2026-05-01',
    plannedEnd: '2026-06-01',
    customerId: 'c-1',
    customer: CUSTOMER,
    siteAddress: null,
    assignedWorkers: [],
    estimatedValue: null,
    notes: null,
    deleted: false,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    createdBy: null,
    updatedBy: null,
    ...overrides,
  };
}

function makeDraft(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'draft-1',
    number: null,
    status: 'draft',
    projectId: 'proj-abc',
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
    issueDate: null,
    performanceDate: '2026-04-10',
    cancellationReason: null,
    renderedPdfBinaryDescriptorId: null,
    createdAt: '2026-04-10T00:00:00Z',
    updatedAt: '2026-04-10T00:00:00Z',
    createdBy: null,
    updatedBy: null,
    ...overrides,
  };
}

function setAuthUser(roles: string[]): void {
  useAuthStore.setState({
    authUser: {
      id: 'u-1',
      username: 'owner',
      displayName: 'Owner',
      roles,
      email: null,
      themePreference: 'system',
      pushMuted: false,
    },
    authError: null,
    sessionChecked: true,
  });
}

function LocationProbe() {
  const loc = useLocation();
  return (
    <span data-testid="location-probe">
      {loc.pathname}
      {loc.search}
    </span>
  );
}

beforeEach(() => {
  listByProjectMock.mockReset();
  listByProjectMock.mockResolvedValue({ ok: true, data: { data: [makeDraft()], total: 1 } });
  setAuthUser(['owner']);
  useProjectStore.setState({
    projects: [makeProject()],
    mutationInFlight: {},
    mutationError: null,
  });
  useInvoiceStore.setState({
    byProject: {},
    loadingByProject: {},
    errorByProject: {},
  });
});

interface RenderOptions {
  state?: { returnTo?: unknown };
}

function renderSection(opts: RenderOptions = {}) {
  const entry = {
    pathname: '/projects/proj-abc',
    search: '?editDraft=draft-1',
    state: opts.state ?? null,
  };
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/projects/:projectId"
          element={
            <>
              <InvoiceSection projectId="proj-abc" projectStatus="rechnung_faellig" />
              <LocationProbe />
            </>
          }
        />
        <Route path="/rechnungen" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('InvoiceSection — draft editor onClose navigation', () => {
  it('returns the user to the originating /rechnungen list when state.returnTo points there', async () => {
    renderSection({ state: { returnTo: '/rechnungen?projectId=proj-abc' } });

    // The deep-link `editDraft` opens the form automatically.
    await screen.findByTestId('invoice-form');

    const cancelButton = screen.getByRole('button', { name: 'Abbrechen' });
    await userEvent.click(cancelButton);

    await waitFor(() => {
      expect(screen.getByTestId('location-probe')).toHaveTextContent(
        '/rechnungen?projectId=proj-abc',
      );
    });
  });

  it('stays on the project page and strips the editDraft param when no returnTo state is present', async () => {
    renderSection();

    await screen.findByTestId('invoice-form');

    const cancelButton = screen.getByRole('button', { name: 'Abbrechen' });
    await userEvent.click(cancelButton);

    await waitFor(() => {
      expect(screen.queryByTestId('invoice-form')).toBeNull();
    });
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/projects/proj-abc');
    expect(screen.getByTestId('location-probe')).not.toHaveTextContent('editDraft');
  });

  it('ignores a returnTo that does not start with /rechnungen (strict prefix guard)', async () => {
    renderSection({ state: { returnTo: '/projects/other-project' } });

    await screen.findByTestId('invoice-form');

    const cancelButton = screen.getByRole('button', { name: 'Abbrechen' });
    await userEvent.click(cancelButton);

    await waitFor(() => {
      expect(screen.queryByTestId('invoice-form')).toBeNull();
    });
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/projects/proj-abc');
    expect(screen.getByTestId('location-probe')).not.toHaveTextContent('editDraft');
  });

  it('ignores a non-string returnTo (defensive narrowing)', async () => {
    renderSection({ state: { returnTo: 42 } });

    await screen.findByTestId('invoice-form');

    const cancelButton = screen.getByRole('button', { name: 'Abbrechen' });
    await userEvent.click(cancelButton);

    await waitFor(() => {
      expect(screen.queryByTestId('invoice-form')).toBeNull();
    });
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/projects/proj-abc');
  });
});
