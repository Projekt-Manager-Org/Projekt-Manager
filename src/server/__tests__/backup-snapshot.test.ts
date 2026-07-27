/**
 * API integration tests: Layer 2 backup — source/dump snapshot equality.
 *
 * Covers verification.md §15.22:
 *   - AC-344 [crit]: the source manifest and the dump artifact come from
 *     a single database snapshot, so a run overlapping concurrent
 *     committed writes still passes Tier 1 and uploads. A run that
 *     cannot establish the shared snapshot fails and uploads nothing
 *     rather than falling back to an independently-snapshotted dump.
 *
 * The production dump source is `pg_dump -Fc --snapshot=<id>` on its own
 * connection. These tests stand in for it with a second connection that
 * imports the same exported snapshot via `SET TRANSACTION SNAPSHOT` —
 * the identical Postgres mechanism, minus the subprocess. That keeps the
 * suite on the Postgres the integration project already requires:
 * `pg_dump` / `pg_restore` / `initdb` are not installed in CI, so a test
 * driving the real binaries would first need `postgresql-17` added to
 * the CI image and to CONTRIBUTING § Runtime Requirements.
 *
 * The race lives in `runBackup`'s orchestration, not inside pg_dump, so
 * the subprocess buys no additional coverage there. What it would cover
 * — `pgDumpSource` actually reaching the binary — is the pre-existing
 * untested-production-path gap tracked out of #297; the argv it builds
 * is pinned by the last block here.
 *
 * Shared fixtures (stub uploader + fake encrypt) come from
 * `src/test/backupTestHarness.ts`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { createDatabase, type Database } from '../db/connection.js';
import { seed } from '../seed.js';
import { makeStubUploader, fakeEncrypt } from '../../test/backupTestHarness.js';
import {
  runBackup,
  computeManifest,
  pgDumpArgs,
  type DumpSource,
  type Manifest,
  type VerifyManifestFn,
} from '../services/backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

/** Table the concurrent writer touches — in `MANIFEST_TABLES`, written on ordinary traffic. */
const CONTENDED_TABLE = 'sessions';

