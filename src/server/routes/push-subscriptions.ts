/**
 * Push subscription routes — api.md §14.2.10, ADR-0023.
 *
 * Authenticated self-scope. `userId` is derived from the session (AC-196).
 *
 * Three operations:
 *   POST   /api/push-subscriptions            — subscribe (upsert)
 *   DELETE /api/push-subscriptions            — unsubscribe by endpoint
 *                                               (?endpoint= query param)
 *   DELETE /api/push-subscriptions/:id        — unsubscribe by id
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/connection.js';
import { requireSession } from '../middleware/auth.js';
import { getRateLimit } from '../config/index.js';
import { PushSubscriptionService } from '../services/PushSubscriptionService.js';

export function pushSubscriptionRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const service = new PushSubscriptionService(db);

    requireSession(app, db);

    app.post(
      '/api/push-subscriptions',
      {
        schema: {
          body: {
            type: 'object',
            required: ['endpoint', 'keys'],
            additionalProperties: false,
            properties: {
              endpoint: { type: 'string', minLength: 1, maxLength: 2048, format: 'uri' },
              keys: {
                type: 'object',
                required: ['p256dh', 'auth'],
                properties: {
                  p256dh: { type: 'string', minLength: 1, maxLength: 512 },
                  auth: { type: 'string', minLength: 1, maxLength: 512 },
                },
              },
              userAgent: { type: ['string', 'null'] },
            },
          },
        },
        config: {
          rateLimit: getRateLimit().subscriptionMutate,
        },
      },
      async (request, reply) => {
        const body = request.body as {
          endpoint: string;
          keys: { p256dh: string; auth: string };
          userAgent?: string | null;
        };
        const result = await service.subscribe(request.user!.id, {
          endpoint: body.endpoint,
          keys: body.keys,
          userAgent: body.userAgent ?? null,
        });
        return reply.code(201).send(result);
      },
    );

    // DELETE by endpoint (query string). The endpoint is the natural
    // key the client holds; keeping it a query param avoids stuffing
    // the full URL into a path segment.
    app.delete(
      '/api/push-subscriptions',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              endpoint: { type: 'string' },
            },
          },
        },
        config: {
          rateLimit: getRateLimit().subscriptionMutate,
        },
      },
      async (request, reply) => {
        const { endpoint } = request.query as { endpoint?: string };
        if (endpoint) {
          await service.unsubscribeByEndpoint(request.user!.id, endpoint);
        }
        // Empty query → idempotent no-op. The request is well-formed;
        // nothing to remove.
        return reply.code(204).send();
      },
    );

    app.delete(
      '/api/push-subscriptions/:id',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        config: {
          rateLimit: getRateLimit().subscriptionMutate,
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        await service.unsubscribeById(request.user!.id, id);
        return reply.code(204).send();
      },
    );
  };
}
