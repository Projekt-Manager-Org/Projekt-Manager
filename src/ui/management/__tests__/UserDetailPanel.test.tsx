/**
 * AC-759: Enter in the reset-password sub-form submits the reset.
 * AC-754: after a failed email save, the panel shows the stored email.
 * The API client is stubbed at the module boundary; real stores run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { User } from '@/domain/types';

const resetPasswordMock = vi.fn();
const updateMock = vi.fn();

vi.mock('@/api/client', () => ({
  userApi: {
    resetPassword: (...args: unknown[]) => resetPasswordMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
  },
}));

const { UserDetailPanel } = await import('@/ui/management/UserDetailPanel');
const { useAuthStore } = await import('@/state/authStore');

const target: User = {
  id: 'u-2',
  username: 'monteur',
  displayName: 'Monteur',
  roles: ['worker'],
  email: 'alt@firma.de',
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
  updateMock.mockReset();
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

  it('AC-754: a failed email save shows the stored email', async () => {
    updateMock.mockResolvedValue({
      ok: false,
      error: { code: 'NETWORK_ERROR', message: 'Speichern fehlgeschlagen' },
      category: 'network',
      sessionExpired: false,
    });
    const user = userEvent.setup();
    render(<UserDetailPanel user={target} onClose={vi.fn()} />);

    const input = screen.getByTestId('user-email-input');
    await user.clear(input);
    await user.type(input, 'neu@firma.de');
    await user.tab();

    expect(updateMock).toHaveBeenCalledWith('u-2', { email: 'neu@firma.de' });
    expect(await screen.findByText('Speichern fehlgeschlagen')).toBeInTheDocument();
    expect(input).toHaveValue('alt@firma.de');
  });
});
