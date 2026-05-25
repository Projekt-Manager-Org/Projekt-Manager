/**
 * exportJobStore — TDD-red contract tests for the export-job subscription
 * that powers the DatenView "Vollständiger Export" dialog
 * ([ui/daten.md §8.11.1], design note `docs/wip/step4-ui-rewire-design.md`
 * §Stores / §`src/api/client.ts` additions).
 *
 * RED BY DESIGN: `@/state/exportJobStore` does not exist yet, so every test
 * in this file fails at the dynamic `await import(...)` below. The assertions
 * nonetheless encode the spec'd behaviour, so they flip green once the store
 * is implemented to the design-note contract — they are not placeholders.
 *
 * Modeled on `storageUsageStore.test.ts`: `vi.mock('@/api/client', …)` with a
 * typed mock namespace, `vi.mock('@/sse/client', …)` over a handler Map so the
 * test can fire SSE frames by hand, `vi.mock('@/state/sessionExpired', …)` to
 * spy on the shared session-expiry delegation, dynamic store import after the
 * mocks, and `__resetForTests()` in `beforeEach`.
 *
 * Coverage references:
 *   - AC-322 — export-job lifecycle + REST contract (resume probe via getLatest).
 *   - AC-331 — one active job per kind (409 EXPORT_JOB_ACTIVE re-attach on start).
 *   - AC-333 — `data_exchange_job_changed` SSE frame is invalidation-only;
 *              consumers refetch the row over REST.
 *   - AC-335 (E2E) — the dialog/resume behaviour these store actions back.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ApiResult } from '@/api/client';

/**
 * Client DTO per the design note §Client DTO. `archiveRef` / `createdBy` are
 * deliberately NOT modelled (Finding F1 — they are stripped server-side and
 * must never reach the client).
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

const getLatestMock = vi.fn<() => Promise<LatestResult>>();
const getMock = vi.fn<(id: string) => Promise<GetResult>>();
const createMock = vi.fn<() => Promise<CreateResult>>();
const downloadPathMock = vi.fn<(id: string) => string>();

// Typed SSE bus mock — mirrors storageUsageStore.test.ts. Tests grab the
// handler registered for an event name and dispatch through it, simulating a
// frame arriving on the shared `/api/events` connection. Per ADR-0025 the
// frame is an invalidation hint, not a data carrier; the store refetches.
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
    exportJobApi: {
      getLatest: (...args: unknown[]) =>
        getLatestMock(...(args as Parameters<typeof getLatestMock>)),
      get: (...args: unknown[]) => getMock(...(args as Parameters<typeof getMock>)),
      create: (...args: unknown[]) => createMock(...(args as Parameters<typeof createMock>)),
      downloadPath: (...args: unknown[]) =>
        downloadPathMock(...(args as Parameters<typeof downloadPathMock>)),
    },
  };
});

vi.mock('@/sse/client', () => ({
  onSseEvent: (name: string, handler: SseHandler) => onSseEventMock(name, handler),
}));

// Spy on the shared session-expiry handler the store delegates to. As in
// storageUsageStore, the store imports `handleSessionExpired` from
// `@/state/sessionExpired`; the test only needs to observe that it fires.
const handleSessionExpiredMock = vi.fn();
vi.mock('@/state/sessionExpired', () => ({
  handleSessionExpired: () => handleSessionExpiredMock(),
}));

// Dynamic import AFTER the mocks are registered — the module under test does
// not exist yet, so this is the line that makes the suite RED.
const { useExportJobStore } = await import('@/state/exportJobStore');

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

/** 409 EXPORT_JOB_ACTIVE — one-active-per-kind guard (AC-331). */
function exportJobActive<T>(): ApiResult<T> {
  return {
    ok: false,
    error: { code: 'EXPORT_JOB_ACTIVE', message: 'Es läuft bereits ein Export.' },
    category: 'server_error',
    sessionExpired: false,
  };
}

/** 401 SESSION_EXPIRED — auth-category failure that must bounce to login. */
function expired<T>(): ApiResult<T> {
  return {
    ok: false,
    error: { code: 'SESSION_EXPIRED', message: 'Sitzung abgelaufen.' },
    category: 'authentication',
    sessionExpired: true,
  };
}

/** A non-auth transient failure — must leave prior state untouched. */
function serverError<T>(): ApiResult<T> {
  return {
    ok: false,
    error: { code: 'SERVER_ERROR', message: 'Serverfehler.' },
    category: 'server_error',
    sessionExpired: false,
  };
}

