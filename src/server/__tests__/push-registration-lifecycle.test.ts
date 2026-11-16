/**
 * Push registration lifecycle — which account events end a device's
 * registration and which leave it. Pins AC-654, AC-656, AC-676, AC-677,
 * AC-678 and the server side of AC-679 in §15.24.
 *
 * Each test creates its own users, so password changes and session
 * expiry do not touch the seeded accounts other tests log in with.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';

import { startApp, stopApp, login, authGet, authPost, authDelete } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import { deleteExpiredSessions } from '../repositories/session.js';

const PASSWORD = 'SecurePass2026!';
const NEW_PASSWORD = 'AnotherPass2027!';

let ownerToken: string;

beforeAll(async () => {
  await startApp();
  ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
});

afterAll(async () => {
  await stopApp();
});

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function createUser(): Promise<{ id: string; token: string }> {
  const username = `push_life_${uniqueSuffix()}`;
  const res = await authPost(ownerToken, '/api/users', {
    username,
    displayName: 'Push lifecycle user',
    password: PASSWORD,
    roles: ['office'],
  });
  expect(res.statusCode).toBeLessThan(300);
  const { id } = res.json() as { id: string };
  return { id, token: await login(username, PASSWORD) };
}

async function register(token: string, endpoint: string): Promise<void> {
  const res = await authPost(token, '/api/push-subscriptions', {
    endpoint,
    keys: { p256dh: 'p', auth: 'a' },
  });
  expect(res.statusCode).toBeLessThan(300);
}

function newEndpoint(label: string): string {
  return `https://push.test.example/lifecycle-${label}-${uniqueSuffix()}`;
}

/** Endpoints registered to `userId`, sorted. */
async function endpointsOf(userId: string): Promise<string[]> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(
      sql`SELECT endpoint FROM push_subscriptions WHERE user_id = ${userId} ORDER BY endpoint`,
    );
    return (res.rows as { endpoint: string }[]).map((r) => r.endpoint);
  } finally {
    await pool.end();
  }
}

/** Every user holding `endpoint`. */
async function holdersOf(endpoint: string): Promise<string[]> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(
      sql`SELECT user_id FROM push_subscriptions WHERE endpoint = ${endpoint}`,
    );
    return (res.rows as { user_id: string }[]).map((r) => r.user_id);
  } finally {
    await pool.end();
  }
}

describe('AC-656: a device belongs to the user who registered it last', () => {
  it('registering an endpoint another user holds moves it to the new user', async () => {
    const first = await createUser();
    const second = await createUser();
    const endpoint = newEndpoint('shared');

    await register(first.token, endpoint);
    await register(second.token, endpoint);

    expect(await holdersOf(endpoint)).toEqual([second.id]);
  });
});

describe("AC-654: no caller removes another user's device", () => {
  it("unregistering another user's endpoint leaves it registered to them", async () => {
    const holder = await createUser();
    const caller = await createUser();
    const endpoint = newEndpoint('held');
    await register(holder.token, endpoint);

    const res = await authDelete(
      caller.token,
      `/api/push-subscriptions?endpoint=${encodeURIComponent(endpoint)}`,
    );
    expect(res.statusCode).toBeLessThan(300);

    expect(await holdersOf(endpoint)).toEqual([holder.id]);
  });
});

describe('AC-676: a self-service password change removes the other devices', () => {
  it("keeps the device the change was made on and removes the user's other devices", async () => {
    const user = await createUser();
    const current = newEndpoint('current');
    const other = newEndpoint('other');
    await register(user.token, current);
    await register(user.token, other);

    const res = await authPost(user.token, '/api/auth/change-password', {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
      pushEndpoint: current,
    });
    expect(res.statusCode).toBe(200);

    expect(await endpointsOf(user.id)).toEqual([current]);
  });

  it("removes every device when the change is made on an unregistered device, no one else's", async () => {
    const user = await createUser();
    const bystander = await createUser();
    const bystanderDevice = newEndpoint('bystander');
    await register(user.token, newEndpoint('a'));
    await register(user.token, newEndpoint('b'));
    await register(bystander.token, bystanderDevice);

    const res = await authPost(user.token, '/api/auth/change-password', {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(res.statusCode).toBe(200);

    expect(await endpointsOf(user.id)).toEqual([]);
    expect(await endpointsOf(bystander.id)).toEqual([bystanderDevice]);
  });

  it("leaves another user's device alone when the change names it", async () => {
    const user = await createUser();
    const bystander = await createUser();
    const bystanderDevices = [newEndpoint('bystander-a'), newEndpoint('bystander-b')].sort();
    await register(user.token, newEndpoint('own'));
    for (const device of bystanderDevices) await register(bystander.token, device);

    const res = await authPost(user.token, '/api/auth/change-password', {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
      pushEndpoint: bystanderDevices[0],
    });
    expect(res.statusCode).toBe(200);

    expect(await endpointsOf(user.id)).toEqual([]);
    expect(await endpointsOf(bystander.id)).toEqual(bystanderDevices);
  });
});

describe("AC-678: an owner password reset removes all the user's devices", () => {
  it("removes every registration of the user and no one else's", async () => {
    const user = await createUser();
    const bystander = await createUser();
    const bystanderDevice = newEndpoint('bystander');
    await register(user.token, newEndpoint('phone'));
    await register(user.token, newEndpoint('desktop'));
    await register(bystander.token, bystanderDevice);

    const res = await authPost(ownerToken, `/api/users/${user.id}/reset-password`, {
      newPassword: NEW_PASSWORD,
    });
    expect(res.statusCode).toBeLessThan(300);

    expect(await endpointsOf(user.id)).toEqual([]);
    expect(await holdersOf(bystanderDevice)).toEqual([bystander.id]);
  });
});

describe('AC-677: an expired session leaves the devices registered', () => {
  it('keeps the registrations after the session expires and the reaper removes it', async () => {
    const user = await createUser();
    const endpoint = newEndpoint('expiry');
    await register(user.token, endpoint);

    const { db, pool } = createDatabase();
    try {
      await db.execute(
        sql`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = ${user.id}`,
      );
      await deleteExpiredSessions(db);
      const left = await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM sessions WHERE user_id = ${user.id}`,
      );
      expect((left.rows[0] as { c: number }).c).toBe(0);
    } finally {
      await pool.end();
    }

    expect(await endpointsOf(user.id)).toEqual([endpoint]);
  });
});

describe('AC-679: a device can tell whether it is registered for the signed-in user', () => {
  async function registered(token: string, endpoint: string): Promise<boolean> {
    const res = await authGet(
      token,
      `/api/push-subscriptions/status?endpoint=${encodeURIComponent(endpoint)}`,
    );
    expect(res.statusCode).toBe(200);
    return (res.json() as { registered: boolean }).registered;
  }

  it("answers yes for the caller's own device only", async () => {
    const holder = await createUser();
    const other = await createUser();
    const endpoint = newEndpoint('status');
    await register(holder.token, endpoint);

    expect(await registered(holder.token, endpoint)).toBe(true);
    expect(await registered(other.token, endpoint)).toBe(false);
    expect(await registered(holder.token, newEndpoint('unknown'))).toBe(false);
  });
});
