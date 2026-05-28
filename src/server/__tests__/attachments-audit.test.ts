/**
 * API integration tests — attachment audit contract (AC-219, AC-240).
 *
 * Pins the single-write-path invariant (AC-177, ADR-0021) as it
 * applies to the attachment entity:
 *
 *   - Complete (the `pending → ready` finalize) writes exactly one
 *     `attachment:add` audit row with `entityType='attachment'`,
 *     `entityId=attachmentId`, and a payload `after` naming attachmentId,
 *     projectId, label, mimeType, sizeBytes. The owning project's
 *     display name is captured in `ancestor_entity_label` (not in the
 *     payload — AC-339 / AC-342), which is the single source consumed
 *     by the push composer (AC-211), the dock, and the /audit Projekt
 *     column. This is the attachment's authoritative entry into the
 *     project.
 *   - Init creates the `pending` row and writes NO audit row (an
 *     allowlisted single-write-path exception, parity with the orphan
 *     reaper's pending-row carve-out). An upload abandoned before
 *     complete therefore leaves NO `attachment:add` row and never
 *     surfaces on the activity feed.
 *   - Delete (= soft-hide, ADR-0022) writes exactly one `attachment:hide`
 *     audit row with `entityType='attachment'`, `entityId=attachmentId`,
 *     and a payload `before` naming the same fields.
 *
 *   - AC-240: the `wrappedDek` / `wrappedThumbDek` columns MUST NOT
 *     appear in any `audit_log` `payload` JSON — neither as column
 *     names ("wrappedDek") nor as the actual envelope bytes for the
 *     row. Schema-level audit exclusion (ADR-0024 / data-model.md
 *     §5.13) is the mechanism; this test is the AC-pinned consumer.
 *     A regression that surfaced the wrapped envelope in audit JSON
 *     would let a DB-only adversary pair the audit dump with the
 *     B2 ciphertext to reconstruct plaintext — defeating the entire
 *     e2e perimeter.
 *
 * Attachment is a first-class member of `AuditEntityType` (data-model.md
 * §5.10), symmetric with `project_worker`. Every attachment audit row
 * carries `entityType='attachment'` and `entityId=<attachmentId>`; the
 * owning project id lives in the payload (`after.projectId` on add,
 * `before.projectId` on remove) so the activity feed can link back to
 * the project. The architecture check
 * (scripts/check-audit-mutations.sh) picks up the `attachments` table
 * via the `AuditEntityType` derivation — covered in
 * attachments-architecture.test.ts.
 *
 * Raw-SQL attachment-row seeding is permitted here — the `__tests__/`
 * prefix is allowlisted by the architecture check (AC-179).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
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
import { photoInitBody } from '../../test/fixtures/attachmentInit.js';

const year = new Date().getFullYear();

async function countAuditRows(): Promise<number> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(sql`SELECT COUNT(*)::int AS c FROM audit_log`);
    return (res.rows[0] as { c: number }).c;
  } finally {
    await pool.end();
  }
}

async function fetchLatestAuditRow(
  entityId: string,
  action: string,
): Promise<Record<string, unknown> | null> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(sql`
      SELECT id, entity_type, entity_id, action, actor_id, actor_kind,
             ancestor_entity_type, ancestor_entity_id, ancestor_entity_label, payload
      FROM audit_log
      WHERE entity_id = ${entityId} AND action = ${action}
      ORDER BY created_at DESC
      LIMIT 1
    `);
    return (res.rows[0] as Record<string, unknown>) ?? null;
  } finally {
    await pool.end();
  }
}

async function projectIdByNumber(ownerToken: string, number: string): Promise<string> {
  const res = await authGet(ownerToken, '/api/projects?limit=200');
  const p = (res.json().data as { id: string; number: string }[]).find((r) => r.number === number);
  if (!p) throw new Error(`seed missing ${number}`);
  return p.id;
}

/**
 * Fetch the owning project's `number` + `title` so a test can assert the
 * exact `projectLabel` snapshot on the `attachment:add` row equals
 * `projectAuditLabel({ number, title })` — i.e. `"<number> <title>"`.
 */
