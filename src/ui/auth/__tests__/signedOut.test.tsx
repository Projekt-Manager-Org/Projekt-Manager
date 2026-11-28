/**
 * The signed-out app — <App /> with the real stores, the real API client
 * and the real SSE client; only `fetch` and `EventSource` are stubbed.
 *
 *   - AC-573: while no one is signed in, every path shows the login
 *     screen and nothing else, whatever data is still in memory.
 *   - AC-26: after `Abmelden`, going back through the history shows no
 *     project data. The server half (the old session reads nothing) is in
 *     `src/server/__tests__/auth.test.ts`.
 *   - AC-27: a session ended elsewhere while the app sits idle shows the
 *     login screen with the expiry message within one heartbeat plus 30 s.
 *     The server ends the realtime connection within the heartbeat
 *     (AC-275, `attachments-events-route.test.ts`); this file pins the
 *     client's 30 s from there.
 *
 * Reads other than the session probe never settle: no response but the
 * ones under test can end the session.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import type { AuthUser } from '@/api/client';
import type { Project } from '@/domain/types';
import { BRANDING } from '@/config/brandingConfig';
import { ROUTES } from '@/config/routes';
import { STRINGS } from '@/config/strings';
import { App } from '@/App';
import { useAuthStore } from '@/state/authStore';
import { useProjectStore } from '@/state/projectStore';

const OWNER: AuthUser = {
  id: 'u-owner',
  username: 'inhaber',
  displayName: 'Thomas Berger',
  roles: ['owner'],
  email: null,
  themePreference: 'system',
  pushMuted: false,
};

const PROJECT = {
  id: 'p-1',
  version: 1,
  number: 'P-2026-017',
  title: 'Treppenhaus Lindenstraße',
  status: 'geplant',
  statusChangedAt: '2026-04-01T00:00:00Z',
  plannedStart: '2026-05-04',
  plannedEnd: '2026-05-08',
  createdAt: '2026-04-01T00:00:00Z',
  updatedAt: '2026-04-01T00:00:00Z',
  customerId: 'c-1',
  customer: null,
  siteAddress: null,
  assignedWorkers: [],
  estimatedValue: null,
  notes: null,
  deleted: false,
  createdBy: null,
  updatedBy: null,
} as Project;

/** Set when the server's session ends — logout here, or elsewhere. */
let sessionEnded: boolean;
/** Latency of the session probe (`GET /api/auth/me`). */
let probeLatencyMs: number;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const path = String(input);
  if (path === '/api/auth/logout') {
    sessionEnded = true;
    return json(200, { success: true });
  }
  if (path === '/api/auth/me') {
    const res = sessionEnded
      ? json(401, { code: 'SESSION_EXPIRED', message: '' })
      : json(200, { user: OWNER });
    return new Promise((resolve) => setTimeout(() => resolve(res), probeLatencyMs));
  }
  return new Promise(() => {});
}

function signIn(): void {
  useAuthStore.setState({ authUser: OWNER, authError: null, sessionChecked: true });
}

function LocationProbe() {
  return <span data-testid="location-probe">{useLocation().pathname}</span>;
}

/** The browser's back button. */
function BackButton() {
  const navigate = useNavigate();
  return (
    <button type="button" data-testid="history-back" onClick={() => void navigate(-1)}>
      back
    </button>
  );
}

/** No project data anywhere on the page. */
function expectNoProjectData(): void {
  expect(document.body).not.toHaveTextContent(PROJECT.number);
  expect(document.body).not.toHaveTextContent(PROJECT.title);
}

