/**
 * API integration tests: Layer 2 status dual-write + manifest determinism.
 *
 * Covers the status-surface and determinism slice of verification.md §15.22:
 *   - AC-169 [crit]: Every run, whatever its outcome, upserts
 *     `meta_backup_status` AND writes the unencrypted status mirror object
 *     with the same field values. If the mirror write throws, the failure
 *     is appended to `lastError` and any uploaded artifacts remain in
 *     place (R2 immutability window — no rollback of immutable objects).
 *     The drill half of AC-169 lives in `backup-drill.test.ts`.
 *   - AC-174 [crit]: The per-table manifest checksum is deterministic
 *     across runs on identical data. Non-deterministic checksums would
 *     invalidate Tier 1 and Tier 2 comparison.
 *
 * AC-165/166/167 (Tier 1 run contract) live in `backup.test.ts` — the
 * dual-write + determinism story is a separate failure mode from the
 * "run outcome" suite.
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
  readStatusRowAsMirror,
} from '../../test/backupTestHarness.js';

import {
  runBackup,
  computeManifest,
  type BackupStatusMirror,
  type Manifest,
  type RunBackupOptions,
} from '../services/backup.js';

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
  // AC-169: the mirror equals the DB row after every run, success or
  // failure; a failed mirror write is appended to `lastError`.
  // --------------------------------------------------------------
  describe('AC-169: status dual-write', () => {
    const rowAsMirror = (): Promise<BackupStatusMirror> => readStatusRowAsMirror(db);

    const fail = async (): Promise<never> => {
      throw new Error('stage failure (test simulation)');
    };

    // One case per failure stage: each records the row on its own path,
    // so each is a separate place the mirror write can be missed. The
    // mirror's `lastError` is the stage cue alone — detail stays in the
    // DB row, out of the plaintext off-site object.
    const stages: Array<[string, string, Partial<RunBackupOptions>]> = [
      ['precondition', 'precondition', { readDataChecksums: async () => 'off' }],
      ['source-capture', 'source-capture', { dumpSource: fail }],
      ['verify', 'verify', { verifyManifest: fail }],
      [
        'tier-1-mismatch',
        'tier-1-mismatch on users',
        {
          manifestPerturb: (m: Manifest): Manifest => ({
            ...m,
            users: { rowCount: -1, checksum: '' },
          }),
        },
      ],
      ['encrypt', 'encrypt', { encrypt: fail }],
      ['upload', 'upload', {}],
    ];

    it('writes the mirror equal to the DB row on success', async () => {
      const { uploader, mirrorCalls } = makeStubUploader();

      const result = await runBackup({ db, uploader, encrypt: fakeEncrypt });

      expect(result.ok).toBe(true);
      expect(mirrorCalls).toEqual([await rowAsMirror()]);
      expect((mirrorCalls[0] as BackupStatusMirror).lastBackupOk).toBe(true);
    });

    it.each(stages)(
      'writes the mirror equal to the DB row on a %s failure, error cut to %s',
      async (stage, cue, opts) => {
        const { uploader, mirrorCalls } = makeStubUploader(
          stage === 'upload' ? { upload: fail } : {},
        );

        const result = await runBackup({ db, uploader, encrypt: fakeEncrypt, ...opts });

        expect(result.ok).toBe(false);
        const row = await rowAsMirror();
        expect(row.lastBackupOk).toBe(false);
        expect(row.lastError ?? '').toMatch(new RegExp(`^${cue}`));
        expect(mirrorCalls).toEqual([{ ...row, lastError: cue }]);
      },
    );

    it('appends a mirror-write failure to lastError after artifacts uploaded', async () => {
      const putStatusMirror = vi.fn(async () => {
        throw new Error('mirror write failed (test simulation)');
      });
      const { uploader, uploads } = makeStubUploader({ putStatusMirror });

      const result = await runBackup({ db, uploader, encrypt: fakeEncrypt });

      // Artifacts are not rolled back (R2 immutability window), and the
      // run itself still succeeded.
      expect(result.ok).toBe(true);
      expect(uploads).toHaveLength(2);
      const row = await rowAsMirror();
      expect(row.lastBackupOk).toBe(true);
      expect(row.lastError).toBe('mirror: mirror write failed (test simulation)');
      // The follow-up write recording the failure is not mirrored.
      expect(putStatusMirror).toHaveBeenCalledTimes(1);
    });

    it("keeps the run's own failure cue when the mirror write also fails", async () => {
      const { uploader } = makeStubUploader({
        putStatusMirror: async () => {
          throw new Error('mirror write failed (test simulation)');
        },
      });

      await runBackup({ db, uploader, encrypt: fail });

      const row = await rowAsMirror();
      expect(row.lastBackupOk).toBe(false);
      expect(row.lastError ?? '').toMatch(/^encrypt: stage failure.*mirror: mirror write failed/);
    });
  });
});
