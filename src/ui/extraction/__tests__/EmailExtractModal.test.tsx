/**
 * Component tests for the two-step save flow in EmailExtractModal.
 *
 * Covers the partial-failure retry: if customer-create succeeds but
 * project-create fails, a retry must NOT replay the customer-create
 * call (either as an idempotent replay or — worse — under a subtly
 * different body that would provoke IDEMPOTENCY_CONFLICT). The fix
 * records the returned customer id so the second attempt skips the
 * customer branch entirely.
 *
 * Also covers AC-521: extraction often yields only part of an address.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiResult, ExtractionResult } from '@/api/client';
import type { Customer, Project } from '@/domain/types';
import { STRINGS } from '@/config/strings';

type ExtractResult = ApiResult<ExtractionResult>;
type CustomerCreateResult = ApiResult<Customer>;
type ProjectCreateResult = ApiResult<Project>;

const extractMock = vi.fn<() => Promise<ExtractResult>>();
const customerListMock = vi.fn();
const customerCreateMock = vi.fn<() => Promise<CustomerCreateResult>>();
const projectCreateMock = vi.fn<() => Promise<ProjectCreateResult>>();
const projectListMock = vi.fn();

vi.mock('@/api/client', () => ({
  extractApi: {
    extract: (...args: unknown[]) => extractMock(...(args as Parameters<typeof extractMock>)),
  },
  customerApi: {
    list: (...args: unknown[]) =>
      customerListMock(...(args as Parameters<typeof customerListMock>)),
    create: (...args: unknown[]) =>
      customerCreateMock(...(args as Parameters<typeof customerCreateMock>)),
    get: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  projectApi: {
    list: (...args: unknown[]) => projectListMock(...(args as Parameters<typeof projectListMock>)),
    create: (...args: unknown[]) =>
      projectCreateMock(...(args as Parameters<typeof projectCreateMock>)),
    get: vi.fn(),
    update: vi.fn(),
    updateDates: vi.fn(),
    delete: vi.fn(),
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

const { EmailExtractModal } = await import('@/ui/extraction/EmailExtractModal');
const { useAuthStore } = await import('@/state/authStore');

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

beforeEach(() => {
  extractMock.mockReset();
  customerListMock.mockReset();
  customerCreateMock.mockReset();
  projectCreateMock.mockReset();
  projectListMock.mockReset();
  customerListMock.mockResolvedValue(ok({ customers: [], total: 0 }));
  projectListMock.mockResolvedValue(ok({ data: [], total: 0 }));
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
});

describe('EmailExtractModal — two-step save resilience', () => {
  it('does not recreate the customer when the second step fails and the user retries', async () => {
    extractMock.mockResolvedValue(
      ok({
        customer: {
          name: 'Neue Firma',
          phone: null,
          email: null,
          street: null,
          zip: null,
          city: null,
        },
        project: { title: 'Dachsanierung', description: null, siteAddress: null },
      }),
    );
    customerCreateMock.mockResolvedValueOnce(ok({ id: 'cust-1', name: 'Neue Firma' } as Customer));

    // First project-create call fails, second succeeds.
    projectCreateMock
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'SERVER_ERROR', message: 'Fehlgeschlagen' },
        category: 'server_error',
        sessionExpired: false,
      })
      .mockResolvedValueOnce(ok({ id: 'proj-1' } as Project));

    render(<EmailExtractModal onClose={() => {}} />);

    // Stage 1: extract
    await userEvent.type(
      screen.getByTestId('extract-email-input'),
      'Some email body with a request.',
    );
    await userEvent.click(screen.getByTestId('extract-submit'));

    // Stage 2: save — first attempt. Customer succeeds, project fails.
    const saveBtn = await screen.findByTestId('extract-save');
    await userEvent.click(saveBtn);

    await waitFor(() => {
      expect(customerCreateMock).toHaveBeenCalledTimes(1);
      expect(projectCreateMock).toHaveBeenCalledTimes(1);
    });

    // Error surfaced; user retries.
    expect(screen.getByText('Fehlgeschlagen')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('extract-save'));

    await waitFor(() => {
      expect(projectCreateMock).toHaveBeenCalledTimes(2);
    });
    // Customer must NOT have been re-created: the fix sets
    // selectedCustomerId after the first success, so the retry skips
    // step 1. Without the fix, the ref-backed UUID would replay the
    // create (wasted call at minimum, CONFLICT if fields drifted).
    expect(customerCreateMock).toHaveBeenCalledTimes(1);

    // And the retry's project-create used the original customer id.
    const retryCalls = projectCreateMock.mock.calls as unknown as Array<[{ customerId: string }]>;
    expect(retryCalls[1][0].customerId).toBe('cust-1');
  });
});

describe('EmailExtractModal — partial customer address', () => {
  it('AC-521: names the partial address and creates neither customer nor project', async () => {
    extractMock.mockResolvedValue(
      ok({
        customer: {
          name: 'Neue Firma',
          phone: null,
          email: null,
          street: null,
          zip: null,
          city: 'Köln',
        },
        project: { title: 'Dachsanierung', description: null, siteAddress: null },
      }),
    );

    render(<EmailExtractModal onClose={() => {}} />);
    await userEvent.type(screen.getByTestId('extract-email-input'), 'Anfrage aus Köln.');
    await userEvent.click(screen.getByTestId('extract-submit'));
    await userEvent.click(await screen.findByTestId('extract-save'));

    expect(await screen.findByText(STRINGS.customers.addressPartial)).toBeInTheDocument();
    expect(customerCreateMock).not.toHaveBeenCalled();
    expect(projectCreateMock).not.toHaveBeenCalled();
  });
});
