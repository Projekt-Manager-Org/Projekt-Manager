/**
 * Store-level behavior for the IDEMPOTENCY_CONFLICT response.
 *
 * Covers:
 *   - customerStore.createCustomer returns `{ status: 'conflict' }` and
 *     triggers a list refresh when the API returns IDEMPOTENCY_CONFLICT.
 *   - projectManagementStore.createProject does the same.
 *
 * The API client is stubbed so no network is needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiResult } from '@/api/client';
import type { Customer, Project } from '@/domain/types';

type CustomerCreateResult = ApiResult<Customer>;
type CustomerListResult = ApiResult<{ customers: Customer[]; total: number }>;
type ProjectCreateResult = ApiResult<Project>;
type ProjectListResult = ApiResult<{ data: Project[]; total: number }>;

const customerCreateMock = vi.fn<() => Promise<CustomerCreateResult>>();
const customerListMock = vi.fn<() => Promise<CustomerListResult>>();
const projectCreateMock = vi.fn<() => Promise<ProjectCreateResult>>();
const projectListMock = vi.fn<() => Promise<ProjectListResult>>();

vi.mock('@/api/client', () => ({
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
    delete: vi.fn(),
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

const { useCustomerStore } = await import('@/state/customerStore');
const { useProjectManagementStore } = await import('@/state/projectManagementStore');

function conflictResult<T>(): ApiResult<T> {
  return {
    ok: false,
    error: {
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'Diese Anfrage-ID wurde bereits mit abweichenden Daten verwendet.',
    },
    category: 'server_error',
    sessionExpired: false,
  };
}

describe('customerStore.createCustomer on IDEMPOTENCY_CONFLICT', () => {
  beforeEach(() => {
    useCustomerStore.setState({ customers: [], total: 0, loading: false, error: null });
    customerCreateMock.mockReset();
    customerListMock.mockReset();
    customerListMock.mockResolvedValue({
      ok: true,
      data: {
        customers: [
          {
            id: 'c-1',
            name: 'Existing',
            phone: null,
            email: null,
            address: null,
            notes: null,
          } as Customer,
        ],
        total: 1,
      },
    });
  });

  it('returns status=conflict, sets error, and refreshes the list', async () => {
    customerCreateMock.mockResolvedValueOnce(conflictResult<Customer>());

    const outcome = await useCustomerStore
      .getState()
      .createCustomer({ id: 'fake-uuid', name: 'x' });

    expect(outcome).toEqual({ status: 'conflict' });
    expect(customerListMock).toHaveBeenCalledTimes(1);
    const state = useCustomerStore.getState();
    expect(state.customers).toHaveLength(1);
    expect(state.error).toBe('Diese Anfrage-ID wurde bereits mit abweichenden Daten verwendet.');
  });

  it('passes through the client-supplied id to the API call', async () => {
    customerCreateMock.mockResolvedValueOnce({
      ok: true,
      data: { id: 'abc', name: 'x' } as Customer,
    });
    await useCustomerStore.getState().createCustomer({ id: 'abc', name: 'x' });
    expect(customerCreateMock).toHaveBeenCalledWith({ id: 'abc', name: 'x' });
  });
});

describe('projectManagementStore.createProject on IDEMPOTENCY_CONFLICT', () => {
  beforeEach(() => {
    useProjectManagementStore.setState({
      projects: [],
      customers: [],
      loading: false,
      error: null,
    });
    projectCreateMock.mockReset();
    projectListMock.mockReset();
    projectListMock.mockResolvedValue({
      ok: true,
      data: { data: [], total: 0 },
    });
  });

  it('returns status=conflict, sets error, and refreshes the list', async () => {
    projectCreateMock.mockResolvedValueOnce(conflictResult<Project>());

    const outcome = await useProjectManagementStore.getState().createProject({
      id: 'fake-uuid',
      number: 'P-1',
      title: 't',
      customerId: 'c-1',
    });

    expect(outcome).toEqual({ status: 'conflict' });
    expect(projectListMock).toHaveBeenCalled();
    expect(useProjectManagementStore.getState().error).toBe(
      'Diese Anfrage-ID wurde bereits mit abweichenden Daten verwendet.',
    );
  });

  it('passes through the client-supplied id to the API call', async () => {
    projectCreateMock.mockResolvedValueOnce({
      ok: true,
      data: { id: 'abc' } as Project,
    });
    await useProjectManagementStore.getState().createProject({
      id: 'abc',
      number: 'P-1',
      title: 't',
      customerId: 'c-1',
    });
    expect(projectCreateMock).toHaveBeenCalledWith({
      id: 'abc',
      number: 'P-1',
      title: 't',
      customerId: 'c-1',
    });
  });
});

describe('searchCustomers / searchProjects actions', () => {
  beforeEach(() => {
    customerListMock.mockReset();
    projectListMock.mockReset();
  });

  it('searchCustomers returns customers on success', async () => {
    customerListMock.mockResolvedValueOnce({
      ok: true,
      data: {
        customers: [{ id: 'c-1', name: 'Ada' } as Customer],
        total: 1,
      },
    });
    const result = await useCustomerStore.getState().searchCustomers('Ada');
    expect(result).toHaveLength(1);
    expect(customerListMock).toHaveBeenCalledWith({ search: 'Ada' });
  });

  it('searchCustomers short-circuits on empty/whitespace input', async () => {
    const result = await useCustomerStore.getState().searchCustomers('   ');
    expect(result).toEqual([]);
    expect(customerListMock).not.toHaveBeenCalled();
  });

  it('searchProjects asks for archived projects too (AC-478)', async () => {
    projectListMock.mockResolvedValueOnce({
      ok: true,
      data: { data: [{ id: 'p-1', number: 'P-1' } as Project], total: 1 },
    });
    const result = await useProjectManagementStore.getState().searchProjects('P-1');
    expect(result).toHaveLength(1);
    expect(projectListMock).toHaveBeenCalledWith({ search: 'P-1', includeArchived: true });
  });

  it('searchProjects short-circuits on empty input', async () => {
    const result = await useProjectManagementStore.getState().searchProjects('');
    expect(result).toEqual([]);
    expect(projectListMock).not.toHaveBeenCalled();
  });
});
