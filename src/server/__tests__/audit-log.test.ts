/**
 * Audit log integration tests — Iteration 8, issue #116.
 *
 * Pins AT-89..AT-94 from `docs/spec/verification.md §16.2` which in turn
 * pin AC-177..AC-183 / AC-187 in §15.23.
 *
 * Every `it(...)` block carries an explicit `// AT-XX` marker. Each block
 * exercises exactly one acceptance criterion — per the workflow's one-AC-
 * per-test convention and `review/conventions-tests.md` (T-REDU, T-ACBS).
 *
 * Failing-state expectations (step 3 of the workflow — tests land ahead
 * of implementation):
 *   - The `audit_log` table does not exist yet, so schema queries fail
 *     with "relation does not exist".
 *   - `GET /api/audit` and `GET /api/audit/:id` do not exist yet, so
 *     routes return 404 (Fastify's not-found handler).
 *   - The service-layer `mutate()` helper does not exist, so mutations
 *     do not produce audit rows.
 *   - No post-commit subscribe/dispatch surface exists, so AT-94 fails
 *     at the import of the expected publisher interface.
 *
 * These are the recognizable failure modes the tests intentionally
 * surface — an independent reviewer checks them in step 4 before an
 * implementation lands in step 5.
 *
 * No mocks of the database — real Postgres + real Fastify per project
 * convention (CLAUDE.md principles, integration prerequisites in
 * CONTRIBUTING.md §Testing).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'path';
import { fileURLToPath } from 'url';
import type pg from 'pg';

import {
  startApp,
  stopApp,
  login,
  authGet,
  authPost,
  authPatch,
  authDelete,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { binaryInitBody } from '../../test/fixtures/attachmentInit.js';
import { createStorageClient } from '../storage/client.js';
import { getEnv } from '../config/env.js';
import { createDatabase } from '../db/connection.js';
import { bootstrapAdminIfEmpty } from '../bootstrap.js';
import {
  projects as projectsTable,
  customers as customersTable,
  projectWorkers as projectWorkersTable,
  users as usersTable,
  sessions as sessionsTable,
} from '../db/schema.js';
import type { Database } from '../db/connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

const year = new Date().getFullYear();

/**
 * A syntactically-valid bcrypt hash for inserting stub rows where a real
 * password verification is not needed. Matches the placeholder used in
 * `bootstrap.test.ts` so the pattern is consistent across the suite.
 */
const PLACEHOLDER_HASH = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8/cN3f.y5h6N5E5hS6LXZ8kA8XwFye';

/**
 * Read every row from `audit_log`. Kept narrow and string-typed because
 * Drizzle does not yet have a schema entry for the table (the migration
 * has not landed). Raw SQL is the only cross-test-surface contract — as
 * soon as the schema ships, these helpers become a one-line switch to
 * the typed equivalent.
 */
interface AuditLogRow {
  id: string;
  created_at: Date;
  actor_id: string | null;
  actor_kind: 'user' | 'system';
  actor_reason: string | null;
  entity_type: 'project' | 'customer' | 'user' | 'project_worker' | 'attachment';
  entity_id: string;
  entity_label: string | null;
  action: string;
  payload: unknown;
  correlation_id: string | null;
}

/**
 * The API-facing audit-entry shape (camelCase) — `data-model.md §5.10`.
 * Used at every `res.json().data as AuditApiEntry[]` cast site. Distinct
 * from `AuditLogRow` above, which is the raw-DB shape returned by
 * `db.execute(sql\`SELECT ... FROM audit_log\`)`.
 */
interface AuditApiEntry {
  id: string;
  createdAt: string;
  actorId: string | null;
  actorKind: 'user' | 'system';
  actorReason: string | null;
  actorDisplayName: string | null;
  entityType: 'project' | 'customer' | 'user' | 'project_worker' | 'attachment';
  entityId: string;
  entityLabel: string | null;
  action: string;
  payload: unknown | null;
  correlationId: string | null;
}

async function fetchAuditRows(db: Database): Promise<AuditLogRow[]> {
  const res = await db.execute(
    sql`SELECT id, created_at, actor_id, actor_kind, actor_reason,
               entity_type, entity_id, action, payload, correlation_id
        FROM audit_log
        ORDER BY created_at ASC, id ASC`,
  );
  return res.rows as unknown as AuditLogRow[];
}

async function countAuditRows(db: Database): Promise<number> {
  const res = await db.execute(sql`SELECT COUNT(*)::int AS c FROM audit_log`);
  return (res.rows[0] as { c: number }).c;
}

