/**
 * Integration test — reconcilability invariant on the per-project
 * storage usage view (AC-267 in verification.md §15.26).
 *
 * AC-263 pins the trigger semantics by computing expected counter
 * values from the test fixture and asserting equality against the
 * view. AC-267 pins a stronger property: at any checkpoint the view
 * equals the row aggregate computed *independently* over `attachments`,
 * grouped by `status`. The test treats the two surfaces as oracles —
 * if a future trigger bug or operator-applied direct SQL drives them
 * apart, the assertion fails regardless of which side is wrong.
 *
 * Multi-project fixture (two projects with a photo + binary mix on
 * each) catches a class of bug AC-263 cannot: a trigger that updates
 * the wrong project_id (e.g. always updates the first project found in
 * the table) would still satisfy AC-263 on a single-project test but
 * would corrupt cross-project totals. The invariant fires per-project
 * at every checkpoint.
 *
 * `[infra]` — the assertion is a structural invariant on the data
 * layer; not a behaviour observable through the API. This test is the
 * whole reconciliation safety net: running the same comparison on a
 * schedule against live state was weighed at #172 and dropped.
 *
 * Pre-impl red state: `project_storage_usage` does not exist yet, so
 * the view-side of the comparison throws "relation does not exist" —
 * surfaces as a per-test failure.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

import { createDatabase } from '../db/connection.js';
import type { Database } from '../db/connection.js';
import { seed } from '../seed.js';
import { validateEnvRuntime } from '../config/env.js';

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
  projectId: string;
  sizeBytes: number;
  thumbSizeBytes: number | null;
  ciphertextSizeBytes: number;
  ciphertextThumbSizeBytes: number | null;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

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
            ${'inv-' + id.slice(0, 6)},
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
    projectId,
    sizeBytes: opts.sizeBytes,
    thumbSizeBytes: opts.thumbSizeBytes ?? null,
    ciphertextSizeBytes: opts.ciphertextSizeBytes,
    ciphertextThumbSizeBytes: opts.ciphertextThumbSizeBytes ?? null,
  };
}

async function completeUpload(db: Database, id: string): Promise<void> {
  const wrappedDek = Buffer.alloc(192, 0x55).toString('base64');
  await db.execute(sql`
    UPDATE attachments SET status = 'ready', wrapped_dek = ${wrappedDek} WHERE id = ${id}
  `);
}

async function hideRow(db: Database, id: string): Promise<void> {
  await db.execute(sql`
    UPDATE attachments SET status = 'hidden', hidden_at = now() WHERE id = ${id}
  `);
}

async function restoreRow(db: Database, id: string): Promise<void> {
  await db.execute(sql`
    UPDATE attachments SET status = 'ready', hidden_at = NULL WHERE id = ${id}
  `);
}

async function deleteRow(db: Database, id: string): Promise<void> {
  await db.execute(sql`DELETE FROM attachments WHERE id = ${id}`);
}

/**
 * Compute the per-project usage totals *from the rows*, grouping by
 * status. This is one of the two oracles the invariant compares.
 * Pending-status rows are excluded by the WHERE clause so they
 * contribute to neither bucket — pinning the same exclusion the
 * trigger applies (data-model.md §5.14).
 */
async function aggregateFromRows(db: Database, projectId: string): Promise<UsageTotals> {
  const r = await db.execute(sql`
    SELECT
      status,
      SUM(size_bytes + COALESCE(thumb_size_bytes, 0))::bigint AS plaintext,
      SUM(COALESCE(ciphertext_size_bytes, 0)
        + COALESCE(ciphertext_thumb_size_bytes, 0))::bigint AS ciphertext
    FROM attachments
    WHERE project_id = ${projectId} AND status IN ('ready', 'hidden')
    GROUP BY status
  `);
  const totals: UsageTotals = {
    ready: { plaintext: 0, ciphertext: 0 },
    hidden: { plaintext: 0, ciphertext: 0 },
  };
  for (const row of r.rows as Array<{
    status: 'ready' | 'hidden';
    plaintext: string | number;
    ciphertext: string | number;
  }>) {
    const bucket = totals[row.status];
    bucket.plaintext = Number(row.plaintext);
    bucket.ciphertext = Number(row.ciphertext);
  }
  return totals;
}

