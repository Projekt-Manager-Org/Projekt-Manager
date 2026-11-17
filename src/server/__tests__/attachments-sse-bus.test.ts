/**
 * SSE invalidation bus — unit tests (issue #171, ADR-0025).
 *
 * Regression guards for the in-process bus:
 *
 *   - subscribe(connection) registers a writer; broadcast(eventName)
 *     fans out an SSE frame to every registered writer.
 *   - unsubscribe(connection) removes a registered writer; calling it
 *     twice is a no-op (idempotent: a teardown firing twice, e.g. error
 *     then close, is a no-op on the second call).
 *   - A subscriber whose write throws does NOT affect dispatch to the
 *     other subscribers, and is removed by the bus on the failure
 *     (same posture as the notification publisher, AC-183).
 *
 * Pre-impl red state: the bus module does not exist yet. The dynamic
 * import surfaces MODULE_NOT_FOUND at the per-test level — same red-state
 * convention as `attachments-hidden-reaper.test.ts` L50-92.
 *
 * Module-API guess (the implementer will conform — see the report at
 * step-3 review):
 *
 *   import { createSseBus } from '../sse/bus.js';
 *   interface SseConnection {
 *     write(chunk: string): void;
 *     onClose(handler: () => void): void; // close-cleanup hook
 *   }
 *   interface SseBus {
 *     subscribe(c: SseConnection): void;
 *     unsubscribe(c: SseConnection): void;
 *     broadcast(eventName: string, payload?: unknown): void;
 *     size(): number;            // observable subscriber count for tests
 *   }
 *   function createSseBus(opts?: { logger?: SseBusLogger }): SseBus;
 *
 * The contract is exercised at the bus level only — route plumbing,
 * heartbeat, and AttachmentService emission live in the sibling test
 * files.
 */

import { describe, it, expect, beforeEach } from 'vitest';

interface SseConnection {
  write(chunk: string): void;
  onClose?(handler: () => void): void;
}

interface SseBus {
  subscribe(c: SseConnection): void;
  unsubscribe(c: SseConnection): void;
  broadcast(eventName: string, payload?: unknown): void;
  size?(): number;
}

interface SseBusLoggerCall {
  ctx: Record<string, unknown>;
  event: string;
}

interface SseBusLogger {
  error?: (ctx: Record<string, unknown>, event: string) => void;
}

interface CreateSseBusOpts {
  logger?: SseBusLogger;
}

async function loadCreateSseBus(): Promise<(opts?: CreateSseBusOpts) => SseBus> {
  // Dynamic import via a string variable so TS --noEmit does not block
  // the file. The bus module does not exist at step-3 time; the import
  // fails at runtime with MODULE_NOT_FOUND — the intended failure
  // surface (mirrors loadPublisher() in notification-publisher.test.ts).
  const path = '../sse/bus.js';
  const mod = (await import(/* @vite-ignore */ path)) as {
    createSseBus: (opts?: CreateSseBusOpts) => SseBus;
  };
  return mod.createSseBus;
}

/**
 * Minimal in-memory SseConnection. Captures every chunk written and
 * exposes a `simulateClose()` to fire any registered close handler so
 * tests can pin the close-cleanup contract without spinning a real
 * socket.
 */
function fakeConnection(): SseConnection & {
  chunks: string[];
  closeHandlers: Array<() => void>;
  simulateClose: () => void;
} {
  const chunks: string[] = [];
  const closeHandlers: Array<() => void> = [];
  return {
    chunks,
    closeHandlers,
    write(chunk: string): void {
      chunks.push(chunk);
    },
    onClose(handler: () => void): void {
      closeHandlers.push(handler);
    },
    simulateClose(): void {
      for (const h of closeHandlers) h();
    },
  };
}

