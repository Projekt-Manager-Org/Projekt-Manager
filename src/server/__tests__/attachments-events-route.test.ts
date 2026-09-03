/**
 * API integration tests — `/api/events` SSE route (issue #171, ADR-0025).
 *
 * Pins AC-268 + AC-269 from verification.md §15.28:
 *
 *   - AC-268: authenticated GET returns 200 with `Content-Type:
 *     text/event-stream`, no `Cache-Control` directive, an open response
 *     stream that does not close on its own. Unauthenticated GET returns
 *     401 UNAUTHENTICATED / SESSION_EXPIRED with no stream. Non-GET
 *     verbs return 405 METHOD_NOT_ALLOWED with `Allow: GET`. A subscribed
 *     connection observes synthetic broadcasts as `event: <name>` frames.
 *
 *   - AC-269: a connection held idle observes a `:` keepalive comment
 *     line within the configured heartbeat window. The interval is
 *     fixed at 25 s in the spec (api.md §14.2.13, ADR-0025); the
 *     implementer is asked to make it injectable so this test can run
 *     against a 100 ms cadence rather than waiting >25 s of wall-clock
 *     time. Surface guess: `SSE_HEARTBEAT_INTERVAL_MS` env override
 *     consumed by `buildApp`'s SSE wiring (parallel to
 *     `PUSH_DISPATCH_LATENCY_BUDGET_MS` in `notification-publisher.test.ts`).
 *     If the implementer chooses a different mechanism (constructor arg,
 *     dedicated module export, …), the implementer rewrites the
 *     heartbeat-arm fixture; the assertion stays the same.
 *
 * Pre-impl red state: the route does not exist, so Fastify's default
 * 404 handler answers `GET /api/events` for the auth + content-type +
 * broadcast arms. The 405 arm fails because POST/PUT/PATCH/DELETE are
 * also unrouted (404, not 405). The heartbeat arm fails because no
 * keepalive line is ever written. All four paths surface as per-test
 * red, matching the project's TDD convention.
 *
 * Streaming response handling under `inject()`: Fastify's `inject()` is
 * built on `light-my-request`, which exposes `payloadAsStream: true` to
 * surface the response body as a Node `Readable` rather than a buffered
 * string. Without this, the test would deadlock waiting for the held
 * connection to close — which by the AC-268 contract it never does.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Readable } from 'node:stream';

import {
  startApp,
  stopApp,
  login,
  getApp,
  revokeSession,
  expireSession,
  deactivateUser,
  createTestUserSession,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { STRINGS } from '../../config/strings.js';

/**
 * Inject a streaming response and return both the `light-my-request`
 * meta (statusCode, headers) and the underlying Node Readable. The
 * caller is responsible for `stream.destroy()` to release the held
 * response — every test that opens a stream MUST destroy it in a
 * try/finally, otherwise vitest hangs at suite teardown.
 *
 * `light-my-request`'s `payloadAsStream: true` wraps the in-process
 * response writer in a Readable. The route handler is still the real
 * Fastify route — no mocking; no real socket either.
 */
async function injectStream(
  app: FastifyInstance,
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  cookie?: string,
): Promise<{ statusCode: number; headers: Record<string, unknown>; stream: Readable }> {
  const res = await app.inject({
    method,
    url,
    headers: cookie ? { cookie } : undefined,
    payloadAsStream: true,
  });
  return {
    statusCode: res.statusCode,
    headers: res.headers as Record<string, unknown>,
    stream: res.stream(),
  };
}

/**
 * Read up to `maxBytes` from a stream, or until a deadline elapses.
 * Resolves with whatever has accumulated by then. Used to sample a
 * non-terminating SSE response without waiting for it to close.
 */
function readWithDeadline(stream: Readable, ms: number, maxBytes = 4096): Promise<string> {
  return new Promise((resolve) => {
    let acc = '';
    const finish = (): void => {
      stream.removeListener('data', onData);
      resolve(acc);
    };
    const onData = (chunk: Buffer | string): void => {
      acc += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      if (acc.length >= maxBytes) finish();
    };
    stream.on('data', onData);
    setTimeout(finish, ms);
  });
}

/**
 * Drain & destroy a held SSE stream. inject()'s in-process writer keeps
 * the Fastify reply open until the consumer signals "done"; without
 * destroy() the suite hangs at afterAll.
 */
