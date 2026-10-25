/**
 * Notification rule routes — api.md §14.2.9, ADR-0023.
 *
 * Admin-only CRUD gated by `notifications:manage`. Validation lives in
 * `NotificationRuleService.validate()` so the route layer stays a thin
 * HTTP adapter.
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/connection.js';
import { requirePermission, requireSession } from '../middleware/auth.js';
import { NotificationRuleService } from '../services/NotificationRuleService.js';

/**
 * The rule body's shape, closed at every object level (AC-515). Value
 * checks stay in the service validator.
 */
const RULE_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    eventClass: {},
    stateFilter: {},
    recipientSpec: {
      type: 'object',
      additionalProperties: false,
      properties: { roles: {}, includeAssignedWorkers: {}, userIds: {} },
    },
    enabled: {},
  },
} as const;

export function notificationRuleRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const service = new NotificationRuleService(db);

    requireSession(app, db);

    app.get(
      '/api/notification-rules',
      { preHandler: requirePermission('notifications:manage') },
      async (_request, reply) => {
        const result = await service.list();
        return reply.code(200).send(result);
      },
    );

    app.get(
      '/api/notification-rules/:id',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: requirePermission('notifications:manage'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const rule = await service.get(id);
        return reply.code(200).send(rule);
      },
    );

    app.post(
      '/api/notification-rules',
      {
        schema: {
          // Structural gate: a non-object body or an undefined field
          // (AC-515) is refused before the service validator. Semantic
          // validation (eventClass, recipientSpec, etc.) lives in
          // NotificationRuleService.
          body: RULE_BODY_SCHEMA,
        },
        preHandler: requirePermission('notifications:manage'),
      },
      async (request, reply) => {
        const rule = await service.create(
          request.body as Record<string, unknown>,
          request.user!.id,
          request.id ?? null,
        );
        return reply.code(201).send(rule);
      },
    );

    app.patch(
      '/api/notification-rules/:id',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
          body: RULE_BODY_SCHEMA,
        },
        preHandler: requirePermission('notifications:manage'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const rule = await service.update(
          id,
          request.body as Record<string, unknown>,
          request.user!.id,
          request.id ?? null,
        );
        return reply.code(200).send(rule);
      },
    );

    app.delete(
      '/api/notification-rules/:id',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: requirePermission('notifications:manage'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        await service.remove(id, request.user!.id, request.id ?? null);
        return reply.code(204).send();
      },
    );
  };
}
