/**
 * API integration tests: Get single project.
 *
 * Covers Get project: the full project object, or a not-found error.
 * Runs against a real test database via Fastify inject (no network).
 *
 * All project operations require authentication. Tests use the `login` helper
 * to obtain a session token before making requests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, login, authGet, authPost, authDelete } from '../../test/api-helpers.js';

describe('Project Operations — Get Single', () => {
  let token: string;

  beforeAll(async () => {
    await startApp();
    token = await login('inhaber', 'changeme');
  });

  afterAll(async () => {
    await stopApp();
  });

  // ---------------------------------------------------------------
  // Get single project by ID
  // Covers Get project: the full project object, or a not-found error.
  // ---------------------------------------------------------------
  describe('Get single project by ID', () => {
    it('returns 200 with the project matching the requested ID', async () => {
      // Get a known project ID from the list
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      expect(projects.length).toBeGreaterThan(0);

      const knownProject = projects[0];

      const res = await authGet(token, `/api/projects/${knownProject.id}`);

      expect(res.statusCode).toBe(200);

      const body = res.json();
      // Behavior: the endpoint returns the project we asked for.
      expect(body.id).toBe(knownProject.id);
    });

    it('returns the same data as the list endpoint for the same project', async () => {
      const listRes = await authGet(token, '/api/projects');
      const projects = listRes.json().data;
      const fromList = projects[0];

      const singleRes = await authGet(token, `/api/projects/${fromList.id}`);
      const fromSingle = singleRes.json();

      // Core fields must match between list and single-get
      expect(fromSingle.id).toBe(fromList.id);
      expect(fromSingle.number).toBe(fromList.number);
      expect(fromSingle.title).toBe(fromList.title);
      expect(fromSingle.status).toBe(fromList.status);
      expect(fromSingle.customer.name).toBe(fromList.customer.name);
    });

    it('returns 404 with NOT_FOUND for a nonexistent ID', async () => {
      const res = await authGet(token, '/api/projects/00000000-0000-0000-0000-000000000000');

      expect(res.statusCode).toBe(404);

      const body = res.json();
      expect(body.code).toBe('NOT_FOUND');
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    });

    // Reported in #128: clicking an archived project (e.g. from the audit
    // feed) surfaced the "nicht gefunden" message, collapsing the
    // actionable archive state into a "never existed" lie. The endpoint
    // now returns 200 with the project payload and `deleted: true` so the
    // UI can render a read-only preview rather than an error surface.
    // AC-499 (mutations rejected on archived rows) is enforced by mutation
    // routes via `getProjectForMutation`, not by this read path.
    it('returns 200 with deleted:true for a soft-deleted (archived) project', async () => {
      // Grab any existing customer id — mirrors the shape handling in
      // projects-crud.test.ts (customers may land under `customers` or
      // `data` depending on the envelope path).
      const customersRes = await authGet(token, '/api/customers');
      const customersBody = customersRes.json();
      const customers = customersBody.customers ?? customersBody.data;
      const customerId = customers[0].id;

      const createRes = await authPost(token, '/api/projects', {
        number: 'GET-ARCH-1',
        title: 'To Be Archived',
        customerId,
      });
      expect(createRes.statusCode).toBe(201);
      const archivedId = createRes.json().id;

      const delRes = await authDelete(token, `/api/projects/${archivedId}`);
      expect(delRes.statusCode).toBe(200);
      expect(delRes.json().deleted).toBe(true);

      const res = await authGet(token, `/api/projects/${archivedId}`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(archivedId);
      expect(body.deleted).toBe(true);
      // The full payload is preserved so the read-only preview can render
      // every field — anything weaker would re-introduce the data-loss the
      // 410 surface had.
      expect(body.title).toBe('To Be Archived');
      expect(body.number).toBe('GET-ARCH-1');
      expect(body.customer).toBeTruthy();
    });
  });
});
