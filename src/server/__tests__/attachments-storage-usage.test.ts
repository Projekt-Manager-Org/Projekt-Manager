/**
 * API integration tests — storage usage (data-model.md §5.14).
 *
 * Pins two surfaces:
 *
 *   - The per-project side table `project_storage_usage` (internal;
 *     design at `projectStorageUsage` in schema.ts) is maintained
 *     accurately across every attachment lifecycle transition (init
 *     pending, complete, hide, restore, orphan-reaper delete pending,
 *     hidden-reaper delete hidden, and a no-op `label` rename). Drives
 *     transitions directly via raw SQL on `attachments` so the
 *     assertion is on the trigger semantics, not on whichever service
 *     path issues the write. Project-purge cascade is pinned in
 *     `attachments-purge-cascade.test.ts`; the row aggregate ↔ view
 *     equality in `attachments-storage-usage-invariant.test.ts`.
 *
 *   - GET /api/storage-usage — `data:export` gate (api.md §14.3: owner
 *     / office → 200; worker / bookkeeper → 403; unauthed → 401), and
 *     the totals of AC-447: summed over every project including
 *     archived, zero when there are no attachments.
 *
 * Raw-SQL attachment-row seeding is permitted under `__tests__/` per
 * the AC-179 architecture-check allowlist (mirrors the pattern in
 * `attachments-hidden-reaper.test.ts` which also drives raw SQL inserts
 * to backdate row timestamps the service surface won't allow).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import type pg from 'pg';

import { startApp, stopApp, login, authGet, authPost, authDelete } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import type { Database } from '../db/connection.js';

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
    ciphertextSizeBytes: number;
    ciphertextThumbSizeBytes?: number | null;
    kind?: 'photo' | 'binary';
  },
): Promise<SeededRow> {
  const id = crypto.randomUUID();
  const isPhoto = (opts.kind ?? 'binary') === 'photo';
  const hasThumb = opts.ciphertextThumbSizeBytes != null;
  await db.execute(sql`
    INSERT INTO attachments
      (id, project_id, status, kind, label, filename, mime_type, size_bytes,
       ciphertext_size_bytes, ciphertext_thumb_size_bytes,
       original_key, thumb_key, has_thumbnail,
       wrapped_dek, wrapped_thumb_dek, wrapped_dek_version)
    VALUES (${id}, ${projectId}, 'pending',
            ${isPhoto ? 'photo' : 'binary'},
            ${isPhoto ? 'foto' : 'sonstiges'},
            ${'p-' + id.slice(0, 6)},
            ${isPhoto ? 'image/jpeg' : 'application/pdf'},
            ${opts.sizeBytes},
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

  beforeAll(async () => {
    await startApp();
    [ownerToken, officeToken, workerToken, bookkeeperToken] = await Promise.all([
      login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.bookkeeper.username, SEED_DEFAULT_PASSWORD),
    ]);

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
  // Per-project storage totals across every lifecycle
  // transition. One project per test for clean isolation; raw-SQL
  // transitions exercise the trigger without coupling to the service
  // surface.
  // -------------------------------------------------------------------
  describe('per-project storage totals across the lifecycle', () => {
    let projectId: string;

    beforeEach(async () => {
      projectId = await createProject(ownerToken);
    });

    it('project insert seeds a usage row with all four counters at zero', async () => {
      // Independent assertion of the `projects_storage_usage_init`
      // trigger — every project must have its usage row from creation.
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
        ciphertextSizeBytes: 4160,
        ciphertextThumbSizeBytes: 320,
        kind: 'photo',
      });
      await completeUpload(db, photo.id);

      // Plaintext: the original only (data-model.md §5.14). Ciphertext: 4160 + 320.
      expect(await readUsageRow(db, projectId)).toEqual({
        ready: { plaintext: 4096, ciphertext: 4480 },
        hidden: { plaintext: 0, ciphertext: 0 },
      });
    });

    it('complete (pending → ready) for a binary (no thumb) adds only the original bytes', async () => {
      const binary = await seedPendingRow(db, projectId, {
        sizeBytes: 2048,
        ciphertextSizeBytes: 2112,
      });
      await completeUpload(db, binary.id);

      // Non-photo contributes only the original (no thumbnail).
      expect(await readUsageRow(db, projectId)).toEqual({
        ready: { plaintext: 2048, ciphertext: 2112 },
        hidden: { plaintext: 0, ciphertext: 0 },
      });
    });

    it('user-DELETE (ready → hidden) moves bytes ready → hidden on both axes', async () => {
      const photo = await seedPendingRow(db, projectId, {
        sizeBytes: 4096,
        ciphertextSizeBytes: 4160,
        ciphertextThumbSizeBytes: 320,
        kind: 'photo',
      });
      await completeUpload(db, photo.id);
      await hideRow(db, photo.id);

      expect(await readUsageRow(db, projectId)).toEqual({
        ready: { plaintext: 0, ciphertext: 0 },
        hidden: { plaintext: 4096, ciphertext: 4480 },
      });
    });

    it('restore (hidden → ready) moves bytes hidden → ready on both axes', async () => {
      const photo = await seedPendingRow(db, projectId, {
        sizeBytes: 4096,
        ciphertextSizeBytes: 4160,
        ciphertextThumbSizeBytes: 320,
        kind: 'photo',
      });
      await completeUpload(db, photo.id);
      await hideRow(db, photo.id);
      await restoreRow(db, photo.id);

      expect(await readUsageRow(db, projectId)).toEqual({
        ready: { plaintext: 4096, ciphertext: 4480 },
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
        ready: { plaintext: 8192, ciphertext: 8256 + 576 },
        hidden: { plaintext: 0, ciphertext: 0 },
      });

      // Complete the binary.
      await completeUpload(db, binary.id);
      expect(await readUsageRow(db, projectId)).toEqual({
        ready: {
          plaintext: 8192 + 16384,
          ciphertext: 8256 + 576 + 16448,
        },
        hidden: { plaintext: 0, ciphertext: 0 },
      });

      // Hide the photo (Papierkorb).
      await hideRow(db, photo.id);
      expect(await readUsageRow(db, projectId)).toEqual({
        ready: { plaintext: 16384, ciphertext: 16448 },
        hidden: { plaintext: 8192, ciphertext: 8256 + 576 },
      });

      // Restore the photo.
      await restoreRow(db, photo.id);
      expect(await readUsageRow(db, projectId)).toEqual({
        ready: {
          plaintext: 8192 + 16384,
          ciphertext: 8256 + 576 + 16448,
        },
        hidden: { plaintext: 0, ciphertext: 0 },
      });

      // Hide the binary.
      await hideRow(db, binary.id);
      expect(await readUsageRow(db, projectId)).toEqual({
        ready: { plaintext: 8192, ciphertext: 8256 + 576 },
        hidden: { plaintext: 16384, ciphertext: 16448 },
      });

      // Hidden reaper purges the hidden binary.
      await deleteRow(db, binary.id);
      expect(await readUsageRow(db, projectId)).toEqual({
        ready: { plaintext: 8192, ciphertext: 8256 + 576 },
        hidden: { plaintext: 0, ciphertext: 0 },
      });
    });

    it('multi-row UPDATE on the same project (bulk hide) ends with correct totals', async () => {
      // Five ready rows; one bulk UPDATE flips them all to hidden. The
      // FOR EACH ROW trigger fires per-row N times within one statement
      // — pinning that the cumulative deltas converge on the right
      // totals (a class of bug a single-row test cannot catch: a
      // trigger that aliases NEW/OLD across the row loop, or that
      // double-counts under multi-row firing). The
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
      // zero delta: a row mutation that changes neither `status` nor
      // any byte field leaves every total unchanged.
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

      // Renames cover `label` and `filename` — pin the label
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
  // GET /api/storage-usage contract (data:export gate, api.md §14.3).
  // -------------------------------------------------------------------
  describe('GET /api/storage-usage contract', () => {
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

    it('returns all-zero buckets when no attachments exist anywhere (AC-447)', async () => {
      // Wipe every attachment on every project; the per-row trigger
      // decrements all `project_storage_usage` rows back to zero
      // (statement runs at depth 1 → no cascade short-circuit).
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

    it('global totals equal the sum over every complete attachment, archived projects included (AC-447)', async () => {
      // Archive (soft-delete per §6.9) is a board-state concept; the
      // attachments still exist and count until purge cascades them away.
      // One archived project carries every bucket case: a ready binary, a
      // ready photo with its thumbnail, a hidden binary, and a pending row
      // that must count toward nothing. Plaintext totals cover originals
      // only (data-model.md §5.14), so the thumbnail counts only as stored bytes.
      await db.execute(sql`DELETE FROM attachments`);
      const archivedProjectId = await createProject(ownerToken);
      const readyBinary = await seedPendingRow(db, archivedProjectId, {
        sizeBytes: 7777,
        ciphertextSizeBytes: 7841,
      });
      await completeUpload(db, readyBinary.id);
      const readyPhoto = await seedPendingRow(db, archivedProjectId, {
        sizeBytes: 4096,
        ciphertextSizeBytes: 4160,
        ciphertextThumbSizeBytes: 320,
        kind: 'photo',
      });
      await completeUpload(db, readyPhoto.id);
      const hiddenBinary = await seedPendingRow(db, archivedProjectId, {
        sizeBytes: 1000,
        ciphertextSizeBytes: 1064,
      });
      await completeUpload(db, hiddenBinary.id);
      await hideRow(db, hiddenBinary.id);
      await seedPendingRow(db, archivedProjectId, {
        sizeBytes: 500,
        ciphertextSizeBytes: 564,
      });

      // Soft-delete via DELETE-without-/purge — same surface that
      // drives `archiveProject` in attachments-purge-cascade.test.ts.
      const archiveRes = await authDelete(ownerToken, `/api/projects/${archivedProjectId}`);
      expect(archiveRes.statusCode).toBe(200);

      const res = await authGet(ownerToken, '/api/storage-usage');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ready: { plaintext: 7777 + 4096, ciphertext: 7841 + 4160 + 320 },
        hidden: { plaintext: 1000, ciphertext: 1064 },
      });
    });
  });
});
