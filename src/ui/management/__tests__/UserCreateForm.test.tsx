/**
 * AC-63: the create form sends the password as typed. Login sends it
 * untrimmed, so a trimmed one would lock out a password with leading or
 * trailing spaces. The API client is stubbed at the module boundary.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const userCreateMock = vi.fn();

vi.mock('@/api/client', () => ({
  userApi: {
    create: (...args: unknown[]) => userCreateMock(...args),
    list: vi.fn().mockResolvedValue({ ok: true, data: { users: [], total: 0 } }),
  },
}));

const { UserCreateForm } = await import('@/ui/management/UserCreateForm');

describe('UserCreateForm', () => {
  it('AC-63: sends the password with its leading and trailing spaces', async () => {
    userCreateMock.mockResolvedValue({ ok: true, data: {} });
    const user = userEvent.setup();
    render(<UserCreateForm onClose={vi.fn()} />);

    await user.type(screen.getByTestId('user-username-input'), 'neu');
    await user.type(screen.getByTestId('user-displayname-input'), 'Neu');
    await user.type(screen.getByTestId('user-password-input'), ' Lange Passphrase ');
    await user.type(screen.getByTestId('user-password-confirm-input'), ' Lange Passphrase ');
    await user.click(screen.getByTestId('user-role-worker'));
    await user.click(screen.getByTestId('user-submit'));

    expect(userCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ password: ' Lange Passphrase ' }),
    );
  });
});
