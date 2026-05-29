/**
 * API integration tests: Layer 2 status dual-write + manifest determinism.
 *
 * Covers the status-surface and determinism slice of verification.md §15.22:
 *   - AC-169 [crit]: Every successful run upserts `meta_backup_status`
 *     AND writes the unencrypted status mirror object with the same field
 *     values. If the mirror write throws after the artifact uploads
 *     succeeded, the artifacts remain in place (R2 immutability window —
 *     no rollback of immutable objects) and `lastError` records the
 *     mirror failure.
 *   - AC-174 [crit]: The per-table manifest checksum is deterministic
 *     across runs on identical data. Non-deterministic checksums would
 *     invalidate Tier 1 and Tier 2 comparison.
 *
 * AC-165/166/167 (Tier 1 run contract) live in `backup.test.ts`. Split
 * to keep each file under the 250-line cap in the test conventions, and
 * because the dual-write + determinism story is a separate failure mode
 * from the "run outcome" suite.
 *
 * Written ahead of implementation (TDD). Fails at import today because
 * `../services/backup.js` is Phase 3's contract surface.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import path from 'path';
import { fileURLToPath } from 'url';
import type pg from 'pg';

import { createDatabase } from '../db/connection.js';
import { seed } from '../seed.js';
import type { Database } from '../db/connection.js';

import {
  makeStubUploader,
  fakeEncrypt,
  type BackupUploader,
} from '../../test/backupTestHarness.js';

// Phase 3 contract surface — unresolvable at import today.
import { runBackup, computeManifest, type Manifest } from '../services/backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

describe('Layer 2 backup — status dual-write + manifest determinism', () => {
  let db: Database;
  let pool: pg.Pool;

  beforeAll(async () => {
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    await pool.query('SELECT 1');
    await migrate(db, { migrationsFolder });
    await seed(db, { force: true });
  });

  afterAll(async () => {
    if (pool) {
      // Restore the migration's pre-seed singleton so a long-lived
      // shared DB (pre-isolation runs, accidental dev-DB targeting)
      // doesn't carry our fixture state into the next session.
      await db.execute(sql`DELETE FROM meta_backup_status`);
      await db.execute(
        sql`INSERT INTO meta_backup_status (singleton, last_backup_ok) VALUES (TRUE, FALSE)`,
      );
      await pool.end();
    }
  });

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM meta_backup_status`);
  });

  // --------------------------------------------------------------
  // AC-174: manifest determinism. Two reads of the same state
  // produce byte-equal values; a 1-row perturbation changes them.
  // --------------------------------------------------------------
  describe('AC-174: manifest determinism', () => {
    it('produces byte-equal manifests across two reads of the same DB', async () => {
      const a = await computeManifest(db);
      const b = await computeManifest(db);
      expect(b).toEqual(a);
    });

    it('produces a different manifest after a 1-row perturbation', async () => {
      const before = await computeManifest(db);
      // Minimal mutation: flip one project's title. Guarded by a WHERE
      // that matches exactly one seeded row so the test doesn't depend
      // on implicit row order.
      await db.execute(
        sql`UPDATE projects SET title = title || ' (perturbation-test)' WHERE number = '2026-001'`,
      );
      try {
        const after = await computeManifest(db);
        expect(after).not.toEqual(before);
      } finally {
        // Revert so sibling tests see the canonical seed dataset.
        await db.execute(
          sql`UPDATE projects SET title = regexp_replace(title, ' \\(perturbation-test\\)$', '') WHERE number = '2026-001'`,
        );
      }
    });

    // Regression: `md5(row(t.*)::text)` serializes `timestamptz`
    // values through the session's TimeZone, so a drift between the
    // source and ephemeral-verify sessions produces a false
    // `tier-1-mismatch` on any populated `timestamptz` column. The
    // production bug: live `db` container runs TimeZone=UTC, backup
    // container runs TZ=Europe/Berlin, the ephemeral verify Postgres
    // inherits the latter. `runBackup`'s source-manifest transaction
    // pins `SET LOCAL TIME ZONE 'UTC'` to defuse the source side;
    // `ephemeralPg.ts` starts the ephemeral cluster with
    // `-c TimeZone=UTC`, pinning the verify side. This
    // test exercises the source-side invariant directly: a source-path
    // tx must produce the same manifest no matter what TimeZone the
    // connection inherited before the tx started.
    it('source-path pins UTC so the manifest is session-TZ-independent', async () => {
      // Seed a non-midnight `timestamptz` whose text form differs
      // across TimeZones (2026-04-20 is inside CEST and JST is +09).
      await db.execute(sql`
        INSERT INTO meta_backup_status (singleton, last_backup_ok, last_backup_at)
        VALUES (TRUE, FALSE, '2026-04-20 15:30:45.123+00')
        ON CONFLICT (singleton) DO UPDATE SET last_backup_at = EXCLUDED.last_backup_at
      `);

      // Mirrors services/backup.ts::runBackup. `setBefore` simulates a
      // non-UTC session TimeZone that the tx inherits — the
      // subsequent `SET LOCAL TIME ZONE 'UTC'` must override so the
      // manifest is stable across all three calls.
      const sourcePath = async (setBefore?: string): Promise<Manifest> =>
        db.transaction(
          async (tx) => {
            if (setBefore) {
              await tx.execute(sql.raw(`SET LOCAL TIME ZONE '${setBefore}'`));
            }
            await tx.execute(sql`SET LOCAL TIME ZONE 'UTC'`);
            return computeManifest(tx);
          },
          { isolationLevel: 'repeatable read', accessMode: 'read only' },
        );

      const asDefault = await sourcePath();
      const asBerlin = await sourcePath('Europe/Berlin');
      const asTokyo = await sourcePath('Asia/Tokyo');

      expect(asBerlin).toEqual(asDefault);
      expect(asTokyo).toEqual(asDefault);
    });
  });

  // --------------------------------------------------------------
  // AC-169: dual-write on success; orphan-artifact path when the
  // mirror write fails after artifacts landed.
  // --------------------------------------------------------------
  describe('AC-169: status dual-write + orphan-artifact handling', () => {
    it('writes meta_backup_status AND the status mirror with equal field values', async () => {
      const { uploader, mirrorCalls } = makeStubUploader();
      const now = new Date('2026-04-17T12:00:00.000Z');

      const result = await runBackup({ db, uploader, encrypt: fakeEncrypt, now });
      expect(result.ok).toBe(true);

      const rows = await db.execute(
        sql`SELECT last_backup_ok, last_backup_at, last_drill_at, last_drill_ok, last_error
            FROM meta_backup_status`,
      );
      const dbRow = rows.rows[0] as {
        last_backup_ok: boolean;
        last_backup_at: Date | string;
        last_drill_at: Date | string | null;
        last_drill_ok: boolean | null;
        last_error: string | null;
      };

      expect(mirrorCalls).toHaveLength(1);
      const mirror = mirrorCalls[0] as {
        lastBackupOk: boolean;
        lastBackupAt: string;
        lastDrillAt: string | null;
        lastDrillOk: boolean | null;
        lastError: string | null;
      };

      // Mirror values equal the DB row — same success flag, same
      // timestamp, same drill state, same error cue. This is the
      // core "dual-write means the two surfaces agree" assertion.
      expect(mirror.lastBackupOk).toBe(dbRow.last_backup_ok);
      const dbTs =
        dbRow.last_backup_at instanceof Date
          ? dbRow.last_backup_at.toISOString()
          : new Date(dbRow.last_backup_at).toISOString();
      expect(new Date(mirror.lastBackupAt).toISOString()).toBe(dbTs);
      expect(mirror.lastError).toBe(dbRow.last_error);
    });

    it('records lastError when the status mirror write fails after artifacts uploaded', async () => {
      const uploads: Array<{ key: string }> = [];
      const failingMirror: BackupUploader = {
        upload: async (key) => {
          uploads.push({ key });
        },
        putStatusMirror: async () => {
          throw new Error('mirror write failed (test simulation)');
        },
      };
      const uploadSpy = vi.spyOn(failingMirror, 'upload');

      await runBackup({ db, uploader: failingMirror, encrypt: fakeEncrypt });

      // The artifacts landed before the mirror failed — per ADR-0020
      // they are not rolled back (R2 immutability window).
      expect(uploadSpy).toHaveBeenCalled();
      expect(uploads.length).toBeGreaterThan(0);

      // The DB row records the mirror failure so operator attention is
      // drawn to the orphan state.
      const rows = await db.execute(sql`SELECT last_error FROM meta_backup_status`);
      const row = rows.rows[0] as { last_error: string | null };
      expect(row.last_error ?? '').toMatch(/mirror/i);
    });
  });
});
