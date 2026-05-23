/**
 * Suppression guard for the override-with-users import path. When the
 * text leg wipes `users` mid-import, background fetches start coming
 * back 401 and would otherwise auto-redirect to /login, unmounting the
 * dialog before its bearer-authed binary leg could run. The orchestrator
 * sets a depth-counted suppression around the binary leg and the dialog
 * fires the redirect explicitly on close.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const authStoreHandler = vi.fn();

vi.mock('../authStore', () => ({
  useAuthStore: {
    getState: () => ({ handleSessionExpired: authStoreHandler }),
  },
}));

import {
  beginSessionExpiredSuppression,
  endSessionExpiredSuppression,
  handleSessionExpired,
} from '../sessionExpired';

describe('sessionExpired suppression', () => {
  beforeEach(() => {
    authStoreHandler.mockReset();
  });

  it('delegates to the auth store when not suppressed', () => {
    handleSessionExpired();
    expect(authStoreHandler).toHaveBeenCalledTimes(1);
  });

  it('no-ops while suppression is active', () => {
    beginSessionExpiredSuppression();
    handleSessionExpired();
    handleSessionExpired();
    expect(authStoreHandler).not.toHaveBeenCalled();
    endSessionExpiredSuppression();
  });

  it('resumes delegation once suppression ends', () => {
    beginSessionExpiredSuppression();
    handleSessionExpired();
    endSessionExpiredSuppression();
    handleSessionExpired();
    expect(authStoreHandler).toHaveBeenCalledTimes(1);
  });

  it('is depth-counted — nested begin/end pairs balance', () => {
    beginSessionExpiredSuppression();
    beginSessionExpiredSuppression();
    endSessionExpiredSuppression();
    handleSessionExpired();
    expect(authStoreHandler).not.toHaveBeenCalled();
    endSessionExpiredSuppression();
    handleSessionExpired();
    expect(authStoreHandler).toHaveBeenCalledTimes(1);
  });

  it('end without begin is safe — depth floors at 0', () => {
    endSessionExpiredSuppression();
    endSessionExpiredSuppression();
    handleSessionExpired();
    expect(authStoreHandler).toHaveBeenCalledTimes(1);
  });
});
