/**
 * Realtime invalidation channel — `GET /api/events` (ADR-0025,
 * api.md §14.2.13, AC-268, AC-269, AC-275).
 *
 * Single multiplexed Server-Sent Events response. The handler accepts
 * an authenticated session, opens an indefinite `text/event-stream`,
 * subscribes the connection to the in-process bus
 * (`src/server/sse/bus.ts`), arms a heartbeat timer, and tears down on
 * connection close. Authorization is at the consumer endpoints the
 * client refetches, not at the event — so the route applies the same
 * `authenticate` preHandler as every other gated `/api/*` plugin and
 * does not narrow further by role.
 *
 * Method gate: `POST` / `PUT` / `PATCH` / `DELETE` return 405 with
 * `Allow: GET`, mirroring `storage-usage.ts`. Without an explicit
 * handler Fastify would answer 404 on these verbs, which the spec
 * (verification.md §15.28) does not allow.
 *
 * The 25-second heartbeat is configurable via `SSE_HEARTBEAT_INTERVAL_MS`
 * — see `src/server/config/env.ts`. Each connection runs its own
 * `setInterval` (architecture.md §11.13: "Independent per connection;
 * not coordinated across the subscriber set") and `unref()`s the timer
 * so a held connection cannot block process shutdown.
 *
 * Session re-validation (AC-275, CWE-613). The `authenticate` preHandler
 * runs once at connect time. Without re-validation a session that
 * naturally expires, gets revoked by logout, gets reaped, or whose user
 * is deactivated mid-stream would keep receiving frames until the client
 * disconnects on its own. Each heartbeat tick re-runs
 * `AuthService.isSessionValid(token)` against the cookie token; a
 * missing, expired, or inactive-user session ends the response.
 * Detection bound: one heartbeat interval post-revocation. DB cost: one
 * query per connection per heartbeat — independent of broadcast rate.
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/connection.js';
import { requireSession } from '../middleware/auth.js';
import { methodNotAllowed } from '../errors.js';
import { subscribe, unsubscribe, type SseConnection } from '../sse/bus.js';
import { AuthService } from '../services/AuthService.js';
import { getEnv } from '../config/env.js';

const HEARTBEAT_FRAME = ': keepalive\n\n';

export function eventsRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const authService = new AuthService(db);
    const heartbeatIntervalMs = getEnv().SSE_HEARTBEAT_INTERVAL_MS;

    requireSession(app, db);

    app.get('/api/events', async (request, reply) => {
      // Stream headers — explicitly NOT setting Cache-Control. The
      // protocol is non-cacheable per WHATWG SSE; Fastify's default
      // cache-control behaviour is silent on this route because we
      // bypass `reply.send()`.
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.flushHeaders();
      // Hand the response off to the route — Fastify must not try to
      // close it on its own when the async handler returns.
      reply.hijack();

      // Token is guaranteed present — `authenticate` rejects a missing
      // cookie before the handler runs. Captured here so the heartbeat
      // re-validation does not depend on `request` state surviving.
      const sessionToken = request.cookies.session!;

      const conn: SseConnection = {
        write(chunk: string): void {
          reply.raw.write(chunk);
        },
      };

      // The heartbeat callback inlines its own teardown (clearInterval
      // on the self-reference + unsubscribe + reply.raw.end()) so the
      // setInterval handle can be `const`. The connection-close
      // listener at the bottom uses the same handle for the
      // tab-closed / network-drop path.
      //
      // `tickInFlight` mirrors `periodicSweeper.ts`'s `currentSweep`
      // guard — if the previous `isSessionValid` await hasn't resolved
      // by the time the next interval fires, skip the tick rather than
      // stacking unbounded concurrent DB queries on a stalled backend.
      let tickInFlight = false;
      const heartbeat = setInterval(() => {
        if (tickInFlight) return;
        tickInFlight = true;
        void (async () => {
          try {
            let valid: boolean;
            try {
              valid = await authService.isSessionValid(sessionToken);
            } catch {
              // Transient DB error — skip this tick and try again on
              // the next. Disconnecting on a momentary blip would
              // punish every active subscriber for a backend hiccup.
              return;
            }
            if (!valid) {
              clearInterval(heartbeat);
              unsubscribe(conn);
              reply.raw.end();
              return;
            }
            try {
              reply.raw.write(HEARTBEAT_FRAME);
            } catch {
              /* socket gone — close handler tears down */
            }
          } finally {
            tickInFlight = false;
          }
        })();
      }, heartbeatIntervalMs);
      heartbeat.unref();

      const teardown = (): void => {
        clearInterval(heartbeat);
        unsubscribe(conn);
      };
      // `close` fires on tab close, navigation, network drop. `error`
      // covers transport faults that don't trigger a clean close. Both
      // listeners point at the same idempotent `teardown` —
      // `clearInterval` and `Set.delete` accept double-invocation.
      // Listeners are attached BEFORE `subscribe(conn)` so a connection
      // that aborts in the synchronous gap between the two cannot leave
      // a subscriber in the bus until the next broadcast retries it.
      request.raw.on('close', teardown);
      request.raw.on('error', teardown);
      subscribe(conn);
    });

    app.route({
      method: ['POST', 'PUT', 'PATCH', 'DELETE'],
      url: '/api/events',
      handler: async (_request, reply) => {
        reply.header('allow', 'GET');
        return reply.code(405).send(methodNotAllowed().toResponse());
      },
    });
  };
}
