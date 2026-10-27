/**
 * Storage usage read route (totals: data-model.md §5.14; permissions: api.md §14.3).
 *
 *   - GET  /api/storage-usage — deployment-wide roll-up. Gated by the
 *     same `data:export` scope as the unified Export operation
 *     (api.md §14.2.4), so worker / bookkeeper see 403; owner / office
 *     see 200.
 *
 * A pure read; no `audit_log` row, no `Cache-Control`
 * header (the maintained-aggregate pattern keeps reads constant-time
 * already, and a stale cache serves no purpose).
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/connection.js';
import { requirePermission, requireSession } from '../middleware/auth.js';
import { StorageUsageService } from '../services/StorageUsageService.js';

export function storageUsageRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const service = new StorageUsageService(db);

    requireSession(app, db);

    // ---------------------------------------------------------------
    // GET /api/storage-usage — data:export gate (api.md §14.3)
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
  };
}
