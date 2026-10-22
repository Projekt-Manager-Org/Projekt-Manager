/**
 * BinaryList — synthetic-origin Service-Worker download path
 * (ADR-0024, spec ui/project-detail.md §8.15.5), browser-side
 * streaming-zip bulk-fetch pipeline (AC-433), and the lazy
 * placeholder branches (`"Datei fehlt"` AC-436, `"Schlüssel nicht
 * verfügbar"` AC-244, generic AC-437).
 *
 * Under the e2e contract:
 *   - The `Herunterladen` action issues a fetch / anchor click against
 *     `/encrypted-storage/<projectId>/<attachmentId>.original`; the SW
 *     intercepts, calls `download-url`, fetches the ciphertext from
 *     B2, AES-256-GCM-decrypts, and serves plaintext via the Fetch
 *     response. Bytes never round-trip the application server.
 *   - `Auswahl als ZIP` calls `POST /api/projects/:id/attachments/bulk-fetch`
 *     and gets back per-file `{originalUrl, originalDekMaterial, ...}`
 *     payloads. The browser streams each ciphertext
 *     through the streaming-zip pipeline, decrypts per-file with the
 *     returned DEK material, and produces a single download at the end.
 *   - Cap-breach selection is blocked client-side with a German
 *     validation message naming both caps before any request issues.
 *   - `<img onError>` analog for binaries: the SW returns a non-2xx
 *     Response on the download request; the row flips to the matching
 *     placeholder, the Herunterladen button is disabled, and the row
 *     is excluded from bulk-fetch selection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiResult } from '@/api/client';
import type { Attachment } from '@/domain/types';
import type { BulkFetchEntry } from '@/api/client';

type ListResult = ApiResult<{ data: Attachment[] }>;
type BulkFetchResult = ApiResult<{ data: BulkFetchEntry[] }>;

const listMock = vi.fn<(projectId: string) => Promise<ListResult>>();
const bulkFetchMock =
  vi.fn<(projectId: string, attachmentIds: string[]) => Promise<BulkFetchResult>>();

vi.mock('@/api/client', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    attachmentApi: {
      list: (...args: unknown[]) => listMock(...(args as Parameters<typeof listMock>)),
      // Under the SW-mediated path the BinaryList does not call
      // `downloadUrl` itself — the SW does on every Herunterladen
      // fetch. Stub it so the import-time mock is complete.
      downloadUrl: vi.fn(),
      bulkFetch: (...args: unknown[]) =>
        bulkFetchMock(...(args as Parameters<typeof bulkFetchMock>)),
      initUpload: vi.fn(),
      completeUpload: vi.fn(),
      delete: vi.fn(),
    },
    authApi: {
      login: vi.fn(),
      logout: vi.fn(),
      me: vi.fn().mockResolvedValue({ ok: false }),
    },
  };
});

const { BinaryList } = await import('@/ui/detail/BinaryList');
const { useAuthStore } = await import('@/state/authStore');
const { useAttachmentStore } = await import('@/state/attachmentStore');

function makeBinary(overrides: Partial<Attachment>): Attachment {
  return {
    id: 'bin-1',
    projectId: 'p-42',
    status: 'ready',
    kind: 'binary',
    label: 'rechnung',
    fileName: 'rechnung.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 200_000,
    originalKey: 'proj/p-42/bin-1/o.pdf',
    thumbKey: null,
    hasThumbnail: false,
    hiddenAt: null,
    createdAt: '2026-04-20T10:00:00Z',
    createdBy: { id: 'u-w1', displayName: 'Anna Arbeiter' },
    ...overrides,
  };
}

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

beforeEach(() => {
  listMock.mockReset();
  bulkFetchMock.mockReset();

  useAttachmentStore.setState({ byProject: {}, pendingUploads: {}, error: null });
  useAuthStore.setState({
    authUser: {
      id: 'u-1',
      username: 'owner',
      displayName: 'Owner',
      roles: ['owner'],
      email: null,
      themePreference: 'system',
      pushMuted: false,
    },
    authError: null,
    sessionChecked: true,
  });

  // Default list: two ready binaries + one ready photo (excluded from
  // binary list) + one pending binary (excluded until ready).
  listMock.mockResolvedValue(
    ok({
      data: [
        makeBinary({
          id: 'bin-pdf',
          fileName: 'angebot.pdf',
          label: 'angebot',
          sizeBytes: 120_000,
          createdBy: { id: 'u-w1', displayName: 'Anna Arbeiter' },
        }),
        makeBinary({
          id: 'bin-docx',
          fileName: 'auftrag.docx',
          label: 'auftragsbestaetigung',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sizeBytes: 80_000,
          createdBy: { id: 'u-w2', displayName: 'Bernd Bauer' },
        }),
        makeBinary({
          id: 'ph-1',
          kind: 'photo',
          mimeType: 'image/jpeg',
          fileName: 'photo.jpg',
          label: 'foto',
          hasThumbnail: true,
          thumbKey: 'proj/p-42/ph-1/thumb.webp',
        }),
        makeBinary({ id: 'bin-pending', status: 'pending', fileName: 'pending.pdf' }),
      ],
    }),
  );

  bulkFetchMock.mockResolvedValue(
    ok({
      data: [
        {
          attachmentId: 'bin-pdf',
          originalUrl: 'https://storage.example/cipher-pdf',
          originalDekMaterial: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          ciphertextSizeBytes: 120_000 + 28,
        },
        {
          attachmentId: 'bin-docx',
          originalUrl: 'https://storage.example/cipher-docx',
          originalDekMaterial: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          ciphertextSizeBytes: 80_000 + 28,
        },
      ] as BulkFetchEntry[],
    }),
  );
});

describe('BinaryList — Herunterladen routes through synthetic origin (AC-409, AC-417)', () => {
  it('renders one row per ready binary with filename / label / uploader / timestamp', async () => {
    render(<BinaryList projectId="p-42" bundleFileName="P-2026-042_Test-Projekt.zip" />);

    // Resolve rows by per-row testid rather than text-matching: pins
    // the row contract independent of German labels.
    const pdfRow = await screen.findByTestId('attachment-binary-row-bin-pdf');
    const docxRow = await screen.findByTestId('attachment-binary-row-bin-docx');
    expect(docxRow).toBeDefined();
    expect(pdfRow.textContent).toContain('angebot.pdf');
    expect(pdfRow.textContent?.toLowerCase()).toContain('angebot');
    expect(pdfRow.textContent).toContain('Anna Arbeiter');
    // Timestamp is rendered via the German date formatter — the year
    // alone is a stable proxy for "the createdAt cell rendered something".
    expect(pdfRow.textContent).toContain('2026');
    expect(within(pdfRow).getByTestId('attachment-download')).toBeInTheDocument();
  });

  it('excludes photo and pending rows from the binary list', async () => {
    render(<BinaryList projectId="p-42" bundleFileName="P-2026-042_Test-Projekt.zip" />);
    await screen.findByTestId('attachment-binary-row-bin-pdf');
    expect(screen.queryByTestId('attachment-binary-row-ph-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('attachment-binary-row-bin-pending')).not.toBeInTheDocument();
  });

  it('Herunterladen issues a request against /encrypted-storage/<projectId>/<attachmentId>.original', async () => {
    // The single-file download path goes through the synthetic origin
    // (ui/project-detail.md §8.15.5). The component issues a fetch
    // against the synthetic URL; the SW intercepts the request, calls
    // download-url, decrypts the ciphertext, and returns plaintext
    // bytes through the Fetch response. On 200 the component wraps
    // the response in a Blob URL and triggers an `<a download>` —
    // the test checks both: the synthetic URL was fetched, and an
    // anchor was appended afterwards (the click drives the browser
    // download dialog).
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]).slice()));

    const appendedAnchors: HTMLAnchorElement[] = [];
    const originalAppendChild = document.body.appendChild.bind(document.body);
    const appendChildSpy = vi.fn((node: Node) => {
      if (node instanceof HTMLAnchorElement) {
        appendedAnchors.push(node);
        // No-op the click — jsdom would otherwise navigate the test
        // window to a Blob URL it cannot resolve.
        (node as HTMLAnchorElement & { click: () => void }).click = vi.fn();
      }
      return originalAppendChild(node) as Node;
    });
    document.body.appendChild = appendChildSpy as unknown as typeof document.body.appendChild;

    try {
      render(<BinaryList projectId="p-42" bundleFileName="P-2026-042_Test-Projekt.zip" />);
      const pdfRow = await screen.findByTestId('attachment-binary-row-bin-pdf');
      await userEvent.click(within(pdfRow).getByTestId('attachment-download'));

      // Synthetic URL fetched — the SW seam (in production) intercepts
      // here; in jsdom the spy's resolved Response stands in for the
      // SW's plaintext output.
      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalled();
      });
      const calledUrls = fetchSpy.mock.calls.map(([input]) =>
        typeof input === 'string' ? input : ((input as Request).url ?? String(input)),
      );
      expect(calledUrls.some((u) => u.endsWith('/encrypted-storage/p-42/bin-pdf.original'))).toBe(
        true,
      );

      // Anchor appended with the Blob URL + download attribute set to
      // the file's name — the user-gesture continuation that triggers
      // the browser save dialog.
      await waitFor(() => {
        expect(appendedAnchors.length).toBeGreaterThan(0);
      });
      const anchor = appendedAnchors[0];
      expect(anchor.download).toBe('angebot.pdf');
      expect(anchor.href.startsWith('blob:')).toBe(true);
    } finally {
      fetchSpy.mockRestore();
      document.body.appendChild = originalAppendChild;
    }
  });
});

describe('BinaryList — Auswahl als ZIP triggers bulk-fetch (AC-433)', () => {
  it('shows Auswahl als ZIP only once at least one row is selected', async () => {
    render(<BinaryList projectId="p-42" bundleFileName="P-2026-042_Test-Projekt.zip" />);
    const pdfRow = await screen.findByTestId('attachment-binary-row-bin-pdf');

    expect(screen.queryByTestId('binary-bulk-download')).not.toBeInTheDocument();

    await userEvent.click(within(pdfRow).getByRole('checkbox'));

    expect(await screen.findByTestId('binary-bulk-download')).toBeInTheDocument();
  });

  it('blocks a selection above the caps with a German message naming both caps (AC-435)', async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      makeBinary({ id: `bin-${i}`, fileName: `file-${i}.pdf`, sizeBytes: 1_000_000 }),
    );
    listMock.mockResolvedValue(ok({ data: many }));

    render(<BinaryList projectId="p-42" bundleFileName="P-2026-042_Test-Projekt.zip" />);
    await screen.findByTestId('attachment-binary-row-bin-0');

    await userEvent.click(screen.getByTestId('binary-select-all'));
    await userEvent.click(screen.getByTestId('binary-bulk-download'));

    const block = await screen.findByTestId('binary-bulk-limit-error');
    // The German validation message names BOTH caps (files + bytes).
    expect(block.textContent?.toLowerCase()).toMatch(/datei/);
    expect(block.textContent?.toLowerCase()).toMatch(/mb|byte|gr[oö]ße/);

    // Client-side block — no network call to the server.
    expect(bulkFetchMock).not.toHaveBeenCalled();
  });

  it('calls bulk-fetch with the selected ids and triggers a Blob-URL download of the assembled zip', async () => {
    // The component delegates zip assembly to the store's
    // `requestBulkZipBlob`, which calls `attachmentApi.bulkFetch` and
    // streams the per-file ciphertexts through `client-zip` after
    // per-file decryption. Replace the store action with a stub so
    // this component test is not coupled to the store's encryption
    // path (covered by `state/__tests__/attachmentStore.test.ts`).
    const requestBulkZipBlobStub = vi
      .fn()
      .mockResolvedValue(new Blob([new Uint8Array(8)], { type: 'application/zip' }));
    useAttachmentStore.setState({
      requestBulkZipBlob: requestBulkZipBlobStub as unknown as ReturnType<
        typeof useAttachmentStore.getState
      >['requestBulkZipBlob'],
    });

    const appendedAnchors: HTMLAnchorElement[] = [];
    const originalAppendChild = document.body.appendChild.bind(document.body);
    const appendChildSpy = vi.fn((node: Node) => {
      if (node instanceof HTMLAnchorElement) {
        appendedAnchors.push(node);
        (node as HTMLAnchorElement & { click: () => void }).click = vi.fn();
      }
      return originalAppendChild(node) as Node;
    });
    document.body.appendChild = appendChildSpy as unknown as typeof document.body.appendChild;

    try {
      render(<BinaryList projectId="p-42" bundleFileName="P-2026-042_Test-Projekt.zip" />);
      const pdfRow = await screen.findByTestId('attachment-binary-row-bin-pdf');
      const docxRow = await screen.findByTestId('attachment-binary-row-bin-docx');

      await userEvent.click(within(pdfRow).getByRole('checkbox'));
      await userEvent.click(within(docxRow).getByRole('checkbox'));
      await userEvent.click(screen.getByTestId('binary-bulk-download'));

      // Wire contract: the component delegates to `requestBulkZipBlob`
      // with the selected ids; the store internally hits
      // `POST /api/projects/:id/attachments/bulk-fetch`.
      await waitFor(() => {
        expect(requestBulkZipBlobStub).toHaveBeenCalledTimes(1);
      });
      const [callProjectId, callIds] = requestBulkZipBlobStub.mock.calls[0];
      expect(callProjectId).toBe('p-42');
      expect(new Set(callIds)).toEqual(new Set(['bin-pdf', 'bin-docx']));

      // Anchor appended with a Blob URL of the assembled zip — the
      // user-gesture continuation that triggers the browser save dialog.
      await waitFor(() => {
        expect(appendedAnchors.length).toBeGreaterThan(0);
      });
      const anchor = appendedAnchors[0];
      expect(anchor.href.startsWith('blob:')).toBe(true);
      expect(anchor.download).toBeTruthy();
    } finally {
      document.body.appendChild = originalAppendChild;
    }
  });
});

/** The SW's storage-404 answer: the code rides on the response header (signal contract, `src/sw/decryptHandler.ts`). */
function objectAbsentResponse(): Response {
  return new Response(JSON.stringify({ code: 'OBJECT_ABSENT' }), {
    status: 404,
    headers: { 'content-type': 'application/json', 'data-sw-error-code': 'OBJECT_ABSENT' },
  });
}