/**
 * Read the view directly. The OTHER oracle the invariant compares.
 * Returns null when no row exists (parent project has been purged) —
 * the caller then decides whether absence is the expected outcome.
 */
async function aggregateFromView(db: Database, projectId: string): Promise<UsageTotals | null> {
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

describe('AC-267: reconcilability invariant — view equals row aggregate', () => {
  let db: Database;
  let pool: pg.Pool;
  let projectAId: string;
  let projectBId: string;

  beforeAll(async () => {
    validateEnvRuntime();
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    await pool.query('SELECT 1');
    await migrate(db, { migrationsFolder });
    await seed(db, { force: true });

    // Pick two seed projects so cross-project arithmetic is observable.
    // Any two will do — the invariant cares about totals, not identity.
    const r = await db.execute(sql`SELECT id FROM projects ORDER BY id LIMIT 2`);
    const rows = r.rows as Array<{ id: string }>;
    if (rows.length < 2) {
      throw new Error('Seed produced fewer than 2 projects; need 2 for cross-project invariant');
    }
    projectAId = rows[0]!.id;
    projectBId = rows[1]!.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Wipe attachments between tests so each test asserts the
    // invariant on a deterministic fixture. The trigger fires on
    // every row deletion (depth=1, no cascade), so the per-project
    // view rows decrement to zero in lockstep.
    await db.execute(sql`DELETE FROM attachments`);
  });

  /**
   * The invariant. Asserts the two oracles agree for every project in
   * `ids`. The label disambiguates which checkpoint of a multi-step
   * test the failure occurred at.
   */
  async function assertInvariant(label: string, ids: readonly string[]): Promise<void> {
    for (const projectId of ids) {
      const fromRows = await aggregateFromRows(db, projectId);
      const fromView = await aggregateFromView(db, projectId);
      expect(fromView, `${label} :: project=${projectId} :: view exists`).not.toBeNull();
      expect(
        fromView,
        `${label} :: project=${projectId} :: view diverges from row aggregate`,
      ).toEqual(fromRows);
    }
  }

  it('holds at every checkpoint of the AC-263 lifecycle on multiple projects', async () => {
    const projectIds = [projectAId, projectBId] as const;

    // Empty state: every project has an init-trigger-seeded usage row
    // at zero, and the row aggregate is zero (no attachments yet).
    await assertInvariant('initial', projectIds);
    for (const id of projectIds) {
      expect(await aggregateFromView(db, id)).toEqual(ZERO_TOTALS);
    }

    // Project A: photo (with thumb) + binary; both pending.
    const aPhoto = await seedPendingRow(db, projectAId, {
      sizeBytes: 4096,
      thumbSizeBytes: 256,
      ciphertextSizeBytes: 4160,
      ciphertextThumbSizeBytes: 320,
      kind: 'photo',
    });
    const aBinary = await seedPendingRow(db, projectAId, {
      sizeBytes: 8192,
      ciphertextSizeBytes: 8256,
    });
    // Project B: photo (with thumb) only, pending.
    const bPhoto = await seedPendingRow(db, projectBId, {
      sizeBytes: 2048,
      thumbSizeBytes: 128,
      ciphertextSizeBytes: 2112,
      ciphertextThumbSizeBytes: 192,
      kind: 'photo',
    });
    await assertInvariant('after-pending-inserts', projectIds);

    // Complete every row → ready bucket on both projects.
    await completeUpload(db, aPhoto.id);
    await assertInvariant('after-complete-aPhoto', projectIds);
    await completeUpload(db, aBinary.id);
    await assertInvariant('after-complete-aBinary', projectIds);
    await completeUpload(db, bPhoto.id);
    await assertInvariant('after-complete-bPhoto', projectIds);

    // Hide aPhoto → A: photo bytes ready→hidden; B: untouched.
    // Absolute-value checkpoint here defends against the oracle-pair
    // failure mode (a bug that mis-handles thumbs symmetrically on both
    // oracles would satisfy the invariant at every step but corrupt the
    // actual totals). Pin all four leaves on both projects.
    await hideRow(db, aPhoto.id);
    await assertInvariant('after-hide-aPhoto', projectIds);
    expect(await aggregateFromRows(db, projectAId)).toEqual({
      ready: { plaintext: 8192, ciphertext: 8256 },
      hidden: { plaintext: 4096 + 256, ciphertext: 4160 + 320 },
    });
    expect(await aggregateFromRows(db, projectBId)).toEqual({
      ready: { plaintext: 2048 + 128, ciphertext: 2112 + 192 },
      hidden: { plaintext: 0, ciphertext: 0 },
    });

    // Restore aPhoto → bytes hidden→ready.
    await restoreRow(db, aPhoto.id);
    await assertInvariant('after-restore-aPhoto', projectIds);

    // Hide bPhoto → B: bytes ready→hidden; A: untouched.
    await hideRow(db, bPhoto.id);
    await assertInvariant('after-hide-bPhoto', projectIds);

    // Hidden-reaper purge of bPhoto → B: hidden bucket clears.
    await deleteRow(db, bPhoto.id);
    await assertInvariant('after-reap-bPhoto', projectIds);

    // Final state for sanity: A holds the photo + binary in ready;
    // B holds nothing. Pin the row-aggregate side directly here so a
    // bug that drives BOTH oracles to the same wrong value (e.g. the
    // aggregate query mis-grouping) cannot pass silently.
    expect(await aggregateFromRows(db, projectAId)).toEqual({
      ready: { plaintext: 4096 + 256 + 8192, ciphertext: 4160 + 320 + 8256 },
      hidden: { plaintext: 0, ciphertext: 0 },
    });
    expect(await aggregateFromRows(db, projectBId)).toEqual(ZERO_TOTALS);
  });

  it('holds after a multi-row UPDATE (bulk hide) on one project', async () => {
    // Three ready rows on A, one ready row on B. Bulk hide on A.
    // Pins that the per-row trigger firing N times in one statement
    // converges on the same view state as the row aggregate.
    const aRows: SeededRow[] = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await seedPendingRow(db, projectAId, {
        sizeBytes: 1000 + i,
        ciphertextSizeBytes: 1064 + i,
      });
      await completeUpload(db, r.id);
      aRows.push(r);
    }
    const bRow = await seedPendingRow(db, projectBId, {
      sizeBytes: 5000,
      ciphertextSizeBytes: 5064,
    });
    await completeUpload(db, bRow.id);
    await assertInvariant('after-completes', [projectAId, projectBId]);

    await db.execute(sql`
      UPDATE attachments
      SET status = 'hidden', hidden_at = now()
      WHERE project_id = ${projectAId} AND status = 'ready'
    `);

    await assertInvariant('after-bulk-hide-A', [projectAId, projectBId]);

    // Sanity: A all-hidden, B unchanged.
    const aTotals = await aggregateFromRows(db, projectAId);
    expect(aTotals.ready.plaintext).toBe(0);
    expect(aTotals.hidden.plaintext).toBe(aRows.reduce((s, r) => s + r.sizeBytes, 0));
    const bTotals = await aggregateFromRows(db, projectBId);
    expect(bTotals.ready.plaintext).toBe(5000);
    expect(bTotals.hidden.plaintext).toBe(0);
  });

  it('holds when pending rows coexist with ready and hidden rows on the same project', async () => {
    // Pending must be excluded by both oracles. A row that flips
    // pending → deleted (orphan reaper) at the same time as ready and
    // hidden rows persist must not perturb the view.
    const pending = await seedPendingRow(db, projectAId, {
      sizeBytes: 4096,
      ciphertextSizeBytes: 4160,
    });
    const ready = await seedPendingRow(db, projectAId, {
      sizeBytes: 1024,
      ciphertextSizeBytes: 1088,
    });
    await completeUpload(db, ready.id);
    const hidden = await seedPendingRow(db, projectAId, {
      sizeBytes: 2048,
      ciphertextSizeBytes: 2112,
    });
    await completeUpload(db, hidden.id);
    await hideRow(db, hidden.id);

    await assertInvariant('mixed-statuses', [projectAId]);

    // Sanity: pending row's bytes are not in any bucket.
    const totals = await aggregateFromRows(db, projectAId);
    expect(totals.ready.plaintext).toBe(1024);
    expect(totals.hidden.plaintext).toBe(2048);

    // Orphan reaper: delete the pending row. View must stay equal to
    // the row aggregate (which is unchanged because pending was
    // excluded).
    await deleteRow(db, pending.id);
    await assertInvariant('after-orphan-reaper', [projectAId]);
  });
});
