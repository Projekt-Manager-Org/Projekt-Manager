/**
 * API integration tests — attachment permission matrix (api.md §14.3;
 * the worker hide rule of AC-411).
 *
 * Pins the 4-role x 3-operation matrix from api.md §14.3:
 *
 *                   | read | write | delete
 *   ----------------|------|-------|--------
 *   owner           |  Y   |   Y   |   Y
 *   office          |  Y   |   Y   |   Y
 *   worker          |  Y*  |   Y*  |   Y* (author + grace)
 *   bookkeeper      |  Y   |   N   |   N
 *
 *   (*) Worker capabilities are additionally scoped at the repository
 *       and service layers — covered in attachments-scope.test.ts
 *       (AC-410). AC-411's grace-window branches also live
 *       here since the permission gate and the grace check share the
 *       DELETE surface.
 *
 * Pattern mirrors permissions.test.ts — a coarse gate per role, with
 * the scope/extent carved out to its own file to preserve T-ACBS
 * (one concern per test).
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
  authDelete,
  createTestUserSession,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import { ATTACHMENT_CONFIG } from '../../config/attachmentConfig.js';
import { binaryInitBody } from '../../test/fixtures/attachmentInit.js';

const year = new Date().getFullYear();

/** A project worker1 is assigned to so worker write arms hit the service layer. */
async function workerReachableProjectId(ownerToken: string): Promise<string> {
  const res = await authGet(ownerToken, '/api/projects?limit=200');
  const p = (res.json().data as { id: string; number: string }[]).find(
    (r) => r.number === `${year}-007`,
  );
  if (!p) throw new Error(`seed missing ${year}-007`);
  return p.id;
}

async function seedReadyAttachment(projectId: string, createdBy: string | null): Promise<string> {
  const { db, pool } = createDatabase();
  try {
    const id = crypto.randomUUID();
    // ADR-0024: a `ready` row must carry a wrapped DEK envelope and a
    // ciphertext byte count (CHECK `attachments_wrapped_dek_required_when_ready`).
    // Synthetic envelope is fine here — this file pins the permission
    // gate, not the unwrap pipeline.
    const wrappedDek = Buffer.alloc(192, 0x77).toString('base64');
    await db.execute(sql`
      INSERT INTO attachments
        (id, project_id, status, kind, label, filename, mime_type, size_bytes,
         ciphertext_size_bytes,
         original_key, thumb_key, has_thumbnail,
         wrapped_dek, wrapped_thumb_dek, wrapped_dek_version, created_by)
      VALUES (${id}, ${projectId}, 'ready', 'binary', 'sonstiges',
              ${'f-' + id.slice(0, 6)}, 'application/pdf', 100,
              164,
              ${`attachments/${projectId}/${id}.orig`}, NULL, FALSE,
              ${wrappedDek}, NULL, 1, ${createdBy})
    `);
    return id;
  } finally {
    await pool.end();
  }
}

