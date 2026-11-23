/**
 * Security baseline of sign-in and sessions (verification.md §15.4, §15.34):
 * no submitted password reaches the operational log (AC-780), session
 * tokens are long random strings carrying no user data (AC-781),
 * every sign-in outcome is logged with username and client address
 * (AC-784), and so are password changes and resets (AC-786).
 *
 * Builds its own app, like `rate-limit.test.ts`, with the production
 * logger config writing into an in-memory sink: the assertions read what
 * an operator's log would hold.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { buildApp } from '../app.js';
import { validateEnvRuntime } from '../config/env.js';
import { createDatabase } from '../db/connection.js';
import { seed } from '../seed.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

let app: FastifyInstance;
let pool: pg.Pool;
const lines: string[] = [];

beforeAll(async () => {
  validateEnvRuntime();
  const conn = createDatabase();
  pool = conn.pool;
  await migrate(conn.db, { migrationsFolder });
  await seed(conn.db, { force: true });
  app = buildApp({
    db: conn.db,
    rateLimit: false,
    logStream: { write: (l) => void lines.push(l) },
  });
  await app.ready();

  const ownerCookie = `session=${tokenOf(await signIn(SEED_DEFAULT_PASSWORD))}`;
  const inactive = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: { cookie: ownerCookie },
    payload: {
      username: 'inactive-user',
      displayName: 'Inactive User',
      password: 'Inactive-Pass-784',
      roles: ['office'],
    },
  });
  expect(inactive.statusCode).toBe(201);
  const deactivated = await pool.query('UPDATE users SET active = false WHERE id = $1', [
    inactive.json().id,
  ]);
  expect(deactivated.rowCount).toBe(1);
});

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach(() => {
  lines.length = 0;
});

const owner = SEED_USERS.owner.username;

function signIn(password: string, remoteAddress = '10.9.0.1') {
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: owner, password },
    remoteAddress,
  });
}

function tokenOf(res: Awaited<ReturnType<typeof signIn>>): string {
  const setCookie = res.headers['set-cookie'];
  const cookie = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  return cookie.match(/session=([^;]+)/)![1]!;
}

const logged = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

describe('AC-780: no submitted password reaches the operational log', () => {
  it('logs none of the passwords of sign-ins, password changes, user creation and password resets', async () => {
    const wrongSignIn = 'Wr0ng-SignIn-Secret-1';
    const wrongCurrent = 'Wr0ng-Current-Secret-2';
    const rejectedNew = 'Rejected-New-Secret-3';
    const createdPassword = 'Created-User-Secret-4';
    const resetPassword = 'Reset-User-Secret-5';

    expect((await signIn(wrongSignIn)).statusCode).toBe(401);
    const ok = await signIn(SEED_DEFAULT_PASSWORD);
    expect(ok.statusCode).toBe(200);
    const cookie = `session=${tokenOf(ok)}`;

    const wrongChange = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: wrongCurrent, newPassword: rejectedNew },
    });
    expect(wrongChange.statusCode).toBe(401);

    // A refused body: the validation path must not echo the password either.
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: wrongCurrent, newPassword: rejectedNew, extra: 1 },
    });
    expect(invalid.statusCode).toBe(422);

    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie },
      payload: {
        username: 'baseline-user',
        displayName: 'Baseline User',
        password: createdPassword,
        roles: ['office'],
      },
    });
    expect(created.statusCode).toBe(201);
    const createdId: string = created.json().id;

    const reset = await app.inject({
      method: 'POST',
      url: `/api/users/${createdId}/reset-password`,
      headers: { cookie },
      payload: { newPassword: resetPassword },
    });
    expect(reset.statusCode).toBeLessThan(300);

    expect(lines.length).toBeGreaterThan(0);
    const log = lines.join('\n');
    for (const password of [
      wrongSignIn,
      SEED_DEFAULT_PASSWORD,
      wrongCurrent,
      rejectedNew,
      createdPassword,
      resetPassword,
    ]) {
      expect(log).not.toContain(password);
    }

    // AC-779 on the admin paths: what is stored is a slow hash, not the password.
    const row = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [createdId],
    );
    const stored = row.rows[0]!.password_hash;
    expect(stored).not.toContain(resetPassword);
    expect(Number(stored.match(/^\$2[aby]\$(\d{2})\$/)?.[1])).toBeGreaterThanOrEqual(10);
  });
});

describe('AC-781: session tokens', () => {
  it('are at least 128 random bits, distinct per sign-in, and carry no user data', async () => {
    const tokens = [
      tokenOf(await signIn(SEED_DEFAULT_PASSWORD)),
      tokenOf(await signIn(SEED_DEFAULT_PASSWORD)),
    ];
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `session=${tokens[0]}` },
    });
    const userId: string = me.json().user.id;
    expect(userId).toMatch(/^[0-9a-f-]{36}$/);

    // Random, not derived: the token is drawn from the CSPRNG, 16 bytes or more.
    const sessionRepo = readFileSync(path.resolve(__dirname, '../repositories/session.ts'), 'utf8');
    const bytes = Number(sessionRepo.match(/const token = randomBytes\((\d+)\)/)?.[1]);
    expect(bytes).toBeGreaterThanOrEqual(16);

    expect(tokens[0]).not.toBe(tokens[1]);
    for (const token of tokens) {
      expect(token).toMatch(/^[0-9a-f]+$/);
      expect(token.length * 4).toBeGreaterThanOrEqual(128);
      const decoded = Buffer.from(token, 'hex').toString('latin1');
      for (const data of [owner, userId]) {
        expect(token).not.toContain(data);
        expect(decoded).not.toContain(data);
      }
    }
  });
});

// Level 30 is pino's `info`, the operator's threshold in production.
describe('AC-784: sign-in outcomes are logged with username and client address', () => {
  const atInfo = () => expect.toSatisfy((l: number) => l >= 30);

  // The three rejections take separate paths through AuthService.login.
  it.each([
    ['an unknown username', 'no-such-user', 'Any-Pass-1', '10.9.0.5'],
    ['a deactivated user', 'inactive-user', 'Inactive-Pass-784', '10.9.0.6'],
    ['a wrong password', owner, 'Wr0ng-Again', '10.9.0.7'],
  ])('logs a sign-in rejected for %s', async (_case, username, password, ip) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username, password },
      remoteAddress: ip,
    });
    expect(res.statusCode).toBe(401);
    expect(logged()).toContainEqual(
      expect.objectContaining({ msg: 'login_failure', username, ip, level: atInfo() }),
    );
  });

  it('logs a successful sign-in', async () => {
    await signIn(SEED_DEFAULT_PASSWORD, '10.9.0.8');
    expect(logged()).toContainEqual(
      expect.objectContaining({
        msg: 'login_success',
        username: owner,
        ip: '10.9.0.8',
        level: atInfo(),
      }),
    );
  });
});

describe('AC-786: password changes and resets are logged', () => {
  it('logs a reset with the user and the resetting user, and a change with the user', async () => {
    const ownerCookie = `session=${tokenOf(await signIn(SEED_DEFAULT_PASSWORD))}`;
    const ownerId: string = (
      await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: ownerCookie } })
    ).json().user.id;
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: ownerCookie },
      payload: {
        username: 'logged-user',
        displayName: 'Logged User',
        password: 'Initial-Pass-786a',
        roles: ['office'],
      },
    });
    expect(created.statusCode).toBe(201);
    const userId: string = created.json().id;

    const reset = await app.inject({
      method: 'POST',
      url: `/api/users/${userId}/reset-password`,
      headers: { cookie: ownerCookie },
      payload: { newPassword: 'Reset-Pass-786b' },
    });
    expect(reset.statusCode).toBeLessThan(300);
    const userSignIn = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'logged-user', password: 'Reset-Pass-786b' },
    });
    const change = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie: `session=${tokenOf(userSignIn)}` },
      payload: { currentPassword: 'Reset-Pass-786b', newPassword: 'Changed-Pass-786c' },
    });
    expect(change.statusCode).toBeLessThan(300);

    const atInfo = expect.toSatisfy((l: number) => l >= 30);
    expect(logged()).toContainEqual(
      expect.objectContaining({ msg: 'password_reset', userId, actorId: ownerId, level: atInfo }),
    );
    expect(logged()).toContainEqual(
      expect.objectContaining({ msg: 'password_change', userId, level: atInfo }),
    );
  });
});