describe('SSE bus — subscribe / broadcast / unsubscribe', () => {
  let createSseBus: (opts?: CreateSseBusOpts) => SseBus;

  beforeEach(async () => {
    createSseBus = await loadCreateSseBus();
  });

  // The bus delivers an event to every subscribed connection.
  it('broadcast writes the event frame to every subscribed connection', () => {
    const bus = createSseBus();
    const a = fakeConnection();
    const b = fakeConnection();
    bus.subscribe(a);
    bus.subscribe(b);

    bus.broadcast('storage_usage_changed');

    // Pins the `event:` line only.
    expect(a.chunks.join('')).toMatch(/event: storage_usage_changed/);
    expect(b.chunks.join('')).toMatch(/event: storage_usage_changed/);
  });

  it('each subscriber receives the broadcast exactly once', () => {
    const bus = createSseBus();
    const a = fakeConnection();
    bus.subscribe(a);

    bus.broadcast('storage_usage_changed');

    const matches = a.chunks.join('').match(/event: storage_usage_changed/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  // Lifecycle: unsubscribe stops further dispatch.
  it('unsubscribe stops a subscriber from receiving subsequent broadcasts', () => {
    const bus = createSseBus();
    const a = fakeConnection();
    const b = fakeConnection();
    bus.subscribe(a);
    bus.subscribe(b);
    bus.unsubscribe(a);

    bus.broadcast('storage_usage_changed');

    expect(a.chunks.join('')).not.toMatch(/event: storage_usage_changed/);
    expect(b.chunks.join('')).toMatch(/event: storage_usage_changed/);
  });

  // Unsubscribe is idempotent: a teardown firing twice (e.g. error
  // followed by close) is a no-op on the second call.
  it('unsubscribe is idempotent — a second call is a no-op', () => {
    const bus = createSseBus();
    const a = fakeConnection();
    const b = fakeConnection();
    bus.subscribe(a);
    bus.subscribe(b);
    bus.unsubscribe(a);

    expect(() => bus.unsubscribe(a)).not.toThrow();

    // Sanity: the surviving subscriber still sees broadcasts.
    bus.broadcast('storage_usage_changed');
    expect(b.chunks.join('')).toMatch(/event: storage_usage_changed/);
    expect(a.chunks.join('')).not.toMatch(/event: storage_usage_changed/);
  });

  it('unsubscribe of a never-subscribed connection is a no-op', () => {
    const bus = createSseBus();
    const ghost = fakeConnection();
    expect(() => bus.unsubscribe(ghost)).not.toThrow();
  });

  // Failure isolation: one failing subscriber does not
  // break dispatch to the others. Pinned at the bus level here; the
  // route-level + service-level wiring live in the sibling files.
  it('a throwing subscriber does not block dispatch to the others', () => {
    const bus = createSseBus();
    const before = fakeConnection();
    const failing: SseConnection = {
      write(): void {
        throw new Error('subscriber-write-failed');
      },
    };
    const after = fakeConnection();
    bus.subscribe(before);
    bus.subscribe(failing);
    bus.subscribe(after);

    expect(() => bus.broadcast('storage_usage_changed')).not.toThrow();

    expect(before.chunks.join('')).toMatch(/event: storage_usage_changed/);
    expect(after.chunks.join('')).toMatch(/event: storage_usage_changed/);
  });

  // The bus catches per-subscriber failures, logs structured
  // operational output, and removes the failing subscriber. The next
  // broadcast must NOT re-attempt the failing writer — otherwise the
  // same fault would be logged on every event.
  it('a writer that threw is removed from the subscriber set', () => {
    const bus = createSseBus();
    let writeAttempts = 0;
    const failing: SseConnection = {
      write(): void {
        writeAttempts += 1;
        throw new Error('subscriber-write-failed');
      },
    };
    bus.subscribe(failing);

    bus.broadcast('storage_usage_changed');
    bus.broadcast('storage_usage_changed');

    expect(writeAttempts).toBe(1);
  });

  it('bus logs the per-subscriber failure on the error channel', () => {
    const errorCalls: SseBusLoggerCall[] = [];
    const logger: SseBusLogger = {
      error: (ctx, event) => {
        errorCalls.push({ ctx, event });
      },
    };
    const bus = createSseBus({ logger });
    bus.subscribe({
      write(): void {
        throw new Error('subscriber-write-failed');
      },
    });

    bus.broadcast('storage_usage_changed');

    // Pin the presence of an error log line and that it carries the
    // surfaced error message somewhere in the context — the exact field
    // name (`error`, `error_hint`, ...) is a minor convention not
    // pinned, so we serialize the context and grep.
    expect(errorCalls.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(errorCalls[0])).toContain('subscriber-write-failed');
  });

  it('a throwing logger does not propagate out of broadcast()', () => {
    // Failure isolation: emission
    // failures cannot affect the originating mutation. A throwing
    // logger sink (circular ctx, fault inside the configured pino
    // transport) must be swallowed so a logger fault does not
    // surface as 5xx to a client whose write succeeded.
    const logger: SseBusLogger = {
      error: () => {
        throw new Error('logger-faulted');
      },
    };
    const bus = createSseBus({ logger });
    bus.subscribe({
      write(): void {
        throw new Error('subscriber-write-failed');
      },
    });

    expect(() => bus.broadcast('storage_usage_changed')).not.toThrow();
  });

  // Lifecycle: the handler registers a teardown that removes the
  // subscriber on connection close, error, or process shutdown.
  // The bus contract surface is `unsubscribe(connection)`; how the
  // route handler observes "close" and calls it is the route's job —
  // but the bus must accept the cleanup call without surprise.
  it('closing a subscribed connection removes it on the next broadcast', () => {
    const bus = createSseBus();
    const a = fakeConnection();
    bus.subscribe(a);

    a.simulateClose();
    bus.unsubscribe(a);

    bus.broadcast('storage_usage_changed');

    expect(a.chunks.join('')).not.toMatch(/event: storage_usage_changed/);
  });

  it('broadcast on an empty bus is a no-op (no throw)', () => {
    const bus = createSseBus();
    expect(() => bus.broadcast('storage_usage_changed')).not.toThrow();
  });

  it('each broadcast frame ends with the SSE record terminator (blank line)', () => {
    // Per WHATWG SSE: a frame is terminated by a blank line. A missing
    // terminator means the browser never dispatches the event to the
    // EventSource consumer — the most common SSE-server bug.
    const bus = createSseBus();
    const a = fakeConnection();
    bus.subscribe(a);
    bus.broadcast('storage_usage_changed');

    const joined = a.chunks.join('');
    expect(joined).toMatch(/event: storage_usage_changed[\s\S]*\n\n$/);
  });
});
