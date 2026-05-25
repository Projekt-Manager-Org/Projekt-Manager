/**
 * Full-account takeout EXPORT job routes — ADR-0018 / ADR-0024, api.md
 * §14.2.4 ("Export job"), data-model.md §5.18.
 *
 * Surfaces (all `data:export`-gated):
 *   - POST /api/export-jobs           — create a `pending` job, kick off the
 *                                       async server-side build, return 201
 *                                       immediately (build is NOT awaited).
 *   - GET  /api/export-jobs           — `{ job: <latest export row> | null }`.
 *   - GET  /api/export-jobs/:id       — the job row (`404` on unknown id).
 *   - GET  /api/export-jobs/:id/download — stream the VPS-staged archive,
 *                                       Range-capable (`206` on a byte range).
 *
 * Build lifecycle: the create handler advances the row through the
 * `DataExchangeJobService` (`pending → running → ready | failed`) and the
 * `buildExportArchive` builder; the browser polls `GET :id` until terminal.
 * A per-row attachment failure is skipped by the builder — the build still
 * reaches `ready` (AC-325). At the terminal transition (and only there) the
 * runner writes EXACTLY ONE `audit_log` row with `entityType='data_import'`
 * (AC-332), mirroring the single `data_import` row `POST /api/import` writes
 * (AC-311). Progress updates write no audit rows.
 *
 * One active per kind (AC-331): a create colliding with a `pending`/
 * `running` export job returns `409 EXPORT_JOB_ACTIVE` carrying the active
 * job's id, so the UI re-attaches rather than starting a second build.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';

import type { Database } from '../db/connection.js';
import { createAuthMiddleware, requirePermission } from '../middleware/auth.js';
import { DataExchangeJobService } from '../services/DataExchangeJobService.js';
import { runExportBuild } from '../services/takeout-export-runner.js';
import { sweepStagedArtifact } from '../services/takeout-staging.js';
import { createStorageClient } from '../storage/client.js';
import { getEnv } from '../config/env.js';
import { exportJobActive, exportJobNotReady, notFound } from '../errors.js';
import { STRINGS } from '../../config/strings.js';

/**
 * Outcome of parsing a `Range` header against a known total size:
 *   - `full`          — absent / unrecognised / invalid header; serve the
 *                       whole body at 200 (RFC 7233 §3.1: ignore a Range we
 *                       cannot satisfy syntactically).
 *   - `range`         — a satisfiable byte range; serve 206.
 *   - `unsatisfiable` — well-formed but out of bounds; serve 416 with
 *                       `Content-Range: bytes *\/size` (RFC 7233 §4.4).
 */
type RangeResult =
  | { kind: 'full' }
  | { kind: 'range'; start: number; end: number }
  | { kind: 'unsatisfiable' };

/**
 * Parse a single-range `Range: bytes=a-b` header against a known total
 * size. Only the single forms the takeout download needs are honoured:
 *   `bytes=a-b`  → [a, b]   (`b` clamped to size-1 if it overshoots)
 *   `bytes=a-`   → [a, size-1]
 *   `bytes=-n`   → last n bytes
 * A first-byte-pos at/beyond the size, or a zero-length suffix, is
 * `unsatisfiable` (416). An unrecognised / reversed / non-integer spec is
 * ignored (`full`, 200) per RFC 7233.
 */
function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return { kind: 'full' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { kind: 'full' };
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return { kind: 'full' };

  let start: number;
  let end: number;
  if (rawStart === '') {
    // Suffix range: the last `rawEnd` bytes. A zero-length suffix is unsatisfiable.
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix)) return { kind: 'full' };
    if (suffix <= 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    if (!Number.isInteger(start)) return { kind: 'full' };
    if (rawEnd === '') {
      end = size - 1;
    } else {
      end = Number(rawEnd);
      if (!Number.isInteger(end)) return { kind: 'full' };
      if (end < start) return { kind: 'full' }; // reversed spec → ignore
      if (end >= size) end = size - 1; // clamp last-byte-pos to the representation length
    }
  }
  // first-byte-pos at or beyond the representation length → 416.
  if (start >= size || end < start) return { kind: 'unsatisfiable' };
  return { kind: 'range', start, end };
}

