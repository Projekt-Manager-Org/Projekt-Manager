/**
 * Audit routes — read-only (api.md §14.2.8).
 *
 * The audit surface has only two operations:
 *   - GET /api/audit        → list with filters, offset/limit, deterministic order.
 *   - GET /api/audit/:id    → get-by-id with the three-way result
 *                             (200 / 403 NOT_PERMITTED / 404 NOT_FOUND).
 *
 * Routes are thin HTTP adapters: schema validation via Fastify's JSON
 * Schema, `authenticate + requirePermission('audit:read')` gates, and
 * delegation to `AuditService`. Per-role response shaping lives in the
 * service; repository-layer predicates enforce scope.
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/connection.js';
import { requirePermission, requireSession } from '../middleware/auth.js';
import {
  AuditService,
  AUDIT_ENTITY_TYPES,
  AUDIT_ACTIONS,
  type AuditEntityType,
} from '../services/AuditService.js';
import { notFound, notPermitted, validationError } from '../errors.js';
import { STRINGS } from '../../config/strings.js';

export function auditRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const auditService = new AuditService(db);

    requireSession(app, db);

    // ---------------------------------------------------------------
    // GET /api/audit — list with filters and pagination.
    // ---------------------------------------------------------------
    app.get(
      '/api/audit',
      {
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
              offset: { type: 'integer', minimum: 0 },
              // Upper bound sized for the activity-feed use case: the
              // integration tests in `audit-log.test.ts` fetch up to
              // 1000 entries in a single page to avoid flake from
              // pagination-boundary effects when many audit rows are
              // written during seed + fixture setup. Keeping the bound
              // at 1000 lets those tests exercise the scope predicates
              // end-to-end without touching pagination.
              limit: { type: 'integer', minimum: 1, maximum: 1000 },
              entityType: { type: 'string', enum: [...AUDIT_ENTITY_TYPES] },
              entityId: { type: 'string', format: 'uuid' },
              // Ancestor-scoped filter (architecture.md §11.12) — powers
              // the project-detail activity feed by pulling every row
              // scoped to a project in one indexed predicate.
              ancestorType: { type: 'string', enum: [...AUDIT_ENTITY_TYPES] },
              ancestorId: { type: 'string', format: 'uuid' },
              // Substring search on entity_label (see repo). Min 3 chars
              // keeps queries trigram-eligible — shorter patterns would
              // fall back to a seq scan. Max 255 mirrors the longest
              // labeled source (customers.name varchar(255)).
              entityLabelQuery: { type: 'string', minLength: 3, maxLength: 255 },
              actorId: { type: 'string', format: 'uuid' },
              from: { type: 'string', format: 'date-time' },
              to: { type: 'string', format: 'date-time' },
              action: { type: 'string', enum: [...AUDIT_ACTIONS] },
              // verification.md AC-200 — "Alles anzeigen" toggle. Absent
              // or 'false' = full RBAC-scoped feed (AC-180); 'true' =
              // only rows whose resolved dispatch recipient set would
              // include the caller. A value outside the enum fails
              // schema validation → 422 VALIDATION_ERROR, matching the
              // route's other coercion failures.
              recipientScope: { type: 'string', enum: ['true', 'false'] },
            },
          },
        },
        preHandler: requirePermission('audit:read'),
      },
      async (request, reply) => {
        const query = request.query as {
          offset?: number;
          limit?: number;
          entityType?: AuditEntityType;
          entityId?: string;
          ancestorType?: AuditEntityType;
          ancestorId?: string;
          entityLabelQuery?: string;
          actorId?: string;
          from?: string;
          to?: string;
          action?: string;
          recipientScope?: 'true' | 'false';
        };

        const from = query.from !== undefined ? new Date(query.from) : undefined;
        const to = query.to !== undefined ? new Date(query.to) : undefined;
        if (from !== undefined && to !== undefined && from.getTime() > to.getTime()) {
          // Inverted date range is a validation failure per api.md §14.2.8
          // ("from/to inverted (to < from) → 422 VALIDATION_ERROR").
          throw validationError(STRINGS.errors.invalidInput);
        }

        const result = await auditService.list(request.user!, {
          offset: query.offset,
          limit: query.limit,
          entityType: query.entityType,
          entityId: query.entityId,
          ancestorType: query.ancestorType,
          ancestorId: query.ancestorId,
          entityLabelQuery: query.entityLabelQuery,
          actorId: query.actorId,
          from,
          to,
          action: query.action,
          recipientScope: query.recipientScope === 'true',
        });
        return reply.code(200).send(result);
      },
    );

    // ---------------------------------------------------------------
    // GET /api/audit/:id — three-way result (200 / 403 / 404).
    // ---------------------------------------------------------------
    app.get(
      '/api/audit/:id',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string', format: 'uuid' },
            },
          },
        },
        preHandler: requirePermission('audit:read'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const result = await auditService.get(request.user!, id);
        if (result.status === 'not-found') {
          throw notFound(STRINGS.entities.audit);
        }
        if (result.status === 'forbidden') {
          throw notPermitted();
        }
        return reply.code(200).send(result.entry);
      },
    );
  };
}
