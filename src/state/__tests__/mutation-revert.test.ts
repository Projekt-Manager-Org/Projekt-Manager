/**
 * AC-53 [crit]: A failed mutation reverts the optimistic UI update and
 * sets a German error message.
 *
 * The projectStore applies date changes optimistically, then rolls back
 * if the API reports failure. This test exercises both the API-error and
 * the network-error revert paths without a running server — the API
 * client is the system boundary, so stubbing it is appropriate here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ApiResult } from '@/api/client';
import type { Project } from '@/domain/types';

// Stub the API client before the store imports it.
const updateDatesMock = vi.fn<() => Promise<ApiResult<Project>>>();

vi.mock('@/api/client', () => ({
  projectApi: {
    list: vi.fn().mockResolvedValue({ ok: true, data: { data: [] } }),
    updateDates: (...args: unknown[]) =>
      updateDatesMock(...(args as Parameters<typeof updateDatesMock>)),
    transitionForward: vi.fn(),
    transitionBackward: vi.fn(),
  },
  authApi: {
    login: vi.fn(),
    logout: vi.fn(),
    me: vi.fn().mockResolvedValue({ ok: false }),
    changePassword: vi.fn(),
  },
  customerApi: { list: vi.fn() },
  userApi: { list: vi.fn() },
  projectManagementApi: { list: vi.fn() },
}));

// Import after mock registration so the store picks up the stubs.
const { useProjectStore } = await import('@/state/projectStore');

const SEED_PROJECT: Project = {
  id: 'test-1',
  version: 1,
  number: 'P-001',
  title: 'Test Project',
  status: 'geplant',
  statusChangedAt: '2026-04-01T00:00:00Z',
  plannedStart: '2026-05-01',
  plannedEnd: '2026-06-01',
  createdAt: '2026-04-01T00:00:00Z',
  updatedAt: '2026-04-01T00:00:00Z',
  customerId: 'c-1',
  customer: { id: 'c-1', name: 'Testkunde', phone: null, email: null, address: null, version: 1 },
  siteAddress: null,
  assignedWorkers: [],
  estimatedValue: null,
  notes: null,
  deleted: false,
  createdBy: null,
  updatedBy: null,
};

describe('AC-53: failed mutation reverts optimistic update', () => {
  beforeEach(() => {
    // Reset store to a known state with one project.
    useProjectStore.setState({
      projects: [{ ...SEED_PROJECT }],
      mutationError: null,
      mutationInFlight: {},
    });
    updateDatesMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reverts dates when the API returns an error', async () => {
    updateDatesMock.mockResolvedValue({
      ok: false as const,
      error: { code: 'VALIDATION_ERROR', message: 'Ungültiger Zeitraum' },
      category: 'validation' as const,
      sessionExpired: false,
    });

    useProjectStore.getState().updateDates('test-1', 1, '2026-07-01', '2026-08-01');

    // Optimistic update applied immediately.
    expect(useProjectStore.getState().projects[0].plannedStart).toBe('2026-07-01');
    expect(useProjectStore.getState().projects[0].plannedEnd).toBe('2026-08-01');
    expect(useProjectStore.getState().mutationInFlight['test-1']).toBe(true);

    // Let the API promise settle.
    await vi.waitFor(() => {
      expect(useProjectStore.getState().mutationInFlight['test-1']).toBeUndefined();
    });

    // Dates reverted to originals.
    const project = useProjectStore.getState().projects[0];
    expect(project.plannedStart).toBe('2026-05-01');
    expect(project.plannedEnd).toBe('2026-06-01');

    // German error message set.
    expect(useProjectStore.getState().mutationError).toBe('Ungültiger Zeitraum');
  });

  it('reverts dates and shows German fallback on network error', async () => {
    updateDatesMock.mockRejectedValue(new Error('fetch failed'));

    useProjectStore.getState().updateDates('test-1', 1, '2026-09-01', null);

    // Let the rejection settle.
    await vi.waitFor(() => {
      expect(useProjectStore.getState().mutationInFlight['test-1']).toBeUndefined();
    });

    // Dates reverted.
    const project = useProjectStore.getState().projects[0];
    expect(project.plannedStart).toBe('2026-05-01');
    expect(project.plannedEnd).toBe('2026-06-01');

    // Fallback German error message from STRINGS.errors.mutationFailed.
    expect(useProjectStore.getState().mutationError).toBe(
      'Änderung fehlgeschlagen. Bitte erneut versuchen.',
    );
  });
});
