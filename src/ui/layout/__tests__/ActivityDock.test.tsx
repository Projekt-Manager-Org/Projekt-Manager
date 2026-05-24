/**
 * App-shell activity dock — fast supplementary coverage for the
 * permission gate (AC-319) and the collapse state machine (AC-318).
 *
 * The full behavioral gate is the e2e suite (e2e/activity-dock.spec.ts,
 * e2e/activity-dock-visibility.spec.ts): live SSE propagation, the
 * `recipientScope=true` wire contract, the desktop-only media-query
 * collapse, and the pager all require a real browser + server and are
 * pinned there. JSDOM cannot honestly assert media-query visibility (the
 * `.module.css` rules are not applied), so this file covers what the unit
 * layer can pin without lying:
 *   - Permission-gated render: nothing in the DOM without `audit:read`;
 *     container + toggle present for a holder.
 *   - Default-collapsed: the embedded feed is NOT mounted on first render
 *     (the panel collapses it), and the panel carries the collapsed class.
 *   - Toggling expands: the feed mounts and the panel carries the open
 *     class.
 *
 * The embedded ActivityFeed subscribes to SSE and fetches the audit list
 * on mount; both are stubbed per the Footer.test.tsx posture so this test
 * exercises only the dock's own behaviour.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ApiResult, AuthUser } from '@/api/client';
import type { AuditEntry } from '@/domain/audit';

interface AuditListDto {
  data: AuditEntry[];
  total: number;
}

const listMock = vi.fn<() => Promise<ApiResult<AuditListDto>>>();
const onSseEventMock = vi.fn(() => () => {});

vi.mock('@/api/client', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    auditApi: {
      list: (...args: unknown[]) => listMock(...(args as Parameters<typeof listMock>)),
    },
  };
});

vi.mock('@/sse/client', () => ({
  onSseEvent: (...args: unknown[]) =>
    onSseEventMock(...(args as Parameters<typeof onSseEventMock>)),
}));

const { useAuthStore } = await import('@/state/authStore');
const { ActivityDock } = await import('@/ui/layout/ActivityDock');

function setAuthRoles(roles: string[]): void {
  const user: AuthUser = {
    id: 'u-1',
    username: 'test',
    displayName: 'Test User',
    roles,
    email: null,
    themePreference: 'system',
    pushMuted: false,
  };
  useAuthStore.setState({ authUser: user, authError: null, sessionChecked: true });
}

beforeEach(() => {
  listMock.mockReset();
  // Empty feed by default — the dock's behaviour under test does not
  // depend on the rows, only on whether the feed is mounted.
  listMock.mockResolvedValue({ ok: true, data: { data: [], total: 0 } });
  onSseEventMock.mockClear();
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ authUser: null, authError: null, sessionChecked: true });
});

describe('ActivityDock — permission gate (AC-319)', () => {
  it('renders nothing for a caller without audit:read (worker)', () => {
    setAuthRoles(['worker']);

    render(<ActivityDock />);

    // Not merely hidden — the container must be absent from the DOM.
    expect(screen.queryByTestId('activity-dock')).not.toBeInTheDocument();
    // The gated feed endpoint must not be pinged either (defense in depth:
    // the feed is never mounted, so its fetch never fires).
    expect(listMock).not.toHaveBeenCalled();
  });

  it('renders nothing for bookkeeper', () => {
    setAuthRoles(['bookkeeper']);

    render(<ActivityDock />);

    expect(screen.queryByTestId('activity-dock')).not.toBeInTheDocument();
  });

  it('renders the container and toggle for an audit:read holder (owner)', () => {
    setAuthRoles(['owner']);

    render(<ActivityDock />);

    expect(screen.getByTestId('activity-dock')).toBeInTheDocument();
    expect(screen.getByTestId('activity-dock-toggle')).toBeInTheDocument();
  });

  it('renders for office (the second audit:read holder)', () => {
    setAuthRoles(['office']);

    render(<ActivityDock />);

    expect(screen.getByTestId('activity-dock')).toBeInTheDocument();
  });
});

describe('ActivityDock — collapse state machine (AC-318)', () => {
  it('is default-collapsed: the panel exists but the feed is not mounted', () => {
    setAuthRoles(['owner']);

    render(<ActivityDock />);

    const panel = screen.getByTestId('activity-dock-panel');
    expect(panel).toBeInTheDocument();
    // Collapsed → the embedded feed is not mounted, so no audit fetch
    // fires on first render (the wire fetch is deferred to expand — the
    // `recipientScope=true` first-fetch contract is pinned in e2e).
    expect(screen.queryByTestId('activity-dock-feed')).not.toBeInTheDocument();
    expect(listMock).not.toHaveBeenCalled();
    // Secondary signal: the panel carries the collapsed-variant class
    // (vitest CSS modules use the non-scoped class name).
    expect(panel.className).toContain('panelCollapsed');
  });

  it('expands on toggle: the feed mounts and the panel opens', () => {
    setAuthRoles(['owner']);

    render(<ActivityDock />);

    fireEvent.click(screen.getByTestId('activity-dock-toggle'));

    expect(screen.getByTestId('activity-dock-feed')).toBeInTheDocument();
    const panel = screen.getByTestId('activity-dock-panel');
    expect(panel.className).toContain('panel');
    expect(panel.className).not.toContain('panelCollapsed');
  });

  it('collapses again on a second toggle: the feed unmounts', () => {
    setAuthRoles(['owner']);

    render(<ActivityDock />);
    const toggle = screen.getByTestId('activity-dock-toggle');

    fireEvent.click(toggle);
    expect(screen.getByTestId('activity-dock-feed')).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.queryByTestId('activity-dock-feed')).not.toBeInTheDocument();
  });
});
