/**
 * Audit retention cleanup — integration test for AC-184.
 *
 * Pins the cleanup contract against a real Postgres instance:
 *   - removes `audit_log` rows older than the configured window (90 d [C]);
 *   - emits exactly one structured operational log line at `info` level
 *     with fields `event='audit-retention-cleanup'`, `window_days`,
 *     `removed_count`, `ran_at` (ISO 8601);
 *   - does NOT produce an `audit_log` row (scope is domain entities
 *     only, per `data-model.md §5.10`).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'path';
import { fileURLToPath } from 'url';
import type pg from 'pg';

import { createDatabase } from '../db/connection.js';
import type { Database } from '../db/connection.js';
import { runAuditRetentionCleanup } from '../services/audit-retention.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

/**
 * Insert a synthetic audit row with an explicit `created_at`. Bypasses
 * the service layer deliberately — the retention test needs control of
 * the timestamp, and `src/server/__tests__/**` is in the allowlist
 * defined by AC-179 / the architecture-check script.
 */
async function insertRowAt(db: Database, createdAt: Date, entityId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_log
      (created_at, actor_id, actor_kind, actor_reason,
       entity_type, entity_id, action, payload, correlation_id)
    VALUES (${createdAt.toISOString()}, NULL, 'system', 'retention-fixture',
            'user', ${entityId}, 'create', '{}'::jsonb, NULL)
  `);
}

async function countAuditRows(db: Database): Promise<number> {
  const res = await db.execute(sql`SELECT COUNT(*)::int AS c FROM audit_log`);
  return (res.rows[0] as { c: number }).c;
}

describe('Audit retention cleanup (AC-184)', () => {
  let db: Database;
  let pool: pg.Pool;

  beforeAll(async () => {
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    await pool.query('SELECT 1');
    await migrate(db, { migrationsFolder });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Start each case with an empty audit_log so fixture rows inserted
    // below are the only rows the cleanup sees.
    await db.execute(sql`TRUNCATE TABLE audit_log`);
  });

  it('removes rows older than the 90-day window and keeps rows inside it', async () => {
    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;

    // Two rows clearly inside the 90-day window.
    await insertRowAt(
      db,
      new Date(now.getTime() - 1 * dayMs),
      '00000000-0000-0000-0000-00000000a001',
    );
    await insertRowAt(
      db,
      new Date(now.getTime() - 30 * dayMs),
      '00000000-0000-0000-0000-00000000a002',
    );
    // Two rows clearly outside the window.
    await insertRowAt(
      db,
      new Date(now.getTime() - 91 * dayMs),
      '00000000-0000-0000-0000-00000000b001',
    );
    await insertRowAt(
      db,
      new Date(now.getTime() - 365 * dayMs),
      '00000000-0000-0000-0000-00000000b002',
    );

    expect(await countAuditRows(db)).toBe(4);

    const infoSpy = vi.fn();
    const errorSpy = vi.fn();
    const fakeLogger = { info: infoSpy, error: errorSpy };

    await runAuditRetentionCleanup({ db, logger: fakeLogger, windowDays: 90, now });

    // Post-conditions on the table: two rows remain (inside window);
    // two were deleted (outside window). The cleanup must NOT itself
    // write an audit row — that would break the "append-only from the
    // application" invariant documented in data-model.md §6.10.
    const remaining = await countAuditRows(db);
    expect(remaining).toBe(2);

    // The survivors are the in-window rows (verified by entity_id
    // pattern) — pins that the predicate is `created_at < cutoff`
    // rather than an unrelated filter that happens to leave two rows.
    const rows = await db.execute(sql`SELECT entity_id FROM audit_log ORDER BY entity_id ASC`);
    const remainingIds = (rows.rows as { entity_id: string }[]).map((r) => r.entity_id);
    expect(remainingIds).toEqual([
      '00000000-0000-0000-0000-00000000a001',
      '00000000-0000-0000-0000-00000000a002',
    ]);

    // Cross-check: the log's `removed_count` matches the actual DB
    // DELETE count. The full log-contract surface (event name, window,
    // ran_at) is asserted in the next test.
    const [context] = infoSpy.mock.calls[0]!;
    const ctx = context as Record<string, unknown>;
    expect(ctx.removed_count).toBe(2);
  });

  it('emits exactly one info log line with the contract fields (event, window_days, removed_count, ran_at)', async () => {
    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    await insertRowAt(
      db,
      new Date(now.getTime() - 100 * dayMs),
      '00000000-0000-0000-0000-0000000000aa',
    );

    const infoSpy = vi.fn();
    const errorSpy = vi.fn();
    const fakeLogger = { info: infoSpy, error: errorSpy };

    await runAuditRetentionCleanup({ db, logger: fakeLogger, windowDays: 90, now });

    // Exactly one info call — the contract says "exactly one structured
    // log line per run".
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();

    const [context, eventName] = infoSpy.mock.calls[0]!;

    // Event discriminator is fixed — operators grep for it.
    expect(eventName).toBe('audit-retention-cleanup');

    // Structured fields per data-model.md §6.10.
    const ctx = context as Record<string, unknown>;
    expect(ctx.event).toBe('audit-retention-cleanup');
    expect(ctx.window_days).toBe(90);
    expect(ctx.removed_count).toBe(1);
    expect(typeof ctx.ran_at).toBe('string');
    // ISO 8601 — the `Date.parse` round-trip catches obvious typos
    // (e.g. `toLocaleString`) without pinning a specific substring.
    expect(Number.isNaN(Date.parse(ctx.ran_at as string))).toBe(false);
  });

  it('emits removed_count=0 on a no-op run (all rows inside the window)', async () => {
    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    await insertRowAt(
      db,
      new Date(now.getTime() - 5 * dayMs),
      '00000000-0000-0000-0000-0000000000cc',
    );

    const infoSpy = vi.fn();
    const fakeLogger = { info: infoSpy, error: vi.fn() };
    await runAuditRetentionCleanup({ db, logger: fakeLogger, windowDays: 90, now });

    // Nothing deleted.
    expect(await countAuditRows(db)).toBe(1);
    // Still exactly one log line, with removed_count=0 per the spec.
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [context] = infoSpy.mock.calls[0]!;
    expect((context as { removed_count: number }).removed_count).toBe(0);
  });

  it('does not itself produce an audit_log row (append-only invariant)', async () => {
    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    await insertRowAt(
      db,
      new Date(now.getTime() - 120 * dayMs),
      '00000000-0000-0000-0000-0000000000dd',
    );
    // One row which will be deleted; post-run we must see ZERO rows
    // (not one) — if the cleanup itself wrote an audit row, we'd see
    // one stray.
    expect(await countAuditRows(db)).toBe(1);

    await runAuditRetentionCleanup({
      db,
      logger: { info: vi.fn(), error: vi.fn() },
      windowDays: 90,
      now,
    });

    expect(await countAuditRows(db)).toBe(0);
  });
});
