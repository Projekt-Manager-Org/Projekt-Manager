/**
 * API integration test: sign-in and password-change rate limiting
 * end-to-end, keyed per client address (AC-772).
 *
 * The shared test helper in `src/test/api-helpers.ts` builds the Fastify app
 * with `rateLimit: false` so the other integration tests can hammer the API
 * without tripping the 5-per-minute login limit. That leaves rate limiting
 * itself un-exercised — this file closes that gap by building its own
 * dedicated app instance with rate limiting **enabled** and asserting that
 * the 6th attempt from the same IP inside the window returns 429.
 *
 * Notes on isolation:
 *   - `@fastify/rate-limit` defaults to an in-memory LRU store scoped to the
 *     plugin instance, so the limiter state lives for exactly as long as this
 *     test's `app` does and does not leak into other files.
 *   - We pass `remoteAddress` explicitly so the limiter key is deterministic
 *     regardless of whatever address fastify's inject default picks.
 *   - We do NOT reuse `startApp()` because it hard-codes `rateLimit: false`
 *     (that's the whole reason this file exists).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { buildApp } from '../app.js';
import { validateEnvRuntime } from '../config/env.js';
import { getRateLimit } from '../config/index.js';
import { createDatabase } from '../db/connection.js';
import { seed } from '../seed.js';
import { SEED_USERS } from '../../test/seedAssumptions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

let app: FastifyInstance;
let pool: pg.Pool;

describe('AC-772: sign-in and password-change rate limits (end-to-end)', () => {
  // Vitest runs with NODE_ENV=test, where `getRateLimit()` defaults the
  // login ceiling to 30/min so E2E flows with many fresh contexts don't
  // throttle. Pin the production ceiling (5/min) explicitly here — this
  // test is the one that verifies the *production* behaviour.
  const originalLimit = process.env.LOGIN_RATE_LIMIT_MAX;

  beforeAll(async () => {
    process.env.LOGIN_RATE_LIMIT_MAX = '5';

    // buildApp() reads the validated env (see config/index.ts and app.ts) —
    // any test that bypasses startApp() must call validateEnvRuntime() itself.
    validateEnvRuntime();

    const conn = createDatabase();
    pool = conn.pool;

    // Verify the pool is live before we touch it.
    await pool.query('SELECT 1');

    // Run migrations (idempotent — drizzle tracks applied migrations) and
    // seed fresh test data so `SEED_USERS.owner` exists for the login call.
    await migrate(conn.db, { migrationsFolder });
    await seed(conn.db, { force: true });

    // Rate limiting ENABLED — this is the whole point of the file.
    app = buildApp({ logger: false, db: conn.db, rateLimit: true });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
    if (originalLimit === undefined) delete process.env.LOGIN_RATE_LIMIT_MAX;
    else process.env.LOGIN_RATE_LIMIT_MAX = originalLimit;
  });

  // The production limit is `{ max: 5, timeWindow: '1 minute' }` per IP for
  // POST /api/auth/login — see `getRateLimit().login` in src/server/config/index.ts.
  // Using wrong credentials so we don't burn a valid session + deliberately
  // get 401s on the first 5 attempts; the 6th must be rejected by the limiter
  // BEFORE the credentials check runs, so it becomes 429.
  it('returns 429 on the 6th login attempt within the 1-minute window', async () => {
    const payload = { username: SEED_USERS.owner.username, password: 'wrongpassword' };
    const remoteAddress = '10.0.0.1';

    // First 5 attempts should NOT be rate-limited. Wrong password yields 401,
    // but importantly none of them are 429. (If somehow one succeeded with a
    // 200 that would also be fine — the assertion is strictly "not 429".)
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload,
        remoteAddress,
      });
      statuses.push(res.statusCode);
    }

    expect(statuses.every((s) => s !== 429)).toBe(true);

    // 6th attempt inside the same 1-minute window must be rate-limited.
    const sixth = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload,
      remoteAddress,
    });
    expect(sixth.statusCode).toBe(429);

    // The response body must be the RATE_LIMITED AppError shape — without
    // the error-handler translation in src/server/app.ts the plugin's
    // vanilla Error would fall through to 500 SERVER_ERROR. Asserting the
    // code and a non-empty message guards that translation path.
    const body = sixth.json();
    expect(body.code).toBe('RATE_LIMITED');
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);

    // @fastify/rate-limit sets the Retry-After header before throwing.
    // Asserting it here proves our error handler's reply.code + send
    // preserves headers the plugin added (rather than wiping them with a
    // fresh 500 response).
    expect(sixth.headers['retry-after']).toBeDefined();

    // The limit is per client address: another address in the same
    // window is not refused. Guards against a single global bucket.
    const otherAddress = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload,
      remoteAddress: '10.0.0.3',
    });
    expect(otherAddress.statusCode).not.toBe(429);
  });

  // The change-password limit is `{ max: 5, timeWindow: '1 minute' }` per IP,
  // declared the same way as the login limit (see getRateLimit().passwordChange in
  // src/server/config/index.ts). Before this test the limit was wired but
  // unverified — a regression that dropped the config from the route would
  // slip through login-only coverage. We use a distinct remoteAddress so the
  // login-test limiter key and this test's limiter key don't collide.
  it('returns 429 on the 6th change-password attempt within the 1-minute window', async () => {
    // Log in first so we have a session cookie — change-password requires
    // authentication, and we want the rate limiter to fire BEFORE the
    // business-logic check rejects the wrong current password.
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: SEED_USERS.owner.username, password: 'changeme' },
      remoteAddress: '10.0.0.2',
    });
    expect(loginRes.statusCode).toBe(200);
    const setCookie = loginRes.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
    const match = cookieStr.match(/session=([^;]+)/);
    expect(match).not.toBeNull();
    const token = match![1]!;

    const payload = { currentPassword: 'wrong', newPassword: 'alsowrong1234567' };
    const remoteAddress = '10.0.0.2';

    // First 5 attempts should hit the business-logic path (401 invalid
    // credentials) but NOT 429.
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        headers: { cookie: `session=${token}` },
        payload,
        remoteAddress,
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.every((s) => s !== 429)).toBe(true);

    // 6th attempt inside the same 1-minute window must be 429.
    const sixth = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie: `session=${token}` },
      payload,
      remoteAddress,
    });
    expect(sixth.statusCode).toBe(429);

    const body = sixth.json();
    expect(body.code).toBe('RATE_LIMITED');
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);
    expect(sixth.headers['retry-after']).toBeDefined();

    // The limit is per client address, not per session: a fresh session
    // from the same address is still refused.
    const relogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: SEED_USERS.owner.username, password: 'changeme' },
      remoteAddress,
    });
    expect(relogin.statusCode).toBe(200);
    const reCookie = relogin.headers['set-cookie'];
    const reCookieStr = Array.isArray(reCookie) ? reCookie[0]! : reCookie!;
    const freshToken = reCookieStr.match(/session=([^;]+)/)![1]!;
    const freshSession = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie: `session=${freshToken}` },
      payload,
      remoteAddress,
    });
    expect(freshSession.statusCode).toBe(429);
  });
});

// Unit-level pins on getRateLimit()'s environment-aware default. The
// integration block above proves the 5/min ceiling actually rejects the
// 6th request; these cases pin the selection logic between production
// (5/min) and dev/test (30/min) so a regression that swaps the branches
// is caught without spinning up the app.
//
// Issue #139 moved `LOGIN_RATE_LIMIT_MAX` and
// `NODE_ENV` reads from raw `process.env` into the validated schema.
// The dev-default credentials guard (POSTGRES_PASSWORD / MINIO_ROOT_*)
// now fires inside `validateEnvRuntime()` whenever `NODE_ENV=production` is in
// scope — including these unit tests, which run with the .env-loaded
// `MINIO_ROOT_USER=minioadmin` already in `process.env`. Clear the
// dev-cred vars in the production-flavoured cases so the guard does
// not trip on the test harness's compose-style setup. The
// 'invalid override' case asserts the new schema-rejection contract
// rather than the old silent-fallback behaviour: an unparseable
// override is now an operator-facing fault, not a runtime fallback.
describe('getRateLimit() login default selection', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalOverride = process.env.LOGIN_RATE_LIMIT_MAX;
  const originalPgPwd = process.env.POSTGRES_PASSWORD;
  const originalMinioUser = process.env.MINIO_ROOT_USER;
  const originalMinioPwd = process.env.MINIO_ROOT_PASSWORD;

  /** Clear the dev-default compose vars so production-flavoured cases
   * do not trip the aggregated dev-credentials guard. */
  function stripDevCreds(): void {
    delete process.env.POSTGRES_PASSWORD;
    delete process.env.MINIO_ROOT_USER;
    delete process.env.MINIO_ROOT_PASSWORD;
  }

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalOverride === undefined) delete process.env.LOGIN_RATE_LIMIT_MAX;
    else process.env.LOGIN_RATE_LIMIT_MAX = originalOverride;
    if (originalPgPwd === undefined) delete process.env.POSTGRES_PASSWORD;
    else process.env.POSTGRES_PASSWORD = originalPgPwd;
    if (originalMinioUser === undefined) delete process.env.MINIO_ROOT_USER;
    else process.env.MINIO_ROOT_USER = originalMinioUser;
    if (originalMinioPwd === undefined) delete process.env.MINIO_ROOT_PASSWORD;
    else process.env.MINIO_ROOT_PASSWORD = originalMinioPwd;
  });

  it('production with no override → 5/min', () => {
    stripDevCreds();
    process.env.NODE_ENV = 'production';
    delete process.env.LOGIN_RATE_LIMIT_MAX;
    expect(getRateLimit().login.max).toBe(5);
  });

  it('missing NODE_ENV is treated as production → 5/min (fail-closed)', () => {
    stripDevCreds();
    delete process.env.NODE_ENV;
    delete process.env.LOGIN_RATE_LIMIT_MAX;
    expect(getRateLimit().login.max).toBe(5);
  });

  it('development with no override → 30/min (E2E-friendly)', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.LOGIN_RATE_LIMIT_MAX;
    expect(getRateLimit().login.max).toBe(30);
  });

  it('test with no override → 30/min (E2E-friendly)', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.LOGIN_RATE_LIMIT_MAX;
    expect(getRateLimit().login.max).toBe(30);
  });

  it('override wins over NODE_ENV default', () => {
    stripDevCreds();
    process.env.NODE_ENV = 'production';
    process.env.LOGIN_RATE_LIMIT_MAX = '100';
    expect(getRateLimit().login.max).toBe(100);
  });

  it('invalid override (non-numeric) is rejected by the schema', () => {
    // Pre-#139 this case asserted silent fallback to the NODE_ENV
    // default. The new contract surfaces invalid overrides as a
    // configuration fault: `getEnv()` re-parses `process.env` and the
    // schema rejects non-numeric LOGIN_RATE_LIMIT_MAX values.
    process.env.NODE_ENV = 'development';
    process.env.LOGIN_RATE_LIMIT_MAX = 'notanumber';
    expect(() => getRateLimit()).toThrow(/LOGIN_RATE_LIMIT_MAX/);
  });
});
