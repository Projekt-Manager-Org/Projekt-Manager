/**
 * Realtime invalidation bus — ADR-0025.
 *
 * In-process pub/sub over SSE connections. Each subscriber is a writer
 * (the live `/api/events` reply); `broadcast(eventName)` fans out one
 * SSE frame to every registered writer. A failing writer is removed
 * silently — same posture as the notification publisher's post-commit
 * fan-out (AC-183). The originating mutation has already
 * committed by the time we reach this code; emission failures cannot
 * roll it back.
 *
 * Two surfaces:
 *   - `createSseBus(opts?)` — pure factory used by unit tests so each
 *     case runs against an isolated bus.
 *   - Module-level `subscribe` / `unsubscribe` / `broadcast` — operate
 *     on the singleton consumed by the `/api/events` route handler and
 *     by the AttachmentService / hidden-reaper emitters. Mirrors the
 *     module-level wiring of `notification-publisher.ts` (boundDb /
 *     boundDispatcher pattern).
 */

export interface SseConnection {
  /** Write a single SSE frame chunk to the connection. */
  write(chunk: string): void;
  /**
   * Optional close-handler hook. The route handler does NOT need this —
   * it owns the request/response lifecycle and removes the subscriber
   * directly via `unsubscribe()`. Exposed for the unit-bus tests so a
   * fake connection can simulate close without spinning a real socket.
   */
  onClose?(handler: () => void): void;
}

/**
 * Structured logger interface — mirrors the pino-style `(ctx, msg)`
 * signature used elsewhere in the server (notification-publisher,
 * attachment-hidden-reaper, audit-publisher). The bus only emits on
 * the error channel today (per-subscriber write failure); a future
 * info channel would land here when there is something to say.
 */
export interface SseBusLogger {
  error?: (ctx: Record<string, unknown>, event: string) => void;
}

export interface SseBus {
  subscribe(c: SseConnection): void;
  unsubscribe(c: SseConnection): void;
  broadcast(eventName: string): void;
  /** Observable subscriber count — exposed for tests. */
  size(): number;
}

export interface CreateSseBusOpts {
  logger?: SseBusLogger;
}

const SUBSCRIBER_WRITE_FAILED_EVENT = 'sse-bus-subscriber-write-failed';

/**
 * Build an isolated bus instance. Subscribers form a `Set`; broadcast
 * snapshots the set before iterating so an unsubscribe-during-write
 * (caused by our own removal of a failing subscriber, or by a
 * subscriber's onClose teardown) cannot mutate the iterator.
 */
export function createSseBus(opts: CreateSseBusOpts = {}): SseBus {
  const subscribers = new Set<SseConnection>();
  const logger = opts.logger;

  return {
    subscribe(c) {
      subscribers.add(c);
    },
    unsubscribe(c) {
      subscribers.delete(c);
    },
    broadcast(eventName) {
      // The frame names the kind of change only, never data (AC-680).
      const envelope = { type: eventName };
      const frame = `event: ${eventName}\ndata: ${JSON.stringify(envelope)}\n\n`;
      for (const c of [...subscribers]) {
        try {
          c.write(frame);
        } catch (err) {
          subscribers.delete(c);
          const errorHint = err instanceof Error ? err.message : String(err);
          // Guard the logger call: the bus contract says emission
          // failures cannot affect the originating mutation, which has
          // already committed by the time we reach this code. A
          // throwing logger (circular ctx, fault in the configured
          // sink) would otherwise propagate out of broadcast() and
          // surface as 5xx to a client whose write succeeded.
          try {
            logger?.error?.(
              { event: SUBSCRIBER_WRITE_FAILED_EVENT, error_hint: errorHint },
              SUBSCRIBER_WRITE_FAILED_EVENT,
            );
          } catch {
            // intentionally swallow — same posture as
            // notification-publisher's post-commit handlers (AC-183)
          }
        }
      }
    },
    size() {
      return subscribers.size;
    },
  };
}

let singleton: SseBus = createSseBus();

/**
 * Replace the singleton bus — used at app startup to wire the
 * operational logger. Any prior subscribers are abandoned; the route
 * handler re-subscribes per connection so a boot-time configuration is
 * idempotent in practice.
 */
export function configureSseBus(opts: CreateSseBusOpts): void {
  singleton = createSseBus(opts);
}

export function subscribe(c: SseConnection): void {
  singleton.subscribe(c);
}

export function unsubscribe(c: SseConnection): void {
  singleton.unsubscribe(c);
}

export function broadcast(eventName: string): void {
  singleton.broadcast(eventName);
}

/**
 * Module-level subscriber count — same purpose as the per-instance
 * `size()` exposed on `SseBus`, but reaches the singleton the
 * `/api/events` route subscribes against. Test-only — nothing in
 * production reads this.
 */
export function size(): number {
  return singleton.size();
}

/**
 * Test-only reset — drop the singleton's subscriber set. Mirrors
 * `notification-publisher.__resetForTests`. Production has no reason
 * to call this.
 */
export function __resetForTests(): void {
  singleton = createSseBus();
}
