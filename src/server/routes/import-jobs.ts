/**
 * Full-account takeout IMPORT job routes — ADR-0018 / ADR-0024, api.md
 * §14.2.4 ("Import job"), data-model.md §5.18.
 *
 * Surfaces (all `data:restore`-gated):
 *   - POST /api/import-jobs    — destructive-guard up front (target-emptiness +
 *                                override + confirmation phrase), create a
 *                                `pending` job, return 201 immediately.
 *   - GET  /api/import-jobs    — `{ job: <latest import row> | null }`.
 *   - GET  /api/import-jobs/:id — the job row (`404` on unknown id).
 *   - HEAD /api/import-jobs/:id/archive — Upload-Offset + Upload-Length
 *                                headers (tus-style offset probe).
 *   - PATCH /api/import-jobs/:id/archive — append chunk (content-type
 *                                `application/offset+octet-stream`). When
 *                                the upload reaches Upload-Length, transitions
 *                                `pending → running` and fires the async
 *                                import runner.
 *
 * Resumable upload: the PATCH body is STREAMED directly to the staged file
 * to keep memory bounded. A content-type parser for
 * `application/offset+octet-stream` passes the raw request stream through
 * (Fastify has no built-in parser for this type). The Upload-Length cap is
 * enforced while streaming so an over-size chunk is rejected before it fills
 * the disk.
 *
 * Staged file convention: `<TAKEOUT_STAGING_DIR>/import-<jobId>.zip`.
 * archiveRef is set at markRunning (so the reaper can locate the file for
 * terminal jobs — AC-334). The runner sets archiveRef again at markReady.
 *
 * One active per kind (AC-331): a second POST while one is `pending`/
 * `running` returns `409 IMPORT_JOB_ACTIVE`.
 *
 * Destructive guard (AC-329): target-emptiness is probed at CREATE, before
 * any upload slot is allocated — a non-empty target without `override`
 * returns `409 TARGET_NOT_EMPTY`; override with a wrong/absent phrase
 * returns `422 RESTORE_CONFIRMATION_MISMATCH`. Guard failures mint NO row.
 */

import { chmod, mkdir, stat, truncate } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { Database } from '../db/connection.js';
import { requirePermission, requireSession } from '../middleware/auth.js';
import { DataExchangeJobService, toExchangeJobDto } from '../services/DataExchangeJobService.js';
import { ImportService } from '../services/ImportService.js';
import { runTakeoutImport } from '../services/takeout-import-runner.js';
import { stagedArtifactPath, sweepStagedArtifact } from '../services/takeout-staging.js';
import { createStorageClient } from '../storage/client.js';
import { getEnv } from '../config/env.js';
import {
  importJobActive,
  notFound,
  targetNotEmpty,
  restoreConfirmationMismatch,
  uploadHeaderInvalid,
  uploadOffsetConflict,
  uploadTooLarge,
  uploadNotAccepted,
} from '../errors.js';
import { STRINGS } from '../../config/strings.js';
import { restorePhraseMatches } from '../../config/dataExchangeConfig.js';

/**
 * Content-type for the tus-style resumable-upload PATCH body.
 * Fastify has no built-in parser for this type.
 */
const UPLOAD_CONTENT_TYPE = 'application/offset+octet-stream';

/**
 * High body-limit for the PATCH route — we enforce the Upload-Length cap
 * ourselves while streaming. 2 GB expressed in bytes (C-HARD).
 */
const UPLOAD_BODY_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

