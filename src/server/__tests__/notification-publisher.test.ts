/**
 * Notification publisher integration tests — Iteration 8, issue #112.
 *
 * Pins AT-100 / AT-102 / AT-103 from `docs/spec/verification.md §16.2`
 * which in turn pin AC-192 / AC-194 / AC-195 in §15.24.
 *
 * Failing-state expectations (step 3):
 *   - `src/server/services/notification-publisher.ts` does not exist
 *     yet, so the dynamic import fails with MODULE_NOT_FOUND — the
 *     recognizable "implementation missing" failure mode (mirrors the
 *     AT-94 pattern in `audit-log.test.ts`).
 *   - Once the module ships, the subscribe surface must expose
 *     `onEventDispatched(handler)` so tests can observe recipient
 *     resolution without touching the push transport.
 *
 * Rationale for the subscribe-spy approach over an end-to-end push
 * delivery assertion: push delivery involves the browser-side VAPID
 * handshake, which is not present under `inject()`. The publisher's
 * recipient-resolution contract is what AC-192/195 actually pin; the
 * transport layer is out of scope here and verified separately at the
 * integration level once a real push sandbox exists.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';

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
import { createDatabase } from '../db/connection.js';

/**
 * Shape of the dispatch-observation event the publisher emits to
 * subscribers registered via `onEventDispatched`. The publisher
 * resolves recipients, attempts push delivery, and emits one event per
 * triggering audit row carrying the computed recipient set. Tests
 * observe this surface instead of instrumenting the push transport.
 *
 * `pushAttemptedUserIds` lists the user ids for whom a push attempt was
 * made — necessarily a subset of `recipients` (the mute filter and
 * dead-subscription pruning may reduce it).
 */
interface DispatchObservation {
  auditEntryId: string;
  ruleMatches: string[];
  recipients: string[];
  pushAttemptedUserIds: string[];
}

interface Publisher {
  onEventDispatched: (h: (entry: DispatchObservation) => void) => () => void;
}

// Dynamic import so TS --noEmit does not block the file. The module
// does not exist at step-3 time; the import fails at runtime with
// MODULE_NOT_FOUND — the intended failure surface.
async function loadPublisher(): Promise<Publisher> {
  const path = '../services/notification-publisher.js';
  return (await import(/* @vite-ignore */ path)) as unknown as Publisher;
}

/**
 * Resolve the `audit_log.id` of the latest `transition:forward` row on
 * a project. Used to partition publisher observations by the specific
 * event the test drove — membership in a shared `observations` array
 * is not a safe shortcut because sibling tests in the same describe
 * block produce dispatch entries too.
 */
