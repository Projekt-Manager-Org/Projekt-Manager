/**
 * Notification rules CRUD integration tests — Iteration 8, issue #112.
 *
 * Pins AC-189 / AC-190 / AC-193 / AC-203 / AC-393 in §15.24.
 *
 * Failing-state expectations (step 3 of the workflow — tests land ahead
 * of implementation):
 *   - The `notification_rule` table does not exist yet, so list / get /
 *     create / update / delete all hit a 404 (route missing) or 500
 *     (relation missing) — both are recognizable "implementation gap"
 *     failure modes.
 *   - Rule mutations do not write audit_log rows (ADR-0023 §Decision).
 *   - The `notifications:manage` permission does not yet exist in
 *     `ROLE_PERMISSIONS`, so the owner path fails 403 — correct gap.
 *
 * No mocks of the database — real Postgres + real Fastify per project
 * convention (CONTRIBUTING.md §Testing, CLAUDE.md principles).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';

import {
  startApp,
  stopApp,
  login,
  authGet,
  authPost,
  authPatch,
  authDelete,
  getApp,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';

/**
 * The API-facing notification-rule shape (camelCase) — data-model.md §5.11.
 * Redeclared locally to pin the contract; until the schema ships, an
 * import of `NotificationRule` from `src/server/db/schema.ts` would fail
 * at compile time — the integration harness prefers runtime assertions
 * that surface the gap at `inject()` time.
 */
interface NotificationRuleApi {
  id: string;
  eventClass: string;
  stateFilter: string | null;
  recipientSpec: {
    roles: string[];
    includeAssignedWorkers: boolean;
    userIds: string[];
  };
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: string | null;
  updatedBy?: string | null;
}