function closeStream(stream: Readable): void {
  stream.destroy();
}

/**
 * Module-level bus accessors — the route subscribes against the
 * singleton bus, so tests assert subscriber count there. Loaded
 * dynamically through the same path the AC-268 broadcast arm uses.
 */
async function loadBus(): Promise<{ size: () => number }> {
  const path = '../sse/bus.js';
  const mod = (await import(/* @vite-ignore */ path)) as { size: () => number };
  return mod;
}

/**
 * Wait until a predicate becomes true, polled at 25 ms. Resolves on
 * the first truthy poll, or after `ms` if the predicate never holds.
 * Used by AC-275 to wait for the heartbeat-driven unsubscribe — the
 * inject() consumer stream does not observe `reply.raw.end()` as a
 * `end` / `close` event in light-my-request, so the test asserts the
 * server-side outcome (subscriber removed from the bus) instead.
 */
async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise<void>((r) => setTimeout(r, 25));
  }
  return predicate();
}

/**
 * Expected bus-module surface for the broadcast arm. The route registers
 * subscribers on the same module the AttachmentService emits into; tests
 * call `broadcast` directly to assert the route's wiring without
 * depending on a real mutation that may or may not yet emit (the
 * emission wiring itself is pinned in
 * `attachments-storage-usage-events.test.ts`).
 *
 * The exact module path is the implementer's choice — `../sse/bus.js`
 * matches the `attachments-sse-bus.test.ts` guess.
 */
async function loadBroadcast(): Promise<(eventName: string, payload?: unknown) => void> {
  // Dynamic import via a string variable so TS --noEmit does not block
  // the file. The bus module does not exist at step-3 time; the import
  // fails at runtime with MODULE_NOT_FOUND.
  const path = '../sse/bus.js';
  const mod = (await import(/* @vite-ignore */ path)) as {
    broadcast: (eventName: string, payload?: unknown) => void;
  };
  return mod.broadcast;
}