export function exportJobRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const authenticate = createAuthMiddleware(db);
    const jobs = new DataExchangeJobService(db);
    const env = getEnv();
    // Storage client construction mirrors the data-exchange routes:
    // env-derived endpoints, no key prefix (the per-fork test prefix is
    // applied only on the start.ts boot clients, never on the route-layer
    // clients that speak bare logical keys — the same convention the
    // attachment + data-exchange routes follow). The `?? ''` collapses
    // satisfy tsc; the boot probes refuse to start without these populated.
    const storage = createStorageClient({
      endpoint: env.STORAGE_ENDPOINT!,
      publicEndpoint: env.STORAGE_PUBLIC_ENDPOINT,
      bucket: env.STORAGE_BUCKET,
      accessKey: env.STORAGE_ACCESS_KEY!,
      secretKey: env.STORAGE_SECRET_KEY!,
      region: env.STORAGE_REGION,
    });

    app.addHook('preHandler', authenticate);

    // ---------------------------------------------------------------
    // POST /api/export-jobs — create + async build.
    // ---------------------------------------------------------------
    app.post(
      '/api/export-jobs',
      { preHandler: requirePermission('data:export') },
      async (request, reply) => {
        // One active per kind (AC-331). A prior ready/failed job does not
        // block — `activeOfKind` matches only pending/running.
        const active = await jobs.activeOfKind('export');
        if (active) {
          throw exportJobActive(active.id);
        }

        // Sweep prior staged artifacts of this kind BEFORE minting the new job.
        // A prior ready job's staged file lingers on disk until the 24h TTL
        // reaper, so back-to-back exports accumulate plaintext archives.
        // Order: sweep BEFORE create so the new job's id is never in the list.
        const priorStaged = await jobs.priorStagedOfKind('export');
        for (const prior of priorStaged) {
          await sweepStagedArtifact(db, prior, request.log);
        }
        if (priorStaged.length > 0) {
          request.log.info(
            {
              event: 'takeout-pre-sweep',
              kind: 'export',
              swept_count: priorStaged.length,
              swept_ids: priorStaged.map((j) => j.id),
            },
            'takeout-pre-sweep',
          );
        }

        const job = await jobs.create('export', request.user!.id);

        // Fire-and-forget the build — the request returns 201 with the
        // pending row immediately (api.md §14.2.4 "Export job — build and
        // lifecycle": the build runs asynchronously; the create call has
        // already returned 2xx by the time processing runs). `request.log`
        // outlives the request for the background write (Fastify's logger
        // is process-scoped); the runner catches every fault internally
        // (it records `failed` on the row, never rejects).
        void runExportBuild({
          db,
          jobs,
          storage,
          caller: request.user!,
          jobId: job.id,
          logger: request.log,
          binaryAgeRecipient: env.BINARY_AGE_RECIPIENT ?? '',
          binaryAgeIdentityPath: env.BINARY_AGE_IDENTITY_PATH,
          stagingDir: env.TAKEOUT_STAGING_DIR,
        });

        // When prior staged artifacts were swept, advertise the count on the
        // response so the caller can observe it (e.g. in tests / logging).
        // Omit the header entirely when count is 0 — present only when
        // something was actually discarded.
        if (priorStaged.length > 0) {
          reply.header('X-Discarded-Prior-Staged', String(priorStaged.length));
        }
        return reply.code(201).send(job);
      },
    );

    // ---------------------------------------------------------------
    // GET /api/export-jobs — latest export job, or null.
    // ---------------------------------------------------------------
    app.get(
      '/api/export-jobs',
      { preHandler: requirePermission('data:export') },
      async (_request, reply) => {
        const job = await jobs.latest('export');
        return reply.code(200).send({ job });
      },
    );

    // ---------------------------------------------------------------
    // GET /api/export-jobs/:id — status poll.
    // ---------------------------------------------------------------
    app.get(
      '/api/export-jobs/:id',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: requirePermission('data:export'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const job = await jobs.get(id);
        if (!job) throw notFound(STRINGS.entities.resource);
        return reply.code(200).send(job);
      },
    );

    // ---------------------------------------------------------------
    // GET /api/export-jobs/:id/download — Range-capable archive stream.
    // ---------------------------------------------------------------
    app.get(
      '/api/export-jobs/:id/download',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: requirePermission('data:export'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const job = await jobs.get(id);
        if (!job) throw notFound(STRINGS.entities.resource);
        // Not ready → 409 (the job exists; the artifact is not built yet).
        if (job.status !== 'ready') throw exportJobNotReady();
        // Ready but the staged artifact is gone (reaper swept it, or the
        // ref was never set) → 404. The row persists as metadata, so this
        // is a NOT_FOUND on the artifact, not on the job.
        if (!job.archiveRef) throw notFound(STRINGS.entities.resource);

        let size: number;
        try {
          const stats = await stat(job.archiveRef);
          size = stats.size;
        } catch {
          // File missing on disk despite a non-null ref (reaped between
          // the row read and the stat, or a partial sweep) → 404.
          throw notFound(STRINGS.entities.resource);
        }

        const range = parseRange(request.headers.range, size);
        if (range.kind === 'unsatisfiable') {
          // RFC 7233 §4.4 — 416 carries the total size so the client can
          // re-issue a satisfiable range.
          return reply
            .code(416)
            .header('Content-Range', `bytes */${size}`)
            .header('Accept-Ranges', 'bytes')
            .send();
        }
        if (range.kind === 'range') {
          const length = range.end - range.start + 1;
          return reply
            .code(206)
            .header('Content-Type', 'application/zip')
            .header('Accept-Ranges', 'bytes')
            .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
            .header('Content-Length', String(length))
            .send(createReadStream(job.archiveRef, { start: range.start, end: range.end }));
        }

        return reply
          .code(200)
          .header('Content-Type', 'application/zip')
          .header('Accept-Ranges', 'bytes')
          .header('Content-Length', String(size))
          .send(createReadStream(job.archiveRef));
      },
    );
  };
}
