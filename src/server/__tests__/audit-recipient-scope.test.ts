/**
 * API integration tests: audit list `recipientScope` filter (AC-200).
 *
 * Covers the "Meine Benachrichtigungen" default view on `GET /api/audit`:
 * narrows the feed to rows whose resolved notification-dispatch recipient
 * set would have included the caller.
 *
 * Cases exercised (mirrors the predicate's three recipient-spec clauses
 * plus the event-class mapping + pagination contract):
 *   - No matching rules → empty list.
 *   - Rule matching via `roles` → role-match clause.
 *   - Rule matching via `includeAssignedWorkers` → project_workers join.
 *   - Rule matching via explicit `userIds` → spec.userIds membership.
 *   - Pagination: offset/limit applied AFTER the recipient-scope filter
 *     so pages stay stable and never skip legitimate rows.
 *   - Omitted / `false` → current behaviour unchanged.
 *
 * Fixture strategy: each describe block wipes `notification_rule` in
 * `beforeEach` and seeds only the rules the arm needs. This mirrors
 * `notification-publisher.test.ts` and is the reason the seed's default
 * rule set does not bleed between arms (the seed rules would otherwise
 * match for seeded workers on every transition event).
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
import { createStorageClient } from '../storage/client.js';
import { getEnv } from '../config/env.js';
import { binaryInitBody } from '../../test/fixtures/attachmentInit.js';

interface AuditApiEntry {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  actorId: string | null;
  entityLabel: string | null;
}

/** Resolve a user's id by username via a scratch db connection. */
async function resolveUserId(username: string): Promise<string> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(sql`SELECT id FROM users WHERE username = ${username} LIMIT 1`);
    const row = res.rows[0] as { id: string } | undefined;
    if (!row) throw new Error(`User not found: ${username}`);
    return row.id;
  } finally {
    await pool.end();
  }
}

/** Seed customer id — every test uses the same anchor for fixture projects. */
async function resolveSeedCustomerId(token: string): Promise<string> {
  const res = await authGet(token, '/api/customers?limit=1');
  const customers = (res.json().customers ?? res.json().data) as { id: string }[];
  if (!customers || customers.length === 0) {
    throw new Error('Seed produced no customers — cannot anchor fixture projects');
  }
  return customers[0]!.id;
}

/** Wipe notification_rule so seeded rules do not leak into assertions. */
async function wipeNotificationRules(): Promise<void> {
  const { db, pool } = createDatabase();
  try {
    await db.execute(sql`DELETE FROM notification_rule`);
  } finally {
    await pool.end();
  }
}

/**
 * Create a rule via the admin API. Routes through `mutate()`, so the rule
 * is audited — tests that count audit rows must account for this. All
 * recipient-scope assertions filter by entity_type ≠ 'notification_rule'
 * or check specific entity ids to avoid coupling to the rule-audit noise.
 */
