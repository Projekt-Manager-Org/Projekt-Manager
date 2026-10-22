/**
 * API integration tests — attachment scope (AC-410).
 *
 * Pins the `attachmentScopeForCaller` repository predicate and the
 * worker-scope service gate:
 *
 *   - Owner, office, bookkeeper → unscoped (see every attachment row
 *     regardless of project assignment).
 *   - Worker → scoped by `project_workers` — sees only attachments on
 *     projects they are assigned to.
 *
 *   - List / init / complete on an unassigned project → 403 NOT_PERMITTED.
 *   - Any attachment endpoint on a non-existent project id → 404 NOT_FOUND.
 *
 *   - get-by-id three-way result (200 in-scope / 403 out-of-scope /
 *     404 missing) mirrors the project pattern in AC-147 /
 *     role-scoping.test.ts. AC-410 pins the symmetry explicitly.
 *
 * Fixtures:
 *   - Worker1 (SEED_USERS.worker1, "arbeiter1") is assigned to YYYY-007,
 *     -008, -009, -011 per src/server/seed/business.ts. We use -007
 *     as the in-scope project and -001 (unassigned) as the out-of-scope
 *     project.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { startApp, stopApp, login, authGet, authPost, authDelete } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { binaryInitBody } from '../../test/fixtures/attachmentInit.js';
import { createDatabase } from '../db/connection.js';
import { KeyEnvelopeService } from '../services/KeyEnvelopeService.js';

const year = new Date().getFullYear();

async function projectIdByNumber(ownerToken: string, number: string): Promise<string> {
  const res = await authGet(ownerToken, '/api/projects?limit=200');
  const p = (res.json().data as { id: string; number: string }[]).find((r) => r.number === number);
  if (!p) throw new Error(`seed missing ${number}`);
  return p.id;
}

/**
 * Wrap a fresh 32-byte DEK against the per-fork test binary identity
 * (set by `src/test/integration-setup.ts`). Real envelope — the
 * `download-url` arm in this file goes through the route's unwrap
 * pipeline, so synthetic Buffer.alloc bytes would surface as
 * DEK_UNWRAP_FAILED instead of the 200 + dekMaterial the three-way arm
 * pins.
 *
 * Reads `process.env` directly because the env zod schema does not yet
 * carry `BINARY_AGE_*` (implementer extends it in step 5).
 */
async function wrapFreshDek(): Promise<string> {
  const recipient = process.env.BINARY_AGE_RECIPIENT;
  const identityPath = process.env.BINARY_AGE_IDENTITY_PATH;
  if (!recipient || !identityPath) {
    throw new Error(
      'wrapFreshDek: BINARY_AGE_RECIPIENT / BINARY_AGE_IDENTITY_PATH not configured. ' +
        'Per-fork identity is set in src/test/integration-setup.ts.',
    );
  }
  const identity = readFileSync(identityPath, 'utf-8').trim();
  const service = new KeyEnvelopeService({ recipient, identity });
  const dek = crypto.randomBytes(32);
  const envelope = await service.wrap(dek);
  return Buffer.from(envelope).toString('base64');
}

