/**
 * VollstaendigerImportDialog — deterministic phase-rendering tests for the
 * server-side import-job dialog (ui/daten.md §8.11.2, AC-335 [vis], AC-161).
 *
 * The e2e (`e2e/daten-jobs.spec.ts`) drives the real job end-to-end but races
 * past `uploading`/`processing` on a tiny seed; this file pins each phase
 * deterministically by driving the real `importJobStore` via `setState` and
 * replacing its `create` / `upload` actions with `vi.fn()` spies (the store's
 * own tests cover its orchestration — here we only assert the dialog renders
 * each phase from the job row + drives create→upload). Mirrors
 * `VollstaendigerExportDialog.test.tsx`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, within, waitFor } from '@testing-library/react';
import { RESTORE_CONFIRMATION_PHRASE } from '@/config/dataExchangeConfig';
import { useImportJobStore, type DataExchangeJobDto } from '@/state/importJobStore';
import { VollstaendigerImportDialog } from '@/ui/management/VollstaendigerImportDialog';

function makeJob(overrides: Partial<DataExchangeJobDto> = {}): DataExchangeJobDto {
  return {
    id: 'job-1',
    kind: 'import',
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

function makeFile(): File {
  return new File([new Uint8Array(2048)], 'takeout.zip', { type: 'application/zip' });
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
  useImportJobStore.getState().__resetForTests();
  setMatchMedia(false);
});

afterEach(() => {
  cleanup();
  useImportJobStore.getState().__resetForTests();
});

describe('VollstaendigerImportDialog — confirm (AC-161)', () => {
  it('a fresh open (file, no job) shows the phrase input with Start disabled', () => {
    render(<VollstaendigerImportDialog file={makeFile()} onClose={vi.fn()} />);
    const confirm = screen.getByTestId('import-job-confirm');
    expect(confirm).toBeInTheDocument();
    expect(within(confirm).getByTestId('import-job-phrase-input')).toBeInTheDocument();
    // Destructive notice is unconditional — no client dry-run (AC-161).
    expect(within(confirm).getByTestId('import-job-destructive-notice')).toBeInTheDocument();
    // Gate closed until the phrase matches.
    expect(screen.getByTestId('import-job-start')).toBeDisabled();
  });

  it('enables Start only when the typed value matches the configured phrase (AC-161)', () => {
    render(<VollstaendigerImportDialog file={makeFile()} onClose={vi.fn()} />);
    const input = screen.getByTestId('import-job-phrase-input');
    const start = screen.getByTestId('import-job-start');

    fireEvent.change(input, { target: { value: 'wrong' } });
    expect(start).toBeDisabled();

    fireEvent.change(input, { target: { value: RESTORE_CONFIRMATION_PHRASE } });
    expect(start).toBeEnabled();
  });

  it('Start calls create with override:true + the matched phrase, then upload (AC-161)', async () => {
    const createSpy = vi.fn(async () => {
      // Mirror the real store: a successful create lands a pending job row.
      useImportJobStore.setState({ job: makeJob({ status: 'pending', bytesTotal: 2048 }) });
    });
    const uploadSpy = vi.fn(async () => {});
    useImportJobStore.setState({ create: createSpy, upload: uploadSpy });

    render(<VollstaendigerImportDialog file={makeFile()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('import-job-phrase-input'), {
      target: { value: RESTORE_CONFIRMATION_PHRASE },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('import-job-start'));
    });

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ override: true, phrase: RESTORE_CONFIRMATION_PHRASE }),
    );
    // create landed a pending job → upload runs against it.
    await waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(1));
  });

  it('a create-time rejection re-enables Start and surfaces the mismatch copy', async () => {
    const createSpy = vi.fn(async () => {
      // No job minted; the server rejected the destructive guard.
      useImportJobStore.setState({ createError: 'confirmation_mismatch' });
    });
    const uploadSpy = vi.fn(async () => {});
    useImportJobStore.setState({ create: createSpy, upload: uploadSpy });

    render(<VollstaendigerImportDialog file={makeFile()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('import-job-phrase-input'), {
      target: { value: RESTORE_CONFIRMATION_PHRASE },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('import-job-start'));
    });

    expect(screen.getByTestId('import-job-confirm-mismatch')).toBeInTheDocument();
    // Re-enabled (no job in flight, phrase still matches) and no upload fired.
    expect(screen.getByTestId('import-job-start')).toBeEnabled();
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('a picked file shows confirm even when a PRIOR terminal job sits in the store', () => {
    // `latest('import')` keeps returning a finished job row, so without this
    // the second restore was unreachable: every open rendered the old
    // summary and the confirm gate never appeared (found by the two-cycle
    // export→import→export→import e2e round).
    useImportJobStore.setState({ job: makeJob({ id: 'old-job', status: 'ready' }) });
    render(<VollstaendigerImportDialog file={makeFile()} onClose={vi.fn()} />);

    expect(screen.getByTestId('import-job-confirm')).toBeInTheDocument();
    expect(screen.queryByTestId('import-job-summary')).not.toBeInTheDocument();
  });

  it('a picked file shows confirm when a PRIOR failed job sits in the store', () => {
    useImportJobStore.setState({
      job: makeJob({ id: 'old-job', status: 'failed', errorDetail: 'boom' }),
    });
    render(<VollstaendigerImportDialog file={makeFile()} onClose={vi.fn()} />);

    expect(screen.getByTestId('import-job-confirm')).toBeInTheDocument();
    expect(screen.queryByTestId('import-job-failed')).not.toBeInTheDocument();
  });

  it('re-attach (no file) still resumes onto a terminal job', () => {
    useImportJobStore.setState({ job: makeJob({ id: 'old-job', status: 'ready' }) });
    render(<VollstaendigerImportDialog file={null} onClose={vi.fn()} />);

    expect(screen.getByTestId('import-job-summary')).toBeInTheDocument();
    expect(screen.queryByTestId('import-job-confirm')).not.toBeInTheDocument();
  });

  it('renders the mobile warning below the configured breakpoint', () => {
    setMatchMedia(true);
    render(<VollstaendigerImportDialog file={makeFile()} onClose={vi.fn()} />);
    expect(screen.getByTestId('import-job-mobile-warning')).toBeInTheDocument();
  });
});

describe('VollstaendigerImportDialog — uploading (AC-335)', () => {
  it('renders the upload byte readout from uploadOffset / bytesTotal', () => {
    // A pending job AT MOUNT = re-attach → tracking → uploading straight away.
    useImportJobStore.setState({
      job: makeJob({ status: 'pending', bytesTotal: 4096 }),
      uploadOffset: 1536,
    });
    render(<VollstaendigerImportDialog file={makeFile()} onClose={vi.fn()} />);

    const uploading = screen.getByTestId('import-job-uploading');
    const bytes = within(uploading).getByTestId('import-job-upload-bytes');
    expect(bytes).toHaveAttribute('data-bytes-done', '1536');
    expect(bytes).toHaveAttribute('data-bytes-total', '4096');
  });
});

describe('VollstaendigerImportDialog — processing (AC-335)', () => {
  it('renders the files counter + current item from a running job', () => {
    useImportJobStore.setState({
      job: makeJob({
        status: 'running',
        filesTotal: 8,
        filesDone: 3,
        currentItem: 'attachments/0001-dach/foto.jpg',
      }),
    });
    render(<VollstaendigerImportDialog file={null} onClose={vi.fn()} />);

    const processing = screen.getByTestId('import-job-processing');
    const counter = within(processing).getByTestId('import-job-processing-counter');
    expect(counter).toHaveAttribute('data-files-done', '3');
    expect(counter).toHaveAttribute('data-files-total', '8');
    expect(within(processing).getByTestId('import-job-current-item')).toHaveTextContent(
      'attachments/0001-dach/foto.jpg',
    );
  });
});

describe('VollstaendigerImportDialog — summary + failed (AC-335)', () => {
  it('renders the restored count from a ready job', () => {
    useImportJobStore.setState({
      job: makeJob({ status: 'ready', filesTotal: 5, filesDone: 5 }),
    });
    render(<VollstaendigerImportDialog file={null} onClose={vi.fn()} />);

    const summary = screen.getByTestId('import-job-summary');
    expect(within(summary).getByTestId('import-job-restored')).toHaveTextContent('5');
  });

  it('renders the job error_detail on a failed restore', () => {
    useImportJobStore.setState({
      job: makeJob({ status: 'failed', errorDetail: 'Tresor nicht erreichbar' }),
    });
    render(<VollstaendigerImportDialog file={null} onClose={vi.fn()} />);
    const err = screen.getByTestId('import-job-error');
    expect(err).toHaveTextContent('Tresor nicht erreichbar');
  });
});