async function resolveTransitionAuditId(projectId: string): Promise<string> {
  const { db, pool } = createDatabase();
  try {
    const row = await db.execute(sql`
      SELECT id FROM audit_log
      WHERE entity_type = 'project' AND entity_id = ${projectId}
        AND action = 'transition:forward'
      ORDER BY created_at DESC, id DESC LIMIT 1
    `);
    return (row.rows[0] as { id: string }).id;
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------
// AT-100 / AC-192 — Recipient union resolution with dedupe
// ---------------------------------------------------------------------
//
// Each `it()` in this describe creates its OWN project fixture
// (ad-hoc, per-test) rather than consuming the seed's `beauftragt`
// rows. This keeps the seed distribution authoritative per
// data-model.md §7.1 and avoids test order dependencies.
describe('AT-100: publisher resolves recipients as deduplicated union (AC-192)', () => {
  let ownerToken: string;
  let seededCustomerId: string;
  let ownerId: string;
  let officeId: string;
  let worker1Id: string;
  let inactiveId: string;

  /** Seq counter to keep fixture project numbers unique within this run. */
  let fixtureCounter = 0;

  /** Create an ad-hoc project in the requested status. Returns the id. */
  async function createFixtureProject(status: 'beauftragt' | 'geplant'): Promise<string> {
    fixtureCounter += 1;
    const number = `AT100-${Date.now().toString(36)}-${fixtureCounter}`;
    const res = await authPost(ownerToken, '/api/projects', {
      number,
      title: `AT-100 fixture (${status})`,
      customerId: seededCustomerId,
      status,
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  }

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);

    // Resolve once: the seed users the tests assert against, and one
    // customer id to anchor every fixture project.
    const { db, pool } = createDatabase();
    try {
      const userRows = await db.execute(
        sql`SELECT id, username FROM users
            WHERE username IN (
              ${SEED_USERS.owner.username},
              ${SEED_USERS.office.username},
              ${SEED_USERS.worker1.username},
              ${SEED_USERS.inactive.username}
            )`,
      );
      const byUsername = new Map<string, string>();
      for (const row of userRows.rows as { id: string; username: string }[]) {
        byUsername.set(row.username, row.id);
      }
      ownerId = byUsername.get(SEED_USERS.owner.username)!;
      officeId = byUsername.get(SEED_USERS.office.username)!;
      worker1Id = byUsername.get(SEED_USERS.worker1.username)!;
      inactiveId = byUsername.get(SEED_USERS.inactive.username)!;
    } finally {
      await pool.end();
    }

    const custRes = await authGet(ownerToken, '/api/customers');
    const customers = (custRes.json().customers ?? custRes.json().data) as { id: string }[];
    expect(customers.length).toBeGreaterThan(0);
    seededCustomerId = customers[0]!.id;
  });

  // Clear rules between sibling tests. Each `it()` drives a transition
  // with a rule tailored to its assertion — leaving rules from a
  // previous arm in the table pollutes the recipient-resolution set of
  // the next one (the "empty recipient set" arm is the classic victim).
  beforeEach(async () => {
    const { db, pool } = createDatabase();
    try {
      await db.execute(sql`DELETE FROM notification_rule`);
    } finally {
      await pool.end();
    }
  });

  afterAll(async () => {
    await stopApp();
  });

  it('resolves recipients = union(roles, includeAssignedWorkers, userIds) deduplicated by userId', async () => {
    const pub = await loadPublisher();

    // Create a rule that overlaps on worker1 from two different sides:
    //   - roles=['worker'] includes worker1 AND worker2;
    //   - userIds=[worker1Id] explicitly names worker1.
    // The resolved recipient set must dedupe worker1 → 1 entry, not 2.
    const ruleRes = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.transition_forward',
      recipientSpec: {
        roles: ['worker', 'office'], // union: worker1, worker2, office
        includeAssignedWorkers: false,
        userIds: [worker1Id, officeId], // worker1 duplicates the roles set
      },
      enabled: true,
    });
    expect(ruleRes.statusCode).toBe(201);

    const observations: DispatchObservation[] = [];
    const unsubscribe = pub.onEventDispatched((entry) => observations.push(entry));

    try {
      const projectId = await createFixtureProject('beauftragt');
      const res = await authPost(ownerToken, `/api/projects/${projectId}/transition/forward`, {
        expectedStatus: 'beauftragt',
      });
      expect(res.statusCode).toBe(200);

      // Partition by the specific audit_entry_id this test produced —
      // every assertion below names the event it pins, so a sibling
      // `it()` block in this describe cannot satisfy the contract.
      const auditEntryId = await resolveTransitionAuditId(projectId);
      const obs = observations.find((o) => o.auditEntryId === auditEntryId);
      expect(obs).toBeDefined();

      // Dedup: a user appearing on both sides lands once.
      const uniqueRecipients = new Set(obs!.recipients);
      expect(uniqueRecipients.size).toBe(obs!.recipients.length);

      // Union content: worker1, office are explicitly named; the
      // roles=['worker'] set expands to worker1 + worker2 too. Owner
      // is NOT a recipient (not named in any spec part).
      expect(obs!.recipients).toContain(worker1Id);
      expect(obs!.recipients).toContain(officeId);
      expect(obs!.recipients).not.toContain(ownerId);
    } finally {
      unsubscribe();
    }
  });

  it('skips inactive users at resolution time', async () => {
    const pub = await loadPublisher();

    // The `inactive` seed user carries the `worker` role but has
    // `active = false`. AC-190(e) forbids naming an inactive user
    // via `userIds` at rule-create time, so we exercise the
    // resolution-time filter via the roles path: `roles=['worker']`
    // expands to every worker including the inactive one, and the
    // publisher must drop the inactive user from the resolved set.
    const ruleRes = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.transition_forward',
      recipientSpec: {
        roles: ['worker'],
        includeAssignedWorkers: false,
        userIds: [],
      },
      enabled: true,
    });
    expect(ruleRes.statusCode).toBe(201);

    const observations: DispatchObservation[] = [];
    const unsubscribe = pub.onEventDispatched((entry) => observations.push(entry));

    try {
      const projectId = await createFixtureProject('beauftragt');
      const res = await authPost(ownerToken, `/api/projects/${projectId}/transition/forward`, {
        expectedStatus: 'beauftragt',
      });
      expect(res.statusCode).toBe(200);

      const auditEntryId = await resolveTransitionAuditId(projectId);
      const obs = observations.find((o) => o.auditEntryId === auditEntryId);
      expect(obs).toBeDefined();
      // The inactive user holds the `worker` role but must not be
      // present in the resolved recipient set — the publisher filters
      // inactive users out at dispatch time.
      expect(obs!.recipients).not.toContain(inactiveId);
      // Live workers are still present.
      expect(obs!.recipients).toContain(worker1Id);
    } finally {
      unsubscribe();
    }
  });

  it('does not crash dispatch when a userId targeted by a rule is later hard-deleted (AC-192 / AC-203 resilience)', async () => {
    // AC-190(e) requires the userId to reference an ACTIVE user at
    // rule-create time, so we create a real active user, bake them
    // into the rule, then hard-delete them. The publisher must
    // complete dispatch without the deleted user in `recipients`.
    // AT-106 pins the same clause from the rule-row side; this arm
    // pins the publisher's resolution-step resilience.
    const pub = await loadPublisher();

    const createUser = await authPost(ownerToken, '/api/users', {
      username: `at100hdel_${Date.now().toString(36)}`,
      displayName: 'AT-100 hard-delete target',
      password: 'SecurePass2026!',
      roles: ['worker'],
    });
    expect(createUser.statusCode).toBeLessThan(300);
    const user = createUser.json() as { id: string };

    const ruleRes = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.transition_forward',
      recipientSpec: {
        roles: [],
        includeAssignedWorkers: false,
        userIds: [ownerId, user.id],
      },
      enabled: true,
    });
    expect(ruleRes.statusCode).toBe(201);

    // Hard-delete the user. The rule row is unchanged by this — AC-203.
    const delRes = await authDelete(ownerToken, `/api/users/${user.id}`);
    expect(delRes.statusCode).toBeLessThan(300);

    const observations: DispatchObservation[] = [];
    const unsubscribe = pub.onEventDispatched((entry) => observations.push(entry));

    try {
      const projectId = await createFixtureProject('beauftragt');
      const res = await authPost(ownerToken, `/api/projects/${projectId}/transition/forward`, {
        expectedStatus: 'beauftragt',
      });
      // 200 = publisher did not surface an error from the deleted id.
      expect(res.statusCode).toBe(200);

      const auditEntryId = await resolveTransitionAuditId(projectId);
      const obs = observations.find((o) => o.auditEntryId === auditEntryId);
      expect(obs).toBeDefined();
      // Owner remains; the deleted user is absent.
      expect(obs!.recipients).toContain(ownerId);
      expect(obs!.recipients).not.toContain(user.id);
    } finally {
      unsubscribe();
    }
  });

  it('completes cleanly when the recipient set resolves to empty', async () => {
    const pub = await loadPublisher();

    // No enabled rule matches the transition (the `beforeEach` wiped
    // the rule table; this `it()` does NOT create one). The publisher
    // must still emit a dispatch observation — the event fired; it
    // simply has nobody to deliver to.
    const observations: DispatchObservation[] = [];
    const unsubscribe = pub.onEventDispatched((entry) => observations.push(entry));

    try {
      const projectId = await createFixtureProject('beauftragt');
      const res = await authPost(ownerToken, `/api/projects/${projectId}/transition/forward`, {
        expectedStatus: 'beauftragt',
      });
      // Transition succeeds — an empty-recipient dispatch must NOT
      // surface as a 5xx at the route layer.
      expect(res.statusCode).toBe(200);

      const auditEntryId = await resolveTransitionAuditId(projectId);
      const obs = observations.find((o) => o.auditEntryId === auditEntryId);
      expect(obs).toBeDefined();
      expect(obs!.recipients).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it('respects stateFilter: transition rule with stateFilter matches only when after.status equals the filter', async () => {
    const pub = await loadPublisher();

    // Rule with stateFilter='in_arbeit' — a forward transition from
    // beauftragt → geplant does NOT match; a transition from
    // geplant → in_arbeit does.
    const ruleRes = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.transition_forward',
      stateFilter: 'in_arbeit',
      recipientSpec: { roles: [], includeAssignedWorkers: false, userIds: [ownerId] },
      enabled: true,
    });
    expect(ruleRes.statusCode).toBe(201);
    const rule = ruleRes.json() as { id: string };

    const observations: DispatchObservation[] = [];
    const unsubscribe = pub.onEventDispatched((entry) => observations.push(entry));

    try {
      // Non-matching event: beauftragt → geplant.
      const nonMatchId = await createFixtureProject('beauftragt');
      const nonMatchRes = await authPost(
        ownerToken,
        `/api/projects/${nonMatchId}/transition/forward`,
        { expectedStatus: 'beauftragt' },
      );
      expect(nonMatchRes.statusCode).toBe(200);

      const nonMatchAuditId = await resolveTransitionAuditId(nonMatchId);

      // Matching event: geplant → in_arbeit (status after=in_arbeit).
      const matchId = await createFixtureProject('geplant');
      const matchRes = await authPost(ownerToken, `/api/projects/${matchId}/transition/forward`, {
        expectedStatus: 'geplant',
      });
      expect(matchRes.statusCode).toBe(200);

      const matchAuditId = await resolveTransitionAuditId(matchId);

      // Partition by the audit_entry_id each test drove — the
      // non-matching event must carry ruleMatches that excludes this
      // rule; the matching event must include it. No count-based
      // shortcut.
      const nonMatchObs = observations.find((o) => o.auditEntryId === nonMatchAuditId);
      const matchObs = observations.find((o) => o.auditEntryId === matchAuditId);
      expect(nonMatchObs).toBeDefined();
      expect(matchObs).toBeDefined();
      expect(nonMatchObs!.ruleMatches).not.toContain(rule.id);
      expect(matchObs!.ruleMatches).toContain(rule.id);
    } finally {
      unsubscribe();
    }
  });
});

