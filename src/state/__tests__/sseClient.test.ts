/**
 * SSE client (`src/sse/client.ts`) — multiplexed `EventSource` over
 * `/api/events` with typed event subscriptions (ADR-0025). Unit-level
 * contracts:
 *
 *   1. First subscriber lazily opens the source; last unsubscribe
 *      closes it.
 *   2. Multiple subscribers to the same event share one DOM listener;
 *      the listener fans out to each registered handler.
 *   3. A frame arriving on event `X` does not call handlers for event
 *      `Y` (and vice versa).
 *   4. A handler that throws does not poison the fan-out — siblings
 *      registered under the same event still fire.
 *   5. After the underlying source enters CLOSED state (the spec's
 *      terminal state, reached on a non-200 answer such as 401 or
 *      502), the next `onSseEvent()` call builds a fresh
 *      `EventSource` rather than `addEventListener` on the dead one.
 *   6. A reconnect runs every subscribed handler once, so each view
 *      refetches what changed while the connection was down (ADR-0025:
 *      no replay; on reconnect the client refetches state).
 *   7. A source that closes for good while handlers remain — a non-200
 *      reconnect such as the proxy's 502 during an app restart — is
 *      reopened once the session probe succeeds; a revoked session
 *      ends in session-expired handling instead of a reconnect loop.
 *
 * Lives under `src/state/__tests__/` so vitest's `unit` project picks
 * it up alongside the other SSE-aware unit tests
 * (`projectSseSubscription.test.ts`, `storageUsageStore.test.ts`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ApiFailure, AuthUser } from '@/api/client';

const meMock = vi.fn<typeof import('@/api/client').authApi.me>();
const handleSessionExpiredMock = vi.fn();

vi.mock('@/api/client', () => ({ authApi: { me: meMock } }));
vi.mock('@/state/sessionExpired', () => ({ handleSessionExpired: handleSessionExpiredMock }));

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly url: string;
  readyState = FakeEventSource.CONNECTING;
  closed = false;
  readonly listeners = new Map<string, Set<EventListener>>();

  constructor(url: string) {
    this.url = url;
    constructorCallCount += 1;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- intentional: the fake records the latest constructed instance so tests can drive its readyState / dispatch path.
    lastEs = this;
  }

  addEventListener(name: string, handler: EventListener): void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(handler);
  }

  removeEventListener(name: string, handler: EventListener): void {
    this.listeners.get(name)?.delete(handler);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  /** The connection (re)established: readyState OPEN, `open` fires. */
  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.dispatch('open');
  }

  /**
   * A transport drop the browser recovers from on its own: readyState
   * back to CONNECTING, `error` fires, the same source reconnects.
   */
  dropTransient(): void {
    this.readyState = FakeEventSource.CONNECTING;
    this.dispatch('error');
  }

  /** Fan a frame out to every listener registered under `name`. */
  dispatch(name: string): void {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const h of [...set]) h({ type: name } as Event);
  }

  /**
   * Drive the source into the spec's terminal CLOSED state and fire
   * the `error` event the implementation would dispatch alongside it.
   * This is how a 401 or a 502 on reconnect presents to the client.
   */
  failClosed(): void {
    this.readyState = FakeEventSource.CLOSED;
    const set = this.listeners.get('error');
    if (!set) return;
    for (const h of [...set]) h({ type: 'error' } as Event);
  }
}

let lastEs: FakeEventSource | null = null;
let constructorCallCount = 0;