describe('BinaryList — "Datei fehlt" on download 404 (AC-436 binary side)', () => {
  it('flips the row to "Datei fehlt" and disables the download when the SW signals object-absent', async () => {
    // Lazy detection: the list endpoint
    // does not probe storage. The UI learns bytes are missing when the
    // user clicks Herunterladen and the SW's ciphertext fetch resolves
    // to a non-2xx Response (storage 404). The component flags the row
    // and disables the action.
    //
    // Mock global fetch with the SW's translated storage-404 response.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(objectAbsentResponse());

    try {
      render(<BinaryList projectId="p-42" bundleFileName="P-2026-042_Test-Projekt.zip" />);

      const pdfRow = await screen.findByTestId('attachment-binary-row-bin-pdf');
      await userEvent.click(within(pdfRow).getByTestId('attachment-download'));

      await waitFor(() => {
        expect(within(pdfRow).getByText(/datei fehlt/i)).toBeInTheDocument();
      });

      expect(within(pdfRow).getByTestId('attachment-download')).toBeDisabled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('excludes a "Datei fehlt" row from bulk-fetch selection', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(objectAbsentResponse());

    try {
      render(<BinaryList projectId="p-42" bundleFileName="P-2026-042_Test-Projekt.zip" />);

      const pdfRow = await screen.findByTestId('attachment-binary-row-bin-pdf');
      await userEvent.click(within(pdfRow).getByTestId('attachment-download'));

      await waitFor(() => {
        expect(within(pdfRow).getByText(/datei fehlt/i)).toBeInTheDocument();
      });

      const checkbox = within(pdfRow).queryByRole('checkbox');
      if (checkbox) expect(checkbox).toBeDisabled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('BinaryList — download failure without an SW code (AC-437)', () => {
  it('shows "Datei konnte nicht geladen werden", not "Datei fehlt", and keeps download + delete enabled', async () => {
    // The page is not controlled by the SW: the request reaches the
    // server, which answers an uncoded 404 ROUTE_NOT_FOUND. Nothing is
    // known about the bytes — a second click re-fetches.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        Response.json({ code: 'ROUTE_NOT_FOUND', message: 'not found' }, { status: 404 }),
      );

    try {
      render(<BinaryList projectId="p-42" bundleFileName="P-2026-042_Test-Projekt.zip" />);

      const pdfRow = await screen.findByTestId('attachment-binary-row-bin-pdf');
      await userEvent.click(within(pdfRow).getByTestId('attachment-download'));

      await waitFor(() => {
        expect(within(pdfRow).getByText('Datei konnte nicht geladen werden')).toBeInTheDocument();
      });
      expect(within(pdfRow).queryByText(/datei fehlt/i)).not.toBeInTheDocument();
      expect(within(pdfRow).getByTestId('attachment-delete')).toBeInTheDocument();

      const download = within(pdfRow).getByTestId('attachment-download');
      expect(download).toBeEnabled();
      await userEvent.click(download);
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('renders the generic state on a transport drop', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));

    try {
      render(<BinaryList projectId="p-42" bundleFileName="P-2026-042_Test-Projekt.zip" />);

      const pdfRow = await screen.findByTestId('attachment-binary-row-bin-pdf');
      await userEvent.click(within(pdfRow).getByTestId('attachment-download'));

      await waitFor(() => {
        expect(within(pdfRow).getByText('Datei konnte nicht geladen werden')).toBeInTheDocument();
      });
      expect(within(pdfRow).queryByText(/datei fehlt/i)).not.toBeInTheDocument();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('drops the badge once a retry succeeds', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({ code: 'ROUTE_NOT_FOUND', message: 'not found' }, { status: 404 }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]).slice()));
    // No-op the anchor click — jsdom cannot navigate to a Blob URL.
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    try {
      render(<BinaryList projectId="p-42" bundleFileName="P-2026-042_Test-Projekt.zip" />);

      const pdfRow = await screen.findByTestId('attachment-binary-row-bin-pdf');
      const download = within(pdfRow).getByTestId('attachment-download');
      await userEvent.click(download);
      await within(pdfRow).findByText('Datei konnte nicht geladen werden');

      await userEvent.click(download);
      await waitFor(() => {
        expect(
          within(pdfRow).queryByText('Datei konnte nicht geladen werden'),
        ).not.toBeInTheDocument();
      });
      expect(clickSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      clickSpy.mockRestore();
    }
  });
});

describe('BinaryList — Schlüssel nicht verfügbar render (AC-244)', () => {
  it('flips the row to "Schlüssel nicht verfügbar" when the SW signals envelope-unwrap failure', async () => {
    // Per AC-244: an envelope unwrap
    // failure on the SW's download-url call (e.g. partial key rotation,
    // recipient drift) surfaces a distinct German placeholder from
    // AC-436. The SW returns a 422 Response carrying
    // `{ code: 'DEK_UNWRAP_FAILED' }`; the component reads the body
    // (or an equivalent SW-attached header) to disambiguate. The
    // German label is locked at the component layer.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'DEK_UNWRAP_FAILED' }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      }),
    );

    try {
      render(<BinaryList projectId="p-42" bundleFileName="P-2026-042_Test-Projekt.zip" />);

      const pdfRow = await screen.findByTestId('attachment-binary-row-bin-pdf');
      await userEvent.click(within(pdfRow).getByTestId('attachment-download'));

      await waitFor(() => {
        expect(within(pdfRow).getByText(/schlüssel nicht verfügbar/i)).toBeInTheDocument();
      });

      // Download disabled and the row excluded from bulk-fetch
      // selection — same exclusion rule as AC-436 with a different
      // remediation prompt.
      expect(within(pdfRow).getByTestId('attachment-download')).toBeDisabled();
      const checkbox = within(pdfRow).queryByRole('checkbox');
      if (checkbox) expect(checkbox).toBeDisabled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
