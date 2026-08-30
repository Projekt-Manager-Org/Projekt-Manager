/**
 * Public push-configuration routes — api.md §14.2.10, ADR-0023.
 *
 * This plugin is unauthenticated on purpose: the VAPID public key is
 * intentionally public (the private half never leaves the server). A
 * separate plugin keeps the authenticated `push-subscriptions.ts`
 * session gate (`requireSession`) from leaking onto this route —
 * Fastify's `preHandler` at the plugin level only applies to routes
 * registered inside the same plugin encapsulation.
 *
 * Operator-facing contract: set `VAPID_PRIVATE_KEY` in the deploy env
 * and the endpoint starts returning the derived public key; leave it
 * unset and the endpoint returns `{ vapidPublicKey: null }` so the
 * client renders the "not configured" branch.
 */

import type { FastifyInstance } from 'fastify';

/**
 * Register the public push routes. The public key is captured at
 * plugin registration time (resolved once at boot in `buildApp`) so
 * the endpoint is a pure read — no per-request env access, no
 * re-derivation cost.
 */
export function pushPublicRoutes(vapidPublicKey: string | null) {
  return async function (app: FastifyInstance): Promise<void> {
    // ---------------------------------------------------------------
    // GET /api/push/vapid-public-key
    //
    // Unauthenticated. Returns `{ vapidPublicKey: string | null }`.
    // `null` when `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` is not fully
    // configured (dispatch is a no-op in that case anyway).
    //
    // Cache: 5 minutes. The key rotates only via deploy; clients can
    // safely re-fetch on the next subscribe attempt. The response is
    // non-user-specific so `cache-control: public` is appropriate —
    // intermediary caches (if any) may reuse it across sessions.
    // ---------------------------------------------------------------
    app.get('/api/push/vapid-public-key', async (_request, reply) => {
      reply.header('cache-control', 'public, max-age=300');
      return reply.code(200).send({ vapidPublicKey });
    });

    // Non-GET verbs on the same path → explicit 405, not the default
    // 404. Web Push clients that accidentally POST to this path get a
    // meaningful response. Fastify's router does not auto-populate
    // `Allow` so we set it here.
    app.route({
      method: ['POST', 'PUT', 'PATCH', 'DELETE'],
      url: '/api/push/vapid-public-key',
      handler: async (_request, reply) => {
        reply.header('allow', 'GET');
        return reply
          .code(405)
          .send({ code: 'METHOD_NOT_ALLOWED', message: 'Only GET is allowed on this endpoint.' });
      },
    });
  };
}
