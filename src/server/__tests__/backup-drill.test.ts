/**
 * API integration tests: Layer 2 Tier 2 drill (verify-on-cycle).
 *
 * Covers verification.md §15.22 AC-168 [crit]: when the operator's
 * private identity is absent from tmpfs, the Tier 2 drill is skipped.
 * A skip is NOT a failure — `lastDrillAt` and `lastDrillOk` are left
 * unchanged from their prior values, so freshness derivation reads
 * "stale" rather than "failed". Also the drill half of AC-169 [crit]:
 * a drill that writes the status row writes the mirror with it; a skip
 * writes neither. And the drill half of AC-345 [crit]: a failure while
 * fetching or opening the artifacts is recorded like any other.
 *
 * Separated from `backup.test.ts` because the drill exercises a
 * distinct code path (decrypt-side / operator-key surface), and
 * mixing the skip-branch into the tier-1 suite obscured which
 * artifact failed when both were red.
 *
 * The contract under test is `runDrill` in
 * `src/server/services/backup-drill.ts`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

import { createDatabase } from '../db/connection.js';
import { seed } from '../seed.js';
import type { Database } from '../db/connection.js';

import { runDrill } from '../services/backup-drill.js';
import type { Manifest } from '../services/backup.js';
import { makeStubUploader, readStatusRowAsMirror } from '../../test/backupTestHarness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

/** The downloaded pair; `passthrough` "decrypts" by returning the bytes as-is. */
const DUMP = new Uint8Array([1, 2, 3]);
const artifacts = async (
  manifest: Manifest,
): Promise<{ dump: Uint8Array; manifest: Uint8Array }> => ({
  dump: DUMP,
  manifest: new TextEncoder().encode(JSON.stringify(manifest)),
});
const passthrough = async (ciphertext: Uint8Array): Promise<Uint8Array> => ciphertext;