beforeEach(() => {
  // The shared component-setup stub is intentionally inert (no
  // readyState transitions, no dispatch path); replace it for this
  // file's contract tests so we can drive the failure modes the
  // implementation guards against.
  (globalThis as { EventSource: unknown }).EventSource = FakeEventSource;
  lastEs = null;
  constructorCallCount = 0;
  meMock.mockReset();
  meMock.mockResolvedValue(SESSION_OK);
  handleSessionExpiredMock.mockReset();
  // Fake timers everywhere: a recovery timer armed by one test must not
  // fire into the next one's fresh module.
  vi.useFakeTimers();
  // Reset module state — the client holds module-level singletons
  // (cached source + handler maps).
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** `authApi.me()` failing the way it does while the proxy answers 502. */
const SERVER_DOWN: ApiFailure = {
  ok: false,
  error: { code: 'API_ERROR', message: '' },
  category: 'server_error',
  sessionExpired: false,
};

const SESSION_OK = { ok: true as const, data: { user: {} as AuthUser } };

async function loadClient(): Promise<typeof import('../../sse/client')> {
  return import('../../sse/client');
}

describe('sse/client — subscription lifecycle', () => {
  it('lazily creates one EventSource on first subscribe and closes it on last unsubscribe', async () => {
    const { onSseEvent } = await loadClient();

    expect(constructorCallCount).toBe(0);

    const off = onSseEvent('project_changed', () => {});
    expect(constructorCallCount).toBe(1);
    expect(lastEs!.closed).toBe(false);

    off();
    expect(lastEs!.closed).toBe(true);
  });

  it('shares one DOM listener across multiple handlers for the same event', async () => {
    const { onSseEvent } = await loadClient();

    const a = vi.fn();
    const b = vi.fn();
    onSseEvent('project_changed', a);
    onSseEvent('project_changed', b);

    // One Set, two members — the client attaches a single DOM listener
    // per event name, then fans out to all registered handlers.
    expect(lastEs!.listeners.get('project_changed')?.size).toBe(1);

    lastEs!.dispatch('project_changed');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('does not cross-fire handlers between distinct event names', async () => {
    const { onSseEvent } = await loadClient();

    const projectHandler = vi.fn();
    const storageHandler = vi.fn();
    onSseEvent('project_changed', projectHandler);
    onSseEvent('storage_usage_changed', storageHandler);

    lastEs!.dispatch('project_changed');
    expect(projectHandler).toHaveBeenCalledTimes(1);
    expect(storageHandler).not.toHaveBeenCalled();

    lastEs!.dispatch('storage_usage_changed');
    expect(storageHandler).toHaveBeenCalledTimes(1);
    expect(projectHandler).toHaveBeenCalledTimes(1);
  });

  it('a handler throwing does not poison the fan-out', async () => {
    const { onSseEvent } = await loadClient();

    const a = vi.fn(() => {
      throw new Error('boom');
    });
    const b = vi.fn();
    onSseEvent('project_changed', a);
    onSseEvent('project_changed', b);

    expect(() => lastEs!.dispatch('project_changed')).not.toThrow();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe('sse/client — recovery from terminal-CLOSED state', () => {
  it('next subscribe after CLOSED creates a fresh EventSource', async () => {
    const { onSseEvent } = await loadClient();

    const handler1 = vi.fn();
    onSseEvent('project_changed', handler1);
    const firstEs = lastEs;
    expect(constructorCallCount).toBe(1);

    // Simulate the WHATWG terminal-error path: a 401 mid-stream lands
    // here. The implementation fires `error`, transitions readyState
    // to CLOSED, and stops reconnecting.
    firstEs!.failClosed();

    // A second subscribe AFTER the close. With a buggy ensureSource()
    // that returned the CLOSED cached source, the new handler would
    // attach to a dead listener set and never fire — the silent-broken
    // mode the auth-gating fix and this guard exist to prevent.
    const handler2 = vi.fn();
    onSseEvent('storage_usage_changed', handler2);

    expect(constructorCallCount).toBe(2);
    expect(lastEs).not.toBe(firstEs);

    // The fresh source must deliver to BOTH the previously-registered
    // handler (it never explicitly unsubscribed — the failure was
    // opaque to the consumer) and the newly-registered one. The client
    // re-attaches DOM listeners for every still-tracked event name on
    // recreate.
    lastEs!.dispatch('project_changed');
    expect(handler1).toHaveBeenCalledTimes(1);

    lastEs!.dispatch('storage_usage_changed');
    expect(handler2).toHaveBeenCalledTimes(1);
  });
});

describe('sse/client — reconnect refetches (ADR-0025: on reconnect the client refetches state)', () => {
  it('the first open does not fan out — each view fetched on mount', async () => {
    const { onSseEvent } = await loadClient();
    const handler = vi.fn();
    onSseEvent('project_changed', handler);

    lastEs!.open();

    expect(handler).not.toHaveBeenCalled();
  });

  it('a reconnect after a transport drop runs every subscribed handler once', async () => {
    const { onSseEvent } = await loadClient();
    const projectHandler = vi.fn();
    const storageHandler = vi.fn();
    onSseEvent('project_changed', projectHandler);
    onSseEvent('storage_usage_changed', storageHandler);
    lastEs!.open();

    // Network drop: the browser reconnects the same source on its own,
    // so the client must not start a recovery of its own.
    lastEs!.dropTransient();
    await vi.runAllTimersAsync();
    lastEs!.open();

    expect(projectHandler).toHaveBeenCalledTimes(1);
    expect(storageHandler).toHaveBeenCalledTimes(1);
    expect(constructorCallCount).toBe(1);
    expect(meMock).not.toHaveBeenCalled();
  });
});

describe('sse/client — recovery when the source closes for good', () => {
  it('a source closed by a 502 on reconnect (app restart behind the proxy) reopens, refetches once and delivers again', async () => {
    const { onSseEvent } = await loadClient();
    const handler = vi.fn();
    onSseEvent('project_changed', handler);
    lastEs!.open();

    // The observed sequence: the stream ends, the browser reconnects,
    // the reconnect gets a 502 and the source closes for good.
    lastEs!.dropTransient();
    lastEs!.failClosed();
    await vi.runAllTimersAsync();

    expect(constructorCallCount).toBe(2);
    lastEs!.open();
    expect(handler).toHaveBeenCalledTimes(1);

    lastEs!.dispatch('project_changed');
    expect(handler).toHaveBeenCalledTimes(2);

    // The next deploy: the recovered source recovers too.
    lastEs!.dropTransient();
    lastEs!.failClosed();
    await vi.runAllTimersAsync();
    expect(constructorCallCount).toBe(3);
  });

  it('opens no new source while the server stays unreachable, then reopens', async () => {
    const { onSseEvent } = await loadClient();
    onSseEvent('project_changed', vi.fn());
    lastEs!.open();
    meMock
      .mockResolvedValueOnce(SERVER_DOWN)
      .mockResolvedValueOnce(SERVER_DOWN)
      .mockResolvedValue(SESSION_OK);

    lastEs!.failClosed();
    await vi.runAllTimersAsync();

    expect(meMock).toHaveBeenCalledTimes(3);
    expect(constructorCallCount).toBe(2);
  });

  it('a revoked session ends in session-expired handling, not a reconnect loop', async () => {
    const { onSseEvent } = await loadClient();
    onSseEvent('project_changed', vi.fn());
    lastEs!.open();
    meMock.mockResolvedValue({
      ok: false,
      error: { code: 'SESSION_EXPIRED', message: '' },
      category: 'authentication',
      sessionExpired: true,
    });

    lastEs!.failClosed();
    await vi.runAllTimersAsync();

    expect(handleSessionExpiredMock).toHaveBeenCalledTimes(1);
    expect(constructorCallCount).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('unsubscribing the last handler cancels a pending recovery', async () => {
    const { onSseEvent } = await loadClient();
    const off = onSseEvent('project_changed', vi.fn());
    lastEs!.open();

    lastEs!.failClosed();
    off();
    await vi.runAllTimersAsync();

    expect(constructorCallCount).toBe(1);
    expect(handleSessionExpiredMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a probe that settles after the last unsubscribe opens nothing and stops', async () => {
    const { onSseEvent } = await loadClient();
    const off = onSseEvent('project_changed', vi.fn());
    lastEs!.open();
    let settleProbe!: (r: typeof SESSION_OK) => void;
    meMock.mockReturnValueOnce(new Promise((r) => (settleProbe = r)));

    lastEs!.failClosed();
    await vi.runOnlyPendingTimersAsync();
    expect(meMock).toHaveBeenCalledTimes(1);

    off();
    settleProbe(SESSION_OK);
    await vi.runAllTimersAsync();

    expect(constructorCallCount).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a probe that fails while a subscribe already reopened schedules nothing', async () => {
    const { onSseEvent } = await loadClient();
    onSseEvent('project_changed', vi.fn());
    lastEs!.open();
    let settleProbe!: (r: ApiFailure) => void;
    meMock.mockReturnValueOnce(new Promise((r) => (settleProbe = r)));

    lastEs!.failClosed();
    await vi.runOnlyPendingTimersAsync();
    onSseEvent('storage_usage_changed', vi.fn());
    settleProbe(SERVER_DOWN);
    await vi.runAllTimersAsync();

    expect(meMock).toHaveBeenCalledTimes(1);
    expect(constructorCallCount).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a subscribe while recovery is pending leaves exactly one live source', async () => {
    const { onSseEvent } = await loadClient();
    onSseEvent('project_changed', vi.fn());
    lastEs!.open();

    lastEs!.failClosed();
    // A view mounts during the outage and opens a source itself.
    onSseEvent('storage_usage_changed', vi.fn());
    const subscribedEs = lastEs;
    await vi.runAllTimersAsync();

    expect(constructorCallCount).toBe(2);
    expect(lastEs).toBe(subscribedEs);
    expect(subscribedEs!.closed).toBe(false);
  });
});
