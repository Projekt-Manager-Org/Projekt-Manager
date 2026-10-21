/**
 * Seed loader tests — AT-87 (AC-390 / AC-391 / AC-392) and AT-88 (AC-164).
 *
 * See verification.md §15.17 and §16.2.
 *
 * -------------------------------------------------------------------
 * Unusual TDD shape — read before editing
 * -------------------------------------------------------------------
 *
 * These two tests fall into different classes:
 *
 * 1. AT-87 is a **regression pin**, not a new-behavior contract. The
 *    post-seed state it asserts (6 users, 21 customers, 19 projects,
 *    7 project_workers; usernames and active flags per SEED_USERS;
 *    SEED_DEFAULT_PASSWORD verifies; project numbers carry the seed-time
 *    calendar-year prefix) is already true today against the monolithic
 *    `src/server/seed.ts`. The test documents that contract so the
 *    upcoming fixture-loader extraction cannot drift without the suite
 *    noticing. AT-87 is expected to PASS against current main.
 *
 * 2. AT-88 is a **forward-looking feature contract**. The "malformed users
 *    fixture → typed throw, users table empty" behavior only makes sense
 *    once a separable fixture loader exists. The current monolithic seed
 *    embeds the user records inline; it cannot read a fixture, let alone
 *    reject a malformed one. The test targets the future API surface —
 *    `parseUsersFixture` exported from `../seed/users.js` — so today it
 *    fails with a module-not-found signal, which is the canonical
 *    "behavior not implemented" mark. Once Step 5 lands the extracted
 *    module, the test runs its real assertions.
 *
 * This is a deliberate deviation from the "all new tests must fail today"
 * rule used in other workflows: regression pins should reflect observable
 * reality from day one; feature contracts follow standard TDD. The Step 4
 * reviewer will check for this split.
 *
 * -------------------------------------------------------------------
 * Year-rollover note on AC-392
 * -------------------------------------------------------------------
 *
 * The project-number year prefix assertion captures `new Date().getFullYear()`
 * once, before calling seed(). A test that straddles the Dec 31 → Jan 1
 * boundary could theoretically see the prefix advance between capture and
 * the seed run. CI does not run then, so this is not a practical concern,
 * but leaving the note here so a future Dec-31 red herring is easier to
 * debug.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'path';
import { fileURLToPath } from 'url';
import type pg from 'pg';

import { createDatabase } from '../db/connection.js';
import { users, customers, projects, projectWorkers, invoices } from '../db/schema.js';
import { verifyPassword } from '../password.js';
import { seed } from '../seed.js';
import type { Database } from '../db/connection.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

// -------------------------------------------------------------------
// Counts pinned by data-model.md §7.1 / §7.3 and by the assignment list
// in src/server/seed.ts. The user count is derived from SEED_USERS so the
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
    await db.execute(
      sql`TRUNCATE TABLE project_workers, sessions, projects, customers, users CASCADE`,
    );
  });

  // ---------------------------------------------------------------
  // AT-87 → AC-390 + AC-391 + AC-392
  //
  // Regression pin: after seed(db, { force: true }) on an empty DB the
  // observable state matches the seed contract. Expected to pass today.
  // ---------------------------------------------------------------
  describe('AT-87: seed force-run populates the contracted dataset', () => {
    // AC-392 wants the year prefix captured at the moment seed ran.
    // Capture before the call, not after, so a Dec-31 → Jan-1 rollover
    // during seed would fail loudly instead of silently agreeing with
    // the post-seed clock (see top-of-file year-rollover note).
    let seedYear: number;

    beforeEach(async () => {
      seedYear = new Date().getFullYear();
      await seed(db, { force: true });
    });

    // AC-390: row counts match the seed contract.
    it('AC-390: row counts match the seed contract', async () => {
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

    // AC-391 part 1: usernames and `active` flags match SEED_USERS.
    it('AC-391: usernames and active flags match SEED_USERS', async () => {
      const rows = await db.select({ username: users.username, active: users.active }).from(users);

      const actual = new Map(rows.map((r) => [r.username, r.active]));
      const expected = Object.values(SEED_USERS);

      // Exact-set equality — no extras, no omissions.
      expect(actual.size).toBe(expected.length);
      for (const user of expected) {
        expect(actual.get(user.username)).toBe(user.active);
      }
    });

    // AC-391 part 2: SEED_DEFAULT_PASSWORD verifies against every stored
    // passwordHash. Uses verifyPassword — the same helper bootstrap.test.ts
    // and AuthService use, so any drift from the bcrypt round-trip surfaces
    // here alongside the other consumers.
    it('AC-391: SEED_DEFAULT_PASSWORD verifies against every user passwordHash', async () => {
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

    // AC-392: every project `number` carries the seed-time year prefix.
    it('AC-392: every project number carries the seed-time year prefix', async () => {
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

  // ---------------------------------------------------------------
  // AT-88 → AC-164
  //
  // Forward-looking: a malformed users fixture throws a typed validation
  // error and leaves `users` empty. Targets the future fixture-loader
  // module `../seed/users.js` and its `parseUsersFixture` export. That
  // module does not exist today, so this test fails with a module-not-
  // found error — the intended "behavior not implemented" signal.
  //
  // When Step 5 lands the extraction, this test runs its real
  // assertions without modification.
  // ---------------------------------------------------------------
  describe('AT-88: malformed users fixture is rejected atomically', () => {
    it('throws a typed validation error and leaves users empty', async () => {
      // Dynamic import so the test file itself type-checks and loads
      // even before `../seed/users.js` exists. A bare static import
      // would make the entire file fail to compile, which muddies the
      // "behavior not implemented" signal the reviewer looks for.
      //
      // The specifier is stored in a variable so TypeScript does not try
      // to resolve it at compile time. This keeps the test file's type-
      // check clean today and lets the runtime "Cannot find module" error
      // be the single, unambiguous signal that the module has not yet
      // been extracted. No `any` and no `@ts-ignore`.
      //
      // Shape assumed for the future API:
      //   parseUsersFixture(raw: unknown): UserSeedRecord[]
      //     - throws a typed validation error on malformed input
      //     - pure: filesystem-free, so the test can feed it literals
      //
      // If the eventual API diverges (e.g. `loadUsers(db)` only), the
      // Step 5 implementer adjusts this test alongside the module; the
      // contract the test pins (typed throw, no partial insert) does
      // not change.
      const futureModulePath = '../seed/users.js';
      const mod: unknown = await import(/* @vite-ignore */ futureModulePath);

      // Narrow the dynamic-import result without `any` / `@ts-ignore`.
      if (typeof mod !== 'object' || mod === null || !('parseUsersFixture' in mod)) {
        throw new Error('seed/users.js does not export parseUsersFixture');
      }
      const { parseUsersFixture } = mod as {
        parseUsersFixture: (raw: unknown) => unknown;
      };

      // Malformed: `username` is a number instead of a string, and
      // `passwordHash` is missing entirely. Either violation alone
      // satisfies the AC's "missing required field, wrong type"; both
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

      expect(() => parseUsersFixture(malformed)).toThrow(
        /invalid_type|invalid_format|expected|unrecognized/i,
      );

      // AC-164's atomicity clause: no partial state lands in `users`.
      // The beforeEach already truncates, so this confirms the parser
      // never reaches the DB writer path.
      const rows = await db.select({ id: users.id }).from(users);
      expect(rows).toHaveLength(0);
    });
  });
});