// ---------------------------------------------------------------------
// AT-102 / AC-194 — Dispatch-latency budget
// ---------------------------------------------------------------------
//
// Read the configured latency budget rather than hardcoding a number —
// AC-194 calls out a `[C]`-configurable budget, and testing against a
// literal would defeat the configurability contract.
describe('AT-102: push dispatch within configured latency budget (AC-194)', () => {
  let ownerToken: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    await stopApp();
  });

  it('push transport is invoked within the configured latency budget of the triggering commit', async () => {
    const pub = await loadPublisher();

    // Read the configured latency budget from the config module — the
    // config module does not exist yet (step-3 gap), so the import
    // fails with MODULE_NOT_FOUND and surfaces as an implementation
    // gap rather than a hardcoded timing assertion.
    const cfgPath = '../../config/pushDispatch.js';
    const cfg = (await import(/* @vite-ignore */ cfgPath)) as {
      PUSH_DISPATCH_LATENCY_BUDGET_MS: number;
    };
    expect(typeof cfg.PUSH_DISPATCH_LATENCY_BUDGET_MS).toBe('number');

    // Create a rule naming owner so we have a non-empty recipient set.
    const { db, pool } = createDatabase();
    let ownerId: string;
    try {
      const rows = await db.execute(
        sql`SELECT id FROM users WHERE username = ${SEED_USERS.owner.username} LIMIT 1`,
      );
      ownerId = (rows.rows[0] as { id: string }).id;
    } finally {
      await pool.end();
    }

    const ruleRes = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.transition_forward',
      recipientSpec: { roles: [], includeAssignedWorkers: false, userIds: [ownerId] },
      enabled: true,
    });
    expect(ruleRes.statusCode).toBe(201);

    let dispatchAt: number | null = null;
    const unsubscribe = pub.onEventDispatched(() => {
      dispatchAt = Date.now();
    });

    try {
      const list = await authGet(ownerToken, '/api/projects?limit=200');
      const target = (list.json().data as { id: string; status: string }[]).find(
        (p) => p.status === 'beauftragt',
      );
      expect(target).toBeDefined();
      const commitAt = Date.now();
      const res = await authPost(ownerToken, `/api/projects/${target!.id}/transition/forward`, {
        expectedStatus: 'beauftragt',
      });
      expect(res.statusCode).toBe(200);

      expect(dispatchAt).not.toBeNull();
      const delta = dispatchAt! - commitAt;
      expect(delta).toBeLessThanOrEqual(cfg.PUSH_DISPATCH_LATENCY_BUDGET_MS);
    } finally {
      unsubscribe();
    }
  });
});