async function seedReadyAttachment(projectId: string, createdBy: string | null): Promise<string> {
  const { db, pool } = createDatabase();
  try {
    const id = crypto.randomUUID();
    // Real wrapped envelope — the three-way download-url arms call into
    // the route's unwrap pipeline, which validates the envelope via
    // `KeyEnvelopeService.unwrap`. A synthetic byte sequence would
    // fail at the AEAD step and surface as DEK_UNWRAP_FAILED.
    const wrappedDek = await wrapFreshDek();
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

describe('Attachment scope (AC-410)', () => {
  let ownerToken: string;
  let officeToken: string;
  let workerToken: string;
  let bookkeeperToken: string;

  let assignedProjectId: string;
  let unassignedProjectId: string;

  beforeAll(async () => {
    await startApp();
    [ownerToken, officeToken, workerToken, bookkeeperToken] = await Promise.all([
      login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.bookkeeper.username, SEED_DEFAULT_PASSWORD),
    ]);
    assignedProjectId = await projectIdByNumber(ownerToken, `${year}-007`);
    unassignedProjectId = await projectIdByNumber(ownerToken, `${year}-001`);
  });

  afterAll(async () => {
    await stopApp();
  });

  // -------------------------------------------------------------------
  // AC-410 — Worker attachment ops on unassigned project → 403.
  //          Non-existent project id → 404.
  // -------------------------------------------------------------------
  describe('AC-410: worker service-layer scope on init / complete / list', () => {
    it('worker list on an unassigned project returns 403 NOT_PERMITTED', async () => {
      const res = await authGet(workerToken, `/api/projects/${unassignedProjectId}/attachments`);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('worker init on an unassigned project returns 403 NOT_PERMITTED', async () => {
      const res = await authPost(
        workerToken,
        `/api/projects/${unassignedProjectId}/attachments/init`,
        binaryInitBody({ fileName: 'x.pdf', sizeBytes: 100, label: 'sonstiges' }),
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('worker complete on an unassigned project returns 403 NOT_PERMITTED', async () => {
      // An attachment on an unassigned project. Its id matters for the
      // route, but the scope check rejects before the row is even
      // fetched — just using any uuid is sufficient.
      const res = await authPost(
        workerToken,
        `/api/projects/${unassignedProjectId}/attachments/${crypto.randomUUID()}/complete`,
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('worker hit on a non-existent project id returns 404 NOT_FOUND (distinguishable from 403)', async () => {
      const missingId = '00000000-0000-0000-0000-000000000099';
      const res = await authGet(workerToken, `/api/projects/${missingId}/attachments`);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });

    it('owner and office see attachments on any project (regression — unscoped)', async () => {
      const ownerRes = await authGet(
        ownerToken,
        `/api/projects/${unassignedProjectId}/attachments`,
      );
      expect(ownerRes.statusCode).toBe(200);

      const officeRes = await authGet(
        officeToken,
        `/api/projects/${unassignedProjectId}/attachments`,
      );
      expect(officeRes.statusCode).toBe(200);

      const bookkeeperRes = await authGet(
        bookkeeperToken,
        `/api/projects/${unassignedProjectId}/attachments`,
      );
      expect(bookkeeperRes.statusCode).toBe(200);
    });
  });

  // -------------------------------------------------------------------
  // AC-410 — Three-way get-by-id (200 / 403 / 404) mirrors AC-147.
  //
  // The download-url endpoint is the natural get-by-id surface for an
  // attachment — it's the one caller-facing read path that keys off an
  // attachment id. Delete is a mutation; list is collection-scoped.
  // -------------------------------------------------------------------
  describe('AC-410: download-url three-way (200 / 403 / 404)', () => {
    let inScopeAttachmentId: string;
    let outOfScopeAttachmentId: string;

    beforeAll(async () => {
      inScopeAttachmentId = await seedReadyAttachment(assignedProjectId, null);
      outOfScopeAttachmentId = await seedReadyAttachment(unassignedProjectId, null);
    });

    it('worker receives 200 for an attachment on an assigned project', async () => {
      const res = await authGet(
        workerToken,
        `/api/projects/${assignedProjectId}/attachments/${inScopeAttachmentId}/download-url?variant=original`,
      );
      expect(res.statusCode).toBe(200);
      // The 200 surface carries `{ url, expiresAt, dekMaterial }` —
      // the SW consumes all three to fetch + decrypt. A
      // regression that returned the legacy `{ url, expiresAt }` shape
      // (pre-ADR-0024) would fail here.
      const body = res.json();
      expect(typeof body.url).toBe('string');
      expect(typeof body.expiresAt).toBe('string');
      expect(typeof body.dekMaterial).toBe('string');
      // 32 bytes after base64-decode — the AES-256-GCM key shape.
      const decoded = Buffer.from(body.dekMaterial, 'base64');
      expect(decoded.length).toBe(32);
    });

    it('worker receives 403 NOT_PERMITTED for an attachment on an unassigned project', async () => {
      const res = await authGet(
        workerToken,
        `/api/projects/${unassignedProjectId}/attachments/${outOfScopeAttachmentId}/download-url?variant=original`,
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('worker receives 404 NOT_FOUND for a non-existent attachment id', async () => {
      const missingId = '00000000-0000-0000-0000-00000000feed';
      const res = await authGet(
        workerToken,
        `/api/projects/${assignedProjectId}/attachments/${missingId}/download-url?variant=original`,
      );
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });

    it.each([
      ['owner', () => ownerToken],
      ['office', () => officeToken],
      ['bookkeeper', () => bookkeeperToken],
    ] as const)(
      '%s receives 200 with `dekMaterial` for any attachment (regression — unscoped)',
      async (_label, getToken) => {
        // Out-of-scope for a scoped worker, but the unscoped roles must
        // still see it (attachment:read is unscoped for
        // owner/office/bookkeeper, api.md §14.3). Under e2e the
        // returned shape carries `dekMaterial` so the SW can decrypt;
        // pin the field's presence on the unscoped path so a regression
        // that exposed the URL but stripped the DEK on a role split
        // would trip here.
        const res = await authGet(
          getToken(),
          `/api/projects/${unassignedProjectId}/attachments/${outOfScopeAttachmentId}/download-url?variant=original`,
        );
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(typeof body.dekMaterial).toBe('string');
        expect(Buffer.from(body.dekMaterial, 'base64').length).toBe(32);
      },
    );
  });

  // Suppress unused-warning for authDelete — kept imported so future
  // delete-scope tests can land here without re-threading the helper.
  void authDelete;
});
