/**
 * Tests for useProjectTransition.inFlight covering the confirm-dialog
 * window. The store's `mutationInFlight` flag only flips once the
 * transition dispatches — so until the fix introduced a local `pending`
 * flag covering `requestConfirm`, a second click during the confirm
 * dialog would silently cancel the first (confirm store preempts) and
 * re-open a new dialog. The hook must report inFlight from the moment
 * `forward()` is called.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Project } from '@/domain/types';

vi.mock('@/api/client', () => ({
  projectApi: {
    list: vi.fn().mockResolvedValue({ ok: true, data: { data: [], total: 0 } }),
    transitionForward: vi.fn(),
    transitionBackward: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateDates: vi.fn(),
    delete: vi.fn(),
    get: vi.fn(),
  },
  authApi: {
    me: vi.fn().mockResolvedValue({ ok: false }),
    login: vi.fn(),
    logout: vi.fn(),
  },
  customerApi: { list: vi.fn() },
  userApi: { list: vi.fn() },
}));

const { useProjectTransition } = await import('@/hooks/useProjectTransition');
const { useConfirmStore } = await import('@/state/confirmStore');
const { useProjectStore } = await import('@/state/projectStore');

const baseProject: Project = {
  id: 'p-1',
  version: 1,
  number: 'P-1',
  title: 't',
  status: 'anfrage',
  statusChangedAt: '2026-04-01T00:00:00Z',
  plannedStart: null,
  plannedEnd: null,
  createdAt: '2026-04-01T00:00:00Z',
  updatedAt: '2026-04-01T00:00:00Z',
  customerId: 'c-1',
  customer: null,
  siteAddress: null,
  assignedWorkers: [],
  estimatedValue: null,
  notes: null,
  deleted: false,
  createdBy: null,
  updatedBy: null,
} as Project;

beforeEach(() => {
  useConfirmStore.setState({ isOpen: false, resolver: null, message: '' });
  useProjectStore.setState({ projects: [], mutationInFlight: {}, mutationError: null });
});

describe('useProjectTransition', () => {
  it('sets inFlight while the confirm dialog is open', async () => {
    const { result } = renderHook(() => useProjectTransition(baseProject));

    expect(result.current.inFlight).toBe(false);

    // Fire forward but do not await — the confirm promise is pending.
    act(() => {
      void result.current.forward();
    });

    await waitFor(() => expect(result.current.inFlight).toBe(true));

    // Decline: hook must reset pending even on the negative path.
    act(() => {
      useConfirmStore.getState().resolve(false);
    });

    await waitFor(() => expect(result.current.inFlight).toBe(false));
  });

  it('rejects a second call while a confirm dialog is already open', async () => {
    const transitionForwardSpy = vi.fn();
    useProjectStore.setState({ transitionForward: transitionForwardSpy });

    const { result } = renderHook(() => useProjectTransition(baseProject));

    act(() => {
      void result.current.forward();
    });
    await waitFor(() => expect(result.current.inFlight).toBe(true));

    // Second invocation while the first's confirm is pending — the
    // guard in forward() must early-return without touching the
    // confirm store. (Before the fix, this invocation would preempt
    // the first dialog, silently discarding the user's first action.)
    await act(async () => {
      await result.current.forward();
    });

    // Resolve the ORIGINAL dialog with 'proceed'.
    act(() => {
      useConfirmStore.getState().resolve(true);
    });

    // Exactly one dispatch — the first call's.
    await waitFor(() => expect(transitionForwardSpy).toHaveBeenCalledTimes(1));
  });
});
