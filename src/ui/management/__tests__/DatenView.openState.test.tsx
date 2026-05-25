/**
 * DatenView derived dialog open-state — the "mirror export" fix
 * ([ui/daten.md §8.11]).
 *
 * The branch's load-bearing UX contract, none of which had unit coverage:
 *
 *   - A TERMINAL export (`ready`/`failed`) surfaces INLINE (`export-job-status`
 *     + `export-job-download`) and must NOT pop a modal over the import action —
 *     the exact regression this branch fixes.
 *   - An ACTIVE export (`pending`/`running`) auto-opens its progress modal and
 *     suppresses the inline affordance (one download surface at a time).
 *   - A TERMINAL import auto-opens its dialog (it re-attaches to the
 *     restored-counts summary after the post-wipe re-auth)…
 *   - …UNLESS the operator already dismissed that job (store-held
 *     `dismissedJobId`), so it does not re-pop on the next Daten revisit.
 *   - Subscriptions are permission-gated: a role without the permission never
 *     probes the gated job endpoint (defence in depth on top of the server).
 *
 * The two dialogs are mocked to inert markers so this file pins DatenView's
 * derivation, not the dialogs' internals (those have their own tests).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ApiResult, AuthUser } from '@/api/client';

interface JobDto {
  id: string;
  kind: 'export' | 'import';
  status: 'pending' | 'running' | 'ready' | 'failed';
  filesTotal: number;
  filesDone: number;
  bytesTotal: number;
  bytesDone: number;
  currentItem: string | null;
  errorDetail: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const exportGetLatestMock = vi.fn<() => Promise<ApiResult<{ job: JobDto | null }>>>();
const importGetLatestMock = vi.fn<() => Promise<ApiResult<{ job: JobDto | null }>>>();
const onSseEventMock = vi.fn(() => () => {});

vi.mock('@/api/client', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    storageUsageApi: {
      getGlobal: vi.fn().mockResolvedValue({
        ok: true,
        data: { ready: { plaintext: 0, ciphertext: 0 }, hidden: { plaintext: 0, ciphertext: 0 } },
      }),
    },
    exportJobApi: {
      getLatest: () => exportGetLatestMock(),
      get: vi.fn(),
      create: vi.fn(),
      downloadPath: (id: string) => `/api/export-jobs/${id}/download`,
    },
    importJobApi: {
      getLatest: () => importGetLatestMock(),
      get: vi.fn(),
      create: vi.fn(),
      headOffset: vi.fn(),
      patchChunk: vi.fn(),
    },
  };
});

vi.mock('@/sse/client', () => ({
  onSseEvent: (...args: unknown[]) =>
    onSseEventMock(...(args as Parameters<typeof onSseEventMock>)),
}));

// Inert dialog markers — DatenView decides whether to MOUNT them; their
// internals are covered by the dialogs' own tests.
vi.mock('@/ui/management/VollstaendigerExportDialog', () => ({
  VollstaendigerExportDialog: () => <div data-testid="mock-export-dialog" />,
}));
vi.mock('@/ui/management/VollstaendigerImportDialog', () => ({
  VollstaendigerImportDialog: () => <div data-testid="mock-import-dialog" />,
}));

const { useAuthStore } = await import('@/state/authStore');
const { useExportJobStore } = await import('@/state/exportJobStore');
const { useImportJobStore } = await import('@/state/importJobStore');
const { DatenView } = await import('@/ui/management/DatenView');

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

function makeJob(overrides: Partial<JobDto>): JobDto {
  return {
    id: 'job-1',
    kind: 'export',
    status: 'ready',
    filesTotal: 0,
    filesDone: 0,
    bytesTotal: 0,
    bytesDone: 0,
    currentItem: null,
    errorDetail: null,
    createdAt: '2026-05-25T00:00:00.000Z',
    updatedAt: '2026-05-25T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
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
  exportGetLatestMock.mockReset().mockResolvedValue(ok({ job: null }));
  importGetLatestMock.mockReset().mockResolvedValue(ok({ job: null }));
  onSseEventMock.mockClear();
  useExportJobStore.getState().__resetForTests();
  useImportJobStore.getState().__resetForTests();
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ authUser: null, authError: null, sessionChecked: true });
});

describe('DatenView — export open-state (mirror-export fix)', () => {
  it('a READY export surfaces inline and does NOT pop the export modal over the import action', async () => {
    exportGetLatestMock.mockResolvedValue(ok({ job: makeJob({ id: 'e-ready', status: 'ready' }) }));
    setAuthRoles(['owner']);

    render(<DatenView />);

    // Inline affordance with the download link…
    const status = await screen.findByTestId('export-job-status');
    expect(status).toBeInTheDocument();
    const dl = screen.getByTestId('export-job-download');
    expect(dl).toHaveAttribute('href', '/api/export-jobs/e-ready/download');
    // …and crucially NO modal covering the surface.
    expect(screen.queryByTestId('mock-export-dialog')).not.toBeInTheDocument();
    // The import action stays reachable.
    expect(screen.getByTestId('data-import-button')).toBeInTheDocument();
  });

  it('a FAILED export surfaces inline (error), not as a modal', async () => {
    exportGetLatestMock.mockResolvedValue(
      ok({ job: makeJob({ id: 'e-fail', status: 'failed', errorDetail: 'boom' }) }),
    );
    setAuthRoles(['owner']);

    render(<DatenView />);

    expect(await screen.findByTestId('export-job-status')).toHaveTextContent('boom');
    expect(screen.queryByTestId('mock-export-dialog')).not.toBeInTheDocument();
  });

  it('an ACTIVE export auto-opens the modal and suppresses the inline affordance', async () => {
    exportGetLatestMock.mockResolvedValue(ok({ job: makeJob({ id: 'e-run', status: 'running' }) }));
    setAuthRoles(['owner']);

    render(<DatenView />);

    expect(await screen.findByTestId('mock-export-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('export-job-status')).not.toBeInTheDocument();
  });
});

describe('DatenView — import open-state + cross-mount dismissal', () => {
  it('a terminal import auto-opens its dialog (re-attach to the summary after re-auth)', async () => {
    importGetLatestMock.mockResolvedValue(
      ok({ job: makeJob({ id: 'i-ready', kind: 'import', status: 'ready' }) }),
    );
    setAuthRoles(['owner']);

    render(<DatenView />);

    expect(await screen.findByTestId('mock-import-dialog')).toBeInTheDocument();
  });

  it('a dismissed terminal import stays closed on a revisit (does not re-pop)', async () => {
    importGetLatestMock.mockResolvedValue(
      ok({ job: makeJob({ id: 'i-ready', kind: 'import', status: 'ready' }) }),
    );
    // Operator already closed this job on a prior visit — the store remembers.
    useImportJobStore.setState({ dismissedJobId: 'i-ready' });
    setAuthRoles(['owner']);

    render(<DatenView />);

    // The probe re-attaches the job, but the dismissal keeps the dialog closed.
    await screen.findByTestId('daten-view');
    expect(screen.queryByTestId('mock-import-dialog')).not.toBeInTheDocument();
  });
});

describe('DatenView — permission-gated subscriptions', () => {
  it('a role without data perms (worker) renders neither section and never probes the job endpoints', () => {
    setAuthRoles(['worker']);

    render(<DatenView />);

    expect(screen.queryByTestId('data-export-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('data-import-button')).not.toBeInTheDocument();
    expect(exportGetLatestMock).not.toHaveBeenCalled();
    expect(importGetLatestMock).not.toHaveBeenCalled();
  });
});
