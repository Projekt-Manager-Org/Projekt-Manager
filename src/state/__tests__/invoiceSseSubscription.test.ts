/**
 * invoiceSseSubscription — wires the invoice stores to refresh on every
 * `invoice_changed` frame and on every realtime reconnect (ADR-0025,
 * AC-682: the reconnect re-runs this same handler).
 *
 * Unit-level contract:
 *   1. Subscribing registers one handler under `invoice_changed`.
 *   2. A frame refetches every loaded per-project invoice cache, every
 *      loaded invoice detail, and the list with its years — the list
 *      only once it was loaded.
 *   3. After unsubscribe, a frame refetches nothing.
 *
 * The per-project and list stores are mocked (fan-out shape); the
 * detail store is real with `fetch` stubbed, so `refreshAll` is exercised.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type SseHandler = () => void;
const sseHandlers = new Map<string, Set<SseHandler>>();

vi.mock('@/sse/client', () => ({
  onSseEvent: (name: string, handler: SseHandler): (() => void) => {
    let set = sseHandlers.get(name);
    if (!set) {
      set = new Set();
      sseHandlers.set(name, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  },
}));

const fetchByProjectMock = vi.fn(async (_projectId: string) => {});
let byProject: Record<string, unknown> = {};

vi.mock('@/state/invoiceStore', () => ({
  useInvoiceStore: {
    getState: () => ({ byProject, fetchByProject: fetchByProjectMock }),
  },
}));

const listFetchMock = vi.fn(async () => {});
const listFetchYearsMock = vi.fn(async () => {});
let listInitialized = false;

vi.mock('@/state/invoiceListStore', () => ({
  useInvoiceListStore: {
    getState: () => ({
      hasInitialized: listInitialized,
      fetch: listFetchMock,
      fetchYears: listFetchYearsMock,
    }),
  },
}));

const { useInvoiceDetailStore } = await import('@/state/invoiceDetailStore');
const { subscribeInvoiceStoreToSse } = await import('@/state/invoiceSseSubscription');

const detailFetchMock = vi.fn(async (_invoiceId: string) => {});

function fireInvoiceChanged(): void {
  for (const h of sseHandlers.get('invoice_changed') ?? []) h();
}

beforeEach(() => {
  sseHandlers.clear();
  fetchByProjectMock.mockClear();
  listFetchMock.mockClear();
  listFetchYearsMock.mockClear();
  detailFetchMock.mockClear();
  byProject = {};
  listInitialized = false;
  useInvoiceDetailStore.setState({ statusById: {}, fetch: detailFetchMock });
});

describe('AC-682: invoiceSseSubscription refetches every loaded invoice view', () => {
  it('registers one handler under invoice_changed', () => {
    subscribeInvoiceStoreToSse();

    expect(sseHandlers.get('invoice_changed')?.size).toBe(1);
  });

  it('AC-719: a frame refetches every loaded project cache, invoice detail, and the loaded list with its years', () => {
    byProject = { 'project-a': {}, 'project-b': {} };
    listInitialized = true;
    useInvoiceDetailStore.setState({ statusById: { 'invoice-1': 'ok', 'invoice-2': 'error' } });
    subscribeInvoiceStoreToSse();

    fireInvoiceChanged();

    expect(fetchByProjectMock.mock.calls.map(([id]) => id).sort()).toEqual([
      'project-a',
      'project-b',
    ]);
    expect(detailFetchMock.mock.calls.map(([id]) => id).sort()).toEqual(['invoice-1', 'invoice-2']);
    expect(listFetchMock).toHaveBeenCalledTimes(1);
    expect(listFetchYearsMock).toHaveBeenCalledTimes(1);
  });

  it('a frame leaves a never-loaded list alone but still refetches the project caches and details', () => {
    byProject = { 'project-a': {} };
    useInvoiceDetailStore.setState({ statusById: { 'invoice-1': 'ok' } });
    subscribeInvoiceStoreToSse();

    fireInvoiceChanged();

    expect(listFetchMock).not.toHaveBeenCalled();
    expect(listFetchYearsMock).not.toHaveBeenCalled();
    expect(fetchByProjectMock).toHaveBeenCalledWith('project-a');
    expect(detailFetchMock).toHaveBeenCalledWith('invoice-1');
  });

  it('after unsubscribe, a frame refetches nothing', () => {
    byProject = { 'project-a': {} };
    listInitialized = true;
    useInvoiceDetailStore.setState({ statusById: { 'invoice-1': 'ok' } });
    const unsubscribe = subscribeInvoiceStoreToSse();

    unsubscribe();
    fireInvoiceChanged();

    expect(fetchByProjectMock).not.toHaveBeenCalled();
    expect(detailFetchMock).not.toHaveBeenCalled();
    expect(listFetchMock).not.toHaveBeenCalled();
  });
});
