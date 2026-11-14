/**
 * VollstaendigerImportDialog — deterministic phase-rendering tests for the
 * server-side import-job dialog (ui/daten.md §8.11.2, AC-161).
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
    // Destructive notice is unconditional (AC-161).
    expect(within(confirm).getByTestId('import-job-destructive-notice')).toBeInTheDocument();
    // Gate closed until the phrase matches.
    expect(screen.getByTestId('import-job-start')).toBeDisabled();
  });

  it('warns that the restore purges the Papierkorb (AC-432)', () => {
    // Distinct from the generic destructive notice: "the existing data is
    // deleted" does not tell an operator that the archive holds no `hidden`
    // rows, so the trash cannot come back. No surprises at the gate.
    render(<VollstaendigerImportDialog file={makeFile()} onClose={vi.fn()} />);
    const confirm = screen.getByTestId('import-job-confirm');
    expect(within(confirm).getByTestId('import-job-papierkorb-notice')).toHaveTextContent(
      /Papierkorb/,
    );
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

  it('AC-605: a picked file shows confirm even when a PRIOR terminal job sits in the store', () => {
    // `latest('import')` keeps returning a finished job row, so without this
    // the second restore was unreachable: every open rendered the old
    // summary and the confirm gate never appeared (found by the two-cycle
    // export→import→export→import e2e round).
    useImportJobStore.setState({ job: makeJob({ id: 'old-job', status: 'ready' }) });
    render(<VollstaendigerImportDialog file={makeFile()} onClose={vi.fn()} />);

    expect(screen.getByTestId('import-job-confirm')).toBeInTheDocument();
    expect(screen.queryByTestId('import-job-summary')).not.toBeInTheDocument();
  });

  it('AC-605: a picked file shows confirm when a PRIOR failed job sits in the store', () => {
    useImportJobStore.setState({
      job: makeJob({ id: 'old-job', status: 'failed', errorDetail: 'boom' }),
    });
    render(<VollstaendigerImportDialog file={makeFile()} onClose={vi.fn()} />);

    expect(screen.getByTestId('import-job-confirm')).toBeInTheDocument();
    expect(screen.queryByTestId('import-job-failed')).not.toBeInTheDocument();
  });

  it('AC-604: re-attach (no file) still resumes onto a terminal job', () => {
    useImportJobStore.setState({ job: makeJob({ id: 'old-job', status: 'ready' }) });
    render(<VollstaendigerImportDialog file={null} onClose={vi.fn()} />);

    expect(screen.getByTestId('import-job-summary')).toBeInTheDocument();
    expect(screen.queryByTestId('import-job-confirm')).not.toBeInTheDocument();
  });

  it('AC-606: renders the mobile warning below the configured breakpoint', () => {
    setMatchMedia(true);
    render(<VollstaendigerImportDialog file={makeFile()} onClose={vi.fn()} />);
    expect(screen.getByTestId('import-job-mobile-warning')).toBeInTheDocument();
    // Non-blocking — the phrase still enables Start.
    fireEvent.change(screen.getByTestId('import-job-phrase-input'), {
      target: { value: RESTORE_CONFIRMATION_PHRASE },
    });
    expect(screen.getByTestId('import-job-start')).toBeEnabled();
  });
});

/** Confirm a fresh import; `upload` is the store action the dialog then calls. */
async function startImport(upload: () => Promise<void>): Promise<void> {
  const createSpy = vi.fn(async () => {
    useImportJobStore.setState({ job: makeJob({ status: 'pending', bytesTotal: 2048 }) });
  });
  useImportJobStore.setState({ create: createSpy, upload: vi.fn(upload) });
  render(<VollstaendigerImportDialog file={makeFile()} onClose={vi.fn()} />);
  fireEvent.change(screen.getByTestId('import-job-phrase-input'), {
    target: { value: RESTORE_CONFIRMATION_PHRASE },
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId('import-job-start'));
  });
}

describe('VollstaendigerImportDialog — uploading (AC-602)', () => {
  it('AC-611: while this page uploads, shows `Hochladen …` and the byte readout from uploadOffset', async () => {
    // The upload is still in flight: it never resolves in this test.
    await startImport(() => {
      useImportJobStore.setState({ uploading: true, uploadOffset: 1536 });
      return new Promise<void>(() => {});
    });

    const dialog = screen.getByTestId('import-job-dialog');
    expect(within(dialog).getByRole('heading')).toHaveTextContent('Hochladen …');
    expect(dialog).not.toHaveTextContent('Upload unterbrochen');
    const bytes = within(dialog).getByTestId('import-job-upload-bytes');
    expect(bytes).toHaveAttribute('data-bytes-done', '1536');
    expect(bytes).toHaveAttribute('data-bytes-total', '2048');
  });
});

