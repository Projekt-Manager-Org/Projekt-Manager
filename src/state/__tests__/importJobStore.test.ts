/**
 * importJobStore — TDD-red contract tests for the import-job subscription
 * that powers the DatenView "Vollständiger Import" dialog
 * ([ui/daten.md §8.11.2], design note `docs/wip/step4-ui-rewire-design.md`
 * §Stores / §`src/api/client.ts` additions).
 *
 * RED BY DESIGN: `@/state/importJobStore` does not exist yet, so every test
 * here fails at the dynamic `await import(...)` below. The assertions encode
 * the spec'd behaviour, so they flip green when the store is implemented to
 * the design-note contract — they are not placeholders.
 *
 * Modeled on `storageUsageStore.test.ts`: typed `vi.mock('@/api/client', …)`
 * namespace, `vi.mock('@/sse/client', …)` over a handler Map (fire frames by
 * hand), `vi.mock('@/state/sessionExpired', …)` spy, dynamic store import
 * after the mocks, `__resetForTests()` in `beforeEach`.
 *
 * Note the two transport flavours from the design note:
 *   - `getLatest` / `get` / `create` return `ApiResult<T>` (via `apiCall`).
 *   - `headOffset` / `patchChunk` are RAW-fetch wrappers (custom content-type
 *     + response-header reads) and return a plain `{ ok, status, offset, … }`
 *     shape — NOT `ApiResult`.
 *
 * Coverage references:
 *   - AC-326 — import-job create + resumable chunked upload (HEAD→PATCH loop,
 *              409 UPLOAD_OFFSET_CONFLICT is retry-safe with the offset
 *              unchanged).
 *   - AC-329 — override + confirmation phrase up front: TARGET_NOT_EMPTY /
 *              RESTORE_CONFIRMATION_MISMATCH map to `createError`; the checks
 *              reject at create, before any upload.
 *   - AC-330 — session invalidation + re-auth: the users-wipe CASCADE-drops
 *              the operator's session mid-run; the SSE-driven refetch's 401 is
 *              the EXPECTED path → delegate to handleSessionExpired (route to
 *              login). DatenView's mount-time resume re-attaches after re-login.
 *   - AC-331 — one active job per kind: 409 IMPORT_JOB_ACTIVE re-attaches to
 *              the running job (no createError), mirroring the export side.
 *   - AC-335 (E2E) — the dialog phases these store actions back.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ApiResult } from '@/api/client';

/**
 * Client DTO per the design note §Client DTO. `archiveRef` / `createdBy` are
 * deliberately NOT modelled (Finding F1 — stripped server-side).
 */
interface DataExchangeJobDto {
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

type LatestResult = ApiResult<{ job: DataExchangeJobDto | null }>;
type GetResult = ApiResult<DataExchangeJobDto>;
type CreateResult = ApiResult<DataExchangeJobDto>;

/** Raw-fetch wrapper return shapes (design note — NOT ApiResult). */
interface HeadOffsetResult {
  ok: boolean;
  status: number;
  offset: number;
  length: number;
}
interface PatchChunkResult {
  ok: boolean;
  status: number;
  offset: number;
}

interface CreateArgs {
  uploadLength: number;
  override: boolean;
  phrase: string | null;
}
interface PatchChunkArgs {
  offset: number;
  chunk: Blob;
  signal?: AbortSignal;
}

const getLatestMock = vi.fn<() => Promise<LatestResult>>();
const getMock = vi.fn<(id: string) => Promise<GetResult>>();
const createMock = vi.fn<(args: CreateArgs) => Promise<CreateResult>>();
const headOffsetMock = vi.fn<(id: string) => Promise<HeadOffsetResult>>();
const patchChunkMock = vi.fn<(id: string, args: PatchChunkArgs) => Promise<PatchChunkResult>>();

// Typed SSE bus mock — same shape as storageUsageStore.test.ts.
type SseHandler = () => void;
const sseHandlers = new Map<string, Set<SseHandler>>();
const onSseEventMock = vi.fn((name: string, handler: SseHandler): (() => void) => {
  let set = sseHandlers.get(name);
  if (!set) {
    set = new Set();
    sseHandlers.set(name, set);
  }
  set.add(handler);
  return () => {
    set?.delete(handler);
  };
});

vi.mock('@/api/client', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    importJobApi: {
      getLatest: (...args: unknown[]) =>
        getLatestMock(...(args as Parameters<typeof getLatestMock>)),
      get: (...args: unknown[]) => getMock(...(args as Parameters<typeof getMock>)),
      create: (...args: unknown[]) => createMock(...(args as Parameters<typeof createMock>)),
      headOffset: (...args: unknown[]) =>
        headOffsetMock(...(args as Parameters<typeof headOffsetMock>)),
      patchChunk: (...args: unknown[]) =>
        patchChunkMock(...(args as Parameters<typeof patchChunkMock>)),
    },
  };
});

