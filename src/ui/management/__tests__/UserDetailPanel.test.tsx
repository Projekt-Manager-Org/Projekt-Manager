/**
 * AC-759: Enter in the reset-password sub-form submits the reset.
 * The API client is stubbed at the module boundary; real stores run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { User } from '@/domain/types';

const resetPasswordMock = vi.fn();

vi.mock('@/api/client', () => ({
  userApi: {
    resetPassword: (...args: unknown[]) => resetPasswordMock(...args),
  },
}));

const { UserDetailPanel } = await import('@/ui/management/UserDetailPanel');
const { useAuthStore } = await import('@/state/authStore');

const target: User = {
  id: 'u-2',
  username: 'monteur',
  displayName: 'Monteur',
  roles: ['worker'],
  email: null,
  active: true,
  themePreference: 'system',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
  createdBy: null,
  updatedBy: null,
};

beforeEach(() => {
  resetPasswordMock.mockReset();
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

describe('UserDetailPanel', () => {
  it('AC-759: Enter in a reset-password field submits the reset', async () => {
    resetPasswordMock.mockResolvedValue({ ok: true, data: { success: true } });
    const user = userEvent.setup();
    render(<UserDetailPanel user={target} onClose={vi.fn()} />);

    await user.click(screen.getByTestId('user-reset-pw-button'));
    await user.type(screen.getByTestId('user-reset-pw-input'), 'neu-geheim');
    await user.type(screen.getByTestId('user-reset-pw-confirm'), 'neu-geheim{Enter}');

    expect(resetPasswordMock).toHaveBeenCalledWith('u-2', 'neu-geheim');
  });
});
