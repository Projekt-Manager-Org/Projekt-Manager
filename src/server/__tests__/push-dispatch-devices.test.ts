/**
 * Push dispatch across a recipient's devices — AC-645 and AC-647 in §15.24.
 *
 * A recording transport replaces the no-op one for this file, so the test
 * sees each device the publisher pushes to. A `backup.failed` system event
 * has no actor (AC-321), so the rule's recipients (owner, office) are
 * always pushed.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';

import { startApp, stopApp, login, authPost } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import {
  publishSystemEvent,
  registerNotificationPublisher,
} from '../services/notification-publisher.js';
import type { PushDispatcher, PushDispatchStatus } from '../services/PushDispatcher.js';

const conn = createDatabase();
let ownerToken: string;
let officeToken: string;
let ownerId: string;
let officeId: string;

/** Endpoints the transport was asked to push to, in order. */
const attempted: string[] = [];
/** When set, decides the outcome for each push; otherwise every push succeeds. */
let outcome: ((callIndex: number) => PushDispatchStatus | 'throw') | null = null;

const recordingDispatcher: PushDispatcher = {
  async send(target) {
    attempted.push(target.endpoint);
    const result = outcome?.(attempted.length - 1) ?? 'ok';
    if (result === 'throw') throw new Error('push service unreachable');
    return result;
  },
};

beforeAll(async () => {
  await startApp();
  registerNotificationPublisher({ db: conn.db, dispatcher: recordingDispatcher });
  ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  officeToken = await login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD);
  const rows = await conn.db.execute(
    sql`SELECT id, username FROM users
        WHERE username IN (${SEED_USERS.owner.username}, ${SEED_USERS.office.username})`,
  );
  const idOf = new Map(
    (rows.rows as { id: string; username: string }[]).map((r) => [r.username, r.id]),
  );
  ownerId = idOf.get(SEED_USERS.owner.username)!;
  officeId = idOf.get(SEED_USERS.office.username)!;

  const rule = await authPost(ownerToken, '/api/notification-rules', {
    eventClass: 'backup.failed',
    recipientSpec: { roles: [], includeAssignedWorkers: false, userIds: [ownerId, officeId] },
    enabled: true,
  });
  expect(rule.statusCode).toBe(201);
});

beforeEach(async () => {
  attempted.length = 0;
  outcome = null;
  await conn.db.execute(sql`DELETE FROM push_subscriptions`);
});

afterAll(async () => {
  await stopApp();
  await conn.pool.end();
});

async function registerDevices(token: string, ...labels: string[]): Promise<string[]> {
  const endpoints: string[] = [];
  for (const label of labels) {
    const endpoint = `https://push.test.example/devices-${label}-${Date.now().toString(36)}`;
    const res = await authPost(token, '/api/push-subscriptions', {
      endpoint,
      keys: { p256dh: 'p', auth: 'a' },
    });
    expect(res.statusCode).toBeLessThan(300);
    endpoints.push(endpoint);
  }
  return endpoints.sort();
}

describe('AC-645: an event is pushed to every device its recipients registered', () => {
  it("pushes each of every recipient's devices once", async () => {
    const ownerDevices = await registerDevices(ownerToken, 'phone', 'laptop');
    const officeDevices = await registerDevices(officeToken, 'office-pc');
    const devices = [...ownerDevices, ...officeDevices].sort();

    await publishSystemEvent({ eventClass: 'backup.failed', payload: { reason: 'backup-stale' } });

    expect([...attempted].sort()).toEqual(devices);
  });
});

describe('AC-647: a failing device does not stop pushes to the others', () => {
  it('still pushes the other devices when the first push throws', async () => {
    const devices = await registerDevices(ownerToken, 'a', 'b');
    outcome = (i) => (i === 0 ? 'throw' : 'ok');

    await publishSystemEvent({ eventClass: 'backup.failed', payload: { reason: 'backup-stale' } });

    expect([...attempted].sort()).toEqual(devices);
  });

  it('still pushes the other devices when the first push reports an error', async () => {
    const devices = await registerDevices(ownerToken, 'c', 'd');
    outcome = (i) => (i === 0 ? 'error' : 'ok');

    await publishSystemEvent({ eventClass: 'backup.failed', payload: { reason: 'backup-stale' } });

    expect([...attempted].sort()).toEqual(devices);
  });
});
