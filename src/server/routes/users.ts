/**
 * User management routes — CRUD, deactivation, reactivation, password reset.
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/connection.js';
import { createAuthMiddleware, requirePermission } from '../middleware/auth.js';
import { UserService } from '../services/UserService.js';
import { ROLE_KEYS } from '../../config/roleKeys.js';

export function userRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const authenticate = createAuthMiddleware(db);
    const userService = new UserService(db);

    app.addHook('preHandler', authenticate);

    // GET /api/users — list all users (including deactivated)
    app.get(
      '/api/users',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              offset: { type: 'integer', minimum: 0 },
              limit: { type: 'integer', minimum: 1, maximum: 200 },
            },
          },
        },
        preHandler: requirePermission('user:read'),
      },
      async (request, reply) => {
        const query = request.query as { offset?: number; limit?: number };
        const result = await userService.listUsers(query);
        return reply.code(200).send(result);
      },
    );

    // GET /api/users/:id — get single user
    app.get(
      '/api/users/:id',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: requirePermission('user:read'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const user = await userService.getUser(id);
        return reply.code(200).send(user);
      },
    );

    // POST /api/users — create user
    app.post(
      '/api/users',
      {
        schema: {
          body: {
            type: 'object',
            required: ['username', 'displayName', 'password', 'roles'],
            additionalProperties: false,
            properties: {
              username: { type: 'string', minLength: 1 },
              displayName: { type: 'string', minLength: 1 },
              password: { type: 'string', minLength: 1 },
              roles: {
                type: 'array',
                items: { type: 'string', enum: [...ROLE_KEYS] },
                minItems: 1,
              },
              email: { type: ['string', 'null'] },
            },
          },
        },
        preHandler: requirePermission('user:manage'),
      },
      async (request, reply) => {
        const body = request.body as {
          username: string;
          displayName: string;
          password: string;
          roles: string[];
          email?: string | null;
        };
        const user = await userService.createUser(
          body,
          request.user!.id,
          request.log,
          request.id ?? null,
        );
        return reply.code(201).send(user);
      },
    );

    // PATCH /api/users/:id — update user
    app.patch(
      '/api/users/:id',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
          body: {
            type: 'object',
            additionalProperties: false,
            minProperties: 1,
            properties: {
              displayName: { type: 'string', minLength: 1 },
              roles: {
                type: 'array',
                items: { type: 'string', enum: [...ROLE_KEYS] },
                minItems: 1,
              },
              email: { type: ['string', 'null'] },
            },
          },
        },
        preHandler: requirePermission('user:manage'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as {
          displayName?: string;
          roles?: string[];
          email?: string | null;
        };
        const user = await userService.updateUser(
          id,
          body,
          request.user!.id,
          request.log,
          request.id ?? null,
        );
        return reply.code(200).send(user);
      },
    );

    // DELETE /api/users/:id — hard-delete user (owner only)
    app.delete(
      '/api/users/:id',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: requirePermission('user:delete'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        await userService.deleteUser(id, request.user!.id, request.log, request.id ?? null);
        return reply.code(204).send();
      },
    );

    // POST /api/users/:id/deactivate
    app.post(
      '/api/users/:id/deactivate',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: requirePermission('user:manage'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const user = await userService.deactivateUser(
          id,
          request.user!.id,
          request.log,
          request.id ?? null,
        );
        return reply.code(200).send(user);
      },
    );

    // POST /api/users/:id/reactivate
    app.post(
      '/api/users/:id/reactivate',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: requirePermission('user:manage'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const user = await userService.reactivateUser(
          id,
          request.user!.id,
          request.log,
          request.id ?? null,
        );
        return reply.code(200).send(user);
      },
    );

    // POST /api/users/:id/reset-password
    app.post(
      '/api/users/:id/reset-password',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
          body: {
            type: 'object',
            required: ['newPassword'],
            additionalProperties: false,
            properties: {
              newPassword: { type: 'string', minLength: 1 },
            },
          },
        },
        preHandler: requirePermission('user:manage'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const { newPassword } = request.body as { newPassword: string };
        await userService.resetPassword(
          id,
          newPassword,
          request.user!.id,
          request.log,
          request.id ?? null,
        );
        return reply.code(200).send({ success: true });
      },
    );
  };
}
