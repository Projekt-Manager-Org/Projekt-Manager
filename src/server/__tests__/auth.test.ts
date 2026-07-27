/**
 * API integration tests: Authentication & session management.
 *
 * Tests AT-1 through AT-7, AT-58, AT-59, AT-60 from the test specification
 * (verification.md §16.2). Runs against a real test database via Fastify
 * inject (no network).
 *
 * Seed users (from data-model.md §7.2) — referenced via SEED_USERS to
 * keep the coupling to `src/server/seed.ts` single-sourced:
 *   - owner (SEED_USERS.owner) — active, owner (admin)
 *   - office (SEED_USERS.office) — active, office
 *   - inactive (SEED_USERS.inactive) — active=false, for AT-3 / AT-7
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  startApp,
  stopApp,
  getApp,
  login,
  authGet,
  authPost,
  authPatch,
  createExpiredSession,
  deactivateUser,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { validateEnvRuntime } from '../config/env.js';

/**
 * Read a single users row directly from the database via a one-shot
 * pg.Client. Used by AT-7 (and only AT-7) to pin the audit columns
 * written by deactivateUser() — see `docs/spec/data-model.md §5.5`.
 *
 * A one-shot Client (not a long-lived Pool) is deliberate: holding a
 * Pool across the full `describe` block produced intermittent state
 * pollution when this file runs back-to-back with auth-password.test.ts
 * (login failures caused by a confused seed/pool lifecycle). The client
 * is opened at assertion time, used for exactly one SELECT, and closed
 * before the test returns, so there is no long-lived second pool racing
 * with the one startApp() manages.
 */
async function readUserAuditRow(userId: string): Promise<{
  active: boolean;
  updatedBy: string | null;
  updatedAt: Date;
}> {
  const env = validateEnvRuntime();
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    const res = await client.query<{
      active: boolean;
      updated_by: string | null;
      updated_at: Date;
    }>('SELECT active, updated_by, updated_at FROM users WHERE id = $1', [userId]);
    if (res.rows.length === 0) {
      throw new Error(`No user row for id ${userId}`);
    }
    const row = res.rows[0]!;
    return {
      active: row.active,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    };
  } finally {
    await client.end();
  }
}

