/**
 * API integration tests: Layer 2 backup — the two waits AC-345 covers
 * that are neither a subprocess nor a manifest statement.
 *
 * Covers verification.md §15.22:
 *   - AC-345 [crit], off-host half: requests to the object store carry a
 *     wall-clock limit that aborts rather than warns.
 *   - AC-345 [crit], status-write half: the run's own status write gives
 *     up on lock contention instead of blocking forever. It is the write
 *     that reports every other failure, so it is the one wait whose
 *     hanging costs the report as well as the tick.
 *
 * The subprocess half lives in `subprocess-bound.test.ts`; the manifest
 * transaction's half in `backup-snapshot.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import path from 'path';
import { fileURLToPath } from 'url';
import type pg from 'pg';

import { createDatabase, type Database } from '../db/connection.js';
import { seed } from '../seed.js';
import { makeStubUploader, fakeEncrypt } from '../../test/backupTestHarness.js';
import { runBackup } from '../services/backup.js';
import { buildClient } from '../services/r2Uploader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

/** Short enough that the test does not park for the production 30s. */
const TEST_LOCK_TIMEOUT_MS = 250;

describe('Layer 2 backup — object-store requests are bounded (§15.22 AC-345)', () => {
  it('gives the R2 client a wall-clock bound that aborts rather than warns', async () => {
    const client = buildClient({
      endpoint: 'https://example.invalid',
      bucket: 'irrelevant',
      accessKeyId: 'irrelevant',
      secretAccessKey: 'irrelevant',
    });

    // `@smithy/node-http-handler` defaults requestTimeout /
    // connectionTimeout / socketTimeout all to 0 — no bound at all. R2
    // is the run's only off-host dependency and therefore the likeliest
    // thing in a tick to black-hole; unbounded, that parks the tick and
    // croner's `protect: true` suppresses every later run.
    //
    // `configProvider` is the handler's own resolved config. It is not
    // public API, so an SDK upgrade that renames it fails here — which
    // is the outcome we want: a loud test failure beats a client that
    // silently stopped bounding.
    // `as unknown as` because the SDK types `requestHandler` as a union
    // that covers the fetch handler too, and that branch has no
    // `configProvider` to narrow against.
    const handler = client.config.requestHandler as unknown as {
      configProvider: Promise<{
        requestTimeout?: number;
        connectionTimeout?: number;
        throwOnRequestTimeout?: boolean;
      }>;
    };
    const resolved = await handler.configProvider;

    expect(resolved.requestTimeout).toBeGreaterThan(0);
    expect(resolved.connectionTimeout).toBeGreaterThan(0);
    // Load-bearing on its own: without it the handler logs a warning at
    // the bound and keeps waiting, so the timeout does not time out.
    expect(resolved.throwOnRequestTimeout).toBe(true);
  });
});

describe('Layer 2 backup — the status write is bounded (§15.22 AC-345)', () => {
  let db: Database;
  let pool: pg.Pool;
  let blockerPool: pg.Pool;

  beforeAll(async () => {
    // The pool the backup runner builds: a session-level `lock_timeout`
    // covers every statement, including the ones outside the manifest
    // transaction that `SET LOCAL` cannot reach.
    const conn = createDatabase({ lockTimeoutMs: TEST_LOCK_TIMEOUT_MS });
    db = conn.db;
    pool = conn.pool;
    await pool.query('SELECT 1');
    await migrate(db, { migrationsFolder });
    await seed(db, { force: true });

    // Separate pool for the blocker — taking the lock from `pool` would
    // bound the blocker itself.
    blockerPool = createDatabase().pool;
  });

  afterAll(async () => {
    if (blockerPool) await blockerPool.end();
    if (pool) {
      await db.execute(sql`DELETE FROM meta_backup_status`);
      await db.execute(
        sql`INSERT INTO meta_backup_status (singleton, last_backup_ok) VALUES (TRUE, FALSE)`,
      );
      await pool.end();
    }
  });

  it('fails the run instead of blocking forever when the status table is locked', async () => {
    // The nastiest shape in the family: the blocked resource is the
    // table the run reports failures on. Unbounded, `runBackup` never
    // returns, the tick never completes, and the freshness badge stays
    // green on the last success — nothing is written because nothing
    // *can* be written. Bounded, the run ends and the operator sees a
    // stale badge go red on schedule.
    const blocker = await blockerPool.connect();
    const { uploader, uploads } = makeStubUploader();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE meta_backup_status IN ACCESS EXCLUSIVE MODE');

      const settled = await runBackup({
        db,
        uploader,
        encrypt: fakeEncrypt,
        // Both throw so a regression that gets this far fails loudly
        // rather than passing for the wrong reason.
        dumpSource: async () => {
          throw new Error('dump source reached despite a locked status table');
        },
        verifyManifest: async () => {
          throw new Error('verify reached despite a locked status table');
        },
      }).then(
        (ok) => ({ kind: 'resolved' as const, ok }),
        (err: unknown) => ({ kind: 'rejected' as const, err }),
      );

      // Settling at all is the AC-345 property; how it settles is
      // secondary. The status row cannot be written here — the table it
      // lives in is the locked one — so this path throws rather than
      // returning `{ ok: false }` like every other failure.
      expect(settled.kind).toBe('rejected');

      // The reason must stay reachable. Drizzle's own message is
      // "Failed query: INSERT INTO meta_backup_status …" and Postgres'
      // "canceling statement due to lock timeout" sits on `cause` —
      // which is why `errorMessage` walks the chain before it reaches
      // `lastError` and the runner's log line.
      const chain: string[] = [];
      let current = settled.kind === 'rejected' ? settled.err : undefined;
      while (current instanceof Error && chain.length < 4) {
        chain.push(current.message);
        current = current.cause;
      }
      expect(chain.join(': ')).toMatch(/lock timeout/);

      expect(uploads).toHaveLength(0);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });
});
