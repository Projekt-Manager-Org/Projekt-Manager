/**
 * Invoice routes — per-project draft CRUD plus issue / cancel / PDF
 * download (ADR-0026, api.md §14.2.14).
 *
 * Each handler is a thin HTTP adapter:
 *   - parse + Ajv-validate the request,
 *   - dispatch to `InvoiceService` for the domain logic and audit boundary,
 *   - format the response (and, for PDF, decrypt + stream the bytes).
 *
 * Authorization model:
 *   - `invoice:read` for list / get / pdf,
 *   - `invoice:write` for create / patch / delete / issue / cancel.
 * Worker holds neither; the repository-predicate scope (ADR-0019) also
 * narrows worker reads to the empty set as a structural backstop.
 *
 * The PDF download path retrieves the rendered ciphertext via the
 * attachment binary-descriptor reference, unwraps the row's `wrappedDek`
 * server-side, decrypts in memory, and streams the plaintext as
 * `application/pdf`. This mirrors the api.md §14.2.14 "Download PDF"
 * line which permits either inline bytes or a presigned-GET wrapper;
 * the inline path keeps the contract simple (no extra round-trip,
 * single-origin response) and matches the boot-time identity-loaded
 * invariant (ADR-0024).
 */

import type { FastifyInstance } from 'fastify';
import { ZipArchive } from 'archiver';
import type { Database } from '../db/connection.js';
import { requirePermission, requireSession } from '../middleware/auth.js';
import { createInvoiceService, type ListInvoicesOpts } from '../services/InvoiceService.js';
import {
  resolveExportInvoices,
  buildManifestCsv,
  todayIsoDate,
  type ExportInput,
  type ExportFilterInput,
} from '../services/InvoiceExportService.js';
import type { InvoiceLine, InvoiceRecipientSnapshot, TaxMode } from '../../domain/invoice.js';
import { TAX_MODES, INVOICE_STATUSES } from '../../domain/invoice.js';
import { buildContentDisposition } from '../storage/client.js';

/**
 * Shared JSON-schema fragment for an `InvoiceLine`. Routes accept the
 * fully-derived shape (the client computes `lineTotal` on each line so
 * the wire shape is concrete); the service re-validates and the server
 * re-derives `totals` from `lines + taxMode` on every successful write
 * (AC-286).
 */
const lineSchema = {
  type: 'object',
  required: ['description', 'quantity', 'unit', 'unitPrice', 'lineTotal', 'taxRate'],
  additionalProperties: false,
  properties: {
    description: { type: 'string', minLength: 1, maxLength: 1000 },
    quantity: { type: 'number', exclusiveMinimum: 0 },
    unit: { type: 'string', maxLength: 100 },
    unitPrice: { type: 'number', minimum: 0 },
    lineTotal: { type: 'number', minimum: 0 },
    taxRate: { type: 'number', enum: [0, 7, 19] },
  },
} as const;

const recipientSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
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
    ustId: { type: ['string', 'null'] },
  },
} as const;

