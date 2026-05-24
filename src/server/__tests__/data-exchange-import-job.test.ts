/**
 * API integration tests — server-side import JOB lifecycle + resumable
 * upload protocol (TDD red).
 *
 * Drives the operator-facing full-account takeout IMPORT job defined in
 * api.md §14.2.4 ("Import job" table + "Import job — *" / "Jobs — *"
 * design notes) + data-model.md §5.18, pinning the create / upload /
 * status / one-active / audit surface:
 *
 *   - AC-326 / AT-140 — create + resumable (tus-style) upload:
 *     `POST /api/import-jobs` (`Upload-Length` header) → `pending`;
 *     `HEAD :id/archive` → `Upload-Offset` + `Upload-Length`;
 *     `PATCH :id/archive` at the server offset appends + returns the new
 *     offset; a stale-offset PATCH → `409 UPLOAD_OFFSET_CONFLICT`
 *     (offset unchanged — retry-safe); bytes past `Upload-Length` →
 *     `413`; reaching `Upload-Length` transitions `pending → running`.
 *   - AC-329 / AT-143 — override + confirmation phrase UP FRONT: a
 *     non-empty target without `override: true` → `409 TARGET_NOT_EMPTY`;
 *     with `override: true` but a wrong/missing `confirmation_phrase` →
 *     `422 RESTORE_CONFIRMATION_MISMATCH`; both reject at CREATE, before
 *     any upload slot exists; an empty-target create needs neither.
 *   - AC-331 / AT-145 — one active import job per kind: a second
 *     `POST /api/import-jobs` while one is `pending`/`running` →
 *     `409 IMPORT_JOB_ACTIVE` carrying the active id; a prior
 *     `ready`/`failed` import does not block.
 *   - AC-332 / AT-146 — exactly one `data_import` audit row at the
 *     terminal transition; progress writes none.
 *
 * The restore-fidelity / validate-before-wipe / session-invalidation /
 * staging-reaper arms (AC-327 / AC-328 / AC-330 / AC-334) live in the
 * sibling file `data-exchange-import-archive.test.ts` — they need a real
 * roundtrip archive (built by the WORKING export job) and are heavier.
 *
 * STATUS: implemented + green. `routes/import-jobs.ts` is wired in app.ts
 * (`POST`/`GET` `/api/import-jobs`, `GET` `/:id`, `HEAD`/`PATCH`
 * `/:id/archive`). This file pins the live contract: create + the
 * resumable (tus-style) upload protocol, the `data:restore` gate, one
 * active import job per kind, and the single terminal `data_import` audit
 * row.
 *
 * Confirmation phrase [C]: `EXPECTED_RESTORE_PHRASE` ('LOESCHEN') —
 * resolved from src/config/dataExchangeConfig.ts (`RESTORE_CONFIRMATION_PHRASE`)
 * and pinned in src/test/seedAssumptions.ts. The wrong-phrase arm uses a
 * deliberately non-matching literal.
 *
 * Permission gate ([C]-resolved): all import-job endpoints are
 * `data:restore`-gated. Among real seed roles ONLY `owner` holds
 * `data:restore` (src/config/permissions.ts). `office` holds `data:export`
 * but NOT `data:restore` — the strongest negative arm (proves the gate is
 * restore-specific, not "any data permission"); `worker` holds neither.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

import { startApp, stopApp, getApp, login, authGet } from '../../test/api-helpers.js';
import {
  SEED_DEFAULT_PASSWORD,
  SEED_USERS,
  EXPECTED_RESTORE_PHRASE,
} from '../../test/seedAssumptions.js';
import { createDatabase, type Database } from '../db/connection.js';

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../db/migrations',
);

// ---------------------------------------------------------------------
// Job row wire shape — camelCase per data-model.md §5.18. Same shape the
// export-job tests assert; kept local so the assertions read tightly.
// ---------------------------------------------------------------------
interface ImportJobRow {
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

const UPLOAD_OCTET_STREAM = 'application/offset+octet-stream';

const POLL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

/**
 * Poll `GET /api/import-jobs/:id` until the job leaves `pending` (i.e.
 * reaches `running`, `ready`, or `failed`), then return the row. Several
 * arms only need to observe the `pending → running` transition the final
 * chunk triggers; others poll on to a terminal state. Fails clearly on
 * timeout so the red run reports "never advanced" rather than hanging.
 */