beforeEach(() => {
  sessionEnded = false;
  probeLatencyMs = 0;
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  useAuthStore.setState({ authUser: null, authError: null, sessionChecked: true });
  useProjectStore.setState({ projects: [PROJECT], mutationInFlight: {}, mutationError: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AC-573: while no one is signed in, only the login screen shows', () => {
  const paths = ['/', '/does-not-exist', ...ROUTES.map((r) => r.path.replace(':id', 'p-1'))];

  beforeEach(() => {
    // A fresh load with no session: the mount-time session check is refused.
    sessionEnded = true;
    useAuthStore.setState({ sessionChecked: false });
  });

  it.each(paths)('%s', async (path) => {
    // Project data left in memory must not leak onto the screen.
    const { container } = render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );

    // ui/index.md §8.1.1: the app name, `Benutzername`, `Passwort`, `Anmelden`.
    // Awaited, so the session check settles inside this test.
    const form = await screen.findByTestId('login-form');
    expect(useAuthStore.getState().sessionChecked).toBe(true);
    expect(screen.getByRole('heading', { name: BRANDING.appName })).toBeInTheDocument();
    expect(screen.getByLabelText('Benutzername')).toBeInTheDocument();
    expect(screen.getByLabelText('Passwort')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anmelden' })).toBeInTheDocument();

    // Nothing beside the login screen: one root, holding the form.
    expect(container.childElementCount).toBe(1);
    expect(container.firstElementChild).toContainElement(form);
    expect(container.querySelector('header, nav, main')).toBeNull();
    expectNoProjectData();
  });
});

describe('AC-26: after signing out, the back button shows no project data', () => {
  it('every earlier history entry shows the login screen', async () => {
    signIn();
    render(
      <MemoryRouter initialEntries={['/kanban']}>
        <App />
        <LocationProbe />
        <BackButton />
      </MemoryRouter>,
    );
    // Signed in, the entries to go back to show the project.
    expect(screen.getByText(PROJECT.title)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('view-toggle-kalender'));
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/calendar');
    await userEvent.click(screen.getByTestId('view-toggle-kanban'));
    expect(screen.getByText(PROJECT.title)).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('user-menu-trigger'));
    await userEvent.click(screen.getByTestId('logout-button'));
    expect(await screen.findByTestId('login-form')).toBeInTheDocument();
    expectNoProjectData();

    for (const path of ['/calendar', '/kanban']) {
      await userEvent.click(screen.getByTestId('history-back'));
      expect(screen.getByTestId('location-probe')).toHaveTextContent(path);
      expect(screen.getByTestId('login-form')).toBeInTheDocument();
      expectNoProjectData();
    }
  });
});

describe('AC-27: a session ended elsewhere shows the login screen with the expiry message', () => {
  // WHATWG leaves the browser's reconnect delay implementation-defined,
  // "in the region of a few seconds".
  const BROWSER_RECONNECT_MS = 5_000;
  /** AC-27's bound, counted from the server closing the stream. */
  const CLIENT_BUDGET_MS = 30_000;

  class FakeEventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readyState = FakeEventSource.CONNECTING;
    private readonly listeners = new Map<string, Set<EventListener>>();

    constructor() {
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- the test drives the source the client opened.
      source = this;
    }
    addEventListener(name: string, handler: EventListener): void {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name)!.add(handler);
    }
    removeEventListener(name: string, handler: EventListener): void {
      this.listeners.get(name)?.delete(handler);
    }
    close(): void {
      this.readyState = FakeEventSource.CLOSED;
    }
    emit(name: string, readyState: number): void {
      this.readyState = readyState;
      for (const h of [...(this.listeners.get(name) ?? [])]) h({ type: name } as Event);
    }
  }
  let source: FakeEventSource | null;

  beforeEach(() => {
    source = null;
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('within 30 s of the server closing the realtime connection', async () => {
    signIn();
    // A slow mobile network.
    probeLatencyMs = 1_000;
    render(
      <MemoryRouter initialEntries={['/kanban']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByText(PROJECT.title)).toBeInTheDocument();
    act(() => source!.emit('open', FakeEventSource.OPEN));

    // Ended elsewhere; at its next heartbeat the server closes the stream.
    sessionEnded = true;
    act(() => source!.emit('error', FakeEventSource.CONNECTING));
    // The browser's reconnect is refused (401): the source closes for good.
    await act(() => vi.advanceTimersByTimeAsync(BROWSER_RECONNECT_MS));
    act(() => source!.emit('error', FakeEventSource.CLOSED));
    await act(() => vi.advanceTimersByTimeAsync(CLIENT_BUDGET_MS - BROWSER_RECONNECT_MS));

    expect(screen.getByTestId('login-form')).toBeInTheDocument();
    expect(screen.getByTestId('login-error')).toHaveTextContent(STRINGS.auth.sessionExpiredLogin);
    expectNoProjectData();
  });
});
