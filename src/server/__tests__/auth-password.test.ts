/**
 * API integration tests: Password change operations.
 *
 * Runs against a real test database via Fastify inject (no network).
 *
 * Separated from auth.test.ts because AC-28 deactivates the office user,
 * and AC-52 needs that same user active. Each test file gets a fresh seed
 * via startApp(), so isolation requires a separate file.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { startApp, stopApp, getApp, login, authPost } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { validateEnvRuntime } from '../config/env.js';

/**
 * Read a single users row directly from the database via a one-shot
 * pg.Client. Used by AC-52 to pin the audit columns written by
 * changePassword — see `docs/spec/data-model.md §5.5`.
 *
 * A one-shot Client (not a long-lived Pool) is deliberate: holding a
 * Pool across the full `describe` block produced intermittent state
 * pollution when this file runs back-to-back with auth.test.ts. The
 * client is opened at assertion time, used for exactly one SELECT, and
 * closed before the test returns.
 */
async function readUserAuditRowByUsername(username: string): Promise<{
  id: string;
  passwordHash: string;
  updatedBy: string | null;
  updatedAt: Date;
}> {
  const env = validateEnvRuntime();
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    const res = await client.query<{
      id: string;
      password_hash: string;
      updated_by: string | null;
      updated_at: Date;
    }>('SELECT id, password_hash, updated_by, updated_at FROM users WHERE username = $1', [
      username,
    ]);
    if (res.rows.length === 0) {
      throw new Error(`No user row for username ${username}`);
    }
    const row = res.rows[0]!;
    return {
      id: row.id,
      passwordHash: row.password_hash,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    };
  } finally {
    await client.end();
  }
}

/**
 * Re-read the same user's audit row by id. Split from the by-username
 * helper so the post-change assertion does not have to trust that the
 * username is still resolvable (e.g. if a future test path renames).
 */
async function readUserAuditRowById(id: string): Promise<{
  passwordHash: string;
  updatedBy: string | null;
  updatedAt: Date;
}> {
  const env = validateEnvRuntime();
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    const res = await client.query<{
      password_hash: string;
      updated_by: string | null;
      updated_at: Date;
    }>('SELECT password_hash, updated_by, updated_at FROM users WHERE id = $1', [id]);
    if (res.rows.length === 0) {
      throw new Error(`No user row for id ${id}`);
    }
    const row = res.rows[0]!;
    return {
      passwordHash: row.password_hash,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    };
  } finally {
    await client.end();
  }
}

