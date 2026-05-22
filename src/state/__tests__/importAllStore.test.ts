/**
 * importAllStore — wrapper-contract tests.
 *
 * The runner hook (`useImportAllRunner`) captures the bearer
 * `importToken` from `postTextLeg`'s response and forwards it on every
 * subsequent binary-leg call via `importInit` / `importComplete` /
 * `importDelete`. These wrappers' job is to:
 *
 *   1. Pass the `authToken` argument verbatim to the underlying
 *      `attachmentApi.*` call.
 *   2. Preserve the API `code` on the thrown Error so the orchestrator
 *      can escalate `IMPORT_TOKEN_INVALID` to a fatal phase rather than
 *      bucket it into per-entry skips.
 *
 * Both properties were missing pre-#232's review pass — the
 * orchestrator caught a generic Error and surfaced it as one of N
 * identical per-attachment failures. These tests pin the contract
 * the orchestrator now relies on.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ApiResult,
  AttachmentInitResponse,
  AttachmentDownloadUrlResponse,
  BulkFetchResponse,
} from '@/api/client';
import type { Attachment, AttachmentLabel } from '@/domain/types';

type InitInput = {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  label: AttachmentLabel;
  hasThumbnail: boolean;
  dekMaterial: string;
  ciphertextSizeBytes: number;
  ciphertextContentMd5: string;
  restore?: { id: string; createdBy: string; createdAt: string };
};

const initMock =
  vi.fn<
    (
      projectId: string,
      input: InitInput,
      signal?: AbortSignal,
      authToken?: string,
    ) => Promise<ApiResult<AttachmentInitResponse>>
  >();
const completeMock =
  vi.fn<
    (
      projectId: string,
      attachmentId: string,
      signal?: AbortSignal,
      authToken?: string,
    ) => Promise<ApiResult<Attachment>>
  >();
const deleteMock =
  vi.fn<
    (projectId: string, attachmentId: string, authToken?: string) => Promise<ApiResult<null>>
  >();

vi.mock('@/api/client', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    attachmentApi: {
      list: vi.fn(),
      initUpload: (...args: unknown[]) => initMock(...(args as Parameters<typeof initMock>)),
      completeUpload: (...args: unknown[]) =>
        completeMock(...(args as Parameters<typeof completeMock>)),
      delete: (...args: unknown[]) => deleteMock(...(args as Parameters<typeof deleteMock>)),
      restore: vi.fn(),
      downloadUrl:
        vi.fn<(...args: unknown[]) => Promise<ApiResult<AttachmentDownloadUrlResponse>>>(),
      bulkFetch: vi.fn<(...args: unknown[]) => Promise<ApiResult<BulkFetchResponse>>>(),
      listTrash: vi.fn(),
    },
    dataApi: {
      export: vi.fn(),
      import: vi.fn(),
    },
  };
});

const { importAllApi } = await import('@/state/importAllStore');

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att-1',
    projectId: 'proj-1',
    status: 'ready',
    kind: 'binary',
    label: 'sonstiges',
    fileName: 'doc.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    originalKey: 'attachments/proj-1/att-1/original.pdf',
    thumbKey: null,
    hasThumbnail: false,
    hiddenAt: null,
    createdAt: '2026-05-01T00:00:00Z',
    createdBy: { id: 'u-1', displayName: 'Operator' },
    ...overrides,
  };
}

function initOkResponse(): ApiResult<AttachmentInitResponse> {
  return {
    ok: true,
    data: {
      attachment: attachment(),
      originalUpload: {
        url: 'https://storage.test/orig',
        headers: { 'Content-Type': 'application/octet-stream' },
        expiresAt: '2099-01-01T00:00:00Z',
      },
    },
  };
}

function initPayload(): {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  label: AttachmentLabel;
  hasThumbnail: boolean;
  dekMaterial: string;
  ciphertextSizeBytes: number;
  ciphertextContentMd5: string;
} {
  return {
    fileName: 'doc.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    label: 'sonstiges',
    hasThumbnail: false,
    dekMaterial: 'AA==',
    ciphertextSizeBytes: 1040,
    ciphertextContentMd5: 'AAAA',
  };
}

const RESTORE_BLOCK = {
  id: 'att-1',
  createdBy: 'u-1',
  createdAt: '2026-05-01T00:00:00Z',
};

beforeEach(() => {
  initMock.mockReset();
  completeMock.mockReset();
  deleteMock.mockReset();
});

describe('importAllApi — authToken threading', () => {
  it('forwards the bearer token to attachmentApi.initUpload', async () => {
    initMock.mockResolvedValueOnce(initOkResponse());

    await importAllApi.importInit('proj-1', initPayload(), RESTORE_BLOCK, 'tok-xyz');

    expect(initMock).toHaveBeenCalledTimes(1);
    // Signature: (projectId, body, signal, authToken).
    expect(initMock.mock.calls[0]![3]).toBe('tok-xyz');
  });

  it('forwards the bearer token to attachmentApi.completeUpload', async () => {
    completeMock.mockResolvedValueOnce({ ok: true, data: attachment() });

    await importAllApi.importComplete('proj-1', 'att-1', 'tok-xyz');

    expect(completeMock).toHaveBeenCalledTimes(1);
    // Signature: (projectId, attachmentId, signal, authToken).
    expect(completeMock.mock.calls[0]![3]).toBe('tok-xyz');
  });

  it('forwards the bearer token to attachmentApi.delete', async () => {
    deleteMock.mockResolvedValueOnce({ ok: true, data: null });

    await importAllApi.importDelete('proj-1', 'att-1', 'tok-xyz');

    expect(deleteMock).toHaveBeenCalledTimes(1);
    // Signature: (projectId, attachmentId, authToken).
    expect(deleteMock.mock.calls[0]![2]).toBe('tok-xyz');
  });
});

describe('importAllApi — error code preservation', () => {
  it('importInit throws an Error carrying the API code on rejection', async () => {
    initMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'IMPORT_TOKEN_INVALID', message: 'Import-Token ungültig oder abgelaufen.' },
      category: 'import_token_invalid',
      sessionExpired: false,
    });

    let caught: unknown;
    try {
      await importAllApi.importInit('proj-1', initPayload(), RESTORE_BLOCK, 'dead-token');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    // The orchestrator routes on `.code` to escalate to fatal — the
    // load-bearing assertion is that the code survives the wrapper.
    expect((caught as Error & { code?: string }).code).toBe('IMPORT_TOKEN_INVALID');
  });

  it('importComplete throws an Error carrying the API code on rejection', async () => {
    completeMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'IMPORT_TOKEN_INVALID', message: 'Import-Token ungültig oder abgelaufen.' },
      category: 'import_token_invalid',
      sessionExpired: false,
    });

    let caught: unknown;
    try {
      await importAllApi.importComplete('proj-1', 'att-1', 'dead-token');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error & { code?: string }).code).toBe('IMPORT_TOKEN_INVALID');
  });

  it('preserves a non-token error code so the orchestrator can branch on it', async () => {
    // VALIDATION_ERROR is a per-entry skip from the orchestrator's
    // perspective — verifies the wrapper doesn't only special-case the
    // token code.
    initMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'Ungültige Eingabe.' },
      category: 'validation',
      sessionExpired: false,
    });

    let caught: unknown;
    try {
      await importAllApi.importInit('proj-1', initPayload(), RESTORE_BLOCK);
    } catch (err) {
      caught = err;
    }

    expect((caught as Error & { code?: string }).code).toBe('VALIDATION_ERROR');
  });
});

// -------------------------------------------------------------------
// importDelete swallow contract. The orchestrator's rollback walk
// runs `Promise.allSettled` over the committed list and does NOT
// inspect individual rejections — the orphan reaper handles eventual
// cleanup either way. The wrapper deliberately swallows API
// rejections so a regression that started re-throwing would change
// rollback semantics (one bad DELETE would short-circuit the rest).
// -------------------------------------------------------------------
describe('importAllApi — importDelete swallow contract', () => {
  it('does NOT throw on IMPORT_TOKEN_INVALID; rollback walk continues', async () => {
    deleteMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'IMPORT_TOKEN_INVALID', message: 'Import-Token ungültig oder abgelaufen.' },
      category: 'import_token_invalid',
      sessionExpired: false,
    });

    // Direct call — if a regression re-threw, this would reject and the
    // assertion below would never run. We resolve to undefined per the
    // wrapper's contract.
    await expect(
      importAllApi.importDelete('proj-1', 'att-1', 'dead-token'),
    ).resolves.toBeUndefined();
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });
});
