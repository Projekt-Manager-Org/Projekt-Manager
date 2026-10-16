/**
 * Data integrity tests — AC-94 through AC-99, AC-115 (CHECK half).
 *
 * Verifies defense-in-depth constraints identified by the data integrity
 * audit: optimistic locking on transitions, soft-delete immutability,
 * DB-level CHECK constraints, FK integrity on audit columns, and atomic
 * project creation. Also pins the users.theme_preference CHECK constraint
 * (AC-115 defense in depth — see data-model.md §5.3, §5.7).
 *
 * AT-42 to AT-49, AT-57 (verification.md §16.2).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase } from '../db/connection.js';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { seed } from '../seed.js';
import { eq, like, sql } from 'drizzle-orm';
import { projects, customers, users } from '../db/schema.js';
import type { Database } from '../db/connection.js';
import type pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  startApp,
  stopApp,
  login,
  authGet,
  authPost,
  authPatch,
  authDelete,
} from '../../test/api-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

// ---------------------------------------------------------------
// §15.18 AC-95: Soft-deleted projects are immutable via API
// AT-42, AT-43, AT-44
// ---------------------------------------------------------------
describe('AC-95: Mutations on soft-deleted projects', () => {
  let token: string;
  let deletedProjectId: string;

  beforeAll(async () => {
    await startApp();
    token = await login('inhaber', 'changeme');

    // Find a project that can be soft-deleted
    const listRes = await authGet(token, '/api/projects');
    const projectList = listRes.json().data;
    // Pick a project in a non-terminal state that we can sacrifice
    const target = projectList.find((p: Record<string, unknown>) => p.status === 'angebot');
    expect(target).toBeDefined();
    deletedProjectId = target.id;

    // Soft-delete it
    const delRes = await authDelete(token, `/api/projects/${deletedProjectId}`);
    expect(delRes.statusCode).toBe(200);

    // Confirm it's archived. Per api.md §14.2.2, GET returns the archived
    // row as a regular 200 with `deleted: true` so the UI can render a
    // read-only preview. AC-95 still holds — subsequent mutation attempts
    // continue to return 404 via the mutation-path repository (verified
    // by AT-42..AT-44 below).
    const after = await authGet(token, `/api/projects/${deletedProjectId}`);
    expect(after.statusCode).toBe(200);
    expect(after.json().deleted).toBe(true);
  });

  afterAll(async () => {
    await stopApp();
  });

  it('AT-42: transition on a soft-deleted project returns 404', async () => {
    const res = await authPost(token, `/api/projects/${deletedProjectId}/transition/forward`, {
      expectedStatus: 'angebot',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('AT-42: backward transition on a soft-deleted project returns 404', async () => {
    const res = await authPost(token, `/api/projects/${deletedProjectId}/transition/backward`, {
      expectedStatus: 'angebot',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('AT-43: date update on a soft-deleted project returns 404', async () => {
    const res = await authPatch(token, `/api/projects/${deletedProjectId}/dates`, {
      plannedStart: '2026-09-01',
      plannedEnd: '2026-09-15',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('AT-44: PATCH update on a soft-deleted project returns 404', async () => {
    const res = await authPatch(token, `/api/projects/${deletedProjectId}`, {
      title: 'Should Not Work',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------
// §15.18 AC-94: Concurrent state transitions are rejected as conflict
// AT-49
// ---------------------------------------------------------------
describe('AC-94: Concurrent state transitions', () => {
  let token: string;

  beforeAll(async () => {
    await startApp();
    token = await login('inhaber', 'changeme');
  });

  afterAll(async () => {
    await stopApp();
  });

  it('AT-49: two concurrent forward transitions — one succeeds, one is rejected as conflict', async () => {
    // Pick a project in a non-terminal, non-boundary state.
    // Seed (data-model.md §7.1) provides 2 projects in 'beauftragt'.
    const listRes = await authGet(token, '/api/projects');
    const projectList = listRes.json().data;
    const target = projectList.find((p: Record<string, unknown>) => p.status === 'beauftragt');
    expect(target).toBeDefined();
    const projectId = target.id;

    // Both clients assert they observed status='beauftragt'. The conditional
    // UPDATE (project-transitions.ts) advances only when the stored status
    // still matches; after the first commit, the second request's predicate
    // no longer holds and the row miss is surfaced as CONFLICT. This holds
    // regardless of whether the two requests actually overlap in time —
    // unlike the prior SELECT-then-UPDATE approach, which flaked under
    // sequential execution (see api.md § Transitions / optimistic concurrency).
    const [resA, resB] = await Promise.all([
      authPost(token, `/api/projects/${projectId}/transition/forward`, {
        expectedStatus: 'beauftragt',
      }),
      authPost(token, `/api/projects/${projectId}/transition/forward`, {
        expectedStatus: 'beauftragt',
      }),
    ]);

    // Exactly one must succeed (200), the other must conflict (409).
    const codes = [resA.statusCode, resB.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    // The conflict response must use the CONFLICT error code
    // (api.md §14.4.1).
    const conflict = resA.statusCode === 409 ? resA : resB;
    expect(conflict.json().code).toBe('CONFLICT');

    // The project must have advanced exactly ONE step, not two.
    const verifyRes = await authGet(token, `/api/projects/${projectId}`);
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.json().status).toBe('geplant');
  });
});

// ---------------------------------------------------------------
// §15.18 AC-96, AC-97: DB-level CHECK constraints
// AT-45, AT-46
// ---------------------------------------------------------------
describe('AC-96/AC-97: DB CHECK constraints', () => {
  let db: Database;
  let pool: pg.Pool;
  let testCustomerId: string;

  beforeAll(async () => {
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    await pool.query('SELECT 1');
    await migrate(db, { migrationsFolder });
    await seed(db, { force: true });

    const rows = await db
      .insert(customers)
      .values({ name: 'Integrity Test Kunde' })
      .returning({ id: customers.id });
    testCustomerId = rows[0]!.id;
  });

  afterAll(async () => {
    await db.delete(projects).where(eq(projects.customerId, testCustomerId));
    await db.delete(customers).where(eq(customers.id, testCustomerId));
    await pool.end();
  });

  it('AT-45: rejects INSERT with invalid status value', async () => {
    let pgError: { code?: string; constraint?: string } | null = null;
    try {
      await pool.query(
        `INSERT INTO projects (number, title, customer_id, status)
         VALUES ($1, $2, $3, $4)`,
        ['CHK-STAT-01', 'invalid status', testCustomerId, 'nonexistent_state'],
      );
    } catch (err) {
      pgError = err as { code?: string; constraint?: string };
    }

    expect(pgError).not.toBeNull();
    expect(pgError!.code).toBe('23514'); // check_violation
    expect(pgError!.constraint).toBe('projects_valid_status');
  });

  it('AT-45: accepts all valid status values', async () => {
    const validStates = [
      'anfrage',
      'angebot',
      'beauftragt',
      'geplant',
      'in_arbeit',
      'abnahme',
      'rechnung_faellig',
      'abgerechnet',
      'erledigt',
    ];
    for (let i = 0; i < validStates.length; i++) {
      await db.insert(projects).values({
        number: `CHK-VS-${i}`,
        title: `valid status: ${validStates[i]}`,
        customerId: testCustomerId,
        status: validStates[i]!,
      });
    }
  });

  it('AT-46: rejects INSERT where plannedEnd < plannedStart', async () => {
    let pgError: { code?: string; constraint?: string } | null = null;
    try {
      await pool.query(
        `INSERT INTO projects (number, title, customer_id, planned_start, planned_end)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          'CHK-DATE-01',
          'end before start',
          testCustomerId,
          '2026-06-15T00:00:00Z',
          '2026-06-01T00:00:00Z',
        ],
      );
    } catch (err) {
      pgError = err as { code?: string; constraint?: string };
    }

    expect(pgError).not.toBeNull();
    expect(pgError!.code).toBe('23514'); // check_violation
    expect(pgError!.constraint).toBe('projects_end_not_before_start');
  });

  it('AT-46: accepts equal start and end dates', async () => {
    await db.insert(projects).values({
      number: 'CHK-DATE-EQ',
      title: 'same day project',
      customerId: testCustomerId,
      plannedStart: new Date('2026-06-15T00:00:00Z'),
      plannedEnd: new Date('2026-06-15T00:00:00Z'),
    });
  });
});

// ---------------------------------------------------------------
// §15.18 AC-98: Customer audit FK SET NULL on user delete
// AT-47
// ---------------------------------------------------------------
describe('AC-98: Customer audit FK cascade', () => {
  let token: string;

  beforeAll(async () => {
    await startApp();
    token = await login('inhaber', 'changeme');
  });

  afterAll(async () => {
    await stopApp();
  });

  it('AT-47: deleting a user nullifies createdBy/updatedBy on customers', async () => {
    // Create a temporary user
    const createUserRes = await authPost(token, '/api/users', {
      username: 'audit_fk_test_user',
      displayName: 'FK Test User',
      password: 'TestPass123!',
      roles: ['office'],
    });
    expect(createUserRes.statusCode).toBe(201);
    const tempUserId = createUserRes.json().id;

    // Log in as that user and create a customer
    const tempToken = await login('audit_fk_test_user', 'TestPass123!');
    const createCustRes = await authPost(tempToken, '/api/customers', {
      name: 'FK Audit Test Kunde',
    });
    expect(createCustRes.statusCode).toBe(201);
    const customerId = createCustRes.json().id;

    // Verify createdBy is set
    const beforeRes = await authGet(token, `/api/customers/${customerId}`);
    expect(beforeRes.json().createdBy).toBe(tempUserId);

    // Delete the user (as owner) — returns 204 No Content
    const deleteRes = await authDelete(token, `/api/users/${tempUserId}`);
    expect(deleteRes.statusCode).toBe(204);

    // Verify createdBy is now null
    const afterRes = await authGet(token, `/api/customers/${customerId}`);
    expect(afterRes.json().createdBy).toBeNull();

    // Clean up the test customer
    await authDelete(token, `/api/customers/${customerId}`);
  });
});

// ---------------------------------------------------------------
// AC-98 parity for audit_log.actor_id:
// data-model.md §5.10 pins ON DELETE SET NULL on `audit_log.actor_id`
// (parallel to `createdBy`/`updatedBy`). Hard-deleting a user whose id
// appears in an audit row must nullify `actor_id` rather than cascade
// the row — the audit trail survives purged actors.
// ---------------------------------------------------------------
describe('AC-98 parity: audit_log.actor_id FK cascade on user delete', () => {
  let token: string;

  beforeAll(async () => {
    await startApp();
    token = await login('inhaber', 'changeme');
  });

  afterAll(async () => {
    await stopApp();
  });

  it('deleting a user sets audit_log.actor_id to NULL for rows they authored', async () => {
    // Bring a throwaway user into the seed and log in as them so they
    // become the actor on an audit row. The customer create below emits
    // a `customer:create` audit row; that row's `actor_id` equals the
    // new user's id.
    const suffix = Date.now().toString(36);
    const createUserRes = await authPost(token, '/api/users', {
      username: `audit_actor_fk_${suffix}`,
      displayName: 'Audit Actor FK Test',
      password: 'TestPass123!',
      roles: ['office'],
    });
    expect(createUserRes.statusCode).toBe(201);
    const tempUserId = createUserRes.json().id as string;

    const tempToken = await login(`audit_actor_fk_${suffix}`, 'TestPass123!');
    const createCustRes = await authPost(tempToken, '/api/customers', {
      name: `Audit FK Customer ${suffix}`,
    });
    expect(createCustRes.statusCode).toBe(201);
    const customerId = createCustRes.json().id as string;

    // Locate the audit row authored by the temp user (the customer-create
    // one). The query filters on `actor_id` directly rather than going
    // via the audit API because the audit route applies role-based
    // shaping — we want to see the raw FK value here.
    const { db, pool } = createDatabase();
    try {
      const before = await db.execute(
        sql`SELECT id, actor_id FROM audit_log
             WHERE entity_type = 'customer' AND entity_id = ${customerId}
             ORDER BY created_at DESC LIMIT 1`,
      );
      const auditRowBefore = before.rows[0] as { id: string; actor_id: string | null };
      expect(auditRowBefore.actor_id).toBe(tempUserId);

      // Hard-delete the user via the admin endpoint.
      const deleteRes = await authDelete(token, `/api/users/${tempUserId}`);
      expect(deleteRes.statusCode).toBe(204);

      // The audit row must still exist, but `actor_id` must be NULL —
      // FK ON DELETE SET NULL, not CASCADE. Pins data-model.md §5.10
      // "Referential integrity" and AC-98 parity.
      const after = await db.execute(
        sql`SELECT id, actor_id FROM audit_log WHERE id = ${auditRowBefore.id}`,
      );
      expect(after.rows).toHaveLength(1);
      expect((after.rows[0] as { actor_id: string | null }).actor_id).toBeNull();
    } finally {
      await pool.end();
    }

    // Clean up the test customer — the actor is already gone, so no
    // further housekeeping is needed for the user record.
    await authDelete(token, `/api/customers/${customerId}`);
  });
});

// ---------------------------------------------------------------
// §15.18 AC-99: Atomic project creation
// AT-48
// ---------------------------------------------------------------
describe('AC-99: Atomic project creation', () => {
  let token: string;

  beforeAll(async () => {
    await startApp();
    token = await login('inhaber', 'changeme');
  });

  afterAll(async () => {
    await stopApp();
  });

  it('AT-48: invalid worker ID rolls back entire project creation', async () => {
    const customerRes = await authGet(token, '/api/customers');
    const custId = customerRes.json().customers[0].id;
    const fakeWorkerId = '00000000-0000-0000-0000-000000000099';

    const res = await authPost(token, '/api/projects', {
      number: 'ATOMIC-FAIL-01',
      title: 'should not persist',
      customerId: custId,
      assignedWorkerIds: [fakeWorkerId],
    });

    // The request should fail (FK violation on workers)
    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    // The project should NOT exist in the database
    const listRes = await authGet(token, '/api/projects');
    const orphan = listRes
      .json()
      .data.find((p: Record<string, unknown>) => p.number === 'ATOMIC-FAIL-01');
    expect(orphan).toBeUndefined();
  });
});

// ---------------------------------------------------------------
// §15.21 AC-115: users.theme_preference CHECK constraint
// AT-57
//
// Defense in depth — the API validator already rejects an invalid
// themePreference (covered by AT-60). But the DB is the last line:
// migrations, seeds, `psql` sessions, or any future service that
// bypasses the route layer must not be able to persist a value
// outside the allowed set. This test pins the CHECK constraint
// presence the same way AT-45 pins projects_valid_status.
// ---------------------------------------------------------------
describe('AC-115: users.theme_preference CHECK constraint', () => {
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
    // Cleanup: any rows created by the positive-case loop below. The
    // negative case never committed, so there is nothing to delete for
    // that. Scope the cleanup by username prefix so a regression that
    // causes the INSERT to succeed does not leave orphan rows behind.
    await db.delete(users).where(like(users.username, 'chk_theme_%'));
    await pool.end();
  });

  it("AT-57: rejects direct INSERT of a user with themePreference='ultraviolet'", async () => {
    // Raw SQL so we observe the actual PG error object (the drizzle
    // `insert()` helper would still hit the constraint, but going
    // through pool.query keeps the test symmetrical with AT-45/AT-46
    // and makes the SQLSTATE + constraint name assertions load-bearing.
    let pgError: { code?: string; constraint?: string } | null = null;
    try {
      await pool.query(
        `INSERT INTO users (username, display_name, password_hash, theme_preference)
         VALUES ($1, $2, $3, $4)`,
        [
          'chk_theme_bad',
          'CHECK reject test',
          'placeholder-hash',
          // 'ultraviolet' is intentionally NOT in {'light','dark','system'}
          'ultraviolet',
        ],
      );
    } catch (err) {
      pgError = err as { code?: string; constraint?: string };
    }

    expect(pgError).not.toBeNull();
    // 23514 = check_violation — pins that this rejection came from
    // the CHECK constraint, not from a NOT NULL / type error / trigger.
    expect(pgError!.code).toBe('23514');
    // The constraint name is the contract that the migration must
    // produce. Keep the expected name aligned with data-model.md §5.7.
    expect(pgError!.constraint).toBe('users_valid_theme_preference');
  });

  it('AT-57: accepts all three allowed theme_preference values', async () => {
    const validValues = ['light', 'dark', 'system'];
    for (let i = 0; i < validValues.length; i++) {
      await pool.query(
        `INSERT INTO users (username, display_name, password_hash, theme_preference)
         VALUES ($1, $2, $3, $4)`,
        [
          `chk_theme_ok_${i}`,
          `CHECK accept ${validValues[i]}`,
          'placeholder-hash',
          validValues[i]!,
        ],
      );
    }
  });
});