export function importJobRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const jobs = new DataExchangeJobService(db);
    const env = getEnv();
    // Storage client — same construction convention as export-jobs.ts.
    const storage = createStorageClient({
      endpoint: env.STORAGE_ENDPOINT!,
      publicEndpoint: env.STORAGE_PUBLIC_ENDPOINT,
      bucket: env.STORAGE_BUCKET,
      accessKey: env.STORAGE_ACCESS_KEY!,
      secretKey: env.STORAGE_SECRET_KEY!,
      region: env.STORAGE_REGION,
    });

    requireSession(app, db);

    // Register a content-type parser for the resumable upload PATCH body.
    // Fastify's built-in parsers cover `application/json` and
    // `application/x-www-form-urlencoded`; `application/offset+octet-stream`
    // has none, so Fastify would reject the PATCH with a 415. The identity
    // parser returns the raw IncomingMessage stream so the handler can pipe
    // it directly to disk (bounded memory — never buffered in full).
    app.addContentTypeParser(UPLOAD_CONTENT_TYPE, function (_req, payload, done) {
      done(null, payload);
    });

    // ---------------------------------------------------------------
    // POST /api/import-jobs — destructive guard + create.
    //
    // Gate order (C-SECU): auth preHandler → requirePermission →
    //   one-active gate → target-emptiness probe → phrase check →
    //   mint row. Guard failures mint NO row (AC-329).
    // ---------------------------------------------------------------
    app.post(
      '/api/import-jobs',
      { preHandler: requirePermission('data:restore') },
      async (request, reply) => {
        // One active per kind (AC-331) — checked before the destructive
        // guard so a colliding create returns 409 immediately.
        const active = await jobs.activeOfKind('import');
        if (active) {
          throw importJobActive(active.id);
        }

        // Parse Upload-Length from the request header.
        const uploadLengthHeader = request.headers['upload-length'];
        const uploadLength = Number(uploadLengthHeader);
        if (!uploadLengthHeader || !Number.isInteger(uploadLength) || uploadLength < 0) {
          throw uploadHeaderInvalid('Upload-Length');
        }

        const body = request.body as { override?: boolean; confirmation_phrase?: string } | null;
        const override = body?.override === true;
        const confirmationPhrase = body?.confirmation_phrase ?? null;

        // Target-emptiness probe — delegated to ImportService, which owns the
        // importable-set definition (`users` / `company_profile` excluded:
        // they always carry the bootstrap admin + the seeded singleton).
        const targetIsNonEmpty = await new ImportService(db).isTargetNonEmpty();

        if (targetIsNonEmpty) {
          if (!override) {
            // Non-empty target without override — 409, no row minted.
            throw targetNotEmpty();
          }
          // override=true into a non-empty target demands the phrase (AC-329).
          if (typeof confirmationPhrase !== 'string' || !restorePhraseMatches(confirmationPhrase)) {
            throw restoreConfirmationMismatch();
          }
        }

        // Sweep prior staged artifacts of this kind BEFORE minting the new job.
        // A prior import's staged file lingers on disk until the 24h TTL reaper;
        // back-to-back imports accumulate plaintext archives on the VPS.
        // Order: sweep BEFORE create so the new job's id is never in the list.
        const priorStaged = await jobs.priorStagedOfKind('import');
        for (const prior of priorStaged) {
          await sweepStagedArtifact(db, prior, request.log);
        }
        if (priorStaged.length > 0) {
          request.log.info(
            {
              event: 'takeout-pre-sweep',
              kind: 'import',
              swept_count: priorStaged.length,
              swept_ids: priorStaged.map((j) => j.id),
            },
            'takeout-pre-sweep',
          );
        }

        // Mint the job row then immediately record the declared upload size
        // so HEAD can serve Upload-Length before any bytes arrive.
        const job = await jobs.create('import', request.user!.id);
        // updateProgress returns the fresh row (with the persisted bytesTotal),
        // so the response reflects it without a second read.
        const fresh = await jobs.updateProgress(job.id, { bytesTotal: uploadLength });

        // When prior staged artifacts were swept, advertise the count on the
        // response so the caller can observe it (e.g. in tests / logging).
        // Omit the header entirely when count is 0 — present only when
        // something was actually discarded.
        if (priorStaged.length > 0) {
          reply.header('X-Discarded-Prior-Staged', String(priorStaged.length));
        }
        // Strip server-internal fields (archiveRef / createdBy) — Finding F1.
        return reply.code(201).send(toExchangeJobDto(fresh));
      },
    );

    // ---------------------------------------------------------------
    // GET /api/import-jobs — latest import job, or null.
    // ---------------------------------------------------------------
    app.get(
      '/api/import-jobs',
      { preHandler: requirePermission('data:restore') },
      async (_request, reply) => {
        const job = await jobs.latest('import');
        // Strip server-internal fields (archiveRef / createdBy) — Finding F1.
        // A null latest stays null.
        return reply.code(200).send({ job: job ? toExchangeJobDto(job) : null });
      },
    );

    // ---------------------------------------------------------------
    // GET /api/import-jobs/:id — status poll.
    // ---------------------------------------------------------------
    app.get(
      '/api/import-jobs/:id',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: requirePermission('data:restore'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const job = await jobs.get(id);
        if (!job) throw notFound(STRINGS.entities.resource);
        // Strip server-internal fields (archiveRef / createdBy) — Finding F1.
        return reply.code(200).send(toExchangeJobDto(job));
      },
    );

    // ---------------------------------------------------------------
    // HEAD /api/import-jobs/:id/archive — offset probe (tus-style).
    // ---------------------------------------------------------------
    app.head(
      '/api/import-jobs/:id/archive',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        // `@fastify/swagger` drops every HEAD route by default — they are
        // normally Fastify's automatic GET companions, which nobody wants
        // duplicated in the document. This one is declared on purpose and
        // is part of the protocol clients speak (api.md §14.2.4), so it
        // opts back in. Inert at runtime; only the generator reads it.
        config: { swagger: { exposeHeadRoute: true } },
        preHandler: requirePermission('data:restore'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const job = await jobs.get(id);
        // A non-import id (or unknown) does not exist in this namespace — 404.
        // Guards against an export job's id being probed via the import surface.
        if (!job || job.kind !== 'import') throw notFound(STRINGS.entities.resource);

        const stagedPath = stagedArtifactPath(env.TAKEOUT_STAGING_DIR, 'import', id);

        // The server-authoritative offset is the current on-disk file size.
        let currentOffset = 0;
        try {
          const s = await stat(stagedPath);
          currentOffset = s.size;
        } catch {
          // File not present yet (no bytes uploaded) — offset stays 0.
        }

        return reply
          .code(200)
          .header('Upload-Offset', String(currentOffset))
          .header('Upload-Length', String(job.bytesTotal))
          .send();
      },
    );

    // ---------------------------------------------------------------
    // PATCH /api/import-jobs/:id/archive — append chunk.
    //
    // Bounded memory: streams the body directly to disk. Enforces
    // the Upload-Length cap while streaming (wholesales rejection on
    // overflow — offset must not move, AC-326).
    // ---------------------------------------------------------------
    app.patch(
      '/api/import-jobs/:id/archive',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        bodyLimit: UPLOAD_BODY_LIMIT_BYTES,
        preHandler: requirePermission('data:restore'),
      },
      async (request: FastifyRequest, reply) => {
        const { id } = request.params as { id: string };
        const job = await jobs.get(id);
        // Reject a non-import id (or unknown) — an export job's id PATCHed here
        // would otherwise flip THAT job to `running` and fire a bogus restore.
        if (!job || job.kind !== 'import') throw notFound(STRINGS.entities.resource);
        // Only a `pending` job accepts bytes. Once the upload completes the job
        // leaves `pending` (running → terminal); appending then would corrupt
        // the staged archive the runner reads, or re-fire a failed job's
        // restore. The normal client never hits this (its loop ends at
        // Upload-Length, before the flip) — it guards direct API misuse.
        if (job.status !== 'pending') throw uploadNotAccepted();

        const clientOffset = Number(request.headers['upload-offset']);
        if (!Number.isInteger(clientOffset) || clientOffset < 0) {
          throw uploadHeaderInvalid('Upload-Offset');
        }

        const stagingDir = env.TAKEOUT_STAGING_DIR;
        const stagedPath = stagedArtifactPath(stagingDir, 'import', id);

        // Ensure staging directory exists with tight permissions (ADR-0024).
        await mkdir(stagingDir, { recursive: true, mode: 0o700 });
        await chmod(stagingDir, 0o700);

        // Authoritative server offset = current on-disk file size. NOTE: the
        // stat→compare→append below is not serialized, so two PATCHes racing at
        // the same offset could both append and corrupt the staged archive.
        // The one-active-job-per-kind gate + the single-operator deployment
        // (one client uploading sequentially) make that unreachable in practice;
        // a per-job upload lock is the fix if this ever serves concurrent writers.
        let currentOffset = 0;
        try {
          const s = await stat(stagedPath);
          currentOffset = s.size;
        } catch {
          // Staged file not created yet — offset stays 0.
        }

        // Offset mismatch — reject, keep the server offset unchanged (AC-326).
        if (clientOffset !== currentOffset) {
          throw uploadOffsetConflict();
        }

        const bytesTotal = job.bytesTotal;
        const remaining = bytesTotal - currentOffset;

        // Guard before streaming: reject immediately when Content-Length
        // alone proves the chunk would overshoot Upload-Length.
        const contentLength = Number(request.headers['content-length']);
        if (Number.isInteger(contentLength) && contentLength > 0 && contentLength > remaining) {
          throw uploadTooLarge();
        }

        // Append-mode write stream; mode 0o600 keeps plaintext off other UIDs
        // (ADR-0024 trust radius, mirrors the export builder).
        const out = createWriteStream(stagedPath, { flags: 'a', mode: 0o600 });

        // Stream body → disk with a byte-cap guard. If the source emits more
        // bytes than `remaining`, we truncate back to `currentOffset` and
        // throw 413 — the offset must not advance (AC-326).
        let written = 0;
        let overflowed = false;

        const body = request.body as NodeJS.ReadableStream;

        try {
          await pipeline(
            body,
            async function* (source) {
              for await (const raw of source) {
                const chunk = Buffer.isBuffer(raw)
                  ? raw
                  : Buffer.from(raw as unknown as Uint8Array);
                if (written + chunk.length > remaining) {
                  overflowed = true;
                  // Signal pipeline failure — the throw propagates out.
                  throw uploadTooLarge();
                }
                written += chunk.length;
                yield chunk;
              }
            },
            out,
          );
        } catch (err) {
          if (overflowed) {
            // Restore the offset: truncate any bytes written in this call.
            try {
              await truncate(stagedPath, currentOffset);
            } catch {
              // Best-effort — the job will fail validation regardless.
            }
            throw uploadTooLarge();
          }
          throw err;
        }

        const newOffset = currentOffset + written;

        // Upload complete: reached the declared total.
        if (newOffset >= bytesTotal) {
          // Transition pending → running and stamp archiveRef NOW (before the
          // async runner) so the staging reaper can locate the staged upload
          // for a terminal job — ready OR failed (data-model.md §6.15 / AC-334).
          await jobs.markRunning(id, { bytesTotal, archiveRef: stagedPath });

          // Fire-and-forget the restore — the PATCH returns 200 immediately
          // (mirrors POST /api/export-jobs). The browser polls
          // GET /api/import-jobs/:id; the runner validates → wipes (dropping
          // the operator session mid-job, AC-330) → restores → re-encrypts →
          // ready, recording any fault on the row (it never throws). A
          // multi-GB restore must NOT block this HTTP response.
          void runTakeoutImport({
            db,
            jobs,
            storage,
            jobId: id,
            stagedPath,
            logger: request.log,
            binaryAgeRecipient: env.BINARY_AGE_RECIPIENT ?? '',
            binaryAgeIdentityPath: env.BINARY_AGE_IDENTITY_PATH,
          });
        }

        return reply.code(200).header('Upload-Offset', String(newOffset)).send();
      },
    );
  };
}
