/**
 * InvoiceListRow — a `/rechnungen` list row's actions (ui/invoices.md §8.16.1).
 *
 * Pins: a draft of an archived project offers no change (AC-514), while
 * the same draft of an active project offers `Bearbeiten` and `Verwerfen`.
 * The `Verwerfen` confirmation sends the version it opened on, whatever a
 * live refresh brings meanwhile (AC-729).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { Invoice } from '@/domain/invoice';
import { invoicesApi } from '@/api/client';
import { InvoiceListRow } from '@/ui/invoices/InvoiceListRow';
import { ConfirmDialog } from '@/ui/common/ConfirmDialog';
import { useAuthStore } from '@/state/authStore';

function makeDraft(overrides: Partial<Invoice>): Invoice {
  return {
    id: 'inv-1',
    number: null,
    status: 'draft',
    projectId: 'proj-1',
    cancellationOf: null,
    issuer: { companyName: '', address: { street: '', zip: '', city: '' }, taxId: '' },
    recipient: {
      name: 'Kunde GmbH',
      address: { street: 'Gartenweg 2', zip: '10117', city: 'Berlin' },
      ustId: null,
    },
    lines: [],
    taxMode: 'standard',
    profile: 'zugferd-en16931',
    totals: { perRate: [], netGrandTotal: 0, taxGrandTotal: 0, grossGrandTotal: 0 },
    issueDate: null,
    performanceDate: null,
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

function signInOwner(): void {
  useAuthStore.setState({
    authUser: {
      id: 'u-1',
      username: 'owner',
      displayName: 'Owner',
      roles: ['owner'],
      email: null,
      themePreference: 'system',
      pushMuted: false,
    },
    authError: null,
    sessionChecked: true,
  });
}

describe('InvoiceListRow — archived project', () => {
  it('AC-514: offers no change on a draft of an archived project', () => {
    signInOwner();
    render(
      <MemoryRouter>
        <div data-testid="active">
          <InvoiceListRow invoice={makeDraft({ id: 'inv-active' })} originalNumber={null} />
        </div>
        <div data-testid="archived">
          <InvoiceListRow
            invoice={makeDraft({ id: 'inv-archived', projectArchived: true })}
            originalNumber={null}
          />
        </div>
      </MemoryRouter>,
    );

    const active = within(screen.getByTestId('active'));
    expect(active.getByTestId('invoice-draft-edit')).toBeInTheDocument();
    expect(active.getByTestId('invoice-draft-delete')).toBeInTheDocument();

    const archived = within(screen.getByTestId('archived'));
    expect(archived.queryByTestId('invoice-draft-edit')).toBeNull();
    expect(archived.queryByTestId('invoice-draft-delete')).toBeNull();
  });
});

describe('InvoiceListRow — AC-729: the discard confirmation acts on the version it opened on', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const line = {
    description: 'Anstrich Fassade',
    quantity: 1,
    unit: 'pauschal',
    unitPrice: 1500,
    lineTotal: 1500,
    taxRate: 19,
  };
  const opened = makeDraft({
    lines: [line],
    totals: {
      perRate: [{ taxRate: 19, netSubtotal: 1500, taxAmount: 285 }],
      netGrandTotal: 1500,
      taxGrandTotal: 285,
      grossGrandTotal: 1785,
    },
  });
  // Repriced by another session while the dialog is open.
  const repriced = makeDraft({
    version: 2,
    lines: [{ ...line, unitPrice: 2000, lineTotal: 2000 }],
    totals: {
      perRate: [{ taxRate: 19, netSubtotal: 2000, taxAmount: 380 }],
      netGrandTotal: 2000,
      taxGrandTotal: 380,
      grossGrandTotal: 2380,
    },
  });

  it('Verwerfen sends the version shown when the dialog opened', async () => {
    signInOwner();
    const discard = vi.spyOn(invoicesApi, 'deleteDraft').mockResolvedValue({
      ok: false,
      error: { code: 'VERSION_CONFLICT', message: 'Inzwischen geändert.' },
      category: 'server_error',
      sessionExpired: false,
    });
    // The conflict's refetches; their outcome is not under test.
    vi.spyOn(invoicesApi, 'listByProject').mockReturnValue(new Promise(() => {}));
    vi.spyOn(invoicesApi, 'list').mockReturnValue(new Promise(() => {}));
    const ui = (invoice: Invoice) => (
      <MemoryRouter>
        <div data-testid="row">
          <InvoiceListRow invoice={invoice} originalNumber={null} />
        </div>
        <ConfirmDialog />
      </MemoryRouter>
    );
    const { rerender } = render(ui(opened));

    await userEvent.click(screen.getByTestId('invoice-draft-delete'));
    const dialog = screen.getByTestId('confirm-dialog');
    expect(dialog).toHaveTextContent(/1\.785,00/);

    // A live refresh re-renders the row behind the open dialog.
    rerender(ui(repriced));
    expect(screen.getByTestId('row')).toHaveTextContent(/2\.380,00/);
    expect(dialog).toHaveTextContent(/1\.785,00/);
    expect(dialog).not.toHaveTextContent(/2\.380,00/);

    await userEvent.click(screen.getByTestId('confirm-ok'));
    expect(discard).toHaveBeenCalledExactlyOnceWith('inv-1', 1);
  });
});