let jobSeq = 0;
function makeJob(overrides: Partial<DataExchangeJobDto> = {}): DataExchangeJobDto {
  jobSeq += 1;
  return {
    id: `export-job-${jobSeq}`,
    kind: 'export',
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

beforeEach(() => {
  getLatestMock.mockReset();
  getMock.mockReset();
  createMock.mockReset();
  downloadPathMock.mockReset();
  onSseEventMock.mockClear();
  handleSessionExpiredMock.mockReset();
  sseHandlers.clear();
  jobSeq = 0;
  // Reset the singleton so each test starts clean — part of the store's
  // public test contract, mirroring storageUsageStore.
  useExportJobStore.getState().__resetForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('exportJobStore — resume probe (AC-322)', () => {
  it('runs the resume probe via exportJobApi.getLatest() on first subscribe and stores the job', async () => {
    // DatenView mounts → first subscriber → the store probes for an existing
    // job so a page reload re-attaches to an in-flight / ready export
    // (AC-335 resume). `getLatest` is the export-kind REST surface (AC-322:
    // `GET /api/export-jobs` → `{ job | null }`).
    const running = makeJob({ status: 'running', filesTotal: 3, filesDone: 1 });
    getLatestMock.mockResolvedValue(ok({ job: running }));

    const unsubscribe = useExportJobStore.getState().subscribe();

    await vi.waitFor(() => expect(getLatestMock).toHaveBeenCalledTimes(1));
    expect(useExportJobStore.getState().job).toEqual(running);

    unsubscribe();
  });

  it('stores job=null when the resume probe reports no prior job', async () => {
    // Fresh deployment / no export ever run — `{ job: null }`. The dialog's
    // local `idle` phase takes over; nothing to re-attach to.
    getLatestMock.mockResolvedValue(ok({ job: null }));

    const unsubscribe = useExportJobStore.getState().subscribe();

    await vi.waitFor(() => expect(getLatestMock).toHaveBeenCalledTimes(1));
    expect(useExportJobStore.getState().job).toBeNull();

    unsubscribe();
  });

  it('does not refetch when a second subscriber joins an already-probed store', async () => {
    // Refcounted subscription: one probe per first-subscriber, not one per
    // consumer. A status chip + the dialog mounting in the same render pass
    // must produce a single network call (parity with storageUsageStore).
    getLatestMock.mockResolvedValue(ok({ job: null }));

    const unsubA = useExportJobStore.getState().subscribe();
    await vi.waitFor(() => expect(getLatestMock).toHaveBeenCalledTimes(1));

    const unsubB = useExportJobStore.getState().subscribe();
    await Promise.resolve();
    await Promise.resolve();
    expect(getLatestMock).toHaveBeenCalledTimes(1);

    unsubA();
    unsubB();
  });
});

describe('exportJobStore — SSE refetch (AC-333)', () => {
  it('registers an onSseEvent(data_exchange_job_changed) handler on first subscribe', () => {
    getLatestMock.mockResolvedValue(ok({ job: null }));

    const unsubscribe = useExportJobStore.getState().subscribe();

    expect(onSseEventMock).toHaveBeenCalledWith('data_exchange_job_changed', expect.any(Function));

    unsubscribe();
  });

  it('refetches via getLatest and updates job when a data_exchange_job_changed frame fires', async () => {
    // The frame is invalidation-only (AC-333 / ADR-0025) — it carries no job
    // payload, so the store refetches the row over REST and adopts the
    // advanced state.
    const pending = makeJob({ status: 'pending' });
    getLatestMock.mockResolvedValueOnce(ok({ job: pending }));
    const unsubscribe = useExportJobStore.getState().subscribe();
    await vi.waitFor(() => expect(getLatestMock).toHaveBeenCalledTimes(1));

    const ready = makeJob({
      id: pending.id,
      status: 'ready',
      filesTotal: 3,
      filesDone: 3,
      finishedAt: '2026-05-25T10:05:00.000Z',
    });
    getLatestMock.mockResolvedValueOnce(ok({ job: ready }));

    const handlers = sseHandlers.get('data_exchange_job_changed');
    expect(handlers && handlers.size).toBeGreaterThan(0);
    for (const h of handlers!) h();

    await vi.waitFor(() => expect(getLatestMock).toHaveBeenCalledTimes(2));
    expect(useExportJobStore.getState().job).toEqual(ready);

    unsubscribe();
  });
});

describe('exportJobStore — start() (AC-322, AC-331)', () => {
  it('calls exportJobApi.create() and stores the returned pending row', async () => {
    // Preflight "Start" → POST /api/export-jobs → 201 pending row (AC-322).
    getLatestMock.mockResolvedValue(ok({ job: null }));
    const unsubscribe = useExportJobStore.getState().subscribe();
    await vi.waitFor(() => expect(getLatestMock).toHaveBeenCalledTimes(1));

    const pending = makeJob({ status: 'pending' });
    createMock.mockResolvedValueOnce(ok(pending));

    await useExportJobStore.getState().start();

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(useExportJobStore.getState().job).toEqual(pending);

    unsubscribe();
  });

  it('re-attaches via getLatest (no throw) when create() returns 409 EXPORT_JOB_ACTIVE', async () => {
    // AC-331: a second create while a job is pending/running is rejected with
    // 409 EXPORT_JOB_ACTIVE carrying the active id. The store must NOT surface
    // this as an error — it re-attaches to the already-running job by probing
    // getLatest, so the dialog jumps straight to the progress phase.
    getLatestMock.mockResolvedValueOnce(ok({ job: null }));
    const unsubscribe = useExportJobStore.getState().subscribe();
    await vi.waitFor(() => expect(getLatestMock).toHaveBeenCalledTimes(1));

    const active = makeJob({ status: 'running', filesTotal: 5, filesDone: 2 });
    createMock.mockResolvedValueOnce(exportJobActive<DataExchangeJobDto>());
    getLatestMock.mockResolvedValueOnce(ok({ job: active }));

    await expect(useExportJobStore.getState().start()).resolves.not.toThrow();

    expect(createMock).toHaveBeenCalledTimes(1);
    // The re-attach probe fired (one mount probe + one conflict re-attach).
    expect(getLatestMock).toHaveBeenCalledTimes(2);
    expect(useExportJobStore.getState().job).toEqual(active);

    unsubscribe();
  });
});

describe('exportJobStore — session-expiry delegation', () => {
  it('delegates to handleSessionExpired and keeps the prior job when a refetch lands after expiry', async () => {
    // SSE-driven refetch arriving after the session aged out (a heartbeat
    // that did not fire, a tab restored after a long sleep). Same surface as
    // storageUsageStore: delegate to the shared handler, do NOT clobber the
    // last-good `job` — the auth store owns the redirect/teardown.
    const ready = makeJob({ status: 'ready', filesTotal: 2, filesDone: 2 });
    getLatestMock.mockResolvedValueOnce(ok({ job: ready }));
    const unsubscribe = useExportJobStore.getState().subscribe();
    await vi.waitFor(() => expect(getLatestMock).toHaveBeenCalledTimes(1));
    expect(useExportJobStore.getState().job).toEqual(ready);

    getLatestMock.mockResolvedValueOnce(expired<{ job: DataExchangeJobDto | null }>());
    const handlers = sseHandlers.get('data_exchange_job_changed');
    for (const h of handlers!) h();

    await vi.waitFor(() => expect(handleSessionExpiredMock).toHaveBeenCalledTimes(1));
    expect(useExportJobStore.getState().job).toEqual(ready);

    unsubscribe();
  });

  it('does not delegate or clobber on a non-auth refetch failure', async () => {
    // Transient 5xx / network blip: state stays put; the next trigger retries.
    const ready = makeJob({ status: 'ready', filesTotal: 2, filesDone: 2 });
    getLatestMock.mockResolvedValueOnce(ok({ job: ready }));
    const unsubscribe = useExportJobStore.getState().subscribe();
    await vi.waitFor(() => expect(getLatestMock).toHaveBeenCalledTimes(1));

    getLatestMock.mockResolvedValueOnce(serverError<{ job: DataExchangeJobDto | null }>());
    const handlers = sseHandlers.get('data_exchange_job_changed');
    for (const h of handlers!) h();

    await vi.waitFor(() => expect(getLatestMock).toHaveBeenCalledTimes(2));
    expect(handleSessionExpiredMock).not.toHaveBeenCalled();
    expect(useExportJobStore.getState().job).toEqual(ready);

    unsubscribe();
  });
});

describe('exportJobStore — refetch race / epoch guard', () => {
  it('commits the newest refetch result when two triggers fire in the same tick', async () => {
    // A burst of triggers (mount probe + an SSE frame in the same tick)
    // issues parallel GETs; without an in-flight epoch guard the SLOWEST
    // response wins because setState blindly overwrites. The store captures
    // an epoch before awaiting and only commits if it is still current —
    // same gate as storageUsageStore.
    const stale = makeJob({ id: 'export-stale', status: 'pending', filesDone: 0 });
    const fresh = makeJob({ id: 'export-fresh', status: 'running', filesDone: 4 });

    // First (mount-probe) call resolves LAST; second (SSE) call resolves
    // first — so a naive last-write-wins store would end on `stale`.
    let resolveFirst!: (v: LatestResult) => void;
    getLatestMock.mockReturnValueOnce(
      new Promise<LatestResult>((r) => {
        resolveFirst = r;
      }),
    );
    getLatestMock.mockResolvedValueOnce(ok({ job: fresh }));

    const unsubscribe = useExportJobStore.getState().subscribe();
    // Fire the SSE-driven refetch while the mount probe is still pending.
    const handlers = sseHandlers.get('data_exchange_job_changed');
    for (const h of handlers!) h();

    // Let the second (fresh) call settle, then release the first (stale) one.
    await vi.waitFor(() => expect(useExportJobStore.getState().job).toEqual(fresh));
    resolveFirst(ok({ job: stale }));

    // The superseded mount-probe result must be discarded by the epoch guard.
    await Promise.resolve();
    await Promise.resolve();
    expect(useExportJobStore.getState().job).toEqual(fresh);

    unsubscribe();
  });
});
