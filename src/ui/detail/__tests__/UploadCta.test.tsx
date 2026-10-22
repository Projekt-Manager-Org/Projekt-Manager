/**
 * UploadCta — upload failure banner + "Erneut versuchen" retry.
 *
 * Covers AC-225: on any upload failure (network error, storage 4xx/5xx,
 * complete returning a conflict) the row renders a red German error
 * banner plus a `Erneut versuchen` action that restarts the flow from
 * init. No silent retry.
 *
 * The flow is:
 *   1. user picks a file → init call is made
 *   2. init fails → banner renders with the server-supplied German
 *      message (or the canonical fallback), plus Erneut versuchen
 *   3. user clicks Erneut versuchen → init is called again
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiResult, AttachmentInitResponse } from '@/api/client';
import type { Attachment, AttachmentLabel } from '@/domain/types';
import { ATTACHMENT_LABELS } from '@/domain/attachments';

type InitResult = ApiResult<AttachmentInitResponse>;

type InitInput = {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  label: AttachmentLabel;
  hasThumbnail: boolean;
};

const initMock = vi.fn<(projectId: string, input: InitInput) => Promise<InitResult>>();
const completeMock = vi.fn();
const listMock = vi.fn().mockResolvedValue({ ok: true, data: { data: [] } });

vi.mock('@/api/client', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    attachmentApi: {
      list: (...args: unknown[]) => listMock(...args),
      initUpload: (...args: unknown[]) => initMock(...(args as Parameters<typeof initMock>)),
      completeUpload: (...args: unknown[]) => completeMock(...args),
      delete: vi.fn(),
      downloadUrl: vi.fn(),
      bulkFetch: vi.fn(),
    },
    authApi: {
      login: vi.fn(),
      logout: vi.fn(),
      me: vi.fn().mockResolvedValue({ ok: false }),
    },
  };
});

const { UploadCta } = await import('@/ui/detail/UploadCta');
const { useAuthStore } = await import('@/state/authStore');
const { useAttachmentStore } = await import('@/state/attachmentStore');

function makeAttachment(): Attachment {
  return {
    id: 'att-new',
    projectId: 'p-42',
    status: 'pending',
    kind: 'photo',
    label: 'foto',
    fileName: 'photo.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 100_000,
    originalKey: 'proj/p-42/att-new/o.jpg',
    thumbKey: 'proj/p-42/att-new/thumb.webp',
    hasThumbnail: true,
    hiddenAt: null,
    createdAt: '2026-04-20T10:00:00Z',
    createdBy: { id: 'u-1', displayName: 'Test User' },
  };
}

beforeEach(() => {
  initMock.mockReset();
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
});

async function pickFile(): Promise<void> {
  const input = screen.getByTestId('attachment-photo-input') as HTMLInputElement;
  const file = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });
  await userEvent.upload(input, file);
}

describe('UploadCta — failure banner (AC-225)', () => {
  it('renders the German error message and a Erneut versuchen action on init failure', async () => {
    initMock.mockResolvedValue({
      ok: false,
      error: { code: 'SERVER_ERROR', message: 'Upload fehlgeschlagen.' },
      category: 'server_error',
      sessionExpired: false,
    });

    render(<UploadCta projectId="p-42" />);
    await pickFile();

    const banner = await screen.findByTestId('upload-error-banner');
    expect(banner.textContent).toContain('Upload fehlgeschlagen');
    expect(screen.getByTestId('upload-retry')).toBeInTheDocument();
  });

  it('falls back to the canonical German error on network rejection', async () => {
    initMock.mockRejectedValue(new Error('fetch failed'));

    render(<UploadCta projectId="p-42" />);
    await pickFile();

    const banner = await screen.findByTestId('upload-error-banner');
    expect(banner.textContent).toContain('Änderung fehlgeschlagen');
  });
});

describe('UploadCta — Erneut versuchen restarts init (AC-225)', () => {
  it('invokes initUpload again when the retry action is clicked', async () => {
    initMock.mockResolvedValue({
      ok: false,
      error: { code: 'SERVER_ERROR', message: 'Upload fehlgeschlagen.' },
      category: 'server_error',
      sessionExpired: false,
    });

    render(<UploadCta projectId="p-42" />);
    await pickFile();

    await waitFor(() => {
      expect(initMock).toHaveBeenCalledTimes(1);
    });

    await userEvent.click(await screen.findByTestId('upload-retry'));

    await waitFor(() => {
      expect(initMock).toHaveBeenCalledTimes(2);
    });
  });

  it('retry succeeds when init recovers — banner is cleared', async () => {
    // First attempt fails, second attempt succeeds end-to-end. The
    // previous version of this test relied on a broken ack set that
    // masked any downstream failure behind "retry clicked"; post-fix
    // the banner only clears when the upload actually completes, so
    // we stub every network step of the happy path.
    initMock
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'SERVER_ERROR', message: 'Upload fehlgeschlagen.' },
        category: 'server_error',
        sessionExpired: false,
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          attachment: makeAttachment(),
          originalUpload: {
            url: 'https://storage/put',
            headers: {
              'Content-Type': 'image/jpeg',
              'Content-Length': '3',
              'Content-MD5': '1B2M2Y8AsgTpgAmY7PhCfg==',
            },
            expiresAt: '2026-04-20T10:05:00Z',
          },
          thumbnailUpload: {
            url: 'https://storage/put-thumb',
            headers: {
              'Content-Type': 'image/webp',
              'Content-Length': '3',
              'Content-MD5': '1B2M2Y8AsgTpgAmY7PhCfg==',
            },
            expiresAt: '2026-04-20T10:05:00Z',
          },
        },
      });
    // Presigned PUTs — return a 200 so `putPresigned` reads `ok`.
    const fetchStub = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchStub as unknown as typeof globalThis.fetch;
    // Complete call — succeeds, which triggers `removePending` and drops
    // the banner for good.
    completeMock.mockResolvedValue({ ok: true, data: makeAttachment() });

    try {
      render(<UploadCta projectId="p-42" />);
      await pickFile();
      await screen.findByTestId('upload-error-banner');

      await userEvent.click(screen.getByTestId('upload-retry'));

      await waitFor(() => {
        expect(screen.queryByTestId('upload-error-banner')).not.toBeInTheDocument();
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('UploadCta — no silent retry (AC-225)', () => {
  it('does not auto-retry after a failure — only the manual action does', async () => {
    initMock.mockResolvedValue({
      ok: false,
      error: { code: 'SERVER_ERROR', message: 'Upload fehlgeschlagen.' },
      category: 'server_error',
      sessionExpired: false,
    });

    render(<UploadCta projectId="p-42" />);
    await pickFile();

    await screen.findByTestId('upload-error-banner');

    // Give the microtask + effect queue time to run. A regression that
    // silently re-tries would raise the call count above 1 here.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(initMock).toHaveBeenCalledTimes(1);
  });
});

describe('UploadCta — closed-enum label dropdown (AC-446)', () => {
  it('renders a label selector populated with the document (non-photo) labels', async () => {
    // The dropdown belongs to the document block — photos are hardcoded
    // to `foto`, so `foto` is excluded from the picker. The remaining
    // options are the closed enum minus `foto`.
    render(<UploadCta projectId="p-42" />);
    await pickFile();

    const select = (await screen.findByTestId('upload-label-select')) as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    const expected = ATTACHMENT_LABELS.map((l) => l.value).filter((v) => v !== 'foto');
    expect(new Set(optionValues)).toEqual(new Set(expected));
  });

  it('does not expose a free-text input for the label', async () => {
    // A free-text input for labels would let the user persist a value
    // outside the closed catalog — the catalog is closed precisely to
    // prevent that (see domain/attachments.ts and the [C] catalogue).
    render(<UploadCta projectId="p-42" />);
    await pickFile();

    expect(screen.queryByTestId('upload-label-input')).not.toBeInTheDocument();
  });
});