async function pollUntilNotPending(token: string, jobId: string): Promise<ImportJobRow> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last: ImportJobRow | null = null;
  while (Date.now() < deadline) {
    const res = await authGet(token, `/api/import-jobs/${jobId}`);
    expect(res.statusCode).toBe(200);
    last = res.json() as ImportJobRow;
    if (last.status !== 'pending') return last;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `import job ${jobId} stayed 'pending' for ${POLL_TIMEOUT_MS}ms — the final chunk ` +
      `did not transition it to 'running' (last status: ${last?.status ?? 'unknown'})`,
  );
}

/** Poll until a terminal status (`ready`/`failed`); used by the audit arm. */
async function pollUntilTerminal(token: string, jobId: string): Promise<ImportJobRow> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last: ImportJobRow | null = null;
  while (Date.now() < deadline) {
    const res = await authGet(token, `/api/import-jobs/${jobId}`);
    expect(res.statusCode).toBe(200);
    last = res.json() as ImportJobRow;
    if (last.status === 'ready' || last.status === 'failed') return last;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `import job ${jobId} did not reach a terminal status within ${POLL_TIMEOUT_MS}ms ` +
      `(last status: ${last?.status ?? 'unknown'})`,
  );
}

// ---------------------------------------------------------------------
// Raw upload-protocol helpers. The resumable upload uses headers
// (Upload-Length / Upload-Offset) + a binary body + a HEAD verb that the
// authGet/authPost helpers don't model, so these drop to
// getApp().inject() with an explicit cookie — the same escape hatch the
// export-job test uses for ranged GETs.
// ---------------------------------------------------------------------

/** `POST /api/import-jobs` with `Upload-Length` + an optional JSON body. */
function createImportJob(
  token: string,
  uploadLength: number,
  body?: { override?: boolean; confirmation_phrase?: string },
) {
  return getApp().inject({
    method: 'POST',
    url: '/api/import-jobs',
    headers: {
      cookie: `session=${token}`,
      'upload-length': String(uploadLength),
      'content-type': 'application/json',
    },
    payload: body ?? {},
  });
}

/** `HEAD :id/archive` — reads the server's current offset. */
function headArchive(token: string, jobId: string) {
  return getApp().inject({
    method: 'HEAD',
    url: `/api/import-jobs/${jobId}/archive`,
    headers: { cookie: `session=${token}` },
  });
}

/** `PATCH :id/archive` — appends `chunk` at `offset`. */
function patchArchive(token: string, jobId: string, offset: number, chunk: Buffer) {
  return getApp().inject({
    method: 'PATCH',
    url: `/api/import-jobs/${jobId}/archive`,
    headers: {
      cookie: `session=${token}`,
      'upload-offset': String(offset),
      'content-type': UPLOAD_OCTET_STREAM,
    },
    payload: chunk,
  });
}

/** Count audit_log rows tagged with the synthetic deployment-level type. */
async function countDataImportAuditRows(db: Database): Promise<number> {
  const res = await db.execute(
    sql`SELECT COUNT(*)::int AS c FROM audit_log WHERE entity_type = 'data_import'`,
  );
  return (res.rows[0] as { c: number }).c;
}

