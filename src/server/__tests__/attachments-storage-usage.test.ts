/**
 * API integration tests — project storage usage tracking
 * (AC-263, AC-264, AC-265 in verification.md §15.26).
 *
 * Pins three contracts:
 *
 *   - AC-263 (data-model.md §5.14, ARCHITECTURE.md "Storage usage —
 *     trigger-maintained side table"): the four-bucket per-project view
 *     `project_storage_usage` is maintained accurately across every
 *     attachment lifecycle transition (init pending, complete, hide,
 *     restore, orphan-reaper delete pending, hidden-reaper delete
 *     hidden, and a no-op `label` rename). Drives transitions directly
 *     via raw SQL on `attachments` so the assertion is on the trigger
 *     semantics, not on whichever service path issues the write — the
 *     spec treats the maintenance mechanism as authoritative regardless
 *     of caller. Project-purge cascade is pinned in
 *     `attachments-purge-cascade.test.ts` under AC-266; the row
 *     aggregate ↔ view equality is pinned in
 *     `attachments-storage-usage-invariant.test.ts` under AC-267.
 *
 *   - AC-264 (api.md §14.2.12): GET /api/projects/:id/storage-usage —
 *     four-bucket payload shape (each leaf a non-negative integer);
 *     three-way result mirroring AC-214 / AC-147 (worker in scope →
 *     200, worker out of scope → 403 NOT_PERMITTED, unknown id → 404
 *     NOT_FOUND); 401 UNAUTHENTICATED for an unauthenticated request;
 *     422 VALIDATION_ERROR on a syntactically invalid project id;
 *     all-zero buckets for a project with no attachments; no
 *     `audit_log` row.
 *
 *   - AC-265 (api.md §14.2.12): GET /api/storage-usage — `data:export`
 *     gate (owner / office → 200; worker / bookkeeper → 403; unauthed
 *     → 401), summed over every project including archived, all-zero
 *     buckets when there are no attachments anywhere, no `audit_log`
 *     row.
 *
 * Raw-SQL attachment-row seeding is permitted under `__tests__/` per
 * the AC-179 architecture-check allowlist (mirrors the pattern in
 * `attachments-hidden-reaper.test.ts` which also drives raw SQL inserts
 * to backdate row timestamps the service surface won't allow).
 *
 * Pre-impl red state: the `project_storage_usage` table does not exist
 * yet, so the AC-263 `readUsageRow` SQL throws "relation does not
 * exist" — surfacing as a per-test failure. The AC-264 / AC-265 routes
 * do not exist yet, so the framework's not-found handler returns
 * `code: 'ROUTE_NOT_FOUND'` (per `error-handler.ts:installNotFoundHandler`)
 * which fails the `statusCode === 200` and `code === 'NOT_FOUND'`
 * assertions — distinct from a successful resource-not-found response,
 * matching the project's TDD red convention.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import type pg from 'pg';

import {
  startApp,
  stopApp,
  login,
  authGet,
  authPost,
  authDelete,
  createTestUserSession,
  getApp,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import type { Database } from '../db/connection.js';

const year = new Date().getFullYear();

// ---------------------------------------------------------------------
// Shapes pinned by the spec.
// ---------------------------------------------------------------------

interface UsageTotals {
  ready: { plaintext: number; ciphertext: number };
  hidden: { plaintext: number; ciphertext: number };
}

const ZERO_TOTALS: UsageTotals = {
  ready: { plaintext: 0, ciphertext: 0 },
  hidden: { plaintext: 0, ciphertext: 0 },
};

interface SeededRow {
  id: string;
  sizeBytes: number;
  thumbSizeBytes: number | null;
  ciphertextSizeBytes: number;
  ciphertextThumbSizeBytes: number | null;
}

// ---------------------------------------------------------------------
// Raw-SQL fixtures. Each lifecycle transition is one `UPDATE` /
// `DELETE` so the assertion targets the trigger, not a service flow.
// ---------------------------------------------------------------------

/**
 * Insert a `pending` row directly. Pending rows must not contribute
 * to either bucket (data-model.md §5.14 — bytes may not exist on
 * object storage yet). The schema's `attachments_wrapped_dek_required_when_ready`
 * CHECK only fires for `ready` rows, so a pending row can carry NULL
 * `wrapped_dek` and `ciphertext_size_bytes`. We populate the ciphertext
 * size up front so completing the upload is a status-only flip.
 */