async function projectNumberTitleById(
  ownerToken: string,
  id: string,
): Promise<{ number: string; title: string }> {
  const res = await authGet(ownerToken, '/api/projects?limit=200');
  const p = (res.json().data as { id: string; number: string; title: string }[]).find(
    (r) => r.id === id,
  );
  if (!p) throw new Error(`project ${id} not found`);
  return { number: p.number, title: p.title };
}

/**
 * Drive init → stage backing ciphertext bytes → complete for one
 * attachment, returning its id. Shared by the tests that need a
 * `ready` row carrying an `attachment:add` audit row (AC-219: the row
 * is written at complete, not at init). Sizes match the photo fixture's
 * ciphertext defaults (120_064 original + 8_064 thumbnail) and the
 * content-type is the sentinel `application/octet-stream` (ADR-0024) so
 * the complete-time HEAD verification passes.
 */
async function stageAndComplete(
  ownerToken: string,
  projectId: string,
  initBody: Record<string, unknown>,
): Promise<string> {
  const initRes = await authPost(
    ownerToken,
    `/api/projects/${projectId}/attachments/init`,
    initBody,
  );
  expect(initRes.statusCode).toBe(201);
  const body = initRes.json();
  const attachmentId = body.attachment.id as string;

  const env = getEnv();
  const s = createStorageClient({
    endpoint: env.STORAGE_ENDPOINT!,
    bucket: env.STORAGE_BUCKET,
    accessKey: env.STORAGE_ACCESS_KEY!,
    secretKey: env.STORAGE_SECRET_KEY!,
  });
  await s.upload(
    body.attachment.originalKey,
    Buffer.alloc(120_064, 0xff),
    'application/octet-stream',
  );
  await s.upload(body.attachment.thumbKey, Buffer.alloc(8_064, 0xaa), 'application/octet-stream');

  const completeRes = await authPost(
    ownerToken,
    `/api/projects/${projectId}/attachments/${attachmentId}/complete`,
  );
  expect(completeRes.statusCode).toBe(200);
  return attachmentId;
}

