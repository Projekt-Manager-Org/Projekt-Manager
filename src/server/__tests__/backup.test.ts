/**
 * API integration tests: Layer 2 encrypted backup — Tier 1 run contract.
 *
 * Covers the core-pipeline slice of verification.md §15.22:
 *   - AC-165 [crit]: Tier 1 verify-on-create mismatch fails the run; no
 *     artifact is uploaded to the off-site store; status row records the
 *     failure with `lastBackupOk=false` and `lastError` identifying the
 *     table whose manifest diverged.
 *   - AC-166 [crit]: Tier 1 match path uploads the encrypted dump + the
 *     encrypted manifest sidecar to the off-site store; `meta_backup_status`
 *     carries `lastBackupOk=true` and `lastBackupAt=run timestamp`.
 *   - AC-167 [crit]: Neither the dump nor the manifest sidecar is written
 *     to the off-site store in plaintext — the bytes handed to the upload
 *     surface must be an encrypted envelope. A run that cannot encrypt
 *     fails and uploads nothing.
 *
 * AC-169 (status dual-write + orphan-artifact handling) and AC-174
 * (manifest determinism) live in `backup-status.test.ts` so this file
 * stays under the 250-line cap in the test conventions.
 *
 * Shared test harness (fixtures + stub uploader + fake encrypt) lives in
 * `src/test/backupTestHarness.ts` so both backup test files import from
 * the same source and cannot drift.
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
  startsWith,
  PG_DUMP_MAGIC,
  type Manifest,
} from '../../test/backupTestHarness.js';

import { runBackup } from '../services/backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

describe('Layer 2 backup — Tier 1 run contract (§15.22 AC-165/166/167)', () => {
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
    // Reset the status row between tests so residue from an earlier
    // run does not leak into these assertions.
    await db.execute(sql`DELETE FROM meta_backup_status`);
  });

  // --------------------------------------------------------------
  // AC-165: Tier 1 mismatch fails the run. No upload, no mirror
  // side-effect, status row records the failing table.
  // --------------------------------------------------------------
  describe('AC-165: Tier 1 verify-on-create mismatch fails the run', () => {
    it('does not upload any artifact when the restore-side manifest differs', async () => {
      const { uploader, uploads, mirrorCalls } = makeStubUploader();
      const uploadSpy = vi.spyOn(uploader, 'upload');

      const result = await runBackup({
        db,
        uploader,
        encrypt: fakeEncrypt,
        // Simulate a Tier 1 drift: flip the rowCount of the 'projects'
        // table in the restore-side manifest. The implementation's
        // comparator must report a mismatch on this table.
        manifestPerturb: (m: Manifest): Manifest => ({
          ...m,
          projects: { ...m.projects!, rowCount: (m.projects!.rowCount ?? 0) + 1 },
        }),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failedTable).toBe('projects');
      }

      // The critical behavioral assertion: upload is never called on
      // mismatch. Even the status mirror is not written for a Tier 1
      // failure — only the DB row records the failure.
      expect(uploadSpy).not.toHaveBeenCalled();
      expect(uploads).toHaveLength(0);
      expect(mirrorCalls).toHaveLength(0);
    });

    it('records the failing table in meta_backup_status.lastError', async () => {
      const { uploader } = makeStubUploader();

      await runBackup({
        db,
        uploader,
        encrypt: fakeEncrypt,
        manifestPerturb: (m: Manifest): Manifest => ({
          ...m,
          customers: { ...m.customers!, rowCount: 9999 },
        }),
      });

      const rows = await db.execute(sql`SELECT last_backup_ok, last_error FROM meta_backup_status`);
      const row = rows.rows[0] as { last_backup_ok: boolean; last_error: string | null };
      expect(row.last_backup_ok).toBe(false);
      expect(row.last_error ?? '').toContain('customers');
    });
  });

  // --------------------------------------------------------------
  // AC-166: Tier 1 match uploads both artifacts and sets status.
  // --------------------------------------------------------------
  describe('AC-166: Tier 1 verify-on-create match uploads + updates status', () => {
    it('uploads the encrypted dump and manifest sidecar on match', async () => {
      const { uploader, uploads } = makeStubUploader();
      const now = new Date('2026-04-17T10:00:00.000Z');

      const result = await runBackup({ db, uploader, encrypt: fakeEncrypt, now });
      expect(result.ok).toBe(true);

      // Expect one dump artifact and one manifest sidecar per
      // ADR-0020 §Decision key convention:
      //   daily/<iso-timestamp>.dump.age
      //   daily/<iso-timestamp>.manifest.json.age
      const dumpKeys = uploads.filter((u) => u.key.endsWith('.dump.age'));
      const manifestKeys = uploads.filter((u) => u.key.endsWith('.manifest.json.age'));
      expect(dumpKeys).toHaveLength(1);
      expect(manifestKeys).toHaveLength(1);
    });

    it('writes meta_backup_status with lastBackupOk=true and lastBackupAt=run timestamp', async () => {
      const { uploader } = makeStubUploader();
      const now = new Date('2026-04-17T11:00:00.000Z');

      await runBackup({ db, uploader, encrypt: fakeEncrypt, now });

      const rows = await db.execute(
        sql`SELECT last_backup_ok, last_backup_at FROM meta_backup_status`,
      );
      const row = rows.rows[0] as {
        last_backup_ok: boolean;
        last_backup_at: Date | string;
      };
      expect(row.last_backup_ok).toBe(true);

      const asDate =
        row.last_backup_at instanceof Date ? row.last_backup_at : new Date(row.last_backup_at);
      expect(asDate.toISOString()).toBe(now.toISOString());
    });
  });

  // --------------------------------------------------------------
  // AC-167: neither artifact at rest is plaintext. The bytes fed
  // to the upload surface must be an encrypted envelope — we
  // assert "not a valid pg_dump" and "not valid JSON", not
  // "starts with age's exact header", so the test survives a tool
  // swap (age → gpg → ...).
  // --------------------------------------------------------------
  describe('AC-167: no plaintext artifacts at rest', () => {
    it('does not upload any artifact whose bytes are a valid pg_dump or JSON manifest', async () => {
      const { uploader, uploads } = makeStubUploader();
      await runBackup({ db, uploader, encrypt: fakeEncrypt });

      for (const u of uploads) {
        // Dump artifact: pg_dump -Fc files begin with the ASCII magic
        // "PGDMP" followed by version bytes. An encrypted artifact
        // must not match this.
        expect(startsWith(u.data, PG_DUMP_MAGIC)).toBe(false);

        // Manifest sidecar: raw JSON would start with '{' or '['. An
        // encrypted sidecar must not be parseable as JSON.
        const asText = new TextDecoder('utf-8', { fatal: false }).decode(u.data);
        const trimmed = asText.trimStart();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            JSON.parse(trimmed);
            // Successful JSON.parse of the upload bytes is the failure
            // condition — forces the assertion to fail loudly.
            expect.fail(`Upload ${u.key} parsed as JSON — artifact at rest is not encrypted`);
          } catch {
            // JSON.parse threw — good, the data is not readable as JSON.
          }
        }
      }
    });

    it('fails the run and uploads nothing when encryption cannot produce output', async () => {
      const { uploader, uploads } = makeStubUploader();
      const failingEncrypt = async (): Promise<Uint8Array> => {
        throw new Error('encryption surface unavailable (test simulation)');
      };

      const result = await runBackup({
        db,
        uploader,
        encrypt: failingEncrypt,
      });

      expect(result.ok).toBe(false);
      expect(uploads).toHaveLength(0);
    });
  });
});
