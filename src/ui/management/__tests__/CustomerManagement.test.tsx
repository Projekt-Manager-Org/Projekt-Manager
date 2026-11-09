/**
 * Component tests for CustomerManagement covering the new behavior
 * introduced with the idempotent create / autocomplete work:
 *
 *   - UUID is stable across re-renders of the same form instance.
 *   - UUID is regenerated across open→close→open cycles.
 *   - Name autocomplete debounces and dedupes rapid keystrokes.
 *   - Clicking a dropdown match closes the create form and opens the
 *     edit form for that customer.
 *   - IDEMPOTENCY_CONFLICT closes the form and surfaces the message.
 *
 * The API client is stubbed at module boundary; the real stores run
 * so their observable behavior (`createCustomer` returning an outcome,
 * `searchCustomers` delegating to the API) is exercised end-to-end
 * within the component tree.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiResult } from '@/api/client';
import type { Customer } from '@/domain/types';
import { STRINGS } from '@/config/strings';

type CustomerCreateResult = ApiResult<Customer>;
type CustomerListResult = ApiResult<{ customers: Customer[]; total: number }>;

const customerCreateMock = vi.fn<() => Promise<CustomerCreateResult>>();
const customerListMock = vi.fn<() => Promise<CustomerListResult>>();
const customerGetMock = vi.fn<() => Promise<ApiResult<Customer>>>();

vi.mock('@/api/client', () => ({
  customerApi: {
    list: (...args: unknown[]) =>
      customerListMock(...(args as Parameters<typeof customerListMock>)),
    create: (...args: unknown[]) =>
      customerCreateMock(...(args as Parameters<typeof customerCreateMock>)),
    get: (...args: unknown[]) => customerGetMock(...(args as Parameters<typeof customerGetMock>)),
    update: vi.fn(),
    delete: vi.fn(),
  },
  projectApi: {
    list: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    updateDates: vi.fn(),
    transitionForward: vi.fn(),
    transitionBackward: vi.fn(),
  },
  authApi: {
    me: vi.fn().mockResolvedValue({ ok: false }),
    login: vi.fn(),
    logout: vi.fn(),
  },
  userApi: { list: vi.fn() },
}));

const { CustomerManagement } = await import('@/ui/management/CustomerManagement');
const { useAuthStore } = await import('@/state/authStore');
const { useCustomerStore } = await import('@/state/customerStore');
const { useConfirmStore } = await import('@/state/confirmStore');
const { customerApi } = await import('@/api/client');

function emptyList(): CustomerListResult {
  return { ok: true, data: { customers: [], total: 0 } };
}

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

beforeEach(() => {
  customerCreateMock.mockReset();
  customerListMock.mockReset();
  customerListMock.mockResolvedValue(emptyList());
  customerGetMock.mockReset();
  vi.mocked(customerApi.update).mockReset();
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
  useCustomerStore.setState({
    customers: [],
    total: 0,
    loading: false,
    error: null,
    search: '',
    sortBy: 'name',
    sortDir: 'asc',
  });
});

describe('CustomerManagement — create form UUID lifecycle', () => {
  it('keeps the same id across re-renders and retries of one form instance', async () => {
    customerCreateMock
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'Fehler' },
        category: 'validation',
        sessionExpired: false,
      })
      .mockResolvedValueOnce(ok({ id: 'srv-1', name: 'Ada' } as Customer));

    const { rerender } = render(<CustomerManagement />);

    await userEvent.click(screen.getByTestId('customer-create-button'));
    const nameInput = screen.getByTestId('customer-name-input');
    await userEvent.type(nameInput, 'Ada');

    const submit = screen.getByTestId('customer-submit');

    // First submission — validation error keeps the form open.
    await userEvent.click(submit);
    await waitFor(() => expect(customerCreateMock).toHaveBeenCalledTimes(1));

    // Force an external re-render between attempts. If the implementation
    // regresses and pulls the UUID into a render-time expression instead
    // of a stable state slot, the second submit would carry a different
    // id — this assertion would catch that. (`useState(crypto.randomUUID())`
    // would also survive this check because its initializer runs once, so
    // the test intentionally exercises both mechanisms as equivalent.)
    rerender(<CustomerManagement />);

    await userEvent.click(submit);
    await waitFor(() => expect(customerCreateMock).toHaveBeenCalledTimes(2));

    const calls = customerCreateMock.mock.calls as unknown as Array<[{ id: string }]>;
    const firstId = calls[0][0].id;
    const secondId = calls[1][0].id;
    expect(firstId).toBeTruthy();
    expect(firstId).toBe(secondId);
  });

  it('regenerates the id across open → close → open cycles', async () => {
    customerCreateMock.mockResolvedValue(ok({ id: 'srv-1', name: 'Ada' } as Customer));

    render(<CustomerManagement />);

    // First cycle.
    await userEvent.click(screen.getByTestId('customer-create-button'));
    await userEvent.type(screen.getByTestId('customer-name-input'), 'Ada');
    await userEvent.click(screen.getByTestId('customer-submit'));
    await waitFor(() => expect(customerCreateMock).toHaveBeenCalledTimes(1));

    // Second cycle — fresh open.
    await userEvent.click(screen.getByTestId('customer-create-button'));
    await userEvent.type(screen.getByTestId('customer-name-input'), 'Bert');
    await userEvent.click(screen.getByTestId('customer-submit'));
    await waitFor(() => expect(customerCreateMock).toHaveBeenCalledTimes(2));

    const calls = customerCreateMock.mock.calls as unknown as Array<[{ id: string }]>;
    const firstId = calls[0][0].id;
    const secondId = calls[1][0].id;
    expect(firstId).not.toBe(secondId);
  });
});

describe('CustomerManagement — name autocomplete', () => {
  it('debounces rapid keystrokes into a single API call', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<CustomerManagement />);

      // Initial fetchCustomers on mount — one call with undefined search.
      await waitFor(() => expect(customerListMock).toHaveBeenCalled());
      customerListMock.mockClear();
      customerListMock.mockResolvedValue(
        ok({ customers: [{ id: 'c-1', name: 'Ada' } as Customer], total: 1 }),
      );

      // We need to drive the form via the real UI, but with fake timers
      // userEvent deadlocks on waitForNextUpdate. Fall back to fireEvent.
      fireEvent.click(screen.getByTestId('customer-create-button'));
      const nameInput = screen.getByTestId('customer-name-input');
      fireEvent.change(nameInput, { target: { value: 'A' } });
      fireEvent.change(nameInput, { target: { value: 'Ad' } });
      fireEvent.change(nameInput, { target: { value: 'Ada' } });

      // Before the debounce window expires, no call.
      expect(customerListMock).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });

      // Exactly one call went out, for the final value.
      expect(customerListMock).toHaveBeenCalledTimes(1);
      expect(customerListMock).toHaveBeenCalledWith({ search: 'Ada' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('clicking a match closes create and opens edit for that customer', async () => {
    customerListMock.mockResolvedValue(
      ok({
        customers: [{ id: 'c-1', name: 'Ada Lovelace', phone: '123' } as Customer],
        total: 1,
      }),
    );

    render(<CustomerManagement />);

    await userEvent.click(screen.getByTestId('customer-create-button'));
    await userEvent.type(screen.getByTestId('customer-name-input'), 'Ada');

    const match = await screen.findByTestId('customer-match-c-1');
    await userEvent.click(match);

    // Edit form: the save button is visible; the submit (create) button
    // is not. The name input is prefilled with the match's name.
    await waitFor(() => {
      expect(screen.queryByTestId('customer-submit')).not.toBeInTheDocument();
      expect(screen.getByTestId('customer-save')).toBeInTheDocument();
    });
    expect((screen.getByTestId('customer-name-input') as HTMLInputElement).value).toBe(
      'Ada Lovelace',
    );
  });
});

// AC-131: in-flight mutation lock covers the soft-confirm dialog — a
// second submit opened while the confirm is awaiting user input must
// not fire a second create when the confirm resolves.
describe('CustomerManagement — soft-confirm double-click protection', () => {
  it('fires only one create call when the user double-clicks during the confirm dialog', async () => {
    // One existing customer whose name collides case-insensitively →
    // submit triggers the soft-confirm modal.
    customerListMock.mockResolvedValue(
      ok({ customers: [{ id: 'c-1', name: 'Ada' } as Customer], total: 1 }),
    );
    customerCreateMock.mockResolvedValue(ok({ id: 'srv-1', name: 'Ada' } as Customer));

    render(<CustomerManagement />);

    await userEvent.click(screen.getByTestId('customer-create-button'));
    await userEvent.type(screen.getByTestId('customer-name-input'), 'Ada');

    // Wait until the autocomplete fetch completes so the exact-match
    // memo is populated and submit will open the confirm.
    await waitFor(() =>
      expect(customerListMock).toHaveBeenCalledWith(expect.objectContaining({ search: 'Ada' })),
    );

    const submit = screen.getByTestId('customer-submit');
    // First click opens the confirm dialog; handler is awaiting the
    // resolver. Second click must be rejected by the submitting guard.
    await userEvent.click(submit);
    await userEvent.click(submit);

    // Resolve the confirm with 'proceed'. Under the fix, exactly one
    // create call fires. Under the bug, `useConfirmStore.request`'s
    // preemption cancels the first dialog and the second click opens a
    // new one — when resolved, it would fire a create call from the
    // second handler invocation, but NOT from the first (which was
    // cancelled). So the bug signature is actually "zero OR two calls";
    // the fix guarantees exactly one.
    await act(async () => {
      useConfirmStore.getState().resolve(true);
    });

    await waitFor(() => expect(customerCreateMock).toHaveBeenCalledTimes(1));
    // Give any phantom second call room to fire, then assert stability.
    await new Promise((r) => setTimeout(r, 50));
    expect(customerCreateMock).toHaveBeenCalledTimes(1);
  });
});

describe('AC-524: CustomerManagement — list search', () => {
  it('debounces typing in the toolbar search and refetches with the search param', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<CustomerManagement />);

      // Mount fetch goes out with the default sort baseline.
      await waitFor(() => expect(customerListMock).toHaveBeenCalled());
      customerListMock.mockClear();
      customerListMock.mockResolvedValue(ok({ customers: [], total: 0 }));

      const searchInput = screen.getByTestId('customer-search');
      fireEvent.change(searchInput, { target: { value: 'M' } });
      fireEvent.change(searchInput, { target: { value: 'Mu' } });
      fireEvent.change(searchInput, { target: { value: 'Mue' } });

      // No fetch before the debounce window expires.
      expect(customerListMock).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });

      // One coalesced call carrying the final value plus the active sort.
      expect(customerListMock).toHaveBeenCalledTimes(1);
      expect(customerListMock).toHaveBeenCalledWith({
        search: 'Mue',
        sortBy: 'name',
        sortDir: 'asc',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AC-525: CustomerManagement — sortable headers', () => {
  it('clicking a header refetches with that column ascending', async () => {
    render(<CustomerManagement />);

    await waitFor(() => expect(customerListMock).toHaveBeenCalled());
    customerListMock.mockClear();
    customerListMock.mockResolvedValue(ok({ customers: [], total: 0 }));

    await userEvent.click(screen.getByTestId('customer-sort-phone'));

    await waitFor(() => expect(customerListMock).toHaveBeenCalledTimes(1));
    expect(customerListMock).toHaveBeenCalledWith({ sortBy: 'phone', sortDir: 'asc' });
  });

  it('second click on the active header flips direction to descending', async () => {
    render(<CustomerManagement />);

    await waitFor(() => expect(customerListMock).toHaveBeenCalled());
    customerListMock.mockClear();
    customerListMock.mockResolvedValue(ok({ customers: [], total: 0 }));

    // First click: switch to phone ASC.
    await userEvent.click(screen.getByTestId('customer-sort-phone'));
    await waitFor(() => expect(customerListMock).toHaveBeenCalledTimes(1));

    // Second click on the same header: flip to DESC.
    await userEvent.click(screen.getByTestId('customer-sort-phone'));
    await waitFor(() => expect(customerListMock).toHaveBeenCalledTimes(2));
    expect(customerListMock).toHaveBeenLastCalledWith({ sortBy: 'phone', sortDir: 'desc' });
  });

  it('clicking a different header resets direction to ascending', async () => {
    render(<CustomerManagement />);

    await waitFor(() => expect(customerListMock).toHaveBeenCalled());
    customerListMock.mockClear();
    customerListMock.mockResolvedValue(ok({ customers: [], total: 0 }));

    // Activate phone DESC first.
    await userEvent.click(screen.getByTestId('customer-sort-phone'));
    await userEvent.click(screen.getByTestId('customer-sort-phone'));
    await waitFor(() => expect(customerListMock).toHaveBeenCalledTimes(2));

    // Now switch to email — must come back as ASC, not inherit DESC.
    await userEvent.click(screen.getByTestId('customer-sort-email'));
    await waitFor(() => expect(customerListMock).toHaveBeenCalledTimes(3));
    expect(customerListMock).toHaveBeenLastCalledWith({ sortBy: 'email', sortDir: 'asc' });
  });
});

describe('CustomerManagement — delete confirmation', () => {
  const opensConfirmWith = async (archivedProjectCount: number) => {
    customerListMock.mockResolvedValue(
      ok({ customers: [{ id: 'c-1', name: 'Ada' } as Customer], total: 1 }),
    );
    customerGetMock.mockResolvedValue(
      ok({ id: 'c-1', name: 'Ada', archivedProjectCount } as Customer & {
        archivedProjectCount: number;
      }),
    );

    render(<CustomerManagement />);
    await userEvent.click(await screen.findByRole('button', { name: STRINGS.ui.delete }));

    await waitFor(() => expect(useConfirmStore.getState().isOpen).toBe(true));
    const { message } = useConfirmStore.getState();
    await act(async () => {
      useConfirmStore.getState().resolve(false);
    });
    return message;
  };

  it('AC-534: warns about the archived projects and names their count', async () => {
    const message = await opensConfirmWith(2);
    expect(message).toBe(STRINGS.customers.deleteWithArchived(2));
    // The customer is "Ada", so this digit can only be the count.
    expect(message).toContain('2');
  });

  it('AC-535: without archived projects, names the customer', async () => {
    expect(await opensConfirmWith(0)).toBe(STRINGS.ui.deleteConfirm('Ada'));
  });
});

describe('AC-533: CustomerManagement — archived-project count fails to load', () => {
  it('shows the error and opens no confirmation', async () => {
    customerListMock.mockResolvedValue(
      ok({ customers: [{ id: 'c-1', name: 'Ada' } as Customer], total: 1 }),
    );
    customerGetMock.mockResolvedValue({
      ok: false,
      error: { code: 'SERVER_ERROR', message: 'Laden fehlgeschlagen' },
      category: 'server_error',
      sessionExpired: false,
    });

    render(<CustomerManagement />);

    await userEvent.click(await screen.findByRole('button', { name: STRINGS.ui.delete }));

    expect(await screen.findByText('Laden fehlgeschlagen')).toBeInTheDocument();
    expect(customerGetMock).toHaveBeenCalledTimes(1);
    expect(useConfirmStore.getState().isOpen).toBe(false);
  });
});

describe('CustomerManagement — address group and optional fields', () => {
  const STORED: Customer = {
    id: 'c-1',
    name: 'Ada',
    phone: null,
    email: null,
    address: { street: 'Hauptstr. 1', zip: '50667', city: 'Köln' },
    ustId: 'DE123456789',
    notes: 'Kontakt über Empfehlung',
    version: 3,
    createdAt: '2026-03-30T00:00:00Z',
    updatedAt: '2026-03-30T00:00:00Z',
    createdBy: null,
    updatedBy: null,
  };

  const openCreate = async () => {
    render(<CustomerManagement />);
    await userEvent.click(screen.getByTestId('customer-create-button'));
    await userEvent.type(screen.getByTestId('customer-name-input'), 'Neu');
  };

  const openEdit = async () => {
    customerListMock.mockResolvedValue(ok({ customers: [STORED], total: 1 }));
    render(<CustomerManagement />);
    await userEvent.click(await screen.findByText('Ada'));
  };

  it('AC-521: the create form names a partial address and sends nothing', async () => {
    await openCreate();
    await userEvent.type(screen.getByTestId('customer-city-input'), 'Köln');
    await userEvent.click(screen.getByTestId('customer-submit'));

    expect(await screen.findByText(STRINGS.customers.addressPartial)).toBeInTheDocument();
    expect(customerCreateMock).not.toHaveBeenCalled();
  });

  it('AC-521: the edit form names a partial address and sends nothing', async () => {
    await openEdit();
    await userEvent.clear(screen.getByTestId('customer-zip-input'));
    await userEvent.click(screen.getByTestId('customer-save'));

    expect(await screen.findByText(STRINGS.customers.addressPartial)).toBeInTheDocument();
    expect(customerApi.update).not.toHaveBeenCalled();
  });

  it('data-model.md §5.6: an address group of only whitespace stays no address', async () => {
    customerCreateMock.mockResolvedValueOnce(ok({ id: 'srv-1', name: 'Neu' } as Customer));
    await openCreate();
    await userEvent.type(screen.getByTestId('customer-street-input'), '   ');
    await userEvent.click(screen.getByTestId('customer-submit'));

    await waitFor(() => expect(customerCreateMock).toHaveBeenCalledTimes(1));
    expect(customerCreateMock).toHaveBeenCalledWith(expect.objectContaining({ address: null }));
  });

  it('AC-522: the create form sends USt-IdNr. and notes', async () => {
    customerCreateMock.mockResolvedValueOnce(ok({ id: 'srv-1', name: 'Neu' } as Customer));
    await openCreate();
    await userEvent.type(screen.getByTestId('customer-ustid-input'), ' DE123456789 ');
    await userEvent.type(screen.getByTestId('customer-notes-input'), 'Hinterhof');
    await userEvent.click(screen.getByTestId('customer-submit'));

    await waitFor(() => expect(customerCreateMock).toHaveBeenCalledTimes(1));
    expect(customerCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ ustId: 'DE123456789', notes: 'Hinterhof' }),
    );
  });

  it('AC-522: the edit form shows USt-IdNr. and notes and saves them back unchanged', async () => {
    vi.mocked(customerApi.update).mockResolvedValue(ok(STORED));
    await openEdit();

    expect(screen.getByTestId('customer-ustid-input')).toHaveValue('DE123456789');
    expect(screen.getByTestId('customer-notes-input')).toHaveValue('Kontakt über Empfehlung');
    await userEvent.click(screen.getByTestId('customer-save'));

    await waitFor(() => expect(customerApi.update).toHaveBeenCalledTimes(1));
    expect(customerApi.update).toHaveBeenCalledWith(
      'c-1',
      3,
      expect.objectContaining({ ustId: 'DE123456789', notes: 'Kontakt über Empfehlung' }),
    );
  });

  it('AC-519: an emptied USt-IdNr. or notes becomes empty', async () => {
    vi.mocked(customerApi.update).mockResolvedValue(ok(STORED));
    await openEdit();
    await userEvent.clear(screen.getByTestId('customer-ustid-input'));
    await userEvent.clear(screen.getByTestId('customer-notes-input'));
    await userEvent.click(screen.getByTestId('customer-save'));

    await waitFor(() => expect(customerApi.update).toHaveBeenCalledTimes(1));
    expect(customerApi.update).toHaveBeenCalledWith(
      'c-1',
      3,
      expect.objectContaining({ ustId: null, notes: null }),
    );
  });
});

describe('CustomerManagement — stale write', () => {
  it('data-model.md §6.4: resets USt-IdNr. and notes to the refetched customer', async () => {
    const stored = {
      id: 'c-1',
      name: 'Ada',
      phone: null,
      email: null,
      address: null,
      ustId: 'DE111111111',
      notes: 'Alt',
      version: 1,
    } as Customer;
    customerListMock.mockResolvedValue(ok({ customers: [stored], total: 1 }));
    vi.mocked(customerApi.update).mockResolvedValue({
      ok: false,
      error: { code: 'VERSION_CONFLICT', message: 'Veraltet' },
      category: 'server_error',
      sessionExpired: false,
    });
    customerGetMock.mockResolvedValue(
      ok({ ...stored, ustId: 'DE222222222', notes: 'Neu', version: 2 }),
    );

    render(<CustomerManagement />);
    await userEvent.click(await screen.findByText('Ada'));
    await userEvent.click(screen.getByTestId('customer-save'));

    await waitFor(() =>
      expect(screen.getByTestId('customer-ustid-input')).toHaveValue('DE222222222'),
    );
    expect(screen.getByTestId('customer-notes-input')).toHaveValue('Neu');
  });
});

describe('CustomerManagement — IDEMPOTENCY_CONFLICT', () => {
  it('closes the create form and refreshes the list', async () => {
    customerCreateMock.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'Diese Anfrage-ID wurde bereits mit abweichenden Daten verwendet.',
      },
      category: 'server_error',
      sessionExpired: false,
    });
    customerListMock.mockResolvedValue(
      ok({
        customers: [{ id: 'c-1', name: 'Already Here' } as Customer],
        total: 1,
      }),
    );

    render(<CustomerManagement />);

    await userEvent.click(screen.getByTestId('customer-create-button'));
    await userEvent.type(screen.getByTestId('customer-name-input'), 'Xyz');
    await userEvent.click(screen.getByTestId('customer-submit'));

    await waitFor(() => {
      expect(screen.queryByTestId('customer-submit')).not.toBeInTheDocument();
    });
    expect(
      screen.getByText('Diese Anfrage-ID wurde bereits mit abweichenden Daten verwendet.'),
    ).toBeInTheDocument();
  });
});