describe('Layer 2 backup — source/dump snapshot equality (§15.22 AC-344)', () => {
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
      // Same restore the other backup suites do — the per-fork DB is
      // shared across test files, so hand back the migration's
      // pre-seed singleton rather than our fixture state.
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

  afterEach(async () => {
    // Drop the rows the concurrent writer added so a later file does not
    // inherit them.
    await db.execute(sql`DELETE FROM sessions WHERE token LIKE 'ac344-%'`);
  });

  /**
   * Commit one row into `CONTENDED_TABLE` on a connection of its own —
   * the ordinary-traffic write (a login) that the run must tolerate.
   */
  const commitConcurrentWrite = async (): Promise<void> => {
    const inserted = await db.execute(sql`
      INSERT INTO sessions (user_id, token, expires_at)
      SELECT id, ${`ac344-${randomUUID()}`}, now() + interval '1 hour'
      FROM users
      LIMIT 1
    `);
    // Without this the INSERT ... SELECT silently writes nothing on an
    // empty `users` table and the happy path below passes vacuously.
    expect(inserted.rowCount).toBe(1);
  };

  /**
   * Stand-in for `pg_dump --snapshot=<id>`. Commits the concurrent write,
   * then reads every manifest table on a separate connection and returns
   * what it saw, serialized.
   *
   * `importSnapshot: false` reproduces the pre-fix wiring — own
   * connection, own snapshot — and drives the negative control.
   *
   * Runs inside the still-open source transaction, so this checks out
   * two more clients (the write, then the read) on top of the one that
   * transaction holds. Fine against pg's default pool max of 10; a pool
   * capped at 2 or below would deadlock here.
   */
  const makeDumpSource = (importSnapshot: boolean): DumpSource => {
    return async (snapshotId: string) => {
      await commitConcurrentWrite();
      const manifest = await db.transaction(
        async (tx) => {
          // Must precede any query in this transaction, which is exactly
          // where Drizzle puts the callback's first statement.
          if (importSnapshot) {
            await tx.execute(sql.raw(`SET TRANSACTION SNAPSHOT '${snapshotId}'`));
          }
          await tx.execute(sql`SET LOCAL TIME ZONE 'UTC'`);
          return computeManifest(tx);
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
      return new TextEncoder().encode(JSON.stringify(manifest));
    };
  };

  /**
   * Hands the dump's own reading straight back as the restore-side
   * manifest. Tier 1 then compares source against dump and nothing else,
   * which is precisely the AC-344 question.
   */
  const verifyManifest: VerifyManifestFn = async (dump: Uint8Array) =>
    JSON.parse(new TextDecoder().decode(dump)) as Manifest;

  it('tolerates a write committed between the source manifest and the dump', async () => {
    const { uploader, uploads } = makeStubUploader();

    const result = await runBackup({
      db,
      uploader,
      encrypt: fakeEncrypt,
      dumpSource: makeDumpSource(true),
      verifyManifest,
    });

    // `runBackup` funnels every throw from the dump side into `error`,
    // including the fixture's own assertions — surface it or a failure
    // here reads as a bare "expected false to be true".
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(uploads.filter((u) => u.key.endsWith('.dump.age'))).toHaveLength(1);
  });

  it('fails Tier 1 on that same write when the dump does not share the snapshot', async () => {
    // Negative control. Without it the test above cannot distinguish
    // "the snapshot is shared" from "the write never landed".
    const { uploader, uploads } = makeStubUploader();

    const result = await runBackup({
      db,
      uploader,
      encrypt: fakeEncrypt,
      dumpSource: makeDumpSource(false),
      verifyManifest,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedTable).toBe(CONTENDED_TABLE);
    }
    expect(uploads).toHaveLength(0);
  });

  it('fails the run and uploads nothing when the dump cannot use the snapshot', async () => {
    // The refusal half of AC-344: no silent fall back to a dump read
    // from a snapshot of its own. Stands in for `pg_dump` rejecting the
    // exported id (e.g. the exporting transaction was killed).
    const { uploader, uploads, mirrorCalls } = makeStubUploader();

    const result = await runBackup({
      db,
      uploader,
      encrypt: fakeEncrypt,
      dumpSource: async () => {
        throw new Error('pg_dump: error: invalid snapshot identifier (test simulation)');
      },
      verifyManifest,
    });

    expect(result.ok).toBe(false);
    expect(uploads).toHaveLength(0);
    expect(mirrorCalls).toHaveLength(0);

    const rows = await db.execute(sql`SELECT last_backup_ok, last_error FROM meta_backup_status`);
    const row = rows.rows[0] as { last_backup_ok: boolean; last_error: string | null };
    expect(row.last_backup_ok).toBe(false);
    // The classification is the system-owned part; the message tail is
    // this test's own throw echoed back.
    expect(row.last_error ?? '').toContain('source-capture');
    expect(row.last_error ?? '').toContain('invalid snapshot identifier');
  });
});

describe('Layer 2 backup — pg_dump argv (§15.22 AC-344)', () => {
  // The two production-path details this fix turns on. Nothing else in
  // the suite reaches `pgDumpSource`, so without these a dropped flag
  // is silent with every other test still green.

  it('passes the exported snapshot id to pg_dump', () => {
    expect(pgDumpArgs('00000003-0000001B-1')).toContain('--snapshot=00000003-0000001B-1');
  });

  it('bounds how long pg_dump waits for a table lock', () => {
    // Unbounded, a concurrent ACCESS EXCLUSIVE request wedges pg_dump
    // behind the manifest transaction that is itself waiting on pg_dump
    // — a cycle the DB cannot see, which stalls the schedule for good.
    const lockWait = pgDumpArgs('00000003-0000001B-1').find((a) =>
      a.startsWith('--lock-wait-timeout='),
    );
    expect(lockWait).toBeDefined();
    expect(Number(lockWait?.split('=')[1])).toBeGreaterThan(0);
  });
});
