/**
 * Workers route — minimal assignee-pool projection for the project
 * management page's assignee filter (ui/management.md, Mitarbeiter
 * filter).
 *
 * Distinct from `/api/users` because:
 *   - The eligible-pool query is gated by `project:read` (every role
 *     that lists projects can use the filter) rather than `user:read`
 *     (admin-only). Workers and bookkeepers have project:read but not
 *     user:read.
 *   - The shape is the minimal `{userId, displayName}` pair used by the
 *     filter and by the `Project.assignedWorkers` chips — no email,
 *     roles array, or other admin-only fields leak through.
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/connection.js';
import { requirePermission, requireSession } from '../middleware/auth.js';
import { UserService } from '../services/UserService.js';

export function workerRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const userService = new UserService(db);
    requireSession(app, db);

    // GET /api/workers — assignable-worker pool for the filter dropdown.
    app.get(
      '/api/workers',
      { preHandler: requirePermission('project:read') },
      async (_req, reply) => {
        const data = await userService.listAssignableWorkers();
        return reply.code(200).send({ data });
      },
    );
  };
}
