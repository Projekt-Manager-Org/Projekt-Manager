/**
 * Header component test — verifies the per-role nav buttons render
 * exactly per the central route table (AC-75).
 *
 * Why this test exists even though `src/config/__tests__/routes.test.ts`
 * already pins the matrix at the table level: if a future refactor
 * reintroduces a hardcoded nav list in `Header.tsx` that _happens_ to
 * match the matrix for 3 of 4 roles, the table test still passes. This
 * component-level assertion catches that drift by rendering the real
 * Header and asserting on the DOM.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import type { AuthUser } from '@/api/client';

// The extraction status is server state (AC-734); each test sets the answer.
vi.mock('@/state/extractionActions', () => ({
  fetchExtractionConfigured: vi.fn(),
}));
const { fetchExtractionConfigured } = await import('@/state/extractionActions');
const mockFetchExtractionConfigured = vi.mocked(fetchExtractionConfigured);

const { useAuthStore } = await import('@/state/authStore');
const { Header } = await import('@/ui/layout/Header');

function setAuthUser(roles: string[]): void {
  const user: AuthUser = {
    id: 'u-1',
    username: 'test',
    displayName: 'Test User',
    roles,
    email: null,
    themePreference: 'system',
    pushMuted: false,
  };
  useAuthStore.setState({
    authUser: user,
    authError: null,
    sessionChecked: true,
  });
}

// Expected nav affordances per role — primary + secondary combined.
// `rechnungen` (invoice:read) — owner / office surface it via Verwaltung;
// bookkeeper renders it inline (only secondary entry → menu suppressed).
const MATRIX: Record<string, readonly string[]> = {
  owner: [
    'kanban',
    'kalender',
    'projekte',
    'kunden',
    'rechnungen',
    'benutzer',
    'daten',
    'aktivitaet',
  ],
  office: ['kanban', 'kalender', 'projekte', 'kunden', 'rechnungen', 'daten', 'aktivitaet'],
  worker: ['kanban', 'kalender'],
  bookkeeper: ['projekte', 'kunden', 'rechnungen'],
};

// Roles whose secondary bucket has ≥2 items — those get the "Verwaltung"
// menu trigger. Others render their (zero or one) secondary routes
// inline, so no trigger is rendered. Bookkeeper has only `rechnungen` in
// its secondary bucket, so no menu — see the SECONDARY_VIEWS rationale
// in src/config/routes.ts.
const ROLES_WITH_ADMIN_MENU = new Set(['owner', 'office']);

const ALL_VIEWS = [
  'kanban',
  'kalender',
  'projekte',
  'kunden',
  'rechnungen',
  'benutzer',
  'daten',
  'aktivitaet',
] as const;

beforeEach(() => {
  mockFetchExtractionConfigured.mockReset();
  mockFetchExtractionConfigured.mockResolvedValue(true);
  useAuthStore.setState({
    authUser: null,
    authError: null,
    sessionChecked: true,
  });
});

describe('Header — per-role nav visibility (AC-75)', () => {
  for (const role of Object.keys(MATRIX)) {
    it(`renders exactly the matrix nav for role '${role}'`, () => {
      setAuthUser([role]);
      render(<Header />);

      // Open the admin menu if this role has one, so its menu items
      // are mounted and queryable.
      if (ROLES_WITH_ADMIN_MENU.has(role)) {
        fireEvent.click(screen.getByTestId('nav-admin-trigger'));
      } else {
        expect(screen.queryByTestId('nav-admin-trigger')).not.toBeInTheDocument();
      }

      // Every view in the matrix is rendered as a button (either inline
      // or inside the now-open admin menu).
      for (const view of MATRIX[role]) {
        expect(screen.queryByTestId(`view-toggle-${view}`)).toBeInTheDocument();
      }

      // No other view is rendered.
      const forbidden = ALL_VIEWS.filter((v) => !MATRIX[role].includes(v));
      for (const view of forbidden) {
        expect(screen.queryByTestId(`view-toggle-${view}`)).not.toBeInTheDocument();
      }
    });
  }
});

describe('Header — email intake entry (AC-734)', () => {
  it('AC-734: shows the email intake entry to a customer:write holder while extraction is configured', async () => {
    setAuthUser(['office']);
    render(<Header />);

    expect(await screen.findByTestId('extract-button')).toBeInTheDocument();
  });

  it('AC-734: shows no email intake entry while extraction is not configured', async () => {
    mockFetchExtractionConfigured.mockResolvedValue(false);
    setAuthUser(['office']);
    render(<Header />);

    await waitFor(() => expect(mockFetchExtractionConfigured).toHaveBeenCalled());
    // Let the resolved status commit before asserting the absence.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('extract-button')).not.toBeInTheDocument();
  });

  it('AC-121: asks for no extraction status without customer:write', () => {
    setAuthUser(['worker']);
    render(<Header />);

    expect(mockFetchExtractionConfigured).not.toHaveBeenCalled();
    expect(screen.queryByTestId('extract-button')).not.toBeInTheDocument();
  });
});