describe('Attachment permission matrix (api.md §14.3 + AC-411)', () => {
  let ownerToken: string;
  let officeToken: string;
  let workerToken: string;
  let bookkeeperToken: string;
  /** A user with no roles — every operation must 403. */
  let noPermsToken: string;
  let workerUserId: string;
  let projectId: string;

  beforeAll(async () => {
    await startApp();
    [ownerToken, officeToken, workerToken, bookkeeperToken] = await Promise.all([
      login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.bookkeeper.username, SEED_DEFAULT_PASSWORD),
    ]);
    const none = await createTestUserSession({ roles: [] });
    noPermsToken = none.token;

    projectId = await workerReachableProjectId(ownerToken);
    const me = await authGet(workerToken, '/api/auth/me');
    workerUserId = me.json().user.id;
  });

  afterAll(async () => {
    await stopApp();
  });

  // -------------------------------------------------------------------
  // attachment:read — owner, office, worker (scoped), bookkeeper
  // -------------------------------------------------------------------
  describe('read (list) — attachment:read gate', () => {
    it.each([
      ['owner', () => ownerToken],
      ['office', () => officeToken],
      ['worker', () => workerToken],
      ['bookkeeper', () => bookkeeperToken],
    ] as const)('%s receives 200 on list (holds attachment:read)', async (_label, getToken) => {
      const res = await authGet(getToken(), `/api/projects/${projectId}/attachments`);
      expect(res.statusCode).toBe(200);
    });

    it('user with no roles receives 403 NOT_PERMITTED', async () => {
      const res = await authGet(noPermsToken, `/api/projects/${projectId}/attachments`);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });
  });

  // -------------------------------------------------------------------
  // attachment:write — owner, office, worker (bookkeeper denied)
  // -------------------------------------------------------------------
  describe('write (init) — attachment:write gate', () => {
    it('bookkeeper is rejected with 403 NOT_PERMITTED — lacks attachment:write', async () => {
      const res = await authPost(
        bookkeeperToken,
        `/api/projects/${projectId}/attachments/init`,
        binaryInitBody({ fileName: 'x.pdf', sizeBytes: 100 }),
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('user with no roles is rejected with 403 NOT_PERMITTED', async () => {
      const res = await authPost(
        noPermsToken,
        `/api/projects/${projectId}/attachments/init`,
        binaryInitBody({ fileName: 'x.pdf', sizeBytes: 100 }),
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it.each([
      ['owner', () => ownerToken],
      ['office', () => officeToken],
    ] as const)(
      '%s passes the permission gate (expected 201 on a valid payload)',
      async (_label, getToken) => {
        const res = await authPost(
          getToken(),
          `/api/projects/${projectId}/attachments/init`,
          binaryInitBody({ fileName: 'gate.pdf', sizeBytes: 100, label: 'sonstiges' }),
        );
        // The gate must not reject with 403, AND the payload is valid,
        // so the only acceptable non-gate outcomes are 201 (success) or
        // 422 (a future validator gets stricter). Asserting a specific
        // set instead of `not.toBe(403)` catches a 5xx regression that
        // the looser check would silently accept.
        expect([201, 422]).toContain(res.statusCode);
      },
    );

    it('worker assigned to the project passes the permission gate', async () => {
      const res = await authPost(
        workerToken,
        `/api/projects/${projectId}/attachments/init`,
        binaryInitBody({ fileName: 'worker.pdf', sizeBytes: 100, label: 'sonstiges' }),
      );
      // Same tight contract as the owner/office arm — the gate passes
      // and the valid payload produces 201 (or 422 if a validator
      // tightens); 5xx must be a failure.
      expect([201, 422]).toContain(res.statusCode);
    });
  });

  // -------------------------------------------------------------------
  // attachment:hide — owner, office, worker (author + grace);
  // bookkeeper denied at the permission gate alone (never reaches
  // authorship / grace branches).
  // -------------------------------------------------------------------
  describe('delete — attachment:hide gate', () => {
    it('bookkeeper is rejected with 403 NOT_PERMITTED — lacks attachment:hide', async () => {
      const id = await seedReadyAttachment(projectId, null);
      const res = await authDelete(bookkeeperToken, `/api/projects/${projectId}/attachments/${id}`);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('user with no roles is rejected with 403 NOT_PERMITTED', async () => {
      const id = await seedReadyAttachment(projectId, null);
      const res = await authDelete(noPermsToken, `/api/projects/${projectId}/attachments/${id}`);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('owner deletes any attachment — returns 204', async () => {
      const id = await seedReadyAttachment(projectId, null);
      const res = await authDelete(ownerToken, `/api/projects/${projectId}/attachments/${id}`);
      // Route returns 204 No Content on success (src/server/routes/attachments.ts).
      // Pinning the exact code catches a 200 or 5xx regression that the
      // old `< 300` check would accept.
      expect(res.statusCode).toBe(204);
    });

    it('office deletes any attachment — returns 204', async () => {
      const id = await seedReadyAttachment(projectId, null);
      const res = await authDelete(officeToken, `/api/projects/${projectId}/attachments/${id}`);
      expect(res.statusCode).toBe(204);
    });

    it('worker deleting their own attachment within the grace window succeeds (AC-411)', async () => {
      // Seed a row whose createdBy IS the worker and whose createdAt is
      // fresh (the default NOW()). The grace window is 15 minutes per
      // architecture.md §12.2; freshly created rows are well within it.
      const id = await seedReadyAttachment(projectId, workerUserId);
      const res = await authDelete(workerToken, `/api/projects/${projectId}/attachments/${id}`);
      expect(res.statusCode).toBe(204);
    });

    it("worker deleting another's attachment is rejected with 403 NOT_PERMITTED (AC-411)", async () => {
      // createdBy = owner-ish (null here — no real owner mattered).
      // Either way the author is not the worker.
      const id = await seedReadyAttachment(projectId, null);
      const res = await authDelete(workerToken, `/api/projects/${projectId}/attachments/${id}`);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    // -----------------------------------------------------------------
    // AC-411 boundary — just-inside / just-outside the grace window.
    //
    // The previous single "24 h in the past → 403" arm wasn't a boundary
    // test: 24 h sits beyond any conceivable grace, so a bug that mis-
    // calculated by minutes would still pass. These two arms pin the
    // exact minute the service flips from "author can still delete" to
    // "author is locked out", by backdating the row just past (expect
    // 403) and just before (expect 204) the configured grace.
    //
    // `ATTACHMENT_CONFIG.workerSelfDeleteGraceMinutes` is the
    // build-time default; the in-process test app uses no env override,
    // so it matches the server-side value the service reads.
    // -----------------------------------------------------------------
    describe('AC-411 grace-window boundary', () => {
      const graceMinutes = ATTACHMENT_CONFIG.workerSelfDeleteGraceMinutes;

      it('worker self-delete JUST OUTSIDE the grace window → 403 NOT_PERMITTED', async () => {
        const id = await seedReadyAttachment(projectId, workerUserId);
        const { db, pool } = createDatabase();
        try {
          // grace + 1 s — first second past the window.
          await db.execute(sql`
            UPDATE attachments
            SET created_at = NOW() - (${graceMinutes} * INTERVAL '1 minute' + INTERVAL '1 second')
            WHERE id = ${id}
          `);
        } finally {
          await pool.end();
        }
        const res = await authDelete(workerToken, `/api/projects/${projectId}/attachments/${id}`);
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('NOT_PERMITTED');
      });

      it('worker self-delete JUST INSIDE the grace window → 204', async () => {
        const id = await seedReadyAttachment(projectId, workerUserId);
        const { db, pool } = createDatabase();
        try {
          // grace - 5 s — five seconds left in the window. A small
          // buffer absorbs wall-clock drift between the DB NOW() used
          // here and the service's Date.now() comparison.
          await db.execute(sql`
            UPDATE attachments
            SET created_at = NOW() - (${graceMinutes} * INTERVAL '1 minute' - INTERVAL '5 seconds')
            WHERE id = ${id}
          `);
        } finally {
          await pool.end();
        }
        const res = await authDelete(workerToken, `/api/projects/${projectId}/attachments/${id}`);
        expect(res.statusCode).toBe(204);
      });
    });
  });
});
