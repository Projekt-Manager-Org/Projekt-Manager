/**
 * Attachment routes — control plane only. No byte traffic through the
 * app; uploads and downloads go directly to object storage via
 * presigned URLs (AC-221, AC-242, api.md §14.2.11).
 *
 * Under ADR-0024 the wire shape carries ciphertext sizes + DEK material
 * and the bulk path returns per-file presigned-GETs + DEK material for
 * browser-side streaming-zip assembly (the legacy server-zip
 * `bulk-download` route retires).
 *
 * The route shape is pinned by AC-221's structural check — do not add
 * a 9th route on `/api/projects/:id/attachments/**` without updating
 * the spec + AC first.
 *
 * Auth wiring (issue #230 fixup):
 *   - The binary-leg routes the takeout-zip restore orchestrator hits
 *     (`init`, `complete`, `DELETE`) accept either a session cookie OR
 *     an `Authorization: Bearer <importToken>` header. The header wins
 *     when both are present, because the cookie is known to be dead
 *     post-`users`-TRUNCATE (see `importTokenStore.ts`).
 *   - All other routes (listing, Papierkorb, download-url, bulk-fetch)
 *     remain session-only — defense in depth against a token that
 *     leaks outside the binary-leg flow.
 *
 * Auth is wired per-route rather than via a plugin-wide
 * `app.addHook('preHandler', ...)` so the two middlewares can coexist
 * without one accidentally swallowing the other.
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/connection.js';
import {
  createAuthMiddleware,
  createAuthMiddlewareWithImportToken,
  requirePermission,
} from '../middleware/auth.js';
import { AttachmentService, type DownloadVariant } from '../services/AttachmentService.js';
import { createStorageClient } from '../storage/client.js';
import { getEnv } from '../config/env.js';

export function attachmentRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const authenticate = createAuthMiddleware(db);
    const authenticateWithImportToken = createAuthMiddlewareWithImportToken(db);
    const env = getEnv();
    const storage = createStorageClient({
      endpoint: env.STORAGE_ENDPOINT!,
      publicEndpoint: env.STORAGE_PUBLIC_ENDPOINT,
      bucket: env.STORAGE_BUCKET,
      accessKey: env.STORAGE_ACCESS_KEY!,
      secretKey: env.STORAGE_SECRET_KEY!,
      region: env.STORAGE_REGION,
    });
    const service = new AttachmentService({
      db,
      storage,
      // Both BINARY_AGE_* values are fail-open in env zod; the boot
      // probe (`assertBinaryIdentityLoaded`) refuses to start the app
      // without them, so by the time a route handler runs they are
      // populated. The `?? ''` collapse satisfies tsc — the service
      // itself rejects empty inputs in its constructor.
      binaryAgeRecipient: env.BINARY_AGE_RECIPIENT ?? '',
      binaryAgeIdentityPath: env.BINARY_AGE_IDENTITY_PATH,
    });

    // ---------------------------------------------------------------
    // GET /api/projects/:id/attachments — list (status=ready only)
    // ---------------------------------------------------------------
    app.get(
      '/api/projects/:id/attachments',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: [authenticate, requirePermission('attachment:read')],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const rows = await service.listForProject(request.user!, id);
        return reply.code(200).send({ data: rows });
      },
    );

    // ---------------------------------------------------------------
    // POST /api/projects/:id/attachments/init — create pending row
    //
    // Binary-leg endpoint: accepts session cookie OR
    // `Authorization: Bearer <importToken>` (issue #230 fixup).
    //
    // ADR-0024: the body carries the ciphertext-bound triplet
    // (`dekMaterial`, `ciphertextSizeBytes`, `ciphertextContentMd5`)
    // plus optional thumbnail equivalents; plaintext `mimeType` /
    // `sizeBytes` / `fileName` / `label` stay on the row for cap checks
    // and download Content-Disposition. `additionalProperties: false`
    // is load-bearing — a stray client-supplied `originalKey` /
    // `wrappedDek` / `versionId` must not bypass the server's owned
    // fields.
    // ---------------------------------------------------------------
    app.post(
      '/api/projects/:id/attachments/init',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
          body: {
            type: 'object',
            required: [
              'fileName',
              'mimeType',
              'sizeBytes',
              'label',
              'dekMaterial',
              'ciphertextSizeBytes',
              'ciphertextContentMd5',
            ],
            additionalProperties: false,
            properties: {
              fileName: { type: 'string', minLength: 1 },
              mimeType: { type: 'string', minLength: 1 },
              sizeBytes: { type: 'integer', minimum: 1 },
              label: { type: 'string' },
              hasThumbnail: { type: 'boolean' },
              // ADR-0024 ciphertext fields. The server signs
              // `ciphertextSizeBytes` into Content-Length and
              // `ciphertextContentMd5` into Content-MD5 of the presigned
              // PUT — see api.md §14.2.11 design notes.
              dekMaterial: { type: 'string', minLength: 1 },
              ciphertextSizeBytes: { type: 'integer', minimum: 1 },
              ciphertextContentMd5: { type: 'string', pattern: '^[A-Za-z0-9+/]{21}[AQgw]==$' },
              // Photo-only thumbnail triplet — schema-optional so binaries
              // do not have to send the fields. Service layer enforces
              // the photos-with-thumbnail invariant after MIME classification.
              thumbDekMaterial: { type: 'string', minLength: 1 },
              ciphertextThumbSizeBytes: { type: 'integer', minimum: 1 },
              ciphertextThumbContentMd5: {
                type: 'string',
                pattern: '^[A-Za-z0-9+/]{21}[AQgw]==$',
              },
              // Issue #163 / api.md §14.2.11 / AC-255-257 — optional
              // import-mode block for the takeout-zip restore
              // orchestrator. When present, service layer additionally
              // gates on `data:restore` (the AND-gate semantics depend
              // on the block being present, which is why this is NOT a
              // route-level preHandler). Field-shape validation here;
              // user-existence and id-collision checks run in the
              // service.
              restore: {
                type: 'object',
                required: ['id', 'createdBy', 'createdAt'],
                additionalProperties: false,
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  createdBy: { type: 'string', format: 'uuid' },
                  createdAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
        preHandler: [authenticateWithImportToken, requirePermission('attachment:write')],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as {
          fileName: string;
          mimeType: string;
          sizeBytes: number;
          label: string;
          hasThumbnail?: boolean;
          dekMaterial: string;
          ciphertextSizeBytes: number;
          ciphertextContentMd5: string;
          thumbDekMaterial?: string;
          ciphertextThumbSizeBytes?: number;
          ciphertextThumbContentMd5?: string;
          // Issue #163 / api.md §14.2.11: optional import-mode block.
          // Service-layer enforces the `data:restore` AND-gate when
          // present (AC-255).
          restore?: { id: string; createdBy: string; createdAt: string };
        };
        const result = await service.initUpload(
          request.user!,
          id,
          {
            fileName: body.fileName,
            mimeType: body.mimeType,
            sizeBytes: body.sizeBytes,
            // The service re-validates `label` against the closed enum;
            // the typing here is intentionally wide so invalid payloads
            // reach the validator path (AC-245 422 VALIDATION_ERROR).
            label: body.label as never,
            hasThumbnail: Boolean(body.hasThumbnail),
            dekMaterial: body.dekMaterial,
            ciphertextSizeBytes: body.ciphertextSizeBytes,
            ciphertextContentMd5: body.ciphertextContentMd5,
            thumbDekMaterial: body.thumbDekMaterial,
            ciphertextThumbSizeBytes: body.ciphertextThumbSizeBytes,
            ciphertextThumbContentMd5: body.ciphertextThumbContentMd5,
            ...(body.restore !== undefined ? { restore: body.restore } : {}),
          },
          request.log,
          request.id ?? null,
        );
        return reply.code(201).send(result);
      },
    );

    // ---------------------------------------------------------------
    // POST /api/projects/:id/attachments/:attId/complete — finalize
    //
    // Binary-leg endpoint: accepts session cookie OR
    // `Authorization: Bearer <importToken>` (issue #230 fixup).
    // ---------------------------------------------------------------
    app.post(
      '/api/projects/:id/attachments/:attId/complete',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id', 'attId'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              attId: { type: 'string', format: 'uuid' },
            },
          },
        },
        preHandler: [authenticateWithImportToken, requirePermission('attachment:write')],
      },
      async (request, reply) => {
        const { id, attId } = request.params as { id: string; attId: string };
        const attachment = await service.completeUpload(request.user!, id, attId, request.log);
        return reply.code(200).send(attachment);
      },
    );

    // ---------------------------------------------------------------
    // DELETE /api/projects/:id/attachments/:attId — soft-hide
    // (ADR-0022; the row moves to status='hidden' and is recoverable
    // via the Papierkorb restore endpoint until lifecycle reap.)
    //
    // Binary-leg endpoint: the orchestrator's rollback walk DELETEs
    // each committed attachment on a fatal failure. Accepts session
    // cookie OR `Authorization: Bearer <importToken>` (issue #230 fixup).
    // ---------------------------------------------------------------
    app.delete(
      '/api/projects/:id/attachments/:attId',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id', 'attId'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              attId: { type: 'string', format: 'uuid' },
            },
          },
        },
        preHandler: [authenticateWithImportToken, requirePermission('attachment:hide')],
      },
      async (request, reply) => {
        const { id, attId } = request.params as { id: string; attId: string };
        await service.hideAttachment(request.user!, id, attId, request.log, request.id ?? null);
        return reply.code(204).send();
      },
    );

    // ---------------------------------------------------------------
    // GET /api/projects/:id/attachments/trash — Papierkorb listing.
    // Owner / office only via attachment:trash. Returns the same shape
    // as the live list, with hiddenAt populated.
    // ---------------------------------------------------------------
    app.get(
      '/api/projects/:id/attachments/trash',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: [authenticate, requirePermission('attachment:trash')],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const data = await service.listHiddenForProject(request.user!, id);
        return reply.code(200).send({ data });
      },
    );

    // ---------------------------------------------------------------
    // POST /api/projects/:id/attachments/:attId/restore — pull the row
    // back from the Papierkorb. Owner / office only via attachment:trash.
    // copyFromVersion runs server-side; the row's persisted version_id
    // pair is the source.
    // ---------------------------------------------------------------
    app.post(
      '/api/projects/:id/attachments/:attId/restore',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id', 'attId'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              attId: { type: 'string', format: 'uuid' },
            },
          },
        },
        preHandler: [authenticate, requirePermission('attachment:trash')],
      },
      async (request, reply) => {
        const { id, attId } = request.params as { id: string; attId: string };
        const attachment = await service.restoreAttachment(
          request.user!,
          id,
          attId,
          request.log,
          request.id ?? null,
        );
        return reply.code(200).send(attachment);
      },
    );

    // ---------------------------------------------------------------
    // GET /api/projects/:id/attachments/:attId/download-url — presigned
    // GET + unwrapped DEK material (ADR-0024 / api.md §14.2.11). The
    // server unwraps `wrappedDek` (or `wrappedThumbDek` for
    // variant=thumbnail) per request; the unwrapped DEK is never
    // persisted server-side. Per-row unwrap failure surfaces as 422
    // with code DEK_UNWRAP_FAILED.
    // ---------------------------------------------------------------
    app.get(
      '/api/projects/:id/attachments/:attId/download-url',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id', 'attId'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              attId: { type: 'string', format: 'uuid' },
            },
          },
          querystring: {
            type: 'object',
            properties: {
              variant: { type: 'string' },
            },
          },
        },
        preHandler: [authenticate, requirePermission('attachment:read')],
      },
      async (request, reply) => {
        const { id, attId } = request.params as { id: string; attId: string };
        const q = request.query as { variant?: string };
        const variant = (q.variant ?? 'original') as DownloadVariant;
        const result = await service.issueDownloadUrl(request.user!, id, attId, variant);
        return reply.code(200).send(result);
      },
    );

    // ---------------------------------------------------------------
    // POST /api/projects/:id/attachments/bulk-fetch — per-file
    // presigned GETs + unwrapped DEK material. Replaces the retired
    // bulk-download zip path (ADR-0024); browser assembles the
    // streaming zip locally.
    // ---------------------------------------------------------------
    app.post(
      '/api/projects/:id/attachments/bulk-fetch',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
          body: {
            type: 'object',
            required: ['attachmentIds'],
            additionalProperties: false,
            properties: {
              attachmentIds: {
                type: 'array',
                // Length caps are enforced in the service so the
                // BULK_LIMIT_EXCEEDED branch has the spec'd shape.
                items: { type: 'string', format: 'uuid' },
              },
            },
          },
        },
        preHandler: [authenticate, requirePermission('attachment:read')],
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as { attachmentIds: string[] };
        const result = await service.bulkFetch(request.user!, id, body.attachmentIds);
        return reply.code(200).send(result);
      },
    );
  };
}
