/**
 * API integration test helpers.
 *
 * Provides a shared Fastify app instance and convenience functions
 * for authenticated requests. Uses Fastify's `inject()` method
 * (in-process HTTP simulation, no actual network).
 */

import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app.js';
import { validateEnvRuntime } from '../server/config/env.js';
import { createDatabase } from '../server/db/connection.js';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { seed } from '../server/seed.js';
import { deactivateUser as deactivateUserRepo } from '../server/repositories/user.js';
import { deleteSession } from '../server/repositories/session.js';
import { eq } from 'drizzle-orm';
import { __resetForTests as resetAuditPublisher } from '../server/services/audit-publisher.js';
import { __resetForTests as resetNotificationPublisher } from '../server/services/notification-publisher.js';
import { __resetForTests as resetSseBus } from '../server/sse/bus.js';
import { randomBytes } from 'node:crypto';
import type { Database } from '../server/db/connection.js';
import { sessions, users } from '../server/db/schema.js';
import type pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

let app: FastifyInstance;
let db: Database;
let pool: pg.Pool;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../server/db/migrations');

/**
 * Start the test application. Call in `beforeAll`.
 *
 * Connects to the test database, runs migrations, seeds data,
 * and boots a Fastify instance. Test files run in parallel; each still
 * gets a fresh seed without racing the others because `isolate` gives
 * every file its own forked process, and integration-setup.ts turns
 * that PID into a private `projekt_manager_test_<pid>` database. The
 * `seed(force: true)` below therefore wipes only this file's data.
 */
export async function startApp(): Promise<FastifyInstance> {
  // Validate the env once at startup — consolidation review C-3 removed
  // the dual ALLOW_INSECURE_HTTP code paths, so getEnv() is now the single
  // source of truth. Integration tests need validateEnvRuntime() called
  // before buildApp() accesses getEnv().
  validateEnvRuntime();

  const conn = createDatabase();
  db = conn.db;
  pool = conn.pool;

  // Verify the new pool is live and PG has released prior connections
  await pool.query('SELECT 1');

  // Run migrations (idempotent — drizzle tracks applied migrations)
  await migrate(db, { migrationsFolder });

  // Seed fresh test data (force: wipe and re-seed for clean slate)
  await seed(db, { force: true });

  app = buildApp({ logger: false, db, rateLimit: false });
  await app.ready();
  return app;
}

/**
 * Shut down the test application. Call in `afterAll`.
 *
 * Closing order matters: Fastify first (stops accepting requests and
 * waits for in-flight handlers to finish), reset module-scoped state on
 * the audit + notification publishers + SSE bus so the next `startApp()`
 * wires onto clean buses, then drain the pg pool.
 */
export async function stopApp(): Promise<void> {
  if (app) {
    await app.close();
  }
  resetNotificationPublisher();
  resetAuditPublisher();
  resetSseBus();
  if (pool) {
    await pool.end();
  }
}

/**
 * Get the current app instance.
 * Throws if `startApp()` has not been called.
 */
export function getApp(): FastifyInstance {
  if (!app) {
    throw new Error('Test app not started. Call startApp() in beforeAll.');
  }
  return app;
}

/**
 * Get the database handle the running app was built with.
 *
 * Lets tests drive the service layer directly (e.g. ExportService /
 * ImportService — see `data-exchange-helpers.ts`) against the same
 * Postgres state the app serves, without an HTTP hop.
 * Throws if `startApp()` has not been called.
 */
export function getDb(): Database {
  if (!db) {
    throw new Error('Test app not started. Call startApp() in beforeAll.');
  }
  return db;
}

/**
 * Log in as a user and return the session token.
 *
 * Extracts the token from the `set-cookie` header (HttpOnly session
 * cookie). Tests pass this token back via `cookie: 'session=<token>'`
 * in subsequent requests.
 */
export async function login(username: string, password: string): Promise<string> {
  const res = await getApp().inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });

  if (res.statusCode !== 200) {
    throw new Error(`Login failed for "${username}": ${res.statusCode} ${res.body}`);
  }

  const setCookie = res.headers['set-cookie'];
  const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const match = cookieStr?.match(/session=([^;]+)/);
  if (!match) {
    throw new Error(`Login for "${username}" did not return a session cookie`);
  }
  return match[1];
}

/**
 * Make an authenticated GET request.
 */
export async function authGet(token: string, url: string) {
  return getApp().inject({
    method: 'GET',
    url,
    headers: { cookie: `session=${token}` },
  });
}

