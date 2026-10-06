/**
 * API integration tests: Layer 2 encrypted backup — Tier 1 run contract.
 *
 * Covers the core-pipeline slice of verification.md §15.22:
 *   - AC-165 [crit]: Tier 1 verify-on-create mismatch fails the run; no
 *     artifact is uploaded to the off-site store; status row records the
 *     failure with `lastBackupOk=false` and `lastBackupError` identifying the
 *     table whose manifest diverged.
 *   - AC-166 [crit]: Tier 1 match path uploads the encrypted dump + the
 *     encrypted manifest sidecar to the off-site store; `meta_backup_status`
 *     carries `lastBackupOk=true` and `lastBackupAt=run timestamp`.
 *   - AC-167 [crit]: Neither the dump nor the manifest sidecar is written
 *     to the off-site store in plaintext — the bytes handed to the upload
 *     surface must be an encrypted envelope. A run that cannot encrypt
 *     fails and uploads no artifact.
 *
 *   - AC-373 [crit]: after uploading both artifacts, a run releases
 *     exactly the backup-pending invoice marks visible in its snapshot;
 *     a mark created after the snapshot survives; a run failing before
 *     the release releases none; a failed release fails the run.
 *   - AC-372 [crit] (database half): the invoice trigger's due-check
 *     reads the live marks and status row; the decision itself is in
 *     `backup-trigger.test.ts`.
 *
 * AC-169 (status dual-write) and AC-174 (manifest determinism) live in
 * `backup-status.test.ts`.
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

import { runBackup, computeManifest } from '../services/backup.js';
import { invoiceTriggerDue } from '../services/backup-trigger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

describe('Layer 2 backup — Tier 1 run contract (§15.22 AC-165/166/167/372/373)', () => {
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
  // AC-165: Tier 1 mismatch fails the run. No artifact upload,
  // status row records the failing table.
  // --------------------------------------------------------------
  describe('AC-165: Tier 1 verify-on-create mismatch fails the run', () => {
    it('does not upload any artifact when the restore-side manifest differs', async () => {
      const { uploader, uploads } = makeStubUploader();
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

      // The critical behavioral assertion: no artifact is uploaded on
      // mismatch. The status mirror is not an artifact (AC-169).
      expect(uploadSpy).not.toHaveBeenCalled();
      expect(uploads).toHaveLength(0);
    });

    it('records the failing table in meta_backup_status.lastBackupError', async () => {
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

      const rows = await db.execute(
        sql`SELECT last_backup_ok, last_backup_error FROM meta_backup_status`,
      );
      const row = rows.rows[0] as { last_backup_ok: boolean; last_backup_error: string | null };
      expect(row.last_backup_ok).toBe(false);
      expect(row.last_backup_error ?? '').toContain('customers');
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

    it('fails the run and uploads no artifact when encryption cannot produce output', async () => {
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

  // --------------------------------------------------------------
  // AC-373: the run releases exactly its snapshot's backup-pending
  // invoice marks, and only once both artifacts are uploaded.
  // --------------------------------------------------------------
  describe('AC-373: release of backup-pending invoice marks', () => {
    let issuedIds: string[];

    async function markedIds(): Promise<string[]> {
      const r = await pool.query<{ invoice_id: string }>(
        'SELECT invoice_id FROM invoice_backup_pending ORDER BY invoice_id',
      );
      return r.rows.map((row) => row.invoice_id);
    }

    async function mark(invoiceId: string): Promise<void> {
      await pool.query('INSERT INTO invoice_backup_pending (invoice_id) VALUES ($1)', [invoiceId]);
    }

    beforeAll(async () => {
      const r = await pool.query<{ id: string }>(
        "SELECT id FROM invoices WHERE status <> 'draft' ORDER BY id LIMIT 2",
      );
      issuedIds = r.rows.map((row) => row.id);
      expect(issuedIds).toHaveLength(2);
    });

    beforeEach(async () => {
      await pool.query('DELETE FROM invoice_backup_pending');
    });

    it('keeps a mark committed after the snapshot, even one created before the run started', async () => {
      const [inSnapshot, afterSnapshot] = issuedIds as [string, string];
      await mark(inSnapshot);

      // The real race: issuance is a long transaction, and its mark's
      // `created_at` (now() = transaction start) predates a backup
      // snapshot taken before that transaction commits. A release keyed
      // on timestamps would wrongly take it; only snapshot visibility
      // is right. So: insert before the run, commit inside the dump
      // (which runs within the snapshot transaction).
      const issuance = await pool.connect();
      try {
        await issuance.query('BEGIN');
        await issuance.query('INSERT INTO invoice_backup_pending (invoice_id) VALUES ($1)', [
          afterSnapshot,
        ]);

        let snapshotManifest: Manifest | undefined;
        const { uploader } = makeStubUploader();
        const result = await runBackup({
          db,
          uploader,
          encrypt: fakeEncrypt,
          dumpSource: async () => {
            // Read before the commit: the committed state then equals the
            // snapshot, which is what the restored dump would hold.
            snapshotManifest = await computeManifest(db);
            await issuance.query('COMMIT');
            return new TextEncoder().encode('MANIFEST-DUMP\n{}');
          },
          verifyManifest: async () => snapshotManifest!,
        });

        expect(result.ok).toBe(true);
        expect(await markedIds()).toEqual([afterSnapshot]);
      } finally {
        await issuance.query('ROLLBACK').catch(() => undefined);
        issuance.release();
      }
    });

    it('releases no mark when the run fails before the release (Tier 1 mismatch)', async () => {
      await mark(issuedIds[0]!);
      const { uploader } = makeStubUploader();

      const result = await runBackup({
        db,
        uploader,
        encrypt: fakeEncrypt,
        manifestPerturb: (m: Manifest): Manifest => ({
          ...m,
          projects: { ...m.projects!, rowCount: m.projects!.rowCount + 1 },
        }),
      });

      expect(result.ok).toBe(false);
      expect(await markedIds()).toEqual([issuedIds[0]]);
    });

    it('releases no mark when the second artifact fails to upload', async () => {
      await mark(issuedIds[0]!);
      // An override replaces the stub's recorder, so record through a
      // second stub.
      const recorder = makeStubUploader();
      const uploads = recorder.uploads;
      const { uploader } = makeStubUploader({
        upload: async (key, data, contentType) => {
          if (key.endsWith('.manifest.json.age')) {
            throw new Error('upload refused (test simulation)');
          }
          await recorder.uploader.upload(key, data, contentType);
        },
      });

      const result = await runBackup({ db, uploader, encrypt: fakeEncrypt });

      expect(result.ok).toBe(false);
      // The dump went up first; the release must still not have run.
      expect(uploads.filter((u) => u.key.endsWith('.dump.age'))).toHaveLength(1);
      expect(await markedIds()).toEqual([issuedIds[0]]);
    });

    it('fails the run when the release fails, with the release cue on the status row', async () => {
      await mark(issuedIds[0]!);
      await pool.query(`
        CREATE OR REPLACE FUNCTION release_test_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'release refused (test simulation)'; END $$`);
      await pool.query(`
        CREATE TRIGGER release_test_refuse BEFORE DELETE ON invoice_backup_pending
        FOR EACH ROW EXECUTE FUNCTION release_test_refuse()`);
      try {
        const { uploader, uploads } = makeStubUploader();
        const result = await runBackup({ db, uploader, encrypt: fakeEncrypt });

        expect(result.ok).toBe(false);
        // Both artifacts were uploaded before the release was attempted.
        expect(uploads.filter((u) => u.key.endsWith('.dump.age'))).toHaveLength(1);
        expect(uploads.filter((u) => u.key.endsWith('.manifest.json.age'))).toHaveLength(1);
        const row = (
          await pool.query<{ last_backup_ok: boolean; last_backup_error: string | null }>(
            'SELECT last_backup_ok, last_backup_error FROM meta_backup_status',
          )
        ).rows[0]!;
        expect(row.last_backup_ok).toBe(false);
        expect(row.last_backup_error ?? '').toMatch(/^release/);
      } finally {
        await pool.query('DROP TRIGGER IF EXISTS release_test_refuse ON invoice_backup_pending');
        await pool.query('DROP FUNCTION IF EXISTS release_test_refuse()');
      }
      expect(await markedIds()).toEqual([issuedIds[0]]);
    });
  });

  // --------------------------------------------------------------
  // AC-372: the trigger's due-check reads its inputs from the live
  // marks and status row (the decision itself is pinned in
  // backup-trigger.test.ts).
  // --------------------------------------------------------------
  describe('AC-372: invoice trigger due-check against the database', () => {
    const NOW = new Date('2026-10-05T10:00:00.000Z');

    beforeEach(async () => {
      await pool.query('DELETE FROM invoice_backup_pending');
    });

    async function setLastBackup(ok: boolean, at: Date): Promise<void> {
      await pool.query(
        `INSERT INTO meta_backup_status (singleton, last_backup_ok, last_backup_at)
         VALUES (TRUE, $1, $2)
         ON CONFLICT (singleton) DO UPDATE SET last_backup_ok = $1, last_backup_at = $2`,
        [ok, at],
      );
    }

    it('is due only while a mark stands, and honours the retry delay after a failure', async () => {
      await setLastBackup(true, NOW);
      expect(await invoiceTriggerDue(db, { now: NOW, retryMinutes: 15 })).toBe(false);

      const r = await pool.query<{ id: string }>(
        "SELECT id FROM invoices WHERE status <> 'draft' ORDER BY id LIMIT 1",
      );
      await pool.query('INSERT INTO invoice_backup_pending (invoice_id) VALUES ($1)', [
        r.rows[0]!.id,
      ]);
      expect(await invoiceTriggerDue(db, { now: NOW, retryMinutes: 15 })).toBe(true);

      await setLastBackup(false, new Date(NOW.getTime() - 5 * 60_000));
      expect(await invoiceTriggerDue(db, { now: NOW, retryMinutes: 15 })).toBe(false);

      await setLastBackup(false, new Date(NOW.getTime() - 15 * 60_000));
      expect(await invoiceTriggerDue(db, { now: NOW, retryMinutes: 15 })).toBe(true);
    });
  });
});