// ---------------------------------------------------------------------
// AT-103 / AC-195 — pushMuted suppresses dispatch but retains subs
// ---------------------------------------------------------------------
describe('AT-103: pushMuted suppresses push but retains subscriptions (AC-195)', () => {
  let ownerToken: string;
  // Office drives the transition (the actor) while owner is the muted
  // recipient. Separating actor from recipient keeps mute the SOLE reason
  // owner is not pushed — otherwise actor-exclusion (AC-321) would mask a
  // broken mute filter, since owner-as-actor would be dropped regardless.
  let officeToken: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    officeToken = await login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    await stopApp();
  });

  async function countPushRowsForUser(userId: string): Promise<number> {
    const { db, pool } = createDatabase();
    try {
      const res = await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM push_subscriptions WHERE user_id = ${userId}`,
      );
      return (res.rows[0] as { c: number }).c;
    } finally {
      await pool.end();
    }
  }

  it('pushMuted=true suppresses push attempts across all subscriptions; activity-feed inclusion is unaffected', async () => {
    const pub = await loadPublisher();

    // Resolve the owner's user id and register a push subscription
    // for them. The subscription row must survive the mute flip.
    const { db, pool } = createDatabase();
    let ownerId: string;
    try {
      const rows = await db.execute(
        sql`SELECT id FROM users WHERE username = ${SEED_USERS.owner.username} LIMIT 1`,
      );
      ownerId = (rows.rows[0] as { id: string }).id;
    } finally {
      await pool.end();
    }

    const subRes = await authPost(ownerToken, '/api/push-subscriptions', {
      endpoint: `https://push.test.example/endpoint-${Date.now().toString(36)}`,
      keys: { p256dh: 'test-p256dh', auth: 'test-auth' },
    });
    expect(subRes.statusCode).toBeLessThan(300);

    const subCountBefore = await countPushRowsForUser(ownerId);
    expect(subCountBefore).toBeGreaterThan(0);

    // Flip pushMuted via the self-update API.
    const muteRes = await authPatch(ownerToken, '/api/auth/me', { pushMuted: true });
    expect(muteRes.statusCode).toBe(200);

    // Create a rule naming owner so dispatch has a reason to attempt
    // push to them. If mute is honored, push attempts will be zero;
    // recipients (activity-feed inclusion) remain present.
    const ruleRes = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.transition_forward',
      recipientSpec: { roles: [], includeAssignedWorkers: false, userIds: [ownerId] },
      enabled: true,
    });
    expect(ruleRes.statusCode).toBe(201);

    const observations: DispatchObservation[] = [];
    const unsubscribe = pub.onEventDispatched((entry) => observations.push(entry));

    let transitionAuditId: string;
    try {
      const list = await authGet(ownerToken, '/api/projects?limit=200');
      const target = (list.json().data as { id: string; status: string }[]).find(
        (p) => p.status === 'beauftragt',
      );
      expect(target).toBeDefined();
      // Office is the actor; owner is the muted recipient.
      const res = await authPost(officeToken, `/api/projects/${target!.id}/transition/forward`, {
        expectedStatus: 'beauftragt',
      });
      expect(res.statusCode).toBe(200);

      transitionAuditId = await resolveTransitionAuditId(target!.id);
      const obs = observations.find((o) => o.auditEntryId === transitionAuditId);
      expect(obs).toBeDefined();
      // Owner IS a recipient (dispatch set includes them) but no push
      // was attempted because pushMuted=true — and owner is not the actor,
      // so mute is the only thing suppressing the push.
      expect(obs!.recipients).toContain(ownerId);
      expect(obs!.pushAttemptedUserIds).not.toContain(ownerId);
    } finally {
      unsubscribe();
    }

    // AC-195 activity-feed clause: the transition's audit row is
    // retrievable via GET /api/audit. The mute only suppresses push
    // dispatch — feed inclusion is independent. We match by the
    // specific audit_entry_id captured above so a sibling row cannot
    // satisfy the assertion.
    const auditRes = await authGet(ownerToken, '/api/audit?limit=50');
    expect(auditRes.statusCode).toBe(200);
    const auditIds = (auditRes.json().data as Array<{ id: string }>).map((r) => r.id);
    expect(auditIds).toContain(transitionAuditId);

    // Subscription rows are retained (unmuting will restore delivery
    // without a re-subscribe — AC-195).
    const subCountAfterMute = await countPushRowsForUser(ownerId);
    expect(subCountAfterMute).toBe(subCountBefore);
  });

  it('setting pushMuted=false restores delivery without requiring a re-subscribe', async () => {
    const pub = await loadPublisher();

    const { db, pool } = createDatabase();
    let ownerId: string;
    try {
      const rows = await db.execute(
        sql`SELECT id FROM users WHERE username = ${SEED_USERS.owner.username} LIMIT 1`,
      );
      ownerId = (rows.rows[0] as { id: string }).id;
    } finally {
      await pool.end();
    }

    // Register a subscription, mute, then unmute. No re-subscribe in
    // between — the row persists.
    const endpoint = `https://push.test.example/endpoint-${Date.now().toString(36)}-restore`;
    const subRes = await authPost(ownerToken, '/api/push-subscriptions', {
      endpoint,
      keys: { p256dh: 'test-p256dh', auth: 'test-auth' },
    });
    expect(subRes.statusCode).toBeLessThan(300);

    await authPatch(ownerToken, '/api/auth/me', { pushMuted: true });
    const unmute = await authPatch(ownerToken, '/api/auth/me', { pushMuted: false });
    expect(unmute.statusCode).toBe(200);

    const ruleRes = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.transition_forward',
      recipientSpec: { roles: [], includeAssignedWorkers: false, userIds: [ownerId] },
      enabled: true,
    });
    expect(ruleRes.statusCode).toBe(201);

    const observations: DispatchObservation[] = [];
    const unsubscribe = pub.onEventDispatched((entry) => observations.push(entry));

    try {
      const list = await authGet(ownerToken, '/api/projects?limit=200');
      const target = (list.json().data as { id: string; status: string }[]).find(
        (p) => p.status === 'beauftragt',
      );
      expect(target).toBeDefined();
      // Office is the actor; owner is the (now-unmuted) recipient.
      const res = await authPost(officeToken, `/api/projects/${target!.id}/transition/forward`, {
        expectedStatus: 'beauftragt',
      });
      expect(res.statusCode).toBe(200);

      const auditEntryId = await resolveTransitionAuditId(target!.id);
      const obs = observations.find((o) => o.auditEntryId === auditEntryId);
      expect(obs).toBeDefined();
      // With pushMuted=false the push path is restored — the owner's
      // user id appears in pushAttemptedUserIds with no re-subscribe
      // required. (Owner is the recipient, not the actor, so AC-321
      // actor-exclusion does not apply.)
      expect(obs!.pushAttemptedUserIds).toContain(ownerId);
    } finally {
      unsubscribe();
    }
  });
});

