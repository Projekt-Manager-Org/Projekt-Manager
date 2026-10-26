/**
 * Push subscription integration tests — Iteration 8, issue #112.
 *
 * Pins AC-196 / AC-197 in §15.24.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';

import { startApp, stopApp, login, authPost, authDelete } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';

// ---------------------------------------------------------------------
// AC-196 — Subscribe / unsubscribe semantics
// ---------------------------------------------------------------------
describe('Push subscription subscribe + unsubscribe (AC-196)', () => {
  let ownerToken: string;
  let ownerUserId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    const { db, pool } = createDatabase();
    try {
      const rows = await db.execute(
        sql`SELECT id FROM users WHERE username = ${SEED_USERS.owner.username} LIMIT 1`,
      );
      ownerUserId = (rows.rows[0] as { id: string }).id;
    } finally {
      await pool.end();
    }
  });

  afterAll(async () => {
    await stopApp();
  });

  async function subscriptionCount(endpoint: string): Promise<number> {
    const { db, pool } = createDatabase();
    try {
      const res = await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM push_subscriptions WHERE endpoint = ${endpoint}`,
      );
      return (res.rows[0] as { c: number }).c;
    } finally {
      await pool.end();
    }
  }

  async function subscriptionUserId(endpoint: string): Promise<string | null> {
    const { db, pool } = createDatabase();
    try {
      const res = await db.execute(
        sql`SELECT user_id FROM push_subscriptions WHERE endpoint = ${endpoint} LIMIT 1`,
      );
      const row = res.rows[0] as { user_id: string } | undefined;
      return row?.user_id ?? null;
    } finally {
      await pool.end();
    }
  }

  it('subscribe sets userId from session; client-supplied userId is rejected (AC-516)', async () => {
    const endpoint = `https://push.test.example/at104-sess-${Date.now().toString(36)}`;
    const res = await authPost(ownerToken, '/api/push-subscriptions', {
      endpoint,
      keys: { p256dh: 'p', auth: 'a' },
      userId: '00000000-0000-0000-0000-0000000fffff',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().details).toContainEqual(
      expect.objectContaining({ params: { additionalProperty: 'userId' } }),
    );
    expect(await subscriptionUserId(endpoint)).toBeNull();

    const ok = await authPost(ownerToken, '/api/push-subscriptions', {
      endpoint,
      keys: { p256dh: 'p', auth: 'a' },
    });
    expect(ok.statusCode).toBeLessThan(300);
    expect(await subscriptionUserId(endpoint)).toBe(ownerUserId);
  });

  it('re-subscribing an existing endpoint updates the row (no duplicate)', async () => {
    const endpoint = `https://push.test.example/at104-re-${Date.now().toString(36)}`;
    const first = await authPost(ownerToken, '/api/push-subscriptions', {
      endpoint,
      keys: { p256dh: 'k1', auth: 'a1' },
    });
    expect(first.statusCode).toBeLessThan(300);
    expect(await subscriptionCount(endpoint)).toBe(1);

    // Re-subscribe with the same endpoint but new key material — must
    // update-in-place, not insert a duplicate.
    const second = await authPost(ownerToken, '/api/push-subscriptions', {
      endpoint,
      keys: { p256dh: 'k2', auth: 'a2' },
    });
    expect(second.statusCode).toBeLessThan(300);
    expect(await subscriptionCount(endpoint)).toBe(1);
  });

  it('unsubscribe against an unknown endpoint is an idempotent no-op (2xx, no error)', async () => {
    // An endpoint that was never registered. Unsubscribe must succeed
    // (self-scoped lookups, no enumeration) with a 2xx.
    const res = await authDelete(
      ownerToken,
      `/api/push-subscriptions?endpoint=${encodeURIComponent('https://push.test.example/never-registered')}`,
    );
    expect(res.statusCode).toBeLessThan(300);
  });

  it('subscribe without a session → 401 UNAUTHENTICATED', async () => {
    const res = await authPost('', '/api/push-subscriptions', {
      endpoint: 'https://push.test.example/no-session',
      keys: { p256dh: 'p', auth: 'a' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHENTICATED');
  });

  it('unsubscribe without a session → 401 UNAUTHENTICATED', async () => {
    const res = await authDelete('', '/api/push-subscriptions?endpoint=foo');
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHENTICATED');
  });
});

// ---------------------------------------------------------------------
// AC-197 — Cascade on user hard-delete / deactivate retention
// ---------------------------------------------------------------------
describe('User lifecycle interacts with push_subscriptions (AC-197)', () => {
  let ownerToken: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    await stopApp();
  });

  async function subscriptionCount(userId: string): Promise<number> {
    const { db, pool } = createDatabase();
    try {
      const res = await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM push_subscriptions WHERE user_id = ${userId}`,
      );
      return (res.rows[0] as { c: number }).c;
    } finally {
      await pool.end();
    }
  }

  it('hard-deleting a user cascades every owned push_subscription row', async () => {
    // Create a dedicated user so the cascade effect is observable
    // without touching seeded accounts.
    const createUser = await authPost(ownerToken, '/api/users', {
      username: `at105_casc_${Date.now().toString(36)}`,
      displayName: 'AC-197 cascade target',
      password: 'SecurePass2026!',
      roles: ['worker'],
    });
    expect(createUser.statusCode).toBeLessThan(300);
    const user = createUser.json() as { id: string };

    // Log in as that user to register their own subscription (subscribe
    // derives userId from the session — see AC-196).
    const userToken = await login(
      (createUser.json() as { username: string }).username,
      'SecurePass2026!',
    );
    for (const suffix of ['phone', 'desktop']) {
      const subRes = await authPost(userToken, '/api/push-subscriptions', {
        endpoint: `https://push.test.example/at105-${suffix}-${Date.now().toString(36)}`,
        keys: { p256dh: 'p', auth: 'a' },
      });
      expect(subRes.statusCode).toBeLessThan(300);
    }
    expect(await subscriptionCount(user.id)).toBe(2);

    // Hard-delete the user. The FK should cascade the rows.
    const delRes = await authDelete(ownerToken, `/api/users/${user.id}`);
    expect(delRes.statusCode).toBeLessThan(300);
    expect(await subscriptionCount(user.id)).toBe(0);
  });

  it('deactivating a user retains push_subscription rows (dispatch is delivery-time filtered)', async () => {
    // Create a dedicated user and register a subscription.
    const createUser = await authPost(ownerToken, '/api/users', {
      username: `at105_deact_${Date.now().toString(36)}`,
      displayName: 'AC-197 deactivate target',
      password: 'SecurePass2026!',
      roles: ['worker'],
    });
    expect(createUser.statusCode).toBeLessThan(300);
    const user = createUser.json() as { id: string };

    const userToken = await login(
      (createUser.json() as { username: string }).username,
      'SecurePass2026!',
    );
    const subRes = await authPost(userToken, '/api/push-subscriptions', {
      endpoint: `https://push.test.example/at105-deact-${Date.now().toString(36)}`,
      keys: { p256dh: 'p', auth: 'a' },
    });
    expect(subRes.statusCode).toBeLessThan(300);
    expect(await subscriptionCount(user.id)).toBe(1);

    // Deactivate the user — rows MUST remain (deactivation is a soft
    // operation; the rows suspend dispatch, they don't delete).
    const deactivate = await authPost(ownerToken, `/api/users/${user.id}/deactivate`, {});
    expect(deactivate.statusCode).toBeLessThan(300);
    expect(await subscriptionCount(user.id)).toBe(1);
  });
});

// ---------------------------------------------------------------------
// Body validation hardening (fix applied in iteration 8 hardening pass)
// ---------------------------------------------------------------------
describe('push-subscription POST body validation', () => {
  let ownerToken: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    await stopApp();
  });

  it('endpoint exceeding 2048 chars → 422', async () => {
    const res = await authPost(ownerToken, '/api/push-subscriptions', {
      endpoint: `https://push.example.com/${'x'.repeat(2050)}`,
      keys: { p256dh: 'validkey', auth: 'validauth' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('p256dh exceeding 512 chars → 422', async () => {
    const res = await authPost(ownerToken, '/api/push-subscriptions', {
      endpoint: 'https://push.example.com/valid-endpoint',
      keys: { p256dh: 'x'.repeat(513), auth: 'validauth' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('auth exceeding 512 chars → 422', async () => {
    const res = await authPost(ownerToken, '/api/push-subscriptions', {
      endpoint: 'https://push.example.com/valid-endpoint',
      keys: { p256dh: 'validkey', auth: 'x'.repeat(513) },
    });
    expect(res.statusCode).toBe(422);
  });

  it('endpoint missing URI scheme → 422', async () => {
    const res = await authPost(ownerToken, '/api/push-subscriptions', {
      endpoint: 'not-a-uri-just-a-string',
      keys: { p256dh: 'validkey', auth: 'validauth' },
    });
    expect(res.statusCode).toBe(422);
  });
});
