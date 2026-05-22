/**
 * Unified data exchange routes. See ADR-0018.
 *
 * Surfaces:
 *   - GET  /api/export                      — single-shot business-data envelope
 *   - POST /api/import                      — restore-only ingest (dry-run + override + confirmation)
 *   - GET  /api/export/binary-descriptors   — paginated companion that yields
 *     every `status='ready'` attachment as a `BinaryDescriptor` (api.md
 *     §14.2.4, AC-248). Browser-side `Vollständiger Export` drains it
 *     alongside `data.json` to assemble a streaming-zip locally.
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/connection.js';
import { createAuthMiddleware, requirePermission } from '../middleware/auth.js';
import { ExportService } from '../services/ExportService.js';
import { ImportService } from '../services/ImportService.js';
import { BinaryDescriptorService } from '../services/BinaryDescriptorService.js';
import { createStorageClient } from '../storage/client.js';
import { getEnv } from '../config/env.js';
import type { Envelope, ImportOptions } from '../../domain/dataExchange.js';

/**
 * Body shape for `POST /api/import`. Issue #163 / AC-253: the endpoint
 * is text-only post-fix; a body carrying an `attachments` key MUST be
 * rejected with `422 VALIDATION_ERROR` and no writes occur.
 *
 * Issue #230: `users`, `company_profile`, `invoices`, `invoice_sequence`
 * are required alongside the pre-existing customers / projects /
 * project_workers. SCHEMA_VERSION = 3 is a hard cut — pre-#230 envelopes
 * fail at the service layer with SCHEMA_VERSION_MISMATCH; the body
 * schema additionally enforces the new keys are present so a hand-edited
 * v3-stamped envelope missing them fails fast at the route layer with
 * 422 instead of bubbling a type error from the service.
 *
 * Listing `attachments` under `properties` with `not: {}` (a schema that
 * fails for every value) is the load-bearing trick: Fastify's ajv
 * defaults to `removeAdditional: true`, so a bare
 * `additionalProperties: false` would silently strip `attachments` rather
 * than reject — see the parallel comment in
 * `src/server/__tests__/push-subscriptions.test.ts`. Listing the key
 * explicitly in `properties` prevents removeAdditional from firing
 * (the key is no longer "additional"), and `not: {}` ensures any value
 * of any type fails validation. Other unlisted keys (a stray `foo`)
 * still get stripped — that is fine; only `attachments` is the
 * load-bearing wire-shape rejection per AC-253.
 */
const ENVELOPE_BODY_SCHEMA = {
  type: 'object',
  required: [
    'schema_version',
    'exported_at',
    'users',
    'company_profile',
    'customers',
    'projects',
    'project_workers',
    'invoices',
    'invoice_sequence',
  ],
  properties: {
    schema_version: { type: 'integer' },
    exported_at: { type: 'string' },
    users: { type: 'array' },
    company_profile: { type: 'array' },
    customers: { type: 'array' },
    projects: { type: 'array' },
    project_workers: { type: 'array' },
    invoices: { type: 'array' },
    invoice_sequence: { type: 'array' },
    // AC-253: any `attachments` payload rejects with 422 — the legacy
    // shape silently inserted attachment rows whose wrapped DEKs were
    // unwrappable on the importing instance.
    attachments: { not: {} },
    // AC-160: optional on the dry-run and empty-target paths; required by
    // ImportService when `override=true` commits into a non-empty DB. The
    // maxLength keeps a pathological payload from reaching the service —
    // the configured phrase is short and any sane input fits well under 64.
    confirmation_phrase: { type: 'string', maxLength: 64 },
  },
} as const;