// ---------------------------------------------------------------------
// AT-135 / AC-321 — the acting user is excluded from their own push
// ---------------------------------------------------------------------
//
// Notifying a user about an action they just performed is noise. The
// actor (the audit row's `actorId`) is dropped from the push attempt —
// a delivery-time filter parallel to mute (AC-195) — while staying in
// `recipients` so activity-feed inclusion is unaffected. A non-actor
// recipient on the same event is still pushed.
describe('AT-135: actor excluded from own-action push (AC-321)', () => {
  let ownerToken: string;
  let ownerId: string;
  let officeId: string;
  let seededCustomerId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);

    const { db, pool } = createDatabase();
    try {
      const rows = await db.execute(
        sql`SELECT id, username FROM users
            WHERE username IN (${SEED_USERS.owner.username}, ${SEED_USERS.office.username})`,
      );
      const byUsername = new Map<string, string>();
      for (const row of rows.rows as { id: string; username: string }[]) {
        byUsername.set(row.username, row.id);
      }
      ownerId = byUsername.get(SEED_USERS.owner.username)!;
      officeId = byUsername.get(SEED_USERS.office.username)!;
    } finally {
      await pool.end();
    }

    const custRes = await authGet(ownerToken, '/api/customers?limit=1');
    const customers = (custRes.json().customers ?? custRes.json().data) as { id: string }[];
    expect(customers.length).toBeGreaterThan(0);
    seededCustomerId = customers[0]!.id;

    // Guarantee owner is un-muted so the assertion below proves
    // actor-exclusion (AC-321), not mute (AC-195), is what drops the
    // actor from the push attempt — isolation from the AT-103 block.
    await authPatch(ownerToken, '/api/auth/me', { pushMuted: false });
  });

  afterAll(async () => {
    await stopApp();
  });

  // Wipe rules so seed defaults do not add recipients.
  beforeEach(async () => {
    const { db, pool } = createDatabase();
    try {
      await db.execute(sql`DELETE FROM notification_rule`);
    } finally {
      await pool.end();
    }
  });

  it('drops the actor from the push attempt but keeps them in recipients; a non-actor recipient is still pushed', async () => {
    const pub = await loadPublisher();

    // Rule targets both owner and office roles. Owner is the actor (drives
    // the transition) AND a rule recipient; office is a non-actor recipient.
    const ruleRes = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.transition_forward',
      recipientSpec: { roles: ['owner', 'office'], includeAssignedWorkers: false, userIds: [] },
      enabled: true,
    });
    expect(ruleRes.statusCode).toBe(201);

    const observations: DispatchObservation[] = [];
    const unsubscribe = pub.onEventDispatched((entry) => observations.push(entry));

    try {
      // Own fixture project in 'beauftragt' — order-independent, does not
      // consume the seed's beauftragt distribution.
      const projRes = await authPost(ownerToken, '/api/projects', {
        number: `AT135-${Date.now().toString(36)}`,
        title: 'AT-135 actor-exclusion fixture',
        customerId: seededCustomerId,
        status: 'beauftragt',
      });
      expect(projRes.statusCode).toBe(201);
      const projectId = (projRes.json() as { id: string }).id;

      // Owner is the actor.
      const res = await authPost(ownerToken, `/api/projects/${projectId}/transition/forward`, {
        expectedStatus: 'beauftragt',
      });
      expect(res.statusCode).toBe(200);

      const auditEntryId = await resolveTransitionAuditId(projectId);
      const obs = observations.find((o) => o.auditEntryId === auditEntryId);
      expect(obs).toBeDefined();

      // Recipients (activity-feed inclusion) include BOTH the actor and the
      // non-actor recipient — actor-exclusion does not narrow this set.
      expect(obs!.recipients).toContain(ownerId);
      expect(obs!.recipients).toContain(officeId);

      // Push attempt EXCLUDES the actor (owner) and retains the non-actor
      // recipient (office).
      expect(obs!.pushAttemptedUserIds).not.toContain(ownerId);
      expect(obs!.pushAttemptedUserIds).toContain(officeId);
    } finally {
      unsubscribe();
    }
  });
});