vi.mock('@/sse/client', () => ({
  onSseEvent: (name: string, handler: SseHandler) => onSseEventMock(name, handler),
}));

const handleSessionExpiredMock = vi.fn();
vi.mock('@/state/sessionExpired', () => ({
  handleSessionExpired: () => handleSessionExpiredMock(),
}));

// Dynamic import AFTER the mocks — the module does not exist yet, so this is
// the line that makes the suite RED.
const { useImportJobStore } = await import('@/state/importJobStore');

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

/** 409 TARGET_NOT_EMPTY — rejects at create when override is omitted (AC-329). */
function targetNotEmpty<T>(): ApiResult<T> {
  return {
    ok: false,
    error: { code: 'TARGET_NOT_EMPTY', message: 'Zielsystem ist nicht leer.' },
    category: 'server_error',
    sessionExpired: false,
  };
}

/**
 * 422 RESTORE_CONFIRMATION_MISMATCH — phrase wrong/missing at create (AC-329).
 * `category: 'server_error'` is what the real client produces: `classifyCode`
 * (client.ts) has no case for this code, so it falls to the default bucket.
 * The store branches on `error.code`, not `category`, so the value is inert to
 * behaviour — but the fixture must not misrepresent what `apiCall` returns.
 */
function confirmationMismatch<T>(): ApiResult<T> {
  return {
    ok: false,
    error: { code: 'RESTORE_CONFIRMATION_MISMATCH', message: 'Bestätigungstext stimmt nicht.' },
    category: 'server_error',
    sessionExpired: false,
  };
}

/** 409 IMPORT_JOB_ACTIVE — one active import per deployment (AC-331). */
function importJobActive<T>(): ApiResult<T> {
  return {
    ok: false,
    error: { code: 'IMPORT_JOB_ACTIVE', message: 'Es läuft bereits ein Import.' },
    category: 'server_error',
    sessionExpired: false,
  };
}

/** 401 SESSION_EXPIRED — the EXPECTED mid-wipe path (AC-330). */
function expired<T>(): ApiResult<T> {
  return {
    ok: false,
    error: { code: 'SESSION_EXPIRED', message: 'Sitzung abgelaufen.' },
    category: 'authentication',
    sessionExpired: true,
  };
}

