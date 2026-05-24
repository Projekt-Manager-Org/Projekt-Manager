/**
 * Notification publisher integration test — `project.attachment_added`
 * dispatch on completed upload. Pins AC-316 (verification.md §15.24).
 *
 * Coupling (AC-316 + revised AC-219, data-model.md §5.11 / §5.13):
 *   - The event fires off the `attachment:add` audit row, which the
 *     revised AC-219 writes at COMPLETE (pending → ready), not at init.
 *   - `audit-publisher` maps that row to an event class via
 *     `eventClassForAudit({ entityType: 'attachment', action:
 *     'attachment:add' })` → `'project.attachment_added'`. The class is
 *     project-scoped, so a rule may set `includeAssignedWorkers` (AC-190
 *     rejects that flag only for the non-project-scoped system classes
 *     `backup.failed` / `disk.threshold_reached`).
 *   - An upload abandoned before complete writes NO `attachment:add`
 *     row (AC-219), hence publishes NO event.
 *
 * Step-3 red state: at the time this test is written NONE of the
 * coupling exists yet —
 *   - `'project.attachment_added'` is absent from
 *     `NOTIFICATION_EVENT_CLASSES` (src/config/notificationEvents.ts), so
 *     rule create for that class fails AC-190 clause (a) → 422.
 *   - `eventClassForAudit` has no `attachment::attachment:add` entry, so
 *     even a completed upload produces no dispatch observation.
 *   - The `attachment:add` audit row is still written at INIT, not at
 *     complete, so the abandoned-upload arm sees a row that AC-219 (as
 *     revised) says must not exist yet.
 * Each arm therefore fails — that is the intended TDD signal.
 *
 * Observation surface: the publisher's `onEventDispatched(handler)` —
 * the same surface AT-100 / AT-103 use in `notification-publisher.test.ts`.
 * Observations are partitioned by the triggering `attachment:add` audit
 * id (resolved via SQL); array membership alone is not a safe shortcut
 * because sibling arms in this run also produce dispatch entries.
 *
 * NOT re-pinned here (would be T-REDU):
 *   - Mute behaviour (AC-195) is covered generically by AT-103 in
 *     `notification-publisher.test.ts`. Mute routes through the same
 *     event-class-agnostic `filterUnmutedUserIds` step regardless of
 *     event class, so re-asserting it for `project.attachment_added`
 *     would duplicate AT-103's coverage.
 *   - Assigned-worker recipient RESOLUTION (union / dedupe /
 *     `includeAssignedWorkers` expansion) is covered generically by
 *     AT-100. Arm 2 below pins only that the new class is ADMITTED into
 *     `PROJECT_SCOPED_EVENT_CLASSES` at rule-create validation — not the
 *     resolution mechanics.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';

import { startApp, stopApp, login, authGet, authPost, authPatch } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import { createStorageClient } from '../storage/client.js';
import { getEnv } from '../config/env.js';
import { binaryInitBody } from '../../test/fixtures/attachmentInit.js';

/**
 * Shape of the dispatch-observation event the publisher emits to
 * subscribers registered via `onEventDispatched` — mirrors the
 * `DispatchObservation` exported by the publisher and consumed by
 * `notification-publisher.test.ts`.
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

// Dynamic import via a string variable so TS --noEmit does not block the
// file on the (already-shipped) publisher; the failure surface for this
// test is the absent event class / audit mapping downstream, not a
// missing module.
async function loadPublisher(): Promise<Publisher> {
  const path = '../services/notification-publisher.js';
  return (await import(/* @vite-ignore */ path)) as unknown as Publisher;
}