export function invoiceRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const service = createInvoiceService(db);

    requireSession(app, db);

    // ---------------------------------------------------------------
    // GET /api/invoices — list.
    //
    // No `invoice:read` permission gate (AC-298, AT-119): worker holds
    // no invoice permission but the repository-predicate scope
    // (ADR-0019) returns the empty set for worker callers — structural
    // exclusion rather than 403. A permission gate here would surface
    // worker calls as 403 instead of `200 + { data: [] }`, contrary to
    // the spec. The authenticated-session preHandler still runs so
    // unauthenticated callers see 401.
    // ---------------------------------------------------------------
    app.get(
      '/api/invoices',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              offset: { type: 'integer', minimum: 0 },
              limit: { type: 'integer', minimum: 1, maximum: 500 },
              status: { type: 'string', enum: [...INVOICE_STATUSES] },
              year: { type: 'integer', minimum: 1900, maximum: 9999 },
              projectId: { type: 'string', format: 'uuid' },
              customerId: { type: 'string', format: 'uuid' },
              includeCancelled: { type: 'string', enum: ['true', 'false'] },
              search: { type: 'string' },
            },
          },
        },
      },
      async (request, reply) => {
        const q = request.query as {
          offset?: number;
          limit?: number;
          status?: ListInvoicesOpts['status'];
          year?: number;
          projectId?: string;
          customerId?: string;
          includeCancelled?: 'true' | 'false';
          search?: string;
        };
        const opts: ListInvoicesOpts = {
          ...(q.offset !== undefined ? { offset: q.offset } : {}),
          ...(q.limit !== undefined ? { limit: q.limit } : {}),
          ...(q.status !== undefined ? { status: q.status } : {}),
          ...(q.year !== undefined ? { year: q.year } : {}),
          ...(q.projectId !== undefined ? { projectId: q.projectId } : {}),
          ...(q.customerId !== undefined ? { customerId: q.customerId } : {}),
          // Default `true` per api.md §14.2.14; the repo treats undefined
          // as the default so explicit absence and explicit `true` are
          // observationally equivalent.
          ...(q.includeCancelled === 'false' ? { includeCancelled: false } : {}),
          ...(q.search !== undefined ? { search: q.search } : {}),
        };
        const result = await service.list(request.user!, opts);
        return reply.code(200).send(result);
      },
    );

    // ---------------------------------------------------------------
    // GET /api/invoices/years — distinct issue-date years in the
    // caller's scope, descending. Drives the year-filter dropdown
    // independent of the active filter. Workers see `[]` because the
    // scope predicate excludes them (ADR-0019).
    // ---------------------------------------------------------------
    app.get('/api/invoices/years', async (request, reply) => {
      const years = await service.listYears(request.user!);
      return reply.code(200).send({ years });
    });

    // ---------------------------------------------------------------
    // GET /api/invoices/:id — three-way 200 / 403 / 404 (AC-298).
    //
    // No `invoice:read` permission gate: the service's three-way result
    // (in-scope row / OUT_OF_SCOPE / null) maps to 200 / 403 / 404. A
    // worker hitting an existing row gets 403 via `notPermitted()`
    // raised from the OUT_OF_SCOPE branch; a worker hitting an unknown
    // id gets 404 from the null branch. A permission gate here would
    // collapse both worker arms to 403 — including the unknown-id
    // arm — and contradict AT-119's 404 expectation.
    // ---------------------------------------------------------------
    app.get(
      '/api/invoices/:id',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const invoice = await service.get(request.user!, id);
        return reply.code(200).send(invoice);
      },
    );

    // ---------------------------------------------------------------
    // POST /api/invoices — create draft
    // ---------------------------------------------------------------
    app.post(
      '/api/invoices',
      {
        schema: {
          body: {
            type: 'object',
            required: ['projectId'],
            additionalProperties: false,
            properties: {
              projectId: { type: 'string', format: 'uuid' },
              // `maxItems` caps renderer-CPU amplification on a single
              // accepted request. 500 is the practical upper bound on a
              // single invoice (a long-form construction project at one
              // unit per line); routes that exceed it should be split.
              lines: { type: 'array', items: lineSchema, maxItems: 500 },
              recipient: recipientSchema,
              taxMode: { type: 'string', enum: [...TAX_MODES] },
              // ISO-8601 calendar date. The month/day groups are pinned
              // here (rather than via Ajv `format: 'date'`, which the
              // route plugin does not register `ajv-formats` for) so the
              // route layer rejects `9999-19-39` outright instead of
              // forwarding a malformed value to the service.
              performanceDate: {
                type: ['string', 'null'],
                pattern: '^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$',
              },
            },
          },
        },
        preHandler: requirePermission('invoice:write'),
      },
      async (request, reply) => {
        const body = request.body as {
          projectId: string;
          lines?: InvoiceLine[];
          recipient?: InvoiceRecipientSnapshot;
          taxMode?: TaxMode;
          performanceDate?: string | null;
        };
        const invoice = await service.createDraft(
          {
            projectId: body.projectId,
            ...(body.lines !== undefined ? { lines: body.lines } : {}),
            ...(body.recipient !== undefined ? { recipient: body.recipient } : {}),
            ...(body.taxMode !== undefined ? { taxMode: body.taxMode } : {}),
            ...(body.performanceDate !== undefined
              ? { performanceDate: body.performanceDate }
              : {}),
          },
          request.user!.id,
          request.log,
          request.id ?? null,
        );
        return reply.code(201).send(invoice);
      },
    );

    // ---------------------------------------------------------------
    // PATCH /api/invoices/:id — update draft (INVOICE_FROZEN on issued/cancelled)
    // ---------------------------------------------------------------
    app.patch(
      '/api/invoices/:id',
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
            properties: {
              // See POST handler — same `maxItems` + ISO-8601 rationale.
              lines: { type: 'array', items: lineSchema, maxItems: 500 },
              recipient: recipientSchema,
              taxMode: { type: 'string', enum: [...TAX_MODES] },
              performanceDate: {
                type: ['string', 'null'],
                pattern: '^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$',
              },
            },
          },
        },
        preHandler: requirePermission('invoice:write'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as {
          lines?: InvoiceLine[];
          recipient?: InvoiceRecipientSnapshot;
          taxMode?: TaxMode;
          performanceDate?: string | null;
        };
        const invoice = await service.updateDraft(
          id,
          {
            ...(body.lines !== undefined ? { lines: body.lines } : {}),
            ...(body.recipient !== undefined ? { recipient: body.recipient } : {}),
            ...(body.taxMode !== undefined ? { taxMode: body.taxMode } : {}),
            // The service treats `'performanceDate' in input` as the
            // touch-marker, so forward the body key only when the
            // caller actually sent it.
            ...('performanceDate' in body ? { performanceDate: body.performanceDate ?? null } : {}),
          },
          request.user!.id,
          request.log,
          request.id ?? null,
        );
        return reply.code(200).send(invoice);
      },
    );

    // ---------------------------------------------------------------
    // DELETE /api/invoices/:id — hard-delete draft (INVOICE_FROZEN otherwise)
    // ---------------------------------------------------------------
    app.delete(
      '/api/invoices/:id',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: requirePermission('invoice:write'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        await service.deleteDraft(id, request.user!.id, request.log, request.id ?? null);
        return reply.code(204).send();
      },
    );

    // ---------------------------------------------------------------
    // POST /api/invoices/:id/issue — issuance transaction (AC-287)
    // ---------------------------------------------------------------
    app.post(
      '/api/invoices/:id/issue',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: requirePermission('invoice:write'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const invoice = await service.issueDraft(
          id,
          request.user!.id,
          request.log,
          request.id ?? null,
        );
        return reply.code(200).send(invoice);
      },
    );

    // ---------------------------------------------------------------
    // POST /api/invoices/:id/cancel — Storno atom (AC-290)
    // ---------------------------------------------------------------
    app.post(
      '/api/invoices/:id/cancel',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
          body: {
            type: ['object', 'null'],
            additionalProperties: false,
            properties: {
              reason: { type: ['string', 'null'], maxLength: 2000 },
            },
          },
        },
        preHandler: requirePermission('invoice:write'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = (request.body ?? {}) as { reason?: string | null };
        const result = await service.cancel(
          id,
          { ...(body.reason !== undefined ? { reason: body.reason } : {}) },
          request.user!.id,
          request.log,
          request.id ?? null,
        );
        return reply.code(200).send(result);
      },
    );

    // ---------------------------------------------------------------
    // GET /api/invoices/:id/pdf — download rendered ZUGFeRD bytes.
    //
    // Permission-gated via `requirePermission('invoice:read')` — workers
    // hold no invoice permission and are rejected at the middleware
    // boundary (403) before the service is reached. Authorized callers
    // (owner / office / bookkeeper) are all unscoped, so the service's
    // get-triage collapses to two-way: 200 (row resolved) or 404
    // (unknown id; also surfaces when the descriptor reference is null
    // or the attachment row is gone). Draft → 409 INVOICE_NOT_ISSUED
    // (AC-299). Bytes are retrieved by fetching the rendered-PDF
    // attachment row, unwrapping its `wrappedDek` server-side,
    // decrypting the ciphertext fetched from object storage, and
    // streaming the plaintext as `application/pdf` with a
    // Content-Disposition naming the invoice.
    // ---------------------------------------------------------------
    app.get(
      '/api/invoices/:id/pdf',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: requirePermission('invoice:read'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const { bytes, filename } = await service.downloadPdf(request.user!, id);
        return reply
          .code(200)
          .header('Content-Type', 'application/pdf')
          .header('Content-Disposition', buildContentDisposition(filename))
          .header('Content-Length', String(bytes.byteLength))
          .send(Buffer.from(bytes));
      },
    );

    // ---------------------------------------------------------------
    // POST /api/invoices/export — bulk-download a ZIP of issued /
    // cancelled invoice PDFs plus a CSV manifest. Bookkeeper takeout
    // (ui/invoices.md §8.16.x).
    //
    // Two request shapes (exactly one of `ids` / `filter`):
    //   { ids: [uuid, ...] }
    //   { filter: { year?, status?, projectId?, customerId?, includeCancelled?, search? } }
    //
    // Permission: `invoice:read` (owner / office / bookkeeper).
    //
    // Drafts are not in the ZIP: ids-mode rejects with 422
    // DRAFT_NOT_EXPORTABLE before any bytes leave the wire;
    // filter-mode silently omits them. The archive is built lazily by
    // `archiver` and handed to Fastify as a Readable — `reply.send()`
    // pipes it to the wire, so the compressed ZIP bytes never collect
    // in memory.
    // ---------------------------------------------------------------
    app.post(
      '/api/invoices/export',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ids: {
                type: 'array',
                items: { type: 'string', format: 'uuid' },
                minItems: 1,
                // Mirrors the filter-mode safety cap. A single explicit
                // selection over 5000 invoices is presumed misuse; the
                // user can re-run with a narrower selection.
                maxItems: 5000,
              },
              filter: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  year: { type: 'integer', minimum: 1900, maximum: 9999 },
                  status: { type: 'string', enum: [...INVOICE_STATUSES] },
                  projectId: { type: 'string', format: 'uuid' },
                  customerId: { type: 'string', format: 'uuid' },
                  includeCancelled: { type: 'boolean' },
                  search: { type: 'string' },
                },
              },
            },
          },
        },
        preHandler: requirePermission('invoice:read'),
      },
      async (request, reply) => {
        const body = request.body as {
          ids?: string[];
          filter?: ExportFilterInput;
        };

        // Preserve undefined-vs-present semantics — `resolveExportInvoices`
        // enforces the exclusive-or invariant; collapsing the missing
        // half to a default empty filter here would mask the validation
        // gate.
        const input = {
          ...(body.ids !== undefined ? { ids: body.ids } : {}),
          ...(body.filter !== undefined ? { filter: body.filter } : {}),
        } as ExportInput;

        // Resolve + pre-fetch all PDF bytes BEFORE setting headers.
        // A failure here (404 / 403 / draft) bubbles to the global
        // error handler and surfaces as the documented status code;
        // once we start writing the archive the response status is
        // locked, so any later fault can only be expressed as a
        // truncated stream.
        const { invoices, scopeLabel } = await resolveExportInvoices(service, request.user!, input);

        const entries: { name: string; bytes: Uint8Array }[] = [];
        for (const invoice of invoices) {
          const { bytes } = await service.downloadPdfBytesForInvoice(invoice);
          entries.push({ name: `${invoice.number!}.pdf`, bytes });
        }
        const manifest = buildManifestCsv(invoices);

        const filename = `Rechnungen_${scopeLabel}_${todayIsoDate()}.zip`;
        const archive = new ZipArchive({ zlib: { level: 9 } });
        archive.on('warning', (err) => {
          request.log.warn({ err }, 'invoice_export_archive_warning');
        });
        archive.on('error', (err) => {
          request.log.error({ err }, 'invoice_export_archive_error');
        });

        for (const entry of entries) {
          archive.append(Buffer.from(entry.bytes), { name: entry.name });
        }
        archive.append(Buffer.from(manifest, 'utf-8'), { name: 'manifest.csv' });

        // Kick off finalize before handing the stream to Fastify —
        // archiver only starts emitting bytes after `finalize()` is
        // called and the consumer begins reading. Awaiting the
        // returned promise would deadlock (it resolves when the stream
        // is fully consumed, which only happens once Fastify reads
        // from it).
        void archive.finalize();

        return reply
          .code(200)
          .header('Content-Type', 'application/zip')
          .header('Content-Disposition', buildContentDisposition(filename))
          .send(archive);
      },
    );
  };
}