describe('Password Change Operations', () => {
  beforeAll(async () => {
    await startApp();
  });

  afterAll(async () => {
    await stopApp();
  });

  // ---------------------------------------------------------------
  // AC-52: Change own password with correct current password succeeds
  // AC-52 [crit]
  // ---------------------------------------------------------------
  describe('AC-52: Change own password (success)', () => {
    it('changes password and allows login with the new one', async () => {
      // Self-contained: login, change, verify new password — all in one test.
      // Uses the office user to avoid affecting other tests that log in as owner.
      // The rotated password is a throwaway literal — it's the NEW value, not
      // a seed reference, so it stays hardcoded here.
      const officeToken = await login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD);

      // Snapshot the user row before the change so the assertion below
      // can prove both the pre-change password hash actually moved AND
      // that updatedAt advanced (not just a no-op update with a stale
      // timestamp). See data-model.md §5.5.
      const beforeRow = await readUserAuditRowByUsername(SEED_USERS.office.username);
      const userId = beforeRow.id;
      const beforeHash = beforeRow.passwordHash;
      const beforeUpdatedAt = beforeRow.updatedAt;

      const changeRes = await authPost(officeToken, '/api/auth/change-password', {
        currentPassword: SEED_DEFAULT_PASSWORD,
        newPassword: 'neuesPasswort123!',
      });

      expect(changeRes.statusCode).toBe(200);

      // Verify the new password works by logging in again
      const loginRes = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: SEED_USERS.office.username, password: 'neuesPasswort123!' },
      });

      expect(loginRes.statusCode).toBe(200);
      // Session token is now in the cookie, not the body
      const setCookie = loginRes.headers['set-cookie'];
      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(cookieStr).toMatch(/session=[^;]+/);

      // Pin the audit columns written by changePassword(). The repository
      // takes `actorId` as a required parameter (commit 362a565), but a
      // regression that flipped the argument order — e.g. passed the
      // row's id as the actor vs. the actor as the row id — would
      // compile cleanly. Without this read-back the only line of
      // defense is code review.
      //
      // AuthService.changePassword is currently self-service only:
      // actor == target, so the written updatedBy must equal the user's
      // own id. A future admin-reset endpoint would pass the admin's id
      // instead; when that happens, this assertion needs to be rewritten
      // *deliberately* for the new shape — which is the point.
      // See consolidation runtime-assertion task on updatedBy.
      const afterRow = await readUserAuditRowById(userId);
      // Sanity: the hash actually rotated (guards against a no-op where
      // the update fires but nothing changes).
      expect(afterRow.passwordHash).not.toBe(beforeHash);
      // Core assertion: the acting user is the target itself.
      expect(afterRow.updatedBy).toBe(userId);
      // updatedAt must advance — defense against a regression that
      // writes updatedBy but forgets to bump the timestamp.
      expect(afterRow.updatedAt.getTime()).toBeGreaterThan(beforeUpdatedAt.getTime());
    });
  });

  // ---------------------------------------------------------------
  // AC-52: Change own password with incorrect current password is rejected
  // AC-52 [crit]
  // ---------------------------------------------------------------
  describe('AC-52: Change own password (wrong current password)', () => {
    it('rejects when current password is incorrect', async () => {
      // Uses owner — completely independent of AC-52's office-user flow.
      const ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);

      const res = await authPost(ownerToken, '/api/auth/change-password', {
        currentPassword: 'definitelywrong',
        newPassword: 'newpassword123!',
      });

      // Should not succeed
      expect(res.statusCode).not.toBe(200);
      // 401 or 422 are both reasonable; the spec says "rejected"
      expect([401, 422]).toContain(res.statusCode);

      const body = res.json();
      expect(body.code).toBeDefined();
      expect(typeof body.message).toBe('string');
    });

    it('does not change the password on rejection', async () => {
      // After the failed attempt, original password should still work.
      // Logs in fresh — no dependency on any prior test state.
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: SEED_USERS.owner.username, password: SEED_DEFAULT_PASSWORD },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // ---------------------------------------------------------------
  // Password policy — shared with bootstrap via password-policy.ts
  // ---------------------------------------------------------------
  describe('Password policy enforcement on change-password', () => {
    it('rejects a blocklist entry as the new password', async () => {
      // Self-contained: uses worker1 to avoid side effects on other tests.
      const token = await login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD);
      const res = await authPost(token, '/api/auth/change-password', {
        currentPassword: SEED_DEFAULT_PASSWORD,
        newPassword: 'qwerty123',
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('rejects a new password shorter than 8 characters', async () => {
      const token = await login(SEED_USERS.worker2.username, SEED_DEFAULT_PASSWORD);
      const res = await authPost(token, '/api/auth/change-password', {
        currentPassword: SEED_DEFAULT_PASSWORD,
        newPassword: 'short1!',
      });
      // 422 from the service's checkPasswordPolicy call. Not 400 from the
      // JSON schema, because the schema's minLength is now 1 — the full
      // policy lives in the service layer so it cannot diverge from the
      // bootstrap path.
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    // Regression test for the UTF-8 byte-length bug found by the security
    // audit on issue #57. Before the fix, the change-password schema had
    // maxLength:72 (characters), and a password like '测'.repeat(25) is 25
    // characters but 75 UTF-8 bytes — it would sneak past the schema and
    // bcrypt would silently truncate to the first ~24 characters.
    it('rejects a UTF-8 password whose bytes exceed 72 despite having fewer characters', async () => {
      const token = await login(SEED_USERS.bookkeeper.username, SEED_DEFAULT_PASSWORD);
      const utf8Pw = '测'.repeat(25); // 25 chars, 75 bytes
      expect(utf8Pw.length).toBe(25);
      expect(Buffer.byteLength(utf8Pw, 'utf8')).toBe(75);

      const res = await authPost(token, '/api/auth/change-password', {
        currentPassword: SEED_DEFAULT_PASSWORD,
        newPassword: utf8Pw,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');

      // And the original password must still work — confirming no partial
      // mutation on the rejection path.
      const loginRes = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: SEED_USERS.bookkeeper.username,
          password: SEED_DEFAULT_PASSWORD,
        },
      });
      expect(loginRes.statusCode).toBe(200);
    });

    it('accepts a 72-ASCII-byte password at the boundary', async () => {
      // Counterpart to the UTF-8 test — a 72-character ASCII password is
      // exactly 72 bytes, which is the boundary value and must be allowed.
      const token = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
      const at72 = 'A'.repeat(72);
      expect(Buffer.byteLength(at72, 'utf8')).toBe(72);

      const res = await authPost(token, '/api/auth/change-password', {
        currentPassword: SEED_DEFAULT_PASSWORD,
        newPassword: at72,
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