describe('Authentication & Session Management', () => {
  beforeAll(async () => {
    await startApp();
  });

  afterAll(async () => {
    await stopApp();
  });

  // ---------------------------------------------------------------
  // AT-1: Login with valid credentials returns a session and user profile
  // ---------------------------------------------------------------
  describe('AT-1: Login with valid credentials', () => {
    it('returns 200 with session cookie and user profile', async () => {
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: SEED_USERS.owner.username, password: SEED_DEFAULT_PASSWORD },
      });

      expect(res.statusCode).toBe(200);

      // Session token is in the HttpOnly cookie, not the response body
      const setCookie = res.headers['set-cookie'];
      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(cookieStr).toBeDefined();
      expect(cookieStr).toMatch(/session=[^;]+/);
      expect(cookieStr).toContain('HttpOnly');
      expect(cookieStr).toContain('SameSite=Strict');

      const body = res.json();
      // Token must NOT appear in the response body
      expect(body).not.toHaveProperty('token');

      // User profile fields
      expect(body.user).toBeDefined();
      expect(body.user.id).toBeDefined();
      expect(body.user.username).toBe(SEED_USERS.owner.username);
      expect(body.user.displayName).toBe(SEED_USERS.owner.displayName);
      expect(body.user.roles).toEqual(expect.arrayContaining([...SEED_USERS.owner.roles]));
      expect(Array.isArray(body.user.roles)).toBe(true);

      // email may be undefined but the field should exist if set
      expect(body.user).toHaveProperty('email');
    });

    it('never includes passwordHash in the response', async () => {
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: SEED_USERS.owner.username, password: SEED_DEFAULT_PASSWORD },
      });

      const body = res.json();
      expect(body.user).not.toHaveProperty('passwordHash');
    });

    // Parity with GET /api/auth/me (api.md §14.2.7): the login response
    // also carries `backupStatus` for owner callers. Before this, a
    // deliberate log-out/log-in by the owner left the badge on the
    // stale value set at initial session check, because the login
    // path rehydrated `user` but not `backupStatus`. This test pins
    // the parity — a regression would silently reintroduce the stale
    // badge and only reveal itself as a UX report.
    it('includes backupStatus for owner callers (parity with /api/auth/me)', async () => {
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: SEED_USERS.owner.username, password: SEED_DEFAULT_PASSWORD },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('backupStatus');
      // Pre-seed row from the baseline migration guarantees the field
      // is present; shape is asserted in backup-status tests.
      expect(body.backupStatus).toBeDefined();
      expect(typeof body.backupStatus.lastBackupOk).toBe('boolean');
    });

    it('omits backupStatus for non-owner callers', async () => {
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: SEED_USERS.office.username, password: SEED_DEFAULT_PASSWORD },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).not.toHaveProperty('backupStatus');
    });

    // AC-39: session duration is driven by configuration.
    //
    // Before iteration 5 cookieMaxAgeSec and sessionDurationMs were
    // hand-synchronized with a "must match" comment. They are now
    // derived from a single constant in config/index.ts, but the only
    // way to prove the auth route actually reads it is to inspect the
    // Set-Cookie header on a real login response. Max-Age must match
    // AUTH_CONFIG.cookieMaxAgeSec byte-for-byte — a regression that
    // hardcodes a different number fails here and fails loudly.
    // See consolidation review F F-4 / round-2 F M-3.
    it('sets the session cookie Max-Age from AUTH_CONFIG.cookieMaxAgeSec (AC-39)', async () => {
      const { AUTH_CONFIG } = await import('../config/index.js');
      // Sanity: the derivation holds at the config layer.
      expect(AUTH_CONFIG.cookieMaxAgeSec * 1000).toBe(AUTH_CONFIG.sessionDurationMs);

      const res = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: SEED_USERS.owner.username, password: SEED_DEFAULT_PASSWORD },
      });
      expect(res.statusCode).toBe(200);

      const setCookie = res.headers['set-cookie'];
      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(cookieStr).toBeDefined();

      const maxAgeMatch = /Max-Age=(\d+)/.exec(cookieStr!);
      expect(maxAgeMatch).not.toBeNull();
      const maxAge = Number(maxAgeMatch![1]);
      // Exact match — not "within N seconds" — because the value is
      // derived from the same constant the route reads. Any drift means
      // a second path has appeared that the test can surface.
      expect(maxAge).toBe(AUTH_CONFIG.cookieMaxAgeSec);
    });
  });

  // ---------------------------------------------------------------
  // AT-2: Login with invalid credentials returns a generic error
  // ---------------------------------------------------------------
  describe('AT-2: Login with invalid credentials', () => {
    it('returns 401 with INVALID_CREDENTIALS for wrong password', async () => {
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: SEED_USERS.owner.username, password: 'wrongpassword' },
      });

      expect(res.statusCode).toBe(401);

      const body = res.json();
      expect(body.code).toBe('INVALID_CREDENTIALS');
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    });

    it('returns 401 with INVALID_CREDENTIALS for nonexistent user', async () => {
      // 'nobody' is intentionally NOT in SEED_USERS — the test proves a
      // username with no matching row fails. Keep the literal here.
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'nobody', password: SEED_DEFAULT_PASSWORD },
      });

      expect(res.statusCode).toBe(401);

      const body = res.json();
      expect(body.code).toBe('INVALID_CREDENTIALS');
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    });

    it('returns identical error shape for wrong user and wrong password (no information leakage)', async () => {
      const wrongPassword = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: SEED_USERS.owner.username, password: 'wrong' },
      });
      const wrongUser = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        // 'nonexistent' is intentionally not a seeded username.
        payload: { username: 'nonexistent', password: SEED_DEFAULT_PASSWORD },
      });

      expect(wrongPassword.statusCode).toBe(wrongUser.statusCode);

      const bodyA = wrongPassword.json();
      const bodyB = wrongUser.json();
      expect(bodyA.code).toBe(bodyB.code);
      // No information leakage: both must return the exact same message
      // so an attacker cannot distinguish "user not found" from "wrong password"
      expect(typeof bodyA.message).toBe('string');
      expect(bodyA.message.length).toBeGreaterThan(0);
      expect(bodyA.message).toBe(bodyB.message);
    });
  });

  // ---------------------------------------------------------------
  // AT-3: Login with an inactive user account returns a generic error
  // AC-28 [crit]
  // ---------------------------------------------------------------
  describe('AT-3: Login with inactive user', () => {
    it('returns 401 with INVALID_CREDENTIALS (same as wrong password)', async () => {
      // Seed includes an inactive user for this test — see SEED_USERS.inactive.
      const res = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: SEED_USERS.inactive.username, password: SEED_DEFAULT_PASSWORD },
      });

      expect(res.statusCode).toBe(401);

      const body = res.json();
      expect(body.code).toBe('INVALID_CREDENTIALS');
      expect(typeof body.message).toBe('string');
    });

    it('is indistinguishable from a wrong-password error', async () => {
      const inactive = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: SEED_USERS.inactive.username, password: SEED_DEFAULT_PASSWORD },
      });
      const wrongPassword = await getApp().inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: SEED_USERS.owner.username, password: 'wrong' },
      });

      expect(inactive.statusCode).toBe(wrongPassword.statusCode);

      const bodyInactive = inactive.json();
      const bodyWrong = wrongPassword.json();
      expect(bodyInactive.code).toBe(bodyWrong.code);
      // Same message — no information leakage between inactive and wrong password
      expect(typeof bodyInactive.message).toBe('string');
      expect(bodyInactive.message.length).toBeGreaterThan(0);
      expect(bodyInactive.message).toBe(bodyWrong.message);
    });
  });

  // ---------------------------------------------------------------
  // AT-4: An authenticated request with a valid session succeeds
  // ---------------------------------------------------------------
  describe('AT-4: Authenticated request with valid session', () => {
    it('GET /api/auth/me returns 200 with user profile', async () => {
      const token = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);

      const res = await authGet(token, '/api/auth/me');

      expect(res.statusCode).toBe(200);

      // /me is enveloped as `{ user: { ... } }` — same shape as /login
      // (consolidation review E F-7). Asserting the envelope and not
      // the flat body pins the contract so a future regression that
      // strips the envelope fails here.
      const body = res.json();
      expect(body.user).toBeDefined();
      expect(body.user.id).toBeDefined();
      expect(body.user.username).toBe(SEED_USERS.owner.username);
      expect(body.user.displayName).toBe(SEED_USERS.owner.displayName);
      expect(body.user.roles).toEqual(expect.arrayContaining([...SEED_USERS.owner.roles]));
      expect(body.user).not.toHaveProperty('passwordHash');
    });

    // AC-176: the freshness badge's only source is the owner-only
    // `backupStatus` field on this response — there is no public
    // `/api/backup/status` endpoint to fall back to. Scope here is the
    // security-relevant half: an owner gets the field, nobody else does.
    it('carries backupStatus for owner callers and omits it for others (AC-176)', async () => {
      const ownerRes = await authGet(
        await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD),
        '/api/auth/me',
      );
      expect(ownerRes.statusCode).toBe(200);
      expect(ownerRes.json()).toHaveProperty('backupStatus');

      const officeRes = await authGet(
        await login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD),
        '/api/auth/me',
      );
      expect(officeRes.statusCode).toBe(200);
      expect(officeRes.json()).not.toHaveProperty('backupStatus');
    });
  });

  // ---------------------------------------------------------------
  // AT-5: A request with an expired session returns an authentication error
  // ---------------------------------------------------------------
  describe('AT-5: Expired session', () => {
    it('returns 401 with SESSION_EXPIRED', async () => {
      // 1. Log in to get a real user ID
      const setupToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
      const meRes = await authGet(setupToken, '/api/auth/me');
      const userId = meRes.json().user.id;

      // 2. Create a real expired session in the database
      const expiredToken = await createExpiredSession(userId);

      // 3. Use the expired token — auth middleware must reject it
      const res = await authGet(expiredToken, '/api/auth/me');

      expect(res.statusCode).toBe(401);

      const body = res.json();
      expect(body.code).toBe('SESSION_EXPIRED');
      expect(typeof body.message).toBe('string');
    });
  });

  // ---------------------------------------------------------------
  // AT-6: A request with no session returns an authentication error
  // ---------------------------------------------------------------
  describe('AT-6: Request with no session', () => {
    it('GET /api/auth/me without session cookie returns 401', async () => {
      const res = await getApp().inject({
        method: 'GET',
        url: '/api/auth/me',
        // No cookie header
      });

      expect(res.statusCode).toBe(401);

      const body = res.json();
      // A missing session is NOT the same as an expired session.
      // SESSION_EXPIRED implies a session existed and timed out (client shows
      // "Sitzung abgelaufen" message). UNAUTHENTICATED means no session was
      // ever provided — the client shows a plain login screen.
      expect(body.code).toBe('UNAUTHENTICATED');
      expect(typeof body.message).toBe('string');
    });

    it('GET /api/projects without session cookie returns 401', async () => {
      const res = await getApp().inject({
        method: 'GET',
        url: '/api/projects',
      });

      expect(res.statusCode).toBe(401);

      const body = res.json();
      expect(body.code).toBe('UNAUTHENTICATED');
    });
  });

  // ---------------------------------------------------------------
  // AT-7: A request with a valid session token for a deactivated user
  //        returns an authentication error
  // AC-28 [crit]
  // ---------------------------------------------------------------
  describe('AT-7: Valid session for deactivated user', () => {
    it('returns 401 when the user has been deactivated after login', async () => {
      // 1. Log in as an active user — get a valid session token
      const validToken = await login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD);

      // Confirm the session works before deactivation
      const beforeRes = await authGet(validToken, '/api/auth/me');
      expect(beforeRes.statusCode).toBe(200);
      const userId = beforeRes.json().user.id;

      // Snapshot the audit columns before deactivation so the assertion
      // below can prove updatedAt actually advanced (not just a no-op
      // update with a stale timestamp). See data-model.md §5.5.
      const beforeRow = await readUserAuditRow(userId);
      const beforeUpdatedAt = beforeRow.updatedAt;

      // 2. Deactivate the user account in the database
      await deactivateUser(userId);

      // 3. Use the same token — auth middleware must reject it
      //    because session validation checks user.active (data-model.md §5.4)
      const res = await authGet(validToken, '/api/auth/me');

      expect(res.statusCode).toBe(401);

      const body = res.json();
      expect(body.code).toBe('SESSION_EXPIRED');
      expect(typeof body.message).toBe('string');

      // Pin the audit columns written by deactivateUser(). The repository
      // takes `actorId` as a required parameter (commit 362a565), but a
      // regression that flipped the argument order — e.g. passed the
      // target user's id instead of the actor — would compile cleanly.
      // Without this read-back the only line of defense is code review.
      //
      // The test helper `deactivateUser(userId)` in api-helpers.ts
      // deliberately passes actorId=null because no human admin exists
      // in this iteration (data-model.md §5.5 permits null for
      // system/fixture actions). Pinning to null here guarantees two
      // things simultaneously:
      //   (a) the repository honored the null actor the test supplied,
      //       i.e. did not silently default to the target's own id, and
      //   (b) if an admin-deactivates-other-user path is added later and
      //       the helper is changed to pass an admin id, the rewrite of
      //       this assertion will be deliberate — not accidental.
      // See consolidation runtime-assertion task on updatedBy.
      const afterRow = await readUserAuditRow(userId);
      expect(afterRow.active).toBe(false);
      expect(afterRow.updatedBy).toBeNull();
      // updatedAt must advance — defense against a regression that
      // writes updatedBy but forgets to bump the timestamp.
      expect(afterRow.updatedAt.getTime()).toBeGreaterThan(beforeUpdatedAt.getTime());
    });
  });

  // ---------------------------------------------------------------
  // Logout: Session invalidation
  // Covers api.md §14.2.1: "Invalidates the specific session."
  // AC-25 [crit]
  // ---------------------------------------------------------------
  describe('Logout: Session invalidation', () => {
    it('invalidates the session so the token no longer works', async () => {
      // 1. Login — get a fresh token
      const logoutToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);

      // 2. Verify the token works before logout
      const beforeRes = await authGet(logoutToken, '/api/auth/me');
      expect(beforeRes.statusCode).toBe(200);

      // 3. Logout — invalidate the session
      const logoutRes = await authPost(logoutToken, '/api/auth/logout');
      expect(logoutRes.statusCode).toBe(200);

      // 4. The same token must no longer work
      const afterRes = await authGet(logoutToken, '/api/auth/me');
      expect(afterRes.statusCode).toBe(401);

      // The error code must be SESSION_EXPIRED, not UNAUTHENTICATED.
      // Why it matters: this test passes the original token cookie back via
      // authGet, so the auth middleware sees a cookie and looks up the session
      // row. SESSION_EXPIRED is only returned when the row is MISSING from the
      // database (src/server/middleware/auth.ts:42-46) — so asserting this
      // code proves the logout actually deleted the session row, not just
      // cleared the browser cookie. Without this check, a silent regression
      // where logout only expired the cookie (leaving the row harvestable)
      // would pass the 401 assertion above.
      // See src/server/services/AuthService.ts:73 — the deleteSession call.
      const body = afterRes.json();
      expect(body.code).toBe('SESSION_EXPIRED');
    });
  });

  // ---------------------------------------------------------------
  // AC-29: Two users logged in simultaneously see each other's
  // changes after refreshing.
  //
  // Before this test AC-29 had zero coverage and was a freeform
  // assertion that happened to work because the current architecture
  // (server-authoritative list, client refetches via GET /api/projects)
  // supports it out of the box. The test pins that assumption: a
  // silent regression that introduces per-session caching, a
  // stickiness rule, or a race window would break it here first.
  // See consolidation review F F-2.
  // ---------------------------------------------------------------
  describe('AC-29: multi-user concurrent visibility', () => {
    it("user A (worker1) sees user B (owner)'s state transition after refetching", async () => {
      // Observer is a worker — has project:read but not project:transition,
      // which fits the "second user just observing" shape of AC-29. Mutator
      // is the owner. Office (buero) is deliberately not used here because
      // AT-7 in this same file deactivates it, and AC-29 runs after AT-7 —
      // a leftover assumption that held because tests in auth.test.ts run
      // sequentially within the same Fastify app instance.
      const observerToken = await login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD);
      const mutatorToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);

      // Find a project the observer can see. Worker1 is scoped
      // (AC-145/ADR-0019) to their assigned projects — pick one in
      // a non-terminal state so the forward transition is always safe.
      // `geplant` is one of worker1's seeded assignments (2024-007, 008).
      const initialObserver = await authGet(observerToken, '/api/projects');
      expect(initialObserver.statusCode).toBe(200);
      const projectsObserver = initialObserver.json().data as Record<string, unknown>[];
      const target = projectsObserver.find((p) => p.status === 'geplant');
      expect(target).toBeDefined();
      const targetId = target!.id as string;
      const initialStatus = target!.status as string;

      // Mutator advances the project one step.
      const transitionRes = await authPost(
        mutatorToken,
        `/api/projects/${targetId}/transition/forward`,
        { expectedStatus: initialStatus },
      );
      expect(transitionRes.statusCode).toBe(200);
      const transitioned = transitionRes.json() as Record<string, unknown>;
      expect(transitioned.status).not.toBe(initialStatus);
      const newStatus = transitioned.status as string;

      // Observer refetches — must see the new status, not the stale one.
      const refreshObserver = await authGet(observerToken, '/api/projects');
      expect(refreshObserver.statusCode).toBe(200);
      const projectsRefreshed = refreshObserver.json().data as Record<string, unknown>[];
      const sameTarget = projectsRefreshed.find((p) => p.id === targetId);
      expect(sameTarget).toBeDefined();
      expect(sameTarget!.status).toBe(newStatus);

      // Direct GET by id also returns the new status.
      const directGet = await authGet(observerToken, `/api/projects/${targetId}`);
      expect(directGet.statusCode).toBe(200);
      const direct = directGet.json() as Record<string, unknown>;
      expect(direct.status).toBe(newStatus);
    });
  });

  // ---------------------------------------------------------------
  // AT-58: Self-update with a valid themePreference round-trips
  // AC-116 [crit]
  //
  // Contract pinned here (api.md §14.2.1 + design notes):
  //   - Endpoint:   PATCH /api/auth/me
  //   - Body:       { themePreference?: 'light' | 'dark' | 'system' }
  //   - Response:   200 { user: <UserProfile> } — same envelope as
  //                 GET /api/auth/me and POST /api/auth/login.
  //   - PATCH semantics: omitted fields unchanged.
  //
  // The second GET /api/auth/me proves the value is actually persisted
  // on the user row, not just echoed from the request body. Without
  // the read-back, a broken endpoint that returns the input unchanged
  // would pass the first assertion silently.
  // ---------------------------------------------------------------
  describe('AT-58: Self-update with a valid themePreference', () => {
    it("PATCH /api/auth/me with themePreference='dark' updates the user row", async () => {
      // Use worker1 — the owner is deactivated / mutated by other
      // tests in this file (AT-7 deactivates office, AC-29 advances
      // a project via owner). worker1 is left alone by the preceding
      // blocks and has no special permissions required for self-update
      // (self-scope only, per api.md §14.2.1 design notes).
      const token = await login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD);

      // Sanity-check the starting state — the worker has not set a
      // preference yet, so the seed default 'system' must be in place.
      // This guards against a regression where the initial value
      // happens to be 'dark' and the assertion below passes by
      // coincidence.
      const beforeRes = await authGet(token, '/api/auth/me');
      expect(beforeRes.statusCode).toBe(200);
      expect(beforeRes.json().user.themePreference).toBe('system');

      // PATCH to 'dark'. 200 OK + enveloped user with the new value.
      const patchRes = await authPatch(token, '/api/auth/me', {
        themePreference: 'dark',
      });
      expect(patchRes.statusCode).toBe(200);
      const patchBody = patchRes.json();
      expect(patchBody.user).toBeDefined();
      expect(patchBody.user.themePreference).toBe('dark');
      // passwordHash must never leak back through any /me path.
      expect(patchBody.user).not.toHaveProperty('passwordHash');

      // Read-back: the next GET /api/auth/me must return 'dark'.
      // This is the load-bearing assertion — proves persistence,
      // not just request echo.
      const afterRes = await authGet(token, '/api/auth/me');
      expect(afterRes.statusCode).toBe(200);
      expect(afterRes.json().user.themePreference).toBe('dark');
    });
  });

  // ---------------------------------------------------------------
  // AT-59: Self-update without a valid session is rejected
  // AC-117 [crit]
  //
  // api.md §14.2.1 design note: "missing or invalid session →
  // authentication error". A PATCH with no cookie is exactly the
  // "missing session" branch. The error code must be UNAUTHENTICATED
  // (not SESSION_EXPIRED) — SESSION_EXPIRED is reserved for requests
  // that presented a cookie which no longer validates. The distinction
  // drives different client UX (login screen vs. expiry message).
  // ---------------------------------------------------------------
  describe('AT-59: Self-update without a valid session', () => {
    it('PATCH /api/auth/me without session cookie returns 401 UNAUTHENTICATED', async () => {
      const res = await getApp().inject({
        method: 'PATCH',
        url: '/api/auth/me',
        // No cookie header — session absent.
        payload: { themePreference: 'dark' },
      });

      expect(res.statusCode).toBe(401);

      const body = res.json();
      expect(body.code).toBe('UNAUTHENTICATED');
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------
  // AT-60: Self-update with an invalid themePreference is rejected
  // AC-118 [crit]
  //
  // api.md §14.2.1 design note: "request body violating the allowed
  // value set (e.g., themePreference outside 'light' | 'dark' |
  // 'system') → validation error". The accepted range is exactly
  // those three literals; anything else — here 'ultraviolet' — must
  // be rejected with VALIDATION_ERROR.
  //
  // HTTP status: the codebase returns 422 from validationError()
  // (errors.ts), but some paths return 400 via the fastify schema
  // layer. Match the pattern from projects-crud.test.ts AT-19 and
  // pin on the range (4xx client error) + the machine-readable code.
  // ---------------------------------------------------------------
  describe('AT-60: Self-update with an invalid themePreference', () => {
    it("PATCH /api/auth/me with themePreference='ultraviolet' returns VALIDATION_ERROR", async () => {
      const token = await login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD);

      const res = await authPatch(token, '/api/auth/me', {
        themePreference: 'ultraviolet',
      });

      // Client error, not server error — validation fires before
      // any DB interaction.
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);

      const body = res.json();
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    });
  });
});