describe('Import job — create, resumable upload, perms, one-active, audit', () => {
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
    // Each arm starts with no job rows so one-active-per-kind and
    // latest-is-null are deterministic. The seed leaves business data in
    // place (a NON-EMPTY target) — the override/phrase arms below rely on
    // that; the empty-target arm wipes explicitly.
    await db.execute(sql`DELETE FROM data_exchange_job`);
    // Cross-arm isolation for AC-332's audit-count arm: the AC-326
    // upload-completion arms return as soon as the job leaves `pending`,
    // leaving a detached runner that settles to `failed` and writes one
    // `data_import` audit row. Clear those here so a straggler cannot land
    // inside AC-332's before/after window.
    await db.execute(sql`DELETE FROM audit_log WHERE entity_type = 'data_import'`);
  });

  // -------------------------------------------------------------------
  // AC-329 / AT-143 — override + confirmation phrase UP FRONT.
  //
  // The seed leaves a NON-EMPTY target (customers / projects / invoices).
  // api.md §14.2.4 "Import job — override + confirmation up front": the
  // server checks target-emptiness at CREATE and fails fast —
  // TARGET_NOT_EMPTY (missing override) or RESTORE_CONFIRMATION_MISMATCH
  // (wrong/missing phrase) — BEFORE the upload, never after a multi-GB
  // transfer. errors.ts pins TARGET_NOT_EMPTY=409, the phrase mismatch=422.
  // -------------------------------------------------------------------
  describe('AC-329: destructive guard precedes the upload (non-empty target)', () => {
    it('create without override into a non-empty target → 409 TARGET_NOT_EMPTY and no upload slot', async () => {
      const res = await createImportJob(ownerToken, 1024 /* bytes */);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('TARGET_NOT_EMPTY');

      // No job row was minted — the latest probe is still null. (If a
      // slot HAD been allocated, AT-143's "no upload slot is usable"
      // assertion would fail; a null latest is the cleanest proof.)
      const latest = await authGet(ownerToken, '/api/import-jobs');
      expect(latest.statusCode).toBe(200);
      expect(latest.json()).toEqual({ job: null });
    });

    it('create with override but NO confirmation_phrase → 422 RESTORE_CONFIRMATION_MISMATCH', async () => {
      const res = await createImportJob(ownerToken, 1024, { override: true });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('RESTORE_CONFIRMATION_MISMATCH');

      const latest = await authGet(ownerToken, '/api/import-jobs');
      expect(latest.json()).toEqual({ job: null });
    });

    it('create with override + WRONG confirmation_phrase → 422 RESTORE_CONFIRMATION_MISMATCH', async () => {
      const res = await createImportJob(ownerToken, 1024, {
        override: true,
        confirmation_phrase: `not-${EXPECTED_RESTORE_PHRASE}`,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('RESTORE_CONFIRMATION_MISMATCH');

      const latest = await authGet(ownerToken, '/api/import-jobs');
      expect(latest.json()).toEqual({ job: null });
    });

    it('create with override + MATCHING phrase into a non-empty target → 201 pending', async () => {
      const res = await createImportJob(ownerToken, 4096, {
        override: true,
        confirmation_phrase: EXPECTED_RESTORE_PHRASE,
      });
      expect(res.statusCode).toBe(201);
      const job = res.json() as ImportJobRow;
      expect(job.kind).toBe('import');
      expect(job.status).toBe('pending');
      expect(job.filesDone).toBe(0);
      expect(job.bytesDone).toBe(0);
      expect(job.archiveRef).toBeNull();
      expect(job.finishedAt).toBeNull();
      expect(typeof job.id).toBe('string');
    });

    it('create into an EMPTY target needs neither override nor phrase → 201 pending', async () => {
      // Empty the importable target WITHOUT touching `users`, so the owner
      // session stays valid through the create. The target-emptiness probe
      // checks customers/projects/project_workers/invoices/attachments only
      // — `users` (always carries the bootstrap admin) and `company_profile`
      // (baseline-seeded singleton) are deliberately excluded (ImportService's
      // target-emptiness probe, Issue #230). So wiping just the probed tables makes the target read
      // as empty while the caller stays authenticated — no app restart.
      try {
        await db.execute(sql`
          TRUNCATE TABLE
            attachments, invoices, invoice_sequence, project_workers,
            projects, customers
          RESTART IDENTITY CASCADE
        `);

        const res = await createImportJob(ownerToken, 2048);
        expect(res.statusCode).toBe(201);
        expect((res.json() as ImportJobRow).status).toBe('pending');
      } finally {
        // Re-seed the standard dataset so later arms (which need a NON-EMPTY
        // target) and sibling files start from the seeded baseline.
        await stopApp();
        await startApp();
        ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
      }
    });
  });

  // -------------------------------------------------------------------
  // Permission gate — every import-job endpoint is data:restore-gated
  // (api.md §14.2.4 "Jobs — error paths"). office holds data:export but
  // NOT data:restore (the strong arm); worker holds neither.
  // -------------------------------------------------------------------
  describe('data:restore gate on every endpoint', () => {
    it('POST /api/import-jobs unauthenticated → 401', async () => {
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/import-jobs',
        headers: { 'upload-length': '1024' },
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    });

    it('POST /api/import-jobs as office (has data:export, lacks data:restore) → 403 NOT_PERMITTED', async () => {
      const officeToken = await login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD);
      const res = await createImportJob(officeToken, 1024, {
        override: true,
        confirmation_phrase: EXPECTED_RESTORE_PHRASE,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('POST /api/import-jobs as worker (no data perms) → 403 NOT_PERMITTED', async () => {
      const workerToken = await login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD);
      const res = await createImportJob(workerToken, 1024, {
        override: true,
        confirmation_phrase: EXPECTED_RESTORE_PHRASE,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('GET /api/import-jobs as office → 403 NOT_PERMITTED', async () => {
      const officeToken = await login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD);
      const res = await authGet(officeToken, '/api/import-jobs');
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('HEAD /api/import-jobs/:id/archive as office → 403', async () => {
      const officeToken = await login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD);
      const res = await headArchive(officeToken, crypto.randomUUID());
      expect(res.statusCode).toBe(403);
    });

    it('PATCH /api/import-jobs/:id/archive as office → 403 NOT_PERMITTED', async () => {
      const officeToken = await login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD);
      const res = await patchArchive(officeToken, crypto.randomUUID(), 0, Buffer.from('x'));
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });
  });

  // -------------------------------------------------------------------
  // AC-326 / AT-140 — create + resumable (tus-style) upload protocol.
  //
  // The protocol arms operate on a NON-EMPTY target (the seed), so every
  // create carries override + the matching phrase to clear the AC-329
  // guard. The bytes uploaded are arbitrary here — these arms pin the
  // OFFSET PROTOCOL (Upload-Length / Upload-Offset / 409 / 413 / the
  // pending→running transition at full length), not archive validity.
  // The validity path (validate-before-wipe, real roundtrip) lives in
  // the sibling archive file.
  // -------------------------------------------------------------------
  describe('AC-326: resumable offset-based upload', () => {
    /** Create a pending import job over a non-empty target; return its id. */
    async function freshUploadSlot(uploadLength: number): Promise<string> {
      const res = await createImportJob(ownerToken, uploadLength, {
        override: true,
        confirmation_phrase: EXPECTED_RESTORE_PHRASE,
      });
      expect(res.statusCode).toBe(201);
      return (res.json() as ImportJobRow).id;
    }

    it('HEAD on a fresh slot reports Upload-Offset 0 and the declared Upload-Length', async () => {
      const total = 4096;
      const id = await freshUploadSlot(total);

      const head = await headArchive(ownerToken, id);
      expect(head.statusCode).toBe(200);
      expect(head.headers['upload-offset']).toBe('0');
      expect(head.headers['upload-length']).toBe(String(total));
    });

    it('a PATCH at the current offset appends and returns the new offset', async () => {
      const chunk = crypto.randomBytes(1000);
      const id = await freshUploadSlot(4096);

      const res = await patchArchive(ownerToken, id, 0, chunk);
      // 2xx (the chunk was accepted); the new server offset rides the
      // Upload-Offset response header.
      expect(res.statusCode).toBeGreaterThanOrEqual(200);
      expect(res.statusCode).toBeLessThan(300);
      expect(res.headers['upload-offset']).toBe(String(chunk.length));

      // HEAD confirms the persisted offset advanced to match.
      const head = await headArchive(ownerToken, id);
      expect(head.headers['upload-offset']).toBe(String(chunk.length));
    });

    it('two sequential PATCHes accumulate the offset', async () => {
      const a = crypto.randomBytes(1500);
      const b = crypto.randomBytes(900);
      const id = await freshUploadSlot(8192);

      const r1 = await patchArchive(ownerToken, id, 0, a);
      expect(r1.headers['upload-offset']).toBe(String(a.length));

      const r2 = await patchArchive(ownerToken, id, a.length, b);
      expect(r2.headers['upload-offset']).toBe(String(a.length + b.length));
    });

    it('a PATCH at a STALE offset → 409 UPLOAD_OFFSET_CONFLICT, offset unchanged (retry-safe)', async () => {
      const first = crypto.randomBytes(1200);
      const id = await freshUploadSlot(8192);

      const r1 = await patchArchive(ownerToken, id, 0, first);
      expect(r1.headers['upload-offset']).toBe(String(first.length));

      // Replay the first chunk at offset 0 — the server is already at
      // `first.length`. The mismatch is rejected; the offset must not move
      // (idempotent retry safety, AC-326).
      const replay = await patchArchive(ownerToken, id, 0, first);
      expect(replay.statusCode).toBe(409);
      expect(replay.json().code).toBe('UPLOAD_OFFSET_CONFLICT');

      const head = await headArchive(ownerToken, id);
      expect(head.headers['upload-offset']).toBe(String(first.length));
    });

    it('a PATCH carrying bytes PAST Upload-Length → 413', async () => {
      // Declare a small total, then PATCH more bytes than that at offset 0.
      const total = 512;
      const id = await freshUploadSlot(total);

      const tooBig = crypto.randomBytes(total + 100);
      const res = await patchArchive(ownerToken, id, 0, tooBig);
      expect(res.statusCode).toBe(413);

      // The over-length write was rejected wholesale — the offset stays at 0.
      const head = await headArchive(ownerToken, id);
      expect(head.headers['upload-offset']).toBe('0');
    });

    it('reaching Upload-Length transitions the job pending → running', async () => {
      // A single full-length chunk completes the upload; the server then
      // flips pending → running and begins async processing. The bytes are
      // not a valid archive, so the job will ultimately go `failed` (the
      // validity path is covered in the archive file) — but the
      // pending→running transition AC-326 pins fires regardless of content.
      const total = 2048;
      const payload = crypto.randomBytes(total);
      const id = await freshUploadSlot(total);

      const res = await patchArchive(ownerToken, id, 0, payload);
      expect(res.statusCode).toBeGreaterThanOrEqual(200);
      expect(res.statusCode).toBeLessThan(300);
      expect(res.headers['upload-offset']).toBe(String(total));

      const advanced = await pollUntilNotPending(ownerToken, id);
      expect(['running', 'ready', 'failed']).toContain(advanced.status);
      // startedAt is stamped on pending → running (data-model.md §5.18).
      expect(advanced.startedAt).not.toBeNull();
    });

    it('resumable: interrupt mid-upload, HEAD to read the offset, resume to completion', async () => {
      // The load-bearing reliability property (AC-326): a dropped upload
      // resumes from the server's offset rather than restarting at zero.
      const total = 6000;
      const full = crypto.randomBytes(total);
      const id = await freshUploadSlot(total);

      // Part one — simulate the connection dropping after the first chunk.
      const part1 = full.subarray(0, 2500);
      const r1 = await patchArchive(ownerToken, id, 0, part1);
      expect(r1.headers['upload-offset']).toBe(String(part1.length));

      // The client lost its local offset; it re-reads via HEAD.
      const head = await headArchive(ownerToken, id);
      const resumeOffset = Number(head.headers['upload-offset']);
      expect(resumeOffset).toBe(part1.length);

      // Resume from exactly that offset with the remaining bytes.
      const part2 = full.subarray(resumeOffset);
      const r2 = await patchArchive(ownerToken, id, resumeOffset, part2);
      expect(r2.statusCode).toBeGreaterThanOrEqual(200);
      expect(r2.statusCode).toBeLessThan(300);
      expect(r2.headers['upload-offset']).toBe(String(total));

      // The completed upload transitions the job out of pending.
      const advanced = await pollUntilNotPending(ownerToken, id);
      expect(['running', 'ready', 'failed']).toContain(advanced.status);
    });
  });

  // -------------------------------------------------------------------
  // Status + latest endpoints (api.md §14.2.4 Import-job table).
  // -------------------------------------------------------------------
  describe('status + latest', () => {
    it('GET /api/import-jobs returns { job: null } on a fresh deployment', async () => {
      const res = await authGet(ownerToken, '/api/import-jobs');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ job: null });
    });

    it('GET /api/import-jobs returns the latest import job after a create', async () => {
      const created = await createImportJob(ownerToken, 1024, {
        override: true,
        confirmation_phrase: EXPECTED_RESTORE_PHRASE,
      });
      expect(created.statusCode).toBe(201);
      const id = (created.json() as ImportJobRow).id;

      const res = await authGet(ownerToken, '/api/import-jobs');
      expect(res.statusCode).toBe(200);
      const body = res.json() as { job: ImportJobRow | null };
      expect(body.job?.id).toBe(id);
      expect(body.job?.kind).toBe('import');
    });

    it('GET /api/import-jobs/:id returns the row; unknown id → 404 NOT_FOUND', async () => {
      const created = await createImportJob(ownerToken, 1024, {
        override: true,
        confirmation_phrase: EXPECTED_RESTORE_PHRASE,
      });
      const id = (created.json() as ImportJobRow).id;

      const found = await authGet(ownerToken, `/api/import-jobs/${id}`);
      expect(found.statusCode).toBe(200);
      expect((found.json() as ImportJobRow).id).toBe(id);

      const missing = await authGet(ownerToken, `/api/import-jobs/${crypto.randomUUID()}`);
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe('NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------
  // AC-331 / AT-145 — one active import job per kind.
  // -------------------------------------------------------------------
  describe('AC-331: one active import job per kind', () => {
    it('a second create while one is pending → 409 IMPORT_JOB_ACTIVE carrying the active id', async () => {
      const first = await createImportJob(ownerToken, 4096, {
        override: true,
        confirmation_phrase: EXPECTED_RESTORE_PHRASE,
      });
      expect(first.statusCode).toBe(201);
      const firstId = (first.json() as ImportJobRow).id;

      const second = await createImportJob(ownerToken, 4096, {
        override: true,
        confirmation_phrase: EXPECTED_RESTORE_PHRASE,
      });
      expect(second.statusCode).toBe(409);
      const body = second.json();
      expect(body.code).toBe('IMPORT_JOB_ACTIVE');
      // The active job's id rides the error body so the UI re-attaches
      // rather than starting a second upload. Assert it equals the first
      // regardless of the exact envelope key the route picks.
      expect(JSON.stringify(body)).toContain(firstId);
    });

    it('a fresh create succeeds after the prior import job reaches a terminal state', async () => {
      // Drive one job to a terminal state by completing an upload of
      // invalid bytes (it fails validation → `failed`, freeing the slot).
      const total = 1024;
      const first = await createImportJob(ownerToken, total, {
        override: true,
        confirmation_phrase: EXPECTED_RESTORE_PHRASE,
      });
      expect(first.statusCode).toBe(201);
      const firstId = (first.json() as ImportJobRow).id;
      await patchArchive(ownerToken, firstId, 0, crypto.randomBytes(total));
      const terminal = await pollUntilTerminal(ownerToken, firstId);
      expect(['ready', 'failed']).toContain(terminal.status);

      // A prior terminal job does NOT block a fresh create.
      const second = await createImportJob(ownerToken, 2048, {
        override: true,
        confirmation_phrase: EXPECTED_RESTORE_PHRASE,
      });
      expect(second.statusCode).toBe(201);
      const secondJob = second.json() as ImportJobRow;
      expect(secondJob.id).not.toBe(firstId);
      expect(secondJob.status).toBe('pending');
    });
  });

  // -------------------------------------------------------------------
  // AC-332 / AT-146 — exactly one data_import audit row at the terminal
  // transition; progress updates write none.
  //
  // Uploading invalid bytes drives the job to a terminal (`failed`)
  // transition without needing a real archive — AC-332 pins "one row at
  // the terminal transition" regardless of ready-vs-failed. (The
  // ready-path audit count rides the sibling roundtrip arm.)
  // -------------------------------------------------------------------
  describe('AC-332: single audit row at the terminal transition', () => {
    it('a job that reaches a terminal state writes exactly one data_import audit row', async () => {
      const before = await countDataImportAuditRows(db);

      const total = 1024;
      const created = await createImportJob(ownerToken, total, {
        override: true,
        confirmation_phrase: EXPECTED_RESTORE_PHRASE,
      });
      expect(created.statusCode).toBe(201);
      const id = (created.json() as ImportJobRow).id;

      await patchArchive(ownerToken, id, 0, crypto.randomBytes(total));
      const terminal = await pollUntilTerminal(ownerToken, id);
      expect(['ready', 'failed']).toContain(terminal.status);

      const after = await countDataImportAuditRows(db);
      // Exactly one row regardless of how many progress updates ran in
      // between — progress mutations do not route through the
      // single-write-path helper (data-model.md §5.18).
      expect(after - before).toBe(1);
    });

    it('the terminal audit row carries entity_type = data_import', async () => {
      const total = 1024;
      const created = await createImportJob(ownerToken, total, {
        override: true,
        confirmation_phrase: EXPECTED_RESTORE_PHRASE,
      });
      const id = (created.json() as ImportJobRow).id;
      await patchArchive(ownerToken, id, 0, crypto.randomBytes(total));
      await pollUntilTerminal(ownerToken, id);

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
});