async function createRule(
  ownerToken: string,
  body: {
    eventClass: string;
    stateFilter?: string | null;
    recipientSpec: { roles: string[]; includeAssignedWorkers: boolean; userIds: string[] };
    enabled?: boolean;
  },
): Promise<{ id: string }> {
  const res = await authPost(ownerToken, '/api/notification-rules', {
    eventClass: body.eventClass,
    stateFilter: body.stateFilter ?? null,
    recipientSpec: body.recipientSpec,
    enabled: body.enabled ?? true,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

/**
 * Init a binary attachment, stage its ciphertext object, and complete
 * the upload (pending → ready) — the path that writes the `attachment:add`
 * audit row. Returns the attachment id. The staged bytes must match the
 * binary fixture's `ciphertextSizeBytes` (50_064) under the
 * `application/octet-stream` sentinel or the complete-time HEAD verify
 * fails before the row is written. (Local copy of the upload dance every
 * attachment-touching integration test rolls — no shared helper exists.)
 */
async function stageAndComplete(token: string, projectId: string): Promise<string> {
  const initRes = await authPost(
    token,
    `/api/projects/${projectId}/attachments/init`,
    binaryInitBody({ fileName: 'ars-upload.pdf', sizeBytes: 4321 }),
  );
  expect(initRes.statusCode).toBe(201);
  const body = initRes.json() as { attachment: { id: string; originalKey: string } };

  const env = getEnv();
  const s = createStorageClient({
    endpoint: env.STORAGE_ENDPOINT!,
    bucket: env.STORAGE_BUCKET,
    accessKey: env.STORAGE_ACCESS_KEY!,
    secretKey: env.STORAGE_SECRET_KEY!,
  });
  await s.upload(
    body.attachment.originalKey,
    Buffer.alloc(50_064, 0xff),
    'application/octet-stream',
  );

  const completeRes = await authPost(
    token,
    `/api/projects/${projectId}/attachments/${body.attachment.id}/complete`,
  );
  expect(completeRes.statusCode).toBe(200);
  return body.attachment.id;
}

describe('GET /api/audit recipientScope (AC-200)', () => {
  let ownerToken: string;
  let officeToken: string;
  let officeId: string;
  let worker1Id: string;
  let seededCustomerId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    officeToken = await login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD);
    officeId = await resolveUserId(SEED_USERS.office.username);
    worker1Id = await resolveUserId(SEED_USERS.worker1.username);
    seededCustomerId = await resolveSeedCustomerId(ownerToken);
  });

  afterAll(async () => {
    await stopApp();
  });

  beforeEach(async () => {
    await wipeNotificationRules();
  });

  // ---------------------------------------------------------------
  // AC-200 — no matching rules → empty list
  // ---------------------------------------------------------------
  //
  // Rules are wiped in `beforeEach`. With zero rules, the EXISTS
  // subquery cannot match any audit row → the recipient-scoped list is
  // empty even though the full feed has content (audit rows produced by
  // the seed + rule-wipe paths remain visible under recipientScope=false).
  it('returns an empty list when no notification_rule rows exist', async () => {
    const res = await authGet(ownerToken, '/api/audit?recipientScope=true&limit=50');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: AuditApiEntry[]; total: number };
    expect(body.total).toBe(0);
    expect(body.data).toHaveLength(0);
  });

  // ---------------------------------------------------------------
  // AC-200 — role-match clause
  // ---------------------------------------------------------------
  //
  // A rule targeting `roles: ['owner']` on `project.assignment_changed`
  // must include worker-assignment audit rows for the owner caller and
  // exclude rows from unrelated event classes. The assertion targets
  // `project_worker` rows specifically so the baseline noise from
  // `notification_rule.create` (produced by the rule-create above) is
  // not confused with the signal.
  it('includes rows whose event class resolves under a role-matching rule', async () => {
    await createRule(ownerToken, {
      eventClass: 'project.assignment_changed',
      recipientSpec: { roles: ['owner'], includeAssignedWorkers: false, userIds: [] },
    });

    // Drive an assignment change. Each worker-id passed to the PATCH
    // produces one `project_worker.create` audit row.
    const projectRes = await authPost(ownerToken, '/api/projects', {
      number: `ARS-role-${Date.now().toString(36)}`,
      title: 'Recipient-scope role arm',
      customerId: seededCustomerId,
    });
    expect(projectRes.statusCode).toBe(201);
    const projectId = projectRes.json().id as string;

    const assignRes = await authPatch(ownerToken, `/api/projects/${projectId}`, {
      assignedWorkerIds: [worker1Id],
    });
    expect(assignRes.statusCode).toBe(200);

    const res = await authGet(ownerToken, '/api/audit?recipientScope=true&limit=200');
    expect(res.statusCode).toBe(200);
    const entries = (res.json() as { data: AuditApiEntry[] }).data;

    // Must include the `project_worker.create` row for this project.
    const assignmentRow = entries.find(
      (e) => e.entityType === 'project_worker' && e.entityId === projectId,
    );
    expect(assignmentRow).toBeDefined();
    expect(assignmentRow!.action).toBe('create');

    // Must NOT include unrelated event classes — the rule does not cover
    // `customer.update`, so a customer mutation in the same session must
    // not appear under this recipient scope.
    const custPatch = await authPatch(ownerToken, `/api/customers/${seededCustomerId}`, {
      phone: `0221-${Date.now().toString().slice(-7)}`,
    });
    expect(custPatch.statusCode).toBe(200);

    const res2 = await authGet(ownerToken, '/api/audit?recipientScope=true&limit=200');
    const entries2 = (res2.json() as { data: AuditApiEntry[] }).data;
    const customerUpdateRow = entries2.find(
      (e) => e.entityType === 'customer' && e.action === 'update',
    );
    expect(customerUpdateRow).toBeUndefined();
  });

  // ---------------------------------------------------------------
  // AC-200 — includeAssignedWorkers clause
  // ---------------------------------------------------------------
  //
  // The rule names no roles and no userIds — only `includeAssignedWorkers
  // = true`. The project_workers-join branch is the only path that can
  // admit the caller. The caller for this arm is a user with `audit:read`
  // (office) who is also added to `project_workers` for the fixture
  // project. The worker1 assignment rows for a DIFFERENT project must
  // not appear (office is not on that project).
  it('includes rows only for projects where the caller is on project_workers', async () => {
    await createRule(ownerToken, {
      eventClass: 'project.assignment_changed',
      recipientSpec: { roles: [], includeAssignedWorkers: true, userIds: [] },
    });

    // Project A — add office to project_workers.
    const projectARes = await authPost(ownerToken, '/api/projects', {
      number: `ARS-aw-A-${Date.now().toString(36)}`,
      title: 'Recipient-scope AW arm A',
      customerId: seededCustomerId,
    });
    expect(projectARes.statusCode).toBe(201);
    const projectA = projectARes.json().id as string;
    // Direct assignment via PATCH: the route maps `assignedWorkerIds` to
    // project_workers inserts under a `mutate()` transaction, producing
    // the audit row the recipient-scope filter should match.
    const assignARes = await authPatch(ownerToken, `/api/projects/${projectA}`, {
      assignedWorkerIds: [officeId],
    });
    expect(assignARes.statusCode).toBe(200);

    // Project B — assign worker1 only; office is NOT on project_workers.
    const projectBRes = await authPost(ownerToken, '/api/projects', {
      number: `ARS-aw-B-${Date.now().toString(36)}`,
      title: 'Recipient-scope AW arm B',
      customerId: seededCustomerId,
    });
    expect(projectBRes.statusCode).toBe(201);
    const projectB = projectBRes.json().id as string;
    const assignBRes = await authPatch(ownerToken, `/api/projects/${projectB}`, {
      assignedWorkerIds: [worker1Id],
    });
    expect(assignBRes.statusCode).toBe(200);

    const res = await authGet(officeToken, '/api/audit?recipientScope=true&limit=200');
    expect(res.statusCode).toBe(200);
    const entries = (res.json() as { data: AuditApiEntry[] }).data;

    const matched = entries.filter(
      (e) => e.entityType === 'project_worker' && e.action === 'create',
    );
    const ids = matched.map((e) => e.entityId);
    expect(ids).toContain(projectA);
    expect(ids).not.toContain(projectB);
  });

  // ---------------------------------------------------------------
  // AC-200 — explicit userIds clause
  // ---------------------------------------------------------------
  //
  // Rule targets the caller's id directly via `recipientSpec.userIds`.
  // No role / assignment-workers paths — the userIds-membership branch
  // is the only one that admits the caller. A sibling rule listing only
  // ownerId (not officeId) must not admit office.
  it('includes rows when the caller id appears in recipientSpec.userIds', async () => {
    await createRule(ownerToken, {
      eventClass: 'project.assignment_changed',
      recipientSpec: { roles: [], includeAssignedWorkers: false, userIds: [officeId] },
    });

    const projectRes = await authPost(ownerToken, '/api/projects', {
      number: `ARS-uid-${Date.now().toString(36)}`,
      title: 'Recipient-scope userIds arm',
      customerId: seededCustomerId,
    });
    expect(projectRes.statusCode).toBe(201);
    const projectId = projectRes.json().id as string;

    const assignRes = await authPatch(ownerToken, `/api/projects/${projectId}`, {
      assignedWorkerIds: [worker1Id],
    });
    expect(assignRes.statusCode).toBe(200);

    // Office sees the assignment row — userIds names office.
    const resOffice = await authGet(officeToken, '/api/audit?recipientScope=true&limit=200');
    expect(resOffice.statusCode).toBe(200);
    const officeEntries = (resOffice.json() as { data: AuditApiEntry[] }).data;
    expect(
      officeEntries.some((e) => e.entityType === 'project_worker' && e.entityId === projectId),
    ).toBe(true);

    // Owner does NOT see it — userIds lists only office, no role or
    // AW path admits owner.
    const resOwner = await authGet(ownerToken, '/api/audit?recipientScope=true&limit=200');
    expect(resOwner.statusCode).toBe(200);
    const ownerEntries = (resOwner.json() as { data: AuditApiEntry[] }).data;
    expect(
      ownerEntries.some((e) => e.entityType === 'project_worker' && e.entityId === projectId),
    ).toBe(false);
  });

  // ---------------------------------------------------------------
  // AC-200 / AC-318 — attachment_added rows surface in the scoped feed
  // ---------------------------------------------------------------
  //
  // The recipient-scope predicate maps (entity_type, action) to an event
  // class via a CASE that must cover EVERY project-scoped class. A
  // completed upload writes an `attachment:add` row on entity_type
  // 'attachment'; with a rule targeting office for
  // `project.attachment_added`, office's scoped feed must include that
  // row — it is the row the activity dock (AC-318) surfaces live. A
  // missing CASE arm drops it (fails closed), so the dock would never
  // show file uploads.
  it('includes a completed upload attachment:add row for a configured recipient', async () => {
    await createRule(ownerToken, {
      eventClass: 'project.attachment_added',
      recipientSpec: { roles: ['office'], includeAssignedWorkers: false, userIds: [] },
    });

    const projectRes = await authPost(ownerToken, '/api/projects', {
      number: `ARS-att-${Date.now().toString(36)}`,
      title: 'Recipient-scope attachment arm',
      customerId: seededCustomerId,
    });
    expect(projectRes.statusCode).toBe(201);
    const projectId = projectRes.json().id as string;

    const attachmentId = await stageAndComplete(ownerToken, projectId);

    // Office is a configured recipient → the attachment:add row is in the
    // scoped feed.
    const res = await authGet(officeToken, '/api/audit?recipientScope=true&limit=200');
    expect(res.statusCode).toBe(200);
    const entries = (res.json() as { data: AuditApiEntry[] }).data;
    expect(
      entries.some(
        (e) =>
          e.entityType === 'attachment' &&
          e.entityId === attachmentId &&
          e.action === 'attachment:add',
      ),
    ).toBe(true);

    // Owner (the uploader) is NOT in the office-only rule → the row must
    // NOT appear in owner's scoped feed. Confirms rule-gating, not blanket
    // inclusion of every attachment row.
    const ownerRes = await authGet(ownerToken, '/api/audit?recipientScope=true&limit=200');
    const ownerEntries = (ownerRes.json() as { data: AuditApiEntry[] }).data;
    expect(
      ownerEntries.some((e) => e.entityType === 'attachment' && e.entityId === attachmentId),
    ).toBe(false);
  });

  // ---------------------------------------------------------------
  // AC-200 — pagination correctness
  // ---------------------------------------------------------------
  //
  // With N > page_size audit rows spread across matching and non-matching
  // categories, two sequential page fetches must carry exactly the
  // matching-row set. The filter MUST be applied BEFORE offset/limit —
  // if the repo applied the filter in application code AFTER pagination,
  // some pages would drop legitimate rows.
  it('pagination respects the recipient-scope filter (filter before offset/limit)', async () => {
    // Rule matching only `project.archived` for the owner caller.
    await createRule(ownerToken, {
      eventClass: 'project.archived',
      recipientSpec: { roles: ['owner'], includeAssignedWorkers: false, userIds: [] },
    });

    const matchingProjectIds: string[] = [];
    // Create 6 projects and archive them → 6 matching `project.archive`
    // rows. Interleave with customer patches (3) which do NOT match the
    // rule. Total audit rows introduced ~= 12+ (project creates, archives,
    // customer updates, plus per-test rule-create noise). Page size 3
    // forces the filter to slice matching rows out of an interleaved
    // stream.
    for (let i = 0; i < 6; i += 1) {
      const projRes = await authPost(ownerToken, '/api/projects', {
        number: `ARS-pg-${Date.now().toString(36)}-${i}`,
        title: `Pagination fixture ${i}`,
        customerId: seededCustomerId,
      });
      expect(projRes.statusCode).toBe(201);
      const projectId = projRes.json().id as string;
      matchingProjectIds.push(projectId);

      // Interleave: customer update every two projects.
      if (i % 2 === 0) {
        const custPatch = await authPatch(ownerToken, `/api/customers/${seededCustomerId}`, {
          phone: `0221-${Date.now().toString().slice(-7)}-${i}`,
        });
        expect(custPatch.statusCode).toBe(200);
      }

      // Soft-delete (archive) the project. `DELETE /api/projects/:id`
      // emits an `archive` action on `entity_type = 'project'` — the
      // event-class map resolves this to `project.archived`.
      const archRes = await authDelete(ownerToken, `/api/projects/${projectId}`);
      expect(archRes.statusCode).toBeLessThan(300);
    }

    // Page 1 (limit=3) + Page 2 (offset=3, limit=3) must contain every
    // archived project id; no page drops legitimate rows.
    const page1 = await authGet(
      ownerToken,
      '/api/audit?recipientScope=true&entityType=project&action=archive&limit=3&offset=0',
    );
    expect(page1.statusCode).toBe(200);
    const page1Body = page1.json() as { data: AuditApiEntry[]; total: number };
    expect(page1Body.total).toBe(6);
    expect(page1Body.data).toHaveLength(3);

    const page2 = await authGet(
      ownerToken,
      '/api/audit?recipientScope=true&entityType=project&action=archive&limit=3&offset=3',
    );
    expect(page2.statusCode).toBe(200);
    const page2Body = page2.json() as { data: AuditApiEntry[]; total: number };
    expect(page2Body.total).toBe(6);
    expect(page2Body.data).toHaveLength(3);

    const allIds = [...page1Body.data, ...page2Body.data].map((e) => e.entityId);
    expect(new Set(allIds).size).toBe(6); // No duplicates across pages.
    for (const id of matchingProjectIds) {
      expect(allIds).toContain(id);
    }
  });

  // ---------------------------------------------------------------
  // AC-200 — recipientScope omitted / 'false' preserves AC-180 feed
  // ---------------------------------------------------------------
  //
  // When `recipientScope` is not 'true', the response must mirror the
  // unfiltered feed (rules present or not). Pins the default-off contract.
  it('omitted recipientScope returns the full RBAC-scoped feed', async () => {
    // Create a rule that would exclude owner via userIds=[officeId] —
    // if the filter accidentally defaults to on, owner would see an
    // empty list. The assertion is that rule presence does NOT narrow
    // the default feed.
    await createRule(ownerToken, {
      eventClass: 'project.assignment_changed',
      recipientSpec: { roles: [], includeAssignedWorkers: false, userIds: [officeId] },
    });

    const baseline = await authGet(ownerToken, '/api/audit?limit=1000');
    expect(baseline.statusCode).toBe(200);
    const baselineBody = baseline.json() as { data: AuditApiEntry[]; total: number };
    // The rule-create is itself an audited mutation; seeded activity +
    // this write guarantee a non-trivial count.
    expect(baselineBody.total).toBeGreaterThan(0);

    const explicit = await authGet(ownerToken, '/api/audit?recipientScope=false&limit=1000');
    expect(explicit.statusCode).toBe(200);
    const explicitBody = explicit.json() as { data: AuditApiEntry[]; total: number };
    expect(explicitBody.total).toBe(baselineBody.total);
  });

  // ---------------------------------------------------------------
  // AC-200 — an invalid recipientScope value is a 422
  // ---------------------------------------------------------------
  //
  // Schema enum is `['true', 'false']`. Anything else fails JSON-schema
  // validation, mapped to 422 by the global error handler (app.ts).
  // Documents the coercion-failure contract in the task.
  it('rejects recipientScope values outside {"true","false"} with 422', async () => {
    const res = await authGet(ownerToken, '/api/audit?recipientScope=yes');
    expect(res.statusCode).toBe(422);
  });
});
