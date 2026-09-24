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
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import type { AuthUser } from '@/api/client';

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
// Worker deliberately excludes `aktivitaet`: the permission is retained
// (deep-link and server-side scoping still work), but the tab is not
// surfaced because worker-visible rows are too narrow to justify the
// nav slot (see Header.tsx comment + docs/spec/ui/index.md §8.7.1 note).
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
