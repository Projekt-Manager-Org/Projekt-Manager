/**
 * API integration tests: User management operations.
 *
 * Covers user CRUD, deactivate/reactivate, password reset, permission enforcement,
 * and the themePreference default for newly-created users (AC-115).
 * Runs against a real test database via Fastify inject (no network).
 *
 * These tests are written ahead of the implementation (TDD). They define
 * the API contract for user management introduced in iteration 6.
 *
 * Route conventions (inferred from existing patterns):
 *   GET    /api/users                       → list users
 *   GET    /api/users/:id                   → get single user
 *   POST   /api/users                       → create user
 *   PATCH  /api/users/:id                   → update user
 *   POST   /api/users/:id/deactivate        → deactivate user
 *   POST   /api/users/:id/reactivate        → reactivate user
 *   POST   /api/users/:id/reset-password    → reset password (admin)
 *
 * Permission model:
 *   - user:read: owner, office
 *   - user:manage: owner only
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  startApp,
  stopApp,
  getDb,
  login,
  authGet,
  authPost,
  authPatch,
  authDelete,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';

describe('User Management Operations', () => {
  let ownerToken: string;
  let officeToken: string;
  let workerToken: string;
  let ownerId: string;

  /** ID of the user created in the AC-63 test, used by subsequent tests. */
  let createdUserId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    officeToken = await login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD);
    workerToken = await login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD);

    // Get the owner's user ID for self-deactivation test
    const meRes = await authGet(ownerToken, '/api/auth/me');
    ownerId = meRes.json().user.id;
  });

  afterAll(async () => {
    await stopApp();
  });

  // ---------------------------------------------------------------
  // List users — all (including deactivated), no passwordHash
  // ---------------------------------------------------------------
  describe('List users', () => {
    it('returns all users including deactivated ones', async () => {
      const res = await authGet(ownerToken, '/api/users');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.users).toBeDefined();
      expect(Array.isArray(body.users)).toBe(true);
      expect(body.total).toBeGreaterThanOrEqual(6); // 6 seeded users

      // The inactive user must be present
      const inactive = body.users.find(
        (u: Record<string, unknown>) => u.username === SEED_USERS.inactive.username,
      );
      expect(inactive).toBeDefined();
      expect(inactive.active).toBe(false);
    });

    it('AC-394: never includes passwordHash in response', async () => {
      const res = await authGet(ownerToken, '/api/users');
      const body = res.json();

      for (const user of body.users) {
        expect(user).not.toHaveProperty('passwordHash');
      }
    });

    it('office can list users (has user:read)', async () => {
      const res = await authGet(officeToken, '/api/users');

      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json().users)).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // AC-63: Create user → can log in
  // ---------------------------------------------------------------
  describe('AC-63: Create user', () => {
    it('creates a user that can immediately log in', async () => {
      const res = await authPost(ownerToken, '/api/users', {
        username: 'testuser_at28',
        displayName: 'Test Benutzer',
        password: 'SecurePass123!',
        roles: ['worker'],
      });

      expect(res.statusCode).toBe(201);

      const user = res.json();
      expect(user.id).toBeDefined();
      expect(user.username).toBe('testuser_at28');
      expect(user.displayName).toBe('Test Benutzer');
      expect(user.roles).toEqual(['worker']);
      expect(user.active).toBe(true);
      expect(user).not.toHaveProperty('passwordHash');

      createdUserId = user.id;

      // Verify the new user can log in
      const loginToken = await login('testuser_at28', 'SecurePass123!');
      expect(loginToken).toBeDefined();
      expect(typeof loginToken).toBe('string');
      expect(loginToken.length).toBeGreaterThan(0);
    });

    it('accepts optional email field', async () => {
      const res = await authPost(ownerToken, '/api/users', {
        username: 'testuser_email',
        displayName: 'E-Mail Test',
        password: 'SecurePass456!',
        roles: ['worker'],
        email: 'test@example.de',
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().email).toBe('test@example.de');
    });
  });

  describe('AC-550: Password policy on create', () => {
    it('refuses a too-short password and creates nothing', async () => {
      const username = 'policy_refused_user';
      const res = await authPost(ownerToken, '/api/users', {
        username,
        displayName: 'Policy Refused',
        password: 'kurz',
        roles: ['worker'],
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      const list = await authGet(ownerToken, '/api/users');
      const usernames = list.json().users.map((u: { username: string }) => u.username);
      expect(usernames).not.toContain(username);
    });
  });

  // ---------------------------------------------------------------
  // AC-115: Newly created user defaults themePreference to 'system'
  // AC-115 [crit] (data-model.md §5.7, verification.md §15.21)
  //
  // The admin create-user payload does not expose themePreference —
  // only the user themselves controls their preference via the
  // self-update operation (data-model.md §5.3). A brand-new account must
  // therefore land on the documented default 'system', both in the
  // create response and in the subsequent GET /api/users/:id fetch
  // (which pins that the default was actually persisted, not just
  // filled in by the response serializer).
  // ---------------------------------------------------------------
  describe('AC-115: New user defaults themePreference to system', () => {
    it("returns themePreference='system' on create and on GET", async () => {
      const createRes = await authPost(ownerToken, '/api/users', {
        username: 'testuser_at56',
        displayName: 'Theme Default Test',
        password: 'ThemePass123!',
        roles: ['worker'],
      });

      expect(createRes.statusCode).toBe(201);

      const created = createRes.json();
      // The create response is the serialized UserProfile — it MUST
      // carry the themePreference field and MUST default to 'system'
      // when the caller omitted it. A response that silently drops
      // the field, or defaults to 'light'/'dark', would let a client
      // render a mismatched theme on first login.
      expect(created.themePreference).toBe('system');

      // Fetch the row back — proves the DB row was written with
      // 'system', not just that the response object was patched in
      // memory. A regression that forgot to persist the default
      // fails here even if the create response is patched.
      const getRes = await authGet(ownerToken, `/api/users/${created.id}`);
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().themePreference).toBe('system');
    });
  });

  // ---------------------------------------------------------------
  // Duplicate username → validation error
  // ---------------------------------------------------------------
  describe('AC-564: Duplicate username', () => {
    it('rejects creation with an already-used username', async () => {
      const res = await authPost(ownerToken, '/api/users', {
        username: 'testuser_at28', // Created in AC-63
        displayName: 'Duplicate Name',
        password: 'AnotherPass789!',
        roles: ['worker'],
      });

      expect(res.statusCode).toBe(409);
      const list = await authGet(ownerToken, '/api/users');
      const names = list.json().users.map((u: { displayName: string }) => u.displayName);
      expect(names).not.toContain('Duplicate Name');

      const body = res.json();
      expect(body.code).toBe('CONFLICT');
      expect(typeof body.message).toBe('string');
    });
  });

  // ---------------------------------------------------------------
  // AC-565: blank, length and role-set constraints (data-model.md §5.3)
  // ---------------------------------------------------------------
  describe('AC-565: User field constraints', () => {
    const tooLong = 'x'.repeat(256);
    const valid = {
      displayName: 'Feldprüfung',
      password: 'FieldCheck123!',
      roles: ['worker'],
    };

    async function listUsernames(): Promise<string[]> {
      const list = await authGet(ownerToken, '/api/users?limit=200');
      return list.json().users.map((u: { username: string }) => u.username);
    }

    it.each([
      ['a whitespace-only username', { username: '   ' }],
      ['a whitespace-only display name', { displayName: '   ' }],
      ['a username over 255 characters', { username: tooLong }],
      ['a display name over 255 characters', { displayName: tooLong }],
      ['an email over 255 characters', { email: `${'x'.repeat(245)}@example.de` }],
      ['no role', { roles: [] }],
      ['a repeated role', { roles: ['worker', 'worker'] }],
    ])('refuses a create with %s and creates nothing', async (label, override) => {
      const before = await listUsernames();
      // A username per case, so an earlier wrongly accepted case cannot turn this one into a 409.
      const username = `ac565_${label.replaceAll(' ', '_')}`.slice(0, 255);
      const res = await authPost(ownerToken, '/api/users', { ...valid, username, ...override });

      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(await listUsernames()).toEqual(before);
    });

    it('accepts username, display name and email of exactly 255 characters', async () => {
      const res = await authPost(ownerToken, '/api/users', {
        ...valid,
        username: 'u'.repeat(255),
        displayName: 'd'.repeat(255),
        email: `${'e'.repeat(244)}@example.de`,
      });

      expect(res.statusCode).toBe(201);
    });

    it.each([
      ['a whitespace-only display name', { displayName: '   ' }],
      ['a display name over 255 characters', { displayName: tooLong }],
      ['an email over 255 characters', { email: `${'x'.repeat(245)}@example.de` }],
      ['no role', { roles: [] }],
      ['a repeated role', { roles: ['worker', 'worker'] }],
    ])('refuses an edit with %s and changes nothing', async (_label, override) => {
      const before = (await authGet(ownerToken, `/api/users/${createdUserId}`)).json();
      const res = await authPatch(ownerToken, `/api/users/${createdUserId}`, override);

      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      const after = (await authGet(ownerToken, `/api/users/${createdUserId}`)).json();
      expect(after).toEqual(before);
    });
  });

  // ---------------------------------------------------------------
  // AC-553: Update user — displayName, roles; username immutable
  // AC-553 [crit]
  // ---------------------------------------------------------------
  describe('AC-553: Update user', () => {
    it('changes display name and roles', async () => {
      const res = await authPatch(ownerToken, `/api/users/${createdUserId}`, {
        displayName: 'Aktualisierter Name',
        roles: ['office'],
      });

      expect(res.statusCode).toBe(200);

      const user = res.json();
      expect(user.displayName).toBe('Aktualisierter Name');
      expect(user.roles).toEqual(['office']);
    });

    it('updates email', async () => {
      const res = await authPatch(ownerToken, `/api/users/${createdUserId}`, {
        email: 'updated@example.de',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().email).toBe('updated@example.de');
    });

    it('refuses a username change (immutable, AC-516)', async () => {
      const res = await authPatch(ownerToken, `/api/users/${createdUserId}`, {
        username: 'newusername',
      });

      expect(res.statusCode).toBe(422);
      const getRes = await authGet(ownerToken, `/api/users/${createdUserId}`);
      expect(getRes.json().username).toBe('testuser_at28');
    });
  });

  // ---------------------------------------------------------------
  // AC-555: Deactivate user → active=false, sessions invalidated
  // ---------------------------------------------------------------
  describe('AC-555: Deactivate user', () => {
    let deactivateTargetSecondToken: string;
    /** A user created specifically for deactivation testing. */
    let deactivateTargetId: string;
    let deactivateTargetToken: string;

    beforeAll(async () => {
      // Create a fresh user for this test to avoid interference
      const createRes = await authPost(ownerToken, '/api/users', {
        username: 'testuser_deactivate',
        displayName: 'Deactivation Target',
        password: 'DeactPass123!',
        roles: ['worker'],
      });
      deactivateTargetId = createRes.json().id;

      // Log the user in to create a session
      deactivateTargetToken = await login('testuser_deactivate', 'DeactPass123!');
      deactivateTargetSecondToken = await login('testuser_deactivate', 'DeactPass123!');
    });

    it('sets active to false', async () => {
      const res = await authPost(ownerToken, `/api/users/${deactivateTargetId}/deactivate`);

      expect(res.statusCode).toBe(200);

      const user = res.json();
      expect(user.active).toBe(false);
    });

    it('AC-570: invalidates all sessions — previously valid tokens are rejected', async () => {
      const second = await authGet(deactivateTargetSecondToken, '/api/auth/me');
      expect(second.statusCode).toBe(401);

      const res = await authGet(deactivateTargetToken, '/api/auth/me');

      expect(res.statusCode).toBe(401);
    });

    it('prevents login', async () => {
      const { getApp } = await import('../../test/api-helpers.js');
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'testuser_deactivate', password: 'DeactPass123!' },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ---------------------------------------------------------------
  // AC-66: Reactivate user → active=true, can log in
  // ---------------------------------------------------------------
  describe('AC-66: Reactivate user', () => {
    /** A user created, deactivated, then reactivated in this block. */
    let reactivateTargetId: string;

    beforeAll(async () => {
      // Create and deactivate a user
      const createRes = await authPost(ownerToken, '/api/users', {
        username: 'testuser_reactivate',
        displayName: 'Reactivation Target',
        password: 'ReactPass123!',
        roles: ['worker'],
      });
      reactivateTargetId = createRes.json().id;

      await authPost(ownerToken, `/api/users/${reactivateTargetId}/deactivate`);
    });

    it('sets active to true', async () => {
      const res = await authPost(ownerToken, `/api/users/${reactivateTargetId}/reactivate`);

      expect(res.statusCode).toBe(200);

      const user = res.json();
      expect(user.active).toBe(true);
    });

    it('allows the user to log in again', async () => {
      const token = await login('testuser_reactivate', 'ReactPass123!');
      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
    });
  });

  // ---------------------------------------------------------------
  // AC-556: Reset password → AC-557 sessions invalidated
  // AC-556 [crit]
  // ---------------------------------------------------------------
  describe('AC-556: Reset password', () => {
    let resetTargetId: string;
    let resetTargetToken: string;
    let resetTargetSecondToken: string;

    beforeAll(async () => {
      const createRes = await authPost(ownerToken, '/api/users', {
        username: 'testuser_reset',
        displayName: 'Password Reset Target',
        password: 'OldPass123!',
        roles: ['worker'],
      });
      resetTargetId = createRes.json().id;

      resetTargetToken = await login('testuser_reset', 'OldPass123!');
      resetTargetSecondToken = await login('testuser_reset', 'OldPass123!');
    });

    it('resets the password — admin does not need current password', async () => {
      const res = await authPost(ownerToken, `/api/users/${resetTargetId}/reset-password`, {
        newPassword: 'NewSecurePass456!',
      });

      expect(res.statusCode).toBe(200);
    });

    it('AC-557: invalidates all sessions for the target user', async () => {
      expect((await authGet(resetTargetSecondToken, '/api/auth/me')).statusCode).toBe(401);
      const res = await authGet(resetTargetToken, '/api/auth/me');

      expect(res.statusCode).toBe(401);
    });

    it('user can log in with the new password', async () => {
      const token = await login('testuser_reset', 'NewSecurePass456!');
      expect(token).toBeDefined();
    });

    it('user cannot log in with the old password', async () => {
      const { getApp } = await import('../../test/api-helpers.js');
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'testuser_reset', password: 'OldPass123!' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('AC-550: rejects a new password that violates password policy', async () => {
      const res = await authPost(ownerToken, `/api/users/${resetTargetId}/reset-password`, {
        newPassword: 'short', // Below minimum length (8 chars)
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      // Nothing stored: the password set by the earlier test still logs in.
      await expect(login('testuser_reset', 'NewSecurePass456!')).resolves.toBeTruthy();
    });
  });

  describe('Delete user', () => {
    it('AC-558: refuses deleting the own account and changes nothing', async () => {
      const res = await authDelete(ownerToken, `/api/users/${ownerId}`);

      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect((await authGet(ownerToken, `/api/users/${ownerId}`)).statusCode).toBe(200);
    });

    it('AC-559: removes the account with its sessions and worker assignments', async () => {
      const username = 'delete_cascade_user';
      const password = 'TestPass123!';
      const created = await authPost(ownerToken, '/api/users', {
        username,
        displayName: 'Delete Cascade',
        password,
        roles: ['worker'],
      });
      expect(created.statusCode).toBe(201);
      const userId = created.json().id as string;
      const token = await login(username, password);
      const project = await getDb().execute(sql`SELECT id FROM projects LIMIT 1`);
      const projectId = (project.rows[0] as { id: string }).id;
      await getDb().execute(
        sql`INSERT INTO project_workers (project_id, user_id) VALUES (${projectId}, ${userId})`,
      );

      expect((await authDelete(ownerToken, `/api/users/${userId}`)).statusCode).toBe(204);

      expect((await authGet(ownerToken, `/api/users/${userId}`)).statusCode).toBe(404);
      expect((await authGet(token, '/api/auth/me')).statusCode).toBe(401);
      const sessions = await getDb().execute(sql`SELECT 1 FROM sessions WHERE user_id = ${userId}`);
      expect(sessions.rows).toHaveLength(0);
      const assignments = await getDb().execute(
        sql`SELECT 1 FROM project_workers WHERE user_id = ${userId}`,
      );
      expect(assignments.rows).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------
  // AC-68: Self-deactivation rejected
  // AC-68 [crit]
  // ---------------------------------------------------------------
  describe('AC-68: Self-deactivation', () => {
    it('rejects when owner tries to deactivate themselves', async () => {
      const res = await authPost(ownerToken, `/api/users/${ownerId}/deactivate`);

      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');

      const body = res.json();
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    });

    it('owner account remains active after rejection', async () => {
      // Verify the session still works — the owner was NOT deactivated
      const meRes = await authGet(ownerToken, '/api/auth/me');
      expect(meRes.statusCode).toBe(200);
      expect(meRes.json().user.username).toBe(SEED_USERS.owner.username);
    });
  });

  // A second owner acts on itself, so a failing guard cannot strip the
  // seeded owner the other tests log in as.
  describe('AC-575: Own roles keep user:manage', () => {
    let selfToken: string;
    let selfId: string;

    beforeAll(async () => {
      const res = await authPost(ownerToken, '/api/users', {
        username: 'ac575_owner',
        displayName: 'Zweiter Inhaber',
        password: 'SecondOwner123!',
        roles: ['owner'],
      });
      selfId = res.json().id;
      selfToken = await login('ac575_owner', 'SecondOwner123!');
    });

    it('refuses dropping the own owner role and changes nothing', async () => {
      const res = await authPatch(selfToken, `/api/users/${selfId}`, {
        displayName: 'Nur noch Büro',
        roles: ['office'],
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      const after = (await authGet(ownerToken, `/api/users/${selfId}`)).json();
      expect(after.roles).toEqual(['owner']);
      expect(after.displayName).toBe('Zweiter Inhaber');
    });

    it('refuses it when the own id is sent in upper case', async () => {
      const res = await authPatch(selfToken, `/api/users/${selfId.toUpperCase()}`, {
        roles: ['office'],
      });

      expect(res.statusCode).toBe(422);
      const after = (await authGet(ownerToken, `/api/users/${selfId}`)).json();
      expect(after.roles).toEqual(['owner']);
    });

    it('accepts an own role edit that keeps the owner role', async () => {
      const res = await authPatch(selfToken, `/api/users/${selfId}`, {
        roles: ['owner', 'office'],
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().roles).toEqual(['owner', 'office']);
    });

    it("accepts dropping another owner's owner role", async () => {
      const res = await authPatch(ownerToken, `/api/users/${selfId}`, { roles: ['office'] });

      expect(res.statusCode).toBe(200);
      expect(res.json().roles).toEqual(['office']);
    });
  });

  // The path id may differ in case and still match the own row. Each test
  // acts as its own fresh owner, so a failing guard cannot remove the
  // seeded owner the other tests log in as.
  describe('Own id in upper case', () => {
    async function freshOwner(username: string): Promise<{ id: string; token: string }> {
      const res = await authPost(ownerToken, '/api/users', {
        username,
        displayName: username,
        password: 'FreshOwner123!',
        roles: ['owner'],
      });
      return { id: res.json().id, token: await login(username, 'FreshOwner123!') };
    }

    it('AC-68: refuses the self-deactivation and changes nothing', async () => {
      const self = await freshOwner('upper_deactivate');
      const res = await authPost(self.token, `/api/users/${self.id.toUpperCase()}/deactivate`);

      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect((await authGet(ownerToken, `/api/users/${self.id}`)).json().active).toBe(true);
      expect((await authGet(self.token, '/api/auth/me')).statusCode).toBe(200);
    });

    it('AC-558: refuses the self-delete and changes nothing', async () => {
      const self = await freshOwner('upper_delete');
      const res = await authDelete(self.token, `/api/users/${self.id.toUpperCase()}`);

      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect((await authGet(ownerToken, `/api/users/${self.id}`)).statusCode).toBe(200);
    });
  });

  // ---------------------------------------------------------------
  // AC-69: Permission enforcement — only user:manage can manage
  // AC-69 [crit]
  // ---------------------------------------------------------------
  describe('AC-69: Permission enforcement', () => {
    it('office cannot create users (has user:read, lacks user:manage)', async () => {
      const res = await authPost(officeToken, '/api/users', {
        username: 'office_cannot_create',
        displayName: 'Should Fail',
        password: 'Password123!',
        roles: ['worker'],
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('office cannot update users', async () => {
      const res = await authPatch(officeToken, `/api/users/${createdUserId}`, {
        displayName: 'Office Cannot Update',
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('office cannot deactivate users', async () => {
      const res = await authPost(officeToken, `/api/users/${createdUserId}/deactivate`);

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('office cannot reset passwords', async () => {
      const res = await authPost(officeToken, `/api/users/${createdUserId}/reset-password`, {
        newPassword: 'OfficeCantReset!',
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('worker cannot list users (lacks user:read)', async () => {
      const res = await authGet(workerToken, '/api/users');

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('worker cannot create users', async () => {
      const res = await authPost(workerToken, '/api/users', {
        username: 'worker_cannot_create',
        displayName: 'Should Fail',
        password: 'Password123!',
        roles: ['worker'],
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });
  });
});
