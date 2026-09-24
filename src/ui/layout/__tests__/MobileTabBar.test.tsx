/**
 * MobileTabBar component test — verifies the phone-only bottom nav
 * renders the expected per-role primary destinations.
 *
 * Specifically pins the bookkeeper inline-Rechnungen rule
 * (`docs/spec/ui/index.md §8.7.1`, central route table
 * `src/config/routes.ts`): owner / office surface `Rechnungen` under
 * the header's Verwaltung menu, which is never part of the bottom tab
 * bar; bookkeeper's secondary bucket has only `rechnungen`, so the "≥2
 * to render a menu" rule promotes it inline alongside Projekte /
 * Kunden. Worker holds no `invoice:read` permission and the entry is
 * never offered.
 *
 * Mirrors the role-matrix pattern in `Header.test.tsx`: the source of
 * truth is `src/config/routes.ts`, so the same matrix-walk approach
 * keeps the two tests symmetric. A future refactor that reintroduces
 * hardcoded mobile-nav lists in the component (rather than reading
 * from the central table) would still need to match the per-role
 * expectations here to pass.
 *
 * Pins [AC-75] (per-role nav visibility — same matrix anchor the
 * Header component-level test pins).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AuthUser } from '@/api/client';

const { useAuthStore } = await import('@/state/authStore');
const { MobileTabBar } = await import('@/ui/layout/MobileTabBar');

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

/**
 * Per-role mobile tab matrix — primary destinations rendered as
 * bottom-bar tabs.
 *
 * Worker — Meine Projekte + Kanban + Kalender. No invoice permission;
 * Rechnungen never appears.
 *
 * Owner / office — primary nav is Kanban + Kalender + Projekte +
 * Kunden. Their secondary bucket has ≥2 entries (Verwaltung group);
 * per the component's `≥2 → render as a menu` rule, the secondary
 * entries stay in the header's Verwaltung menu, off the tab bar. So
 * `Rechnungen` is NOT in the bottom bar for owner / office on mobile.
 *
 * Bookkeeper — Projekte + Kunden + Rechnungen. Their secondary bucket
 * has exactly one entry (`rechnungen`), so the menu is suppressed and
 * the entry is inlined as a primary tab — the grouping rule in
 * `docs/spec/ui/index.md §8.7.1`.
 */
const MOBILE_TABS: Record<string, readonly string[]> = {
  owner: ['kanban', 'kalender', 'projekte', 'kunden'],
  office: ['kanban', 'kalender', 'projekte', 'kunden'],
  worker: ['meineProjekte', 'kanban', 'kalender'],
  bookkeeper: ['projekte', 'kunden', 'rechnungen'],
};

// All views the icon map knows about — used to assert the disallowed
// views are NOT rendered for any given role.
const ALL_MOBILE_VIEWS = [
  'meineProjekte',
  'kanban',
  'kalender',
  'projekte',
  'kunden',
  'rechnungen',
] as const;

beforeEach(() => {
  useAuthStore.setState({
    authUser: null,
    authError: null,
    sessionChecked: true,
  });
});

describe('MobileTabBar — per-role primary-tab visibility (AC-75)', () => {
  for (const role of Object.keys(MOBILE_TABS)) {
    it(`renders exactly the mobile primary tabs for role '${role}'`, () => {
      setAuthUser([role]);
      render(<MobileTabBar />);

      const bar = screen.getByTestId('mobile-tab-bar');
      expect(bar).toBeInTheDocument();

      for (const view of MOBILE_TABS[role]) {
        expect(screen.queryByTestId(`tab-bar-${view}`)).toBeInTheDocument();
      }

      const forbidden = ALL_MOBILE_VIEWS.filter((v) => !MOBILE_TABS[role].includes(v));
      for (const view of forbidden) {
        expect(screen.queryByTestId(`tab-bar-${view}`)).not.toBeInTheDocument();
      }
    });
  }
});

describe('MobileTabBar — bookkeeper Rechnungen placement (ui/index.md §8.7.1)', () => {
  // Dedicated arm pinning the load-bearing claim — bookkeeper sees
  // Rechnungen as a top-level mobile tab (not behind the header's
  // Verwaltung menu). Owner and office, who have a ≥2 secondary
  // bucket, do not get the inline promotion; their Rechnungen entry
  // lives in the header's Verwaltung menu.

  it('bookkeeper: Rechnungen renders as a top-level mobile tab', () => {
    setAuthUser(['bookkeeper']);
    render(<MobileTabBar />);
    expect(screen.getByTestId('tab-bar-rechnungen')).toBeInTheDocument();
  });

  it('owner: Rechnungen does NOT render in the mobile bottom tab bar', () => {
    setAuthUser(['owner']);
    render(<MobileTabBar />);
    expect(screen.queryByTestId('tab-bar-rechnungen')).not.toBeInTheDocument();
  });

  it('office: Rechnungen does NOT render in the mobile bottom tab bar', () => {
    setAuthUser(['office']);
    render(<MobileTabBar />);
    expect(screen.queryByTestId('tab-bar-rechnungen')).not.toBeInTheDocument();
  });

  it('worker: Rechnungen does NOT render — worker has no invoice:read permission', () => {
    setAuthUser(['worker']);
    render(<MobileTabBar />);
    expect(screen.queryByTestId('tab-bar-rechnungen')).not.toBeInTheDocument();
  });
});
