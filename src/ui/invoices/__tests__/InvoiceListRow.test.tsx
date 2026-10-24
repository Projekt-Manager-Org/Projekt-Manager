/**
 * InvoiceListRow — a `/rechnungen` list row's actions (ui/invoices.md §8.16.1).
 *
 * Pins: a draft of an archived project offers no change (AC-514), while
 * the same draft of an active project offers `Bearbeiten` and `Verwerfen`.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { Invoice } from '@/domain/invoice';
import { InvoiceListRow } from '@/ui/invoices/InvoiceListRow';
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

describe('InvoiceListRow — archived project', () => {
  it('AC-514: offers no change on a draft of an archived project', () => {
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
