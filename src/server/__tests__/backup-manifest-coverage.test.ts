/**
 * Structural guard: every public-schema BASE TABLE appears in
 * `MANIFEST_TABLES`. A new table added to `schema.ts` without a matching
 * entry in `src/server/services/backup.ts` fails CI here — without the
 * guard, the Layer 2 manifest silently weakens as the schema grows
 * (issue #230 found six tables of fourteen covered).
 *
 * Pairs with `backup.test.ts` (Tier 1 run contract) and
 * `backup-status.test.ts` (manifest determinism / AC-174). Kept in its
 * own file because the assertion is schema-shape, not run behavior.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import path from 'path';
import { fileURLToPath } from 'url';
import type pg from 'pg';

import { createDatabase } from '../db/connection.js';
import type { Database } from '../db/connection.js';
import { MANIFEST_TABLES } from '../services/backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

/**
 * `drizzle.__drizzle_migrations` is the migration journal Drizzle's own
 * migrator owns. It lives in the `drizzle` schema, not `public`, but
 * older deploys may have it in `public` — exclude both by name as a
 * defensive belt for environments that landed with an early schema.
 */
const SYSTEM_TABLES = new Set(['__drizzle_migrations']);

describe('Layer 2 backup — manifest coverage structural guard (issue #230)', () => {
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
    if (pool) await pool.end();
  });

  it('MANIFEST_TABLES covers every public BASE TABLE — no schema drift', async () => {
    const result = await db.execute<{ table_name: string }>(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    const publicTables = result.rows
      .map((r) => r.table_name)
      .filter((name) => !SYSTEM_TABLES.has(name));

    const manifestTables = MANIFEST_TABLES.map((t) => t.name).sort();
    expect(manifestTables).toEqual(publicTables.sort());
  });

  it('each MANIFEST_TABLES entry names columns that exist on the table', async () => {
    // The checksum query `ORDER BY <pkColumns>` fails at run time if a
    // column name drifts (e.g. PK rename in schema, stale entry here).
    // Catch the divergence at test time rather than on a Tier 1 run.
    for (const table of MANIFEST_TABLES) {
      const result = await db.execute<{ column_name: string }>(sql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ${table.name}
      `);
      const columns = new Set(result.rows.map((r) => r.column_name));
      for (const pkCol of table.pkColumns) {
        expect(columns, `${table.name}.${pkCol}`).toContain(pkCol);
      }
    }
  });

  it('each MANIFEST_TABLES pkColumns list matches the table primary key', async () => {
    // Belt on top of the column-existence check above: the listed
    // columns must collectively BE the PK (not a subset that happens
    // to exist). A wrong PK ordering would still produce a stable
    // checksum, but ORDER BY a non-PK column drifts as rows update.
    for (const table of MANIFEST_TABLES) {
      const result = await db.execute<{ column_name: string }>(sql`
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name
         AND kcu.constraint_schema = tc.constraint_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema = 'public'
          AND tc.table_name = ${table.name}
        ORDER BY kcu.ordinal_position
      `);
      const dbPkCols = result.rows.map((r) => r.column_name);
      expect(dbPkCols.sort(), `${table.name} PK`).toEqual([...table.pkColumns].sort());
    }
  });
});