export function dataExchangeRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const authenticate = createAuthMiddleware(db);
    const exportService = new ExportService(db);
    const env = getEnv();
    // Storage client + binary-descriptor service mirror the attachment-
    // route construction (env-derived endpoints, per-request envelope
    // service against the operator-loaded identity). The fallback
    // `?? ''` collapses satisfy tsc — the boot probes refuse to start
    // the app without these env values populated.
    const storage = createStorageClient({
      endpoint: env.STORAGE_ENDPOINT!,
      publicEndpoint: env.STORAGE_PUBLIC_ENDPOINT,
      bucket: env.STORAGE_BUCKET,
      accessKey: env.STORAGE_ACCESS_KEY!,
      secretKey: env.STORAGE_SECRET_KEY!,
      region: env.STORAGE_REGION,
    });
    const importService = new ImportService(db, storage);
    const binaryDescriptorService = new BinaryDescriptorService({
      db,
      storage,
      binaryAgeRecipient: env.BINARY_AGE_RECIPIENT ?? '',
      binaryAgeIdentityPath: env.BINARY_AGE_IDENTITY_PATH,
    });

    app.addHook('preHandler', authenticate);

    // ---------------------------------------------------------------
    // GET /api/export
    // ---------------------------------------------------------------
    app.get(
      '/api/export',
      { preHandler: requirePermission('data:export') },
      async (request, reply) => {
        // Caller is guaranteed non-null after `authenticate` — thread it
        // through so ExportService can fail-fast if a scoped role ever
        // acquires `data:export` (tripwire for ADR-0019 bypass).
        const envelope = await exportService.export(request.user!);
        return reply.code(200).send(envelope);
      },
    );

    // ---------------------------------------------------------------
    // GET /api/export/binary-descriptors — paginated descriptor surface
    // (api.md §14.2.4 / verification.md AC-248).
    //
    // The query-string schema is intentionally permissive on `after` (a
    // free-form string — service decodes and validates) and `limit` (a
    // bare number — service enforces the `[C]` ceiling so the
    // 422 VALIDATION_ERROR surface stays in one place rather than split
    // between Fastify's schema validator and the service). Both paths
    // surface the same `code: 'VALIDATION_ERROR'` envelope shape.
    // ---------------------------------------------------------------
    app.get(
      '/api/export/binary-descriptors',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              after: { type: 'string' },
              // `coerce: { types: [...] }` would be cleaner but Fastify
              // doesn't support per-field coercion in the standard ajv
              // pipeline; accepting `string` here and parsing in the
              // handler keeps the validator simple and lets the service
              // own the `[C]` ceiling check.
              limit: { type: 'string' },
            },
          },
        },
        preHandler: requirePermission('data:export'),
      },
      async (request, reply) => {
        const q = request.query as { after?: string; limit?: string };
        const limit = q.limit !== undefined ? Number(q.limit) : undefined;
        const page = await binaryDescriptorService.listPage(request.user!, {
          after: q.after,
          limit,
        });
        return reply.code(200).send(page);
      },
    );

    // ---------------------------------------------------------------
    // POST /api/import
    // ---------------------------------------------------------------
    app.post(
      '/api/import',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              // Strict enum so a typo (TRUE, 1, yes, dryRun-camelCase) fails
              // closed with 422 rather than silently arming the destructive
              // path. Mirrors `override`'s safe-by-default posture.
              dry_run: { type: 'string', enum: ['true', 'false'] },
              override: { type: 'string', enum: ['true', 'false'] },
            },
          },
          body: ENVELOPE_BODY_SCHEMA,
        },
        preHandler: requirePermission('data:restore'),
      },
      async (request, reply) => {
        const query = request.query as { dry_run?: string; override?: string };
        const { confirmation_phrase: rawPhrase, ...envelope } = request.body as Envelope & {
          confirmation_phrase?: unknown;
        };
        const opts: ImportOptions = {
          dryRun: query.dry_run === 'true',
          override: query.override === 'true',
          confirmationPhrase: typeof rawPhrase === 'string' ? rawPhrase : null,
        };
        const result = await importService.import(envelope, opts, request.log, request.user!);
        return reply.code(200).send(result);
      },
    );
  };
}
