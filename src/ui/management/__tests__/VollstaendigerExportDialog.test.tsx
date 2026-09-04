/**
 * VollstaendigerExportDialog — deterministic phase-rendering tests for the
 * server-side export-job dialog (ui/daten.md §8.11.1, AC-335 [vis]).
 *
 * The e2e (`e2e/daten-jobs.spec.ts`) drives the real job end-to-end but races
 * past `progress` on a tiny seed; this file pins the readout deterministically
 * by driving the real `exportJobStore` via `setState` (the store's own tests
 * cover its logic — here we only assert the dialog renders each phase from the
 * job row). Mirrors the store-driving + testid-assertion style of
 * `DatenView.storageRow.test.tsx`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';
import type { DataExchangeJobDto } from '@/api/client';
import { useExportJobStore } from '@/state/exportJobStore';
import { VollstaendigerExportDialog } from '@/ui/management/VollstaendigerExportDialog';

function makeJob(overrides: Partial<DataExchangeJobDto> = {}): DataExchangeJobDto {
  return {
    id: 'job-1',
    kind: 'export',
    status: 'running',
    filesTotal: 0,
    filesDone: 0,
    bytesTotal: 0,
    bytesDone: 0,
    currentItem: null,
    errorDetail: null,
    createdAt: '2026-05-25T10:00:00.000Z',
    updatedAt: '2026-05-25T10:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function setMatchMedia(matches: boolean): void {
  (globalThis as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

beforeEach(() => {
  useExportJobStore.getState().__resetForTests();
  setMatchMedia(false);
});

afterEach(() => {
  cleanup();
  useExportJobStore.getState().__resetForTests();
});

describe('VollstaendigerExportDialog — preflight (AC-335)', () => {
  it('a fresh open (no job) shows the preflight with an enabled Start action', () => {
    render(<VollstaendigerExportDialog onClose={vi.fn()} />);
    expect(screen.getByTestId('export-job-preflight')).toBeInTheDocument();
    expect(screen.getByTestId('export-job-start')).toBeEnabled();
    expect(screen.queryByTestId('export-job-mobile-warning')).not.toBeInTheDocument();
  });

  it('renders the mobile warning below the configured breakpoint', () => {
    setMatchMedia(true);
    render(<VollstaendigerExportDialog onClose={vi.fn()} />);
    expect(screen.getByTestId('export-job-mobile-warning')).toBeInTheDocument();
    // Non-blocking — Start stays enabled.
    expect(screen.getByTestId('export-job-start')).toBeEnabled();
  });

  it('Start invokes the store start() action and disables itself until the job arrives', () => {
    const startSpy = vi.fn();
    useExportJobStore.setState({ start: startSpy });
    render(<VollstaendigerExportDialog onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId('export-job-start'));

    expect(startSpy).toHaveBeenCalledTimes(1);
    // job is still null (create in flight) → preflight stays, Start disabled
    // so a second click cannot mint a second job.
    expect(screen.getByTestId('export-job-start')).toBeDisabled();
  });
});

describe('VollstaendigerExportDialog — progress (AC-335)', () => {
  it('renders files/bytes/current-item from a running job (resume open)', () => {
    // A running job AT MOUNT = resume → tracking → progress straight away.
    useExportJobStore.setState({
      job: makeJob({
        status: 'running',
        filesTotal: 8,
        filesDone: 3,
        bytesTotal: 4096,
        bytesDone: 1536,
        currentItem: 'attachments/0001-dach/foto.jpg',
      }),
    });
    render(<VollstaendigerExportDialog onClose={vi.fn()} />);

    const progress = screen.getByTestId('export-job-progress');
    const counter = within(progress).getByTestId('export-job-progress-counter');
    expect(counter).toHaveAttribute('data-files-done', '3');
    expect(counter).toHaveAttribute('data-files-total', '8');
    const bytes = within(progress).getByTestId('export-job-progress-bytes');
    expect(bytes).toHaveAttribute('data-bytes-done', '1536');
    expect(bytes).toHaveAttribute('data-bytes-total', '4096');
    expect(within(progress).getByTestId('export-job-current-item')).toHaveTextContent(
      'attachments/0001-dach/foto.jpg',
    );
  });
});

describe('VollstaendigerExportDialog — ready + failed (AC-335)', () => {
  it('transitions running → ready and exposes a Range download link to the job archive', () => {
    useExportJobStore.setState({ job: makeJob({ status: 'running' }) });
    render(<VollstaendigerExportDialog onClose={vi.fn()} />);
    expect(screen.getByTestId('export-job-progress')).toBeInTheDocument();

    act(() => {
      useExportJobStore.setState({
        job: makeJob({ id: 'job-1', status: 'ready', filesTotal: 5, filesDone: 5 }),
      });
    });

    expect(screen.getByTestId('export-job-ready')).toBeInTheDocument();
    const dl = screen.getByTestId('export-job-download');
    // Points at the Range-capable authenticated download for THIS job; the
    // `download` attribute supplies the suggested filename.
    expect(dl).toHaveAttribute('href', '/api/export-jobs/job-1/download');
    expect(dl).toHaveAttribute('download');
  });

  it('renders the job error_detail on a failed build', () => {
    useExportJobStore.setState({ job: makeJob({ status: 'running' }) });
    render(<VollstaendigerExportDialog onClose={vi.fn()} />);
    act(() => {
      useExportJobStore.setState({
        job: makeJob({ id: 'job-1', status: 'failed', errorDetail: 'Tresor nicht erreichbar' }),
      });
    });
    const err = screen.getByTestId('export-job-error');
    expect(err).toHaveTextContent('Tresor nicht erreichbar');
  });
});
