/**
 * Project routes — CRUD and transitions for projects.
 * All routes require authentication.
 *
 * Routes are thin HTTP adapters: request parsing, response formatting,
 * Fastify-specific concerns. Business logic lives in the three project
 * services (see `src/server/services/project.ts`).
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/connection.js';
import { requirePermission, requireSession } from '../middleware/auth.js';
import {
  ProjectCrudService,
  ProjectTransitionService,
  ProjectDatesService,
  PROJECT_SORT_KEYS,
  type ProjectSortKey,
} from '../services/project.js';
import { STATE_KEYS, type WorkflowState } from '../../config/stateConfig.js';
import { createStorageClient } from '../storage/client.js';
import { getEnv } from '../config/env.js';

export function projectRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    // Storage client for the purge-cascade's storage-side cleanup
    // (AC-218). Optional — a deployment without storage configured
    // (e.g. test harness without STORAGE_* env) falls back to DB-only
    // cascade.
    const env = getEnv();
    const storage =
      env.STORAGE_ENDPOINT && env.STORAGE_ACCESS_KEY && env.STORAGE_SECRET_KEY
        ? createStorageClient({
            endpoint: env.STORAGE_ENDPOINT,
            bucket: env.STORAGE_BUCKET,
            accessKey: env.STORAGE_ACCESS_KEY,
            secretKey: env.STORAGE_SECRET_KEY,
            region: env.STORAGE_REGION,
          })
        : undefined;
    const crudService = new ProjectCrudService(db, { storage });
    const transitionService = new ProjectTransitionService(db);
    const datesService = new ProjectDatesService(db);

    requireSession(app, db);

    // ---------------------------------------------------------------
    // GET /api/projects — list with filters
    // ---------------------------------------------------------------
    app.get(
      '/api/projects',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              offset: { type: 'integer', minimum: 0 },
              limit: { type: 'integer', minimum: 0, maximum: 200 },
              status: {}, // Accept string or array — Fastify querystring parsing handles both
              search: { type: 'string' },
              hasNoDates: { type: 'string' },
              customerId: { type: 'string', format: 'uuid' },
              includeArchived: { type: 'string' },
              // Mitarbeiter filter (assignee). Modelled as an array of
              // UUIDs; Fastify's querystring Ajv runs `coerceTypes: 'array'`
              // so a single `?assignedWorkerIds=u1` is coerced to `[u1]`
              // and `?assignedWorkerIds=u1&assignedWorkerIds=u2` arrives
              // as `[u1, u2]`. `items.format: 'uuid'` enforces the shape
              // at the route boundary so malformed input returns 422
              // VALIDATION_ERROR up front rather than a SQLSTATE 22P02
              // → 500 from the DB driver.
              assignedWorkerIds: {
                type: 'array',
                items: { type: 'string', format: 'uuid' },
              },
              includeUnassigned: { type: 'string' },
              sortBy: { type: 'string', enum: [...PROJECT_SORT_KEYS] },
              sortDir: { type: 'string', enum: ['asc', 'desc'] },
            },
          },
        },
        preHandler: requirePermission('project:read'),
      },
      async (request, reply) => {
        const query = request.query as {
          offset?: number;
          limit?: number;
          status?: string | string[];
          search?: string;
          hasNoDates?: string;
          customerId?: string;
          includeArchived?: string;
          assignedWorkerIds?: string[];
          includeUnassigned?: string;
          sortBy?: ProjectSortKey;
          sortDir?: 'asc' | 'desc';
        };
        // Schema-coerced to `string[]` regardless of whether Fastify saw
        // one query param or several. Empty/undefined → omit so the repo
        // treats it as "no worker filter".
        const workerIds = query.assignedWorkerIds;
        const result = await crudService.listProjects(request.user!, {
          offset: query.offset,
          limit: query.limit,
          status: query.status,
          search: query.search,
          hasNoDates: query.hasNoDates === 'true',
          customerId: query.customerId,
          includeArchived: query.includeArchived === 'true',
          assignedWorkerIds: workerIds,
          includeUnassigned: query.includeUnassigned === 'true',
          sortBy: query.sortBy,
          sortDir: query.sortDir,
        });

        return reply.code(200).send({ data: result.data, total: result.total });
      },
    );

    // ---------------------------------------------------------------
    // POST /api/projects — create project
    // ---------------------------------------------------------------
    app.post(
      '/api/projects',
      {
        schema: {
          body: {
            type: 'object',
            required: ['number', 'title', 'customerId'],
            additionalProperties: false,
            properties: {
              id: { type: 'string', format: 'uuid' },
              number: { type: 'string', minLength: 1 },
              title: { type: 'string', minLength: 1 },
              customerId: { type: 'string', format: 'uuid' },
              status: { type: 'string' },
              // Baustellen-/Leistungsadresse — same JSON shape as customer.address.
              // Null means "site is at the customer's billing address" (data-model.md §5.1).
              // AC-284 backstop: partial triples (any empty-string component)
              // are rejected at this layer with 422 VALIDATION_ERROR. The
              // primary all-or-none rule lives in the UI; the API enforces
              // the same shape as defense-in-depth against a malformed client.
              siteAddress: {
                type: ['object', 'null'],
                additionalProperties: false,
                required: ['street', 'zip', 'city'],
                properties: {
                  street: { type: 'string', minLength: 1 },
                  zip: { type: 'string', minLength: 1 },
                  city: { type: 'string', minLength: 1 },
                },
              },
              plannedStart: { type: ['string', 'null'], format: 'date' },
              plannedEnd: { type: ['string', 'null'], format: 'date' },
              assignedWorkerIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
              estimatedValue: { type: ['number', 'null'] },
              notes: { type: ['string', 'null'] },
            },
          },
        },
        preHandler: requirePermission('project:create'),
      },
      async (request, reply) => {
        const body = request.body as {
          id?: string;
          number: string;
          title: string;
          customerId: string;
          status?: string;
          siteAddress?: { street: string; zip: string; city: string } | null;
          plannedStart?: string | null;
          plannedEnd?: string | null;
          assignedWorkerIds?: string[];
          estimatedValue?: number | null;
          notes?: string | null;
        };
        const project = await crudService.createProject(
          body,
          request.user!.id,
          request.log,
          request.id ?? null,
        );
        return reply.code(201).send(project);
      },
    );

    // ---------------------------------------------------------------
    // GET /api/projects/:id
    // ---------------------------------------------------------------
    app.get(
      '/api/projects/:id',
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
        preHandler: requirePermission('project:read'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const project = await crudService.getProject(request.user!, id);
        return reply.code(200).send(project);
      },
    );

    // ---------------------------------------------------------------
    // POST /api/projects/:id/transition/forward
    // ---------------------------------------------------------------
    app.post(
      '/api/projects/:id/transition/forward',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string', format: 'uuid' },
            },
          },
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['expectedStatus'],
            properties: {
              expectedStatus: { type: 'string', enum: STATE_KEYS },
            },
          },
        },
        preHandler: requirePermission('project:transition'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const { expectedStatus } = request.body as { expectedStatus: WorkflowState };
        const project = await transitionService.transitionForward(
          id,
          request.user!.id,
          expectedStatus,
          request.log,
          request.id ?? null,
        );
        return reply.code(200).send(project);
      },
    );

    // ---------------------------------------------------------------
    // POST /api/projects/:id/transition/backward
    // ---------------------------------------------------------------
    app.post(
      '/api/projects/:id/transition/backward',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string', format: 'uuid' },
            },
          },
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['expectedStatus'],
            properties: {
              expectedStatus: { type: 'string', enum: STATE_KEYS },
            },
          },
        },
        preHandler: requirePermission('project:transition'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const { expectedStatus } = request.body as { expectedStatus: WorkflowState };
        const project = await transitionService.transitionBackward(
          id,
          request.user!.id,
          expectedStatus,
          request.log,
          request.id ?? null,
        );
        return reply.code(200).send(project);
      },
    );

    // ---------------------------------------------------------------
    // PATCH /api/projects/:id/dates
    // ---------------------------------------------------------------
    app.patch(
      '/api/projects/:id/dates',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string', format: 'uuid' },
            },
          },
          body: {
            type: 'object',
            additionalProperties: false,
            properties: {
              // `null` is allowed so the frontend "clear planned date" flow
              // (ProjectDetailPanel.tsx → updateDates(id, val || null, ...))
              // reaches the repository's falsy→null branch. JSON Schema's
              // `format` keyword applies to strings only; null values bypass
              // it, which is exactly what we want.
              plannedStart: { type: ['string', 'null'], format: 'date' },
              plannedEnd: { type: ['string', 'null'], format: 'date' },
            },
          },
        },
        preHandler: requirePermission('project:dates'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as {
          plannedStart?: string | null;
          plannedEnd?: string | null;
        };

        const project = await datesService.updateDates(
          id,
          request.user!.id,
          body,
          request.log,
          request.id ?? null,
        );
        return reply.code(200).send(project);
      },
    );

    // ---------------------------------------------------------------
    // PATCH /api/projects/:id — update project fields
    // ---------------------------------------------------------------
    app.patch(
      '/api/projects/:id',
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
              title: { type: 'string', minLength: 1 },
              customerId: { type: 'string', format: 'uuid' },
              // PATCH semantics: omitted leaves the stored value unchanged;
              // null clears (= "site is at the customer's billing address");
              // a populated triple overwrites. Mirrors the customer-address
              // PATCH-clears rule. AC-284: each component requires minLength 1
              // — empty-string in any field is a 422 VALIDATION_ERROR.
              siteAddress: {
                type: ['object', 'null'],
                additionalProperties: false,
                required: ['street', 'zip', 'city'],
                properties: {
                  street: { type: 'string', minLength: 1 },
                  zip: { type: 'string', minLength: 1 },
                  city: { type: 'string', minLength: 1 },
                },
              },
              assignedWorkerIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
              estimatedValue: { type: ['number', 'null'] },
              notes: { type: ['string', 'null'] },
            },
          },
        },
        preHandler: requirePermission('project:update'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as {
          title?: string;
          customerId?: string;
          siteAddress?: { street: string; zip: string; city: string } | null;
          assignedWorkerIds?: string[];
          estimatedValue?: number | null;
          notes?: string | null;
        };
        const project = await crudService.updateProject(
          id,
          body,
          request.user!.id,
          request.log,
          request.id ?? null,
        );
        return reply.code(200).send(project);
      },
    );

    // ---------------------------------------------------------------
    // DELETE /api/projects/:id — soft-delete
    // ---------------------------------------------------------------
    app.delete(
      '/api/projects/:id',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: requirePermission('project:delete'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        await crudService.deleteProject(id, request.user!.id, request.log, request.id ?? null);
        return reply.code(200).send({ success: true, deleted: true });
      },
    );

    // ---------------------------------------------------------------
    // DELETE /api/projects/:id/purge — hard-delete (AC-155..158)
    //
    // Requires the narrower `project:purge` permission (owner-only).
    // `project:delete` (which office holds) does not grant purge.
    // Precondition: the project must already be archived; a non-archived
    // target returns 409 CONFLICT with German copy directing the user
    // to archive first.
    // ---------------------------------------------------------------
    app.delete(
      '/api/projects/:id/purge',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: requirePermission('project:purge'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        await crudService.purgeProject(id, request.user!.id, request.log, request.id ?? null);
        return reply.code(204).send();
      },
    );

    // ---------------------------------------------------------------
    // POST /api/projects/:id/restore — undo archive
    //
    // Symmetric to DELETE /api/projects/:id (archive). Reuses the
    // `project:delete` permission so the same role that archived can
    // recover from a fat-finger; ADR-0017 was updated to expose this
    // affordance after the read-only-preview surface gave it a UI home.
    // Precondition: the project must currently be archived; an active
    // target returns 409 CONFLICT.
    // ---------------------------------------------------------------
    app.post(
      '/api/projects/:id/restore',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: requirePermission('project:delete'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const project = await crudService.restoreProject(
          id,
          request.user!.id,
          request.log,
          request.id ?? null,
        );
        return reply.code(200).send(project);
      },
    );
  };
}