async function seedPendingRow(
  db: Database,
  projectId: string,
  opts: {
    sizeBytes: number;
    thumbSizeBytes?: number | null;
    ciphertextSizeBytes: number;
    ciphertextThumbSizeBytes?: number | null;
    kind?: 'photo' | 'binary';
  },
): Promise<SeededRow> {
  const id = crypto.randomUUID();
  const isPhoto = (opts.kind ?? 'binary') === 'photo';
  const hasThumb = opts.thumbSizeBytes != null;
  await db.execute(sql`
    INSERT INTO attachments
      (id, project_id, status, kind, label, filename, mime_type, size_bytes,
       thumb_size_bytes,
       ciphertext_size_bytes, ciphertext_thumb_size_bytes,
       original_key, thumb_key, has_thumbnail,
       wrapped_dek, wrapped_thumb_dek, wrapped_dek_version)
    VALUES (${id}, ${projectId}, 'pending',
            ${isPhoto ? 'photo' : 'binary'},
            ${isPhoto ? 'foto' : 'sonstiges'},
            ${'p-' + id.slice(0, 6)},
            ${isPhoto ? 'image/jpeg' : 'application/pdf'},
            ${opts.sizeBytes},
            ${opts.thumbSizeBytes ?? null},
            ${opts.ciphertextSizeBytes},
            ${opts.ciphertextThumbSizeBytes ?? null},
            ${`attachments/${projectId}/${id}.orig`},
            ${hasThumb ? `attachments/${projectId}/${id}.thumb` : null},
            ${hasThumb},
            NULL, NULL, 1)
  `);
  return {
    id,
    sizeBytes: opts.sizeBytes,
    thumbSizeBytes: opts.thumbSizeBytes ?? null,
    ciphertextSizeBytes: opts.ciphertextSizeBytes,
    ciphertextThumbSizeBytes: opts.ciphertextThumbSizeBytes ?? null,
  };
}

/**
 * Transition pending → ready. The CHECK pinning `wrapped_dek` for
 * ready rows requires the wrap envelope to land in the same UPDATE.
 * Synthetic envelope bytes — this file does not unwrap, only the
 * trigger arithmetic depends on the `status` flip.
 */
async function completeUpload(db: Database, id: string): Promise<void> {
  const wrappedDek = Buffer.alloc(192, 0x55).toString('base64');
  await db.execute(sql`
    UPDATE attachments
    SET status = 'ready', wrapped_dek = ${wrappedDek}
    WHERE id = ${id}
  `);
}

async function hideRow(db: Database, id: string): Promise<void> {
  await db.execute(sql`
    UPDATE attachments
    SET status = 'hidden', hidden_at = now()
    WHERE id = ${id}
  `);
}

async function restoreRow(db: Database, id: string): Promise<void> {
  await db.execute(sql`
    UPDATE attachments
    SET status = 'ready', hidden_at = NULL
    WHERE id = ${id}
  `);
}

async function deleteRow(db: Database, id: string): Promise<void> {
  await db.execute(sql`DELETE FROM attachments WHERE id = ${id}`);
}

/**
 * Read the side-table row directly. `bigint` columns come back as
 * strings on the pg driver's default config; `Number(...)` widens to
 * the JS number domain — safe for the byte counts the test fixtures
 * produce (well under `Number.MAX_SAFE_INTEGER`).
 */
async function readUsageRow(db: Database, projectId: string): Promise<UsageTotals | null> {
  const r = await db.execute(sql`
    SELECT space_ready_bytes, space_hidden_bytes,
           ciphertext_ready_bytes, ciphertext_hidden_bytes
    FROM project_storage_usage
    WHERE project_id = ${projectId}
  `);
  const row = r.rows[0] as
    | {
        space_ready_bytes: string | number;
        space_hidden_bytes: string | number;
        ciphertext_ready_bytes: string | number;
        ciphertext_hidden_bytes: string | number;
      }
    | undefined;
  if (!row) return null;
  return {
    ready: {
      plaintext: Number(row.space_ready_bytes),
      ciphertext: Number(row.ciphertext_ready_bytes),
    },
    hidden: {
      plaintext: Number(row.space_hidden_bytes),
      ciphertext: Number(row.ciphertext_hidden_bytes),
    },
  };
}