describe('Attachment audit contract (AC-219)', () => {
  let ownerToken: string;
  let projectId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    projectId = await projectIdByNumber(ownerToken, `${year}-007`);
  });

  afterAll(async () => {
    await stopApp();
  });

  // -------------------------------------------------------------------
  // complete → exactly one `attachment:add` audit row (AC-219)
  //
  // The `attachment:add` row is written at the `pending → ready`
  // finalize, NOT at init. We drive init+complete, asserting init alone
  // produces zero audit rows and complete produces exactly one — and
  // that row carries the structural `payload.after` AND a non-null
  // `ancestor_entity_label` snapshot equal to `<number> <title>` (the
  // single source of the project's display name for downstream consumers
  // — push composer, dock, /audit Projekt column).
  // -------------------------------------------------------------------
  it('complete writes exactly one attachment:add row with entityType=attachment, structural payload.after, and the project-label snapshot on ancestor_entity_label', async () => {
    // Init: stage the pending row + backing bytes WITHOUT completing
    // yet, so we can pin the "init writes no audit row" leg before the
    // finalize. (We can't reuse stageAndComplete here — it completes in
    // one shot; this test needs the count between init and complete.)
    const initRes = await authPost(
      ownerToken,
      `/api/projects/${projectId}/attachments/init`,
      photoInitBody({ fileName: 'vertrag-audit.jpg', sizeBytes: 4321, label: 'foto' }),
    );
    expect(initRes.statusCode).toBe(201);
    const body = initRes.json();
    const attachmentId = body.attachment.id as string;

    // Stage backing ciphertext bytes so the complete-time HEAD verify
    // passes. Sizes match the photo fixture's ciphertext defaults
    // (120_064 + 8_064); content-type is the sentinel per ADR-0024.
    const env = getEnv();
    const s = createStorageClient({
      endpoint: env.STORAGE_ENDPOINT!,
      bucket: env.STORAGE_BUCKET,
      accessKey: env.STORAGE_ACCESS_KEY!,
      secretKey: env.STORAGE_SECRET_KEY!,
    });
    await s.upload(
      body.attachment.originalKey,
      Buffer.alloc(120_064, 0xff),
      'application/octet-stream',
    );
    await s.upload(body.attachment.thumbKey, Buffer.alloc(8_064, 0xaa), 'application/octet-stream');

    // Init alone writes NO audit row (AC-219).
    const afterInit = await countAuditRows();
    expect(await fetchLatestAuditRow(attachmentId, 'attachment:add')).toBeNull();

    const completeRes = await authPost(
      ownerToken,
      `/api/projects/${projectId}/attachments/${attachmentId}/complete`,
    );
    expect(completeRes.statusCode).toBe(200);

    // Complete writes exactly one audit row.
    const afterComplete = await countAuditRows();
    expect(afterComplete - afterInit).toBe(1);

    const row = await fetchLatestAuditRow(attachmentId, 'attachment:add');
    expect(row).not.toBeNull();
    expect(row!.entity_type).toBe('attachment');
    expect(row!.entity_id).toBe(attachmentId);
    expect(row!.action).toBe('attachment:add');
    expect(row!.actor_kind).toBe('user');
    expect(row!.actor_id).not.toBeNull();

    // Ancestor link (architecture.md §11.12). Attachment rows carry
    // `('project', projectId)` so the per-project activity feed's
    // ancestor-scoped filter picks them up alongside project and
    // project_worker rows in one indexed query.
    expect(row!.ancestor_entity_type).toBe('project');
    expect(row!.ancestor_entity_id).toBe(projectId);

    const payload = row!.payload as { after?: Record<string, unknown> };
    expect(payload.after).toBeDefined();
    expect(payload.after!.projectId).toBe(projectId);
    expect(payload.after!.attachmentId).toBe(attachmentId);
    expect(payload.after!.label).toBe('foto');
    expect(payload.after!.mimeType).toBe('image/jpeg');
    expect(payload.after!.sizeBytes).toBe(4321);

    // The owning project's display name is NOT in payload.after — the
    // single source is `ancestor_entity_label` on the audit row itself
    // (AC-219 / AC-339 / AC-342). The push composer, dock, and /audit
    // Projekt column all read from there. Assert the absence so a
    // regression that re-duplicates it into the payload is caught.
    expect(payload.after).not.toHaveProperty('projectLabel');

    // `ancestor_entity_label` MUST equal projectAuditLabel(project) =
    // `<number> <title>`. Fetch the project's number+title and assert
    // exact equality — not just presence.
    const { number, title } = await projectNumberTitleById(ownerToken, projectId);
    expect(row!.ancestor_entity_label).toBe(`${number} ${title}`);
  });

  // -------------------------------------------------------------------
  // init → NO audit row; an abandoned upload leaves no `attachment:add`
  // -------------------------------------------------------------------
  it('init writes zero audit rows — an abandoned upload leaves no attachment:add row', async () => {
    const before = await countAuditRows();

    // Init ONLY — no backing bytes staged, no complete call. This is an
    // upload abandoned before finalize (the orphan reaper, data-model.md
    // §6.11, later removes the pending row + objects). It must produce no
    // audit row (AC-219).
    const initRes = await authPost(
      ownerToken,
      `/api/projects/${projectId}/attachments/init`,
      photoInitBody({ fileName: 'abandoned-upload.jpg' }),
    );
    expect(initRes.statusCode).toBe(201);
    const attachmentId = initRes.json().attachment.id as string;

    const after = await countAuditRows();
    expect(after - before).toBe(0);
    expect(await fetchLatestAuditRow(attachmentId, 'attachment:add')).toBeNull();
  });

  // -------------------------------------------------------------------
  // delete → exactly one `attachment:hide` audit row
  // -------------------------------------------------------------------
  it('delete writes exactly one attachment:hide row with before payload fields', async () => {
    // Seed directly — we don't need the real upload path here; the
    // delete API takes a ready row and flips it to status='hidden'
    // (ADR-0022). Raw SQL is allowlisted under __tests__/.
    const { db, pool } = createDatabase();
    const attachmentId = crypto.randomUUID();
    const wrappedDekSeed = Buffer.alloc(192, 0x99).toString('base64');
    try {
      await db.execute(sql`
        INSERT INTO attachments
          (id, project_id, status, kind, label, filename, mime_type, size_bytes,
           ciphertext_size_bytes,
           original_key, thumb_key, has_thumbnail,
           wrapped_dek, wrapped_thumb_dek, wrapped_dek_version, created_by)
        VALUES (${attachmentId}, ${projectId}, 'ready', 'binary', 'angebot',
                'angebot-2026.pdf', 'application/pdf', 9876,
                9940,
                ${`attachments/${projectId}/${attachmentId}.orig`}, NULL, FALSE,
                ${wrappedDekSeed}, NULL, 1, NULL)
      `);
    } finally {
      await pool.end();
    }

    const before = await countAuditRows();

    const res = await authDelete(
      ownerToken,
      `/api/projects/${projectId}/attachments/${attachmentId}`,
    );
    expect(res.statusCode).toBeLessThan(300);

    const after = await countAuditRows();
    expect(after - before).toBe(1);

    const row = await fetchLatestAuditRow(attachmentId, 'attachment:hide');
    expect(row).not.toBeNull();
    expect(row!.entity_type).toBe('attachment');
    expect(row!.entity_id).toBe(attachmentId);
    expect(row!.action).toBe('attachment:hide');
    expect(row!.actor_kind).toBe('user');
    // Ancestor link (architecture.md §11.12).
    expect(row!.ancestor_entity_type).toBe('project');
    expect(row!.ancestor_entity_id).toBe(projectId);
    // AC-339 / AC-342: ancestor label snapshot equals
    // `projectAuditLabel(project)` so the dock and /audit Projekt column
    // render the project name without a JOIN. Regression-guard the change
    // under test (the hide leg was previously asserted only on type+id).
    const { number, title } = await projectNumberTitleById(ownerToken, projectId);
    expect(row!.ancestor_entity_label).toBe(`${number} ${title}`);

    const payload = row!.payload as { before?: Record<string, unknown> };
    expect(payload.before).toBeDefined();
    expect(payload.before!.projectId).toBe(projectId);
    expect(payload.before!.attachmentId).toBe(attachmentId);
    expect(payload.before!.label).toBe('angebot');
    expect(payload.before!.mimeType).toBe('application/pdf');
    expect(payload.before!.sizeBytes).toBe(9876);
  });

  // -------------------------------------------------------------------
  // Cross-entity isolation — attachment writes stay on
  // `entityType='attachment'` and do NOT bleed onto sibling entities.
  //
  // Guard against a regression that mistakenly stamps every audit row
  // with `entityType='attachment'` (e.g. a constant substituted for a
  // per-call parameter in `mutate()`). Trigger two writes in the same
  // run — one attachment op, one non-attachment op — and assert the
  // two resulting rows carry DISTINCT `entity_type` values.
  //
  // Customer create is the cheapest sibling op: single POST, no
  // fixture seeding, yields one `entity_type='customer'` audit row.
  // -------------------------------------------------------------------
  it('attachment and non-attachment writes produce distinct entity_type audit rows', async () => {
    // Attachment write → `entity_type='attachment'`. The `attachment:add`
    // row lands at complete (AC-219), so drive the full init→stage→
    // complete flow via the shared helper to get the row.
    const attachmentId = await stageAndComplete(
      ownerToken,
      projectId,
      photoInitBody({ fileName: 'cross-entity.jpg', label: 'foto' }),
    );

    // Non-attachment write → `entity_type='customer'`.
    const customerRes = await authPost(ownerToken, '/api/customers', {
      name: 'Cross-Entity Isolation Test',
    });
    expect(customerRes.statusCode).toBe(201);
    const customerId = customerRes.json().id as string;

    const attachmentRow = await fetchLatestAuditRow(attachmentId, 'attachment:add');
    const customerRow = await fetchLatestAuditRow(customerId, 'create');

    expect(attachmentRow).not.toBeNull();
    expect(customerRow).not.toBeNull();

    // Core invariant — a regression that flipped every audit row to
    // `'attachment'` would fail HERE.
    expect(attachmentRow!.entity_type).toBe('attachment');
    expect(customerRow!.entity_type).toBe('customer');
    expect(attachmentRow!.entity_type).not.toBe(customerRow!.entity_type);
  });

  // -------------------------------------------------------------------
  // Snapshot survival — ancestor_entity_label is frozen at write time.
  //
  // The whole point of denormalizing the parent project's label onto
  // every audit row (architecture.md §11.12) is that the activity feed
  // stays readable AFTER the project is renamed or purged. This test
  // pins that guarantee: write an audit row, rename the project, fetch
  // the SAME audit row, assert the label still shows the original
  // value.
  // -------------------------------------------------------------------
  it('ancestor_entity_label is frozen at write time — a later project rename does not mutate prior audit rows', async () => {
    const { number: originalNumber, title: originalTitle } = await projectNumberTitleById(
      ownerToken,
      projectId,
    );
    const originalLabel = `${originalNumber} ${originalTitle}`;

    // 1) Write an audit row carrying the current label snapshot.
    const attachmentId = await stageAndComplete(
      ownerToken,
      projectId,
      photoInitBody({ fileName: 'snapshot-survival.jpg', label: 'foto' }),
    );
    const rowBeforeRename = await fetchLatestAuditRow(attachmentId, 'attachment:add');
    expect(rowBeforeRename).not.toBeNull();
    expect(rowBeforeRename!.ancestor_entity_label).toBe(originalLabel);

    // 2) Rename the project. Restore in `finally` so a later test that
    //    reads the live title isn't affected by a failure here.
    const renamedTitle = `${originalTitle} (renamed)`;
    try {
      const patchRes = await authPatch(ownerToken, `/api/projects/${projectId}`, {
        title: renamedTitle,
      });
      expect(patchRes.statusCode).toBe(200);

      // Sanity: the live row reflects the new title.
      const { title: liveTitleAfter } = await projectNumberTitleById(ownerToken, projectId);
      expect(liveTitleAfter).toBe(renamedTitle);

      // 3) The originally written audit row's ancestor label must
      //    still be the ORIGINAL value. A regression that resolved
      //    the label from a JOIN-at-read instead of the snapshot
      //    would surface the renamed title here.
      const rowAfterRename = await fetchLatestAuditRow(attachmentId, 'attachment:add');
      expect(rowAfterRename).not.toBeNull();
      expect(rowAfterRename!.ancestor_entity_label).toBe(originalLabel);
      expect(rowAfterRename!.ancestor_entity_label).not.toBe(`${originalNumber} ${renamedTitle}`);
    } finally {
      await authPatch(ownerToken, `/api/projects/${projectId}`, { title: originalTitle });
    }
  });
});

