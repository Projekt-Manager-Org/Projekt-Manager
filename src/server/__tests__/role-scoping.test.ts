/**
 * API integration tests: worker read scoping (verification.md §15.21,
 * realized per ADR-0019):
 *   - AC-579: worker project list — assigned projects only, [] for none
 *   - AC-580: worker customer list — customers of assigned non-archived
 *             projects only
 *   - AC-581, AC-582: a worker's read of an unassigned project or
 *             unreachable customer is 403 NOT_PERMITTED, not 404
 *   - AC-577: owner, office and bookkeeper are unscoped, and so is a user
 *             holding one of them beside `worker`
 *   - AC-578: a worker's customer read reveals nothing beyond the
 *             worker's assigned projects
 *   - AC-542: a worker's archived-project read withholds customer details
 *
 * Worker visibility derived from src/server/seed.ts assignments:
 *   arbeiter1 (worker1) → 007, 008, 009, 011
 *   arbeiter2 (worker2) → 007, 009, 010
 *   deaktiviert (inactive worker) → (never logs in; covered via
 *                                   createTestUserSession for "no assignments")
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  startApp,
  stopApp,
  login,
  authGet,
  authPost,
  createTestUserSession,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import { projects, projectWorkers, users } from '../db/schema.js';

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

describe('Worker Read Scoping', () => {
  let ownerToken: string;
  let officeToken: string;
  let bookkeeperToken: string;
  let worker1Token: string;
  let unassignedWorkerToken: string;
  // Holds `owner` and `worker`, with no assignments: a scoped caller would
  // see nothing (AC-577).
  let ownerWorkerToken: string;
  let ownerWorkerId: string;

  // Every unscoped caller shares the same reads (AC-577). One list, so
  // adding or reclassifying a role is a one-line change.
  const UNSCOPED_CALLERS = [
    ['owner', () => ownerToken],
    ['office', () => officeToken],
    ['bookkeeper', () => bookkeeperToken],
    ['owner + worker', () => ownerWorkerToken],
  ] as const;

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
    // the "empty list" branch of AC-579 without mutating the seed.
    const unassigned = await createTestUserSession({
      roles: ['worker'],
      displayName: 'Unassigned Worker',
    });
    unassignedWorkerToken = unassigned.token;
    const ownerWorker = await createTestUserSession({
      roles: ['owner', 'worker'],
      displayName: 'Owner Worker',
    });
    ownerWorkerToken = ownerWorker.token;
    ownerWorkerId = ownerWorker.userId;

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
  // AC-579: GET /api/projects — scoped for worker, unscoped for
  // owner / office, empty for unassigned worker.
  // ---------------------------------------------------------------
  describe('GET /api/projects scoped by assignment', () => {
    it('AC-579: worker sees only projects they are assigned to', async () => {
      const res = await authGet(worker1Token, '/api/projects?limit=200');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const returnedNumbers = (body.data as { number: string }[]).map((p) => p.number).sort();
      expect(returnedNumbers).toEqual([...worker1AssignedNumbers].sort());
      expect(body.total).toBe(worker1AssignedNumbers.length);
    });

    it('AC-579: worker with no assignments sees an empty list', async () => {
      const res = await authGet(unassignedWorkerToken, '/api/projects?limit=200');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    describe.each(UNSCOPED_CALLERS)(
      'AC-577: %s sees every non-deleted project',
      (_label, getToken) => {
        it('returns the full project list', async () => {
          const res = await authGet(getToken(), '/api/projects?limit=200');
          expect(res.statusCode).toBe(200);
          const returnedNumbers = (res.json().data as { number: string }[])
            .map((p) => p.number)
            .sort();
          expect(returnedNumbers).toEqual(allProjectNumbers);
        });
      },
    );
  });

  // ---------------------------------------------------------------
  // AC-580: GET /api/customers — scoped for worker via assigned
  // non-deleted projects; owner / office unchanged.
  // ---------------------------------------------------------------
  describe('GET /api/customers scoped by assignment', () => {
    it('AC-580: worker sees only customers linked through assigned projects', async () => {
      const res = await authGet(worker1Token, '/api/customers?limit=200');
      expect(res.statusCode).toBe(200);
      const names = (res.json().customers as { name: string }[]).map((c) => c.name).sort();
      expect(names).toEqual([...worker1AssignedCustomerNames].sort());
    });

    it('AC-580: excludes a customer reachable only through a soft-deleted project', async () => {
      // Soft-delete the current year's -011 project (Café Sonnenschein) —
      // worker1's only project for that customer. Expect the customer to
      // vanish from the worker's list while remaining in owner's (AC-577). Direct-DB mutation per ADR-0018.
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
        // must not cascade into the owner's customer list (AC-577).
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

    describe.each(UNSCOPED_CALLERS)('AC-577: %s sees every customer', (_label, getToken) => {
      it('returns the full customer list', async () => {
        const res = await authGet(getToken(), '/api/customers?limit=200');
        expect(res.statusCode).toBe(200);
        const names = (res.json().customers as { name: string }[]).map((c) => c.name).sort();
        expect(names).toEqual(allCustomerNames);
      });
    });
  });

  // ---------------------------------------------------------------
  // AC-581: GET /api/projects/:id — 200 / 403 / 404.
  // ---------------------------------------------------------------
  describe('GET /api/projects/:id distinguishes 403 from 404', () => {
    it('AC-581: worker receives 403 NOT_PERMITTED for a project they are not assigned to', async () => {
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

    describe.each(UNSCOPED_CALLERS)(
      'AC-577: %s receives 200 for any existing project',
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
  // Invoices follow the same classification: the scope backstop must not
  // empty the list of a caller who holds `invoice:read` through `owner`.
  // ---------------------------------------------------------------
  it('AC-576, AC-577: an owner who also holds worker lists every invoice', async () => {
    const owner = await authGet(ownerToken, '/api/invoices?limit=500');
    const ownerWorker = await authGet(ownerWorkerToken, '/api/invoices?limit=500');

    expect(ownerWorker.statusCode).toBe(200);
    expect(owner.json().total).toBeGreaterThan(0);
    expect(ownerWorker.json().total).toBe(owner.json().total);
  });

  // ---------------------------------------------------------------
  // AC-582: GET /api/customers/:id — 200 / 403 / 404.
  // ---------------------------------------------------------------
  describe('GET /api/customers/:id distinguishes 403 from 404', () => {
    it('AC-582: worker receives 403 NOT_PERMITTED for a customer not reachable through assignments', async () => {
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

    describe.each(UNSCOPED_CALLERS)(
      'AC-577: %s receives 200 for any existing customer',
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
  // A worker reaches an archived project they are assigned to, but its
  // customer is readable only through an active one.
  // ---------------------------------------------------------------
  describe("a project's nested customer detail", () => {
    const CUSTOMER_DETAIL = {
      phone: '0221-1',
      email: 'a@b.de',
      address: { street: 'Hauptstr. 1', zip: '50667', city: 'Köln' },
      ustId: 'DE123123123',
      notes: 'Nur intern',
    };
    const WITHHELD = { phone: null, email: null, ustId: null, notes: null };

    async function assignedProject(
      deleted: boolean,
      siteAddress: { street: string; zip: string; city: string } | null = null,
      assigneeId?: string,
    ): Promise<string> {
      const customer = await authPost(ownerToken, '/api/customers', {
        name: `Nested Scope ${crypto.randomUUID().slice(0, 8)}`,
        ...CUSTOMER_DETAIL,
      });
      const { db, pool } = createDatabase();
      try {
        const [worker] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.username, SEED_USERS.worker1.username));
        const [project] = await db
          .insert(projects)
          .values({
            number: `NS-${crypto.randomUUID().slice(0, 8)}`,
            title: 'Nested scope fixture',
            status: 'anfrage',
            customerId: customer.json().id,
            deleted,
            siteAddress,
          })
          .returning({ id: projects.id });
        await db
          .insert(projectWorkers)
          .values({ projectId: project!.id, userId: assigneeId ?? worker!.id });
        return project!.id;
      } finally {
        await pool.end();
      }
    }

    it('AC-542: is withheld from a worker on an archived project, except the name', async () => {
      const id = await assignedProject(true, { street: 'Bauweg 2', zip: '50668', city: 'Köln' });

      const detail = await authGet(worker1Token, `/api/projects/${id}`);
      expect(detail.statusCode).toBe(200);
      expect(detail.json().customer).toMatchObject({ ...WITHHELD, address: null });
      expect(detail.json().customer.name).toMatch(/^Nested Scope/);

      const list = await authGet(worker1Token, '/api/projects?includeArchived=true&limit=200');
      const row = (list.json().data as { id: string; customer: object }[]).find((p) => p.id === id);
      expect(row?.customer).toMatchObject({ ...WITHHELD, address: null });

      // The customer-search list takes a separate query path.
      const number = detail.json().number as string;
      const searched = await authGet(
        worker1Token,
        `/api/projects?includeArchived=true&search=${number}`,
      );
      expect(searched.json().data[0].customer).toMatchObject({ ...WITHHELD, address: null });
    });

    it("AC-542: keeps the customer's address when it is the project's site", async () => {
      const id = await assignedProject(true);

      const res = await authGet(worker1Token, `/api/projects/${id}`);

      expect(res.json().customer).toMatchObject({
        ...WITHHELD,
        address: CUSTOMER_DETAIL.address,
      });
    });

    it('AC-542: reaches a worker on an active project', async () => {
      const id = await assignedProject(false);

      const res = await authGet(worker1Token, `/api/projects/${id}`);

      expect(res.json().customer).toMatchObject(CUSTOMER_DETAIL);
    });

    it('AC-542: reaches an unscoped caller on an archived project', async () => {
      const id = await assignedProject(true);

      const res = await authGet(ownerToken, `/api/projects/${id}`);

      expect(res.json().customer).toMatchObject(CUSTOMER_DETAIL);
    });

    // Assigned, so the project itself is in reach either way: only the
    // classification decides whether the details are withheld.
    it('AC-542, AC-577: reaches an owner who also holds worker on an archived project', async () => {
      const id = await assignedProject(true, null, ownerWorkerId);

      const res = await authGet(ownerWorkerToken, `/api/projects/${id}`);

      expect(res.json().customer).toMatchObject(CUSTOMER_DETAIL);
    });
  });

  // ---------------------------------------------------------------
  // getCustomer exposes only counts scoped to the caller's assignment
  // graph (ADR-0019). Direct-DB setup per ADR-0018 — the API has no
  // "create extra project for this customer, but don't assign the
  // worker" helper, and building one would be more complex than the
  // assertion it supports.
  // ---------------------------------------------------------------
  describe('getCustomer counts are scoped to assignments', () => {
    it('AC-578: a worker count excludes archived projects not assigned to them; unscoped callers count all', async () => {
      // Customer: Evangelische Gemeinde Refrath — already has project
      // YYYY-007 with worker1 assigned. We add an archived project for
      // the same customer WITHOUT assigning worker1.
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
            deleted: true,
          })
          .returning({ id: projects.id });
        const extraId = extraProject[0]!.id;

        try {
          const workerRes = await authGet(worker1Token, `/api/customers/${refrathId}`);
          expect(workerRes.statusCode).toBe(200);
          expect(workerRes.json().archivedProjectCount).toBe(0);

          // Owner sees the archived project; the unscoped count is
          // unaffected by caller identity.
          const ownerRes = await authGet(ownerToken, `/api/customers/${refrathId}`);
          expect(ownerRes.statusCode).toBe(200);
          expect(ownerRes.json().archivedProjectCount).toBe(1);

          // Bookkeeper is unscoped too (AC-577) — same count
          // as owner, pinning the classification.
          const bookkeeperRes = await authGet(bookkeeperToken, `/api/customers/${refrathId}`);
          expect(bookkeeperRes.statusCode).toBe(200);
          expect(bookkeeperRes.json().archivedProjectCount).toBe(1);

          // So is an owner who also holds worker (AC-577).
          const ownerWorkerRes = await authGet(ownerWorkerToken, `/api/customers/${refrathId}`);
          expect(ownerWorkerRes.statusCode).toBe(200);
          expect(ownerWorkerRes.json().archivedProjectCount).toBe(1);
        } finally {
          await db.delete(projects).where(eq(projects.id, extraId));
        }
      } finally {
        await pool.end();
      }
    });

    // The invoice count ignored the caller's assignments, and a worker
    // holds no `invoice:read`.
    it("a worker's response carries no invoice count", async () => {
      const refrathId = await customerIdByName(ownerToken, 'Evangelische Gemeinde Refrath');

      const res = await authGet(worker1Token, `/api/customers/${refrathId}`);

      expect(res.statusCode).toBe(200);
      expect(res.json()).not.toHaveProperty('invoiceCount');
    });
  });
});