async function projectIdByNumber(ownerToken: string, number: string): Promise<string> {
  const res = await authGet(ownerToken, '/api/projects?limit=200');
  const rows = res.json().data as { id: string; number: string }[];
  const p = rows.find((r) => r.number === number);
  if (!p) throw new Error(`seed missing project ${number}`);
  return p.id;
}

async function createProject(ownerToken: string): Promise<string> {
  const customersRes = await authGet(ownerToken, '/api/customers');
  const customers = customersRes.json().customers ?? customersRes.json().data;
  if (!Array.isArray(customers) || customers.length === 0) {
    throw new Error('Seed setup: at least one customer required');
  }
  const customerId = customers[0].id;
  const suffix = crypto.randomUUID().slice(0, 8);
  const res = await authPost(ownerToken, '/api/projects', {
    number: `SU-${suffix}`,
    title: `Storage-usage fixture ${suffix}`,
    customerId,
  });
  if (res.statusCode !== 201) {
    throw new Error(`project create failed ${res.statusCode} ${res.body}`);
  }
  return res.json().id as string;
}

async function countAuditRows(db: Database): Promise<number> {
  const r = await db.execute(sql`SELECT COUNT(*)::int AS c FROM audit_log`);
  return (r.rows[0] as { c: number }).c;
}

// ---------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------

