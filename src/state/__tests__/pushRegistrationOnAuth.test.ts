/**
 * What the auth store does to this device's push registration on
 * sign-in, sign-out, session expiry and a password change. Pins the
 * client side of AC-655, AC-676, AC-677 and AC-679 in §15.24; the server
 * side of AC-676, AC-677 and AC-679 is in `push-registration-lifecycle.test.ts`.
 * The push controls read the browser subscription when they mount, after
 * sign-in, so a subscription dropped before then shows `aktivieren`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiResult } from '@/api/client';

const logoutMock = vi.fn<() => Promise<ApiResult<void>>>();
const changePasswordMock =
  vi.fn<(current: string, next: string, pushEndpoint?: string) => Promise<ApiResult<void>>>();
const unsubscribeFromPushMock = vi.fn<() => Promise<void>>();
const dropForeignMock = vi.fn<() => Promise<void>>();
const loginMock = vi.fn();
const getCurrentSubscriptionMock = vi.fn<() => Promise<{ endpoint: string } | null>>();

vi.mock('@/api/client', () => ({
  authApi: {
    me: vi.fn().mockResolvedValue({ ok: false }),
    login: (username: string, password: string) => loginMock(username, password),
    logout: () => logoutMock(),
    changePassword: (current: string, next: string, pushEndpoint?: string) =>
      changePasswordMock(current, next, pushEndpoint),
    updateSelf: vi.fn(),
  },
  projectApi: { list: vi.fn().mockResolvedValue({ ok: true, data: { data: [] } }) },
  customerApi: { list: vi.fn() },
  workerApi: { list: vi.fn() },
  userApi: { list: vi.fn() },
}));

vi.mock('@/pwa/pushClient', () => ({
  unsubscribeFromPush: () => unsubscribeFromPushMock(),
  getCurrentSubscription: () => getCurrentSubscriptionMock(),
  dropSubscriptionNotRegisteredForUser: () => dropForeignMock(),
}));

const { useAuthStore, changePassword } = await import('@/state/authStore');

beforeEach(() => {
  logoutMock.mockReset().mockResolvedValue({ ok: true, data: undefined });
  unsubscribeFromPushMock.mockReset().mockResolvedValue(undefined);
  changePasswordMock.mockReset().mockResolvedValue({ ok: true, data: undefined });
  getCurrentSubscriptionMock.mockReset().mockResolvedValue(null);
  dropForeignMock.mockReset().mockResolvedValue(undefined);
  loginMock.mockReset();
});

describe('AC-655: signing out unregisters this device', () => {
  it('ends the session only once unregistering has finished', async () => {
    let finishUnsubscribe!: () => void;
    unsubscribeFromPushMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishUnsubscribe = resolve)),
    );

    const loggingOut = useAuthStore.getState().logout();
    await vi.waitFor(() => expect(unsubscribeFromPushMock).toHaveBeenCalledTimes(1));
    expect(logoutMock).not.toHaveBeenCalled();

    finishUnsubscribe();
    await loggingOut;
    expect(logoutMock).toHaveBeenCalledTimes(1);
  });

  it('still signs out when unregistering fails', async () => {
    unsubscribeFromPushMock.mockRejectedValueOnce(new Error('network'));
    useAuthStore.setState({ authUser: { username: 'u' } as never });

    await useAuthStore.getState().logout();

    expect(logoutMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().authUser).toBeNull();
  });
});

describe('AC-677: an expired session leaves this device registered', () => {
  it('does not unregister the device', () => {
    useAuthStore.getState().handleSessionExpired();
    expect(unsubscribeFromPushMock).not.toHaveBeenCalled();
  });
});

describe('AC-676: a password change names this device to keep', () => {
  it("sends this device's registration with the change", async () => {
    getCurrentSubscriptionMock.mockResolvedValue({ endpoint: 'https://push.example/this' });
    await changePassword('old', 'new');
    expect(changePasswordMock).toHaveBeenCalledWith('old', 'new', 'https://push.example/this');
  });

  it('sends none when this device is not registered', async () => {
    await changePassword('old', 'new');
    expect(changePasswordMock).toHaveBeenCalledWith('old', 'new', undefined);
  });
});

describe("AC-679: signing in drops a registration that is not the user's", () => {
  const signedIn = {
    ok: true,
    data: { user: { username: 'u', displayName: 'U', themePreference: 'system' } },
  };

  it('shows the signed-in user only once this device is checked', async () => {
    loginMock.mockResolvedValue(signedIn);
    let finishCheck!: () => void;
    dropForeignMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishCheck = resolve)),
    );
    useAuthStore.setState({ authUser: null });

    const signingIn = useAuthStore.getState().login('u', 'pw');
    await vi.waitFor(() => expect(dropForeignMock).toHaveBeenCalledTimes(1));
    expect(useAuthStore.getState().authUser).toBeNull();

    finishCheck();
    await signingIn;
    expect(useAuthStore.getState().authUser).not.toBeNull();
  });

  it('still signs in when the check throws', async () => {
    loginMock.mockResolvedValue(signedIn);
    dropForeignMock.mockRejectedValueOnce(new Error('unsubscribe failed'));
    useAuthStore.setState({ authUser: null });

    await useAuthStore.getState().login('u', 'pw');

    expect(useAuthStore.getState().authUser).not.toBeNull();
  });

  it('checks nothing when signing in fails', async () => {
    loginMock.mockResolvedValue({ ok: false, error: { message: 'nope' } });
    await useAuthStore.getState().login('u', 'wrong');
    expect(dropForeignMock).not.toHaveBeenCalled();
  });
});
