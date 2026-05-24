/**
 * API integration tests — server-side export JOB lifecycle (TDD red).
 *
 * Drives the operator-facing full-account takeout EXPORT job defined in
 * api.md §14.2.4 ("Export job") + data-model.md §5.18, pinning:
 *
 *   - AC-322 / AT-136 — create + status + latest endpoints, perm gate,
 *     async pending → running → ready advance.
 *   - AC-324 / AT-138 — Range-capable download, 409 EXPORT_JOB_NOT_READY
 *     before ready, 404 after the staging reaper sweeps the artifact.
 *   - AC-331 / AT-145 — one active export job per kind (409
 *     EXPORT_JOB_ACTIVE carrying the active id); a prior ready/failed
 *     job does not block (export half only — import endpoints unbuilt).
 *   - AC-332 / AT-146 — exactly one audit_log row at the terminal
 *     transition, entity_type='data_import'; progress writes none.
 *   - AC-333 / AT-147 — every lifecycle transition emits a
 *     data_exchange_job_changed SSE frame; progress is throttled; the
 *     frame is invalidation-only (no job payload in the body).
 *   - AC-334 / AT-148 — a ready artifact aged past the takeout staging
 *     TTL is swept by the scheduled reaper; the download then 404s.
 *
 * RED-STATE EXPECTATION: none of `/api/export-jobs*` is registered yet
 * (app.ts wires only the text-leg `/api/export` + `/api/import`), and no
 * runner / reaper module exists. Every arm therefore fails — create /
 * status / latest hit the ROUTE_NOT_FOUND not-found handler (404), the
 * ready-dependent arms time out at the poll (no runner advances the job),
 * and the reaper arm fails at the dynamic `import()` of the absent
 * module. The assertions encode the FINAL intended contract, so they go
 * green once the feature lands — they are not pinned to the 404.
 *
 * The archive-content + per-row-skip arms (AC-323 / AC-325) live in the
 * sibling file `data-exchange-export-archive.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

import { startApp, stopApp, getApp, login, authGet, authPost } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase, type Database } from '../db/connection.js';
import {
  createStorageClient,
  type StorageClient,
  type AttachmentStorageClient,
} from '../storage/client.js';
import { getEnv } from '../config/env.js';
import { DATA_EXCHANGE_JOB_CHANGED } from '../../config/sseEvents.js';
import {
  reapAbandonedDataExchangeJobs,
  BOOT_REAP_DETAIL,
} from '../services/data-exchange-boot-reaper.js';
import { runExportBuild } from '../services/takeout-export-runner.js';
import { DataExchangeJobService } from '../services/DataExchangeJobService.js';
import type { AuthUser } from '../middleware/auth.js';

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../db/migrations',
);

// ---------------------------------------------------------------------
// Job row wire shape — camelCase per data-model.md §5.18. Kept local so
// the assertions read tightly without re-pulling the domain type.
// ---------------------------------------------------------------------
interface ExportJobRow {
  id: string;
  kind: 'export' | 'import';
  status: 'pending' | 'running' | 'ready' | 'failed';
  filesTotal: number;
  filesDone: number;
  bytesTotal: number;
  bytesDone: number;
  currentItem: string | null;
  archiveRef: string | null;
  errorDetail: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

// ---------------------------------------------------------------------
// SSE bus fake — mirrors data-exchange-job-service.test.ts. Subscribe a
// fake connection, then count `event: <NAME>\n` frames anchored on the
// catalog constant so a sibling event name cannot collide.
// ---------------------------------------------------------------------
interface SseConnection {
  write(chunk: string): void;
}
interface SseBusModule {
  subscribe(c: SseConnection): void;
  unsubscribe(c: SseConnection): void;
}
interface SubscribedFake extends SseConnection {
  chunks: string[];
}

async function loadBus(): Promise<SseBusModule> {
  const p = '../sse/bus.js';
  return (await import(/* @vite-ignore */ p)) as unknown as SseBusModule;
}

function subscribeFake(bus: SseBusModule): SubscribedFake {
  const conn: SubscribedFake = {
    chunks: [],
    write(chunk: string): void {
      this.chunks.push(chunk);
    },
  };
  bus.subscribe(conn);
  return conn;
}

