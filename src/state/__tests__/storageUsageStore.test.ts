/**
 * storageUsageStore — shared subscription that powers the Footer badge
 * ([ui/index.md §8.1.2]) and the DatenView storage row ([ui/daten.md
 * §8.11.3]). Pins the store's four refresh triggers:
 *
 *   1. Mount — first subscriber triggers a fetch via storageUsageApi.getGlobal()
 *   2. visibilitychange → visible — refetch when the tab returns to foreground
 *   3. Post-mutation refresh() — the orchestrators that move counter bytes
 *      invoke refresh() after their successful path
 *   4. storage_usage_changed SSE event — cross-session invalidation
 *
 * Each trigger is the load-bearing client-side behavior the spec pins.
 *
 * Surface judgement (the implementer will conform):
 *   - State store at `@/state/storageUsageStore` (Zustand slice — matches
 *     the dominant pattern in `src/state/`).
 *   - Public actions: `subscribe()` (returns an unsubscribe handle),
 *     `refresh()` (forces a refetch), `data` (the StorageUsageDto or null).
 *   - The SSE primitive is `onSseEvent(name, handler) => unsubscribe`
 *     from `@/sse/client` — a typed event bus over the browser-native
 *     EventSource per ADR-0025.
 *
 * Coverage references AC-450 for the post-mutation and SSE refreshes;
 * its cross-session form is covered by an E2E spec, not this file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ApiResult } from '@/api/client';

interface StorageUsageDto {
  ready: { plaintext: number; ciphertext: number };
  hidden: { plaintext: number; ciphertext: number };
}

type GetGlobalResult = ApiResult<StorageUsageDto>;

const getGlobalMock = vi.fn<() => Promise<GetGlobalResult>>();

// Lightweight typed SSE bus mock: tests can grab the registered handler
// for a given event name and dispatch through it. Mirrors the contract
// implied by [architecture.md §11.13] (consumer-side: subscribe to a
// typed event name; payload is an invalidation hint, not data).
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
    storageUsageApi: {
      getGlobal: (...args: unknown[]) =>
        getGlobalMock(...(args as Parameters<typeof getGlobalMock>)),
    },
  };
});

vi.mock('@/sse/client', () => ({
  onSseEvent: (name: string, handler: SseHandler) => onSseEventMock(name, handler),
}));

// Spy on the shared session-expiry handler the store delegates to. The
// store imports `handleSessionExpired` from `@/state/sessionExpired`,
// which itself fans out to the auth store; tests don't need the auth
// store wired up here — only that the handler is invoked when the
// refetch reports an expired session.
const handleSessionExpiredMock = vi.fn();
vi.mock('@/state/sessionExpired', () => ({
  handleSessionExpired: () => handleSessionExpiredMock(),
}));

const { useStorageUsageStore } = await import('@/state/storageUsageStore');

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

function makeUsage(readyBytes: number, hiddenBytes: number): StorageUsageDto {
  return {
    ready: { plaintext: readyBytes, ciphertext: readyBytes * 2 },
    hidden: { plaintext: hiddenBytes, ciphertext: hiddenBytes * 2 },
  };
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  Object.defineProperty(document, 'hidden', { configurable: true, value: state === 'hidden' });
}

beforeEach(() => {
  getGlobalMock.mockReset();
  onSseEventMock.mockClear();
  handleSessionExpiredMock.mockReset();
  sseHandlers.clear();
  setVisibility('visible');
  // Reset the singleton store so each test starts from a clean slate.
  // The store's reset hook is part of its public test contract.
  useStorageUsageStore.getState().__resetForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('storageUsageStore — mount-time fetch', () => {
  it('fetches via storageUsageApi.getGlobal() when the first subscriber registers', async () => {
    getGlobalMock.mockResolvedValue(ok(makeUsage(2048, 1024)));

    const unsubscribe = useStorageUsageStore.getState().subscribe();

    await vi.waitFor(() => expect(getGlobalMock).toHaveBeenCalledTimes(1));
    expect(useStorageUsageStore.getState().data).toEqual(makeUsage(2048, 1024));

    unsubscribe();
  });

  it('does not refetch when a second subscriber joins an already-loaded store', async () => {
    // The shared subscription's contract is one fetch per refresh-trigger
    // event, not one fetch per consumer. Footer + DatenView mounting in
    // the same render pass must produce a single network call.
    getGlobalMock.mockResolvedValue(ok(makeUsage(0, 0)));

    const unsubA = useStorageUsageStore.getState().subscribe();
    await vi.waitFor(() => expect(getGlobalMock).toHaveBeenCalledTimes(1));

    const unsubB = useStorageUsageStore.getState().subscribe();
    // Allow microtasks to flush — a regression that re-fetches per
    // subscriber would surface here.
    await Promise.resolve();
    await Promise.resolve();
    expect(getGlobalMock).toHaveBeenCalledTimes(1);

    unsubA();
    unsubB();
  });
});

describe('storageUsageStore — visibilitychange refresh', () => {
  it('refetches when document.visibilityState flips back to visible', async () => {
    getGlobalMock.mockResolvedValueOnce(ok(makeUsage(100, 0)));
    const unsubscribe = useStorageUsageStore.getState().subscribe();
    await vi.waitFor(() => expect(getGlobalMock).toHaveBeenCalledTimes(1));

    getGlobalMock.mockResolvedValueOnce(ok(makeUsage(500, 200)));
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    // Hidden → visible is the trigger; hidden alone must not refetch.
    expect(getGlobalMock).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));

    await vi.waitFor(() => expect(getGlobalMock).toHaveBeenCalledTimes(2));
    expect(useStorageUsageStore.getState().data).toEqual(makeUsage(500, 200));

    unsubscribe();
  });
});

describe('storageUsageStore — post-mutation refresh() (AC-450)', () => {
  it('refetches and updates state when refresh() is called explicitly', async () => {
    getGlobalMock.mockResolvedValueOnce(ok(makeUsage(0, 0)));
    const unsubscribe = useStorageUsageStore.getState().subscribe();
    await vi.waitFor(() => expect(getGlobalMock).toHaveBeenCalledTimes(1));

    getGlobalMock.mockResolvedValueOnce(ok(makeUsage(2048, 0)));
    await useStorageUsageStore.getState().refresh();

    expect(getGlobalMock).toHaveBeenCalledTimes(2);
    expect(useStorageUsageStore.getState().data).toEqual(makeUsage(2048, 0));

    unsubscribe();
  });
});

describe('storageUsageStore — SSE invalidation (AC-450)', () => {
  it('subscribes to the storage_usage_changed event when the first subscriber registers', () => {
    getGlobalMock.mockResolvedValue(ok(makeUsage(0, 0)));

    const unsubscribe = useStorageUsageStore.getState().subscribe();

    expect(onSseEventMock).toHaveBeenCalledWith('storage_usage_changed', expect.any(Function));

    unsubscribe();
  });

  it('refetches when a storage_usage_changed event fires', async () => {
    getGlobalMock.mockResolvedValueOnce(ok(makeUsage(0, 0)));
    const unsubscribe = useStorageUsageStore.getState().subscribe();
    await vi.waitFor(() => expect(getGlobalMock).toHaveBeenCalledTimes(1));

    getGlobalMock.mockResolvedValueOnce(ok(makeUsage(4096, 1024)));
    // Fire the registered handler — simulates a frame arriving on the
    // SSE channel from another session's mutation. ADR-0025 pins the
    // payload as an invalidation hint, not a data carrier; the consumer
    // refetches via the gated read endpoint.
    const handlers = sseHandlers.get('storage_usage_changed');
    expect(handlers && handlers.size).toBeGreaterThan(0);
    for (const h of handlers!) h();

    await vi.waitFor(() => expect(getGlobalMock).toHaveBeenCalledTimes(2));
    expect(useStorageUsageStore.getState().data).toEqual(makeUsage(4096, 1024));

    unsubscribe();
  });
});

describe('storageUsageStore — refetch failure surfacing', () => {
  // Failure surface for the SSE → refetch path. Without this, an event
  // arriving after session expiry triggers a refetch that returns a
  // 401 SESSION_EXPIRED, and the previous `data` lingers in the badge
  // / DatenView row indefinitely. The store delegates to the shared
  // session-expiry handler — same surface every other store uses.
  function expired<T>(): ApiResult<T> {
    return {
      ok: false,
      error: { code: 'SESSION_EXPIRED', message: 'Sitzung abgelaufen.' },
      category: 'authentication',
      sessionExpired: true,
    };
  }

  function serverError<T>(): ApiResult<T> {
    return {
      ok: false,
      error: { code: 'SERVER_ERROR', message: 'Serverfehler.' },
      category: 'server_error',
      sessionExpired: false,
    };
  }

  it('delegates to handleSessionExpired when the SSE-driven refetch lands after session expiry', async () => {
    getGlobalMock.mockResolvedValueOnce(ok(makeUsage(2048, 1024)));
    const unsubscribe = useStorageUsageStore.getState().subscribe();
    await vi.waitFor(() => expect(getGlobalMock).toHaveBeenCalledTimes(1));
    expect(useStorageUsageStore.getState().data).toEqual(makeUsage(2048, 1024));

    getGlobalMock.mockResolvedValueOnce(expired());
    const handlers = sseHandlers.get('storage_usage_changed');
    for (const h of handlers!) h();

    await vi.waitFor(() => expect(handleSessionExpiredMock).toHaveBeenCalledTimes(1));
    // Non-OK result must NOT clobber the prior `data` — the auth store
    // is responsible for tearing down the session UI; the badge keeps
    // showing the last good value until the redirect lands.
    expect(useStorageUsageStore.getState().data).toEqual(makeUsage(2048, 1024));

    unsubscribe();
  });

  it('does not call handleSessionExpired on non-auth refetch failures', async () => {
    getGlobalMock.mockResolvedValueOnce(ok(makeUsage(2048, 1024)));
    const unsubscribe = useStorageUsageStore.getState().subscribe();
    await vi.waitFor(() => expect(getGlobalMock).toHaveBeenCalledTimes(1));

    getGlobalMock.mockResolvedValueOnce(serverError());
    const handlers = sseHandlers.get('storage_usage_changed');
    for (const h of handlers!) h();

    await vi.waitFor(() => expect(getGlobalMock).toHaveBeenCalledTimes(2));
    expect(handleSessionExpiredMock).not.toHaveBeenCalled();
    // Transient failure: state stays put; the next trigger retries.
    expect(useStorageUsageStore.getState().data).toEqual(makeUsage(2048, 1024));

    unsubscribe();
  });
});
