/**
 * attachmentSseSubscription — wires the attachment caches to refresh on
 * every `attachment_changed` SSE frame (api.md §14.2.13, AC-337, #237).
 *
 * Unit contract (the AC-337 two-browser value test lives in e2e):
 *   1. Subscribing registers a handler under `attachment_changed`.
 *   2. A frame refetches `byProject` for every cached project and the
 *      Papierkorb (`hiddenByProject`) for every project whose trash was
 *      opened — the event is payload-less, so all loaded projects refresh.
 *   3. A project whose Papierkorb was never opened triggers no trash fetch.
 *   4. Unsubscribe removes the listener; a later frame does not refetch.
 *   5. subscribe → unsubscribe → subscribe yields a fresh handler each
 *      cycle (the auth-gated App.tsx lifecycle; no singleton dedupe that
 *      would silently swallow a re-login).
 *
 * Mocks mirror projectSseSubscription.test.ts: a typed-bus stub exposes
 * the registered handler so the test dispatches through it; the store's
 * fetch actions are spied so the test asserts the fan-out shape.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('@/sse/client', () => ({
  onSseEvent: (name: string, handler: SseHandler) => onSseEventMock(name, handler),
}));

const fetchForProjectMock = vi.fn(async () => {});
const fetchTrashForProjectMock = vi.fn(async () => ({ kind: 'ok' as const }));

// Mutable state object so each test seeds the caches before firing a
// frame; the handler reads `getState()` fresh on every frame.
const storeState: {
  byProject: Record<string, unknown[]>;
  hiddenByProject: Record<string, unknown[]>;
  fetchForProject: typeof fetchForProjectMock;
  fetchTrashForProject: typeof fetchTrashForProjectMock;
} = {
  byProject: {},
  hiddenByProject: {},
  fetchForProject: fetchForProjectMock,
  fetchTrashForProject: fetchTrashForProjectMock,
};

vi.mock('@/state/attachmentStore', () => ({
  useAttachmentStore: { getState: () => storeState },
}));

const { subscribeAttachmentStoreToSse } = await import('@/state/attachmentSseSubscription');

beforeEach(() => {
  onSseEventMock.mockClear();
  fetchForProjectMock.mockClear();
  fetchTrashForProjectMock.mockClear();
  sseHandlers.clear();
  storeState.byProject = {};
  storeState.hiddenByProject = {};
});

afterEach(() => {
  vi.restoreAllMocks();
});

function fire(): void {
  const handlers = sseHandlers.get('attachment_changed');
  for (const h of handlers ?? []) h();
}

describe('attachmentSseSubscription — wiring (AC-337, #237)', () => {
  it('registers a handler for the attachment_changed event', () => {
    subscribeAttachmentStoreToSse();
    expect(onSseEventMock).toHaveBeenCalledTimes(1);
    expect(onSseEventMock).toHaveBeenCalledWith('attachment_changed', expect.any(Function));
  });

  it('refetches byProject for every cached project on a frame', () => {
    storeState.byProject = { p1: [], p2: [] };
    subscribeAttachmentStoreToSse();
    fire();
    expect(fetchForProjectMock).toHaveBeenCalledTimes(2);
    expect(fetchForProjectMock).toHaveBeenCalledWith('p1');
    expect(fetchForProjectMock).toHaveBeenCalledWith('p2');
  });

  it('refetches the Papierkorb only for projects whose trash was opened', () => {
    storeState.byProject = { p1: [], p2: [] };
    storeState.hiddenByProject = { p2: [] };
    subscribeAttachmentStoreToSse();
    fire();
    expect(fetchTrashForProjectMock).toHaveBeenCalledTimes(1);
    expect(fetchTrashForProjectMock).toHaveBeenCalledWith('p2');
  });

  it('triggers no fetches when no project is cached', () => {
    subscribeAttachmentStoreToSse();
    fire();
    expect(fetchForProjectMock).not.toHaveBeenCalled();
    expect(fetchTrashForProjectMock).not.toHaveBeenCalled();
  });

  it('stops refetching after unsubscribe', () => {
    storeState.byProject = { p1: [] };
    const unsubscribe = subscribeAttachmentStoreToSse();
    fire();
    expect(fetchForProjectMock).toHaveBeenCalledTimes(1);

    unsubscribe();
    fire();
    expect(fetchForProjectMock).toHaveBeenCalledTimes(1);
  });

  it('subscribe → unsubscribe → subscribe yields a fresh handler each cycle', () => {
    const unsubscribe1 = subscribeAttachmentStoreToSse();
    expect(sseHandlers.get('attachment_changed')?.size).toBe(1);

    unsubscribe1();
    expect(sseHandlers.get('attachment_changed')?.size ?? 0).toBe(0);

    subscribeAttachmentStoreToSse();
    expect(sseHandlers.get('attachment_changed')?.size).toBe(1);
  });
});