describe('AC-316: project.attachment_added dispatch on completed upload', () => {
  let ownerToken: string;
  let seededCustomerId: string;
  let ownerId: string;
  let officeId: string;
  let worker1Id: string;

  /** Seq counter to keep fixture project numbers unique within this run. */
  let fixtureCounter = 0;

  /** Create an ad-hoc project (owner is the actor). Returns the id. */
  async function createFixtureProject(): Promise<string> {
    fixtureCounter += 1;
    const number = `AC316-${Date.now().toString(36)}-${fixtureCounter}`;
    const res = await authPost(ownerToken, '/api/projects', {
      number,
      title: `AC-316 fixture #${fixtureCounter}`,
      customerId: seededCustomerId,
      status: 'beauftragt',
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  }

  /**
   * Init a binary attachment, stage its backing ciphertext object, and
   * POST complete. Returns the attachment id. Copies the upload pattern
   * from `attachments-audit.test.ts` ("complete writes zero audit rows"):
   * the staged bytes must match the persisted `ciphertextSizeBytes`
   * (binary fixture default: 50_064) and carry the `application/octet-stream`
   * sentinel content-type (ADR-0024), or the complete-time HEAD verify
   * fails before the audit row is written.
   */
  async function stageAndComplete(projectId: string): Promise<string> {
    const initRes = await authPost(
      ownerToken,
      `/api/projects/${projectId}/attachments/init`,
      binaryInitBody({ fileName: 'ac316-upload.pdf', sizeBytes: 4321 }),
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
      ownerToken,
      `/api/projects/${projectId}/attachments/${body.attachment.id}/complete`,
    );
    expect(completeRes.statusCode).toBe(200);
    return body.attachment.id;
  }

  /** Init a binary attachment WITHOUT completing — leaves a `pending` row. */
  async function initOnly(projectId: string): Promise<string> {
    const initRes = await authPost(
      ownerToken,
      `/api/projects/${projectId}/attachments/init`,
      binaryInitBody({ fileName: 'ac316-abandoned.pdf', sizeBytes: 4321 }),
    );
    expect(initRes.statusCode).toBe(201);
    return (initRes.json() as { attachment: { id: string } }).attachment.id;
  }

  /**
   * Resolve the `audit_log.id` of the latest `attachment:add` row for an
   * attachment. Used to partition publisher observations by the specific
   * event the test drove (per AC-316 / AT-100 the row is the dispatch
   * trigger). Returns null when no such row exists (the abandoned-upload
   * arm relies on this).
   */
  async function resolveAttachmentAddAuditId(attachmentId: string): Promise<string | null> {
    const { db, pool } = createDatabase();
    try {
      const row = await db.execute(sql`
        SELECT id FROM audit_log
        WHERE entity_type = 'attachment' AND entity_id = ${attachmentId}
          AND action = 'attachment:add'
        ORDER BY created_at DESC, id DESC LIMIT 1
      `);
      return (row.rows[0] as { id: string } | undefined)?.id ?? null;
    } finally {
      await pool.end();
    }
  }

  /** Count `attachment:add` audit rows for an attachment. */
  async function countAttachmentAddRows(attachmentId: string): Promise<number> {
    const { db, pool } = createDatabase();
    try {
      const res = await db.execute(sql`
        SELECT COUNT(*)::int AS c FROM audit_log
        WHERE entity_type = 'attachment' AND entity_id = ${attachmentId}
          AND action = 'attachment:add'
      `);
      return (res.rows[0] as { c: number }).c;
    } finally {
      await pool.end();
    }
  }

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);

    // Resolve the seed user ids the arms assert against, plus one
    // customer id to anchor every fixture project.
    const { db, pool } = createDatabase();
    try {
      const userRows = await db.execute(
        sql`SELECT id, username FROM users
            WHERE username IN (${SEED_USERS.owner.username}, ${SEED_USERS.office.username}, ${SEED_USERS.worker1.username})`,
      );
      const byUsername = new Map<string, string>();
      for (const row of userRows.rows as { id: string; username: string }[]) {
        byUsername.set(row.username, row.id);
      }
      ownerId = byUsername.get(SEED_USERS.owner.username)!;
      officeId = byUsername.get(SEED_USERS.office.username)!;
      worker1Id = byUsername.get(SEED_USERS.worker1.username)!;
    } finally {
      await pool.end();
    }

    const custRes = await authGet(ownerToken, '/api/customers');
    const customers = (custRes.json().customers ?? custRes.json().data) as { id: string }[];
    expect(customers.length).toBeGreaterThan(0);
    seededCustomerId = customers[0]!.id;
  });

  // Clear rules between arms — a rule left from a prior arm pollutes the
  // recipient-resolution set of the next (the same hazard the publisher
  // suite guards against).
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

  // -------------------------------------------------------------------
  // Arm 1 — exactly one dispatch on complete; uploader is NOT auto-added.
  //
  // First failure point at step-3: the rule create returns 422 (event
  // class `project.attachment_added` is outside NOTIFICATION_EVENT_CLASSES
  // → AC-190 clause (a)), so `expect(ruleRes.statusCode).toBe(201)` fails.
  // Were that to pass, the dispatch would still never fire — no
  // `attachment::attachment:add` mapping in `eventClassForAudit`.
  // -------------------------------------------------------------------
  it('fires exactly one project.attachment_added dispatch on upload complete; the uploader is not auto-added as a recipient', async () => {
    const pub = await loadPublisher();

    // Rule targets the `office` role only. The uploader (owner) holds the
    // `owner` role, NOT `office` — so if the uploader appears in
    // `recipients`, the publisher is wrongly auto-including the actor.
    // Recipients must come solely from the matching rule.
    const ruleRes = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.attachment_added',
      recipientSpec: { roles: ['office'], includeAssignedWorkers: false, userIds: [] },
      enabled: true,
    });
    expect(ruleRes.statusCode).toBe(201);

    const observations: DispatchObservation[] = [];
    const unsubscribe = pub.onEventDispatched((entry) => observations.push(entry));

    try {
      const projectId = await createFixtureProject();
      const attachmentId = await stageAndComplete(projectId);

      // Partition by the specific attachment:add audit id this arm drove.
      const auditEntryId = await resolveAttachmentAddAuditId(attachmentId);
      expect(auditEntryId).not.toBeNull();

      const matching = observations.filter((o) => o.auditEntryId === auditEntryId);
      // Exactly one dispatch for the completed upload — not zero, not a
      // double-fire (e.g. on both init and complete).
      expect(matching).toHaveLength(1);

      const obs = matching[0]!;
      // Office role member is a recipient; the uploader (owner) is not —
      // the actor is never auto-included.
      expect(obs.recipients).toContain(officeId);
      expect(obs.recipients).not.toContain(ownerId);
    } finally {
      unsubscribe();
    }
  });

  // -------------------------------------------------------------------
  // Arm 2 — the class is project-scoped: a rule may set
  // includeAssignedWorkers.
  //
  // Pins membership in PROJECT_SCOPED_EVENT_CLASSES via the rule-create
  // validator (AC-190 clause (c) rejects the flag ONLY for the system
  // classes). At step-3 the class is unknown → clause (a) fires first →
  // 422, so the 201 expectation fails. Resolution mechanics are NOT
  // re-tested here (AT-100 covers them generically — T-REDU).
  // -------------------------------------------------------------------
  it('project.attachment_added is project-scoped: a rule may set includeAssignedWorkers', async () => {
    const ruleRes = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.attachment_added',
      recipientSpec: { roles: [], includeAssignedWorkers: true, userIds: [] },
      enabled: true,
    });
    expect(ruleRes.statusCode).toBe(201);
  });

  // -------------------------------------------------------------------
  // Arm 4 — an includeAssignedWorkers rule RESOLVES the assigned worker.
  //
  // Arm 2 only proves the flag is admitted at rule-create. This arm
  // proves dispatch actually resolves the assigned worker as a recipient
  // — which requires deriving the upload's project id from the audit
  // row's ANCESTOR link (`attachment` rows carry the attachment id as
  // entity_id; the project id is in ancestorEntityId). A regression that
  // reads entity_id as the project id resolves zero workers, so the
  // recipient assertion below fails closed and silently — exactly the
  // gap this arm guards.
  // -------------------------------------------------------------------
  it('resolves an assigned worker as a recipient under an includeAssignedWorkers rule', async () => {
    const pub = await loadPublisher();

    // No roles, no userIds — the project_workers join is the ONLY path to
    // a recipient, so this isolates the project-id resolution.
    const ruleRes = await authPost(ownerToken, '/api/notification-rules', {
      eventClass: 'project.attachment_added',
      recipientSpec: { roles: [], includeAssignedWorkers: true, userIds: [] },
      enabled: true,
    });
    expect(ruleRes.statusCode).toBe(201);

    const observations: DispatchObservation[] = [];
    const unsubscribe = pub.onEventDispatched((entry) => observations.push(entry));

    try {
      const projectId = await createFixtureProject();
      // Assign worker1 to the project — the rule's only recipient source.
      const assignRes = await authPatch(ownerToken, `/api/projects/${projectId}`, {
        assignedWorkerIds: [worker1Id],
      });
      expect(assignRes.statusCode).toBe(200);

      const attachmentId = await stageAndComplete(projectId);
      const auditEntryId = await resolveAttachmentAddAuditId(attachmentId);
      expect(auditEntryId).not.toBeNull();

      const matching = observations.filter((o) => o.auditEntryId === auditEntryId);
      expect(matching).toHaveLength(1);
      // The assigned worker resolves — proving the project id was read
      // from the ancestor link, not the attachment entity_id.
      expect(matching[0]!.recipients).toContain(worker1Id);
    } finally {
      unsubscribe();
    }
  });

  // -------------------------------------------------------------------
  // Arm 3 — an upload abandoned before complete publishes no event.
  //
  // Under the revised AC-219 the `attachment:add` row is written at
  // complete, so an init-only (abandoned) upload writes NO such row and
  // therefore drives NO dispatch. At step-3 the row is still written at
  // INIT, so `countAttachmentAddRows` returns 1 → the count assertion
  // fails (correctly pinning the revised AC-219 / AC-316 coupling).
  // -------------------------------------------------------------------
  it('an upload abandoned before complete publishes no event', async () => {
    const pub = await loadPublisher();

    const observations: DispatchObservation[] = [];
    const unsubscribe = pub.onEventDispatched((entry) => observations.push(entry));

    try {
      const projectId = await createFixtureProject();
      const attachmentId = await initOnly(projectId);

      // Drain microtasks so any (erroneous) post-commit dispatch would
      // have landed an observation before we assert.
      await new Promise<void>((r) => setImmediate(r));

      // No attachment:add row exists for an abandoned upload (AC-219).
      expect(await countAttachmentAddRows(attachmentId)).toBe(0);

      // And no dispatch observation references this attachment's
      // attachment:add row (there is none to reference).
      const auditEntryId = await resolveAttachmentAddAuditId(attachmentId);
      expect(auditEntryId).toBeNull();
      expect(observations.some((o) => o.auditEntryId === auditEntryId)).toBe(false);
    } finally {
      unsubscribe();
    }
  });
});
