/**
 * PhotoGallery — synthetic-origin Service-Worker render path
 * (ADR-0024, spec ui/project-detail.md §8.15.4) plus the lazy
 * placeholder branches (`"Datei fehlt"` AC-436, `"Schlüssel nicht
 * verfügbar"` AC-244, generic AC-437).
 *
 * Under the e2e contract:
 *   - Each `<img src>` points at `/encrypted-storage/<projectId>/<attachmentId>.thumbnail`;
 *     the Service Worker (out of scope here, see `src/sw/__tests__/sw-decrypt.test.ts`)
 *     intercepts the request, calls the `download-url` endpoint to
 *     obtain `{url, expiresAt, dekMaterial}`, fetches the ciphertext
 *     from B2, AES-256-GCM-decrypts, and serves plaintext bytes via
 *     the Fetch response.
 *   - Lightbox flips to `.original` under the same synthetic origin.
 *   - `<img onError>` is the integration seam: the SW returns a non-2xx
 *     Response on either an object-absent path (AC-436) or an
 *     envelope-unwrap failure (AC-244), and the gallery flips the row
 *     to the matching German placeholder. A failure without either code
 *     renders the generic load-failure placeholder (AC-437).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiResult } from '@/api/client';
import type { Attachment } from '@/domain/types';

type ListResult = ApiResult<{ data: Attachment[] }>;

const listMock = vi.fn<(projectId: string) => Promise<ListResult>>();

vi.mock('@/api/client', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    attachmentApi: {
      list: (...args: unknown[]) => listMock(...(args as Parameters<typeof listMock>)),
      // Under the SW-mediated render path the gallery no longer calls
      // `downloadUrl` itself — the SW does on each `<img>` fetch. We
      // still stub the surface so the import-time mock is complete.
      downloadUrl: vi.fn(),
      bulkFetch: vi.fn(),
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

const { PhotoGallery } = await import('@/ui/detail/PhotoGallery');
const { useAuthStore } = await import('@/state/authStore');
const { useAttachmentStore } = await import('@/state/attachmentStore');

function makePhoto(overrides: Partial<Attachment>): Attachment {
  return {
    id: 'ph-1',
    projectId: 'p-42',
    status: 'ready',
    kind: 'photo',
    label: 'foto',
    fileName: 'photo-1.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 200_000,
    originalKey: 'proj/p-42/att/ph-1/o.jpg',
    thumbKey: 'proj/p-42/att/ph-1/thumb.webp',
    hasThumbnail: true,
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
  useAttachmentStore.setState({ byProject: {}, pendingUploads: {}, error: null });

  // Default list: one ready photo + one binary + one pending photo.
  listMock.mockResolvedValue(
    ok({
      data: [
        makePhoto({ id: 'ph-ready', fileName: 'ready.jpg' }),
        makePhoto({
          id: 'bin-1',
          kind: 'binary',
          mimeType: 'application/pdf',
          fileName: 'doc.pdf',
          hasThumbnail: false,
          thumbKey: null,
          label: 'rechnung',
        }),
        makePhoto({ id: 'ph-pending', status: 'pending', fileName: 'pending.jpg' }),
      ],
    }),
  );
});

describe('PhotoGallery — renders ready photo thumbnails (AC-409)', () => {
  it('points each ready-photo <img src> at the synthetic-origin thumbnail path', async () => {
    render(<PhotoGallery projectId="p-42" />);

    const thumb = await screen.findByTestId('photo-thumb-ph-ready');
    const img = thumb.querySelector('img');
    expect(img).not.toBeNull();
    // Synthetic origin (ADR-0024) — the SW path behind AC-416. The browser-internal scheme has no TTL and no
    // cache headers leaked.
    expect(img?.getAttribute('src')).toBe('/encrypted-storage/p-42/ph-ready.thumbnail');
  });

  it('does not render a thumbnail for binary or pending attachments', async () => {
    render(<PhotoGallery projectId="p-42" />);

    await screen.findByTestId('photo-thumb-ph-ready');

    // Binary attachments live in the BinaryList, not the gallery — see
    // BinaryList.test.tsx. Pending rows are excluded from both surfaces
    // until `complete()` flips them to ready.
    expect(screen.queryByTestId('photo-thumb-bin-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('photo-thumb-ph-pending')).not.toBeInTheDocument();
  });
});

describe('PhotoGallery — lightbox requests the original variant (ui/project-detail.md §8.15.4)', () => {
  it('flips the open <img src> to the synthetic-origin original variant on click', async () => {
    render(<PhotoGallery projectId="p-42" />);

    const thumb = await screen.findByTestId('photo-thumb-ph-ready');
    await userEvent.click(thumb);

    const lightbox = await screen.findByTestId('photo-lightbox');
    const lightboxImg = lightbox.querySelector('img');
    expect(lightboxImg).not.toBeNull();
    // Same synthetic origin, `.original` instead of `.thumbnail`. The
    // SW will fetch + decrypt the original ciphertext on demand.
    expect(lightboxImg?.getAttribute('src')).toBe('/encrypted-storage/p-42/ph-ready.original');
  });
});

describe('PhotoGallery — lightbox a11y', () => {
  it('closes the lightbox on Escape', async () => {
    render(<PhotoGallery projectId="p-42" />);
    const thumb = await screen.findByTestId('photo-thumb-ph-ready');
    await userEvent.click(thumb);

    expect(await screen.findByTestId('photo-lightbox')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByTestId('photo-lightbox')).not.toBeInTheDocument();
    });
  });

  it('closes the lightbox when the X close button is clicked', async () => {
    render(<PhotoGallery projectId="p-42" />);
    const thumb = await screen.findByTestId('photo-thumb-ph-ready');
    await userEvent.click(thumb);

    await screen.findByTestId('photo-lightbox');
    await userEvent.click(screen.getByTestId('photo-lightbox-close'));

    await waitFor(() => {
      expect(screen.queryByTestId('photo-lightbox')).not.toBeInTheDocument();
    });
  });

  it('keeps the lightbox open when the backdrop or the photo itself is clicked', async () => {
    render(<PhotoGallery projectId="p-42" />);
    const thumb = await screen.findByTestId('photo-thumb-ph-ready');
    await userEvent.click(thumb);

    const lightbox = await screen.findByTestId('photo-lightbox');
    await userEvent.click(lightbox);
    expect(screen.getByTestId('photo-lightbox')).toBeInTheDocument();

    const innerImg = lightbox.querySelector('img');
    expect(innerImg).not.toBeNull();
    await userEvent.click(innerImg!);
    expect(screen.getByTestId('photo-lightbox')).toBeInTheDocument();
  });

  it('restores focus to the thumbnail that opened the lightbox on close', async () => {
    render(<PhotoGallery projectId="p-42" />);
    const thumb = await screen.findByTestId('photo-thumb-ph-ready');
    await userEvent.click(thumb);

    await screen.findByTestId('photo-lightbox');

    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByTestId('photo-lightbox')).not.toBeInTheDocument();
    });
    // Focus returns to the thumbnail that opened the lightbox so
    // keyboard users stay anchored to their point of entry instead of
    // dropping to document root.
    expect(document.activeElement).toBe(thumb);
  });
});

describe('PhotoGallery — "Datei fehlt" render (AC-436 photo side)', () => {
  it('renders the "Datei fehlt" placeholder when the SW signals object-absent on the thumbnail', async () => {
    // Lazy detection: the list endpoint
    // does not probe storage. The UI learns bytes are missing only when
    // the `<img>` decode fails — the SW returned a non-2xx Response
    // because the ciphertext GET hit a storage 404. Distinct from
    // AC-244: the operator remediation differs (storage divergence vs.
    // identity drift). Both placeholders disable the download action
    // and exclude the row from the lightbox + bulk-fetch selection.
    render(<PhotoGallery projectId="p-42" />);

    const thumb = await screen.findByTestId('photo-thumb-ph-ready');
    const img = thumb.querySelector('img');
    expect(img).not.toBeNull();

    // The SW mirrors OBJECT_ABSENT onto the `<img>` before the error
    // event fires (signal contract, `src/sw/decryptHandler.ts`).
    img!.setAttribute('data-sw-error-code', 'OBJECT_ABSENT');
    fireEvent.error(img!, { target: img });

    const placeholder = await screen.findByTestId('photo-missing-ph-ready');
    expect(placeholder.textContent).toContain('Datei fehlt');
  });

  it('excludes a "Datei fehlt" row from the lightbox + bulk-fetch selection (clicking the placeholder is a no-op)', async () => {
    render(<PhotoGallery projectId="p-42" />);

    const thumb = await screen.findByTestId('photo-thumb-ph-ready');
    const img = thumb.querySelector('img');
    img!.setAttribute('data-sw-error-code', 'OBJECT_ABSENT');
    fireEvent.error(img!, { target: img });

    const placeholder = await screen.findByTestId('photo-missing-ph-ready');
    await userEvent.click(placeholder);

    expect(screen.queryByTestId('photo-lightbox')).not.toBeInTheDocument();
  });
});

describe('PhotoGallery — load failure without an SW code (AC-437)', () => {
  it('renders "Datei konnte nicht geladen werden", not "Datei fehlt", and keeps the delete action', async () => {
    // No code on the `<img>`: the SW did not answer (page not controlled,
    // the request reached the server) or failed without a pinned code.
    // Nothing is known about the bytes, so the row stays deletable.
    render(<PhotoGallery projectId="p-42" />);

    const thumb = await screen.findByTestId('photo-thumb-ph-ready');
    const img = thumb.querySelector('img');
    fireEvent.error(img!, { target: img });

    const placeholder = await screen.findByTestId('photo-load-failed-ph-ready');
    expect(placeholder.textContent).toContain('Datei konnte nicht geladen werden');
    expect(screen.queryByText('Datei fehlt')).not.toBeInTheDocument();
    expect(screen.getByTestId('attachment-delete')).toBeInTheDocument();
  });

  it('re-requests the thumbnail once the SW takes control of the page', async () => {
    // First visit: the thumbnail fetch ran before the SW claimed the
    // page. The SW's `controllerchange` is the subsequent attempt.
    const sw = new EventTarget();
    Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });

    try {
      render(<PhotoGallery projectId="p-42" />);

      const img = (await screen.findByTestId('photo-thumb-ph-ready')).querySelector('img');
      fireEvent.error(img!, { target: img });
      await screen.findByTestId('photo-load-failed-ph-ready');

      act(() => {
        sw.dispatchEvent(new Event('controllerchange'));
      });

      const retried = await screen.findByTestId('photo-thumb-ph-ready');
      expect(retried.querySelector('img')).not.toBe(img);
    } finally {
      Reflect.deleteProperty(navigator, 'serviceWorker');
    }
  });
});

describe('PhotoGallery — Schlüssel nicht verfügbar render (AC-244)', () => {
  it('renders the "Schlüssel nicht verfügbar" placeholder when the SW signals envelope-unwrap failure', async () => {
    // Per AC-244: an envelope unwrap
    // failure (e.g. partial key rotation in progress, recipient drift)
    // surfaces a distinct placeholder from AC-436. The SW's
    // download-url request returns 422 DEK_UNWRAP_FAILED; the SW
    // translates that into a non-2xx Response carrying the code so
    // `<img onError>` can disambiguate. The German label is locked at
    // the gallery layer so a string-table edit can't silently drop it.
    render(<PhotoGallery projectId="p-42" />);

    const thumb = await screen.findByTestId('photo-thumb-ph-ready');
    const img = thumb.querySelector('img');
    expect(img).not.toBeNull();

    // Mark the `<img>` as the unwrap-failure variant so the gallery's
    // `onError` handler reads the cause attribute and routes to AC-244
    // instead of AC-436. The exact attribute name is the implementer's
    // choice — the test pins it to `data-sw-error-code` because the SW
    // is the single seam that knows the reason. If the implementer
    // picks a different attribute, this test breaks loudly and the
    // change is visible.
    img!.setAttribute('data-sw-error-code', 'DEK_UNWRAP_FAILED');
    fireEvent.error(img!, { target: img });

    const placeholder = await screen.findByTestId('photo-key-unavailable-ph-ready');
    expect(placeholder.textContent).toContain('Schlüssel nicht verfügbar');
  });

  it('excludes the placeholder row from the lightbox on click', async () => {
    render(<PhotoGallery projectId="p-42" />);

    const thumb = await screen.findByTestId('photo-thumb-ph-ready');
    const img = thumb.querySelector('img');
    img!.setAttribute('data-sw-error-code', 'DEK_UNWRAP_FAILED');
    fireEvent.error(img!, { target: img });

    const placeholder = await screen.findByTestId('photo-key-unavailable-ph-ready');
    await userEvent.click(placeholder);
    // Clicking the placeholder must not open the lightbox — same
    // exclusion rule as AC-436. The "download disabled" contract from
    // AC-244 lives on BinaryList (where per-row downloads exist) and
    // is asserted there; the gallery surface has no per-row download
    // button to disable.
    expect(screen.queryByTestId('photo-lightbox')).not.toBeInTheDocument();
  });
});
