/**
 * ActivityFeed — SSE-driven realtime refresh.
 *
 * The per-project activity feed previously only refetched on filterKey
 * change, so mutations that wrote audit rows without bumping the
 * parent project's `updatedAt` (attachment add / hide / restore,
 * invoice, customer) left the feed showing stale data until manual
 * reload.
 *
 * Fix: the feed subscribes to `audit_changed` on mount and refetches
 * the current filter via a ref so the subscription does not have to
 * retrigger on every filter change. This test pins:
 *
 *   1. Mount subscribes to `audit_changed` via `onSseEvent`.
 *   2. Firing the registered handler calls `auditApi.list` again
 *      (refetch with the same filters).
 *   3. Unmount runs the unsubscribe returned by `onSseEvent`.
 *   4. The handler reads the latest filters from the ref, so a
 *      filter change between mount and the next frame uses the new
 *      filters.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { ApiResult } from '@/api/client';
import type { AuditEntry, AuditListResponse, AuditListParams } from '@/domain/audit';

// Typed SSE bus mock — tests grab the registered handler for a given
// event name and dispatch through it. Mirrors `projectSseSubscription.test.ts`.
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

const listMock = vi.fn<(params?: AuditListParams) => Promise<ApiResult<AuditListResponse>>>();

vi.mock('@/api/client', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    auditApi: {
      list: (...args: unknown[]) => listMock(...(args as Parameters<typeof listMock>)),
      get: vi.fn(),
    },
  };
});

const { ActivityFeed } = await import('@/ui/audit/ActivityFeed');

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

function emptyResponse(): AuditListResponse {
  return { data: [] as AuditEntry[], total: 0 };
}

beforeEach(() => {
  onSseEventMock.mockClear();
  listMock.mockReset();
  listMock.mockResolvedValue(ok(emptyResponse()));
  sseHandlers.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ActivityFeed — audit_changed SSE subscription', () => {
  it('subscribes to audit_changed on mount', () => {
    render(
      <ActivityFeed
        filters={{ ancestorType: 'project', ancestorId: 'p-1' }}
        filterKey="p-1"
        testId="activity-feed"
      />,
    );

    expect(onSseEventMock).toHaveBeenCalledWith('audit_changed', expect.any(Function));
    expect(sseHandlers.get('audit_changed')?.size).toBe(1);
  });

  it('refetches the list when an audit_changed frame arrives', async () => {
    render(
      <ActivityFeed
        filters={{ ancestorType: 'project', ancestorId: 'p-1' }}
        filterKey="p-1"
        testId="activity-feed"
      />,
    );

    // Initial mount-time fetch from the filterKey-driven effect.
    await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    // Simulate one audit_changed frame.
    const handlers = sseHandlers.get('audit_changed');
    expect(handlers && handlers.size).toBe(1);
    for (const h of handlers!) h();

    await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    // Both fetches carry the same project-scoped filter — proving the
    // SSE handler reuses the active filters rather than the default.
    const lastCall = listMock.mock.calls.at(-1)?.[0];
    expect(lastCall?.ancestorType).toBe('project');
    expect(lastCall?.ancestorId).toBe('p-1');
  });

  it('unsubscribes on unmount — no refetch after a frame arrives post-unmount', async () => {
    const { unmount } = render(
      <ActivityFeed
        filters={{ ancestorType: 'project', ancestorId: 'p-1' }}
        filterKey="p-1"
        testId="activity-feed"
      />,
    );

    await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    expect(sseHandlers.get('audit_changed')?.size).toBe(1);

    unmount();

    // The unsubscribe from `onSseEvent` removed the handler.
    expect(sseHandlers.get('audit_changed')?.size ?? 0).toBe(0);

    // A frame arriving after unmount must not refetch (the only handler
    // we'd reach was removed by the cleanup). Defensive: dispatch
    // through whatever remains; nothing should call listMock again.
    const remaining = sseHandlers.get('audit_changed');
    if (remaining) for (const h of remaining) h();
    await new Promise<void>((r) => setImmediate(r));
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it('uses the latest filters when refetching — filter change between mount and frame is honored', async () => {
    // Render with filter A, change to filter B via a filterKey change,
    // then fire an audit_changed frame. The SSE-driven refetch must use
    // filter B (read through the ref), not the stale filter A.
    const { rerender } = render(
      <ActivityFeed
        filters={{ ancestorType: 'project', ancestorId: 'p-1' }}
        filterKey="p-1"
        testId="activity-feed"
      />,
    );

    await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    rerender(
      <ActivityFeed
        filters={{ ancestorType: 'project', ancestorId: 'p-2' }}
        filterKey="p-2"
        testId="activity-feed"
      />,
    );

    // filterKey change fired its own refetch (the existing effect).
    await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));

    // The SSE subscription must remain a single handler — it should not
    // re-subscribe on filter change.
    expect(onSseEventMock).toHaveBeenCalledTimes(1);
    expect(sseHandlers.get('audit_changed')?.size).toBe(1);

    // Fire a frame — refetch must carry the new filter (p-2).
    const handlers = sseHandlers.get('audit_changed');
    for (const h of handlers!) h();

    await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(3));
    const lastCall = listMock.mock.calls.at(-1)?.[0];
    expect(lastCall?.ancestorId).toBe('p-2');
  });
});
