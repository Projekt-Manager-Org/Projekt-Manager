/**
 * API integration tests: Layer 2 backup — page-checksum precondition.
 *
 *   - AC-366 [crit]: A backup run against a source database without page
 *     checksums fails before producing an artifact — nothing uploaded,
 *     `lastBackupOk = false`, `lastBackupError` names the missing checksums.
 *
 * `data_checksums` is fixed at cluster init and cannot be switched per
 * test, so the off-case injects the setting's value at the read boundary.
 * The on-case needs no test here: every other backup run in the suite
 * executes the real read against a checksum-enabled cluster.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import path from 'path';
import { fileURLToPath } from 'url';
import type pg from 'pg';

import { createDatabase } from '../db/connection.js';
import type { Database } from '../db/connection.js';
import { makeStubUploader, fakeEncrypt } from '../../test/backupTestHarness.js';
import { runBackup } from '../services/backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

describe('Layer 2 backup — page-checksum precondition (§15.22 AC-366)', () => {
  let db: Database;
  let pool: pg.Pool;

  beforeAll(async () => {
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    await migrate(db, { migrationsFolder });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('fails before the dump, uploads no artifact, and names the missing checksums', async () => {
    const { uploader, uploads } = makeStubUploader();
    const dumpSource = vi.fn(async () => new Uint8Array());

    const result = await runBackup({
      db,
      uploader,
      encrypt: fakeEncrypt,
      dumpSource,
      readDataChecksums: async () => 'off',
    });

    expect(result.ok).toBe(false);
    expect(dumpSource).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(0);

    const rows = await db.execute(
      sql`SELECT last_backup_ok, last_backup_error FROM meta_backup_status`,
    );
    const row = rows.rows[0] as { last_backup_ok: boolean; last_backup_error: string | null };
    expect(row.last_backup_ok).toBe(false);
    expect(row.last_backup_error ?? '').toMatch(/^precondition: data checksums are off/);
  });
});
