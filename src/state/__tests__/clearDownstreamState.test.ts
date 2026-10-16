/**
 * Logout/session-expiry cleanup — `authStore.clearDownstreamState()`
 * resets payload data AND the management surfaces' filter/sort/search
 * state, so user A's view does not bleed into user B's first paint on
 * the same browser.
 *
 * The function itself is module-private; we exercise it through the
 * two paths that call it: `logout()` and `handleSessionExpired()`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiResult } from '@/api/client';

const logoutMock = vi.fn<() => Promise<ApiResult<void>>>();

vi.mock('@/api/client', () => ({
  authApi: {
    me: vi.fn().mockResolvedValue({ ok: false }),
    login: vi.fn(),
    logout: () => logoutMock(),
    changePassword: vi.fn(),
    updateSelf: vi.fn(),
  },
  projectApi: {
    list: vi.fn().mockResolvedValue({ ok: true, data: { data: [] } }),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    purge: vi.fn(),
    restore: vi.fn(),
    updateDates: vi.fn(),
    transitionForward: vi.fn(),
    transitionBackward: vi.fn(),
    get: vi.fn(),
  },
  customerApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), get: vi.fn() },
  workerApi: { list: vi.fn() },
  userApi: { list: vi.fn() },
}));

const { useAuthStore } = await import('@/state/authStore');
const { useCustomerStore } = await import('@/state/customerStore');
const { useProjectManagementStore } = await import('@/state/projectManagementStore');
const { useProjectStore } = await import('@/state/projectStore');
const { useUIStore } = await import('@/state/uiStore');
const { useExportJobStore } = await import('@/state/exportJobStore');
const { useImportJobStore } = await import('@/state/importJobStore');

function seedDirtyState(): void {
  // Payload + filter state across every downstream surface.
  useProjectStore.setState({
    projects: [{ id: 'p-1' } as never],
    mutationInFlight: { 'p-1': true },
    mutationError: 'stale',
  });
  useUIStore.setState({
    selectedProjectId: 'p-1',
    filterNoDates: true,
    activeView: 'kalender',
  });
  useCustomerStore.setState({
    customers: [{ id: 'c-1', name: 'Ada' } as never],
    total: 1,
    loading: true,
    error: 'stale',
    search: 'Müller',
    sortBy: 'city',
    sortDir: 'desc',
  });
  useProjectManagementStore.setState({
    projects: [{ id: 'p-1' } as never],
    customers: [{ id: 'c-1' } as never],
    workers: [{ userId: 'u-1', displayName: 'Anna' }],
    loading: true,
    error: 'stale',
    showArchived: true,
    assignedWorkerIds: ['u-1'],
    includeUnassigned: true,
    search: 'abc',
    sortBy: 'title',
    sortDir: 'desc',
  });
  // Data-exchange job stores: a prior operator's terminal export/import job +
  // the dismissed-job marker must not bleed into the next operator's tab.
  useExportJobStore.setState({ job: { id: 'e-1', status: 'ready' } as never });
  useImportJobStore.setState({
    job: { id: 'i-1', status: 'ready' } as never,
    uploadOffset: 4096,
    createError: 'target_not_empty',
    dismissedJobId: 'i-0',
  });
}

function expectJobStoresCleared(): void {
  expect(useExportJobStore.getState().job).toBeNull();
  const imp = useImportJobStore.getState();
  expect(imp.job).toBeNull();
  expect(imp.uploadOffset).toBe(0);
  expect(imp.createError).toBeNull();
  expect(imp.dismissedJobId).toBeNull();
}

beforeEach(() => {
  logoutMock.mockReset();
  logoutMock.mockResolvedValue({ ok: true, data: undefined as never });
});

describe('clearDownstreamState — interactive logout', () => {
  it('resets payload AND filter state across every downstream store', async () => {
    seedDirtyState();
    await useAuthStore.getState().logout();

    expect(useProjectStore.getState().projects).toEqual([]);
    expect(useProjectStore.getState().mutationInFlight).toEqual({});
    expect(useProjectStore.getState().mutationError).toBeNull();

    expect(useUIStore.getState().selectedProjectId).toBeNull();
    expect(useUIStore.getState().filterNoDates).toBe(false);
    expect(useUIStore.getState().activeView).toBe('kanban');

    expect(useCustomerStore.getState().customers).toEqual([]);
    expect(useCustomerStore.getState().total).toBe(0);
    expect(useCustomerStore.getState().error).toBeNull();
    expect(useCustomerStore.getState().search).toBe('');
    expect(useCustomerStore.getState().sortBy).toBe('name');
    expect(useCustomerStore.getState().sortDir).toBe('asc');

    const mgmt = useProjectManagementStore.getState();
    expect(mgmt.projects).toEqual([]);
    expect(mgmt.customers).toEqual([]);
    expect(mgmt.workers).toEqual([]);
    expect(mgmt.error).toBeNull();
    expect(mgmt.showArchived).toBe(false);
    expect(mgmt.assignedWorkerIds).toEqual([]);
    expect(mgmt.includeUnassigned).toBe(false);
    expect(mgmt.search).toBe('');
    expect(mgmt.sortBy).toBeNull();
    expect(mgmt.sortDir).toBe('asc');

    expectJobStoresCleared();
  });
});

describe('clearDownstreamState — mid-session expiry', () => {
  it('resets the same surfaces when handleSessionExpired fires (no logout API call)', () => {
    seedDirtyState();
    useAuthStore.getState().handleSessionExpired();

    // The session-expired path does NOT hit the logout endpoint — the
    // server already considers the session dead. Cleanup must still
    // happen client-side.
    expect(logoutMock).not.toHaveBeenCalled();

    expect(useCustomerStore.getState().search).toBe('');
    expect(useCustomerStore.getState().sortBy).toBe('name');

    const mgmt = useProjectManagementStore.getState();
    expect(mgmt.showArchived).toBe(false);
    expect(mgmt.assignedWorkerIds).toEqual([]);
    expect(mgmt.search).toBe('');
    expect(mgmt.sortBy).toBeNull();

    expectJobStoresCleared();
  });
});
