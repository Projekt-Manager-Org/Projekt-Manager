/**
 * API integration tests — `init` with the optional `restore` block
 * (issue #163, AC-255 / AC-256 / AC-257 / AC-258).
 *
 * Pins the contract for the import-mode init path on
 *   POST /api/projects/:id/attachments/init
 * with an optional `restore: { id, createdBy, createdAt }` block. The
 * block lets the takeout-zip orchestrator pin the original row identity
 * across a Vollständiger Import; without the block the existing init
 * path stays unchanged (AC-258 regression).
 *
 * AC coverage:
 *   AC-255  permission gate — `restore` block requires both `data:restore`
 *           AND `attachment:write`. `attachment:write` only → 403;
 *           `data:restore` only (synthetic role; no seeded role holds it
 *           without `attachment:write`) → 403; both → 200; init without
 *           the block is unaffected.
 *   AC-256  happy path — supplied `id`, `createdBy`, `createdAt` land
 *           verbatim on the resulting row (no server override). Other
 *           init-time checks (MIME whitelist, label enum, size cap,
 *           fileName sanitization, DEK validation) still run.
 *   AC-257  bad-input branches — bad UUID → 422; `restore.createdBy`
 *           referencing absent user → 422; non-ISO `restore.createdAt`
 *           → 422; `restore.id` collides with existing attachment → 409.
 *           No row persisted on every branch.
 *   AC-258  regression — caller without `data:restore` (e.g. office)
 *           drives the standard upload path; resulting row carries
 *           server-generated `id`, session-derived `createdBy`, and
 *           server-clock `createdAt`.
 *
 * Mirrors the harness in `attachments-routes.test.ts` (per-role tokens
 * via `createTestUserSession`, direct-DB assertions for the no-write
 * arms, `binaryInitBody` for the canonical valid payload).
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
  createTestUserSession,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import { binaryInitBody } from '../../test/fixtures/attachmentInit.js';

const year = new Date().getFullYear();

/**
 * Pick a project the caller can write to. Worker1 is assigned to
 * YYYY-007; that project is reachable for the seeded `office` and
 * `owner` users too (no scope filter on attachment write for those
 * roles), so the same id works for every arm here.
 */
async function reachableProjectId(ownerToken: string): Promise<string> {
  const res = await authGet(ownerToken, '/api/projects?limit=200');
  const p = (res.json().data as { id: string; number: string }[]).find(
    (r) => r.number === `${year}-007`,
  );
  if (!p) throw new Error(`seed missing ${year}-007`);
  return p.id;
}

async function countAttachmentRows(): Promise<number> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(sql`SELECT COUNT(*)::int AS c FROM attachments`);
    return (res.rows[0] as { c: number }).c;
  } finally {
    await pool.end();
  }
}

/**
 * Read the row produced by an init call straight from the DB. The
 * route response carries its own view of the row; the AC asserts
 * against the persisted state, so direct-DB read is the load-bearing
 * source of truth.
 */
async function fetchRow(id: string): Promise<{
  id: string;
  createdBy: string | null;
  createdAt: string;
} | null> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(
      sql`SELECT id, created_by, created_at FROM attachments WHERE id = ${id} LIMIT 1`,
    );
    const row = res.rows[0] as
      { id: string; created_by: string | null; created_at: Date } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      createdBy: row.created_by,
      createdAt:
        row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    };
  } finally {
    await pool.end();
  }
}

/**
 * Assemble the `restore` block. Defaults are valid — the caller
 * overrides one field at a time to exercise each bad-input branch.
 */
function restoreBlock(overrides: { id?: string; createdBy?: string; createdAt?: string }): {
  id: string;
  createdBy: string;
  createdAt: string;
} {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    createdBy: overrides.createdBy ?? '00000000-0000-4000-8000-000000000000',
    createdAt: overrides.createdAt ?? '2025-06-15T12:34:56.789Z',
  };
}