/**
 * Make an authenticated POST request.
 */
export async function authPost(token: string, url: string, payload?: Record<string, unknown>) {
  return getApp().inject({
    method: 'POST',
    url,
    headers: { cookie: `session=${token}` },
    payload,
  });
}

/**
 * Make an authenticated PATCH request.
 */
export async function authPatch(token: string, url: string, payload?: Record<string, unknown>) {
  return getApp().inject({
    method: 'PATCH',
    url,
    headers: { cookie: `session=${token}` },
    payload,
  });
}

/**
 * Make an authenticated PUT request.
 *
 * Used by upsert-style routes such as company-profile (api.md §14.2.15).
 */
export async function authPut(token: string, url: string, payload?: Record<string, unknown>) {
  return getApp().inject({
    method: 'PUT',
    url,
    headers: { cookie: `session=${token}` },
    payload,
  });
}

/**
 * Make an authenticated DELETE request.
 */
export async function authDelete(token: string, url: string) {
  return getApp().inject({
    method: 'DELETE',
    url,
    headers: { cookie: `session=${token}` },
  });
}

/**
 * Create an expired session for the given user and return its token.
 *
 * The session must be a real database row whose expiresAt is in the past.
 * This lets AT-5 verify that the auth middleware rejects expired sessions
 * with the correct error code — something a fabricated string can never do.
 *
 * Test-only helper — intentionally NOT in production code.
 */
export async function createExpiredSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const expiredAt = new Date(Date.now() - 60_000); // 1 minute in the past
  const rows = await db
    .insert(sessions)
    .values({
      userId,
      token,
      expiresAt: expiredAt,
    })
    .returning();
  return rows[0]!.token;
}

/**
 * Deactivate a user account by setting active=false in the database.
 *
 * Used by AT-7 to simulate the "logged-in user gets deactivated" flow:
 * login normally, deactivate the account, then assert the existing token
 * is rejected on the next request. Tests pass actorId=null because no
 * human admin exists in this iteration — the audit pattern allows
 * updatedBy to be null for system/test-fixture actions (data-model.md §5.5).
 */
export async function deactivateUser(userId: string): Promise<void> {
  // The repo write requires a tx handle (AC-179 type gate — see
  // connection.ts MutatingDatabase). Test fixtures may bypass the
  // service-layer `mutate()` wrapper but still must execute inside a
  // transaction for type safety.
  await db.transaction(async (tx) => {
    await deactivateUserRepo(tx, userId, null);
  });
}

/**
 * Revoke a session by deleting its row directly. Mirrors what
 * `AuthService.logout` does on its own session row, what
 * `UserService.deactivateUser` does to every session of the affected
 * user, and what `session-reaper` does to expired rows. Used by AC-275
 * to assert that a held SSE stream observes server-side revocation
 * within the heartbeat budget.
 */
export async function revokeSession(token: string): Promise<void> {
  await deleteSession(db, token);
}

/**
 * Force a session row's `expiresAt` to the past. Models the natural-
 * expiry path that the auth middleware rejects via `isSessionExpired`
 * (the session-reaper sweeps these rows asynchronously, but the
 * auth gate triggers the moment `expiresAt < now`). Used by AC-275 to
 * exercise the expiry arm without waiting for wall-clock to elapse.
 */
export async function expireSession(token: string): Promise<void> {
  const past = new Date(Date.now() - 60_000);
  await db.update(sessions).set({ expiresAt: past }).where(eq(sessions.token, token));
}

/**
 * Create an authenticated test user with the given roles and return a
 * ready-to-use session token. The password hash is a placeholder — this
 * helper mints the session directly in the database, bypassing login.
 *
 * Used by permission tests to construct users that do not match any seed
 * role (e.g. roles: [] for a user with no permissions at all). Regular
 * tests should log in via seed users instead.
 */
export async function createTestUserSession(options: {
  roles: string[];
  displayName?: string;
}): Promise<{ userId: string; token: string }> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour ahead
  const username = `test_${randomBytes(6).toString('hex')}`;
  const userRows = await db
    .insert(users)
    .values({
      username,
      displayName: options.displayName ?? 'Test User',
      // Placeholder hash — this helper bypasses login, so the value is
      // never verified. Non-empty because the column is NOT NULL.
      passwordHash: 'test-no-password-verification',
      roles: options.roles,
      active: true,
    })
    .returning();
  const userId = userRows[0]!.id;
  await db.insert(sessions).values({ userId, token, expiresAt });
  return { userId, token };
}