let jobSeq = 0;
function makeJob(overrides: Partial<DataExchangeJobDto> = {}): DataExchangeJobDto {
  jobSeq += 1;
  return {
    id: `import-job-${jobSeq}`,
    kind: 'import',
    status: 'pending',
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

/** A small fake archive — a few KB so chunking runs in 1–2 chunks. */
function makeArchive(size = 5 * 1024): File {
  return new File([new Uint8Array(size)], 'takeout.zip', { type: 'application/zip' });
}

/**
 * Wire `headOffset` + `patchChunk` to a moving server-offset cursor, so the
 * store's HEAD→PATCH loop converges regardless of the implementation's chunk
 * size. Each accepted PATCH advances the cursor by the chunk's byte length and
 * echoes the new offset (the server contract in AC-326). Returns the cursor
 * holder so a test can inspect the final offset.
 *
 * `conflictAt`, when set, makes the FIRST PATCH whose start offset equals that
 * value return 409 UPLOAD_OFFSET_CONFLICT with the offset UNCHANGED (AC-326:
 * a stale PATCH is retry-safe). The store is expected to re-HEAD and resume.
 */
function wireResumableUpload(
  length: number,
  opts: { conflictAt?: number } = {},
): {
  cursor: { value: number };
} {
  const cursor = { value: 0 };
  let conflictFired = false;
  headOffsetMock.mockImplementation(async () => ({
    ok: true,
    status: 200,
    offset: cursor.value,
    length,
  }));
  patchChunkMock.mockImplementation(async (_id: string, args: PatchChunkArgs) => {
    if (opts.conflictAt !== undefined && !conflictFired && args.offset === opts.conflictAt) {
      conflictFired = true;
      // Stale offset: server rejects, cursor (and the returned offset) unchanged.
      return { ok: false, status: 409, offset: cursor.value };
    }
    const size = args.chunk.size;
    cursor.value = args.offset + size;
    return { ok: true, status: 200, offset: cursor.value };
  });
  return { cursor };
}

beforeEach(() => {
  getLatestMock.mockReset();
  getMock.mockReset();
  createMock.mockReset();
  headOffsetMock.mockReset();
  patchChunkMock.mockReset();
  onSseEventMock.mockClear();
  handleSessionExpiredMock.mockReset();
  sseHandlers.clear();
  jobSeq = 0;
  useImportJobStore.getState().__resetForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('importJobStore — resume probe (AC-330)', () => {
  it('runs the resume probe via importJobApi.getLatest() on first subscribe and stores the job', async () => {
    // DatenView mounts → first subscriber probes for an in-flight import so a
    // reload (or a re-login after the mid-wipe re-auth) re-attaches (AC-330).
    const running = makeJob({ status: 'running', filesTotal: 4, filesDone: 1 });
    getLatestMock.mockResolvedValue(ok({ job: running }));

    const unsubscribe = useImportJobStore.getState().subscribe();

    await vi.waitFor(() => expect(getLatestMock).toHaveBeenCalledTimes(1));
    expect(useImportJobStore.getState().job).toEqual(running);

    unsubscribe();
  });

  it('does not refetch when a second subscriber joins an already-probed store', async () => {
    getLatestMock.mockResolvedValue(ok({ job: null }));

    const unsubA = useImportJobStore.getState().subscribe();
    await vi.waitFor(() => expect(getLatestMock).toHaveBeenCalledTimes(1));

    const unsubB = useImportJobStore.getState().subscribe();
    await Promise.resolve();
    await Promise.resolve();
    expect(getLatestMock).toHaveBeenCalledTimes(1);

    unsubA();
    unsubB();
  });

  it('refetches via getLatest when a data_exchange_job_changed frame fires', async () => {
    // Invalidation-only frame (AC-333 / ADR-0025): refetch the row over REST.
    const pending = makeJob({ status: 'pending' });
    getLatestMock.mockResolvedValueOnce(ok({ job: pending }));
    const unsubscribe = useImportJobStore.getState().subscribe();
    await vi.waitFor(() => expect(getLatestMock).toHaveBeenCalledTimes(1));

    const processing = makeJob({
      id: pending.id,
      status: 'running',
      filesTotal: 4,
      filesDone: 2,
      currentItem: 'attachments/0001-dach/foo.jpg',
    });
    getLatestMock.mockResolvedValueOnce(ok({ job: processing }));

    expect(onSseEventMock).toHaveBeenCalledWith('data_exchange_job_changed', expect.any(Function));
    const handlers = sseHandlers.get('data_exchange_job_changed');
    expect(handlers && handlers.size).toBeGreaterThan(0);
    for (const h of handlers!) h();

    await vi.waitFor(() => expect(getLatestMock).toHaveBeenCalledTimes(2));
    expect(useImportJobStore.getState().job).toEqual(processing);

    unsubscribe();
  });
});

describe('importJobStore — create() guard mapping (AC-329)', () => {
  it('stores the pending row and CLEARS any prior createError on a clean create', async () => {
    // First, a rejected create leaves createError set — so the clean create
    // below has a non-null prior value to clear (otherwise the final
    // assertion can't distinguish "cleared" from "never touched").
    const file = makeArchive();
    createMock.mockResolvedValueOnce(confirmationMismatch<DataExchangeJobDto>());
    await useImportJobStore.getState().create({ file, override: true, phrase: 'WRONG' });
    expect(useImportJobStore.getState().createError).toBe('confirmation_mismatch');

    // Now a clean (empty-target) create: neither override nor phrase needed.
    // POST returns a pending job; the store adopts it AND resets createError.
    const pending = makeJob({ status: 'pending', bytesTotal: 5 * 1024 });
    createMock.mockResolvedValueOnce(ok(pending));
    await useImportJobStore.getState().create({ file, override: false, phrase: null });

    expect(createMock).toHaveBeenCalledTimes(2);
    // The store derives Upload-Length from the file size (design note §client
    // additions: `create({ uploadLength, override, phrase })`).
    expect(createMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ uploadLength: file.size, override: false, phrase: null }),
    );
    expect(useImportJobStore.getState().job).toEqual(pending);
    expect(useImportJobStore.getState().createError).toBeNull();
  });

  it("maps 409 TARGET_NOT_EMPTY to createError='target_not_empty' and leaves job unset", async () => {
    // AC-329: a restore into a non-empty target without override is rejected
    // at create, before any upload. The dialog surfaces a "must override" cue.
    createMock.mockResolvedValueOnce(targetNotEmpty<DataExchangeJobDto>());

    const file = makeArchive();
    await useImportJobStore.getState().create({ file, override: false, phrase: null });

    expect(useImportJobStore.getState().createError).toBe('target_not_empty');
    expect(useImportJobStore.getState().job).toBeNull();
  });

  it("maps 422 RESTORE_CONFIRMATION_MISMATCH to createError='confirmation_mismatch'", async () => {
    // AC-329: override set but the phrase is wrong/missing — rejected at create.
    createMock.mockResolvedValueOnce(confirmationMismatch<DataExchangeJobDto>());

    const file = makeArchive();
    await useImportJobStore.getState().create({ file, override: true, phrase: 'WRONG' });

    expect(useImportJobStore.getState().createError).toBe('confirmation_mismatch');
    expect(useImportJobStore.getState().job).toBeNull();
  });

  it('re-attaches to the active job (no createError) when create() returns 409 IMPORT_JOB_ACTIVE', async () => {
    // AC-331: a second create while an import is pending/running is rejected
    // with IMPORT_JOB_ACTIVE. Mirroring the export side, the store does NOT
    // surface this as a create error — it re-attaches to the running job via
    // getLatest so the dialog jumps straight to the processing phase. The
    // picked file is moot: the active job owns the single per-kind slot, so
    // there is nothing to upload. (A `createError` here would force the dialog
    // into an error state while `job` says "running" — a contradiction.)
    createMock.mockResolvedValueOnce(importJobActive<DataExchangeJobDto>());
    const active = makeJob({ status: 'running', filesTotal: 6, filesDone: 3 });
    getLatestMock.mockResolvedValueOnce(ok({ job: active }));

    const file = makeArchive();
    await useImportJobStore.getState().create({ file, override: true, phrase: 'JA-LOESCHEN' });

    expect(useImportJobStore.getState().createError).toBeNull();
    expect(getLatestMock).toHaveBeenCalledTimes(1);
    expect(useImportJobStore.getState().job).toEqual(active);
  });
});

describe('importJobStore — resumable upload (AC-326)', () => {
  it('reads the server offset via headOffset then PATCHes chunks to file.size, advancing uploadOffset', async () => {
    // Fresh upload from offset 0. The store HEADs the current offset, then
    // PATCHes sequential chunks until the offset reaches Upload-Length
    // (AC-326). Each accepted PATCH carries the offset it is writing at, in
    // strictly increasing order, with no gaps — the upload is contiguous.
    const size = 5 * 1024;
    const file = makeArchive(size);
    const pending = makeJob({ status: 'pending', id: 'import-upload-1', bytesTotal: size });
    useImportJobStore.setState({ job: pending });
    wireResumableUpload(size);

    await useImportJobStore.getState().upload(file);

    expect(headOffsetMock).toHaveBeenCalledWith(pending.id);
    expect(patchChunkMock.mock.calls.length).toBeGreaterThanOrEqual(1);

    // First PATCH starts at the HEAD-reported offset (0); offsets are
    // strictly increasing and contiguous, and the last write reaches size.
    const patchArgs = patchChunkMock.mock.calls.map(([, a]) => a);
    expect(patchArgs[0].offset).toBe(0);
    let expected = 0;
    for (const a of patchArgs) {
      expect(a.offset).toBe(expected);
      expected += a.chunk.size;
    }
    expect(expected).toBe(size);
    expect(useImportJobStore.getState().uploadOffset).toBe(size);
  });

  it('resumes from a non-zero server offset reported by headOffset', async () => {
    // Re-attach after an interrupted upload: HEAD reports bytes already on the
    // server, so the store must NOT re-send from 0 — it picks up at the
    // server's offset (AC-326 resumability).
    const size = 5 * 1024;
    const startAt = 2 * 1024;
    const file = makeArchive(size);
    const pending = makeJob({ status: 'pending', id: 'import-resume-1', bytesTotal: size });
    useImportJobStore.setState({ job: pending });
    const { cursor } = wireResumableUpload(size);
    cursor.value = startAt; // server already holds the first 2 KB

    await useImportJobStore.getState().upload(file);

    const patchArgs = patchChunkMock.mock.calls.map(([, a]) => a);
    // No chunk re-sends bytes the server already has.
    expect(patchArgs[0].offset).toBe(startAt);
    for (const a of patchArgs) expect(a.offset).toBeGreaterThanOrEqual(startAt);
    expect(useImportJobStore.getState().uploadOffset).toBe(size);
  });

  it('re-HEADs and resumes on a 409 UPLOAD_OFFSET_CONFLICT (offset unchanged on the conflicting call)', async () => {
    // AC-326: a PATCH at a stale offset returns 409 with the offset unchanged
    // (retry-safe). The store re-HEADs to learn the true offset and resumes;
    // the upload still completes to Upload-Length. We inject a conflict on the
    // first chunk (offset 0) to force at least one re-HEAD.
    const size = 5 * 1024;
    const file = makeArchive(size);
    const pending = makeJob({ status: 'pending', id: 'import-conflict-1', bytesTotal: size });
    useImportJobStore.setState({ job: pending });
    wireResumableUpload(size, { conflictAt: 0 });

    await useImportJobStore.getState().upload(file);

    // The conflict forced a re-HEAD: at least the initial probe + one re-probe.
    expect(headOffsetMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    // The conflicting PATCH did not advance the offset; the upload still
    // reaches the full length after resuming.
    expect(useImportJobStore.getState().uploadOffset).toBe(size);

    // No chunk was committed past the declared Upload-Length.
    const patchArgs = patchChunkMock.mock.calls.map(([, a]) => a);
    for (const a of patchArgs) expect(a.offset).toBeLessThan(size);
  });

  it('breaks out (does not spin forever) on a non-advancing 2xx PATCH', async () => {
    // Robustness: a misbehaving server/proxy that answers 200 WITHOUT an
    // Upload-Offset header makes patchChunk fall back to the request offset, so
    // a naive success branch would `continue` with the offset unchanged and
    // loop forever. The success path must feed the same stall breaker as the
    // 409 path (MAX_UPLOAD_STALLS = 5) and terminate.
    const size = 5 * 1024;
    const file = makeArchive(size);
    const pending = makeJob({ status: 'pending', id: 'import-stall-1', bytesTotal: size });
    useImportJobStore.setState({ job: pending });

    headOffsetMock.mockResolvedValue({ ok: true, status: 200, offset: 0, length: size });
    // Every PATCH is "accepted" (ok) but never advances the offset.
    patchChunkMock.mockImplementation(async (_id, args: PatchChunkArgs) => ({
      ok: true,
      status: 200,
      offset: args.offset,
    }));

    // Resolves (no hang); the breaker caps the attempts and the upload never
    // falsely reports completion.
    await useImportJobStore.getState().upload(file);

    expect(patchChunkMock.mock.calls.length).toBe(5);
    expect(useImportJobStore.getState().uploadOffset).toBe(0);
  });
});

describe('importJobStore — mid-wipe re-auth (AC-330)', () => {
  it('delegates an SSE-driven 401 refetch to handleSessionExpired without clobbering job', async () => {
    // EXPECTED path, not an error: the import job's users-wipe CASCADE-drops
    // the operator's session mid-run, so a status poll on the old cookie
    // returns 401. The store delegates to handleSessionExpired (route to
    // login) and keeps the last-good `job` in place.
    //
    // DatenView's mount-time resume probe (getLatest) re-attaches to this same
    // job AFTER the operator re-authenticates — the account round-trips
    // through the archive with its original passwordHash (AC-330). No bearer
    // token is minted anywhere in this flow.
    const processing = makeJob({ status: 'running', filesTotal: 8, filesDone: 4 });
    getLatestMock.mockResolvedValueOnce(ok({ job: processing }));
    const unsubscribe = useImportJobStore.getState().subscribe();
    await vi.waitFor(() => expect(getLatestMock).toHaveBeenCalledTimes(1));
    expect(useImportJobStore.getState().job).toEqual(processing);

    getLatestMock.mockResolvedValueOnce(expired<{ job: DataExchangeJobDto | null }>());
    const handlers = sseHandlers.get('data_exchange_job_changed');
    for (const h of handlers!) h();

    await vi.waitFor(() => expect(handleSessionExpiredMock).toHaveBeenCalledTimes(1));
    expect(useImportJobStore.getState().job).toEqual(processing);

    unsubscribe();
  });
});
