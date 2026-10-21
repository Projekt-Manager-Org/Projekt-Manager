/**
 * API integration tests: worker read scoping (AC-145, AC-146, AC-147, AC-148).
 *
 * Covers the behavior pinned by verification.md §15.21 and realized per
 * ADR-0019:
 *   - AC-145: GET /api/projects — worker sees only assigned projects;
 *             owner/office see all; worker with no assignments sees []
 *   - AC-146: GET /api/customers — worker sees only customers reachable
 *             through assigned non-deleted projects; owner/office see all;
 *             customers reachable only via soft-deleted projects excluded
 *   - AC-147: GET /api/projects/:id — 403 NOT_PERMITTED (not 404) for a
 *             project the worker is not assigned to; 404 for a missing id;
 *             200 for an assigned project
 *   - AC-148: GET /api/customers/:id — 403 NOT_PERMITTED (not 404) for a
 *             customer the worker cannot reach via any assigned non-deleted
 *             project; 404 for a missing id; 200 for a reachable customer
 *
 * Also asserts cross-role regressions: owner, office, and bookkeeper
 * responses are unchanged by scoping. Bookkeeper is classified as unscoped
 * (MVP placeholder per ADR-0019 / api.md §14.3) — these regressions pin
 * that behavior so a future tightening is a deliberate break, not silent.
 *
 * Worker visibility derived from src/server/seed.ts assignments:
 *   arbeiter1 (worker1) → 007, 008, 009, 011
 *   arbeiter2 (worker2) → 007, 009, 010
 *   deaktiviert (inactive worker) → (never logs in; covered via
 *                                   createTestUserSession for "no assignments")
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  startApp,
  stopApp,
  login,
  authGet,
  createTestUserSession,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import { projects } from '../db/schema.js';

const year = new Date().getFullYear();

/** Look up a project id by its seeded "YYYY-NNN" number via owner read. */
async function projectIdByNumber(ownerToken: string, number: string): Promise<string> {
  const res = await authGet(ownerToken, '/api/projects?limit=200');
  expect(res.statusCode).toBe(200);
  const match = (res.json().data as { id: string; number: string }[]).find(
    (p) => p.number === number,
  );
  if (!match) throw new Error(`Seed missing project ${number}`);
  return match.id;
}

/** Look up a customer id by name via owner read. */
async function customerIdByName(ownerToken: string, name: string): Promise<string> {
  const res = await authGet(ownerToken, '/api/customers?limit=200');
  expect(res.statusCode).toBe(200);
  const match = (res.json().customers as { id: string; name: string }[]).find(
    (c) => c.name === name,
  );
  if (!match) throw new Error(`Seed missing customer "${name}"`);
  return match.id;
}

