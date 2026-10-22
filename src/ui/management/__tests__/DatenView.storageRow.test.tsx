/**
 * DatenView storage row — covers the row in [ui/daten.md §8.11.3]:
 *
 *   - Row visible to `data:export` holders only (owner, office under
 *     the default matrix).
 *   - Hidden from worker and bookkeeper (defence in depth on top of
 *     the nav gate; the server remains authoritative).
 *   - Both plaintext buckets rendered inline:
 *       `Sichtbar`      → ready.plaintext
 *       `Im Papierkorb` → hidden.plaintext
 *     each formatted via the shared byte-formatting helper.
 *   - Ciphertext buckets (operator / billing concerns) are NOT shown
 *     on the user-facing surface.
 *
 * The "row sits above Export and Import" ordering is a layout concern
 * the e2e author covers; this file covers the data-and-permission
 * contract that lives at the unit level.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
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
const { DatenView } = await import('@/ui/management/DatenView');

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
});

describe('DatenView storage row — permission gating', () => {
  it('renders the row when the user holds data:export (owner)', async () => {
    getGlobalMock.mockResolvedValue(
      ok({
        ready: { plaintext: 0, ciphertext: 0 },
        hidden: { plaintext: 0, ciphertext: 0 },
      }),
    );
    setAuthRoles(['owner']);

    render(<DatenView />);

    expect(await screen.findByTestId('daten-storage-row')).toBeInTheDocument();
  });

  it('renders the row for office (the second data:export holder)', async () => {
    getGlobalMock.mockResolvedValue(
      ok({
        ready: { plaintext: 0, ciphertext: 0 },
        hidden: { plaintext: 0, ciphertext: 0 },
      }),
    );
    setAuthRoles(['office']);

    render(<DatenView />);

    expect(await screen.findByTestId('daten-storage-row')).toBeInTheDocument();
  });

  it('hides the row from bookkeeper (no data:export under the default matrix)', () => {
    setAuthRoles(['bookkeeper']);

    render(<DatenView />);

    expect(screen.queryByTestId('daten-storage-row')).not.toBeInTheDocument();
    // Defence in depth: a role without `data:export` must not even ping
    // the gated read endpoint from the DatenView.
    expect(getGlobalMock).not.toHaveBeenCalled();
  });

  it('hides the row from worker', () => {
    setAuthRoles(['worker']);

    render(<DatenView />);

    expect(screen.queryByTestId('daten-storage-row')).not.toBeInTheDocument();
    expect(getGlobalMock).not.toHaveBeenCalled();
  });
});

describe('DatenView storage row — bucket rendering', () => {
  it('renders both plaintext buckets inline with the German labels and formatted values', async () => {
    // ready.plaintext = 3 MB, hidden.plaintext = 512 KB. The shared
    // byte-formatting helper renders the MB tier with two decimals and
    // the KB tier as integer (AC-451). Pinning both tiers in one
    // assertion catches a regression that swaps formatters per surface.
    getGlobalMock.mockResolvedValue(
      ok({
        ready: { plaintext: 3 * 1024 * 1024, ciphertext: 9 * 1024 * 1024 },
        hidden: { plaintext: 512 * 1024, ciphertext: 1024 * 1024 },
      }),
    );
    setAuthRoles(['owner']);

    render(<DatenView />);

    const row = await screen.findByTestId('daten-storage-row');
    expect(within(row).getByText(/Sichtbar/)).toBeInTheDocument();
    expect(within(row).getByText(/3,00 MB/)).toBeInTheDocument();
    expect(within(row).getByText(/Im Papierkorb/)).toBeInTheDocument();
    expect(within(row).getByText(/512 KB/)).toBeInTheDocument();
  });

  it('does NOT render the ciphertext buckets — those are operator concerns', async () => {
    // Ciphertext numbers are deliberately distinct from plaintext so a
    // regression that swaps `ready.plaintext` for `ready.ciphertext`
    // (or pulls both into the surface) shows up as a leaked value.
    getGlobalMock.mockResolvedValue(
      ok({
        ready: { plaintext: 1 * 1024 * 1024, ciphertext: 7 * 1024 * 1024 },
        hidden: { plaintext: 1 * 1024 * 1024, ciphertext: 8 * 1024 * 1024 },
      }),
    );
    setAuthRoles(['owner']);

    render(<DatenView />);

    const row = await screen.findByTestId('daten-storage-row');
    // Both plaintext values render exactly once each; both ciphertext
    // values must not appear at all.
    expect(within(row).queryByText(/7,00 MB/)).not.toBeInTheDocument();
    expect(within(row).queryByText(/8,00 MB/)).not.toBeInTheDocument();
  });

  it('exposes both buckets inline with no hover-only tooltip surface', async () => {
    // Mobile-first posture per [ui/daten.md §8.11.3]: both buckets are
    // on the surface at all times, no `title`-based hover tooltip
    // because there is no hover on touch. A regression that re-uses
    // the Footer's tooltip pattern here would surface as a `title`
    // attribute carrying the breakdown.
    getGlobalMock.mockResolvedValue(
      ok({
        ready: { plaintext: 1024, ciphertext: 0 },
        hidden: { plaintext: 1024, ciphertext: 0 },
      }),
    );
    setAuthRoles(['owner']);

    render(<DatenView />);

    const row = await screen.findByTestId('daten-storage-row');
    expect(row.getAttribute('title')).toBeNull();
  });
});
