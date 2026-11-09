/**
 * InvoiceSection — draft-editor close navigation (UX fix).
 *
 * When the editor is opened by clicking a draft row on the standalone
 * `/rechnungen?projectId=<id>` filtered list, the row navigates here
 * via router state carrying a `returnTo` URL. The editor's onClose
 * honors that state and returns the user to the filtered list —
 * otherwise (in-page CTAs, fresh load) the close stays on the project
 * page and just strips the `editDraft` URL param.
 *
 * Also: the totals preview survives a typed value that overflows a double,
 * the tax-rate select follows the tax mode (ui/invoices.md §8.16.2), and the
 * recipient's USt-IdNr. is pre-filled and editable, with unchanged fields
 * left to the server pre-fill.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import type { ApiResult } from '@/api/client';
import type { Customer, Project } from '@/domain/types';
import type { Invoice } from '@/domain/invoice';
import { STRINGS } from '@/config/strings';

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
const { invoicesApi } = await import('@/api/client');
const { useAuthStore } = await import('@/state/authStore');
const { useInvoiceStore } = await import('@/state/invoiceStore');
const { useProjectStore } = await import('@/state/projectStore');

const CUSTOMER: Customer = {
  id: 'c-1',
  version: 1,
  name: 'Kunde GmbH',
  phone: null,
  email: null,
  address: { street: 'Gartenweg 2', zip: '10117', city: 'Berlin' },
  ustId: null,
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
    projectArchived: false,
    version: 1,
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
  search?: string;
}

function renderSection(opts: RenderOptions = {}) {
  const entry = {
    pathname: '/projects/proj-abc',
    search: opts.search ?? '?editDraft=draft-1',
    state: opts.state ?? null,
  };
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/projects/:projectId"
          element={
            <>
              <InvoiceSection
                projectId="proj-abc"
                projectStatus="rechnung_faellig"
                archived={false}
              />
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

describe('InvoiceSection — draft editor totals preview', () => {
  it('shows a placeholder instead of crashing when a typed line overflows', async () => {
    renderSection();
    await screen.findByTestId('invoice-form');

    const quantity = screen.getAllByTestId(/^invoice-line-quantity-input/)[0]!;
    const unitPrice = screen.getAllByTestId(/^invoice-line-unit-price-input/)[0]!;
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '1e200');
    await userEvent.clear(unitPrice);
    await userEvent.type(unitPrice, '1e200');

    expect(screen.getByTestId('invoice-totals-net')).toHaveTextContent('—');
  });
});

describe('InvoiceSection — recipient USt-IdNr.', () => {
  const ustIdInput = () => screen.getByTestId('invoice-recipient-ustid-input');

  async function fillUsableLine() {
    await userEvent.type(screen.getByTestId('invoice-line-description-input'), 'Anstrich');
    await userEvent.type(screen.getByTestId('invoice-line-unit-price-input'), '100');
  }

  async function openNewDraft() {
    useProjectStore.setState({
      projects: [makeProject({ customer: { ...CUSTOMER, ustId: 'DE123456789' } })],
    });
    listByProjectMock.mockResolvedValue({ ok: true, data: { data: [], total: 0 } });
    vi.mocked(invoicesApi.createDraft).mockReset();
    vi.mocked(invoicesApi.createDraft).mockResolvedValue({ ok: true, data: makeDraft() });
    renderSection({ search: '' });
    await userEvent.click(await screen.findByTestId('invoice-draft-create'));
    await screen.findByTestId('invoice-form');
  }

  const sentRecipient = () => vi.mocked(invoicesApi.createDraft).mock.calls[0]![1].recipient;

  it("ui/invoices.md §8.16.2: a new draft shows the customer's USt-IdNr.", async () => {
    await openNewDraft();
    expect(ustIdInput()).toHaveValue('DE123456789');
  });

  it('ui/invoices.md §8.16.2: an unchanged recipient is left to the server pre-fill', async () => {
    await openNewDraft();
    await fillUsableLine();
    await userEvent.click(screen.getByTestId('invoice-form-save'));

    await waitFor(() => expect(invoicesApi.createDraft).toHaveBeenCalledTimes(1));
    expect(sentRecipient()).toEqual({});
  });

  it('ui/invoices.md §8.16.2: a correction landing while the form is open is not overridden by the shown value', async () => {
    await openNewDraft();
    act(() => {
      useProjectStore.setState({
        projects: [makeProject({ customer: { ...CUSTOMER, ustId: 'DE000000001' } })],
      });
    });
    await fillUsableLine();
    await userEvent.click(screen.getByTestId('invoice-form-save'));

    await waitFor(() => expect(invoicesApi.createDraft).toHaveBeenCalledTimes(1));
    expect(sentRecipient()).toEqual({});
  });

  it('ui/invoices.md §8.16.2: a form opened after a customer correction shows the corrected values', async () => {
    await openNewDraft();
    await userEvent.click(screen.getByRole('button', { name: STRINGS.ui.cancel }));
    act(() => {
      useProjectStore.setState({
        projects: [makeProject({ customer: { ...CUSTOMER, ustId: 'DE000000001' } })],
      });
    });

    await userEvent.click(await screen.findByTestId('invoice-draft-create'));

    expect(await screen.findByTestId('invoice-recipient-ustid-input')).toHaveValue('DE000000001');
  });

  it('ui/invoices.md §8.16.2: an edited address is sent whole, and only the address', async () => {
    await openNewDraft();
    const street = screen.getByRole('textbox', { name: STRINGS.invoices.formRecipientStreet });
    await userEvent.clear(street);
    await userEvent.type(street, 'Neue Straße 5');
    await fillUsableLine();
    await userEvent.click(screen.getByTestId('invoice-form-save'));

    await waitFor(() => expect(invoicesApi.createDraft).toHaveBeenCalledTimes(1));
    expect(sentRecipient()).toEqual({
      address: { street: 'Neue Straße 5', zip: '10117', city: 'Berlin' },
    });
  });

  it('ui/invoices.md §8.16.2: an edited USt-IdNr. overrides the customer value on the draft', async () => {
    await openNewDraft();
    await userEvent.clear(ustIdInput());
    await userEvent.type(ustIdInput(), ' DE987654321 ');
    await fillUsableLine();
    await userEvent.click(screen.getByTestId('invoice-form-save'));

    await waitFor(() => expect(invoicesApi.createDraft).toHaveBeenCalledTimes(1));
    expect(sentRecipient()).toEqual({ ustId: 'DE987654321' });
  });

  it('ui/invoices.md §8.16.2: an emptied USt-IdNr. is sent as no value', async () => {
    await openNewDraft();
    await userEvent.clear(ustIdInput());
    await fillUsableLine();
    await userEvent.click(screen.getByTestId('invoice-form-save'));

    await waitFor(() => expect(invoicesApi.createDraft).toHaveBeenCalledTimes(1));
    expect(sentRecipient()).toEqual({ ustId: null });
  });

  it('ui/invoices.md §8.16.2: a cleared address is sent as no address', async () => {
    await openNewDraft();
    for (const label of ['Street', 'Zip', 'City'] as const) {
      await userEvent.clear(
        screen.getByRole('textbox', { name: STRINGS.invoices[`formRecipient${label}`] }),
      );
    }
    await fillUsableLine();
    await userEvent.click(screen.getByTestId('invoice-form-save'));

    await waitFor(() => expect(invoicesApi.createDraft).toHaveBeenCalledTimes(1));
    expect(sentRecipient()).toEqual({ address: null });
  });

  it("ui/invoices.md §8.16.2: an existing draft shows its own USt-IdNr., not the customer's", async () => {
    useProjectStore.setState({
      projects: [makeProject({ customer: { ...CUSTOMER, ustId: 'DE123456789' } })],
    });
    listByProjectMock.mockResolvedValue({
      ok: true,
      data: {
        data: [
          makeDraft({
            recipient: { ...makeDraft().recipient, ustId: 'DE555555555' },
          }),
        ],
        total: 1,
      },
    });
    renderSection();
    await screen.findByTestId('invoice-form');

    expect(ustIdInput()).toHaveValue('DE555555555');
  });
});

describe('InvoiceSection — draft editor tax-rate select', () => {
  const rateOptions = () =>
    Array.from(
      (screen.getByTestId('invoice-line-tax-rate-select') as HTMLSelectElement).options,
    ).map((o) => o.value);

  function reverseChargeDraftWithZeroLine(): Invoice {
    return makeDraft({
      taxMode: 'reverse_charge',
      lines: [{ ...makeDraft().lines[0]!, taxRate: 0 }],
      totals: { perRate: [], netGrandTotal: 1500, taxGrandTotal: 0, grossGrandTotal: 1500 },
    });
  }

  it('offers 7 and 19 under Regulär', async () => {
    renderSection();
    await screen.findByTestId('invoice-form');
    expect(rateOptions()).toEqual(['7', '19']);
  });

  it('offers 0, 7 and 19 under Reverse-Charge', async () => {
    listByProjectMock.mockResolvedValue({
      ok: true,
      data: { data: [reverseChargeDraftWithZeroLine()], total: 1 },
    });
    renderSection();
    await screen.findByTestId('invoice-form');
    expect(rateOptions()).toEqual(['0', '7', '19']);
  });

  it('switching to Regulär keeps a 0 % line, flags it and blocks Speichern', async () => {
    listByProjectMock.mockResolvedValue({
      ok: true,
      data: { data: [reverseChargeDraftWithZeroLine()], total: 1 },
    });
    vi.mocked(invoicesApi.updateDraft).mockReset();
    vi.mocked(invoicesApi.updateDraft).mockResolvedValue({
      ok: true,
      data: makeDraft({ version: 2 }),
    });
    renderSection();
    await screen.findByTestId('invoice-form');

    await userEvent.selectOptions(screen.getByTestId('invoice-tax-mode-select'), 'standard');

    expect(screen.getByTestId('invoice-line-tax-rate-select')).toHaveValue('0');
    expect(screen.getByTestId('invoice-line-tax-rate-error')).toBeVisible();
    await userEvent.click(screen.getByTestId('invoice-form-save'));
    expect(invoicesApi.updateDraft).not.toHaveBeenCalled();

    // A valid rate clears the error and unblocks Speichern.
    await userEvent.selectOptions(screen.getByTestId('invoice-line-tax-rate-select'), '19');
    expect(screen.queryByTestId('invoice-line-tax-rate-error')).toBeNull();
    await userEvent.click(screen.getByTestId('invoice-form-save'));
    await waitFor(() => expect(invoicesApi.updateDraft).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(invoicesApi.updateDraft).mock.calls[0]!.at(-1) as {
      lines: Array<{ taxRate: number }>;
    };
    expect(payload.lines[0]!.taxRate).toBe(19);
  });
});
