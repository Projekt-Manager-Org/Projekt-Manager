/**
 * Branding surfaces in the page (AC-743): the header wordmark, the login
 * heading and the footer brand line follow the configured values. The
 * mocked branding differs from the shipped default, so a hardcoded
 * literal fails here instead of coinciding with it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AuthUser } from '@/api/client';

vi.mock('@/config/brandingConfig', async (importActual) => {
  const actual = (await importActual()) as typeof import('@/config/brandingConfig');
  return {
    ...actual,
    BRANDING: {
      ...actual.BRANDING,
      appName: 'Malerei Muster',
      footerBrandLine: 'Malerei Muster GmbH',
    },
  };
});

vi.mock('@/state/extractionActions', () => ({
  fetchExtractionConfigured: vi.fn(() => Promise.resolve(false)),
}));

const { useAuthStore } = await import('@/state/authStore');
const { Header } = await import('@/ui/layout/Header');
const { Footer } = await import('@/ui/layout/Footer');
const { LoginForm } = await import('@/ui/auth/LoginForm');

function signIn(): void {
  const user: AuthUser = {
    id: 'u-1',
    username: 'test',
    displayName: 'Test User',
    // No data:export: the footer renders no storage badge and fetches nothing.
    roles: ['worker'],
    email: null,
    themePreference: 'system',
    pushMuted: false,
  };
  useAuthStore.setState({ authUser: user, authError: null, sessionChecked: true });
}

describe('AC-743: branding values reach their page surfaces', () => {
  beforeEach(() => {
    useAuthStore.setState({ authUser: null, authError: null, sessionChecked: true });
  });

  it('AC-743: the header wordmark shows the configured app name', () => {
    signIn();
    render(<Header />);
    expect(screen.getByText('Malerei Muster')).toBeInTheDocument();
  });

  it('AC-743: the login heading shows the configured app name', () => {
    render(<LoginForm />);
    expect(screen.getByRole('heading', { name: 'Malerei Muster' })).toBeInTheDocument();
  });

  it('AC-743: the footer shows the configured footer brand line', () => {
    signIn();
    render(<Footer />);
    expect(screen.getByText('Malerei Muster GmbH')).toBeInTheDocument();
  });
});
