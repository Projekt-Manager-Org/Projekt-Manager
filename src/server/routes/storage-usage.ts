/**
 * Storage usage read routes (api.md §14.2.12, AC-264 / AC-265).
 *
 *   - GET  /api/projects/:id/storage-usage — per-project read.
 *     Permission and reachability mirror Get project ([api.md §14.2.2]):
 *     a known, in-scope project returns 200 with the four-bucket
 *     payload; an existing project outside the caller's scope returns
 *     403 NOT_PERMITTED; an unknown project id returns 404 NOT_FOUND.
 *     The 403/404 distinguishability mirrors the attachment policy
 *     (AC-214) and the project policy (AC-147) — resource existence is
 *     not a secret at the role boundary under the project's threat
 *     model (ADR-0019).
 *   - GET  /api/storage-usage — deployment-wide roll-up. Gated by the
 *     same `data:export` scope as the unified Export operation
 *     (api.md §14.2.4), so worker / bookkeeper see 403; owner / office
 *     see 200.
 *
 * Both surfaces are pure reads; no `audit_log` row, no `Cache-Control`
 * header (the maintained-aggregate pattern keeps reads constant-time
 * already, and a stale cache serves no purpose). Non-GET verbs on
 * either path return 405 with `Allow: GET` — explicit method handling
 * because Fastify's default 404-for-unknown-method response would not
 * carry the documented status code.
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/connection.js';
import { requirePermission, requireSession } from '../middleware/auth.js';
import { methodNotAllowed } from '../errors.js';
import { StorageUsageService } from '../services/StorageUsageService.js';

export function storageUsageRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const service = new StorageUsageService(db);

    requireSession(app, db);

    // ---------------------------------------------------------------
    // GET /api/projects/:id/storage-usage — AC-264
    // ---------------------------------------------------------------
    app.get(
      '/api/projects/:id/storage-usage',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: requirePermission('project:read'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const usage = await service.getProjectUsage(request.user!, id);
        return reply.code(200).send(usage);
      },
    );

    app.route({
      method: ['POST', 'PUT', 'PATCH', 'DELETE'],
      url: '/api/projects/:id/storage-usage',
      handler: async (_request, reply) => {
        reply.header('allow', 'GET');
        return reply.code(405).send(methodNotAllowed().toResponse());
      },
    });

    // ---------------------------------------------------------------
    // GET /api/storage-usage — AC-265 (data:export gate)
    // ---------------------------------------------------------------
    app.get(
      '/api/storage-usage',
      {
        preHandler: requirePermission('data:export'),
      },
      async (_request, reply) => {
        const usage = await service.getGlobalUsage();
        return reply.code(200).send(usage);
      },
    );

    app.route({
      method: ['POST', 'PUT', 'PATCH', 'DELETE'],
      url: '/api/storage-usage',
      handler: async (_request, reply) => {
        reply.header('allow', 'GET');
        return reply.code(405).send(methodNotAllowed().toResponse());
      },
    });
  };
}