describe('Project storage usage tracking', () => {
  let db: Database;
  let pool: pg.Pool;
  let ownerToken: string;
  let officeToken: string;
  let workerToken: string;
  let bookkeeperToken: string;
  let noPermsToken: string;

  beforeAll(async () => {
    await startApp();
    [ownerToken, officeToken, workerToken, bookkeeperToken] = await Promise.all([
      login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.bookkeeper.username, SEED_DEFAULT_PASSWORD),
    ]);
    const none = await createTestUserSession({ roles: [] });
    noPermsToken = none.token;

    // Independent pool for raw-SQL fixtures and side-table reads.
    // `startApp()` keeps its own pool inside the helper module; tearing
    // down both in afterAll keeps the integration runner from leaking
    // connections between files.
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
  });

  afterAll(async () => {
    await pool.end();
    await stopApp();
  });

  // -------------------------------------------------------------------
  // AC-263 — per-project storage totals across every lifecycle
  // transition. One project per test for clean isolation; raw-SQL
  // transitions exercise the trigger without coupling to the service
  // surface.
  // -------------------------------------------------------------------
  describe('AC-263: per-project storage totals across the lifecycle', () => {
    let projectId: string;

    beforeEach(async () => {
      projectId = await createProject(ownerToken);
    });

    it('project insert seeds a usage row with all four counters at zero', async () => {
      // Independent assertion of the `projects_storage_usage_init`
      // trigger — every project must have its usage row from creation
      // (data-model.md §5.14: "system-maintained invariant").
      expect(await readUsageRow(db, projectId)).toEqual(ZERO_TOTALS);
    });

    it('INSERT pending leaves all four counters at zero', async () => {
      await seedPendingRow(db, projectId, {
        sizeBytes: 1024,
        ciphertextSizeBytes: 1088,
      });
      // Pending rows are excluded by construction (data-model.md §5.14).
      expect(await readUsageRow(db, projectId)).toEqual(ZERO_TOTALS);
    });

    it('complete (pending → ready) adds bytes to the ready bucket on both axes (photo with thumb)', async () => {
      const photo = await seedPendingRow(db, projectId, {
        sizeBytes: 4096,
        thumbSizeBytes: 256,
        ciphertextSizeBytes: 4160,
        ciphertextThumbSizeBytes: 320,
        kind: 'photo',
      });
      await completeUpload(db, photo.id);

      // Plaintext: 4096 + 256 (thumb included). Ciphertext: 4160 + 320.
      expect(await readUsageRow(db, projectId)).toEqual({
        ready: { plaintext: 4352, ciphertext: 4480 },
        hidden: { plaintext: 0, ciphertext: 0 },
      });
    });

    it('complete (pending → ready) for a binary (no thumb) adds only the original bytes', async () => {
      const binary = await seedPendingRow(db, projectId, {
        sizeBytes: 2048,
        ciphertextSizeBytes: 2112,
      });
      await completeUpload(db, binary.id);

      // Non-photo contributes only the original (data-model.md §5.14).
      expect(await readUsageRow(db, projectId)).toEqual({
        ready: { plaintext: 2048, ciphertext: 2112 },
        hidden: { plaintext: 0, ciphertext: 0 },
      });
    });

    it('user-DELETE (ready → hidden) moves bytes ready → hidden on both axes', async () => {
      const photo = await seedPendingRow(db, projectId, {
        sizeBytes: 4096,
        thumbSizeBytes: 256,
        ciphertextSizeBytes: 4160,
        ciphertextThumbSizeBytes: 320,
        kind: 'photo',
      });
      await completeUpload(db, photo.id);
      await hideRow(db, photo.id);

      expect(await readUsageRow(db, projectId)).toEqual({
        ready: { plaintext: 0, ciphertext: 0 },
        hidden: { plaintext: 4352, ciphertext: 4480 },
      });
    });

    it('restore (hidden → ready) moves bytes hidden → ready on both axes', async () => {
      const photo = await seedPendingRow(db, projectId, {
        sizeBytes: 4096,
        thumbSizeBytes: 256,
        ciphertextSizeBytes: 4160,
        ciphertextThumbSizeBytes: 320,
        kind: 'photo',
      });
      await completeUpload(db, photo.id);
      await hideRow(db, photo.id);
      await restoreRow(db, photo.id);

      expect(await readUsageRow(db, projectId)).toEqual({
        ready: { plaintext: 4352, ciphertext: 4480 },
        hidden: { plaintext: 0, ciphertext: 0 },
      });
    });

    it('orphan-reaper DELETE on a pending row leaves all counters unchanged', async () => {
      const pending = await seedPendingRow(db, projectId, {
        sizeBytes: 1024,
        ciphertextSizeBytes: 1088,
      });
      // Pre-condition: pending contributes nothing.
      expect(await readUsageRow(db, projectId)).toEqual(ZERO_TOTALS);

      await deleteRow(db, pending.id);

      expect(await readUsageRow(db, projectId)).toEqual(ZERO_TOTALS);
    });

    it('hidden-reaper DELETE on a hidden row subtracts bytes from the hidden bucket', async () => {
      const binary = await seedPendingRow(db, projectId, {
        sizeBytes: 2048,
        ciphertextSizeBytes: 2112,
      });
      await completeUpload(db, binary.id);
      await hideRow(db, binary.id);
      // Pre-condition: bytes accounted in hidden bucket.
      expect(await readUsageRow(db, projectId)).toEqual({
        ready: { plaintext: 0, ciphertext: 0 },
        hidden: { plaintext: 2048, ciphertext: 2112 },
      });

      await deleteRow(db, binary.id);

      expect(await readUsageRow(db, projectId)).toEqual(ZERO_TOTALS);
    });

    it('full lifecycle on a photo + binary keeps the matrix correct at every checkpoint', async () => {
      // Per-step assertions catch a wrong delta that a final-only check
      // would let through (e.g. a sign flip on `hide` masked by a
      // matching sign flip on `restore`).
      const photo = await seedPendingRow(db, projectId, {
        sizeBytes: 8192,
        thumbSizeBytes: 512,
        ciphertextSizeBytes: 8256,
        ciphertextThumbSizeBytes: 576,
        kind: 'photo',
      });
      const binary = await seedPendingRow(db, projectId, {
        sizeBytes: 16384,
        ciphertextSizeBytes: 16448,
      });

      // Both pending → counters at zero.
      expect(await readUsageRow(db, projectId)).toEqual(ZERO_TOTALS);

      // Complete the photo.
      await completeUpload(db, photo.id);
      expect(await readUsageRow(db, projectId)).toEqual({
        ready: { plaintext: 8192 + 512, ciphertext: 8256 + 576 },
        hidden: { plaintext: 0, ciphertext: 0 },
      });

      // Complete the binary.
      await completeUpload(db, binary.id);
      expect(await readUsageRow(db, projectId)).toEqual({
        ready: {
          plaintext: 8192 + 512 + 16384,
          ciphertext: 8256 + 576 + 16448,
        },
        hidden: { plaintext: 0, ciphertext: 0 },
      });

      // Hide the photo (Papierkorb).
      await hideRow(db, photo.id);
      expect(await readUsageRow(db, projectId)).toEqual({
        ready: { plaintext: 16384, ciphertext: 16448 },
        hidden: { plaintext: 8192 + 512, ciphertext: 8256 + 576 },
      });

      // Restore the photo.
      await restoreRow(db, photo.id);
      expect(await readUsageRow(db, projectId)).toEqual({
        ready: {
          plaintext: 8192 + 512 + 16384,
          ciphertext: 8256 + 576 + 16448,
        },
        hidden: { plaintext: 0, ciphertext: 0 },
      });

      // Hide the binary.
      await hideRow(db, binary.id);
      expect(await readUsageRow(db, projectId)).toEqual({
        ready: { plaintext: 8192 + 512, ciphertext: 8256 + 576 },
        hidden: { plaintext: 16384, ciphertext: 16448 },
      });

      // Hidden reaper purges the hidden binary.
      await deleteRow(db, binary.id);
      expect(await readUsageRow(db, projectId)).toEqual({
        ready: { plaintext: 8192 + 512, ciphertext: 8256 + 576 },
        hidden: { plaintext: 0, ciphertext: 0 },
      });
    });

    it('multi-row UPDATE on the same project (bulk hide) ends with correct totals', async () => {
      // Five ready rows; one bulk UPDATE flips them all to hidden. The
      // FOR EACH ROW trigger fires per-row N times within one statement
      // — pinning that the cumulative deltas converge on the right
      // totals (a class of bug a single-row test cannot catch: a
      // trigger that aliases NEW/OLD across the row loop, or that
      // double-counts under multi-row firing). The AC-263 clause about
      // *concurrent* writes (independent transactions) is structurally
      // out of reach in an in-process integration test; the row-lock
      // serialization the spec calls out is a Postgres semantic, not a
      // testable behaviour at this layer.
      const rows: SeededRow[] = [];
      for (let i = 0; i < 5; i += 1) {
        const r = await seedPendingRow(db, projectId, {
          sizeBytes: 1000 + i,
          ciphertextSizeBytes: 1064 + i,
        });
        await completeUpload(db, r.id);
        rows.push(r);
      }
      const expectedReadyPlain = rows.reduce((a, r) => a + r.sizeBytes, 0);
      const expectedReadyCipher = rows.reduce((a, r) => a + r.ciphertextSizeBytes, 0);
      expect(await readUsageRow(db, projectId)).toEqual({
        ready: { plaintext: expectedReadyPlain, ciphertext: expectedReadyCipher },
        hidden: { plaintext: 0, ciphertext: 0 },
      });

      await db.execute(sql`
        UPDATE attachments
        SET status = 'hidden', hidden_at = now()
        WHERE project_id = ${projectId} AND status = 'ready'
      `);

      expect(await readUsageRow(db, projectId)).toEqual({
        ready: { plaintext: 0, ciphertext: 0 },
        hidden: { plaintext: expectedReadyPlain, ciphertext: expectedReadyCipher },
      });
    });

    it('a no-op UPDATE (filename rename) on a ready row leaves all counters unchanged', async () => {
      const r = await seedPendingRow(db, projectId, {
        sizeBytes: 999,
        ciphertextSizeBytes: 1063,
      });
      await completeUpload(db, r.id);
      const before = await readUsageRow(db, projectId);
      expect(before).not.toBeNull();

      // A mutation that touches no `status`/byte field must compute a
      // zero delta — pins the "row mutation that changes neither
      // `status` nor any byte field … leaves every total unchanged"
      // clause of AC-263.
      await db.execute(sql`
        UPDATE attachments
        SET filename = ${'renamed-' + r.id.slice(0, 4)}
        WHERE id = ${r.id}
      `);

      expect(await readUsageRow(db, projectId)).toEqual(before);
    });

    it('a no-op UPDATE (label rename) on a ready row leaves all counters unchanged', async () => {
      const r = await seedPendingRow(db, projectId, {
        sizeBytes: 777,
        ciphertextSizeBytes: 841,
      });
      await completeUpload(db, r.id);
      const before = await readUsageRow(db, projectId);
      expect(before).not.toBeNull();

      // AC-263 names "a `label` or `filename` rename" — pin the label
      // arm too so a regression that wires label changes into the
      // delta computation cannot pass.
      await db.execute(sql`
        UPDATE attachments
        SET label = 'angebot'
        WHERE id = ${r.id}
      `);

      expect(await readUsageRow(db, projectId)).toEqual(before);
    });
  });

  // -------------------------------------------------------------------
  // AC-264 — GET /api/projects/:id/storage-usage contract.
  // -------------------------------------------------------------------
  describe('AC-264: GET /api/projects/:id/storage-usage contract', () => {
    let assignedProjectId: string;
    let unassignedProjectId: string;

    beforeAll(async () => {
      // Worker1 is assigned to YYYY-007, -008, -009, -011 per
      // src/server/seed/business.ts (mirrors attachments-scope.test.ts).
      assignedProjectId = await projectIdByNumber(ownerToken, `${year}-007`);
      unassignedProjectId = await projectIdByNumber(ownerToken, `${year}-001`);
    });

    it('returns 200 with the four-bucket payload for an authenticated owner', async () => {
      const res = await authGet(ownerToken, `/api/projects/${assignedProjectId}/storage-usage`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual({
        ready: { plaintext: expect.any(Number), ciphertext: expect.any(Number) },
        hidden: { plaintext: expect.any(Number), ciphertext: expect.any(Number) },
      });
      // Each leaf is a non-negative integer byte count
      // (api.md §14.2.12 "Each leaf is a non-negative integer count of
      // bytes").
      for (const bucket of ['ready', 'hidden'] as const) {
        for (const axis of ['plaintext', 'ciphertext'] as const) {
          const v = body[bucket][axis];
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it('returns all-zero buckets for a project with no attachments (not 404, not omitted)', async () => {
      const fresh = await createProject(ownerToken);
      const res = await authGet(ownerToken, `/api/projects/${fresh}/storage-usage`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(ZERO_TOTALS);
    });

    it('returns 200 for a worker on an assigned project', async () => {
      const res = await authGet(workerToken, `/api/projects/${assignedProjectId}/storage-usage`);
      expect(res.statusCode).toBe(200);
    });

    it('returns 403 NOT_PERMITTED for a worker on a project they are not assigned to', async () => {
      // Distinguishability mirrors AC-214 / AC-147: an existing project
      // outside the caller's scope is 403, not 404.
      const res = await authGet(workerToken, `/api/projects/${unassignedProjectId}/storage-usage`);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('returns 404 NOT_FOUND for an unknown project id (distinguishable from 403)', async () => {
      // Worker (the most-scoped role) — load-bearing case for the
      // missing-vs-out-of-scope distinction. Mirrors attachments-scope
      // test for AC-214: a worker on a real-but-out-of-scope project
      // gets 403; a worker on an unknown id gets 404. Conflating the
      // two would leak existence info through a differential response.
      const missingId = '00000000-0000-0000-0000-000000000099';
      const res = await authGet(workerToken, `/api/projects/${missingId}/storage-usage`);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });

    it('returns 401 UNAUTHENTICATED for an unauthenticated request', async () => {
      const res = await authGet('', `/api/projects/${assignedProjectId}/storage-usage`);
      expect(res.statusCode).toBe(401);
    });

    it('returns 422 VALIDATION_ERROR for a syntactically invalid project id', async () => {
      const res = await authGet(ownerToken, `/api/projects/not-a-uuid/storage-usage`);
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('returns 403 NOT_PERMITTED for a user with no roles', async () => {
      const res = await authGet(noPermsToken, `/api/projects/${assignedProjectId}/storage-usage`);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('produces no audit_log row on a successful read', async () => {
      // The endpoint is a read; the audit invariant (AC-177) applies
      // only to mutations. Mirrors the audit-log read endpoints in
      // §14.2.8.
      const before = await countAuditRows(db);
      const res = await authGet(ownerToken, `/api/projects/${assignedProjectId}/storage-usage`);
      expect(res.statusCode).toBe(200);
      expect(await countAuditRows(db)).toBe(before);
    });

    it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
      'rejects %s with 405 METHOD_NOT_ALLOWED (api.md §14.2.12 error path)',
      async (method) => {
        const res = await getApp().inject({
          method,
          url: `/api/projects/${assignedProjectId}/storage-usage`,
          headers: { cookie: `session=${ownerToken}` },
        });
        expect(res.statusCode).toBe(405);
      },
    );
  });

  // -------------------------------------------------------------------
  // AC-265 — GET /api/storage-usage contract (data:export gate).
  // -------------------------------------------------------------------
  describe('AC-265: GET /api/storage-usage contract', () => {
    it('returns 200 with the four-bucket payload for an owner (holds data:export)', async () => {
      const res = await authGet(ownerToken, '/api/storage-usage');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual({
        ready: { plaintext: expect.any(Number), ciphertext: expect.any(Number) },
        hidden: { plaintext: expect.any(Number), ciphertext: expect.any(Number) },
      });
      for (const bucket of ['ready', 'hidden'] as const) {
        for (const axis of ['plaintext', 'ciphertext'] as const) {
          const v = body[bucket][axis];
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it('returns 200 for office (holds data:export)', async () => {
      const res = await authGet(officeToken, '/api/storage-usage');
      expect(res.statusCode).toBe(200);
    });

    it('returns 403 NOT_PERMITTED for a worker (lacks data:export)', async () => {
      // Mirrors the unified Export gate (api.md §14.2.4).
      const res = await authGet(workerToken, '/api/storage-usage');
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('returns 403 NOT_PERMITTED for a bookkeeper (lacks data:export)', async () => {
      const res = await authGet(bookkeeperToken, '/api/storage-usage');
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('returns 401 UNAUTHENTICATED for an unauthenticated request', async () => {
      const res = await authGet('', '/api/storage-usage');
      expect(res.statusCode).toBe(401);
    });

    it('returns all-zero buckets when no attachments exist anywhere', async () => {
      // Wipe every attachment on every project; the per-row trigger
      // decrements all `project_storage_usage` rows back to zero
      // (statement runs at depth 1 → no cascade short-circuit).
      // Pins "Zeros when there are no projects or no attachments"
      // (api.md §14.2.12, AC-265).
      await db.execute(sql`DELETE FROM attachments`);
      const res = await authGet(ownerToken, '/api/storage-usage');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(ZERO_TOTALS);
    });

    it('produces no audit_log row on a successful read', async () => {
      const before = await countAuditRows(db);
      const res = await authGet(ownerToken, '/api/storage-usage');
      expect(res.statusCode).toBe(200);
      expect(await countAuditRows(db)).toBe(before);
    });

    it("includes archived projects' bytes in the global sum (api.md §14.2.12)", async () => {
      // Archive (soft-delete per §6.9) is a board-state concept; the
      // attachments still exist and contribute real bytes to the
      // operator-facing tally until purge cascades them away
      // (AC-265 + AC-266). The global endpoint must include them.
      await db.execute(sql`DELETE FROM attachments`);
      const archivedProjectId = await createProject(ownerToken);
      const archivedRow = await seedPendingRow(db, archivedProjectId, {
        sizeBytes: 7777,
        ciphertextSizeBytes: 7841,
      });
      await completeUpload(db, archivedRow.id);

      // Soft-delete via DELETE-without-/purge — same surface that
      // drives `archiveProject` in attachments-purge-cascade.test.ts.
      const archiveRes = await authDelete(ownerToken, `/api/projects/${archivedProjectId}`);
      expect(archiveRes.statusCode).toBe(200);

      // Global tally must still reflect the archived project's bytes.
      const res = await authGet(ownerToken, '/api/storage-usage');
      expect(res.statusCode).toBe(200);
      const body = res.json() as UsageTotals;
      expect(body.ready.plaintext).toBeGreaterThanOrEqual(7777);
      expect(body.ready.ciphertext).toBeGreaterThanOrEqual(7841);
    });

    it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
      'rejects %s with 405 METHOD_NOT_ALLOWED (api.md §14.2.12 error path)',
      async (method) => {
        const res = await getApp().inject({
          method,
          url: '/api/storage-usage',
          headers: { cookie: `session=${ownerToken}` },
        });
        expect(res.statusCode).toBe(405);
      },
    );
  });
});
