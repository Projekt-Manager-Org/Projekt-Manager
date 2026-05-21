/**
 * Footer storage badge — covers AC-271's permission-gated visibility,
 * label, and tooltip surface ([ui/index.md §8.1.2], [verification.md
 * §15.29]).
 *
 * The viewport-media-query gate (badge hidden on phones) is verified
 * by the e2e author — JSDOM cannot honestly assert media-query
 * collapse. This file covers the behaviour the unit layer can pin:
 *   - Permission-gated render (`data:export` holders only).
 *   - German label `Daten:` followed by `ready.plaintext` formatted
 *     via the shared byte-formatting helper.
 *   - Value tracks the storage-usage subscription's data after refresh.
 *   - Tooltip carries the two-bucket plaintext breakdown (`Sichtbar`
 *     and `Im Papierkorb`).
 *
 * Match the existing tooltip posture (BackupBadge.tsx): the `title`
 * attribute on the badge element is the desktop hover surface. If the
 * implementer chooses a different mechanism (a popover with
 * `role="tooltip"`, a custom Tooltip component, etc.) the assertion
 * will fail with a clear locator miss and they can adapt.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ApiResult, AuthUser } from '@/api/client';

interface StorageUsageDto {
  ready: { plaintext: number; ciphertext: number };
  hidden: { plaintext: number; ciphertext: number };
}

type GetGlobalResult = ApiResult<StorageUsageDto>;

const getGlobalMock = vi.fn<() => Promise<GetGlobalResult>>();
const onSseEventMock = vi.fn(() => () => {});

vi.mock('@/api/client', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    storageUsageApi: {
      getGlobal: (...args: unknown[]) =>
        getGlobalMock(...(args as Parameters<typeof getGlobalMock>)),
    },
  };
});

vi.mock('@/sse/client', () => ({
  onSseEvent: (...args: unknown[]) =>
    onSseEventMock(...(args as Parameters<typeof onSseEventMock>)),
}));

const { useAuthStore } = await import('@/state/authStore');
const { useStorageUsageStore } = await import('@/state/storageUsageStore');
const { Footer } = await import('@/ui/layout/Footer');

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

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
  getGlobalMock.mockReset();
  onSseEventMock.mockClear();
  useStorageUsageStore.getState().__resetForTests();
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ authUser: null, authError: null, sessionChecked: true });
  // Drop any per-test override of `__APP_GIT_SHA__` so the next test
  // starts from the default (component-setup.ts) value.
  vi.unstubAllGlobals();
});

describe('Footer storage badge — permission gating (AC-271)', () => {
  it('renders the badge when the authenticated user holds data:export (owner)', async () => {
    getGlobalMock.mockResolvedValue(
      ok({
        ready: { plaintext: 2048, ciphertext: 4096 },
        hidden: { plaintext: 1024, ciphertext: 2048 },
      }),
    );
    setAuthRoles(['owner']);

    render(<Footer />);

    const badge = await screen.findByTestId('storage-usage-badge');
    expect(badge).toBeInTheDocument();
  });

  it('renders the badge for office (the second data:export holder)', async () => {
    getGlobalMock.mockResolvedValue(
      ok({
        ready: { plaintext: 0, ciphertext: 0 },
        hidden: { plaintext: 0, ciphertext: 0 },
      }),
    );
    setAuthRoles(['office']);

    render(<Footer />);

    expect(await screen.findByTestId('storage-usage-badge')).toBeInTheDocument();
  });

  it('hides the badge from worker — only the brand text shows', () => {
    setAuthRoles(['worker']);

    render(<Footer />);

    expect(screen.queryByTestId('storage-usage-badge')).not.toBeInTheDocument();
    // Brand text remains — the badge gate must not collapse the footer
    // entirely, which would also hide the configurable footerText.
    expect(screen.getByText('Projekt-Manager')).toBeInTheDocument();
    // The fetch is gated too — a worker render must not even ping the
    // gated read endpoint (defense in depth: server returns 403, but
    // the client doesn't make the call).
    expect(getGlobalMock).not.toHaveBeenCalled();
  });

  it('hides the badge from bookkeeper', () => {
    setAuthRoles(['bookkeeper']);

    render(<Footer />);

    expect(screen.queryByTestId('storage-usage-badge')).not.toBeInTheDocument();
    expect(getGlobalMock).not.toHaveBeenCalled();
  });
});

describe('Footer storage badge — label and value (AC-271)', () => {
  it('renders "Daten:" followed by ready.plaintext formatted via the shared helper', async () => {
    // 2 MB exact — pins both the German label and the formatBytes
    // posture (two decimals at the MB tier per AC-274).
    getGlobalMock.mockResolvedValue(
      ok({
        ready: { plaintext: 2 * 1024 * 1024, ciphertext: 0 },
        hidden: { plaintext: 0, ciphertext: 0 },
      }),
    );
    setAuthRoles(['owner']);

    render(<Footer />);

    const badge = await screen.findByTestId('storage-usage-badge');
    expect(badge.textContent).toContain('Daten:');
    expect(badge.textContent).toContain('2.00 MB');
  });

  it('reflects refreshed values after a refresh trigger fires', async () => {
    // Mount with one value; explicitly refresh() with another and assert
    // the rendered text follows the subscription. Pins AC-271's
    // "matches the response's `ready.plaintext` after every refresh
    // trigger fires" clause.
    getGlobalMock.mockResolvedValueOnce(
      ok({
        ready: { plaintext: 1024, ciphertext: 0 },
        hidden: { plaintext: 0, ciphertext: 0 },
      }),
    );
    setAuthRoles(['owner']);

    render(<Footer />);
    const badge = await screen.findByTestId('storage-usage-badge');
    await vi.waitFor(() => expect(badge.textContent).toContain('1 KB'));

    getGlobalMock.mockResolvedValueOnce(
      ok({
        ready: { plaintext: 5 * 1024 * 1024, ciphertext: 0 },
        hidden: { plaintext: 0, ciphertext: 0 },
      }),
    );
    await useStorageUsageStore.getState().refresh();

    await vi.waitFor(() => expect(badge.textContent).toContain('5.00 MB'));
  });
});

describe('Footer version chip — build-time git SHA', () => {
  it('renders the chip with `v` prefix + 7-char SHA when __APP_GIT_SHA__ is set', () => {
    vi.stubGlobal('__APP_GIT_SHA__', 'abc1234');
    setAuthRoles(['worker']); // worker hides the storage badge — keeps the assertion clean

    render(<Footer />);

    const chip = screen.getByTestId('footer-app-version');
    expect(chip).toBeInTheDocument();
    expect(chip.textContent).toBe('vabc1234');
  });

  it('truncates a full 40-char SHA to 7 chars for display', () => {
    // Belt-and-braces against a future bake-in that ships a full SHA
    // (vite truncates today, but the Footer should not depend on that
    // upstream invariant for the displayed form).
    vi.stubGlobal('__APP_GIT_SHA__', 'd468579abcdef0123456789abcdef0123456789a');
    setAuthRoles(['worker']);

    render(<Footer />);

    expect(screen.getByTestId('footer-app-version').textContent).toBe('vd468579');
  });

  it('renders no chip when __APP_GIT_SHA__ is empty (dev / non-git build)', () => {
    vi.stubGlobal('__APP_GIT_SHA__', '');
    setAuthRoles(['worker']);

    render(<Footer />);

    expect(screen.queryByTestId('footer-app-version')).not.toBeInTheDocument();
  });
});

describe('Footer storage badge — tooltip breakdown (AC-271)', () => {
  it('exposes the two-bucket plaintext breakdown with the German labels', async () => {
    // ready.plaintext = 3 MB, hidden.plaintext = 1.50 MB — both
    // formatted via the shared helper. Tooltip wording mirrors the
    // DatenView labels pinned in [ui/daten.md §8.11.3]: `Sichtbar` for
    // ready, `Im Papierkorb` for hidden. Ciphertext buckets are
    // operator-only and must NOT appear.
    getGlobalMock.mockResolvedValue(
      ok({
        ready: { plaintext: 3 * 1024 * 1024, ciphertext: 9 * 1024 * 1024 },
        hidden: { plaintext: 1.5 * 1024 * 1024, ciphertext: 4.5 * 1024 * 1024 },
      }),
    );
    setAuthRoles(['owner']);

    render(<Footer />);

    const badge = await screen.findByTestId('storage-usage-badge');
    // The tooltip surface follows the BackupBadge convention — `title`
    // attribute carrying the desktop-hover label. If the implementer
    // chooses a popover element instead, the assertion will fail with
    // a clear locator miss and they can adapt the test.
    const tooltip = badge.getAttribute('title') ?? '';
    expect(tooltip).toContain('Sichtbar');
    expect(tooltip).toContain('3.00 MB');
    expect(tooltip).toContain('Im Papierkorb');
    expect(tooltip).toContain('1.50 MB');
    // Operator-only ciphertext buckets stay off the user surface.
    expect(tooltip).not.toContain('9.00 MB');
    expect(tooltip).not.toContain('4.50 MB');
  });
});
