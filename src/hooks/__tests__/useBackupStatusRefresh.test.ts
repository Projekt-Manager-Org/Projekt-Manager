/**
 * Behaviour tests for useBackupStatusRefresh — the piece that keeps
 * the owner badge fresh between full reloads (AC-615).
 *
 * Covers:
 *   - non-owner: no polling, no visibility handler (zero calls)
 *   - owner: 60s interval calls checkSession while visible
 *   - owner: hidden tab suppresses the call, visible resumes it
 *   - owner: visibilitychange -> visible triggers an immediate refresh
 *   - cleanup on unmount clears the interval + listener
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('@/api/client', () => ({
  authApi: { me: vi.fn().mockResolvedValue({ ok: false }) },
}));

const { useBackupStatusRefresh } = await import('@/hooks/useBackupStatusRefresh');
const { useAuthStore } = await import('@/state/authStore');

function setAuthUser(roles: string[] | null) {
  useAuthStore.setState({
    authUser: roles
      ? {
          id: 'u-1',
          username: 'u',
          displayName: 'u',
          roles,
          email: null,
          themePreference: 'system',
          pushMuted: false,
        }
      : null,
  });
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
}

describe('useBackupStatusRefresh', () => {
  let checkSession: ReturnType<typeof vi.fn<() => Promise<void>>>;

  beforeEach(() => {
    vi.useFakeTimers();
    setHidden(false);
    // Replace checkSession with a spy so we can assert call counts without
    // touching the real /me path (mocked above to reject anyway).
    checkSession = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    useAuthStore.setState({ checkSession });
  });

  afterEach(() => {
    vi.useRealTimers();
    setAuthUser(null);
  });

  it('does nothing when the user is not authenticated', () => {
    setAuthUser(null);
    renderHook(() => useBackupStatusRefresh());
    vi.advanceTimersByTime(180_000);
    expect(checkSession).not.toHaveBeenCalled();
  });

  it('does nothing for a non-owner user', () => {
    setAuthUser(['office']);
    renderHook(() => useBackupStatusRefresh());
    vi.advanceTimersByTime(180_000);
    expect(checkSession).not.toHaveBeenCalled();
  });

  it('polls /me every 60s for owner while the tab is visible', () => {
    setAuthUser(['owner']);
    renderHook(() => useBackupStatusRefresh());
    expect(checkSession).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(checkSession).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(checkSession).toHaveBeenCalledTimes(2);
  });

  it('suppresses polling while the tab is hidden', () => {
    setAuthUser(['owner']);
    renderHook(() => useBackupStatusRefresh());
    setHidden(true);
    vi.advanceTimersByTime(180_000);
    expect(checkSession).not.toHaveBeenCalled();
    setHidden(false);
    vi.advanceTimersByTime(60_000);
    expect(checkSession).toHaveBeenCalledTimes(1);
  });

  it('refreshes once on visibilitychange when the tab becomes visible', () => {
    setAuthUser(['owner']);
    renderHook(() => useBackupStatusRefresh());
    setHidden(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(checkSession).not.toHaveBeenCalled();
    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(checkSession).toHaveBeenCalledTimes(1);
  });

  it('clears the interval and listener on unmount', () => {
    setAuthUser(['owner']);
    const { unmount } = renderHook(() => useBackupStatusRefresh());
    unmount();
    vi.advanceTimersByTime(180_000);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(checkSession).not.toHaveBeenCalled();
  });
});
