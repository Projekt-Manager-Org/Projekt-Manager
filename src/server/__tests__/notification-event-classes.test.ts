/**
 * AC-643 for the project event classes other than `project.attachment_added`
 * (that one is in `attachment-added-notification.test.ts`): each change a
 * class names (data-model.md §5.11) fires exactly one event of that class.
 *
 * One enabled rule per class names the owner; office makes the changes,
 * so the actor is not the recipient. The class of a dispatched event is
 * read from the rule it matched.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';

import {
  startApp,
  stopApp,
  login,
  authGet,
  authPost,
  authPatch,
  authDelete,
  seedProjectStatus,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import { onEventDispatched } from '../services/notification-publisher.js';

const CLASSES = [
  'project.transition_forward',
  'project.transition_backward',
  'project.archived',
  'project.assignment_changed',
  // Counted only, so a change that wrongly fires it fails the test.
  'project.attachment_added',
] as const;
type ProjectClass = (typeof CLASSES)[number];

let ownerToken: string;
let officeToken: string;
let ownerId: string;
let worker1Id: string;
let customerId: string;
const ruleIdOf = new Map<ProjectClass, string>();
let fixtureCounter = 0;

beforeAll(async () => {
  await startApp();
  ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  officeToken = await login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD);

  const { db, pool } = createDatabase();
  try {
    const rows = await db.execute(
      sql`SELECT id, username FROM users
          WHERE username IN (${SEED_USERS.owner.username}, ${SEED_USERS.worker1.username})`,
    );
    const byUsername = new Map(
      (rows.rows as { id: string; username: string }[]).map((r) => [r.username, r.id]),
    );
    ownerId = byUsername.get(SEED_USERS.owner.username)!;
    worker1Id = byUsername.get(SEED_USERS.worker1.username)!;
  } finally {
    await pool.end();
  }

  const custRes = await authGet(ownerToken, '/api/customers');
  const customers = (custRes.json().customers ?? custRes.json().data) as { id: string }[];
  customerId = customers[0]!.id;
});

beforeEach(async () => {
  const { db, pool } = createDatabase();
  try {
    await db.execute(sql`DELETE FROM notification_rule`);
  } finally {
    await pool.end();
  }
  ruleIdOf.clear();
  for (const eventClass of CLASSES) {
    const res = await authPost(ownerToken, '/api/notification-rules', {
      eventClass,
      recipientSpec: { roles: [], includeAssignedWorkers: false, userIds: [ownerId] },
      enabled: true,
    });
    expect(res.statusCode).toBe(201);
    ruleIdOf.set(eventClass, (res.json() as { id: string }).id);
  }
});

afterAll(async () => {
  await stopApp();
});

async function createProject(status: 'beauftragt'): Promise<string> {
  fixtureCounter += 1;
  const res = await authPost(ownerToken, '/api/projects', {
    number: `AC643-${Date.now().toString(36)}-${fixtureCounter}`,
    title: 'AC-643 fixture',
    customerId,
  });
  expect(res.statusCode).toBe(201);
  const id = (res.json() as { id: string }).id;
  await seedProjectStatus(id, status);
  return id;
}

/** Run `change` and count the events it fires per class. */
async function eventsFiredBy(change: () => Promise<void>): Promise<Record<ProjectClass, number>> {
  const counts = Object.fromEntries(CLASSES.map((c) => [c, 0])) as Record<ProjectClass, number>;
  const unsubscribe = onEventDispatched((o) => {
    for (const eventClass of CLASSES) {
      if (o.ruleMatches.includes(ruleIdOf.get(eventClass)!)) counts[eventClass] += 1;
    }
  });
  try {
    await change();
  } finally {
    unsubscribe();
  }
  return counts;
}

function only(eventClass: ProjectClass): Record<ProjectClass, number> {
  return Object.fromEntries(CLASSES.map((c) => [c, c === eventClass ? 1 : 0])) as Record<
    ProjectClass,
    number
  >;
}

describe('AC-643: each project change fires one event of its class', () => {
  it('a forward status move fires one project.transition_forward', async () => {
    const id = await createProject('beauftragt');
    const counts = await eventsFiredBy(async () => {
      const res = await authPost(officeToken, `/api/projects/${id}/transition/forward`, {
        expectedStatus: 'beauftragt',
      });
      expect(res.statusCode).toBe(200);
    });
    expect(counts).toEqual(only('project.transition_forward'));
  });

  it('a backward status move fires one project.transition_backward', async () => {
    const id = await createProject('beauftragt');
    const counts = await eventsFiredBy(async () => {
      const res = await authPost(officeToken, `/api/projects/${id}/transition/backward`, {
        expectedStatus: 'beauftragt',
      });
      expect(res.statusCode).toBe(200);
    });
    expect(counts).toEqual(only('project.transition_backward'));
  });

  it('archiving fires one project.archived', async () => {
    const id = await createProject('beauftragt');
    const counts = await eventsFiredBy(async () => {
      const res = await authDelete(officeToken, `/api/projects/${id}`);
      expect(res.statusCode).toBeLessThan(300);
    });
    expect(counts).toEqual(only('project.archived'));
  });

  it('assigning a worker and removing them each fire one project.assignment_changed', async () => {
    const id = await createProject('beauftragt');

    const assigned = await eventsFiredBy(async () => {
      const res = await authPatch(officeToken, `/api/projects/${id}`, {
        assignedWorkerIds: [worker1Id],
      });
      expect(res.statusCode).toBe(200);
    });
    expect(assigned).toEqual(only('project.assignment_changed'));

    const removed = await eventsFiredBy(async () => {
      const res = await authPatch(officeToken, `/api/projects/${id}`, { assignedWorkerIds: [] });
      expect(res.statusCode).toBe(200);
    });
    expect(removed).toEqual(only('project.assignment_changed'));
  });
});
