/**
 * Seed loader regression guards. They cite no AC: the seed is a dev and
 * test fixture that production never loads. They keep the
 * dataset other tests and the demo rely on from drifting unnoticed.
 *
 * The year-prefix check captures `new Date().getFullYear()` before
 * seed() runs, so a run straddling Dec 31 → Jan 1 can fail spuriously.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ZodError } from 'zod';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'path';
import { fileURLToPath } from 'url';
import type pg from 'pg';

import { createDatabase } from '../db/connection.js';
import { users, customers, projects, projectWorkers, invoices } from '../db/schema.js';
import { verifyPassword } from '../password.js';
import { seed } from '../seed.js';
import { parseUsersFixture } from '../seed/users.js';
import type { Database } from '../db/connection.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { withAuditLogRemoval } from '../db/auditLogRemoval.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

// -------------------------------------------------------------------
// Customer and project counts are pinned by the specs in
// src/server/seed/business.ts. The user count is derived from SEED_USERS so the
// 6-user contract is expressed in one place (seedAssumptions.ts), not
// duplicated as a literal here.
// -------------------------------------------------------------------
const EXPECTED_USER_COUNT = Object.keys(SEED_USERS).length;
const EXPECTED_CUSTOMER_COUNT = 21;
const EXPECTED_PROJECT_COUNT = 19;
const EXPECTED_PROJECT_WORKER_COUNT = 7;
// Invoice fixtures: 5 fresh issues + 1 cancellation pair (cancelled +
// storno + reissued = 3 extra rows on the same project) + 5 drafts =
// 12 invoice rows. By status: 5 draft + 6 issued (5 fresh issues + 1
// storno + 1 reissue MINUS the one that got cancelled = 6) + 1
// cancelled. The storno keeps `status='issued'` with `cancellationOf`
// set (see `InvoiceCancelService.ts`).
// The three `rechnung_faellig` project slots (013/014/015) are NOT
// issued against here — they remain available to `invoices-routes.test.ts`
// which claims them via `rechnungFaelligProjectId()`.
const EXPECTED_INVOICE_COUNT = 12;
const EXPECTED_INVOICE_DRAFT_COUNT = 5;
const EXPECTED_INVOICE_ISSUED_COUNT = 6;
const EXPECTED_INVOICE_CANCELLED_COUNT = 1;

// Uses a raw DB connection (no Fastify) — mirrors db-constraints.test.ts
// and bootstrap.test.ts because these tests exercise the seed loader
// directly, not an HTTP surface.
let db: Database;
let pool: pg.Pool;

describe('Seed', () => {
  beforeAll(async () => {
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    // Verify the pool is live and migrations are in place.
    // Pattern from bootstrap.test.ts:62-69.
    await pool.query('SELECT 1');
    await migrate(db, { migrationsFolder });
  });

  afterAll(async () => {
    await pool.end();
  });

  // Each test starts from a truly empty state — the seed's `force: true`
  // path TRUNCATEs anyway, but wiping here first guarantees the "empty DB"
  // precondition both tests depend on and matches the bootstrap.test.ts
  // per-test TRUNCATE pattern (bootstrap.test.ts:75-79).
  beforeEach(async () => {
    await withAuditLogRemoval(db, (tx) =>
      tx.execute(sql`TRUNCATE TABLE project_workers, sessions, projects, customers, users CASCADE`),
    );
  });

  // ---------------------------------------------------------------
  // After seed(db, { force: true }) on an empty DB the dataset matches
  // the seed specs.
  // ---------------------------------------------------------------
  describe('seed force-run populates the expected dataset', () => {
    // Capture the year before the call, not after, so a Dec-31 → Jan-1 rollover
    // during seed would fail loudly instead of silently agreeing with
    // the post-seed clock (see top-of-file year-rollover note).
    let seedYear: number;

    beforeEach(async () => {
      seedYear = new Date().getFullYear();
      await seed(db, { force: true });
    });

    it('row counts match the seed specs', async () => {
      const [userRows, customerRows, projectRows, projectWorkerRows, invoiceRows] =
        await Promise.all([
          db.select({ id: users.id }).from(users),
          db.select({ id: customers.id }).from(customers),
          db.select({ id: projects.id }).from(projects),
          db.select({ projectId: projectWorkers.projectId }).from(projectWorkers),
          db.select({ id: invoices.id, status: invoices.status }).from(invoices),
        ]);

      expect(userRows).toHaveLength(EXPECTED_USER_COUNT);
      expect(customerRows).toHaveLength(EXPECTED_CUSTOMER_COUNT);
      expect(projectRows).toHaveLength(EXPECTED_PROJECT_COUNT);
      expect(projectWorkerRows).toHaveLength(EXPECTED_PROJECT_WORKER_COUNT);

      expect(invoiceRows).toHaveLength(EXPECTED_INVOICE_COUNT);
      const byStatus = new Map<string, number>();
      for (const r of invoiceRows) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
      expect(byStatus.get('draft') ?? 0).toBe(EXPECTED_INVOICE_DRAFT_COUNT);
      expect(byStatus.get('issued') ?? 0).toBe(EXPECTED_INVOICE_ISSUED_COUNT);
      expect(byStatus.get('cancelled') ?? 0).toBe(EXPECTED_INVOICE_CANCELLED_COUNT);
    });

    // Usernames and `active` flags match SEED_USERS.
    it('usernames and active flags match SEED_USERS', async () => {
      const rows = await db.select({ username: users.username, active: users.active }).from(users);

      const actual = new Map(rows.map((r) => [r.username, r.active]));
      const expected = Object.values(SEED_USERS);

      // Exact-set equality — no extras, no omissions.
      expect(actual.size).toBe(expected.length);
      for (const user of expected) {
        expect(actual.get(user.username)).toBe(user.active);
      }
    });

    // Uses verifyPassword — the same helper bootstrap.test.ts
    // and AuthService use, so any drift from the bcrypt round-trip surfaces
    // here alongside the other consumers.
    it('SEED_DEFAULT_PASSWORD verifies against every user passwordHash', async () => {
      const rows = await db
        .select({ username: users.username, passwordHash: users.passwordHash })
        .from(users);

      expect(rows).toHaveLength(EXPECTED_USER_COUNT);

      const verifications = await Promise.all(
        rows.map(async (r) => ({
          username: r.username,
          ok: await verifyPassword(SEED_DEFAULT_PASSWORD, r.passwordHash),
        })),
      );

      for (const v of verifications) {
        expect(v.ok, `SEED_DEFAULT_PASSWORD should verify for "${v.username}"`).toBe(true);
      }
    });

    it('every project number carries the seed-time year prefix', async () => {
      const rows = await db.select({ number: projects.number }).from(projects);

      expect(rows).toHaveLength(EXPECTED_PROJECT_COUNT);
      const prefix = `${seedYear}-`;
      for (const r of rows) {
        expect(
          r.number.startsWith(prefix),
          `project number "${r.number}" missing prefix "${prefix}"`,
        ).toBe(true);
      }
    });
  });

  describe('parseUsersFixture', () => {
    it('rejects a malformed fixture with a ZodError', () => {
      // Malformed: `username` is a number instead of a string, and
      // `passwordHash` is missing entirely. Either violation alone
      // covers "missing required field, wrong type"; both
      // together make the test robust to minor schema evolution.
      const malformed = [
        {
          username: 12345,
          displayName: 'Broken User',
          roles: ['worker'],
          email: null,
          active: true,
        },
      ];

      expect(() => parseUsersFixture(malformed)).toThrow(ZodError);
    });
  });
});