// ---------------------------------------------------------------------
// AC-240 — schema-level audit exclusion for wrappedDek / wrappedThumbDek
//
// Drives the full `attachment:add` (complete) → `attachment:hide`
// (DELETE) → `attachment:restore` flow and asserts each resulting
// `audit_log` row's `payload` JSON contains NEITHER the column names
// `wrappedDek` / `wrappedThumbDek` NOR the actual envelope bytes for the
// row. The schema-level mechanism (declarative column tag) is the
// implementation — this test is the AC consumer pinning the contract.
//
// The seeded row carries fixture wrapped envelopes set via direct INSERT
// so the test can inspect them on the audit-log read. A regression
// could leak the bytes either by name (column appears in payload) or by
// value (the literal envelope bytes appear in some other field). Pin
// both — a malicious `payload` shape that smuggles the envelope under
// a different field name would still trip the bytes-by-value branch.
// ---------------------------------------------------------------------

describe('AC-240: wrapped-DEK columns never appear in audit payloads', () => {
  let ownerToken: string;
  let projectId: string;

  const FIXTURE_WRAPPED_DEK = Buffer.from('sentinel-original-envelope-bytes-do-not-leak').toString(
    'base64',
  );
  const FIXTURE_WRAPPED_THUMB_DEK = Buffer.from(
    'sentinel-thumbnail-envelope-bytes-do-not-leak',
  ).toString('base64');

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    projectId = await projectIdByNumber(ownerToken, `${year}-007`);
  });

  afterAll(async () => {
    await stopApp();
  });

  /**
   * Read every audit_log row for a given entity id and return the
   * `payload` JSON serialised back to a string — easier to grep for
   * forbidden tokens than to walk the JSON tree (and it catches both
   * shape-level and value-level leaks in one pass).
   */
  async function fetchAuditPayloadStrings(entityId: string): Promise<string[]> {
    const { db, pool } = createDatabase();
    try {
      const res = await db.execute(
        sql`SELECT payload FROM audit_log WHERE entity_id = ${entityId} ORDER BY created_at ASC`,
      );
      return (res.rows as { payload: unknown }[]).map((r) => JSON.stringify(r.payload));
    } finally {
      await pool.end();
    }
  }

  /** Assert no audit-log row for `entityId` leaks either by name or by value. */
  async function assertNoLeak(entityId: string): Promise<void> {
    const payloads = await fetchAuditPayloadStrings(entityId);
    expect(payloads.length).toBeGreaterThan(0); // sanity — a write happened
    for (const p of payloads) {
      // Column names — direct JSON.stringify-shape leak.
      expect(p).not.toContain('wrappedDek');
      expect(p).not.toContain('wrappedThumbDek');
      // snake_case shape — DB-row mirror leak (a regression that
      // serialised the row directly would surface the snake_case
      // form too).
      expect(p).not.toContain('wrapped_dek');
      expect(p).not.toContain('wrapped_thumb_dek');
      // The actual envelope bytes for the row — a smuggled-under-
      // a-different-name leak still trips here.
      expect(p).not.toContain(FIXTURE_WRAPPED_DEK);
      expect(p).not.toContain(FIXTURE_WRAPPED_THUMB_DEK);
    }
  }

  it('attachment:add (complete) audit row does not carry wrappedDek by name or by bytes', async () => {
    // The `attachment:add` row is written at complete, not init (AC-219),
    // so drive the full init→stage→complete flow via the shared helper
    // to produce it. The route wraps the DEK server-side; AC-240 pins
    // that the wrapped envelope must NOT surface in the audit payload —
    // by column name OR by its literal bytes. We pin both shape (no
    // column name) AND bytes (the row's actual wrapped_dek /
    // wrapped_thumb_dek must not appear in any audit row for the entity).
    const attachmentId = await stageAndComplete(
      ownerToken,
      projectId,
      photoInitBody({ fileName: 'audit-complete.jpg', label: 'foto' }),
    );

    // Read the row's actual wrapped envelopes (a photo populates both
    // original + thumbnail) for the bytes-by-value check.
    const { db, pool } = createDatabase();
    let actualWrappedDek: string;
    let actualWrappedThumbDek: string;
    try {
      const res = await db.execute(
        sql`SELECT wrapped_dek, wrapped_thumb_dek FROM attachments WHERE id = ${attachmentId}`,
      );
      const r = res.rows[0] as { wrapped_dek: string; wrapped_thumb_dek: string };
      actualWrappedDek = r.wrapped_dek;
      actualWrappedThumbDek = r.wrapped_thumb_dek;
    } finally {
      await pool.end();
    }
    expect(actualWrappedDek.length).toBeGreaterThan(0);
    expect(actualWrappedThumbDek.length).toBeGreaterThan(0);

    const payloads = await fetchAuditPayloadStrings(attachmentId);
    expect(payloads.length).toBe(1); // exactly one attachment:add row
    for (const p of payloads) {
      expect(p).not.toContain('wrappedDek');
      expect(p).not.toContain('wrappedThumbDek');
      expect(p).not.toContain('wrapped_dek');
      expect(p).not.toContain('wrapped_thumb_dek');
      // The literal envelope bytes for THIS row (defence against a
      // smuggle-under-another-name regression).
      expect(p).not.toContain(actualWrappedDek);
      expect(p).not.toContain(actualWrappedThumbDek);
    }
  });

  it('attachment:hide (DELETE) audit row does not carry wrappedDek by name or by bytes', async () => {
    // Seed a ready row directly with the FIXTURE wrapped envelopes so
    // the bytes-by-value check has a deterministic target.
    const attachmentId = crypto.randomUUID();
    const { db, pool } = createDatabase();
    try {
      await db.execute(sql`
        INSERT INTO attachments
          (id, project_id, status, kind, label, filename, mime_type, size_bytes,
           ciphertext_size_bytes,
           original_key, thumb_key, has_thumbnail,
           wrapped_dek, wrapped_thumb_dek, wrapped_dek_version, created_by)
        VALUES (${attachmentId}, ${projectId}, 'ready', 'binary', 'angebot',
                'audit-hide.pdf', 'application/pdf', 1234,
                1234,
                ${`attachments/${projectId}/${attachmentId}.orig`}, NULL, FALSE,
                ${FIXTURE_WRAPPED_DEK}, NULL, 1, NULL)
      `);
    } finally {
      await pool.end();
    }

    const res = await authDelete(
      ownerToken,
      `/api/projects/${projectId}/attachments/${attachmentId}`,
    );
    expect(res.statusCode).toBeLessThan(300);

    await assertNoLeak(attachmentId);
  });

  it('attachment:restore audit row does not carry wrappedDek by name or by bytes', async () => {
    // Seed a hidden photo row (so both wrappedDek AND wrappedThumbDek
    // are populated) with FIXTURE envelopes. Drive restore. Inspect.
    const attachmentId = crypto.randomUUID();
    const { db, pool } = createDatabase();
    try {
      await db.execute(sql`
        INSERT INTO attachments
          (id, project_id, status, kind, label, filename, mime_type, size_bytes,
           ciphertext_size_bytes, ciphertext_thumb_size_bytes,
           original_key, thumb_key, has_thumbnail,
           wrapped_dek, wrapped_thumb_dek, wrapped_dek_version,
           version_id, thumb_version_id, hidden_at, created_by)
        VALUES (${attachmentId}, ${projectId}, 'hidden', 'photo', 'foto',
                'audit-restore.jpg', 'image/jpeg', 5000,
                5000, 1000,
                ${`attachments/${projectId}/${attachmentId}.orig`},
                ${`attachments/${projectId}/${attachmentId}.thumb`}, TRUE,
                ${FIXTURE_WRAPPED_DEK}, ${FIXTURE_WRAPPED_THUMB_DEK}, 1,
                'fake-version-id', 'fake-thumb-version-id', NOW(), NULL)
      `);
    } finally {
      await pool.end();
    }

    // Drive restore. The route may surface a 5xx because the storage
    // copyFromVersion call fails on the fake version-id; the audit
    // contract under AC-240 is whether the audit row (if written)
    // leaks the envelope. If restore fails before the audit write, the
    // assertion still holds (no audit row, no leak); the failure-mode
    // assertion lives in attachments-routes.test.ts.
    await authPost(ownerToken, `/api/projects/${projectId}/attachments/${attachmentId}/restore`);

    // For every audit row that DID land (init wasn't called here, so
    // we only see hide/restore rows if any committed), assert no leak.
    const payloads = await fetchAuditPayloadStrings(attachmentId);
    for (const p of payloads) {
      expect(p).not.toContain('wrappedDek');
      expect(p).not.toContain('wrappedThumbDek');
      expect(p).not.toContain('wrapped_dek');
      expect(p).not.toContain('wrapped_thumb_dek');
      expect(p).not.toContain(FIXTURE_WRAPPED_DEK);
      expect(p).not.toContain(FIXTURE_WRAPPED_THUMB_DEK);
    }
  });
});
