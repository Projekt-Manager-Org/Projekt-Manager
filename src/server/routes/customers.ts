/**
 * Customer routes — CRUD operations for customers.
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/connection.js';
import { requirePermission, requireSession } from '../middleware/auth.js';
import {
  CustomerService,
  CUSTOMER_SORT_KEYS,
  type CustomerSortKey,
} from '../services/CustomerService.js';

export function customerRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const customerService = new CustomerService(db);

    requireSession(app, db);

    // GET /api/customers — list customers
    app.get(
      '/api/customers',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              offset: { type: 'integer', minimum: 0 },
              limit: { type: 'integer', minimum: 1, maximum: 200 },
              search: { type: 'string' },
              sortBy: { type: 'string', enum: [...CUSTOMER_SORT_KEYS] },
              sortDir: { type: 'string', enum: ['asc', 'desc'] },
            },
          },
        },
        preHandler: requirePermission('customer:read'),
      },
      async (request, reply) => {
        const query = request.query as {
          offset?: number;
          limit?: number;
          search?: string;
          sortBy?: CustomerSortKey;
          sortDir?: 'asc' | 'desc';
        };
        const result = await customerService.listCustomers(request.user!, query);
        return reply.code(200).send(result);
      },
    );

    // GET /api/customers/:id — get single customer
    app.get(
      '/api/customers/:id',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: requirePermission('customer:read'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const customer = await customerService.getCustomer(request.user!, id);
        return reply.code(200).send(customer);
      },
    );

    // POST /api/customers — create customer
    app.post(
      '/api/customers',
      {
        schema: {
          body: {
            type: 'object',
            required: ['name'],
            additionalProperties: false,
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: 'string', minLength: 1 },
              phone: { type: ['string', 'null'] },
              email: { type: ['string', 'null'] },
              address: {
                type: ['object', 'null'],
                additionalProperties: false,
                required: ['street', 'zip', 'city'],
                properties: {
                  street: { type: 'string' },
                  zip: { type: 'string' },
                  city: { type: 'string' },
                },
              },
              // USt-IdNr. — data-model.md §5.6 / AC-306. Structurally
              // optional at the route layer; the issuance-time
              // requiredness gate fires only when taxMode =
              // 'reverse_charge' (see AC-289). Capped at 50 chars to
              // bound the audit payload and the recipient-snapshot
              // metadata embedded in rendered invoices.
              ustId: { type: ['string', 'null'], maxLength: 50 },
              notes: { type: ['string', 'null'] },
            },
          },
        },
        preHandler: requirePermission('customer:write'),
      },
      async (request, reply) => {
        const body = request.body as {
          id?: string;
          name: string;
          phone?: string | null;
          email?: string | null;
          address?: { street: string; zip: string; city: string } | null;
          ustId?: string | null;
          notes?: string | null;
        };
        const customer = await customerService.createCustomer(
          body,
          request.user!.id,
          request.log,
          request.id ?? null,
        );
        return reply.code(201).send(customer);
      },
    );

    // PATCH /api/customers/:id — update customer
    app.patch(
      '/api/customers/:id',
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
              name: { type: 'string', minLength: 1 },
              phone: { type: ['string', 'null'] },
              email: { type: ['string', 'null'] },
              address: {
                type: ['object', 'null'],
                additionalProperties: false,
                required: ['street', 'zip', 'city'],
                properties: {
                  street: { type: 'string' },
                  zip: { type: 'string' },
                  city: { type: 'string' },
                },
              },
              // USt-IdNr. — see POST handler note above (AC-306).
              // PATCH with `ustId: null` clears the field.
              ustId: { type: ['string', 'null'], maxLength: 50 },
              notes: { type: ['string', 'null'] },
            },
          },
        },
        preHandler: requirePermission('customer:write'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as {
          name?: string;
          phone?: string | null;
          email?: string | null;
          address?: { street: string; zip: string; city: string } | null;
          ustId?: string | null;
          notes?: string | null;
        };
        const customer = await customerService.updateCustomer(
          id,
          body,
          request.user!.id,
          request.log,
          request.id ?? null,
        );
        return reply.code(200).send(customer);
      },
    );

    // DELETE /api/customers/:id — delete customer
    app.delete(
      '/api/customers/:id',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: requirePermission('customer:delete'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        await customerService.deleteCustomer(id, request.user!.id, request.log, request.id ?? null);
        return reply.code(204).send();
      },
    );
  };
}