describe('Layer 2 drill — AC-168 skip, AC-169 mirror, AC-345 failure cue', () => {
  let db: Database;
  let pool: pg.Pool;
  let keyDir: string;

  beforeAll(async () => {
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    await pool.query('SELECT 1');
    await migrate(db, { migrationsFolder });
    await seed(db, { force: true });

    // Emulate a tmpfs-style mount point with a temp directory. The
    // drill MUST NOT assume a specific absolute path — the identity
    // path is passed through explicitly so the test can control it.
    keyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-drill-key-'));
  });

  afterAll(async () => {
    try {
      // Restore the migration's pre-seed singleton so a long-lived
      // shared DB (pre-isolation runs, accidental dev-DB targeting)
      // doesn't carry our fixture timestamp into the next session.
      if (pool) {
        await db.execute(sql`DELETE FROM meta_backup_status`);
        await db.execute(
          sql`INSERT INTO meta_backup_status (singleton, last_backup_ok) VALUES (TRUE, FALSE)`,
        );
      }
      await fs.rm(keyDir, { recursive: true, force: true });
    } finally {
      if (pool) await pool.end();
    }
  });

  beforeEach(async () => {
    // Seed a known prior state so "unchanged" is observable as
    // "equals the prior value", not "equals null by accident".
    await db.execute(sql`DELETE FROM meta_backup_status`);
    await db.execute(sql`
      INSERT INTO meta_backup_status
        (last_backup_ok, last_backup_at, last_drill_at, last_drill_ok, last_error, updated_at)
      VALUES
        (true,
         '2026-04-10T00:00:00.000Z',
         '2026-04-01T00:00:00.000Z',
         true,
         NULL,
         '2026-04-10T00:00:00.000Z')
    `);
  });

  it("returns outcome='skipped' when the identity path does not exist", async () => {
    const missing = path.join(keyDir, 'never-created.txt');

    const result = await runDrill({
      db,
      uploader: makeStubUploader().uploader,
      identityPath: missing,
      download: async () => {
        throw new Error('downloader must not be called when key is absent');
      },
      decrypt: async () => {
        throw new Error('decrypt must not be called when key is absent');
      },
    });

    expect(result.outcome).toBe('skipped');
    // A skip carries a reason cue so operators can disambiguate it
    // from a genuine drill failure in the log stream.
    expect(result.reason ?? '').toMatch(/key.?absent/i);
  });

  it("returns outcome='skipped' when the identity file exists but is empty", async () => {
    // Equally "absent" for our purpose — an empty tmpfs file represents
    // "operator ran load-drill-key.sh but nothing was piped in". The
    // drill still must not attempt to decrypt.
    const empty = path.join(keyDir, 'empty.txt');
    await fs.writeFile(empty, '');

    const result = await runDrill({
      db,
      uploader: makeStubUploader().uploader,
      identityPath: empty,
      download: async () => {
        throw new Error('downloader must not be called for an empty identity');
      },
      decrypt: async () => {
        throw new Error('decrypt must not be called for an empty identity');
      },
    });

    expect(result.outcome).toBe('skipped');
  });

  it('leaves lastDrillAt and lastDrillOk unchanged after a skip', async () => {
    const missing = path.join(keyDir, 'nope.txt');
    const before = await db.execute(
      sql`SELECT last_drill_at, last_drill_ok FROM meta_backup_status`,
    );
    const priorAt = (before.rows[0] as { last_drill_at: Date | string }).last_drill_at;
    const priorOk = (before.rows[0] as { last_drill_ok: boolean | null }).last_drill_ok;
    const { uploader, mirrorCalls } = makeStubUploader();

    await runDrill({
      db,
      uploader,
      identityPath: missing,
      download: async () => artifacts({}),
      decrypt: passthrough,
    });

    const after = await db.execute(
      sql`SELECT last_drill_at, last_drill_ok FROM meta_backup_status`,
    );
    const postAt = (after.rows[0] as { last_drill_at: Date | string }).last_drill_at;
    const postOk = (after.rows[0] as { last_drill_ok: boolean | null }).last_drill_ok;

    // Timestamps may be returned as Date or string by the driver; compare
    // normalised ISO strings so the test doesn't fail on representation.
    const priorIso =
      priorAt instanceof Date ? priorAt.toISOString() : new Date(priorAt).toISOString();
    const postIso = postAt instanceof Date ? postAt.toISOString() : new Date(postAt).toISOString();

    expect(postIso).toBe(priorIso);
    expect(postOk).toBe(priorOk);
    // A skip is not a write, so there is nothing to mirror (AC-169).
    expect(mirrorCalls).toHaveLength(0);
  });

  it('does not bump updatedAt on a skip', async () => {
    // A skipped drill is not a write. data-model.md §5.9 defines
    // `updatedAt` as "set by the backup service on every write", and
    // the whole point of "skip != failure" (AC-168) is that no state
    // changes happen. Bumping `updatedAt` on a no-op would make
    // freshness-derivation surfaces observe a fake "the row moved"
    // signal with no Tier-2 outcome behind it.
    const missing = path.join(keyDir, 'still-nope.txt');
    const before = await db.execute(sql`SELECT updated_at FROM meta_backup_status`);
    const priorUpdatedAt = (before.rows[0] as { updated_at: Date | string }).updated_at;

    await runDrill({
      db,
      uploader: makeStubUploader().uploader,
      identityPath: missing,
      download: async () => artifacts({}),
      decrypt: passthrough,
    });

    const after = await db.execute(sql`SELECT updated_at FROM meta_backup_status`);
    const postUpdatedAt = (after.rows[0] as { updated_at: Date | string }).updated_at;

    const priorIso =
      priorUpdatedAt instanceof Date
        ? priorUpdatedAt.toISOString()
        : new Date(priorUpdatedAt).toISOString();
    const postIso =
      postUpdatedAt instanceof Date
        ? postUpdatedAt.toISOString()
        : new Date(postUpdatedAt).toISOString();

    expect(postIso).toBe(priorIso);
  });

  it('surfaces the underlying Postgres cause in a verify-failure reason', async () => {
    // drizzle wraps a driver error as `Failed query: <sql>` and hangs the
    // real Postgres message on `.cause`. The drill cue must carry that
    // cause — otherwise an operator sees only the opaque wrapper with no
    // hint of WHY verify failed (e.g. a restored dump missing a table).
    const identity = path.join(keyDir, 'present.key');
    await fs.writeFile(identity, 'AGE-SECRET-KEY-1-not-a-real-key');

    const wrapped = new Error(
      'Failed query: SELECT COUNT(*)::int AS c FROM "data_exchange_job"\nparams: ',
    );
    wrapped.cause = new Error('relation "data_exchange_job" does not exist');

    const result = await runDrill({
      db,
      uploader: makeStubUploader().uploader,
      identityPath: identity,
      download: async () => artifacts({ data_exchange_job: { rowCount: 0, checksum: '' } }),
      decrypt: passthrough,
      verifyManifest: async () => {
        throw wrapped;
      },
    });

    expect(result.outcome).toBe('failed');
    // Both the actionable cause AND the SQL context survive into the cue.
    expect(result.reason).toContain('relation "data_exchange_job" does not exist');
    expect(result.reason).toContain('Failed query');

    // And it lands in the durable status row, not just the return value.
    const row = await db.execute(sql`SELECT last_error FROM meta_backup_status`);
    const lastError = (row.rows[0] as { last_error: string | null }).last_error ?? '';
    expect(lastError).toContain('relation "data_exchange_job" does not exist');
  });

  it.each([
    ['passes', true, { users: { rowCount: 1, checksum: 'a' } }],
    ['fails', false, { users: { rowCount: 2, checksum: 'b' } }],
  ])('writes the mirror equal to the DB row when the drill %s', async (_, ok, restored) => {
    const identity = path.join(keyDir, 'present.key');
    await fs.writeFile(identity, 'AGE-SECRET-KEY-1-not-a-real-key');
    const { uploader, mirrorCalls } = makeStubUploader();

    const result = await runDrill({
      db,
      uploader,
      identityPath: identity,
      download: async () => artifacts({ users: { rowCount: 1, checksum: 'a' } }),
      decrypt: passthrough,
      verifyManifest: async () => restored,
    });

    expect(result.outcome).toBe(ok ? 'ok' : 'failed');
    const row = await readStatusRowAsMirror(db);
    expect(row.lastDrillOk).toBe(ok);
    expect(mirrorCalls).toEqual([row]);
  });

  // AC-345: the status row records why a drill failed — including the
  // steps before verify: fetching the artifacts and opening the sidecar.
  it.each([
    [
      'the download fails',
      'drill-download: no backup artifacts found under daily/ prefix',
      'drill-download',
      {
        download: async (): Promise<never> => {
          throw new Error('no backup artifacts found under daily/ prefix');
        },
      },
    ],
    [
      'the manifest does not decrypt',
      // The reason survives; the identity path does not (AC-175).
      'drill-decrypt: no identity matched any of the recipients in <identity>',
      'drill-decrypt',
      {
        decrypt: async (ciphertext: Uint8Array, identityPath: string): Promise<Uint8Array> => {
          if (ciphertext !== DUMP) {
            throw new Error(`no identity matched any of the recipients in ${identityPath}`);
          }
          return ciphertext;
        },
      },
    ],
    [
      'the manifest is unreadable',
      'drill-manifest: unreadable',
      'drill-manifest',
      {
        download: async () => ({
          dump: DUMP,
          manifest: new TextEncoder().encode('not a manifest'),
        }),
      },
    ],
  ])('records a failed drill when %s', async (_, cue, mirrorCue, overrides) => {
    const identity = path.join(keyDir, 'present.key');
    await fs.writeFile(identity, 'AGE-SECRET-KEY-1-not-a-real-key');
    const { uploader, mirrorCalls } = makeStubUploader();
    const now = new Date('2026-05-01T09:02:00.000Z');

    const result = await runDrill({
      db,
      uploader,
      identityPath: identity,
      download: async () => artifacts({ users: { rowCount: 1, checksum: 'a' } }),
      decrypt: passthrough,
      verifyManifest: async () => ({ users: { rowCount: 1, checksum: 'a' } }),
      now,
      ...overrides,
    });

    expect(result.outcome).toBe('failed');
    const row = await readStatusRowAsMirror(db);
    expect(row.lastDrillOk).toBe(false);
    expect(row.lastDrillAt).toBe(now.toISOString());
    expect(row.lastError).toBe(cue);
    expect(mirrorCalls).toEqual([{ ...row, lastError: mirrorCue }]);
  });
});
