/**
 * DB-level CHECK constraint tests.
 *
 * Belt and braces — the API layer already rejects invalid planned-date
 * combinations (see projects-dates.test.ts).
 * But direct DB writes from migrations, seed scripts, or manual SQL bypass
 * the route layer entirely. These tests verify that the
 * `projects_end_requires_start` CHECK constraint is actually enforced by the
 * database, not just present in the schema file.
 *
 * Uses a raw DB connection (no Fastify) because we are exercising the
 * database, not the HTTP layer.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase } from '../db/connection.js';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { seed } from '../seed.js';
import { eq } from 'drizzle-orm';
import { projects, customers } from '../db/schema.js';
import type { Database } from '../db/connection.js';
import type pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

let db: Database;
let pool: pg.Pool;
/** A customer ID created for constraint tests. */
let testCustomerId: string;

describe('DB CHECK constraints — projects.planned_end requires planned_start', () => {
  beforeAll(async () => {
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    await pool.query('SELECT 1');
    await migrate(db, { migrationsFolder });
    await seed(db, { force: true });

    // Create a test customer for direct-insert tests
    const rows = await db
      .insert(customers)
      .values({ name: 'Constraint Test Kunde' })
      .returning({ id: customers.id });
    testCustomerId = rows[0]!.id;
  });

  afterAll(async () => {
    // Clean up test artifacts so they don't leak into the dev database
    await db.delete(projects).where(eq(projects.customerId, testCustomerId));
    await db.delete(customers).where(eq(customers.id, testCustomerId));
    await pool.end();
  });

  it('rejects direct INSERT of plannedEnd without plannedStart', async () => {
    let pgError: { code?: string; constraint?: string } | null = null;
    try {
      await pool.query(
        `INSERT INTO projects (number, title, customer_id, planned_start, planned_end)
         VALUES ($1, $2, $3, NULL, $4)`,
        ['CHK-01', 'end without start', testCustomerId, '2026-06-10T00:00:00Z'],
      );
    } catch (err) {
      pgError = err as { code?: string; constraint?: string };
    }

    expect(pgError).not.toBeNull();
    expect(pgError!.code).toBe('23514');
    expect(pgError!.constraint).toBe('projects_end_requires_start');
  });

  it('allows start without end, both dates, and neither', async () => {
    const base = {
      title: 'constraint positive case',
      customerId: testCustomerId,
    };

    // Neither date
    await db
      .insert(projects)
      .values({ ...base, number: 'CHK-N', plannedStart: null, plannedEnd: null });

    // Start only
    await db.insert(projects).values({
      ...base,
      number: 'CHK-S',
      plannedStart: new Date('2026-06-01T00:00:00Z'),
      plannedEnd: null,
    });

    // Both dates
    await db.insert(projects).values({
      ...base,
      number: 'CHK-B',
      plannedStart: new Date('2026-06-01T00:00:00Z'),
      plannedEnd: new Date('2026-06-10T00:00:00Z'),
    });
  });
});
