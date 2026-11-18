/**
 * Realtime invalidation event bus over the browser-native `EventSource`.
 *
 * Per ADR-0025 the client opens a single multiplexed SSE connection to
 * `/api/events`; consumers subscribe by event name, not by stream. The
 * payload is an invalidation hint (the server frame's `data` is unused
 * by handlers) — the consumer refetches via the gated read endpoint
 * after the handler fires.
 *
 * Lifecycle posture:
 *   - One EventSource per tab (ADR-0025 connection-model pin). All
 *     handlers, regardless of event name, share the same underlying
 *     connection. Opening a separate EventSource per handler would
 *     multiply server-side connections without any benefit.
 *   - Lazily created on first `onSseEvent` call; closed when the last
 *     subscriber unsubscribes. The next subscribe rebuilds it. This
 *     keeps the connection cost zero when no UI surface is mounted.
 *   - WHATWG `EventSource` reconnects on transport failure at the
 *     implementation-defined reconnection time the spec mandates
 *     (overridable by the server's `retry:` field, not used here).
 *     A non-200 answer to that reconnect — the proxy's 502 while the
 *     app restarts, or a 401 after the session was revoked — moves the
 *     source to CLOSED for good. The client then probes the session
 *     with growing delays: an expired session goes to the shared
 *     session-expired handling; otherwise, once the probe succeeds, a
 *     fresh source opens. A subscribe meanwhile opens it at once.
 *   - No replay (ADR-0025): every reopen after the first open of a
 *     subscription lifetime runs each handler once, so every view
 *     refetches what changed while the connection was down.
 *   - Same-origin only — cookies ride along automatically. Do not
 *     pass `withCredentials: true` (it is for cross-origin only and
 *     causes a CORS preflight that the server is not configured for).
 */

import { authApi } from '@/api/client';
import { handleSessionExpired } from '@/state/sessionExpired';

const SSE_URL = '/api/events';
const RECOVERY_DELAY_MIN_MS = 1_000;
const RECOVERY_DELAY_MAX_MS = 15_000; // inside AC-682's 30 s, with margin

let source: EventSource | null = null;
const handlersByEvent = new Map<string, Set<() => void>>();
const listenersByEvent = new Map<string, (e: MessageEvent) => void>();
/** A source opened since the first subscribe; the next open is a reconnect. */
let hasOpened = false;
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
let recoveryDelayMs = RECOVERY_DELAY_MIN_MS;

function ensureSource(): EventSource {
  // A source that closed for good was dropped by its `error` listener
  // below, so a cached one is always live.
  if (source) return source;
  cancelRecovery();
  source = new EventSource(SSE_URL);
  source.addEventListener('open', () => {
    recoveryDelayMs = RECOVERY_DELAY_MIN_MS;
    if (hasOpened) runAllHandlers();
    hasOpened = true;
  });
  // A CLOSED source never reconnects on its own: drop it and recover.
  source.addEventListener('error', () => {
    if (source && source.readyState === EventSource.CLOSED) {
      source = null;
      listenersByEvent.clear();
      scheduleRecovery();
    }
  });
  // Re-attach DOM listeners to the newly created source for every
  // event name we already track: a resubscribe after the last
  // unsubscribe, and a source reopened after a terminal close.
  for (const eventName of handlersByEvent.keys()) {
    attachDomListener(source, eventName);
  }
  return source;
}

function runAllHandlers(): void {
  for (const set of handlersByEvent.values()) runHandlers(set);
}

function runHandlers(set: Set<() => void>): void {
  for (const h of [...set]) {
    try {
      h();
    } catch {
      /* a faulty handler must not poison the fan-out */
    }
  }
}

function scheduleRecovery(): void {
  if (recoveryTimer || handlersByEvent.size === 0) return;
  const delay = recoveryDelayMs;
  recoveryDelayMs = Math.min(delay * 2, RECOVERY_DELAY_MAX_MS);
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    void recover();
  }, delay);
}

async function recover(): Promise<void> {
  const probe = await authApi.me();
  // Settled meanwhile: every handler left, or a subscribe reopened.
  if (handlersByEvent.size === 0 || source) return;
  if (probe.ok) {
    ensureSource();
  } else if (probe.sessionExpired) {
    handleSessionExpired();
  } else {
    scheduleRecovery();
  }
}

function cancelRecovery(): void {
  if (recoveryTimer) clearTimeout(recoveryTimer);
  recoveryTimer = null;
}

function attachDomListener(es: EventSource, eventName: string): void {
  if (listenersByEvent.has(eventName)) return;
  const listener = (): void => {
    const set = handlersByEvent.get(eventName);
    if (set) runHandlers(set);
  };
  es.addEventListener(eventName, listener);
  listenersByEvent.set(eventName, listener);
}

function teardownIfIdle(): void {
  if (handlersByEvent.size > 0) return;
  cancelRecovery();
  hasOpened = false;
  recoveryDelayMs = RECOVERY_DELAY_MIN_MS;
  if (!source) return;
  for (const [name, listener] of listenersByEvent) {
    source.removeEventListener(name, listener);
  }
  listenersByEvent.clear();
  source.close();
  source = null;
}

/**
 * Subscribe to a typed SSE event. The handler is called once per frame
 * the server emits with this event name. Returns an unsubscribe handle;
 * dropping the last handler closes the underlying connection.
 */
export function onSseEvent(name: string, handler: () => void): () => void {
  let set = handlersByEvent.get(name);
  if (!set) {
    set = new Set();
    handlersByEvent.set(name, set);
  }
  set.add(handler);

  const es = ensureSource();
  attachDomListener(es, name);

  return () => {
    const current = handlersByEvent.get(name);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) {
      handlersByEvent.delete(name);
      const listener = listenersByEvent.get(name);
      if (listener && source) {
        source.removeEventListener(name, listener);
      }
      listenersByEvent.delete(name);
    }
    teardownIfIdle();
  };
}
