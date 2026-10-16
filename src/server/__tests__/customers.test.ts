/**
 * API integration tests: Customer CRUD operations.
 *
 * Tests AT-23 to AT-26 from the test specification (verification.md §16.3).
 * Runs against a real test database via Fastify inject (no network).
 *
 * These tests are written ahead of the implementation (TDD). They define
 * the API contract for the customers entity introduced in iteration 6.
 *
 * Route conventions (inferred from existing patterns):
 *   GET    /api/customers           → list customers (with search, pagination)
 *   GET    /api/customers/:id       → get single customer (with project count)
 *   POST   /api/customers           → create customer
 *   PATCH  /api/customers/:id       → update customer (PATCH semantics)
 *
 * Permission model:
 *   - All authenticated users can read customers (customer:read)
 *   - owner and office can create/update (customer:write)
 *   - owner can delete customers without projects (customer:delete) — see data-model.md §5.6
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startApp,
  stopApp,
  login,
  authGet,
  authPost,
  authPatch,
  authDelete,
  expectedVersion,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';

describe('Customer CRUD Operations', () => {
  let ownerToken: string;
  let workerToken: string;

  /** ID of a customer created in AT-23, used by subsequent tests. */
  let createdCustomerId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    workerToken = await login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    await stopApp();
  });

  // ---------------------------------------------------------------
  // AT-23: Create customer with a name → generated ID
  // ---------------------------------------------------------------
  describe('AT-23: Create customer', () => {
    it('returns 201 with a customer object containing a generated ID', async () => {
      const res = await authPost(ownerToken, '/api/customers', {
        name: 'Familie Testmann',
      });

      expect(res.statusCode).toBe(201);

      const customer = res.json();
      expect(customer.id).toBeDefined();
      expect(typeof customer.id).toBe('string');
      expect(customer.name).toBe('Familie Testmann');
      expect(customer.createdAt).toBeDefined();
      expect(customer.updatedAt).toBeDefined();

      createdCustomerId = customer.id;
    });

    it('accepts all optional fields', async () => {
      const res = await authPost(ownerToken, '/api/customers', {
        name: 'Schmidt GmbH Test',
        phone: '0221-1234567',
        email: 'kontakt@schmidt-test.de',
        address: {
          street: 'Industriestr. 42',
          zip: '50667',
          city: 'Köln',
        },
        notes: 'Bestandskunde seit 2020',
      });

      expect(res.statusCode).toBe(201);

      const customer = res.json();
      expect(customer.name).toBe('Schmidt GmbH Test');
      expect(customer.phone).toBe('0221-1234567');
      expect(customer.email).toBe('kontakt@schmidt-test.de');
      expect(customer.address).toEqual({
        street: 'Industriestr. 42',
        zip: '50667',
        city: 'Köln',
      });
      expect(customer.notes).toBe('Bestandskunde seit 2020');
    });

    it('defaults optional fields to null', async () => {
      const res = await authPost(ownerToken, '/api/customers', {
        name: 'Minimal Kunde',
      });

      expect(res.statusCode).toBe(201);

      const customer = res.json();
      expect(customer.phone).toBeNull();
      expect(customer.email).toBeNull();
      expect(customer.address).toBeNull();
      expect(customer.notes).toBeNull();
    });

    it('requires name — rejects when missing', async () => {
      const res = await authPost(ownerToken, '/api/customers', {
        phone: '0221-0000000',
      });

      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    });

    it('requires customer:write permission — worker is rejected', async () => {
      const res = await authPost(workerToken, '/api/customers', {
        name: 'Worker Should Not Create',
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });
  });

  // ---------------------------------------------------------------
  // AT-24: Update customer — PATCH semantics
  // AC-55 [crit]
  // ---------------------------------------------------------------
  describe('AT-24: Update customer (PATCH semantics)', () => {
    it('changes only the specified fields, preserves others', async () => {
      // Read before state
      const beforeRes = await authGet(ownerToken, `/api/customers/${createdCustomerId}`);
      expect(beforeRes.statusCode).toBe(200);

      const res = await authPatch(ownerToken, `/api/customers/${createdCustomerId}`, {
        ...(await expectedVersion(ownerToken, `/api/customers/${createdCustomerId}`)),
        phone: '0170-9876543',
      });

      expect(res.statusCode).toBe(200);

      const after = res.json();
      // Changed
      expect(after.phone).toBe('0170-9876543');
      // Preserved
      expect(after.name).toBe('Familie Testmann');

      // Audit field updated
      expect(after.updatedAt).toBeDefined();
    });

    it('clears an optional field when set to null', async () => {
      // First set a phone number
      await authPatch(ownerToken, `/api/customers/${createdCustomerId}`, {
        ...(await expectedVersion(ownerToken, `/api/customers/${createdCustomerId}`)),
        email: 'test@example.de',
      });

      // Then clear it
      const res = await authPatch(ownerToken, `/api/customers/${createdCustomerId}`, {
        ...(await expectedVersion(ownerToken, `/api/customers/${createdCustomerId}`)),
        email: null,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().email).toBeNull();
    });

    it('requires customer:write permission — worker is rejected', async () => {
      const res = await authPatch(workerToken, `/api/customers/${createdCustomerId}`, {
        ...(await expectedVersion(ownerToken, `/api/customers/${createdCustomerId}`)),
        phone: '0170-0000000',
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });
  });

  // ---------------------------------------------------------------
  // AT-25: List customers with search parameter
  // AC-56 [crit]
  // ---------------------------------------------------------------
  describe('AT-25: List customers', () => {
    it('returns all customers with pagination', async () => {
      const res = await authGet(ownerToken, '/api/customers');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.customers).toBeDefined();
      expect(Array.isArray(body.customers)).toBe(true);
      expect(body.total).toBeGreaterThanOrEqual(1);
    });

    it('respects limit and offset parameters', async () => {
      const res = await authGet(ownerToken, '/api/customers?limit=2&offset=0');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.customers.length).toBeLessThanOrEqual(2);
    });

    it('filters by name substring (case-insensitive)', async () => {
      const res = await authGet(ownerToken, '/api/customers?search=testmann');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.customers.length).toBeGreaterThanOrEqual(1);

      for (const customer of body.customers) {
        expect(customer.name.toLowerCase()).toContain('testmann');
      }
    });

    it('returns empty array when search has no match', async () => {
      const res = await authGet(ownerToken, '/api/customers?search=DefinitelyNoMatchXYZ123');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.customers).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('all authenticated users can read (worker included)', async () => {
      const res = await authGet(workerToken, '/api/customers');

      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json().customers)).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // AT-26: Get customer includes project count
  // AC-57 [crit]
  // ---------------------------------------------------------------
  describe('AT-26: Get single customer with project count', () => {
    it('returns the full customer object and associated project count', async () => {
      const res = await authGet(ownerToken, `/api/customers/${createdCustomerId}`);

      expect(res.statusCode).toBe(200);

      const customer = res.json();
      expect(customer.id).toBe(createdCustomerId);
      expect(customer.name).toBe('Familie Testmann');
      expect(typeof customer.projectCount).toBe('number');
      expect(customer.projectCount).toBeGreaterThanOrEqual(0);
    });

    it('returns 404 for non-existent customer', async () => {
      const res = await authGet(ownerToken, '/api/customers/00000000-0000-0000-0000-000000000000');

      expect(res.statusCode).toBe(404);

      const body = res.json();
      expect(body.code).toBe('NOT_FOUND');
    });

    // AC-154 [crit] data prerequisite: the warning dialog is fed by
    // `archivedProjectCount` from this endpoint. Pin both counts on
    // a customer with a mix of active + archived projects.
    it('returns archivedProjectCount reflecting soft-deleted projects', async () => {
      const createRes = await authPost(ownerToken, '/api/customers', {
        name: 'AT-26 Counts Fixture',
      });
      const countsCustomerId = createRes.json().id as string;

      const activeRes = await authPost(ownerToken, '/api/projects', {
        number: 'AT-26-ACTIVE',
        title: 'Active project',
        customerId: countsCustomerId,
      });
      expect(activeRes.statusCode).toBe(201);

      const archivedRes = await authPost(ownerToken, '/api/projects', {
        number: 'AT-26-ARCHIVED',
        title: 'Archived project',
        customerId: countsCustomerId,
      });
      expect(archivedRes.statusCode).toBe(201);
      await authDelete(ownerToken, `/api/projects/${archivedRes.json().id}`);

      const getRes = await authGet(ownerToken, `/api/customers/${countsCustomerId}`);
      expect(getRes.statusCode).toBe(200);
      const customer = getRes.json();
      expect(customer.projectCount).toBe(1);
      expect(customer.archivedProjectCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------
  // Delete customer
  // AC-91 [crit]: delete customer with no projects succeeds
  // AC-92 [crit]: delete customer with projects is rejected (409)
  // AC-93 [crit]: delete customer requires customer:delete permission
  // ---------------------------------------------------------------
  describe('Delete customer', () => {
    it('AC-93: requires customer:delete permission — worker is rejected', async () => {
      const res = await authDelete(workerToken, `/api/customers/${createdCustomerId}`);

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('AC-93: requires customer:delete permission — office is rejected', async () => {
      const officeToken = await login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD);
      const res = await authDelete(officeToken, `/api/customers/${createdCustomerId}`);

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('AC-92: rejects deletion when projects reference the customer', async () => {
      // Create a project referencing the customer
      const projectRes = await authPost(ownerToken, '/api/projects', {
        number: 'DEL-TEST-001',
        title: 'Deletion Test Project',
        customerId: createdCustomerId,
      });
      expect(projectRes.statusCode).toBe(201);

      const res = await authDelete(ownerToken, `/api/customers/${createdCustomerId}`);

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('CONFLICT');
    });

    it('AC-91: deletes customer with no projects', async () => {
      // Create a fresh customer with no projects
      const createRes = await authPost(ownerToken, '/api/customers', {
        name: 'Zum Löschen',
      });
      expect(createRes.statusCode).toBe(201);
      const deleteId = createRes.json().id;

      const res = await authDelete(ownerToken, `/api/customers/${deleteId}`);

      expect(res.statusCode).toBe(204);

      // Verify it's gone
      const getRes = await authGet(ownerToken, `/api/customers/${deleteId}`);
      expect(getRes.statusCode).toBe(404);
    });

    it('returns 404 for non-existent customer', async () => {
      const res = await authDelete(
        ownerToken,
        '/api/customers/00000000-0000-0000-0000-000000000000',
      );

      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------
  // Sort customers — server-side sortBy/sortDir allowlist.
  // Each test creates a small fixture set with a unique tag in the
  // name so the assertion can filter the sorted result down to the
  // rows under test, ignoring any seed customers that happened to
  // share the global ordering.
  // ---------------------------------------------------------------
  describe('Sort customers', () => {
    it('sorts by name ascending then descending', async () => {
      const tag = `SORT-NAME-${Date.now()}`;
      const names = [`${tag}-Bravo`, `${tag}-Alpha`, `${tag}-Charlie`];
      for (const name of names) {
        const res = await authPost(ownerToken, '/api/customers', { name });
        expect(res.statusCode).toBe(201);
      }

      const ascRes = await authGet(
        ownerToken,
        `/api/customers?search=${tag}&sortBy=name&sortDir=asc`,
      );
      expect(ascRes.statusCode).toBe(200);
      expect(ascRes.json().customers.map((c: { name: string }) => c.name)).toEqual([
        `${tag}-Alpha`,
        `${tag}-Bravo`,
        `${tag}-Charlie`,
      ]);

      const descRes = await authGet(
        ownerToken,
        `/api/customers?search=${tag}&sortBy=name&sortDir=desc`,
      );
      expect(descRes.statusCode).toBe(200);
      expect(descRes.json().customers.map((c: { name: string }) => c.name)).toEqual([
        `${tag}-Charlie`,
        `${tag}-Bravo`,
        `${tag}-Alpha`,
      ]);
    });

    it('sorts by city via JSONB extract and pushes NULL city last', async () => {
      const tag = `SORT-CITY-${Date.now()}`;
      const fixtures: {
        name: string;
        address: { street: string; zip: string; city: string } | null;
      }[] = [
        { name: `${tag}-Z`, address: { street: 'S1', zip: '00001', city: 'Aachen' } },
        { name: `${tag}-Y`, address: null },
        { name: `${tag}-X`, address: { street: 'S2', zip: '00002', city: 'Mannheim' } },
      ];
      for (const f of fixtures) {
        const res = await authPost(ownerToken, '/api/customers', f);
        expect(res.statusCode).toBe(201);
      }

      const ascRes = await authGet(
        ownerToken,
        `/api/customers?search=${tag}&sortBy=city&sortDir=asc`,
      );
      expect(ascRes.statusCode).toBe(200);
      const ascNames = ascRes.json().customers.map((c: { name: string }) => c.name);
      // Aachen → Mannheim → NULL (NULLS LAST holds for both directions)
      expect(ascNames).toEqual([`${tag}-Z`, `${tag}-X`, `${tag}-Y`]);

      const descRes = await authGet(
        ownerToken,
        `/api/customers?search=${tag}&sortBy=city&sortDir=desc`,
      );
      expect(descRes.statusCode).toBe(200);
      const descNames = descRes.json().customers.map((c: { name: string }) => c.name);
      // Mannheim → Aachen → NULL (still last in DESC)
      expect(descNames).toEqual([`${tag}-X`, `${tag}-Z`, `${tag}-Y`]);
    });

    // Fastify maps querystring schema violations to 422 via the project's
    // error handler (server/app.ts). 422 is the right status — the
    // request was syntactically valid, it just carried a value the route
    // refuses.
    it('rejects unknown sortBy column with 422', async () => {
      const res = await authGet(ownerToken, '/api/customers?sortBy=notes&sortDir=asc');
      expect(res.statusCode).toBe(422);
    });

    it('rejects invalid sortDir with 422', async () => {
      const res = await authGet(ownerToken, '/api/customers?sortBy=name&sortDir=sideways');
      expect(res.statusCode).toBe(422);
    });

    // LIKE-pattern metacharacters (`%`, `_`, `\`) and quote / semicolon
    // shapes are escaped at the repository boundary (`escapeLike`) so
    // user input is treated as literal text. Without escape, `%` and `_`
    // would expand the wildcard space and a malicious `'); DROP …`
    // would never reach the SQL — drizzle's tagged-template still binds
    // the value — but the escape contract is the first line of defense.
    describe('LIKE-pattern escape (search safety)', () => {
      it('treats % as a literal character, not a wildcard', async () => {
        const tag = `ESC-PCT-${Date.now()}`;
        const literal = `${tag}-50%-off`;
        const decoy = `${tag}-plain`;
        for (const name of [literal, decoy]) {
          const res = await authPost(ownerToken, '/api/customers', { name });
          expect(res.statusCode).toBe(201);
        }
        // Search for `%` should match only the literal-% row, not the
        // decoy. Without escaping, `%` would match every row.
        const res = await authGet(
          ownerToken,
          `/api/customers?search=${encodeURIComponent('%')}-off`,
        );
        expect(res.statusCode).toBe(200);
        const names = res.json().customers.map((c: { name: string }) => c.name);
        expect(names).toContain(literal);
        expect(names).not.toContain(decoy);
      });

      it('treats _ as a literal character, not a single-char wildcard', async () => {
        const tag = `ESC-UND-${Date.now()}`;
        const literal = `${tag}-foo_bar`;
        const decoy = `${tag}-fooXbar`;
        for (const name of [literal, decoy]) {
          const res = await authPost(ownerToken, '/api/customers', { name });
          expect(res.statusCode).toBe(201);
        }
        const res = await authGet(
          ownerToken,
          `/api/customers?search=${encodeURIComponent('foo_bar')}`,
        );
        expect(res.statusCode).toBe(200);
        const names = res.json().customers.map((c: { name: string }) => c.name);
        expect(names).toContain(literal);
        expect(names).not.toContain(decoy);
      });

      it('treats \\ as a literal character', async () => {
        const tag = `ESC-BS-${Date.now()}`;
        const literal = `${tag}-back\\slash`;
        const res = await authPost(ownerToken, '/api/customers', { name: literal });
        expect(res.statusCode).toBe(201);
        const search = await authGet(
          ownerToken,
          `/api/customers?search=${encodeURIComponent('back\\slash')}`,
        );
        expect(search.statusCode).toBe(200);
        const names = search.json().customers.map((c: { name: string }) => c.name);
        expect(names).toContain(literal);
      });

      it('treats SQL-injection-shaped input as plain text', async () => {
        const tag = `ESC-SQLI-${Date.now()}`;
        const literal = `${tag}-'); DROP TABLE customers; --`;
        const createRes = await authPost(ownerToken, '/api/customers', { name: literal });
        expect(createRes.statusCode).toBe(201);
        const res = await authGet(
          ownerToken,
          `/api/customers?search=${encodeURIComponent('); DROP TABLE')}`,
        );
        expect(res.statusCode).toBe(200);
        const names = res.json().customers.map((c: { name: string }) => c.name);
        expect(names).toContain(literal);
        // Sanity: the table still exists — the next list query succeeds
        // and returns a non-empty result set.
        const sanity = await authGet(ownerToken, '/api/customers?limit=1');
        expect(sanity.statusCode).toBe(200);
        expect(sanity.json().customers.length).toBeGreaterThan(0);
      });
    });

    // `customers.name` is notNull but not unique, so ties on the primary
    // sort column would otherwise leave pagination order to the planner.
    // The repo appends `, id ASC` as a stable tiebreaker.
    it('produces deterministic pagination when name ties', async () => {
      const tag = `SORT-TIE-${Date.now()}`;
      const duplicateName = `${tag}-Same`;
      const createdIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await authPost(ownerToken, '/api/customers', { name: duplicateName });
        expect(res.statusCode).toBe(201);
        createdIds.push(res.json().id as string);
      }

      const page1 = await authGet(
        ownerToken,
        `/api/customers?search=${tag}&sortBy=name&sortDir=asc&limit=1&offset=0`,
      );
      const page2 = await authGet(
        ownerToken,
        `/api/customers?search=${tag}&sortBy=name&sortDir=asc&limit=1&offset=1`,
      );
      const page3 = await authGet(
        ownerToken,
        `/api/customers?search=${tag}&sortBy=name&sortDir=asc&limit=1&offset=2`,
      );

      const ids = [
        page1.json().customers[0].id,
        page2.json().customers[0].id,
        page3.json().customers[0].id,
      ];
      expect(new Set(ids).size).toBe(3);
      const sortedById = [...createdIds].sort();
      expect(ids).toEqual(sortedById);

      // A second pass over the same query returns the same order — the
      // tiebreaker is stable, not just deterministic for one snapshot.
      const repeat1 = await authGet(
        ownerToken,
        `/api/customers?search=${tag}&sortBy=name&sortDir=asc&limit=1&offset=0`,
      );
      expect(repeat1.json().customers[0].id).toBe(ids[0]);
    });
  });
});