describe('Worker Read Scoping (AC-145, AC-146, AC-147, AC-148)', () => {
  let ownerToken: string;
  let officeToken: string;
  let bookkeeperToken: string;
  let worker1Token: string;
  let unassignedWorkerToken: string;

  // Seeded identifiers collected in beforeAll.
  let worker1AssignedNumbers: string[];
  let worker1AssignedCustomerNames: string[];
  let allProjectNumbers: string[];
  let allCustomerNames: string[];

  beforeAll(async () => {
    await startApp();
    [ownerToken, officeToken, bookkeeperToken, worker1Token] = await Promise.all([
      login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.bookkeeper.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD),
    ]);
    // A worker account created fresh with no project_workers rows. Anchors
    // the "empty list" branch of AC-145 without mutating the seed.
    const unassigned = await createTestUserSession({
      roles: ['worker'],
      displayName: 'Unassigned Worker',
    });
    unassignedWorkerToken = unassigned.token;

    // Derive ground truth from the owner's (unscoped) view once.
    worker1AssignedNumbers = [`${year}-007`, `${year}-008`, `${year}-009`, `${year}-011`];
    worker1AssignedCustomerNames = [
      'Evangelische Gemeinde Refrath',
      'Frau Klein',
      'Dr. Braun Zahnarztpraxis',
      'Café Sonnenschein GbR',
    ];
    const ownerProjects = (await authGet(ownerToken, '/api/projects?limit=200')).json().data as {
      number: string;
    }[];
    const ownerCustomers = (await authGet(ownerToken, '/api/customers?limit=200')).json()
      .customers as { name: string }[];
    allProjectNumbers = ownerProjects.map((p) => p.number).sort();
    allCustomerNames = ownerCustomers.map((c) => c.name).sort();
  });

  afterAll(async () => {
    await stopApp();
  });

  // ---------------------------------------------------------------
  // AC-145: GET /api/projects — scoped for worker, unscoped for
  // owner / office, empty for unassigned worker.
  // ---------------------------------------------------------------
  describe('AC-145: GET /api/projects scoped by assignment', () => {
    it('worker sees only projects they are assigned to', async () => {
      const res = await authGet(worker1Token, '/api/projects?limit=200');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const returnedNumbers = (body.data as { number: string }[]).map((p) => p.number).sort();
      expect(returnedNumbers).toEqual([...worker1AssignedNumbers].sort());
      expect(body.total).toBe(worker1AssignedNumbers.length);
    });

    it('worker with no assignments sees an empty list', async () => {
      const res = await authGet(unassignedWorkerToken, '/api/projects?limit=200');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    // Unscoped roles share identical list behavior — owner/office by
    // design, bookkeeper as an MVP placeholder (ADR-0019, api.md §14.3).
    // Parametrized so adding / reclassifying a role is a one-line change
    // and the assertion never drifts between roles.
    describe.each([
      ['owner', () => ownerToken],
      ['office', () => officeToken],
      ['bookkeeper', () => bookkeeperToken],
    ] as const)('%s sees every non-deleted project (regression — unscoped)', (_label, getToken) => {
      it('returns the full project list', async () => {
        const res = await authGet(getToken(), '/api/projects?limit=200');
        expect(res.statusCode).toBe(200);
        const returnedNumbers = (res.json().data as { number: string }[])
          .map((p) => p.number)
          .sort();
        expect(returnedNumbers).toEqual(allProjectNumbers);
      });
    });
  });

  // ---------------------------------------------------------------
  // AC-146: GET /api/customers — scoped for worker via assigned
  // non-deleted projects; owner / office unchanged.
  // ---------------------------------------------------------------
  describe('AC-146: GET /api/customers scoped by assignment', () => {
    it('worker sees only customers linked through assigned projects', async () => {
      const res = await authGet(worker1Token, '/api/customers?limit=200');
      expect(res.statusCode).toBe(200);
      const names = (res.json().customers as { name: string }[]).map((c) => c.name).sort();
      expect(names).toEqual([...worker1AssignedCustomerNames].sort());
    });

    it('excludes a customer reachable only through a soft-deleted project', async () => {
      // Soft-delete the current year's -011 project (Café Sonnenschein) —
      // worker1's only project for that customer. Expect the customer to
      // vanish from the worker's list while remaining in owner's (AC-146
      // parity clause). Direct-DB mutation per ADR-0018.
      const cafeProjectId = await projectIdByNumber(ownerToken, `${year}-011`);
      const { db, pool } = createDatabase();
      try {
        await db.update(projects).set({ deleted: true }).where(eq(projects.id, cafeProjectId));

        const workerRes = await authGet(worker1Token, '/api/customers?limit=200');
        const workerNames = (workerRes.json().customers as { name: string }[]).map((c) => c.name);
        expect(workerNames).not.toContain('Café Sonnenschein GbR');
        // Sanity: other assigned customers still visible.
        expect(workerNames).toContain('Evangelische Gemeinde Refrath');

        // Owner still sees every customer — the soft-delete of a project
        // must not cascade into the owner's customer list (parity clause
        // to AC-145's "every non-deleted project" for owner/office).
        const ownerRes = await authGet(ownerToken, '/api/customers?limit=200');
        const ownerNames = (ownerRes.json().customers as { name: string }[])
          .map((c) => c.name)
          .sort();
        expect(ownerNames).toEqual(allCustomerNames);
      } finally {
        // Restore so later tests in this file see the full seed. Other
        // files start fresh via seed(force:true) in their beforeAll.
        await db.update(projects).set({ deleted: false }).where(eq(projects.id, cafeProjectId));
        await pool.end();
      }
    });

    describe.each([
      ['owner', () => ownerToken],
      ['office', () => officeToken],
      ['bookkeeper', () => bookkeeperToken],
    ] as const)('%s sees every customer (regression — unscoped)', (_label, getToken) => {
      it('returns the full customer list', async () => {
        const res = await authGet(getToken(), '/api/customers?limit=200');
        expect(res.statusCode).toBe(200);
        const names = (res.json().customers as { name: string }[]).map((c) => c.name).sort();
        expect(names).toEqual(allCustomerNames);
      });
    });
  });

  // ---------------------------------------------------------------
  // AC-147: GET /api/projects/:id — 200 / 403 / 404.
  // ---------------------------------------------------------------
  describe('AC-147: GET /api/projects/:id distinguishes 403 from 404', () => {
    it('worker receives 403 NOT_PERMITTED for a project they are not assigned to', async () => {
      // 2024-001 is an "anfrage" project with no worker assignments.
      const id = await projectIdByNumber(ownerToken, `${year}-001`);
      const res = await authGet(worker1Token, `/api/projects/${id}`);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('worker receives 404 NOT_FOUND for an id that does not exist', async () => {
      const res = await authGet(worker1Token, '/api/projects/00000000-0000-0000-0000-000000000000');
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });

    it('worker receives 200 for a project they are assigned to', async () => {
      const id = await projectIdByNumber(ownerToken, `${year}-008`);
      const res = await authGet(worker1Token, `/api/projects/${id}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(id);
    });

    describe.each([
      ['owner', () => ownerToken],
      ['office', () => officeToken],
      ['bookkeeper', () => bookkeeperToken],
    ] as const)(
      '%s receives 200 for any existing project (regression — unscoped)',
      (_label, getToken) => {
        it('returns 200 for a project no scoped role would see', async () => {
          // 2024-001 is an "anfrage" project with no worker assignments — a
          // scoped caller would get 403 here. Unscoped roles must see it.
          const id = await projectIdByNumber(ownerToken, `${year}-001`);
          const res = await authGet(getToken(), `/api/projects/${id}`);
          expect(res.statusCode).toBe(200);
          expect(res.json().id).toBe(id);
        });
      },
    );
  });

  // ---------------------------------------------------------------
  // AC-148: GET /api/customers/:id — 200 / 403 / 404.
  // ---------------------------------------------------------------
  describe('AC-148: GET /api/customers/:id distinguishes 403 from 404', () => {
    it('worker receives 403 NOT_PERMITTED for a customer not reachable through assignments', async () => {
      // "Familie Müller" only appears on 2024-001 (anfrage, unassigned) —
      // worker1 has no path to it.
      const id = await customerIdByName(ownerToken, 'Familie Müller');
      const res = await authGet(worker1Token, `/api/customers/${id}`);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('worker receives 404 NOT_FOUND for an id that does not exist', async () => {
      const res = await authGet(
        worker1Token,
        '/api/customers/00000000-0000-0000-0000-000000000000',
      );
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });

    it('worker receives 200 for a customer reachable through an assigned project', async () => {
      // "Frau Klein" → 2024-008 (worker1 assigned).
      const id = await customerIdByName(ownerToken, 'Frau Klein');
      const res = await authGet(worker1Token, `/api/customers/${id}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(id);
    });

    describe.each([
      ['owner', () => ownerToken],
      ['office', () => officeToken],
      ['bookkeeper', () => bookkeeperToken],
    ] as const)(
      '%s receives 200 for any existing customer (regression — unscoped)',
      (_label, getToken) => {
        it('returns 200 for a customer no scoped role would reach', async () => {
          // "Familie Müller" sits on an unassigned anfrage project only — a
          // scoped caller would get 403. Unscoped roles must see it.
          const id = await customerIdByName(ownerToken, 'Familie Müller');
          const res = await authGet(getToken(), `/api/customers/${id}`);
          expect(res.statusCode).toBe(200);
          expect(res.json().id).toBe(id);
        });
      },
    );
  });

  // ---------------------------------------------------------------
  // getCustomer.projectCount is scoped to the caller's assignment
  // graph. A worker assigned to 1 of N projects for a customer sees
  // projectCount: 1; unscoped callers see N. Direct-DB setup per
  // ADR-0018 — the API has no "create extra project for this
  // customer, but don't assign the worker" helper, and building one
  // would be more complex than the assertion it supports.
  // ---------------------------------------------------------------
  describe('getCustomer.projectCount is scoped to assignments', () => {
    it('worker sees 1 when assigned to 1 of 2 projects; unscoped callers see 2', async () => {
      // Customer: Evangelische Gemeinde Refrath — already has project
      // YYYY-007 with worker1 assigned. We add a second project for the
      // same customer WITHOUT assigning worker1.
      const refrathId = await customerIdByName(ownerToken, 'Evangelische Gemeinde Refrath');
      const { db, pool } = createDatabase();
      try {
        const extraProject = await db
          .insert(projects)
          .values({
            number: `${year}-999`, // does not collide with seed (019 is last)
            title: 'Extra unassigned project (m1 regression)',
            status: 'anfrage',
            customerId: refrathId,
          })
          .returning({ id: projects.id });
        const extraId = extraProject[0]!.id;

        try {
          const workerRes = await authGet(worker1Token, `/api/customers/${refrathId}`);
          expect(workerRes.statusCode).toBe(200);
          expect(workerRes.json().projectCount).toBe(1);

          // Owner sees both active projects; the unscoped count is
          // unaffected by caller identity.
          const ownerRes = await authGet(ownerToken, `/api/customers/${refrathId}`);
          expect(ownerRes.statusCode).toBe(200);
          expect(ownerRes.json().projectCount).toBe(2);

          // Bookkeeper is unscoped too (MVP placeholder) — same count
          // as owner, pinning the classification.
          const bookkeeperRes = await authGet(bookkeeperToken, `/api/customers/${refrathId}`);
          expect(bookkeeperRes.statusCode).toBe(200);
          expect(bookkeeperRes.json().projectCount).toBe(2);
        } finally {
          await db.delete(projects).where(eq(projects.id, extraId));
        }
      } finally {
        await pool.end();
      }
    });
  });
});