describe('Attachment init — `restore` block (issue #163)', () => {
  let ownerToken: string;
  let officeToken: string;
  /** Synthetic user holding `data:restore` ONLY — no role does in production. */
  let restoreOnlyToken: string;
  /** Owner's user id — re-used as a valid `restore.createdBy` reference. */
  let ownerUserId: string;
  let projectId: string;

  beforeAll(async () => {
    await startApp();
    [ownerToken, officeToken] = await Promise.all([
      login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD),
    ]);

    // The production role matrix in `src/config/permissions.ts` does
    // NOT mint a role that holds `data:restore` without
    // `attachment:write` — the AC explicitly calls this synthetic. The
    // permission registry carries a test-only role
    // `__test_data_restore_only` that grants ONLY `data:restore`; the
    // role is listed in `ROLE_PERMISSIONS` so `hasPermission()`
    // recognises it through the same code path as production roles.
    // This is what makes the AC-255 "data:restore only → 403" arm
    // load-bearing: the 403 must fire because `attachment:write` is
    // absent on a caller who DOES hold `data:restore`. A vacuous
    // version (empty role array) would also produce 403, but for the
    // wrong reason (it would prove the attachment:write gate alone,
    // not the AND gate).
    const restoreOnly = await createTestUserSession({ roles: ['__test_data_restore_only'] });
    restoreOnlyToken = restoreOnly.token;

    const me = await authGet(ownerToken, '/api/auth/me');
    ownerUserId = me.json().user.id as string;

    projectId = await reachableProjectId(ownerToken);
  });

  afterAll(async () => {
    await stopApp();
  });

  // -----------------------------------------------------------------
  // AC-255 — permission gate. Both `data:restore` AND `attachment:write`
  // are required when the body carries a `restore` block; missing either
  // is a 403, with no row persisted.
  // -----------------------------------------------------------------
  describe('AC-255: permission gate on init with `restore` block', () => {
    function bodyWithRestore(): Record<string, unknown> {
      return {
        ...binaryInitBody({ fileName: 'gate.pdf', sizeBytes: 100, label: 'sonstiges' }),
        restore: restoreBlock({ createdBy: ownerUserId }),
      };
    }

    it('attachment:write only (office, lacks data:restore) → 403 NOT_PERMITTED, no row', async () => {
      const before = await countAttachmentRows();
      const res = await authPost(
        officeToken,
        `/api/projects/${projectId}/attachments/init`,
        bodyWithRestore(),
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
      expect(await countAttachmentRows()).toBe(before);
    });

    it('data:restore only (no attachment:write) → 403 NOT_PERMITTED, no row', async () => {
      // Contract pinned: the AND gate honors `data:restore` AND
      // `attachment:write`. Caller holds `data:restore` (via the
      // test-only `__test_data_restore_only` role) but NOT
      // `attachment:write` — must reject with 403. A vacuous variant
      // (caller missing both) would not distinguish "AND gate honors
      // data:restore" from "AND gate broken but caller lacks
      // attachment:write anyway"; that's the trap the role plumbing
      // above defuses.
      //
      // Pre-condition guard: prove the synthetic caller genuinely
      // carries `data:restore`. If a future refactor renames or drops
      // the test-only role, the guard fails loudly here instead of
      // silently rendering the AC-255 arm vacuous again.
      const meRes = await authGet(restoreOnlyToken, '/api/auth/me');
      expect(meRes.statusCode).toBe(200);
      const me = meRes.json().user as { roles: string[] };
      expect(me.roles).toContain('__test_data_restore_only');
      // And confirm the registry resolution: the role grants
      // `data:restore` (looked up the same way the route gate does).
      const { hasPermission } = await import('../../config/permissions.js');
      expect(hasPermission(me.roles, 'data:restore')).toBe(true);
      expect(hasPermission(me.roles, 'attachment:write')).toBe(false);

      const before = await countAttachmentRows();
      const res = await authPost(
        restoreOnlyToken,
        `/api/projects/${projectId}/attachments/init`,
        bodyWithRestore(),
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
      expect(await countAttachmentRows()).toBe(before);
    });

    it('owner (holds both data:restore AND attachment:write) → 201, row persisted', async () => {
      // Happy-path gate check — the owner role holds both permissions
      // per src/config/permissions.ts. The init must therefore succeed
      // with the supplied identity fields landing on the row (the AC-256
      // happy path covers the row-content side; here we pin the gate).
      const body = bodyWithRestore();
      const restore = (body as { restore: { id: string } }).restore;
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, body);
      expect(res.statusCode).toBe(201);
      const persisted = await fetchRow(restore.id);
      expect(persisted).not.toBeNull();
      expect(persisted!.id).toBe(restore.id);
    });

    it('init without a `restore` block is unaffected by the AC-255 gate (regression)', async () => {
      // The standard upload path — no `restore` key — does not require
      // `data:restore`. Office (which lacks `data:restore`) drives a
      // valid binary init; result is a 201 with a server-generated id.
      const body = binaryInitBody({ fileName: 'standard.pdf', sizeBytes: 100, label: 'sonstiges' });
      const res = await authPost(officeToken, `/api/projects/${projectId}/attachments/init`, body);
      expect(res.statusCode).toBe(201);
      const id = res.json().attachment.id as string;
      const row = await fetchRow(id);
      expect(row).not.toBeNull();
      // Server-generated id — UUID-shape sanity is enough; the AC-258
      // happy path does the deeper assertion on the standard path.
      expect(row!.id).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  // -----------------------------------------------------------------
  // AC-256 — happy path. With both permissions and a valid `restore`
  // block, the supplied id / createdBy / createdAt land on the row
  // verbatim. Other init-time checks still run (MIME, size, etc.) —
  // the `restore` block is NOT a bypass.
  // -----------------------------------------------------------------
  describe('AC-256: happy path — restore block pins id/createdBy/createdAt', () => {
    it('persists the supplied id / createdBy / createdAt verbatim on the row', async () => {
      const restore = restoreBlock({
        id: '11111111-2222-4333-8444-555555555555',
        createdBy: ownerUserId,
        createdAt: '2024-03-14T15:09:26.535Z',
      });
      const body = {
        ...binaryInitBody({ fileName: 'restore.pdf', sizeBytes: 200, label: 'sonstiges' }),
        restore,
      };
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, body);
      expect(res.statusCode).toBe(201);

      // Direct-DB read pins the persisted state. The route response
      // may shape `createdBy` as `{ id, displayName }` (existing
      // expansion); the AC pins the row's stored `created_by` UUID.
      const row = await fetchRow(restore.id);
      expect(row).not.toBeNull();
      expect(row!.id).toBe(restore.id);
      expect(row!.createdBy).toBe(restore.createdBy);
      // `created_at` round-trips through PG as a Date; compare ISO
      // strings to defuse precision drift between drivers.
      expect(new Date(row!.createdAt).toISOString()).toBe(
        new Date(restore.createdAt).toISOString(),
      );
    });

    it('init-time checks still run — MIME outside the whitelist rejects with 422 even under the restore block', async () => {
      // The restore block does NOT bypass MIME validation. A non-
      // whitelisted MIME must still produce 422 with no row.
      const before = await countAttachmentRows();
      const restore = restoreBlock({ createdBy: ownerUserId });
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        ...binaryInitBody({
          fileName: 'evil.exe',
          mimeType: 'application/x-msdownload',
          sizeBytes: 100,
          label: 'sonstiges',
        }),
        restore,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(await countAttachmentRows()).toBe(before);
    });

    it('init-time checks still run — sizeBytes over the per-file cap rejects with 422 even under the restore block', async () => {
      const before = await countAttachmentRows();
      const restore = restoreBlock({ createdBy: ownerUserId });
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        ...binaryInitBody({
          fileName: 'huge.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 10 * 1024 * 1024,
          label: 'sonstiges',
        }),
        restore,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(await countAttachmentRows()).toBe(before);
    });
  });

  // -----------------------------------------------------------------
  // AC-257 — bad-input branches on the `restore` block. Each rejects
  // with 422 VALIDATION_ERROR (or 409 CONFLICT for the id-collision
  // branch); no row persists on any branch.
  // -----------------------------------------------------------------
  describe('AC-257: bad-input branches on the restore block', () => {
    it('rejects malformed `restore.id` (not a UUID) with 422 VALIDATION_ERROR (no row)', async () => {
      const before = await countAttachmentRows();
      const restore = {
        id: 'not-a-uuid',
        createdBy: ownerUserId,
        createdAt: '2025-01-01T00:00:00.000Z',
      };
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        ...binaryInitBody({ fileName: 'bad-uuid.pdf', sizeBytes: 100, label: 'sonstiges' }),
        restore,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(await countAttachmentRows()).toBe(before);
    });

    it('rejects `restore.createdBy` referencing an absent user with 422 VALIDATION_ERROR (no row)', async () => {
      const before = await countAttachmentRows();
      // Valid UUID syntax but no matching row in `users`. The AC names
      // this branch explicitly — the validator must look up the user
      // and refuse if absent (load-bearing for the takeout-restore
      // round trip; a stale `createdBy` would foreign-key-fail at the
      // INSERT and surface as a generic 500 otherwise).
      const restore = restoreBlock({
        createdBy: '99999999-9999-4999-8999-999999999999',
      });
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        ...binaryInitBody({ fileName: 'ghost.pdf', sizeBytes: 100, label: 'sonstiges' }),
        restore,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(await countAttachmentRows()).toBe(before);
    });

    it('rejects `restore.createdAt` not parseable as ISO 8601 with 422 VALIDATION_ERROR (no row)', async () => {
      const before = await countAttachmentRows();
      const restore = restoreBlock({
        createdBy: ownerUserId,
        createdAt: 'definitely-not-a-timestamp',
      });
      const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
        ...binaryInitBody({ fileName: 'bad-ts.pdf', sizeBytes: 100, label: 'sonstiges' }),
        restore,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(await countAttachmentRows()).toBe(before);
    });

    it('rejects `restore.id` colliding with an existing attachment row with 409 CONFLICT (no second row)', async () => {
      // First call lands a row. Second call with the same `restore.id`
      // collides — under takeout-zip restore mechanics (AC-254 leaves
      // the table empty), this indicates a client-orchestrator logic
      // error, not a recoverable race. The AC pins 409 CONFLICT.
      const restore = restoreBlock({
        id: 'cccccccc-0000-4000-8000-cccccccccccc',
        createdBy: ownerUserId,
      });
      const firstBody = {
        ...binaryInitBody({ fileName: 'first.pdf', sizeBytes: 100, label: 'sonstiges' }),
        restore,
      };
      const first = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        firstBody,
      );
      expect(first.statusCode).toBe(201);

      const before = await countAttachmentRows();
      const secondBody = {
        ...binaryInitBody({ fileName: 'second.pdf', sizeBytes: 100, label: 'sonstiges' }),
        restore,
      };
      const second = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/init`,
        secondBody,
      );
      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe('CONFLICT');
      // Exactly one row now exists for the colliding id, not two.
      expect(await countAttachmentRows()).toBe(before);
    });
  });

  // -----------------------------------------------------------------
  // AC-258 — regression. The standard upload path (no `restore` block)
  // is unchanged: server-generated id, session-derived createdBy,
  // server-clock createdAt. Office (which holds `attachment:write` but
  // NOT `data:restore`) drives this arm.
  // -----------------------------------------------------------------
  describe('AC-258: standard init without restore block — regression', () => {
    it('office without data:restore drives the standard path; row carries server-generated identity fields', async () => {
      const body = binaryInitBody({
        fileName: 'standard-office.pdf',
        sizeBytes: 100,
        label: 'sonstiges',
      });
      const beforeCall = new Date();
      const res = await authPost(officeToken, `/api/projects/${projectId}/attachments/init`, body);
      const afterCall = new Date();
      expect(res.statusCode).toBe(201);

      const id = res.json().attachment.id as string;
      // Server-generated id — UUIDv4 shape per existing init contract.
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      const row = await fetchRow(id);
      expect(row).not.toBeNull();

      // Session-derived createdBy — match the calling user's id, not
      // a client-supplied value (no `restore` block was sent).
      const me = await authGet(officeToken, '/api/auth/me');
      const officeUserId = me.json().user.id as string;
      expect(row!.createdBy).toBe(officeUserId);

      // Server-clock createdAt — falls inside the (beforeCall, afterCall]
      // window. The AC names "server-clock"; the bracket is the
      // load-bearing assertion (a regression that pinned a stale value
      // would land outside the window).
      const persistedAt = new Date(row!.createdAt).getTime();
      expect(persistedAt).toBeGreaterThanOrEqual(beforeCall.getTime() - 1_000);
      expect(persistedAt).toBeLessThanOrEqual(afterCall.getTime() + 1_000);
    });
  });
});
