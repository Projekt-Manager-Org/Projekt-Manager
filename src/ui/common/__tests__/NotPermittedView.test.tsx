/**
 * NotPermittedView + route guard — covers AC-149 at the component
 * level. Full E2E coverage is deferred to Round 9 (role-scoping
 * visual-regression walk); this test pins the two observable pieces
 * that are cheap to assert in isolation:
 *
 *   1. The surface renders the German error copy (no redirect, no
 *      destination swap).
 *   2. When the App's route guard mounts a forbidden route, the surface
 *      renders AND the URL stays at the forbidden path (the "URL in
 *      the address bar remains unchanged" clause of AC-149).
 *
 * Two orthogonal harnesses:
 *   - Standalone render of <NotPermittedView /> for the copy contract.
 *   - <App /> inside MemoryRouter for the guard contract.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { AuthUser } from '@/api/client';
import { STRINGS } from '@/config/strings';

/**
 * Renders `useLocation().pathname` into a testid so the AC-149 tests can
 * assert the URL-unchanged clause directly. Relying solely on the
 * testid-absence of landing views was a proxy that would pass silently
 * if one of those testids was ever renamed.
 */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location-probe">{location.pathname}</span>;
}

// jsdom ships without matchMedia; the KanbanBoard's collapse-tier hook
// uses it on mount. A no-op stub is enough — the guard test doesn't
// care about layout.
beforeAll(() => {
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }
});

// The App mounts the real KanbanBoard, CalendarView, etc., which dispatch
// through stores that in turn call the API client on mount. Stub the
// client surface at the module boundary so the guard test does not
// spiral into network paths or Playwright-level dependencies.
vi.mock('@/api/client', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    authApi: {
      me: vi.fn().mockResolvedValue({ ok: false }),
      login: vi.fn(),
      logout: vi.fn(),
      updateSelf: vi.fn(),
      changePassword: vi.fn(),
    },
    projectApi: {
      list: vi.fn().mockResolvedValue({ ok: true, data: { data: [], total: 0 } }),
      create: vi.fn(),
      update: vi.fn(),
      updateDates: vi.fn(),
      delete: vi.fn(),
      transitionForward: vi.fn(),
      transitionBackward: vi.fn(),
    },
    customerApi: {
      list: vi.fn().mockResolvedValue({ ok: true, data: { customers: [], total: 0 } }),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    userApi: {
      list: vi.fn().mockResolvedValue({ ok: true, data: { users: [], total: 0 } }),
    },
    extractApi: {
      extract: vi.fn(),
    },
  };
});

const { NotPermittedView } = await import('@/ui/common/NotPermittedView');
const { App } = await import('@/App');
const { useAuthStore } = await import('@/state/authStore');

function setAuthUser(roles: string[]): void {
  const user: AuthUser = {
    id: 'u-1',
    username: 'tester',
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

beforeEach(() => {
  useAuthStore.setState({
    authUser: null,
    authError: null,
    sessionChecked: true,
  });
});

describe('NotPermittedView — surface copy', () => {
  it('renders the German heading and body', () => {
    setAuthUser(['worker']);
    render(
      <MemoryRouter>
        <NotPermittedView />
      </MemoryRouter>,
    );
    expect(screen.getByText(STRINGS.ui.notPermittedHeading)).toBeInTheDocument();
    expect(screen.getByText(STRINGS.ui.notPermittedBody)).toBeInTheDocument();
    expect(screen.getByTestId('not-permitted-home')).toBeInTheDocument();
  });
});

// Forbidden-path coverage — one case per role × one off-matrix path.
// Exhaustive role × path coverage is deferred to the E2E visual walk
// (AC-149, Round 9); here we take one representative per role.
type ForbiddenCase = { role: string; path: string };
const FORBIDDEN: readonly ForbiddenCase[] = [
  { role: 'worker', path: '/customers' }, // AC-149 example
  { role: 'worker', path: '/users' },
  { role: 'worker', path: '/daten' },
  // Worker lacks `invoice:read`; the Rechnungen route is forbidden.
  { role: 'worker', path: '/rechnungen' },
  { role: 'office', path: '/users' },
  { role: 'bookkeeper', path: '/kanban' },
  { role: 'bookkeeper', path: '/calendar' },
  { role: 'bookkeeper', path: '/users' },
  { role: 'bookkeeper', path: '/daten' },
  // Bookkeeper lacks `audit:read`; the Aktivität route is forbidden.
  { role: 'bookkeeper', path: '/audit' },
];

describe('Route guard — AC-149: forbidden path renders NotPermittedView, URL unchanged', () => {
  for (const { role, path } of FORBIDDEN) {
    it(`role '${role}' at '${path}' sees the not-permitted surface and stays on the path`, () => {
      setAuthUser([role]);
      render(
        <MemoryRouter initialEntries={[path]}>
          <App />
          <LocationProbe />
        </MemoryRouter>,
      );
      // The error surface renders.
      expect(screen.getByTestId('not-permitted-view')).toBeInTheDocument();
      // The URL is unchanged — asserted directly via the probe. The
      // original testid-absence checks (kept below) pinned the same
      // invariant indirectly; keeping them adds a layer of defence
      // against the guard silently rendering the wrong view on the
      // forbidden path.
      expect(screen.getByTestId('location-probe').textContent).toBe(path);
      expect(screen.queryByTestId('kanban-board')).not.toBeInTheDocument();
      expect(screen.queryByTestId('calendar-view')).not.toBeInTheDocument();
      expect(screen.queryByTestId('customer-table')).not.toBeInTheDocument();
      expect(screen.queryByTestId('project-table')).not.toBeInTheDocument();
      expect(screen.queryByTestId('user-table')).not.toBeInTheDocument();
      expect(screen.queryByTestId('daten-view')).not.toBeInTheDocument();
    });
  }
});

describe('Route guard — permitted paths still render their view', () => {
  it('owner on /kanban sees the kanban board, not the error surface', () => {
    setAuthUser(['owner']);
    render(
      <MemoryRouter initialEntries={['/kanban']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('not-permitted-view')).not.toBeInTheDocument();
  });
});
