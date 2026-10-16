/**
 * API integration tests: Role-based permission enforcement.
 *
 * Verifies that the permission middleware correctly blocks or allows
 * operations based on user roles:
 *   - worker / bookkeeper: can read, cannot transition or update dates
 *   - owner / office: can read, transition, and update dates
 *
 * Seed users referenced via SEED_USERS from `../../test/seedAssumptions.js`
 * (see that file for the single source of truth on usernames / passwords).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startApp,
  stopApp,
  login,
  authGet,
  authPost,
  authPatch,
  createTestUserSession,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';

/** Helper: find the first project in a given status from the list endpoint. */
async function findProjectByStatus(
  token: string,
  status: string,
): Promise<Record<string, unknown>> {
  const res = await authGet(token, '/api/projects');
  const projects = res.json().data as Record<string, unknown>[];
  const match = projects.find((p) => p.status === status);
  if (!match) throw new Error(`No project with status "${status}" in seed data`);
  return match;
}

describe('Role-based Permission Enforcement', () => {
  let workerToken: string;
  let bookkeeperToken: string;
  let ownerToken: string;
  let officeToken: string;

  beforeAll(async () => {
    await startApp();
    [workerToken, bookkeeperToken, ownerToken, officeToken] = await Promise.all([
      login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.bookkeeper.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD),
    ]);
  });

  afterAll(async () => {
    await stopApp();
  });

  // ---------------------------------------------------------------
  // Restricted roles — worker (SEED_USERS.worker1) and bookkeeper
  // (SEED_USERS.bookkeeper) share the same permission model (read-only:
  // cannot transition or update dates). Parametrized so adding/removing
  // a restricted role is a one-line change and assertions never drift
  // between the two roles.
  //
  // Tokens are looked up by role name inside each test because `it.each`
  // evaluates its table at describe-collection time, before `beforeAll`
  // has assigned the module-scoped token variables.
  // ---------------------------------------------------------------
  describe('Restricted roles (read-only)', () => {
    type RestrictedRole = 'worker' | 'bookkeeper';
    const restrictedRoles: RestrictedRole[] = ['worker', 'bookkeeper'];
    const tokenFor = (role: RestrictedRole): string =>
      role === 'worker' ? workerToken : bookkeeperToken;

    // Project *discovery* uses the owner token — the unscoped view covers
    // every status deterministically, so the test does not accidentally
    // conflate "role can't mutate" with "role can't even see the row".
    // The restricted role's token is only used for the mutation under
    // assertion. Without this split the worker case would pass by seed
    // coincidence (arbeiter1 happens to be assigned to geplant/in_arbeit
    // projects); bookkeeper would fail if workers' seed coverage shrank.
    it.each(restrictedRoles)(
      '%s cannot transition forward — returns 403 NOT_PERMITTED',
      async (role) => {
        const project = await findProjectByStatus(ownerToken, 'geplant');

        const res = await authPost(
          tokenFor(role),
          `/api/projects/${project.id}/transition/forward`,
          { expectedStatus: 'geplant' },
        );

        expect(res.statusCode).toBe(403);

        const body = res.json();
        expect(body.code).toBe('NOT_PERMITTED');
        expect(typeof body.message).toBe('string');
        expect(body.message.length).toBeGreaterThan(0);
      },
    );

    it.each(restrictedRoles)(
      '%s cannot transition backward — returns 403 NOT_PERMITTED',
      async (role) => {
        const project = await findProjectByStatus(ownerToken, 'in_arbeit');

        const res = await authPost(
          tokenFor(role),
          `/api/projects/${project.id}/transition/backward`,
          { expectedStatus: 'in_arbeit' },
        );

        expect(res.statusCode).toBe(403);

        const body = res.json();
        expect(body.code).toBe('NOT_PERMITTED');
        expect(typeof body.message).toBe('string');
        expect(body.message.length).toBeGreaterThan(0);
      },
    );

    it.each(restrictedRoles)('%s cannot update dates — returns 403 NOT_PERMITTED', async (role) => {
      const project = await findProjectByStatus(ownerToken, 'geplant');

      const res = await authPatch(tokenFor(role), `/api/projects/${project.id}/dates`, {
        plannedStart: '2026-10-01',
        plannedEnd: '2026-10-15',
      });

      expect(res.statusCode).toBe(403);

      const body = res.json();
      expect(body.code).toBe('NOT_PERMITTED');
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    });

    it.each(restrictedRoles)('%s CAN read projects — returns 200', async (role) => {
      const res = await authGet(tokenFor(role), '/api/projects');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------
  // Owner — full access
  // ---------------------------------------------------------------
  describe(`Owner (${SEED_USERS.owner.username})`, () => {
    it('can transition forward — returns 200', async () => {
      const project = await findProjectByStatus(ownerToken, 'abnahme');

      const res = await authPost(ownerToken, `/api/projects/${project.id}/transition/forward`, {
        expectedStatus: 'abnahme',
      });

      expect(res.statusCode).toBe(200);

      const updated = res.json();
      expect(updated.id).toBe(project.id);
      expect(updated.status).toBe('rechnung_faellig');
    });
  });

  // ---------------------------------------------------------------
  // Office — full access
  // ---------------------------------------------------------------
  describe(`Office (${SEED_USERS.office.username})`, () => {
    it('can transition forward — returns 200', async () => {
      // Use a project that hasn't been transitioned by the owner test above.
      // anfrage -> angebot is safe since seed has 2 anfrage projects.
      const project = await findProjectByStatus(officeToken, 'anfrage');

      const res = await authPost(officeToken, `/api/projects/${project.id}/transition/forward`, {
        expectedStatus: 'anfrage',
      });

      expect(res.statusCode).toBe(200);

      const updated = res.json();
      expect(updated.id).toBe(project.id);
      expect(updated.status).toBe('angebot');
    });
  });

  // ---------------------------------------------------------------
  // Users with no permissions — guards against regressions where a
  // protected route is registered without a `requirePermission` check.
  // The four seed roles all carry `project:read` and `auth:change-password`,
  // so prior to explicit enforcement these endpoints would silently allow
  // anyone with a valid session — including a future role added without
  // those permissions, or a programmatic user with roles: [].
  //
  // We mint the session directly (createTestUserSession) rather than
  // adding a seed user, so the test surfaces the enforcement contract
  // without depending on seed data shape.
  // ---------------------------------------------------------------
  describe('User with no permissions (roles: [])', () => {
    let noPermsToken: string;

    beforeAll(async () => {
      const session = await createTestUserSession({ roles: [] });
      noPermsToken = session.token;
    });

    it('cannot list projects — returns 403 NOT_PERMITTED', async () => {
      const res = await authGet(noPermsToken, '/api/projects');
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('cannot get a project by id — returns 403 NOT_PERMITTED', async () => {
      // A project id obtained via an authorized user — the id itself is not
      // authorization-sensitive; the check is role-based.
      const project = await findProjectByStatus(ownerToken, 'anfrage');
      const res = await authGet(noPermsToken, `/api/projects/${project.id}`);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('cannot change own password — returns 403 NOT_PERMITTED', async () => {
      const res = await authPost(noPermsToken, '/api/auth/change-password', {
        currentPassword: 'irrelevant',
        newPassword: 'irrelevant-too',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('cannot transition a project — returns 403 NOT_PERMITTED', async () => {
      const project = await findProjectByStatus(ownerToken, 'anfrage');
      const res = await authPost(noPermsToken, `/api/projects/${project.id}/transition/forward`, {
        expectedStatus: 'anfrage',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });
  });
});