function countJobChanged(conn: SubscribedFake): number {
  const matches = conn.chunks
    .join('')
    .match(new RegExp(`event: ${DATA_EXCHANGE_JOB_CHANGED}\\n`, 'g'));
  return matches ? matches.length : 0;
}

// ---------------------------------------------------------------------
// Takeout staging reaper — contract surface (AC-334 / data-model §6.15).
// Resolved lazily via dynamic import (parity with the orphan/hidden reaper
// tests' `runAttachmentOrphanReaper` resolver shape) so the FILE loads even
// when only a subset of arms run. The module ships with this export job and
// sweeps `ready` export artifacts; the import leg widens it to `import`
// uploads (see data-exchange-import-archive.test.ts).
//
// Shape parallels the orphan / hidden reapers: invoked directly (no
// scheduler plumbing) with an injectable `now`, a TTL, a storage client
// for the VPS-local staging path, and a structured logger. `ttlMinutes`
// matches the sibling ATTACHMENT_*_REAPER_TTL_MINUTES env convention
// (default 1440 = the §12.2 24h).
// ---------------------------------------------------------------------
type ReaperLogFn = (ctx: Record<string, unknown>, event: string) => void;

interface TakeoutStagingReaperOptions {
  db: Database;
  storage: StorageClient;
  logger: { info: ReaperLogFn; error: ReaperLogFn };
  ttlMinutes: number;
  now?: Date;
}

async function runTakeoutStagingReaper(opts: TakeoutStagingReaperOptions): Promise<void> {
  // Specifier held in a variable (not a string literal) so `tsc` cannot
  // statically resolve — and thus cannot error on — a module that does
  // not exist yet. Same indirection data-exchange-job-service.test.ts
  // uses for the SSE bus import. The reaper arm fails at this `import()`
  // (MODULE_NOT_FOUND) until the implementation lands, then resolves.
  const p = '../services/takeout-staging-reaper.js';
  const mod = (await import(/* @vite-ignore */ p)) as {
    runTakeoutStagingReaper: (opts: TakeoutStagingReaperOptions) => Promise<void>;
  };
  return mod.runTakeoutStagingReaper(opts);
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
const POLL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

/**
 * Poll `GET /api/export-jobs/:id` until the job reaches a terminal
 * status (`ready` or `failed`), then return the row. Fails clearly on
 * timeout so the red run (no runner advancing the job) reports "never
 * reached terminal" rather than hanging.
 */
async function pollUntilTerminal(token: string, jobId: string): Promise<ExportJobRow> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last: ExportJobRow | null = null;
  while (Date.now() < deadline) {
    const res = await authGet(token, `/api/export-jobs/${jobId}`);
    expect(res.statusCode).toBe(200);
    last = res.json() as ExportJobRow;
    if (last.status === 'ready' || last.status === 'failed') return last;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `export job ${jobId} did not reach a terminal status within ${POLL_TIMEOUT_MS}ms ` +
      `(last status: ${last?.status ?? 'unknown'})`,
  );
}

/** Create an export job and assert the 201 + pending shape; return the row. */
async function createExportJob(token: string): Promise<ExportJobRow> {
  const res = await authPost(token, '/api/export-jobs');
  expect(res.statusCode).toBe(201);
  return res.json() as ExportJobRow;
}

function storageClient(): StorageClient {
  const env = getEnv();
  return createStorageClient({
    endpoint: env.STORAGE_ENDPOINT!,
    bucket: env.STORAGE_BUCKET,
    accessKey: env.STORAGE_ACCESS_KEY!,
    secretKey: env.STORAGE_SECRET_KEY!,
  });
}

/** Count audit_log rows tagged with the synthetic deployment-level type. */
async function countDataImportAuditRows(db: Database): Promise<number> {
  const res = await db.execute(
    sql`SELECT COUNT(*)::int AS c FROM audit_log WHERE entity_type = 'data_import'`,
  );
  return (res.rows[0] as { c: number }).c;
}