describe('VollstaendigerImportDialog — stalled upload (AC-609, AC-610, AC-611)', () => {
  it('AC-611: once this page sent the last chunk, it keeps `Hochladen …` until the restore starts', async () => {
    // The upload finished; the job row has not reached `running` yet.
    await startImport(async () => {
      useImportJobStore.setState({ uploadOffset: 2048 });
    });

    const dialog = screen.getByTestId('import-job-dialog');
    expect(within(dialog).getByRole('heading')).toHaveTextContent('Hochladen …');
    expect(within(dialog).getByTestId('import-job-upload-bytes')).toHaveAttribute(
      'data-bytes-done',
      '2048',
    );
  });

  it('AC-610: the size check follows the live job — a pending upload that arrives after the dialog opened', () => {
    render(<VollstaendigerImportDialog file={makeFile()} onClose={vi.fn()} />);
    act(() => {
      useImportJobStore.setState({ job: makeJob({ status: 'pending', bytesTotal: 4096 }) });
    });
    expect(screen.getByTestId('import-job-size-mismatch')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('import-job-phrase-input'), {
      target: { value: RESTORE_CONFIRMATION_PHRASE },
    });
    expect(screen.getByTestId('import-job-start')).toBeDisabled();
  });

  const INTERRUPTED = 'Upload unterbrochen. Zum Fortsetzen das Archiv über „Import“ erneut wählen.';

  it('AC-611, AC-603: re-attached to a pending upload, it says the upload is interrupted and shows the server progress', () => {
    useImportJobStore.setState({
      job: makeJob({ status: 'pending', bytesTotal: 4096, bytesDone: 1536 }),
    });
    render(<VollstaendigerImportDialog file={null} onClose={vi.fn()} />);

    const dialog = screen.getByTestId('import-job-dialog');
    expect(within(dialog).getByRole('heading')).toHaveTextContent(INTERRUPTED);
    expect(dialog).not.toHaveTextContent('Hochladen …');
    const bytes = within(dialog).getByTestId('import-job-upload-bytes');
    expect(bytes).toHaveAttribute('data-bytes-done', '1536');
    expect(bytes).toHaveAttribute('data-bytes-total', '4096');
  });

  it("AC-611: when this page's upload stops before it completes, it says the upload is interrupted", async () => {
    // The store's upload loop gives up (network gone): it returns, the job stays pending.
    await startImport(async () => {
      useImportJobStore.setState({ uploadOffset: 1536 });
    });

    const dialog = screen.getByTestId('import-job-dialog');
    expect(within(dialog).getByRole('heading')).toHaveTextContent(INTERRUPTED);
    expect(dialog).not.toHaveTextContent('Hochladen …');
  });

  it('AC-609: picking the archive of a pending upload shows the confirmation; Start continues that upload', async () => {
    const pending = makeJob({ id: 'stalled', status: 'pending', bytesTotal: 2048 });
    useImportJobStore.setState({ job: pending });
    // The server answers IMPORT_JOB_ACTIVE; the store re-attaches to the pending job.
    const createSpy = vi.fn(async () => {
      useImportJobStore.setState({ job: pending });
    });
    const uploadSpy = vi.fn(async () => {});
    useImportJobStore.setState({ create: createSpy, upload: uploadSpy });
    const file = makeFile();

    render(<VollstaendigerImportDialog file={file} onClose={vi.fn()} />);
    expect(screen.getByTestId('import-job-confirm')).toBeInTheDocument();
    expect(uploadSpy).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('import-job-phrase-input'), {
      target: { value: RESTORE_CONFIRMATION_PHRASE },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('import-job-start'));
    });

    // Continuing goes through create; the server answers IMPORT_JOB_ACTIVE and the store re-attaches.
    expect(createSpy).toHaveBeenCalledWith({
      file,
      override: true,
      phrase: RESTORE_CONFIRMATION_PHRASE,
    });
    await waitFor(() => expect(uploadSpy).toHaveBeenCalledWith(file));
  });

  it('AC-610: a file whose size differs from the pending upload is refused and nothing uploads', async () => {
    useImportJobStore.setState({ job: makeJob({ status: 'pending', bytesTotal: 4096 }) });
    const createSpy = vi.fn(async () => {});
    const uploadSpy = vi.fn(async () => {});
    useImportJobStore.setState({ create: createSpy, upload: uploadSpy });

    render(<VollstaendigerImportDialog file={makeFile()} onClose={vi.fn()} />);
    expect(screen.getByTestId('import-job-size-mismatch')).toHaveTextContent(
      'Diese Datei gehört nicht zum laufenden Import.',
    );
    fireEvent.change(screen.getByTestId('import-job-phrase-input'), {
      target: { value: RESTORE_CONFIRMATION_PHRASE },
    });
    const start = screen.getByTestId('import-job-start');
    expect(start).toBeDisabled();
    await act(async () => {
      fireEvent.click(start);
    });
    expect(createSpy).not.toHaveBeenCalled();
    expect(uploadSpy).not.toHaveBeenCalled();
  });
});

describe('VollstaendigerImportDialog — processing (AC-602)', () => {
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

describe('VollstaendigerImportDialog — summary + failed (AC-607, AC-587)', () => {
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