describe('GET /api/events — SSE route (AC-268, AC-269)', () => {
  let app: FastifyInstance;
  let ownerToken: string;

  beforeAll(async () => {
    // The implementer is asked to honor SSE_HEARTBEAT_INTERVAL_MS so
    // the heartbeat assertion runs in seconds rather than >25 s of
    // wall-clock. Set it BEFORE buildApp() reads env. The 1000 ms
    // floor matches the schema's documented lower bound (1 s minimum;
    // see env.ts and architecture.md §12.2).
    process.env.SSE_HEARTBEAT_INTERVAL_MS = '1000';
    await startApp();
    app = getApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    await stopApp();
    delete process.env.SSE_HEARTBEAT_INTERVAL_MS;
  });

  // -------------------------------------------------------------------
  // AC-268 — authentication gate.
  // -------------------------------------------------------------------
  describe('AC-268: authentication gate', () => {
    it('returns 401 UNAUTHENTICATED with no stream when the session cookie is missing', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/events' });
      expect(res.statusCode).toBe(401);
      const body = res.json() as { code?: string };
      // The session middleware uses UNAUTHENTICATED for missing-session
      // and SESSION_EXPIRED for an expired session row — both are valid
      // 401 codes per api.md §14.2.13. We accept either at the
      // missing-cookie boundary (no session row exists at all).
      expect(['UNAUTHENTICATED', 'SESSION_EXPIRED']).toContain(body.code);
      // The body MUST NOT carry a `text/event-stream` content-type —
      // the rejection happens BEFORE the stream begins (api.md §14.2.13
      // "rejected with 401 UNAUTHENTICATED / SESSION_EXPIRED for
      // unauthenticated callers ... no stream begins").
      expect(String(res.headers['content-type'] ?? '')).not.toContain('text/event-stream');
    });
  });

  // -------------------------------------------------------------------
  // AC-268 — content-type + cache directive on the authenticated branch.
  // -------------------------------------------------------------------
  describe('AC-268: response-stream shape on the authenticated branch', () => {
    it('returns 200 with Content-Type: text/event-stream and no Cache-Control directive', async () => {
      const { statusCode, headers, stream } = await injectStream(
        app,
        '/api/events',
        'GET',
        `session=${ownerToken}`,
      );
      try {
        expect(statusCode).toBe(200);
        expect(String(headers['content-type'] ?? '')).toContain('text/event-stream');
        // api.md §14.2.13: "No Cache-Control directive — text/event-stream
        // is non-cacheable per the WHATWG SSE protocol." A regression
        // that mounted the global static-cache hook on /api/events would
        // surface as a `Cache-Control` header on the response.
        expect(headers['cache-control']).toBeUndefined();
      } finally {
        closeStream(stream);
      }
    });

    it('the response stream stays open (does not terminate on its own)', async () => {
      // AC-268: "an open response stream that does not close on its own".
      // We sample for 200 ms and assert the stream has not ended — a
      // route that returned a single string and closed (the Fastify
      // default for a sync handler) would fire `end` immediately.
      const { stream } = await injectStream(app, '/api/events', 'GET', `session=${ownerToken}`);
      try {
        let ended = false;
        stream.once('end', () => {
          ended = true;
        });
        await new Promise<void>((r) => setTimeout(r, 200));
        expect(ended).toBe(false);
      } finally {
        closeStream(stream);
      }
    });
  });

  // -------------------------------------------------------------------
  // AC-268 — method gate.
  // -------------------------------------------------------------------
  describe('AC-268: method gate', () => {
    it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
      'returns 405 METHOD_NOT_ALLOWED with Allow: GET on %s /api/events',
      async (method) => {
        const res = await app.inject({
          method,
          url: '/api/events',
          headers: { cookie: `session=${ownerToken}` },
        });
        expect(res.statusCode).toBe(405);
        // `Allow` header is part of the 405 contract — the storage-usage
        // route mounts it the same way (storage-usage.ts L60-70).
        expect(String(res.headers['allow'] ?? '').toUpperCase()).toContain('GET');
        const body = res.json() as { code?: string; message?: string };
        expect(body.code).toBe('METHOD_NOT_ALLOWED');
        // Pins the guard to the shared factory (AC-354). The literal it
        // replaced carried an English message; asserting the code alone
        // would not notice a regression back to a hand-rolled body.
        expect(body.message).toBe(STRINGS.errors.methodNotAllowed);
      },
    );
  });

  // -------------------------------------------------------------------
  // AC-268 — broadcast reaches a subscribed connection.
  // -------------------------------------------------------------------
  describe('AC-268: broadcast delivery', () => {
    it('a synthetic broadcast lands as an `event: storage_usage_changed` frame on the held stream', async () => {
      const broadcast = await loadBroadcast();
      const { stream } = await injectStream(app, '/api/events', 'GET', `session=${ownerToken}`);
      try {
        // Start reading BEFORE broadcasting. A handler that writes the
        // headers async (fastify: defer to next tick) needs the request
        // to be fully accepted before broadcast() will reach this
        // subscriber. 50 ms is generous but cheap.
        const readPromise = readWithDeadline(stream, 250);
        await new Promise<void>((r) => setTimeout(r, 50));
        broadcast('storage_usage_changed');
        const body = await readPromise;

        // api.md §14.2.13 "Payload shape" leaves the data: line shape
        // open: empty `data:`, `data: {}`, or
        // `data: {"type":"storage_usage_changed"}` are all conformant.
        // We pin the event line and let the implementer choose the
        // payload shape. A regression that omits the `event:` line
        // would land as an unnamed frame and break the EventSource
        // dispatch on the consumer.
        expect(body).toMatch(/event: storage_usage_changed/);
        // SSE record terminator — a frame must end with a blank line
        // for the browser to dispatch it. We assert presence of
        // `\n\n` somewhere after the event line.
        expect(body).toMatch(/event: storage_usage_changed[\s\S]*\n\n/);
      } finally {
        closeStream(stream);
      }
    });
  });

  // -------------------------------------------------------------------
  // AC-269 — heartbeat.
  // -------------------------------------------------------------------
  describe('AC-269: heartbeat keepalive', () => {
    it('an idle connection observes a `:` SSE comment line within the configured heartbeat window', async () => {
      // Per api.md §14.2.13: 25 s default. The schema bounds the
      // configurable interval at 1 s minimum (env.ts), so the test
      // cadence is 1 s and the read deadline budget is 1.5 s — a
      // single heartbeat with margin.
      const { stream } = await injectStream(app, '/api/events', 'GET', `session=${ownerToken}`);
      try {
        const body = await readWithDeadline(stream, 1500);
        // `:` comment line per WHATWG SSE — the line begins with a
        // colon and is terminated by `\n`. We do NOT pin the comment
        // body (`: keepalive`, `: ping`, empty are all conformant).
        // A heartbeat that never fires shows up as an empty / event-
        // only body here.
        expect(body).toMatch(/(^|\n):[^\n]*\n/);
      } finally {
        closeStream(stream);
      }
    });
  });

  // -------------------------------------------------------------------
  // AC-275 — session re-validation on held streams (CWE-613, issue #173).
  //
  // The auth preHandler runs once at connect time. Without re-validation
  // a session that gets deleted (logout / reaper / `deleteSessionsByUserId`),
  // expires naturally, or whose user is deactivated mid-stream would
  // keep receiving frames until the client disconnects. The route
  // re-runs `findSession()` at every heartbeat tick and ends the
  // response when the session is no longer valid; the test cadence is
  // 1 s (matching AC-269), so the bound is "stream ends within ~1.5 s
  // of the invalidating mutation".
  //
  // Three arms cover the three independent invalidation modes — the
  // single re-check covers all three, but the test asserts each path
  // surfaces correctly so a future fix that only handles one mode (e.g.
  // hooking the logout call site but not the user-deactivation cascade)
  // would surface here.
  //
  // Each arm logs in / mints a fresh session so the arms cannot
  // interfere with each other or with the AC-268/269 arms above.
  // -------------------------------------------------------------------
  describe('AC-275: session re-validation on held streams', () => {
    it('removes the subscriber within one heartbeat after the session row is deleted', async () => {
      // Models logout, the periodic session reaper, and
      // `UserService.deactivateUser`'s `deleteSessionsByUserId` cascade.
      const bus = await loadBus();
      const baseline = bus.size();
      const token = await login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD);
      const { stream } = await injectStream(app, '/api/events', 'GET', `session=${token}`);
      try {
        // Let the connection register before mutating; otherwise the
        // deletion races with `subscribe()` and the test asserts the
        // wrong window. A 100 ms wait is generous given the 1 s
        // heartbeat cadence.
        await new Promise<void>((r) => setTimeout(r, 100));
        expect(bus.size()).toBe(baseline + 1);
        await revokeSession(token);
        // Heartbeat cadence is 1 s; budget the wait at 2.5 s for one
        // tick + the async findSession round-trip + scheduling slack.
        const removed = await waitFor(() => bus.size() === baseline, 2500);
        expect(removed).toBe(true);
      } finally {
        closeStream(stream);
      }
    });

    it('removes the subscriber within one heartbeat after the session row expires', async () => {
      // Models natural expiry (`session.expiresAt < now`). The reaper
      // would eventually delete the row, but the auth gate triggers the
      // moment `isSessionExpired()` returns true, which is what the
      // re-validation checks.
      const bus = await loadBus();
      const baseline = bus.size();
      const token = await login(SEED_USERS.worker2.username, SEED_DEFAULT_PASSWORD);
      const { stream } = await injectStream(app, '/api/events', 'GET', `session=${token}`);
      try {
        await new Promise<void>((r) => setTimeout(r, 100));
        expect(bus.size()).toBe(baseline + 1);
        await expireSession(token);
        const removed = await waitFor(() => bus.size() === baseline, 2500);
        expect(removed).toBe(true);
      } finally {
        closeStream(stream);
      }
    });

    it('removes the subscriber within one heartbeat after the user is deactivated', async () => {
      // Models the admin-lockout path: `users.active = false` while
      // sessions still exist. The repo-level deactivate flips the flag
      // without touching the session table — the only signal the held
      // stream gets is the joined `user.active` column on `findSession()`.
      // A mint-on-the-fly user keeps this arm independent of seed-user
      // state across files.
      const bus = await loadBus();
      const baseline = bus.size();
      const { userId, token } = await createTestUserSession({ roles: ['worker'] });
      const { stream } = await injectStream(app, '/api/events', 'GET', `session=${token}`);
      try {
        await new Promise<void>((r) => setTimeout(r, 100));
        expect(bus.size()).toBe(baseline + 1);
        await deactivateUser(userId);
        const removed = await waitFor(() => bus.size() === baseline, 2500);
        expect(removed).toBe(true);
      } finally {
        closeStream(stream);
      }
    });
  });
});