describe('Export job — lifecycle, perms, download, audit, realtime, reaper', () => {
  let db: Database;
  let pool: pg.Pool;
  let ownerToken: string;

  beforeAll(async () => {
    await startApp();
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    await pool.query('SELECT 1');
    await migrate(db, { migrationsFolder });
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    await stopApp();
    await pool.end();
  });

  beforeEach(async () => {
    // Each arm starts with no job rows (so one-active-per-kind and
    // latest-is-null are deterministic) and no attachments (the seed
    // creates none; only the throttle arm seeds its own), so the build's
    // file set is known per arm.
    await db.execute(sql`DELETE FROM data_exchange_job`);
    await db.execute(sql`DELETE FROM attachments`);
  });

  // -------------------------------------------------------------------
  // AC-322 / AT-136 — create, status, latest; permission gate.
  // -------------------------------------------------------------------
  describe('AC-322: create + status + latest (data:export gated)', () => {
    it('POST /api/export-jobs unauthenticated → 401', async () => {
      const res = await getApp().inject({ method: 'POST', url: '/api/export-jobs' });
      expect(res.statusCode).toBe(401);
    });

    it('POST /api/export-jobs without data:export → 403 NOT_PERMITTED', async () => {
      // arbeiter1 (worker) holds neither data:export nor data:restore.
      const workerToken = await login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD);
      const res = await authPost(workerToken, '/api/export-jobs');
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('POST /api/export-jobs with data:export → 201 pending row, zeroed counters', async () => {
      const job = await createExportJob(ownerToken);
      expect(job.kind).toBe('export');
      expect(job.status).toBe('pending');
      expect(job.filesDone).toBe(0);
      expect(job.bytesDone).toBe(0);
      expect(job.archiveRef).toBeNull();
      expect(job.finishedAt).toBeNull();
      expect(typeof job.id).toBe('string');
    });

    it('the build advances pending → running → ready asynchronously', async () => {
      const created = await createExportJob(ownerToken);
      const terminal = await pollUntilTerminal(ownerToken, created.id);
      // A fresh seed has no `status='ready'` attachments to decrypt and
      // the binary identity is loaded per-fork, so the happy-path build
      // completes — it reaches `ready`, not `failed`.
      expect(terminal.status).toBe('ready');
      expect(terminal.startedAt).not.toBeNull();
      expect(terminal.finishedAt).not.toBeNull();
      expect(terminal.archiveRef).not.toBeNull();
    });

    it('GET /api/export-jobs/:id returns the row; unknown id → 404 NOT_FOUND', async () => {
      const created = await createExportJob(ownerToken);

      const found = await authGet(ownerToken, `/api/export-jobs/${created.id}`);
      expect(found.statusCode).toBe(200);
      expect((found.json() as ExportJobRow).id).toBe(created.id);

      const missing = await authGet(ownerToken, `/api/export-jobs/${crypto.randomUUID()}`);
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe('NOT_FOUND');
    });

    it('GET /api/export-jobs returns { job: null } on a fresh deployment', async () => {
      const res = await authGet(ownerToken, '/api/export-jobs');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ job: null });
    });

    it('GET /api/export-jobs returns the latest job after a create', async () => {
      const created = await createExportJob(ownerToken);
      const res = await authGet(ownerToken, '/api/export-jobs');
      expect(res.statusCode).toBe(200);
      const body = res.json() as { job: ExportJobRow | null };
      expect(body.job?.id).toBe(created.id);
    });

    it('GET /api/export-jobs without data:export → 403 NOT_PERMITTED', async () => {
      const bookkeeperToken = await login(SEED_USERS.bookkeeper.username, SEED_DEFAULT_PASSWORD);
      const res = await authGet(bookkeeperToken, '/api/export-jobs');
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });
  });

  // -------------------------------------------------------------------
  // AC-324 / AT-138 — download: not-ready 409, ready stream, Range 206,
  // perm gate. (The post-reap 404 arm lives under AC-334 below.)
  // -------------------------------------------------------------------
  describe('AC-324: Range-capable download', () => {
    it('download of a not-yet-ready job → 409 EXPORT_JOB_NOT_READY', async () => {
      // A freshly-created job is `pending`; downloading before the build
      // finishes is the documented 409 (not a 404 — the job exists).
      const created = await createExportJob(ownerToken);
      const res = await authGet(ownerToken, `/api/export-jobs/${created.id}/download`);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('EXPORT_JOB_NOT_READY');
    });

    it('download of a ready job streams application/zip', async () => {
      const created = await createExportJob(ownerToken);
      const terminal = await pollUntilTerminal(ownerToken, created.id);
      expect(terminal.status).toBe('ready');

      const res = await authGet(ownerToken, `/api/export-jobs/${created.id}/download`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/zip');
      expect((res.rawPayload as Buffer).length).toBeGreaterThan(0);
    });

    it('a ranged GET returns 206 Partial Content with exactly the requested bytes', async () => {
      const created = await createExportJob(ownerToken);
      await pollUntilTerminal(ownerToken, created.id);

      // Read the whole artifact first to know its length and to compare
      // the slice byte-for-byte.
      const full = await authGet(ownerToken, `/api/export-jobs/${created.id}/download`);
      expect(full.statusCode).toBe(200);
      const fullBytes = full.rawPayload as Buffer;
      expect(fullBytes.length).toBeGreaterThan(10);

      // Request a strict interior slice [start, end] inclusive.
      const start = 2;
      const end = 7; // inclusive → 6 bytes
      const ranged = await getApp().inject({
        method: 'GET',
        url: `/api/export-jobs/${created.id}/download`,
        headers: {
          cookie: `session=${ownerToken}`,
          range: `bytes=${start}-${end}`,
        },
      });

      expect(ranged.statusCode).toBe(206);
      const partial = ranged.rawPayload as Buffer;
      expect(partial.length).toBe(end - start + 1);
      // The returned bytes are exactly the corresponding window of the
      // full artifact — a real Range slice, not a re-sent whole body.
      expect(Buffer.compare(partial, fullBytes.subarray(start, end + 1))).toBe(0);
    });

    it('a well-formed but unsatisfiable range → 416 with Content-Range bytes */size', async () => {
      const created = await createExportJob(ownerToken);
      await pollUntilTerminal(ownerToken, created.id);

      const full = await authGet(ownerToken, `/api/export-jobs/${created.id}/download`);
      const size = (full.rawPayload as Buffer).length;
      expect(size).toBeGreaterThan(0);

      // first-byte-pos beyond the artifact → 416 (RFC 7233 §4.4), not a
      // silent full 200. The header advertises the true size so the client
      // can re-issue a satisfiable range.
      const ranged = await getApp().inject({
        method: 'GET',
        url: `/api/export-jobs/${created.id}/download`,
        headers: { cookie: `session=${ownerToken}`, range: `bytes=${size + 100}-${size + 200}` },
      });
      expect(ranged.statusCode).toBe(416);
      expect(ranged.headers['content-range']).toBe(`bytes */${size}`);
    });

    it('download without data:export → 403 NOT_PERMITTED', async () => {
      const created = await createExportJob(ownerToken);
      const workerToken = await login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD);
      const res = await authGet(workerToken, `/api/export-jobs/${created.id}/download`);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });
  });

  // -------------------------------------------------------------------
  // AC-331 / AT-145 — one active export job per kind (export half only).
  // -------------------------------------------------------------------
  describe('AC-331: one active export job per kind', () => {
    it('a second create while one is pending/running → 409 EXPORT_JOB_ACTIVE carrying the active id', async () => {
      const first = await createExportJob(ownerToken);

      const second = await authPost(ownerToken, '/api/export-jobs');
      expect(second.statusCode).toBe(409);
      const body = second.json();
      expect(body.code).toBe('EXPORT_JOB_ACTIVE');
      // The response carries the active job's id so the UI re-attaches
      // rather than starting a second build. The id is surfaced on the
      // error body; assert it equals the first job regardless of the
      // exact envelope key the route picks.
      expect(JSON.stringify(body)).toContain(first.id);
    });

    it('a fresh create succeeds after the prior job reaches a terminal state', async () => {
      const first = await createExportJob(ownerToken);
      const terminal = await pollUntilTerminal(ownerToken, first.id);
      expect(['ready', 'failed']).toContain(terminal.status);

      // A prior ready/failed job does NOT block — the new build supersedes it.
      const second = await authPost(ownerToken, '/api/export-jobs');
      expect(second.statusCode).toBe(201);
      const secondJob = second.json() as ExportJobRow;
      expect(secondJob.id).not.toBe(first.id);
      expect(secondJob.status).toBe('pending');
    });
  });

  // -------------------------------------------------------------------
  // AC-332 / AT-146 — exactly one audit_log row at the terminal
  // transition; progress updates write none.
  // -------------------------------------------------------------------
  describe('AC-332: single audit row at the terminal transition', () => {
    it('a finished export job writes exactly one data_import audit row', async () => {
      const before = await countDataImportAuditRows(db);

      const created = await createExportJob(ownerToken);
      await pollUntilTerminal(ownerToken, created.id);

      const after = await countDataImportAuditRows(db);
      // Exactly one row regardless of how many progress updates ran in
      // between — progress mutations do not route through the
      // single-write-path helper (data-model §5.18).
      expect(after - before).toBe(1);
    });

    it('the terminal audit row carries entity_type = data_import', async () => {
      const created = await createExportJob(ownerToken);
      await pollUntilTerminal(ownerToken, created.id);

      const res = await db.execute(
        sql`SELECT entity_type FROM audit_log
            WHERE entity_type = 'data_import'
            ORDER BY created_at DESC
            LIMIT 1`,
      );
      expect(res.rows.length).toBe(1);
      expect((res.rows[0] as { entity_type: string }).entity_type).toBe('data_import');
    });
  });

  // -------------------------------------------------------------------
  // AC-333 / AT-147 — realtime: lifecycle transitions emit a frame,
  // progress is throttled, the frame is invalidation-only.
  // -------------------------------------------------------------------
  describe('AC-333: realtime invalidation', () => {
    it('every lifecycle transition emits a data_exchange_job_changed frame', async () => {
      const bus = await loadBus();
      const conn = subscribeFake(bus);
      try {
        const created = await createExportJob(ownerToken);
        await pollUntilTerminal(ownerToken, created.id);

        // pending (create) → running → ready is three transitions; the
        // job emits at least one frame per transition. A looser `>= 2`
        // would pass even if a transition silently dropped its frame, so
        // pin the full lifecycle floor.
        expect(countJobChanged(conn)).toBeGreaterThanOrEqual(3);
      } finally {
        bus.unsubscribe(conn);
      }
    });

    it('progress emissions are throttled — far fewer frames than files processed', async () => {
      // Seed many ready attachments so the build streams many files. If
      // progress emitted one frame per file the count would be ~N; the
      // throttle keeps it well below. Assert a strict inequality against
      // the file count so an un-throttled implementation fails.
      const fileCount = await seedManyReadyAttachments(40);

      const bus = await loadBus();
      const conn = subscribeFake(bus);
      try {
        const created = await createExportJob(ownerToken);
        await pollUntilTerminal(ownerToken, created.id);
        // Lifecycle frames (3) + a throttled subset of progress frames.
        // Far fewer than one-per-file: assert strictly below the file count.
        expect(countJobChanged(conn)).toBeLessThan(fileCount);
      } finally {
        bus.unsubscribe(conn);
      }
    });

    it('the frame body is invalidation-only — carries no job payload', async () => {
      const bus = await loadBus();
      const conn = subscribeFake(bus);
      try {
        const created = await createExportJob(ownerToken);
        await pollUntilTerminal(ownerToken, created.id);

        // Isolate the data lines of this event's frames. A correct
        // invalidation-only frame carries no serialized job — so the
        // job id never appears in any `data:` line.
        const joined = conn.chunks.join('');
        expect(joined).toContain(`event: ${DATA_EXCHANGE_JOB_CHANGED}\n`);
        const dataLines = joined.split('\n').filter((line) => line.startsWith('data:'));
        for (const line of dataLines) {
          expect(line).not.toContain(created.id);
          expect(line).not.toContain('"status"');
          expect(line).not.toContain('archiveRef');
        }
      } finally {
        bus.unsubscribe(conn);
      }
    });
  });

  // -------------------------------------------------------------------
  // AC-334 / AT-148 — staging reaper sweeps an aged ready artifact; the
  // download then 404s.
  //
  // TTL injection: §12.2 specifies the takeout staging TTL as a [C] value
  // (24h default) exactly like the orphan/hidden reaper TTLs — whose env
  // var (ATTACHMENT_*_REAPER_TTL_MINUTES) lives in config/env.ts, not in
  // §12.2 prose. The takeout knob (TAKEOUT_STAGING_TTL_MINUTES, default
  // 1440) lands in env.ts at implementation. This arm injects ttlMinutes
  // directly — the shape attachments-reaper.test.ts uses — pinning the
  // OBSERVABLE contract (aged artifact swept → archiveRef nulled →
  // download 404s), not the env wiring.
  // -------------------------------------------------------------------
  describe('AC-334: staging reaper sweeps the aged ready artifact', () => {
    it('a ready artifact older than the TTL is swept and the download then 404s', async () => {
      const ttlMinutes = 1440; // §12.2 default (24h) in the sibling _MINUTES unit

      const created = await createExportJob(ownerToken);
      const terminal = await pollUntilTerminal(ownerToken, created.id);
      expect(terminal.status).toBe('ready');

      // The download is live before the sweep.
      const before = await authGet(ownerToken, `/api/export-jobs/${created.id}/download`);
      expect(before.statusCode).toBe(200);

      // Backdate the job's finishedAt well past the TTL so the reaper's
      // age predicate selects it, then run the reaper with `now` = real
      // time. (finishedAt is the natural staging-clock anchor for a
      // `ready` export artifact.)
      await db.execute(sql`
        UPDATE data_exchange_job
        SET finished_at = ${new Date(Date.now() - (ttlMinutes + 60) * 60 * 1000).toISOString()}
        WHERE id = ${created.id}
      `);

      await runTakeoutStagingReaper({
        db,
        storage: storageClient(),
        logger: { info: vi.fn(), error: vi.fn() },
        ttlMinutes,
        now: new Date(),
      });

      // Reaper deletes the staged file and nulls archiveRef; the row
      // persists (operational metadata) so the download resolves to 404.
      const after = await authGet(ownerToken, `/api/export-jobs/${created.id}/download`);
      expect(after.statusCode).toBe(404);
      expect(after.json().code).toBe('NOT_FOUND');

      const row = await authGet(ownerToken, `/api/export-jobs/${created.id}`);
      expect(row.statusCode).toBe(200);
      expect((row.json() as ExportJobRow).archiveRef).toBeNull();
    });
  });

  // -------------------------------------------------------------------
  // Staged-archive confidentiality — the zip holds decrypted plaintext of
  // all business data + every passwordHash, so it must not be readable by
  // other UIDs on the VPS (ADR-0024 trust radius). File 0600 is the
  // load-bearing control (content), dir 0700 hides the in-flight job ids.
  // -------------------------------------------------------------------
  describe('staged archive permissions (0600 file / 0700 dir)', () => {
    it('writes the staged zip without group/other access, in a private dir', async () => {
      const created = await createExportJob(ownerToken);
      const terminal = await pollUntilTerminal(ownerToken, created.id);
      expect(terminal.status).toBe('ready');
      expect(terminal.archiveRef).not.toBeNull();

      const fileStat = await stat(terminal.archiveRef!);
      // No read/write/exec for group or other on the plaintext archive.
      expect(fileStat.mode & 0o077).toBe(0);
      expect(fileStat.mode & 0o777).toBe(0o600);

      const dirStat = await stat(path.dirname(terminal.archiveRef!));
      expect(dirStat.mode & 0o077).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // Boot reconciliation (data-model.md §5.18) — a restart abandons any
  // in-flight job; reap pending/running → failed (freeing the
  // one-active-per-kind slot) and delete the partial staged archive.
  // -------------------------------------------------------------------
  describe('boot reconciliation of abandoned jobs', () => {
    it('reaps pending/running → failed + deletes their staged files; terminal rows untouched', async () => {
      const stagingDir = getEnv().TAKEOUT_STAGING_DIR;
      const ids = {
        pending: crypto.randomUUID(),
        running: crypto.randomUUID(),
        ready: crypto.randomUUID(),
        failed: crypto.randomUUID(),
      };
      const pendingPath = path.join(stagingDir, `${ids.pending}.zip`);
      const runningPath = path.join(stagingDir, `${ids.running}.zip`);
      const readyPath = path.join(stagingDir, `${ids.ready}.zip`);
      // A crash can leave a partial archive for an in-flight job (archive_ref
      // still null — markReady never ran); the ready job has a complete one.
      await writeFile(pendingPath, 'partial-pending');
      await writeFile(runningPath, 'partial-running');
      await writeFile(readyPath, 'complete-ready');

      await db.execute(sql`
        INSERT INTO data_exchange_job (id, kind, status, archive_ref) VALUES
          (${ids.pending}, 'export', 'pending', NULL),
          (${ids.running}, 'export', 'running', NULL),
          (${ids.ready},   'export', 'ready',   ${readyPath}),
          (${ids.failed},  'import', 'failed',  NULL)
      `);

      const reaped = await reapAbandonedDataExchangeJobs({
        db,
        stagingDir,
        logger: { info: vi.fn(), error: vi.fn() },
      });
      expect(reaped).toBe(2);

      const res = await db.execute(
        sql`SELECT id, status, error_detail, finished_at FROM data_exchange_job`,
      );
      const byId = new Map(
        (
          res.rows as {
            id: string;
            status: string;
            error_detail: string | null;
            finished_at: string | null;
          }[]
        ).map((r) => [r.id, r]),
      );
      // pending + running reaped to failed, stamped + reasoned.
      for (const id of [ids.pending, ids.running]) {
        expect(byId.get(id)!.status).toBe('failed');
        expect(byId.get(id)!.error_detail).toBe(BOOT_REAP_DETAIL);
        expect(byId.get(id)!.finished_at).not.toBeNull();
      }
      // terminal rows untouched (the pre-existing failed keeps its null detail).
      expect(byId.get(ids.ready)!.status).toBe('ready');
      expect(byId.get(ids.failed)!.status).toBe('failed');
      expect(byId.get(ids.failed)!.error_detail).toBeNull();

      // Partial files of the reaped jobs are gone; the ready artifact survives.
      await expect(stat(pendingPath)).rejects.toThrow();
      await expect(stat(runningPath)).rejects.toThrow();
      expect((await stat(readyPath)).isFile()).toBe(true);

      // The slot is free: a fresh create succeeds (no 409 from the stale row).
      const created = await authPost(ownerToken, '/api/export-jobs');
      expect(created.statusCode).toBe(201);
    });

    it('is a no-op (returns 0) when nothing is abandoned', async () => {
      const reaped = await reapAbandonedDataExchangeJobs({
        db,
        stagingDir: getEnv().TAKEOUT_STAGING_DIR,
        logger: { info: vi.fn(), error: vi.fn() },
      });
      expect(reaped).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // Wholesale build-failure handling — a write-side fault must FAIL the
  // job (no hang, no process crash) so the one-active-per-kind slot frees
  // and the partial staged plaintext is cleaned. Regression guard for the
  // archiver finalize/pipeline ordering: awaiting finalize() (not the
  // pipeline) hung forever on a write error and leaked an unhandled
  // rejection.
  // -------------------------------------------------------------------
  describe('wholesale build failure (write fault)', () => {
    it('marks the job failed within bounded time and does not hang', async () => {
      const jobs = new DataExchangeJobService(db);
      const job = await jobs.create('export', null);

      // Pre-create a DIRECTORY at the deterministic staged path so the
      // build's createWriteStream fails on open — the write-side fault that
      // previously hung the build.
      const stagingDir = getEnv().TAKEOUT_STAGING_DIR;
      const archivePath = path.join(stagingDir, `${job.id}.zip`);
      await mkdir(archivePath, { recursive: true });

      const ownerRow = (
        await db.execute(
          sql`SELECT id, display_name FROM users WHERE username = ${SEED_USERS.owner.username} LIMIT 1`,
        )
      ).rows[0] as { id: string; display_name: string };
      const caller: AuthUser = {
        id: ownerRow.id,
        username: SEED_USERS.owner.username,
        displayName: ownerRow.display_name,
        roles: ['owner'],
        email: null,
        themePreference: 'system',
        pushMuted: false,
      };

      try {
        // runExportBuild never rejects; it must REACH a terminal state.
        // Race a timeout so a hang regression fails loudly, not stalls.
        await Promise.race([
          runExportBuild({
            db,
            jobs,
            // Unused here (no ready attachments to decrypt); the wider
            // StorageClient helper type needs the cast to the route's
            // AttachmentStorageClient param.
            storage: storageClient() as AttachmentStorageClient,
            caller,
            jobId: job.id,
            logger: { info: vi.fn(), error: vi.fn() },
            binaryAgeRecipient: process.env.BINARY_AGE_RECIPIENT ?? '',
            binaryAgeIdentityPath: process.env.BINARY_AGE_IDENTITY_PATH ?? '',
            stagingDir,
          }),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('runExportBuild hung — never reached terminal')),
              8000,
            ),
          ),
        ]);

        const after = await jobs.get(job.id);
        expect(after?.status).toBe('failed');
        expect(after?.errorDetail).toBeTruthy();
      } finally {
        await rm(archivePath, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------
  // Local seed helper (throttle arm). Inserts N `status='ready'`
  // attachment rows against a seeded project with REAL backing
  // ciphertext + a real wrapped DEK so the build streams each file into
  // the archive (the throttle arm needs the build to actually process
  // many files). Raw-SQL attachment seeding is allowlisted under
  // __tests__/ per the AC-179 architecture check.
  //
  // Inlined rather than imported from data-exchange-export-all.ts (that
  // file is scheduled for retirement). The crypto wire shape mirrors
  // src/server/services/invoice/payloadCrypto.ts: nonce(12)||ct||tag(16).
  // -------------------------------------------------------------------
  async function seedManyReadyAttachments(count: number): Promise<number> {
    const { readFileSync } = await import('node:fs');
    const { KeyEnvelopeService } = await import('../services/KeyEnvelopeService.js');

    const recipient = process.env.BINARY_AGE_RECIPIENT;
    const identityPath = process.env.BINARY_AGE_IDENTITY_PATH;
    if (!recipient || !identityPath) {
      throw new Error(
        'seedManyReadyAttachments: BINARY_AGE_RECIPIENT / BINARY_AGE_IDENTITY_PATH unset — ' +
          'per-fork identity is provisioned in src/test/integration-setup.ts',
      );
    }
    const identity = readFileSync(identityPath, 'utf-8').trim();

    const projectRes = await db.execute(sql`SELECT id FROM projects LIMIT 1`);
    const projectId = (projectRes.rows[0] as { id: string }).id;

    const storage = storageClient();
    const svc = new KeyEnvelopeService({ recipient, identity });
    try {
      for (let i = 0; i < count; i++) {
        const id = crypto.randomUUID();
        const plaintext = Buffer.from(`throttle-file-${i}-${id}`);
        const dek = crypto.randomBytes(32);
        const nonce = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', dek, nonce);
        const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const tag = cipher.getAuthTag();
        const ciphertext = Buffer.concat([nonce, body, tag]);

        const originalKey = `attachments/${projectId}/${id}.orig`;
        await storage.upload(originalKey, ciphertext, 'application/octet-stream');
        const wrapped = Buffer.from(await svc.wrap(dek)).toString('base64');

        await db.execute(sql`
          INSERT INTO attachments
            (id, project_id, status, kind, label, filename, mime_type, size_bytes,
             ciphertext_size_bytes, original_key, has_thumbnail,
             wrapped_dek, wrapped_dek_version)
          VALUES (${id}, ${projectId}, 'ready', 'binary', 'sonstiges',
                  ${`throttle-${i}.bin`}, 'application/pdf', ${plaintext.length},
                  ${ciphertext.length}, ${originalKey}, FALSE,
                  ${wrapped}, 1)
        `);
      }
    } finally {
      svc.close();
    }
    return count;
  }
});
