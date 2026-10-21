/**
 * API integration tests: List projects.
 *
 * Runs against a real test database via Fastify inject (no network).
 *
 * All project operations require authentication. Tests use the `login` helper
 * to obtain a session token before making requests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, login, authGet, authPost } from '../../test/api-helpers.js';
import { STATE_KEYS, WORKFLOW_ORDER } from '../../config/stateConfig.js';

describe('Project Operations — List', () => {
  let token: string;

  beforeAll(async () => {
    await startApp();
    token = await login('inhaber', 'changeme');
  });

  afterAll(async () => {
    await stopApp();
  });

  // ---------------------------------------------------------------
  // List projects returns all seeded projects with correct fields
  // ---------------------------------------------------------------
  describe('List projects', () => {
    it('returns 200 with an array of projects', async () => {
      const res = await authGet(token, '/api/projects');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(Array.isArray(body.data)).toBe(true);
      // Exact seed count is not pinned by any AC — only that the
      // endpoint returns a non-empty array. Counts are seed-fixture
      // detail, not contract.
      expect(body.data.length).toBeGreaterThanOrEqual(1);
    });

    it('project number follows the "YYYY-NNN" format', async () => {
      const res = await authGet(token, '/api/projects');
      const body = res.json();

      for (const project of body.data) {
        expect(project.number).toMatch(/^\d{4}-\d{3}$/);
      }
    });

    it('project status is a valid workflow state', async () => {
      const res = await authGet(token, '/api/projects');
      const body = res.json();

      for (const project of body.data) {
        expect(WORKFLOW_ORDER).toContain(project.status);
      }
    });
  });

  // ---------------------------------------------------------------
  // Pagination
  // ---------------------------------------------------------------
  describe('Pagination', () => {
    it('respects limit parameter', async () => {
      const res = await authGet(token, '/api/projects?limit=3');
      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.data.length).toBe(3);
      // total reflects full count, not the page size
      expect(body.total).toBeGreaterThanOrEqual(15);
    });

    it('respects offset parameter', async () => {
      const allRes = await authGet(token, '/api/projects');
      const all = allRes.json().data;

      const res = await authGet(token, '/api/projects?offset=2&limit=3');
      const body = res.json();

      expect(body.data.length).toBe(3);
      expect(body.data[0].id).toBe(all[2].id);
    });

    it('returns empty array when offset exceeds total', async () => {
      const res = await authGet(token, '/api/projects?offset=999&limit=10');
      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBeGreaterThanOrEqual(15);
    });
  });

  // ---------------------------------------------------------------
  // Sort projects — server-side sortBy/sortDir allowlist.
  // Tests seed a small set of projects under a unique title prefix
  // and assert their relative order in the returned list.
  // ---------------------------------------------------------------
  describe('Sort projects', () => {
    let customerId: string;
    // Distinct, short prefix per test run. The project `number` column is
    // `varchar(20)`, so we tile every generated number under that cap:
    // `${runId}-${slot}-${i}` keeps us comfortably below the limit while
    // remaining unique against the seed data and across tests in this file.
    let runId: string;

    function num(slot: string, i: number): string {
      return `${runId}-${slot}-${i}`;
    }

    beforeAll(async () => {
      const customerRes = await authPost(token, '/api/customers', {
        name: `Sort fixture ${Date.now()}`,
      });
      expect(customerRes.statusCode).toBe(201);
      customerId = customerRes.json().id;
      // 6 base-36 digits = ~9 chars total once the literal prefix is added.
      runId = `S${Date.now().toString(36).slice(-6)}`;
    });

    it('sorts by title ascending then descending', async () => {
      const tag = `${runId}-TIT`;
      const titles = [`${tag}-Bravo`, `${tag}-Alpha`, `${tag}-Charlie`];
      for (const [i, title] of titles.entries()) {
        const res = await authPost(token, '/api/projects', {
          number: num('T', i),
          title,
          customerId,
        });
        expect(res.statusCode).toBe(201);
      }

      const ascRes = await authGet(token, `/api/projects?search=${tag}&sortBy=title&sortDir=asc`);
      expect(ascRes.statusCode).toBe(200);
      expect(ascRes.json().data.map((p: { title: string }) => p.title)).toEqual([
        `${tag}-Alpha`,
        `${tag}-Bravo`,
        `${tag}-Charlie`,
      ]);

      const descRes = await authGet(token, `/api/projects?search=${tag}&sortBy=title&sortDir=desc`);
      expect(descRes.statusCode).toBe(200);
      expect(descRes.json().data.map((p: { title: string }) => p.title)).toEqual([
        `${tag}-Charlie`,
        `${tag}-Bravo`,
        `${tag}-Alpha`,
      ]);
    });

    it('sorts by estimatedValue and pushes NULLs last in both directions', async () => {
      const tag = `${runId}-VAL`;
      const fixtures: { title: string; estimatedValue: number | null }[] = [
        { title: `${tag}-low`, estimatedValue: 100 },
        { title: `${tag}-null`, estimatedValue: null },
        { title: `${tag}-high`, estimatedValue: 9999 },
      ];
      for (const [i, f] of fixtures.entries()) {
        const res = await authPost(token, '/api/projects', {
          number: num('V', i),
          title: f.title,
          customerId,
          estimatedValue: f.estimatedValue,
        });
        expect(res.statusCode).toBe(201);
      }

      const ascRes = await authGet(
        token,
        `/api/projects?search=${tag}&sortBy=estimatedValue&sortDir=asc`,
      );
      expect(ascRes.statusCode).toBe(200);
      expect(ascRes.json().data.map((p: { title: string }) => p.title)).toEqual([
        `${tag}-low`,
        `${tag}-high`,
        `${tag}-null`,
      ]);

      const descRes = await authGet(
        token,
        `/api/projects?search=${tag}&sortBy=estimatedValue&sortDir=desc`,
      );
      expect(descRes.statusCode).toBe(200);
      expect(descRes.json().data.map((p: { title: string }) => p.title)).toEqual([
        `${tag}-high`,
        `${tag}-low`,
        `${tag}-null`,
      ]);
    });

    it('sorts by status using workflow ordinal, not alphabetic key', async () => {
      // Pick three workflow keys whose alphabetic order differs from
      // their workflow order. That difference is what we're actually
      // testing — alphabetic sort would put 'abnahme' before 'angebot',
      // but workflow order puts 'angebot' first.
      const tag = `${runId}-STS`;
      const picks: { title: string; status: string }[] = [
        { title: `${tag}-abnahme`, status: 'abnahme' },
        { title: `${tag}-anfrage`, status: 'anfrage' },
        { title: `${tag}-angebot`, status: 'angebot' },
      ];
      for (const [i, p] of picks.entries()) {
        const res = await authPost(token, '/api/projects', {
          number: num('S', i),
          title: p.title,
          customerId,
          status: p.status,
        });
        expect(res.statusCode).toBe(201);
      }

      const ascRes = await authGet(token, `/api/projects?search=${tag}&sortBy=status&sortDir=asc`);
      expect(ascRes.statusCode).toBe(200);
      const ascStatuses = ascRes.json().data.map((p: { status: string }) => p.status);
      // Order must follow STATE_KEYS index: anfrage(0) < angebot(1) < abnahme(5).
      // (An alphabetic sort would produce abnahme, anfrage, angebot.)
      expect(ascStatuses).toEqual(['anfrage', 'angebot', 'abnahme']);
      // Sanity-check the ordinals to keep the test honest if STATE_KEYS
      // is ever reshuffled.
      expect(STATE_KEYS.indexOf('anfrage')).toBeLessThan(STATE_KEYS.indexOf('angebot'));
      expect(STATE_KEYS.indexOf('angebot')).toBeLessThan(STATE_KEYS.indexOf('abnahme'));
    });

    it('sorts by joined customer name', async () => {
      const tag = `${runId}-CST`;
      // Two distinct customers, lexicographic on suffix.
      const c1 = await authPost(token, '/api/customers', { name: `${tag}-Bbb` });
      const c2 = await authPost(token, '/api/customers', { name: `${tag}-Aaa` });
      expect(c1.statusCode).toBe(201);
      expect(c2.statusCode).toBe(201);

      const p1 = await authPost(token, '/api/projects', {
        number: num('C', 1),
        title: `${tag}-P1`,
        customerId: c1.json().id,
      });
      const p2 = await authPost(token, '/api/projects', {
        number: num('C', 2),
        title: `${tag}-P2`,
        customerId: c2.json().id,
      });
      expect(p1.statusCode).toBe(201);
      expect(p2.statusCode).toBe(201);

      const ascRes = await authGet(
        token,
        `/api/projects?search=${tag}&sortBy=customer&sortDir=asc`,
      );
      expect(ascRes.statusCode).toBe(200);
      const ascCustomers = ascRes
        .json()
        .data.map((p: { customer: { name: string } }) => p.customer.name);
      expect(ascCustomers).toEqual([`${tag}-Aaa`, `${tag}-Bbb`]);
    });

    // Fastify maps querystring schema violations to 422 UNPROCESSABLE
    // ENTITY via the project's error handler (see server/app.ts). 422 is
    // the right status here — the request was syntactically valid JSON,
    // it just carried a value the route refuses. We pin the contract so
    // a regression in the error mapping is caught.
    it('rejects unknown sortBy column with 422', async () => {
      const res = await authGet(token, '/api/projects?sortBy=notes&sortDir=asc');
      expect(res.statusCode).toBe(422);
    });

    it('rejects invalid sortDir with 422', async () => {
      const res = await authGet(token, '/api/projects?sortBy=title&sortDir=sideways');
      expect(res.statusCode).toBe(422);
    });
  });
});