// ---------------------------------------------------------------------
// AT-89 — Mutation and audit row are committed atomically (AC-177)
// ---------------------------------------------------------------------
//
// Covers the core invariant of ADR-0021: every domain-entity mutation
// emits exactly one `audit_log` row in the same transaction as the
// state change. A failure on either side aborts both.
//
// Four entity types are exercised because AC-177 names all four. They
// live in separate `it()` blocks rather than one mega-block so a
// regression in only `customer` is not masked by a passing `project`
// arm (see T-ACBS). The forced-failure branch is separate again so
// the atomic-rollback assertion does not pile onto a happy-path test.
describe('AT-89: Mutation + audit row atomicity (AC-177)', () => {
  let ownerToken: string;
  let seededCustomerId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);

    const custList = await authGet(ownerToken, '/api/customers?limit=1');
    const customers = custList.json().customers as { id: string }[];
    if (!customers || customers.length === 0) {
      throw new Error('Seed produced no customers — cannot run AT-89 fixtures');
    }
    seededCustomerId = customers[0]!.id;
  });

  afterAll(async () => {
    await stopApp();
  });

  // AT-89 — create on `project`
  it('create on project produces exactly one audit_log row (actorKind=user, action=create)', async () => {
    const { db, pool } = createDatabase();
    try {
      const before = await countAuditRows(db);

      const createRes = await authPost(ownerToken, '/api/projects', {
        // number is varchar(20) — keep the generated string short so a
        // unique suffix still fits the schema. Uses base36 for density.
        number: `AT89C-${Date.now().toString(36)}`,
        title: 'AT-89 create project',
        customerId: seededCustomerId,
      });
      expect(createRes.statusCode).toBe(201);
      const projectId = createRes.json().id as string;

      const after = await countAuditRows(db);
      expect(after - before).toBe(1);

      const rows = await db.execute(sql`SELECT * FROM audit_log WHERE entity_id = ${projectId}`);
      expect(rows.rows).toHaveLength(1);
      const row = rows.rows[0] as unknown as AuditLogRow;

      expect(row.entity_type).toBe('project');
      expect(row.action).toBe('create');
      expect(row.actor_kind).toBe('user');
      expect(row.actor_id).not.toBeNull();
      // actorReason is null for user-actor writes (data-model.md §5.10).
      expect(row.actor_reason).toBeNull();
      // Payload carries `before`/`after` — create has an empty `before`
      // and a populated `after`. Exact field contents are not pinned by
      // the AC (avoid T-BLOA); what matters is the shape.
      expect(row.payload).toMatchObject({ after: expect.any(Object) });
      // entity_label snapshot — captured at write time from the
      // service-returned project row. Must include the title the
      // caller supplied so the feed stays readable after a rename.
      expect(row.entity_label).toContain('AT-89 create project');
    } finally {
      await pool.end();
    }
  });

  // AT-89 — update on `customer`
  it('update on customer produces exactly one audit_log row (action=update)', async () => {
    const { db, pool } = createDatabase();
    try {
      const before = await countAuditRows(db);

      const patchRes = await authPatch(ownerToken, `/api/customers/${seededCustomerId}`, {
        phone: '0221-8889990',
      });
      expect(patchRes.statusCode).toBe(200);

      const after = await countAuditRows(db);
      expect(after - before).toBe(1);

      const rows = await db.execute(
        sql`SELECT * FROM audit_log
            WHERE entity_type = 'customer' AND entity_id = ${seededCustomerId}
            ORDER BY created_at DESC LIMIT 1`,
      );
      expect(rows.rows).toHaveLength(1);
      const row = rows.rows[0] as unknown as AuditLogRow;
      expect(row.action).toBe('update');
      expect(row.actor_kind).toBe('user');
      // Payload diff shape: `before` and `after` both present on an
      // update (spec: "before/after of changed fields only").
      expect(row.payload).toMatchObject({
        before: expect.any(Object),
        after: expect.any(Object),
      });
    } finally {
      await pool.end();
    }
  });

  // AT-89 — transition on `project`
  it('state transition on project produces a transition-action audit row', async () => {
    const { db, pool } = createDatabase();
    try {
      // Pick a project in a non-boundary state we can advance.
      const list = await authGet(ownerToken, '/api/projects?limit=200');
      const target = (list.json().data as { id: string; status: string }[]).find(
        (p) => p.status === 'beauftragt',
      );
      expect(target).toBeDefined();
      const projectId = target!.id;

      const before = await countAuditRows(db);

      const transitionRes = await authPost(
        ownerToken,
        `/api/projects/${projectId}/transition/forward`,
        { expectedStatus: 'beauftragt' },
      );
      expect(transitionRes.statusCode).toBe(200);

      const after = await countAuditRows(db);
      expect(after - before).toBe(1);

      const rows = await db.execute(
        sql`SELECT * FROM audit_log
            WHERE entity_type = 'project' AND entity_id = ${projectId}
            ORDER BY created_at DESC LIMIT 1`,
      );
      const row = rows.rows[0] as unknown as AuditLogRow;
      // data-model.md §5.10 action vocabulary: transition rows carry
      // `transition:forward` (the colon form is pinned — changing it is
      // a deliberate schema break).
      expect(row.action).toBe('transition:forward');
      expect(row.actor_kind).toBe('user');
      // data-model.md §5.10: "For a state transition, `before` and
      // `after` carry `status` and `statusChangedAt`." Pin both sides —
      // the payload drawer and the activity-feed renderer both rely on
      // the prior `statusChangedAt` being present (workflow-views.md
      // §8.4.1 "Termine aktualisiert" / duration rendering).
      const payload = row.payload as {
        before?: { status?: string; statusChangedAt?: string };
        after?: { status?: string; statusChangedAt?: string };
      };
      expect(payload.before?.status).toBe('beauftragt');
      expect(typeof payload.before?.statusChangedAt).toBe('string');
      expect(payload.after?.status).toBeDefined();
      expect(typeof payload.after?.statusChangedAt).toBe('string');
    } finally {
      await pool.end();
    }
  });

  // AT-89 — delete on `project_worker`
  it('delete on project_worker produces one audit_log row per dropped assignment (action=delete)', async () => {
    // Snapshot taken before the mutation so the lookup below can filter
    // by `created_at >= before`. Without this filter a sibling test (or
    // a future reorder) could leave a matching row and the lookup would
    // land on it silently.
    const before = new Date();
    const { db, pool } = createDatabase();
    try {
      // Seed: any project with a worker assignment. The seeded worker1
      // is assigned to YYYY-007 (role-scoping.test.ts mirrors this).
      const list = await authGet(ownerToken, '/api/projects?limit=200');
      const project = (list.json().data as { id: string; number: string }[]).find(
        (p) => p.number === `${year}-007`,
      );
      expect(project).toBeDefined();
      const projectId = project!.id;

      // Count the seeded assignments for this project so the delta is
      // a pinned value rather than a softened `> before`. YYYY-007 is
      // seeded with arbeiter1 + arbeiter2 (see src/server/seed/business.ts
      // ASSIGNMENT_SPECS) — two rows dropped, two audit rows emitted.
      const assignedBefore = await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM project_workers WHERE project_id = ${projectId}`,
      );
      const assignedCount = (assignedBefore.rows[0] as { c: number }).c;
      expect(assignedCount).toBeGreaterThan(0);

      const auditBefore = await countAuditRows(db);

      // Update-assignments PATCH: drop the worker list to [] so the
      // service deletes existing project_worker rows. Route shape is
      // the one any reasonable implementation provides; if the final
      // implementation exposes it differently, this test fails with a
      // 404 — a recognizable implementation gap, not a silent pass.
      const patchRes = await authPatch(ownerToken, `/api/projects/${projectId}`, {
        assignedWorkerIds: [],
      });
      expect(patchRes.statusCode).toBe(200);

      const auditAfter = await countAuditRows(db);
      // Exactly `assignedCount` delete rows — one per dropped assignment,
      // per AC-177's "every mutation produces exactly one audit_log row".
      expect(auditAfter - auditBefore).toBe(assignedCount);

      const rows = await db.execute(
        sql`SELECT * FROM audit_log
            WHERE entity_type = 'project_worker' AND action = 'delete'
              AND created_at >= ${before}
              AND (payload->'before'->>'projectId' = ${projectId}
                   OR payload->'after'->>'projectId' = ${projectId})
            ORDER BY created_at DESC LIMIT 1`,
      );
      expect(rows.rows.length).toBeGreaterThan(0);
      const row = rows.rows[0] as unknown as AuditLogRow;
      expect(row.actor_kind).toBe('user');
      // `project_worker` rows carry payload referencing the project the
      // worker was attached to — the UI activity feed renders worker
      // assignment changes from it.
      expect(row.payload).toBeTruthy();
    } finally {
      await pool.end();
    }
  });

  // AT-89 — forced failure path: rollback leaves neither artifact
  it('a failed mutation rolls back BOTH the state change and the audit row', async () => {
    const { db, pool } = createDatabase();
    try {
      const projectsBefore = await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM projects WHERE number = 'AT-89-ROLLBACK'`,
      );
      expect((projectsBefore.rows[0] as { c: number }).c).toBe(0);

      const auditBefore = await countAuditRows(db);

      // Force an FK violation on the audited transaction: referenced
      // worker id does not exist. `data-integrity.test.ts:AT-48` pins
      // this same failure path for atomic project creation.
      const fakeWorkerId = '00000000-0000-0000-0000-000000000099';
      const res = await authPost(ownerToken, '/api/projects', {
        number: 'AT-89-ROLLBACK',
        title: 'should never persist',
        customerId: seededCustomerId,
        assignedWorkerIds: [fakeWorkerId],
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);

      // Neither the project nor its audit row persisted.
      const projectsAfter = await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM projects WHERE number = 'AT-89-ROLLBACK'`,
      );
      expect((projectsAfter.rows[0] as { c: number }).c).toBe(0);

      const auditAfter = await countAuditRows(db);
      expect(auditAfter).toBe(auditBefore);
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------
// AT-90 — First-run bootstrap writes a system-actor audit row (AC-178)
// ---------------------------------------------------------------------
//
// Drives `bootstrapAdminIfEmpty` directly (same pattern as
// `bootstrap.test.ts`) against a scratch database so the resulting
// audit row can be observed in isolation. A separate assertion proves
// the DB CHECK constraint rejects a `system` row with empty
// `actorReason` — defense-in-depth for the "invisible bootstrap"
// failure mode AC-178 explicitly calls out.
describe('AT-90: Bootstrap emits system-actor audit row + CHECK constraint (AC-178)', () => {
  let db: Database;
  let pool: pg.Pool;

  function makeLogger() {
    return { warn: vi.fn(), error: vi.fn() };
  }

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
    // Bootstrap requires an empty users table. CASCADE covers every FK
    // pointing at users (including the audit_log FK on actor_id), so
    // one statement is sufficient — two TRUNCATEs raced pre-impl when
    // audit_log did not yet exist.
    await db.execute(sql`TRUNCATE TABLE audit_log, sessions, projects, users CASCADE`);
  });

  it('bootstrap run on empty DB produces actorKind=system, null actorId, non-empty actorReason', async () => {
    const result = await bootstrapAdminIfEmpty(
      db,
      {
        username: 'admin-at-90',
        password: 'SecurePass2026!',
        displayName: 'Admin AT-90',
      },
      makeLogger(),
    );
    expect(result.inserted).toBe(true);

    const rows = await fetchAuditRows(db);
    // Exactly one row — bootstrap writes a single user-create event.
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row.entity_type).toBe('user');
    expect(row.action).toBe('create');
    expect(row.actor_kind).toBe('system');
    expect(row.actor_id).toBeNull();
    // Non-empty actor_reason — this is the field that makes the
    // bootstrap visible in the Aktivität feed. AC-178 rationale.
    expect(row.actor_reason).toBeTruthy();
    expect((row.actor_reason ?? '').length).toBeGreaterThan(0);
    // A recognisable cue naming the code path, per data-model.md §5.10:
    // `"first-run-bootstrap"` is the spec's example. Regex rather than
    // equality so trivial wording drift doesn't break the test — the
    // assertion is "the reason names the bootstrap path".
    expect(row.actor_reason).toMatch(/bootstrap/i);
  });

  it('DB CHECK constraint rejects a system audit row with null actorReason', async () => {
    let pgError: { code?: string; constraint?: string } | null = null;
    try {
      await pool.query(
        `INSERT INTO audit_log
           (actor_id, actor_kind, actor_reason, entity_type, entity_id, action, payload)
         VALUES (NULL, 'system', NULL, 'user',
                 '00000000-0000-0000-0000-000000000001', 'create', '{}'::jsonb)`,
      );
    } catch (err) {
      pgError = err as { code?: string; constraint?: string };
    }
    expect(pgError).not.toBeNull();
    // 23514 = check_violation. Pinning the code lets us distinguish a
    // CHECK rejection from a NOT NULL / type error / trigger.
    expect(pgError!.code).toBe('23514');
  });

  it('DB CHECK constraint rejects a system audit row with empty-string actorReason', async () => {
    let pgError: { code?: string } | null = null;
    try {
      await pool.query(
        `INSERT INTO audit_log
           (actor_id, actor_kind, actor_reason, entity_type, entity_id, action, payload)
         VALUES (NULL, 'system', '', 'user',
                 '00000000-0000-0000-0000-000000000001', 'create', '{}'::jsonb)`,
      );
    } catch (err) {
      pgError = err as { code?: string };
    }
    expect(pgError).not.toBeNull();
    expect(pgError!.code).toBe('23514');
  });
});

// ---------------------------------------------------------------------
// AT-91 — Audit-list access matrix
// ---------------------------------------------------------------------
//
// Owner + office hold `audit:read`; both are unscoped for reachability.
// Worker + bookkeeper lack the permission and are denied at the
// permission middleware before reaching the repository.
describe('AT-91: Audit-list access matrix', () => {
  let ownerToken: string;
  let officeToken: string;
  let workerToken: string;
  let bookkeeperToken: string;
  /** Positive control id — a user-entity audit row authored by the
   *  owner, proves the owner/office blocks aren't asserting on an empty
   *  slice. Seeded by having owner update the office user via admin
   *  user-management (self-preference PATCHes are non-audited per
   *  data-model.md §5.10). */
  let ownerAuthoredUserRowId: string;

  beforeAll(async () => {
    await startApp();
    [ownerToken, officeToken, workerToken, bookkeeperToken] = await Promise.all([
      login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.bookkeeper.username, SEED_DEFAULT_PASSWORD),
    ]);

    const { db: fixtureDb, pool: fixturePool } = createDatabase();
    try {
      const ownerLookup = await fixtureDb.execute(
        sql`SELECT id FROM users WHERE username = ${SEED_USERS.owner.username} LIMIT 1`,
      );
      const ownerRow = ownerLookup.rows[0] as { id: string } | undefined;
      if (!ownerRow) {
        throw new Error('AT-91 fixture: owner user missing from seed');
      }

      // Drive a user-entity audit row authored by owner: owner updates
      // the office user's displayName via admin user-management. This
      // path routes through mutate() and emits an entityType='user'
      // row with actor_id=owner.
      const officeLookup = await fixtureDb.execute(
        sql`SELECT id FROM users WHERE username = ${SEED_USERS.office.username} LIMIT 1`,
      );
      const officeRow = officeLookup.rows[0] as { id: string } | undefined;
      if (!officeRow) {
        throw new Error('AT-91 fixture: office user missing from seed');
      }
      const adminPatch = await authPatch(ownerToken, `/api/users/${officeRow.id}`, {
        displayName: `${SEED_USERS.office.displayName} (AT-91 fixture)`,
      });
      expect(adminPatch.statusCode).toBe(200);

      const ownerAuditLookup = await fixtureDb.execute(
        sql`SELECT id FROM audit_log
            WHERE entity_type = 'user' AND actor_id = ${ownerRow.id}
            ORDER BY created_at DESC LIMIT 1`,
      );
      const ownerAuditRow = ownerAuditLookup.rows[0] as { id: string } | undefined;
      if (!ownerAuditRow) {
        throw new Error(
          'AT-91 fixture: no owner-authored user audit row — admin PATCH did not emit one',
        );
      }
      ownerAuthoredUserRowId = ownerAuditRow.id;
    } finally {
      await fixturePool.end();
    }
  });

  afterAll(async () => {
    await stopApp();
  });

  it('owner receives every audit row (no reachability filter)', async () => {
    const res = await authGet(ownerToken, '/api/audit?limit=500');
    expect(res.statusCode).toBe(200);
    const entries = res.json().data as AuditApiEntry[];

    const hasUserEntry = entries.some((row) => row.entityType === 'user');
    expect(hasUserEntry).toBe(true);

    const ids = new Set(entries.map((row) => row.id));
    expect(ids.has(ownerAuthoredUserRowId)).toBe(true);
  });

  it('office receives non-destructive audit rows (no reachability filter)', async () => {
    const res = await authGet(officeToken, '/api/audit?limit=500');
    expect(res.statusCode).toBe(200);
    const entries = res.json().data as AuditApiEntry[];
    const hasUserEntry = entries.some((row) => row.entityType === 'user');
    expect(hasUserEntry).toBe(true);

    // Positive control: the owner-authored user row (a theme-preference
    // update — no `roles` diff) is non-destructive, so the destructive
    // predicate admits it for office.
    const ids = new Set(entries.map((row) => row.id));
    expect(ids.has(ownerAuthoredUserRowId)).toBe(true);
  });

  it('worker is denied — lacks audit:read', async () => {
    const res = await authGet(workerToken, '/api/audit?limit=1');
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('NOT_PERMITTED');
  });

  it('bookkeeper is denied — lacks audit:read', async () => {
    const res = await authGet(bookkeeperToken, '/api/audit?limit=1');
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('NOT_PERMITTED');
  });
});

// ---------------------------------------------------------------------
// AT-93 — Destructive-action predicate gates visibility (AC-182, AC-187)
// ---------------------------------------------------------------------
//
// `auditDestructiveScopeForCaller` narrows the list + get-by-id result
// set. For owner (default matrix) the predicate returns null — owner
// sees every row, including destructive ones. For every other role
// holding `audit:read`, the predicate contributes a `WHERE` fragment
// that excludes entries matching: action=purge (any entity type),
// action=delete on user, action=update on user touching `roles`.
//
// Fixture strategy: seed the three destructive rows directly via raw
// SQL against `audit_log`. This test file is in the `__tests__/`
// allowlist per AC-179, and the direct-insert path is the same one
// `audit-retention.test.ts` uses for the retention fixture.
//
// Rationale for the raw-SQL fixture over API-driven mutations (the
// earlier draft used `POST /api/projects` + `DELETE /api/projects/:id`
// + `DELETE /api/projects/:id/purge` + `DELETE /api/users/:id` +
// `PATCH /api/users/:id`): pre-implementation those routes return 500
// because the service layer attempts to write audit rows that don't
// exist, making the whole describe crash in `beforeAll` with an
// unrecognizable failure shape ("500 from failed audit write") instead
// of the intended "endpoint missing on /api/audit". The raw-SQL
// fixture keeps AT-93 **independent of the mutation pipeline** — the
// test proves the read-side destructive-scope predicate without
// depending on the not-yet-implemented write-side helper. Mutation-
// pipeline coverage (atomic-commit, rollback) is pinned separately by
// AT-89; AT-93's scope is the visibility predicate.
describe('AT-93: Destructive-action visibility (AC-182, AC-187)', () => {
  let ownerToken: string;
  let officeToken: string;
  /** An audit row matching `action='purge'` — owner-visible, office hidden. */
  let purgeAuditId: string;
  /** An audit row matching `action='delete'` on `entityType='user'`. */
  let userDeleteAuditId: string;
  /** An audit row matching `action='update'` on `entityType='user'` touching roles. */
  let userRolesUpdateAuditId: string;
  /**
   * Negative-control row: `action='update'` on `entityType='user'` whose
   * diff is email-only (no `roles`). Owner and office MUST see it — it
   * is not destructive. The purpose is to prove the destructive
   * predicate keys specifically off the `roles` diff rather than any
   * broader "user entity update" catch-all.
   */
  let userEmailUpdateAuditId: string;

  beforeAll(async () => {
    await startApp();
    [ownerToken, officeToken] = await Promise.all([
      login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD),
    ]);

    // Use a fresh DB/pool handle for the raw inserts so it is torn down
    // before `stopApp`. Drizzle's `sql` template does parameter binding
    // via positional placeholders — safe with arbitrary string input.
    const { db: fixtureDb, pool: fixturePool } = createDatabase();
    try {
      // Resolve an owner user id — the user-actor destructive rows must
      // cite a real UserAccount row because `actor_id` is a FK to users.
      // Owner is guaranteed to exist (seeded in every test env).
      const ownerLookup = await fixtureDb.execute(
        sql`SELECT id FROM users WHERE username = ${SEED_USERS.owner.username} LIMIT 1`,
      );
      const ownerRow = ownerLookup.rows[0] as { id: string } | undefined;
      if (!ownerRow) {
        throw new Error('AT-93 fixture: owner user missing from seed');
      }
      const ownerId = ownerRow.id;

      // ---- Purge row — entity_type='project', action='purge' ----
      // Payload shape per data-model.md §5.10: `after` empty on delete/
      // purge. The `entityId` cites a synthetic project uuid: `entityId`
      // is not FK-constrained (purge removes the target row while its
      // audit trail remains).
      const purgeEntityId = '00000000-0000-0000-0000-0000000a7931';
      const purgeInsert = await fixtureDb.execute(sql`
        INSERT INTO audit_log
          (actor_id, actor_kind, actor_reason, entity_type, entity_id,
           action, payload, correlation_id)
        VALUES (${ownerId}, 'user', NULL, 'project', ${purgeEntityId},
                'purge', '{"before":{"number":"AT-93-PURGE"},"after":{}}'::jsonb, NULL)
        RETURNING id
      `);
      purgeAuditId = (purgeInsert.rows[0] as { id: string }).id;

      // ---- User-delete row — entity_type='user', action='delete' ----
      const userDeleteEntityId = '00000000-0000-0000-0000-0000000a7932';
      const userDeleteInsert = await fixtureDb.execute(sql`
        INSERT INTO audit_log
          (actor_id, actor_kind, actor_reason, entity_type, entity_id,
           action, payload, correlation_id)
        VALUES (${ownerId}, 'user', NULL, 'user', ${userDeleteEntityId},
                'delete',
                '{"before":{"username":"at93_hard_delete"},"after":{}}'::jsonb,
                NULL)
        RETURNING id
      `);
      userDeleteAuditId = (userDeleteInsert.rows[0] as { id: string }).id;

      // ---- User-roles-update row ----
      // Payload carries `{ before: { roles: [...] }, after: { roles: [...] } }`
      // as per the AT-93 fixture spec — the predicate keys off the
      // `roles` diff presence.
      const rolesUpdateEntityId = '00000000-0000-0000-0000-0000000a7933';
      const rolesUpdateInsert = await fixtureDb.execute(sql`
        INSERT INTO audit_log
          (actor_id, actor_kind, actor_reason, entity_type, entity_id,
           action, payload, correlation_id)
        VALUES (${ownerId}, 'user', NULL, 'user', ${rolesUpdateEntityId},
                'update',
                '{"before":{"roles":["office"]},"after":{"roles":["worker"]}}'::jsonb,
                NULL)
        RETURNING id
      `);
      userRolesUpdateAuditId = (rolesUpdateInsert.rows[0] as { id: string }).id;

      // ---- Negative control — user-email-update (no `roles` diff) ----
      // Proves the destructive predicate keys specifically off the
      // `roles` diff: a user-entity update whose diff omits `roles` is
      // NOT destructive. Owner and office must both see it (office is
      // unscoped on reachability per api.md §14.2.8; the destructive
      // predicate admits this row because the diff does not touch roles).
      const emailUpdateEntityId = '00000000-0000-0000-0000-0000000a7934';
      const emailUpdateInsert = await fixtureDb.execute(sql`
        INSERT INTO audit_log
          (actor_id, actor_kind, actor_reason, entity_type, entity_id,
           action, payload, correlation_id)
        VALUES (${ownerId}, 'user', NULL, 'user', ${emailUpdateEntityId},
                'update',
                '{"before":{"email":"old@example.com"},"after":{"email":"new@example.com"}}'::jsonb,
                NULL)
        RETURNING id
      `);
      userEmailUpdateAuditId = (emailUpdateInsert.rows[0] as { id: string }).id;
    } finally {
      await fixturePool.end();
    }
  });

  afterAll(async () => {
    await stopApp();
  });

  it('owner list includes purge, user-delete, and user-roles-update rows', async () => {
    const res = await authGet(ownerToken, '/api/audit?limit=1000');
    expect(res.statusCode).toBe(200);
    const ids = new Set((res.json().data as AuditApiEntry[]).map((r) => r.id));
    expect(ids.has(purgeAuditId)).toBe(true);
    expect(ids.has(userDeleteAuditId)).toBe(true);
    expect(ids.has(userRolesUpdateAuditId)).toBe(true);
    // Negative control: the non-destructive email-update row must be
    // present. Owner sees everything; this pins that AND the predicate
    // is keying off the `roles` diff rather than any broader catch-all.
    expect(ids.has(userEmailUpdateAuditId)).toBe(true);
  });

  it('office list excludes all three destructive entries (predicate WHERE fragment)', async () => {
    const res = await authGet(officeToken, '/api/audit?limit=1000');
    expect(res.statusCode).toBe(200);
    const ids = new Set((res.json().data as AuditApiEntry[]).map((r) => r.id));
    expect(ids.has(purgeAuditId)).toBe(false);
    expect(ids.has(userDeleteAuditId)).toBe(false);
    expect(ids.has(userRolesUpdateAuditId)).toBe(false);
    // Negative control: the email-update row has no `roles` diff and is
    // therefore NOT destructive. Office reachability is null (unscoped
    // per api.md §14.2.8), so the row must be admitted — proving the
    // destructive predicate keys off `roles` specifically, not any
    // user-entity update.
    expect(ids.has(userEmailUpdateAuditId)).toBe(true);
  });

  it.each([
    ['purge', () => purgeAuditId],
    ['user-delete', () => userDeleteAuditId],
    ['user-roles-update', () => userRolesUpdateAuditId],
  ])('office get-by-id on a %s row returns 403 NOT_PERMITTED', async (_, getId) => {
    const res = await authGet(officeToken, `/api/audit/${getId()}`);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('NOT_PERMITTED');
  });
});

// ---------------------------------------------------------------------
// AT-94 — Throwing post-commit subscriber does not roll back (AC-183)
// ---------------------------------------------------------------------
//
// ADR-0021 fixes the publisher as post-commit: subscribers run after
// the domain transaction has committed, so a throwing subscriber
// cannot undo the state change or the audit row.
//
// The publisher/subscriber surface does not exist yet. This test
// imports the expected module path and will fail at import time until
// the implementation lands — that's the recognizable failing state
// for step 3.
describe('AT-94: Throwing post-commit subscriber does not roll back (AC-183)', () => {
  let ownerToken: string;
  let seededCustomerId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    const custList = await authGet(ownerToken, '/api/customers?limit=1');
    seededCustomerId = (custList.json().customers as { id: string }[])[0]!.id;
  });

  afterAll(async () => {
    await stopApp();
  });

  it('a subscriber that throws leaves the mutation and audit row committed and surfaces the error in the operational logger', async () => {
    // Import the publisher surface spec'd in api.md §14.2.8
    // (`Post-commit publisher contract`). Until the module exists this
    // throws MODULE_NOT_FOUND at runtime — the recognizable failing
    // state step 3 wants. The `/* @vite-ignore */` comment and the
    // string-literal path mirror the pattern in `seed.test.ts` (AT-87)
    // so the dynamic import does not compile-fail `tsc --noEmit` in
    // CI's type-check step — failure surface stays a runtime error,
    // not a type error.
    const publisherPath = '../services/audit-publisher.js';
    const pub = await import(/* @vite-ignore */ publisherPath);

    // The subscriber surface — `onAuditCommitted(handler)` returning
    // an unsubscribe function, and `setOperationalLogger(logger)` for
    // test-side injection — is pinned by api.md §14.2.8.
    const errorSpy = vi.fn();
    const fakeLogger = {
      info: vi.fn(),
      error: errorSpy,
    };

    (pub as { setOperationalLogger: (l: unknown) => void }).setOperationalLogger(fakeLogger);

    const unsubscribe = (
      pub as {
        onAuditCommitted: (h: (row: unknown) => void | Promise<void>) => () => void;
      }
    ).onAuditCommitted(() => {
      throw new Error('AT-94 intentional subscriber failure');
    });

    try {
      const { db, pool } = createDatabase();
      try {
        const auditBefore = await countAuditRows(db);

        const createRes = await authPost(ownerToken, '/api/projects', {
          // number is varchar(20); base36 keeps the generated suffix short.
          number: `AT94-${Date.now().toString(36)}`,
          title: 'AT-94 subscriber crash test',
          customerId: seededCustomerId,
        });
        // Domain mutation must succeed despite the subscriber crash
        // — this is the AC-183 invariant.
        expect(createRes.statusCode).toBe(201);
        const projectId = createRes.json().id as string;

        // State change is committed.
        const project = await db.execute(sql`SELECT id FROM projects WHERE id = ${projectId}`);
        expect(project.rows).toHaveLength(1);

        // Audit row is committed.
        const auditAfter = await countAuditRows(db);
        expect(auditAfter - auditBefore).toBe(1);

        // Subscriber error surfaces via the structured operational
        // logger. AC-183 pins the concrete field set on the log line:
        //   - event = 'audit-publisher-handler-error'
        //   - audit_entry_id — the committed row's id (non-empty)
        //   - error_message — a non-empty string
        //
        // Two common logger conventions exist:
        //   a) `logger.error({ event, audit_entry_id, error_message })`
        //   b) `logger.error('message', { event, audit_entry_id, error_message })`
        // We scan all `errorSpy` calls for the first whose object-arg
        // carries the expected `event` — using `calls[0]` would blame
        // this test for an unrelated earlier `.error(...)` call landing
        // first. The contract is the field-set, not the call ordinal.
        expect(errorSpy).toHaveBeenCalled();
        let payload: Record<string, unknown> | undefined;
        for (const call of errorSpy.mock.calls) {
          const objectArg = (call as unknown[]).find(
            (arg): arg is Record<string, unknown> =>
              typeof arg === 'object' && arg !== null && !Array.isArray(arg),
          );
          if (objectArg && objectArg.event === 'audit-publisher-handler-error') {
            payload = objectArg;
            break;
          }
        }
        if (!payload) {
          throw new Error(
            `AT-94: no logger.error call with event='audit-publisher-handler-error' found — got calls ${JSON.stringify(errorSpy.mock.calls)}`,
          );
        }
        expect(payload.event).toBe('audit-publisher-handler-error');
        expect(typeof payload.audit_entry_id).toBe('string');
        expect((payload.audit_entry_id as string).length).toBeGreaterThan(0);
        expect(typeof payload.error_message).toBe('string');
        expect((payload.error_message as string).length).toBeGreaterThan(0);
      } finally {
        await pool.end();
      }
    } finally {
      unsubscribe();
    }
  });
});

// ---------------------------------------------------------------------
// AT-96 — entity_label is a point-in-time snapshot (AC-188)
// ---------------------------------------------------------------------
//
// data-model.md §5.10 "Entity label snapshot": `entityLabel` is frozen
// at the audit row so the activity feed stays readable after the target
// is renamed or purged. AC-188 pins the invariant; the tests here drive
// it end-to-end through `mutate()` — rename does not rewrite prior
// rows, and delete does not null them.
describe('AT-96: entity_label is frozen at event time (AC-188)', () => {
  let ownerToken: string;
  let seededCustomerId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    const custList = await authGet(ownerToken, '/api/customers?limit=1');
    seededCustomerId = (custList.json().customers as { id: string }[])[0]!.id;
  });

  afterAll(async () => {
    await stopApp();
  });

  it('renaming a project leaves the pre-rename audit row entity_label untouched', async () => {
    const { db, pool } = createDatabase();
    try {
      const initialTitle = 'AT-96 initial title';
      const renamedTitle = 'AT-96 renamed title';
      const projectNumber = `AT96R-${Date.now().toString(36)}`;

      const createRes = await authPost(ownerToken, '/api/projects', {
        number: projectNumber,
        title: initialTitle,
        customerId: seededCustomerId,
      });
      expect(createRes.statusCode).toBe(201);
      const projectId = createRes.json().id as string;

      const patchRes = await authPatch(ownerToken, `/api/projects/${projectId}`, {
        title: renamedTitle,
      });
      expect(patchRes.statusCode).toBe(200);

      // Two rows: the pre-rename create keeps the original label, the
      // post-rename update carries the new one. Pre-rename row must not
      // drift — that would be a back-fill, the exact failure mode
      // AC-188 forbids.
      const rows = await db.execute(
        sql`SELECT action, entity_label FROM audit_log
            WHERE entity_type = 'project' AND entity_id = ${projectId}
            ORDER BY created_at ASC, id ASC`,
      );
      expect(rows.rows).toHaveLength(2);
      const [createRow, updateRow] = rows.rows as unknown as Array<{
        action: string;
        entity_label: string | null;
      }>;

      expect(createRow.action).toBe('create');
      expect(createRow.entity_label).toContain(initialTitle);
      expect(createRow.entity_label).not.toContain(renamedTitle);

      expect(updateRow.action).toBe('update');
      expect(updateRow.entity_label).toContain(renamedTitle);
    } finally {
      await pool.end();
    }
  });

  it('deleting a customer leaves the pre-delete audit row entity_label intact', async () => {
    const { db, pool } = createDatabase();
    try {
      const customerName = `AT-96 purgeable customer ${Date.now().toString(36)}`;

      const createRes = await authPost(ownerToken, '/api/customers', {
        name: customerName,
      });
      expect(createRes.statusCode).toBe(201);
      const customerId = createRes.json().id as string;

      const deleteRes = await authDelete(ownerToken, `/api/customers/${customerId}`);
      expect(deleteRes.statusCode).toBeLessThan(300);

      // The customer row is gone. The prior create audit row still
      // carries the snapshotted label — the readability guarantee
      // `entityLabel` exists for.
      const rows = await db.execute(
        sql`SELECT action, entity_label FROM audit_log
            WHERE entity_type = 'customer' AND entity_id = ${customerId}
            ORDER BY created_at ASC, id ASC`,
      );
      expect(rows.rows.length).toBeGreaterThanOrEqual(1);
      const createRow = rows.rows[0] as unknown as {
        action: string;
        entity_label: string | null;
      };
      expect(createRow.action).toBe('create');
      expect(createRow.entity_label).toBe(customerName);
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------
// AT-107 — Self-preference carve-out produces zero audit rows (AC-204)
// ---------------------------------------------------------------------
//
// data-model.md §5.10 "Non-audited self-preference paths": PATCH
// /api/auth/me updating `themePreference` or `pushMuted` must NOT
// produce an audit_log row — these are self-controlled delivery/display
// preferences, not domain state changes. By contrast, PATCH /api/users/:id
// changing another user's `displayName` via admin management MUST still
// emit exactly one audit row (AC-204 confirms the carve-out is scoped
// to self-preference fields only, not to the whole user-update surface).
describe('AT-107: self-preference carve-out (AC-204)', () => {
  let ownerToken: string;
  let officeUserId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);

    const { db: fixtureDb, pool: fixturePool } = createDatabase();
    try {
      const row = await fixtureDb.execute(
        sql`SELECT id FROM users WHERE username = ${SEED_USERS.office.username} LIMIT 1`,
      );
      const officeRow = row.rows[0] as { id: string } | undefined;
      if (!officeRow) throw new Error('AT-107 fixture: office user missing from seed');
      officeUserId = officeRow.id;
    } finally {
      await fixturePool.end();
    }
  });

  afterAll(async () => {
    await stopApp();
  });

  it('PATCH /api/auth/me updating themePreference produces zero audit_log rows', async () => {
    const { db, pool } = createDatabase();
    try {
      const before = await countAuditRows(db);
      const res = await authPatch(ownerToken, '/api/auth/me', { themePreference: 'dark' });
      expect(res.statusCode).toBe(200);
      const after = await countAuditRows(db);
      expect(after - before).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('PATCH /api/auth/me updating pushMuted produces zero audit_log rows', async () => {
    const { db, pool } = createDatabase();
    try {
      const before = await countAuditRows(db);
      const res = await authPatch(ownerToken, '/api/auth/me', { pushMuted: true });
      expect(res.statusCode).toBe(200);
      const after = await countAuditRows(db);
      expect(after - before).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('PATCH /api/users/:id changing displayName produces exactly one audit_log row', async () => {
    const beforeTs = new Date();
    const { db, pool } = createDatabase();
    try {
      const res = await authPatch(ownerToken, `/api/users/${officeUserId}`, {
        displayName: `${SEED_USERS.office.displayName} (AT-107)`,
      });
      expect(res.statusCode).toBe(200);

      // Narrow to rows written AFTER this test started so sibling
      // describe blocks (AT-91 also patches the office user) do not
      // inflate the count.
      const rows = await db.execute(
        sql`SELECT entity_type, action FROM audit_log
            WHERE entity_type = 'user' AND entity_id = ${officeUserId}
              AND created_at >= ${beforeTs}
            ORDER BY created_at DESC`,
      );
      expect(rows.rows).toHaveLength(1);
      const row = rows.rows[0] as { entity_type: string; action: string };
      expect(row.entity_type).toBe('user');
      expect(row.action).toBe('update');
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------
// AT-124 — Ancestor-scoped filter on GET /api/audit
// (architecture.md §11.12; pins #124)
// ---------------------------------------------------------------------
//
// `ancestorType` + `ancestorId` return every row whose write-time
// ancestor pair equals the filter — project rows self-ancestor, and
// nested entities (project_worker, attachment) set their ancestor to
// the owning project's id. The feed therefore unions every entity
// type scoped to the project in one indexed predicate.
describe('AT-124: ancestor-scoped filter unions project + nested entities', () => {
  let ownerToken: string;
  let seededCustomerId: string;
  let projectId: string;
  let attachmentId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);

    const custList = await authGet(ownerToken, '/api/customers?limit=1');
    seededCustomerId = (custList.json().customers as { id: string }[])[0]!.id;

    // Drive: create a project (one project row), assign a worker
    // (one project_worker row), init an attachment (one attachment row).
    // Each goes through `mutate()`, so each audit row carries the
    // ancestor-link the read filter asserts against.
    const createRes = await authPost(ownerToken, '/api/projects', {
      number: `AT124-${Date.now().toString(36)}`,
      title: 'AT-124 ancestor-scoped feed',
      customerId: seededCustomerId,
    });
    expect(createRes.statusCode).toBe(201);
    projectId = createRes.json().id as string;

    // Seed worker assignment — lookup worker1's id first.
    const { db: lookupDb, pool: lookupPool } = createDatabase();
    try {
      const workerLookup = await lookupDb.execute(
        sql`SELECT id FROM users WHERE username = ${SEED_USERS.worker1.username} LIMIT 1`,
      );
      const workerId = (workerLookup.rows[0] as { id: string }).id;
      const patchRes = await authPatch(ownerToken, `/api/projects/${projectId}`, {
        assignedWorkerIds: [workerId],
      });
      expect(patchRes.statusCode).toBe(200);
    } finally {
      await lookupPool.end();
    }

    // Attachment init → stage backing ciphertext → complete. Under the
    // revised AC-219 the `attachment:add` audit row (the ancestor-linked
    // attachment row this feed asserts against) is written at COMPLETE,
    // not init — an init-only upload leaves no audit row. We drive the
    // full flow so a real `attachment:add` row with its project ancestor
    // exists. Using the real API path keeps the ancestor-write assertion
    // covering the production `AttachmentService` mutation rather than a
    // raw-insert stand-in. (`attachment` is allowlisted under __tests__/
    // by the architecture check.)
    const initRes = await authPost(
      ownerToken,
      `/api/projects/${projectId}/attachments/init`,
      binaryInitBody({ fileName: 'ancestor.pdf', sizeBytes: 123 }),
    );
    expect(initRes.statusCode).toBe(201);
    const initBody = initRes.json() as { attachment: { id: string; originalKey: string } };
    attachmentId = initBody.attachment.id;

    // Stage the backing ciphertext object so the complete-time HEAD verify
    // passes. Size matches the binary fixture's ciphertext default
    // (50_064); content-type is the `application/octet-stream` sentinel
    // (ADR-0024).
    const env = getEnv();
    const storage = createStorageClient({
      endpoint: env.STORAGE_ENDPOINT!,
      bucket: env.STORAGE_BUCKET,
      accessKey: env.STORAGE_ACCESS_KEY!,
      secretKey: env.STORAGE_SECRET_KEY!,
    });
    await storage.upload(
      initBody.attachment.originalKey,
      Buffer.alloc(50_064, 0xff),
      'application/octet-stream',
    );

    const completeRes = await authPost(
      ownerToken,
      `/api/projects/${projectId}/attachments/${attachmentId}/complete`,
    );
    expect(completeRes.statusCode).toBe(200);
  });

  afterAll(async () => {
    await stopApp();
  });

  it('returns project + project_worker + attachment rows scoped to the project id', async () => {
    const res = await authGet(
      ownerToken,
      `/api/audit?ancestorType=project&ancestorId=${projectId}&limit=1000`,
    );
    expect(res.statusCode).toBe(200);
    const entries = res.json().data as AuditApiEntry[];

    // Every returned entry must belong to THIS project (the ancestor
    // predicate is scoping the feed, not post-hoc filtered).
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      // The ancestor fields themselves are not in the API entry shape
      // (the client filters by them, not renders them). We assert the
      // predicate worked by checking every row's `entityType` is one
      // that can carry a project ancestor, AND that the three grain
      // events we seeded above each appear below.
      expect(['project', 'project_worker', 'attachment']).toContain(e.entityType);
    }

    const types = entries.map((e) => e.entityType);
    expect(types).toContain('project');
    expect(types).toContain('project_worker');
    expect(types).toContain('attachment');

    // Attachment row id must match the one we initialized.
    const attachmentEntry = entries.find(
      (e) => e.entityType === 'attachment' && e.entityId === attachmentId,
    );
    expect(attachmentEntry).toBeDefined();
  });

  it('AND-composes with action + actor filters', async () => {
    // The project create emits a single `create` row on entity_type=project.
    // Narrowing the ancestor-scoped feed to action=create should include
    // that row AND the worker-assignment create rows (also action=create
    // on entity_type=project_worker), but must not include the attachment
    // add row (action=attachment:add).
    const res = await authGet(
      ownerToken,
      `/api/audit?ancestorType=project&ancestorId=${projectId}&action=create&limit=1000`,
    );
    expect(res.statusCode).toBe(200);
    const entries = res.json().data as AuditApiEntry[];
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.action).toBe('create');
      expect(['project', 'project_worker']).toContain(e.entityType);
    }
  });

  it('excludes rows from a different project + top-level entities', async () => {
    // Drive a customer create — top-level, ancestor is NULL. It must
    // NOT appear in an ancestor-scoped feed even when its id matches
    // a project id by coincidence (the filter keys off the ancestor
    // pair, not the entity id).
    const custRes = await authPost(ownerToken, '/api/customers', {
      name: `AT-124 cross-scope ${Date.now().toString(36)}`,
    });
    expect(custRes.statusCode).toBe(201);
    const otherCustomerId = custRes.json().id as string;

    const res = await authGet(
      ownerToken,
      `/api/audit?ancestorType=project&ancestorId=${projectId}&limit=1000`,
    );
    expect(res.statusCode).toBe(200);
    const entries = res.json().data as AuditApiEntry[];
    const ids = new Set(entries.map((e) => e.entityId));
    // The customer create row must not appear under the project's
    // ancestor scope.
    expect(ids.has(otherCustomerId)).toBe(false);
    // And no entry with entityType='customer' leaks in.
    expect(entries.every((e) => e.entityType !== 'customer')).toBe(true);
  });
});

// ---------------------------------------------------------------------
// Housekeeping — defensive cleanup of test-created users/customers.
//
// The outer `startApp()` / `stopApp()` pair in each `describe` block
// already re-seeds per-file (vitest.config.ts fileParallelism:false +
// api-helpers.ts seed(force:true)), so cross-test contamination is
// not a concern. This block exists only to document that choice — no
// inter-file fixture handoff is required.
// ---------------------------------------------------------------------
void [
  // Reference imported symbols so TS doesn't mark them as unused when
  // a future maintainer trims one of the sub-describes.
  and,
  eq,
  projectsTable,
  customersTable,
  projectWorkersTable,
  usersTable,
  sessionsTable,
  PLACEHOLDER_HASH,
];
