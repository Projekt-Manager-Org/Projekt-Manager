/**
 * AssignedWorkerEditor — inline worker-chip editor on the project
 * detail page (spec §8.15.3, AC-209 + AC-210).
 *
 * The control shows the current assigned workers as chips, lets callers
 * with `project:update` add or remove workers, and is hidden as a
 * whole for callers without `project:update`. Each add/remove
 * dispatches the Update project operation with an `assignedWorkerIds`
 * patch; a failed mutation reverts the optimistic chip set per
 * behavior.md §9.5.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiResult } from '@/api/client';
import type { Project, User } from '@/domain/types';

type ProjectUpdateResult = ApiResult<Project>;
type UserListResult = ApiResult<{ users: User[]; total: number }>;

type ProjectUpdatePatch = {
  title?: string;
  customerId?: string;
  assignedWorkerIds?: string[];
  estimatedValue?: number | null;
  notes?: string | null;
};

const updateMock = vi.fn<(id: string, data: ProjectUpdatePatch) => Promise<ProjectUpdateResult>>();
const userListMock =
  vi.fn<(params?: { offset?: number; limit?: number }) => Promise<UserListResult>>();

vi.mock('@/api/client', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    projectApi: {
      list: vi.fn().mockResolvedValue({ ok: true, data: { data: [], total: 0 } }),
      get: vi.fn(),
      update: (...args: unknown[]) => updateMock(...(args as Parameters<typeof updateMock>)),
      create: vi.fn(),
      updateDates: vi.fn(),
      delete: vi.fn(),
      transitionForward: vi.fn(),
      transitionBackward: vi.fn(),
    },
    userApi: {
      list: (...args: unknown[]) => userListMock(...(args as Parameters<typeof userListMock>)),
    },
    customerApi: { list: vi.fn(), get: vi.fn() },
    authApi: {
      login: vi.fn(),
      logout: vi.fn(),
      me: vi.fn().mockResolvedValue({ ok: false }),
    },
  };
});

const { AssignedWorkerEditor } = await import('@/ui/detail/AssignedWorkerEditor');
const { useAuthStore } = await import('@/state/authStore');
const { useProjectStore } = await import('@/state/projectStore');

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p-42',
    number: 'P-042',
    title: 'Dachsanierung',
    status: 'geplant',
    statusChangedAt: '2026-04-01T00:00:00Z',
    plannedStart: null,
    plannedEnd: null,
    customerId: 'c-1',
    customer: null,
    siteAddress: null,
    assignedWorkers: [
      { userId: 'u-w1', displayName: 'Anna Arbeiter' },
      { userId: 'u-w2', displayName: 'Bernd Bauer' },
    ],
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

function setAuthUser(roles: string[]): void {
  useAuthStore.setState({
    authUser: {
      id: 'u-owner',
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

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

beforeEach(() => {
  updateMock.mockReset();
  userListMock.mockReset();
  userListMock.mockResolvedValue(
    ok({
      users: [
        { id: 'u-w1', username: 'anna', displayName: 'Anna Arbeiter', roles: ['worker'] } as User,
        { id: 'u-w2', username: 'bernd', displayName: 'Bernd Bauer', roles: ['worker'] } as User,
        { id: 'u-w3', username: 'carla', displayName: 'Carla Chef', roles: ['worker'] } as User,
      ],
      total: 3,
    }),
  );
  useProjectStore.setState({
    projects: [makeProject()],
    mutationInFlight: {},
    mutationError: null,
  });
});

describe('AssignedWorkerEditor — read surface', () => {
  it('renders a chip per currently assigned worker', () => {
    setAuthUser(['owner']);
    render(<AssignedWorkerEditor projectId="p-42" />);

    const chips = screen.getAllByTestId(/^worker-chip-u-/);
    expect(chips).toHaveLength(2);
    expect(chips.some((c) => c.textContent?.includes('Anna Arbeiter'))).toBe(true);
    expect(chips.some((c) => c.textContent?.includes('Bernd Bauer'))).toBe(true);
  });
});

describe('AssignedWorkerEditor — add worker (AC-209)', () => {
  it('dispatches projectApi.update with the full new assignedWorkerIds list', async () => {
    setAuthUser(['owner']);
    updateMock.mockResolvedValue(
      ok(
        makeProject({
          assignedWorkers: [
            { userId: 'u-w1', displayName: 'Anna Arbeiter' },
            { userId: 'u-w2', displayName: 'Bernd Bauer' },
            { userId: 'u-w3', displayName: 'Carla Chef' },
          ],
        }),
      ),
    );

    render(<AssignedWorkerEditor projectId="p-42" />);

    const addButton = await screen.findByTestId('worker-editor-add');
    await userEvent.click(addButton);

    // The add surface exposes Carla as the only unassigned option.
    const carlaOption = await screen.findByTestId('worker-editor-option-u-w3');
    await userEvent.click(carlaOption);

    await waitFor(() => {
      expect(updateMock).toHaveBeenCalledTimes(1);
    });
    const [projectId, patch] = updateMock.mock.calls[0] as unknown as [
      string,
      { assignedWorkerIds: string[] },
    ];
    expect(projectId).toBe('p-42');
    // The patch names the full new set — the Update project API takes a
    // replacement list, not a delta (api.md §14.2.2 + spec §8.15.3).
    expect(new Set(patch.assignedWorkerIds)).toEqual(new Set(['u-w1', 'u-w2', 'u-w3']));
  });
});

describe('AssignedWorkerEditor — remove worker (AC-209)', () => {
  it('dispatches projectApi.update with the remaining worker ids', async () => {
    setAuthUser(['owner']);
    updateMock.mockResolvedValue(
      ok(
        makeProject({
          assignedWorkers: [{ userId: 'u-w2', displayName: 'Bernd Bauer' }],
        }),
      ),
    );

    render(<AssignedWorkerEditor projectId="p-42" />);

    const removeAnna = await screen.findByTestId('worker-chip-remove-u-w1');
    await userEvent.click(removeAnna);

    await waitFor(() => {
      expect(updateMock).toHaveBeenCalledTimes(1);
    });
    const [, patch] = updateMock.mock.calls[0] as unknown as [
      string,
      { assignedWorkerIds: string[] },
    ];
    expect(patch.assignedWorkerIds).toEqual(['u-w2']);
  });
});

describe('AssignedWorkerEditor — hidden control for callers without project:update', () => {
  it('worker role sees the chip set but no add/remove controls', () => {
    // A worker holds project:read but not project:update. They can read
    // the assignment but must not see the mutation surface.
    setAuthUser(['worker']);
    render(<AssignedWorkerEditor projectId="p-42" />);

    expect(screen.getAllByTestId(/^worker-chip-u-/)).toHaveLength(2);
    expect(screen.queryByTestId('worker-editor-add')).not.toBeInTheDocument();
    expect(screen.queryByTestId(/^worker-chip-remove-/)).not.toBeInTheDocument();
  });
});

describe('AssignedWorkerEditor — optimistic revert on failure (AC-210 + §9.5)', () => {
  it('restores the original chip set when the mutation fails', async () => {
    setAuthUser(['owner']);
    updateMock.mockResolvedValue({
      ok: false,
      error: { code: 'SERVER_ERROR', message: 'Änderung fehlgeschlagen.' },
      category: 'server_error',
      sessionExpired: false,
    });

    const { container } = render(<AssignedWorkerEditor projectId="p-42" />);

    const removeAnna = await screen.findByTestId('worker-chip-remove-u-w1');
    await userEvent.click(removeAnna);

    await waitFor(() => {
      expect(updateMock).toHaveBeenCalled();
    });

    // After the failed mutation settles, the two original chips are back.
    await waitFor(() => {
      expect(within(container).getAllByTestId(/^worker-chip-u-/)).toHaveLength(2);
    });
  });
});