// ---------------------------------------------------------------------
// AC-189 — Permission matrix on rule CRUD
// ---------------------------------------------------------------------
//
// `notifications:manage` (owner-only under the default matrix). Office,
// worker, and bookkeeper receive 403; unauthenticated → 401. Permission
// failures are asserted per-HTTP-method because middleware is often
// wired per-route — a regression that forgets the gate on DELETE but
// keeps it on POST would otherwise slip through.
describe('Notification-rule CRUD permission matrix (AC-189)', () => {
  let ownerToken: string;
  let officeToken: string;
  let workerToken: string;
  let bookkeeperToken: string;

  beforeAll(async () => {
    await startApp();
    [ownerToken, officeToken, workerToken, bookkeeperToken] = await Promise.all([
      login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.bookkeeper.username, SEED_DEFAULT_PASSWORD),
    ]);
  });

  afterAll(async () => {
    await stopApp();
  });

  it('owner GET /api/notification-rules returns 200 with an array envelope', async () => {
    const res = await authGet(ownerToken, '/api/notification-rules');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('owner POST /api/notification-rules returns 201 with the persisted rule', async () => {
    const res = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.transition_forward',
      stateFilter: 'in_arbeit',
      recipientSpec: {
        roles: ['owner'],
        includeAssignedWorkers: false,
        userIds: [],
      },
      enabled: true,
    });
    expect(res.statusCode).toBe(201);
    const rule = res.json() as NotificationRuleApi;
    expect(rule.id).toBeDefined();
    expect(rule.eventClass).toBe('project.transition_forward');
    expect(rule.stateFilter).toBe('in_arbeit');
    expect(rule.recipientSpec.roles).toEqual(['owner']);
    expect(rule.enabled).toBe(true);
  });

  // Non-admin roles: separate `it()` per role × HTTP method so a gate
  // missing on a single (role, method) pair surfaces specifically rather
  // than hiding behind a passing peer.
  for (const [role, tokenName] of [
    ['office', 'officeToken'],
    ['worker', 'workerToken'],
    ['bookkeeper', 'bookkeeperToken'],
  ] as const) {
    it(`${role} GET /api/notification-rules → 403 NOT_PERMITTED`, async () => {
      const token =
        tokenName === 'officeToken'
          ? officeToken
          : tokenName === 'workerToken'
            ? workerToken
            : bookkeeperToken;
      const res = await authGet(token, '/api/notification-rules');
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it(`${role} POST /api/notification-rules → 403 NOT_PERMITTED`, async () => {
      const token =
        tokenName === 'officeToken'
          ? officeToken
          : tokenName === 'workerToken'
            ? workerToken
            : bookkeeperToken;
      const res = await authPost(token, '/api/notification-rules', {
        eventClass: 'project.transition_forward',
        recipientSpec: { roles: ['owner'], includeAssignedWorkers: false, userIds: [] },
        enabled: true,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it(`${role} DELETE /api/notification-rules/:id → 403 NOT_PERMITTED`, async () => {
      const token =
        tokenName === 'officeToken'
          ? officeToken
          : tokenName === 'workerToken'
            ? workerToken
            : bookkeeperToken;
      // Any syntactically-valid UUID. The permission gate must fire
      // before the "does this id exist?" check, so a 404 here would
      // indicate a skipped gate.
      const res = await authDelete(
        token,
        '/api/notification-rules/00000000-0000-0000-0000-000000000001',
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });
  }

  it('unauthenticated GET /api/notification-rules → 401 UNAUTHENTICATED', async () => {
    // authGet drops the cookie header when the token is empty — an
    // empty string still lands at the route's auth middleware, which
    // must reject with 401 rather than falling through to the
    // permission middleware.
    const res = await authGet('', '/api/notification-rules');
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHENTICATED');
  });
});

// ---------------------------------------------------------------------
// AC-190 — Create/update validation branches
// ---------------------------------------------------------------------
//
// Every rejected branch in AC-190 (a)–(f) lands in its own `it()` block
// so a regression in one predicate does not hide behind a passing peer.
// Every branch must return 422 VALIDATION_ERROR and persist nothing.
describe('Notification-rule validation branches (AC-190)', () => {
  let ownerToken: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    await stopApp();
  });

  async function ruleCount(): Promise<number> {
    const { db, pool } = createDatabase();
    try {
      const res = await db.execute(sql`SELECT COUNT(*)::int AS c FROM notification_rule`);
      return (res.rows[0] as { c: number }).c;
    } finally {
      await pool.end();
    }
  }

  // (a) Unknown eventClass — must be rejected regardless of the rest
  // being valid.
  it('(a) rejects payload whose eventClass is outside NotificationEventClass', async () => {
    const before = await ruleCount();
    const res = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.definitely_not_a_real_event',
      recipientSpec: { roles: ['owner'], includeAssignedWorkers: false, userIds: [] },
      enabled: true,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(await ruleCount()).toBe(before);
  });

  // (b) stateFilter on a non-transition event
  it('(b) rejects stateFilter on a non-transition eventClass', async () => {
    const before = await ruleCount();
    const res = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.archived',
      stateFilter: 'in_arbeit',
      recipientSpec: { roles: ['owner'], includeAssignedWorkers: false, userIds: [] },
      enabled: true,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(await ruleCount()).toBe(before);
  });

  // (c) includeAssignedWorkers on a non-project-scoped event
  it('(c) rejects includeAssignedWorkers=true on backup.failed', async () => {
    const before = await ruleCount();
    const res = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'backup.failed',
      recipientSpec: { roles: ['owner'], includeAssignedWorkers: true, userIds: [] },
      enabled: true,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(await ruleCount()).toBe(before);
  });

  it('(c) rejects includeAssignedWorkers=true on disk.threshold_reached', async () => {
    const before = await ruleCount();
    const res = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'disk.threshold_reached',
      recipientSpec: { roles: ['owner'], includeAssignedWorkers: true, userIds: [] },
      enabled: true,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(await ruleCount()).toBe(before);
  });

  // AC-199 positive — stateFilter=null on a non-transition event is
  // accepted and persisted as NULL. This is the server-side mirror of
  // the form-field-hidden clause: the UI hides the field so the POST
  // carries `stateFilter: null`, and the API must accept that shape
  // (only a non-null stateFilter on a non-transition class is
  // rejected).
  it('(AC-199) accepts stateFilter=null on a non-transition event and persists NULL', async () => {
    const res = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.archived',
      stateFilter: null,
      recipientSpec: { roles: ['owner'], includeAssignedWorkers: false, userIds: [] },
      enabled: true,
    });
    expect(res.statusCode).toBe(201);
    const persisted = res.json() as NotificationRuleApi;
    expect(persisted.stateFilter).toBeNull();
  });

  // (d) Unknown role in roles list
  it('(d) rejects a role outside the configured role set', async () => {
    const before = await ruleCount();
    const res = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.transition_forward',
      recipientSpec: {
        roles: ['ceo'], // not in owner/office/worker/bookkeeper
        includeAssignedWorkers: false,
        userIds: [],
      },
      enabled: true,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(await ruleCount()).toBe(before);
  });

  // (e) userIds referencing a non-existent / inactive user
  it('(e) rejects a userIds entry not matching an active UserAccount.id', async () => {
    const before = await ruleCount();
    const res = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.transition_forward',
      recipientSpec: {
        roles: [],
        includeAssignedWorkers: false,
        // Syntactically-valid UUID that does not identify any user.
        userIds: ['00000000-0000-0000-0000-0000000fffff'],
      },
      enabled: true,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(await ruleCount()).toBe(before);
  });

  // (f) Empty recipientSpec
  it('(f) rejects a recipientSpec that resolves to empty', async () => {
    const before = await ruleCount();
    const res = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.transition_forward',
      recipientSpec: {
        roles: [],
        includeAssignedWorkers: false,
        userIds: [],
      },
      enabled: true,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(await ruleCount()).toBe(before);
  });
});

// ---------------------------------------------------------------------
// AC-393 — Rule CRUD does NOT write audit_log rows
// ---------------------------------------------------------------------
//
// ADR-0023 removed the audit coupling: rule mutations are administrative
// config, not audited domain events. The assertions here verify:
//   1. The total audit_log row count does not change on create/update/delete.
//   2. No row with entity_type = 'notification_rule' exists (that value
//      is no longer valid in the CHECK constraint, so any attempt to
//      insert one would fail the DB constraint outright).
describe('Notification-rule CRUD produces no audit_log rows (AC-393)', () => {
  let ownerToken: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    await stopApp();
  });

  async function countAuditRows(): Promise<number> {
    const { db, pool } = createDatabase();
    try {
      const res = await db.execute(sql`SELECT COUNT(*)::int AS c FROM audit_log`);
      return (res.rows[0] as { c: number }).c;
    } finally {
      await pool.end();
    }
  }

  async function countRuleAuditRows(): Promise<number> {
    const { db, pool } = createDatabase();
    try {
      // entity_type = 'notification_rule' is rejected by the DB CHECK
      // constraint, so this query always returns zero — it is a
      // defence-in-depth assertion that the constraint is holding.
      const res = await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM audit_log WHERE entity_type = 'notification_rule'`,
      );
      return (res.rows[0] as { c: number }).c;
    } finally {
      await pool.end();
    }
  }

  it('create produces zero audit_log rows and no notification_rule entity rows', async () => {
    const before = await countAuditRows();

    const createRes = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.transition_forward',
      stateFilter: 'geplant',
      recipientSpec: { roles: ['owner'], includeAssignedWorkers: false, userIds: [] },
      enabled: true,
    });
    expect(createRes.statusCode).toBe(201);

    const after = await countAuditRows();
    expect(after - before).toBe(0);
    expect(await countRuleAuditRows()).toBe(0);
  });

  it('update produces zero audit_log rows', async () => {
    const createRes = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.transition_backward',
      recipientSpec: { roles: ['owner'], includeAssignedWorkers: false, userIds: [] },
      enabled: true,
    });
    expect(createRes.statusCode).toBe(201);
    const rule = createRes.json() as NotificationRuleApi;

    const before = await countAuditRows();

    const updateRes = await authPatch(ownerToken, `/api/notification-rules/${rule.id}`, {
      enabled: false,
    });
    expect(updateRes.statusCode).toBe(200);

    const after = await countAuditRows();
    expect(after - before).toBe(0);
    expect(await countRuleAuditRows()).toBe(0);
  });

  it('delete produces zero audit_log rows', async () => {
    const createRes = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.archived',
      recipientSpec: { roles: ['owner'], includeAssignedWorkers: false, userIds: [] },
      enabled: true,
    });
    expect(createRes.statusCode).toBe(201);
    const rule = createRes.json() as NotificationRuleApi;

    const before = await countAuditRows();

    const delRes = await authDelete(ownerToken, `/api/notification-rules/${rule.id}`);
    expect(delRes.statusCode).toBeLessThan(300);

    const after = await countAuditRows();
    expect(after - before).toBe(0);
    expect(await countRuleAuditRows()).toBe(0);
  });
});

// ---------------------------------------------------------------------
// AC-193 — Rule take-effect: events in-flight use prior rule set
// ---------------------------------------------------------------------
//
// A rule enable/disable or recipient-spec change affects only events
// committed AFTER the change. An event whose domain commit precedes the
// rule-change commit must dispatch under the rule set read at its own
// commit — not the later one.
//
// Note: the notification publisher routing `audit_log` rows to
// subscribers does not exist yet. This test captures subscriber calls
// and asserts the recipient set reflects the rule state at commit time.
describe('Rule changes apply to events committed after the change (AC-193)', () => {
  let ownerToken: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    await stopApp();
  });

  it('an event committed before a rule disable is dispatched under the pre-change rule set', async () => {
    // The publisher module and its subscribe surface do not exist yet;
    // the import below fails with MODULE_NOT_FOUND at runtime — the
    // recognizable step-3 failing state. String-literal path + vite
    // ignore mirrors the audit-log.test.ts AC-183 pattern so tsc does
    // not block the file at --noEmit time.
    const pubPath = '../services/notification-publisher.js';
    const pub = (await import(/* @vite-ignore */ pubPath)) as {
      onEventDispatched: (
        h: (entry: { auditEntryId: string; ruleMatches: string[]; recipients: string[] }) => void,
      ) => () => void;
    };

    // Create the rule so the first event has a matching rule set.
    const createRule = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.transition_forward',
      stateFilter: null,
      recipientSpec: { roles: ['owner'], includeAssignedWorkers: false, userIds: [] },
      enabled: true,
    });
    expect(createRule.statusCode).toBe(201);
    const rule = createRule.json() as NotificationRuleApi;

    const dispatchEvents: Array<{
      auditEntryId: string;
      ruleMatches: string[];
      recipients: string[];
    }> = [];
    const unsubscribe = pub.onEventDispatched((entry) => {
      dispatchEvents.push(entry);
    });

    try {
      // Drive event #1 — rule is enabled, event must match. Capture the
      // returned project id + the transition's audit_entry_id (the
      // mutation response surfaces it via the updated project's latest
      // audit row — see data-model.md §5.10). The transition audit row
      // is the ONLY one this test owns, so we partition observations by
      // the id that landed on it, not by membership in an unbounded set.
      const list = await authGet(ownerToken, '/api/projects?limit=200');
      const target = (list.json().data as { id: string; status: string }[]).find(
        (p) => p.status === 'beauftragt',
      );
      expect(target).toBeDefined();
      const t1Res = await authPost(ownerToken, `/api/projects/${target!.id}/transition/forward`, {
        expectedStatus: 'beauftragt',
      });
      expect(t1Res.statusCode).toBe(200);

      // Resolve event #1's audit_entry_id by querying the latest
      // transition:forward row for this project. This is the anchor
      // every assertion below keys off — removing the count-based
      // shortcut that a single unrelated event could satisfy.
      const { db, pool } = createDatabase();
      let event1AuditId: string;
      try {
        const row = await db.execute(sql`
          SELECT id FROM audit_log
          WHERE entity_type = 'project' AND entity_id = ${target!.id}
            AND action = 'transition:forward'
          ORDER BY created_at DESC, id DESC LIMIT 1
        `);
        event1AuditId = (row.rows[0] as { id: string }).id;
      } finally {
        await pool.end();
      }

      // Disable the rule. Events committed after this line use the
      // post-change rule set (rule disabled → no match).
      const patchRes = await authPatch(ownerToken, `/api/notification-rules/${rule.id}`, {
        enabled: false,
      });
      expect(patchRes.statusCode).toBe(200);

      // Drive event #2 — rule is now disabled, event must NOT match.
      const list2 = await authGet(ownerToken, '/api/projects?limit=200');
      const target2 = (list2.json().data as { id: string; status: string }[]).find(
        (p) => p.status === 'beauftragt',
      );
      expect(target2).toBeDefined();
      const t2Res = await authPost(ownerToken, `/api/projects/${target2!.id}/transition/forward`, {
        expectedStatus: 'beauftragt',
      });
      expect(t2Res.statusCode).toBe(200);

      const { db: db2, pool: pool2 } = createDatabase();
      let event2AuditId: string;
      try {
        const row = await db2.execute(sql`
          SELECT id FROM audit_log
          WHERE entity_type = 'project' AND entity_id = ${target2!.id}
            AND action = 'transition:forward'
          ORDER BY created_at DESC, id DESC LIMIT 1
        `);
        event2AuditId = (row.rows[0] as { id: string }).id;
      } finally {
        await pool2.end();
      }

      // Partition observations by the specific audit ids this test
      // produced. Neither assertion relies on counts — each names the
      // event it pins. No shortcut can let event #2 be absent.
      const event1Obs = dispatchEvents.find((e) => e.auditEntryId === event1AuditId);
      const event2Obs = dispatchEvents.find((e) => e.auditEntryId === event2AuditId);

      expect(event1Obs).toBeDefined();
      expect(event2Obs).toBeDefined();

      // Event #1 committed under the enabled rule → rule matches.
      expect(event1Obs!.ruleMatches).toContain(rule.id);
      // Event #2 committed under the disabled rule → rule does NOT match.
      expect(event2Obs!.ruleMatches).not.toContain(rule.id);
    } finally {
      unsubscribe();
      // Cleanup: delete the rule so the assertion above is
      // independent of cross-test fixture state.
      await authDelete(ownerToken, `/api/notification-rules/${rule.id}`);
    }
  });
});

// ---------------------------------------------------------------------
// AC-203 — Rule referencing deactivated / deleted user
// ---------------------------------------------------------------------
//
// A rule naming a user later deactivated (active=false) or hard-deleted
// must not crash dispatch. The user is skipped at resolution time; the
// rule row is untouched by the user state change.
//
// Two sub-tests — deactivate path is the common one (user data stays);
// hard-delete path is the sharper test because the userId no longer
// identifies any row.
describe('Rule referencing deactivated/deleted user does not crash dispatch (AC-203)', () => {
  let ownerToken: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    await stopApp();
  });

  it('deactivated user is skipped; rule row is unchanged', async () => {
    // Create a user — we'll immediately name it in a rule, then
    // deactivate it, and assert the publisher copes.
    const createUser = await authPost(ownerToken, '/api/users', {
      username: `ac203deact_${Date.now().toString(36)}`,
      displayName: 'AC-203 deactivated user',
      password: 'SecurePass2026!',
      roles: ['worker'],
    });
    expect(createUser.statusCode).toBeLessThan(300);
    const user = createUser.json() as { id: string };

    const createRule = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.transition_forward',
      recipientSpec: { roles: [], includeAssignedWorkers: false, userIds: [user.id] },
      enabled: true,
    });
    expect(createRule.statusCode).toBe(201);
    const rule = createRule.json() as NotificationRuleApi;

    // Deactivate the user.
    const deactivate = await authPost(ownerToken, `/api/users/${user.id}/deactivate`, {});
    expect(deactivate.statusCode).toBeLessThan(300);

    // Fetch the rule — the userId must still be listed, proving the
    // user state change did NOT rewrite the rule row.
    const ruleAfter = await authGet(ownerToken, `/api/notification-rules/${rule.id}`);
    expect(ruleAfter.statusCode).toBe(200);
    const ruleBody = ruleAfter.json() as NotificationRuleApi;
    expect(ruleBody.recipientSpec.userIds).toContain(user.id);
  });

  it('hard-deleted user is skipped; dispatch completes with the deleted user absent from recipients', async () => {
    const pubPath = '../services/notification-publisher.js';
    const pub = (await import(/* @vite-ignore */ pubPath)) as {
      onEventDispatched: (
        h: (entry: { auditEntryId: string; ruleMatches: string[]; recipients: string[] }) => void,
      ) => () => void;
    };

    const createUser = await authPost(ownerToken, '/api/users', {
      username: `ac203hdel_${Date.now().toString(36)}`,
      displayName: 'AC-203 hard-delete target',
      password: 'SecurePass2026!',
      roles: ['worker'],
    });
    expect(createUser.statusCode).toBeLessThan(300);
    const user = createUser.json() as { id: string };

    const createRule = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.transition_forward',
      recipientSpec: { roles: [], includeAssignedWorkers: false, userIds: [user.id] },
      enabled: true,
    });
    expect(createRule.statusCode).toBe(201);
    const rule = createRule.json() as NotificationRuleApi;

    // Hard-delete the user.
    const delRes = await authDelete(ownerToken, `/api/users/${user.id}`);
    expect(delRes.statusCode).toBeLessThan(300);

    // Rule row must still be readable — the user-state change did NOT
    // rewrite it.
    const ruleAfter = await authGet(ownerToken, `/api/notification-rules/${rule.id}`);
    expect(ruleAfter.statusCode).toBe(200);
    expect((ruleAfter.json() as NotificationRuleApi).id).toBe(rule.id);

    // AC-203 core: drive a matching transition and assert the publisher
    // completes without crashing AND the deleted user is absent from
    // the recipient set. "Does not crash dispatch" is the clause the
    // earlier version left unasserted.
    const observations: Array<{
      auditEntryId: string;
      ruleMatches: string[];
      recipients: string[];
    }> = [];
    const unsubscribe = pub.onEventDispatched((entry) => observations.push(entry));

    try {
      const list = await authGet(ownerToken, '/api/projects?limit=200');
      const target = (list.json().data as { id: string; status: string }[]).find(
        (p) => p.status === 'beauftragt',
      );
      expect(target).toBeDefined();
      const tRes = await authPost(ownerToken, `/api/projects/${target!.id}/transition/forward`, {
        expectedStatus: 'beauftragt',
      });
      // 200 from the transition is the operational signal that the
      // post-commit publisher chain did not surface an error.
      expect(tRes.statusCode).toBe(200);

      // Resolve the specific transition's audit row so the assertion
      // targets THIS event rather than any observation that happens to
      // be in the array.
      const { db, pool } = createDatabase();
      let transitionAuditId: string;
      try {
        const row = await db.execute(sql`
          SELECT id FROM audit_log
          WHERE entity_type = 'project' AND entity_id = ${target!.id}
            AND action = 'transition:forward'
          ORDER BY created_at DESC, id DESC LIMIT 1
        `);
        transitionAuditId = (row.rows[0] as { id: string }).id;
      } finally {
        await pool.end();
      }

      const obs = observations.find((o) => o.auditEntryId === transitionAuditId);
      expect(obs).toBeDefined();
      // The hard-deleted user MUST NOT appear in the resolved recipient
      // set — this is the "skipped at resolution" clause.
      expect(obs!.recipients).not.toContain(user.id);
    } finally {
      unsubscribe();
    }
  });
});

// ---------------------------------------------------------------------
// Body validation hardening — POST and PATCH must reject non-object bodies
// ---------------------------------------------------------------------
describe('notification-rule body validation: non-object bodies → 422', () => {
  let ownerToken: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    await stopApp();
  });

  it('POST with body null → 422', async () => {
    // Fastify's inject payload must be sent as a raw string for null.
    // Sending null as payload results in an empty body; instead we
    // send the JSON string "null" with the correct Content-Type.
    const res = await getApp().inject({
      method: 'POST',
      url: '/api/notification-rules',
      headers: {
        cookie: `session=${ownerToken}`,
        'content-type': 'application/json',
      },
      payload: 'null',
    });
    expect(res.statusCode).toBe(422);
  });

  it('POST with body "not an object" (string) → 422', async () => {
    const res = await getApp().inject({
      method: 'POST',
      url: '/api/notification-rules',
      headers: {
        cookie: `session=${ownerToken}`,
        'content-type': 'application/json',
      },
      payload: '"not an object"',
    });
    expect(res.statusCode).toBe(422);
  });

  it('POST with body [] (array) → 422', async () => {
    const res = await getApp().inject({
      method: 'POST',
      url: '/api/notification-rules',
      headers: {
        cookie: `session=${ownerToken}`,
        'content-type': 'application/json',
      },
      payload: '[]',
    });
    expect(res.statusCode).toBe(422);
  });
});
