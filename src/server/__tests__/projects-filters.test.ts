/**
 * API integration tests: Project list filters.
 *
 * Extends the list endpoint (projects-list.test.ts) with filter coverage.
 * Runs against a real test database via Fastify inject (no network).
 *
 * These tests are written ahead of the implementation (TDD). They define
 * the filter contract for the GET /api/projects endpoint.
 *
 * Spec §14.2.2 filter parameters:
 *   - status: single or multiple workflow states
 *   - search: free-text across number, title, customer name
 *   - hasNoDates: boolean — projects without planned dates
 *   - customerId: FK reference
 *   - plannedStartFrom / plannedStartTo: date range
 *   - includeArchived: boolean — include soft-deleted rows (default false)
 *   - All filters use AND logic
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, login, authGet, authPost, authDelete } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';

describe('Project List Filters', () => {
  let token: string;

  beforeAll(async () => {
    await startApp();
    token = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    await stopApp();
  });

  // ---------------------------------------------------------------
  // AC-76: Status filter
  // ---------------------------------------------------------------
  describe('AC-76: Filter by status', () => {
    it('returns only projects matching a single status', async () => {
      const res = await authGet(token, '/api/projects?status=rechnung_faellig');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.data.length).toBeGreaterThanOrEqual(1);

      for (const project of body.data) {
        expect(project.status).toBe('rechnung_faellig');
      }

      // total reflects the filtered count, not all projects
      expect(body.total).toBe(body.data.length);
    });

    it('returns only projects matching multiple statuses', async () => {
      const res = await authGet(token, '/api/projects?status=anfrage&status=angebot');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      for (const project of body.data) {
        expect(['anfrage', 'angebot']).toContain(project.status);
      }
    });

    it('returns empty result for unused status', async () => {
      // Discover which statuses have data in the seed
      const allRes = await authGet(token, '/api/projects?limit=200');
      const usedStatuses = new Set(
        allRes.json().data.map((p: Record<string, unknown>) => p.status),
      );

      const validStates = [
        'anfrage',
        'angebot',
        'geplant',
        'in_arbeit',
        'fertiggestellt',
        'rechnung_faellig',
        'rechnung_bezahlt',
        'storniert',
        'erledigt',
      ];
      const unused = validStates.find((s) => !usedStatuses.has(s));

      if (!unused) {
        // All 9 states populated by seed — empty-result case not testable
        // without data mutation. Single-status test above covers filter correctness.
        return;
      }

      const res = await authGet(token, `/api/projects?status=${unused}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual([]);
      expect(res.json().total).toBe(0);
    });
  });

  // ---------------------------------------------------------------
  // AC-76: Search parameter
  // ---------------------------------------------------------------
  describe('AC-76: Search across number, title, customer name', () => {
    it('finds projects by number substring', async () => {
      // Get a known project number from seed
      const allRes = await authGet(token, '/api/projects?limit=1');
      const knownNumber = allRes.json().data[0].number as string;
      // Search by the year prefix (e.g., "2026")
      const yearPrefix = knownNumber.split('-')[0];

      const res = await authGet(token, `/api/projects?search=${yearPrefix}`);

      expect(res.statusCode).toBe(200);
      expect(res.json().data.length).toBeGreaterThanOrEqual(1);
    });

    it('finds projects by title substring', async () => {
      // Seed titles include German construction terms like "Fassade", "Treppenhaussanierung"
      // Use a generic German construction term that should match at least one seed project
      const res = await authGet(token, '/api/projects?search=Fassade');

      expect(res.statusCode).toBe(200);
      // At least one seed project should have "Fassade" in its title
      expect(res.json().data.length).toBeGreaterThanOrEqual(1);
    });

    it('finds projects by customer name substring', async () => {
      // Seed customers include "Müller" (spec §7.3)
      const res = await authGet(token, '/api/projects?search=Müller');

      expect(res.statusCode).toBe(200);
      expect(res.json().data.length).toBeGreaterThanOrEqual(1);
    });

    it('search is case-insensitive', async () => {
      const lower = await authGet(token, '/api/projects?search=fassade');
      const upper = await authGet(token, '/api/projects?search=FASSADE');

      expect(lower.json().data.length).toBe(upper.json().data.length);
    });

    it('returns empty when search has no match', async () => {
      const res = await authGet(token, '/api/projects?search=DefinitelyNoMatchXYZ789');

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual([]);
      expect(res.json().total).toBe(0);
    });
  });

  // ---------------------------------------------------------------
  // AC-76: hasNoDates filter
  // ---------------------------------------------------------------
  describe('AC-76: Filter by hasNoDates', () => {
    it('returns only projects without planned dates', async () => {
      const res = await authGet(token, '/api/projects?hasNoDates=true');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.data.length).toBeGreaterThanOrEqual(1); // Seed has projects without dates

      for (const project of body.data) {
        expect(project.plannedStart).toBeNull();
        expect(project.plannedEnd).toBeNull();
      }
    });

    it('total reflects filtered count', async () => {
      const allRes = await authGet(token, '/api/projects');
      const noDatesCount = allRes
        .json()
        .data.filter(
          (p: Record<string, unknown>) => p.plannedStart == null && p.plannedEnd == null,
        ).length;

      const res = await authGet(token, '/api/projects?hasNoDates=true');
      expect(res.json().total).toBe(noDatesCount);
    });
  });

  // ---------------------------------------------------------------
  // Combined filters (AND logic)
  // ---------------------------------------------------------------
  describe('Combined filters', () => {
    it('status + search uses AND logic', async () => {
      const res = await authGet(token, '/api/projects?status=anfrage&search=Müller');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.data.length).toBeGreaterThanOrEqual(1);

      for (const project of body.data) {
        expect(project.status).toBe('anfrage');
      }

      // Verify AND logic: combined result must be a subset of search-only results
      const searchOnly = await authGet(token, '/api/projects?search=Müller');
      const searchIds = new Set(searchOnly.json().data.map((p: Record<string, unknown>) => p.id));
      for (const project of body.data) {
        expect(searchIds.has(project.id)).toBe(true);
      }
    });

    it('pagination works with filters', async () => {
      const res = await authGet(token, '/api/projects?status=rechnung_faellig&limit=1&offset=0');

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.data.length).toBeLessThanOrEqual(1);
      // total still reflects the full filtered count, not the page
      expect(body.total).toBeGreaterThanOrEqual(body.data.length);
    });
  });

  // ---------------------------------------------------------------
  // Mitarbeiter (assignee) filter — assignedWorkerIds + includeUnassigned
  // ---------------------------------------------------------------
  // The filter is the read-side complement of the assignment editor on
  // the project detail page. Two axes:
  //   - assignedWorkerIds: OR semantics across the supplied user ids
  //     (matches the GitHub/Jira/Linear assignee-filter convention).
  //   - includeUnassigned: special "Nicht zugewiesen" entry that matches
  //     projects with zero workers. ORs with the assignedWorkerIds branch.
  //
  // Fixtures are created fresh in this block (rather than relying on
  // seed counts) so the assertions remain stable as seed data evolves.
  // The leaked rows are tolerated — every case scopes its assertions to
  // the ids it just created.
  describe('Filter by assignedWorkerIds + includeUnassigned', () => {
    let customerId: string;
    let worker1Id: string;
    let worker2Id: string;
    let projectAssignedToW1: string; // assigned to worker1 only
    let projectAssignedToW2: string; // assigned to worker2 only
    let projectAssignedToBoth: string; // assigned to both
    let projectUnassigned: string; // assigned to nobody

    beforeAll(async () => {
      // Resolve seeded user ids by username so assertions are anchored
      // to the seed contract (SEED_USERS) rather than fragile uuids.
      const usersRes = await authGet(token, '/api/users?limit=200');
      const users = usersRes.json().users as { id: string; username: string }[];
      worker1Id = users.find((u) => u.username === SEED_USERS.worker1.username)!.id;
      worker2Id = users.find((u) => u.username === SEED_USERS.worker2.username)!.id;

      const customerRes = await authGet(token, '/api/customers');
      customerId = (customerRes.json().customers ?? customerRes.json().data)[0].id;

      // Four fixture projects covering the matrix: w1-only, w2-only, both,
      // and unassigned. POST takes assignedWorkerIds as the create-time
      // assignment list (api.md §14.2.2).
      const make = async (number: string, workerIds: string[]) => {
        const res = await authPost(token, '/api/projects', {
          number,
          title: `assignee-filter fixture ${number}`,
          customerId,
          assignedWorkerIds: workerIds,
        });
        if (res.statusCode !== 201) {
          throw new Error(`fixture create failed for ${number}: ${res.statusCode} ${res.body}`);
        }
        return res.json().id as string;
      };
      projectAssignedToW1 = await make('FILT-AW-001', [worker1Id]);
      projectAssignedToW2 = await make('FILT-AW-002', [worker2Id]);
      projectAssignedToBoth = await make('FILT-AW-003', [worker1Id, worker2Id]);
      projectUnassigned = await make('FILT-AW-004', []);
    });

    it('single id matches projects assigned to that worker (and only those, among fixtures)', async () => {
      const res = await authGet(token, `/api/projects?assignedWorkerIds=${worker1Id}&limit=200`);
      expect(res.statusCode).toBe(200);
      const ids = (res.json().data as { id: string }[]).map((p) => p.id);
      expect(ids).toContain(projectAssignedToW1);
      expect(ids).toContain(projectAssignedToBoth);
      expect(ids).not.toContain(projectAssignedToW2);
      expect(ids).not.toContain(projectUnassigned);
    });

    it('multiple ids use OR semantics (matches projects assigned to any of them)', async () => {
      const res = await authGet(
        token,
        `/api/projects?assignedWorkerIds=${worker1Id}&assignedWorkerIds=${worker2Id}&limit=200`,
      );
      expect(res.statusCode).toBe(200);
      const ids = (res.json().data as { id: string }[]).map((p) => p.id);
      expect(ids).toContain(projectAssignedToW1);
      expect(ids).toContain(projectAssignedToW2);
      expect(ids).toContain(projectAssignedToBoth);
      expect(ids).not.toContain(projectUnassigned);
    });

    it('includeUnassigned=true matches projects with zero workers', async () => {
      const res = await authGet(token, '/api/projects?includeUnassigned=true&limit=200');
      expect(res.statusCode).toBe(200);
      const matched = res.json().data as { id: string; assignedWorkers: unknown }[];
      // The fixture's unassigned project must appear; every returned row
      // must have no assigned workers (the response shape uses null when
      // the set is empty — see toProject).
      const matchedIds = matched.map((p) => p.id);
      expect(matchedIds).toContain(projectUnassigned);
      for (const row of matched) {
        expect(row.assignedWorkers).toBeNull();
      }
      // Assigned fixtures must not appear under unassigned-only.
      expect(matchedIds).not.toContain(projectAssignedToW1);
      expect(matchedIds).not.toContain(projectAssignedToW2);
      expect(matchedIds).not.toContain(projectAssignedToBoth);
    });

    it('combines assignedWorkerIds + includeUnassigned via OR (union)', async () => {
      const res = await authGet(
        token,
        `/api/projects?assignedWorkerIds=${worker2Id}&includeUnassigned=true&limit=200`,
      );
      expect(res.statusCode).toBe(200);
      const ids = (res.json().data as { id: string }[]).map((p) => p.id);
      expect(ids).toContain(projectAssignedToW2);
      expect(ids).toContain(projectAssignedToBoth);
      expect(ids).toContain(projectUnassigned);
      expect(ids).not.toContain(projectAssignedToW1);
    });

    it('AND-composes with customerId (assignee-filter narrows further)', async () => {
      // Every fixture above is on the same customer, so the customer
      // filter is a no-op against this fixture set — but the contract
      // is "AND with every other filter", so the result must be the
      // same set as the assignee-only query.
      const res = await authGet(
        token,
        `/api/projects?assignedWorkerIds=${worker1Id}&customerId=${customerId}&limit=200`,
      );
      expect(res.statusCode).toBe(200);
      const ids = (res.json().data as { id: string }[]).map((p) => p.id);
      expect(ids).toContain(projectAssignedToW1);
      expect(ids).toContain(projectAssignedToBoth);
      expect(ids).not.toContain(projectAssignedToW2);
      expect(ids).not.toContain(projectUnassigned);
      // Each row also belongs to the supplied customer.
      const rows = res.json().data as { customer: { id: string } }[];
      for (const row of rows) {
        expect(row.customer.id).toBe(customerId);
      }
    });

    it('does not double-count projects (no DISTINCT regression)', async () => {
      // The repo uses EXISTS rather than a JOIN to avoid duplicates when
      // a project matches via multiple branches. Filtering on both worker
      // ids that the "both" project carries must still return that
      // project exactly once.
      const res = await authGet(
        token,
        `/api/projects?assignedWorkerIds=${worker1Id}&assignedWorkerIds=${worker2Id}&limit=200`,
      );
      const ids = (res.json().data as { id: string }[]).map((p) => p.id);
      const occurrences = ids.filter((id) => id === projectAssignedToBoth).length;
      expect(occurrences).toBe(1);
    });

    // The route schema enforces UUID shape on assignedWorkerIds via
    // `oneOf` so a malformed value short-circuits to 422 at the route
    // boundary rather than reaching PG and surfacing as SQLSTATE 22P02
    // → 500. The body-level POST/PATCH schemas have always required
    // `format: 'uuid'`; the list endpoint now matches.
    it('rejects non-UUID assignedWorkerIds with 422', async () => {
      const res = await authGet(token, '/api/projects?assignedWorkerIds=not-a-uuid&limit=10');
      expect(res.statusCode).toBe(422);
    });

    it('rejects mixed valid + invalid assignedWorkerIds with 422', async () => {
      const res = await authGet(
        token,
        `/api/projects?assignedWorkerIds=${worker1Id}&assignedWorkerIds=not-a-uuid&limit=10`,
      );
      expect(res.statusCode).toBe(422);
    });

    // The worker-scope predicate must AND with assignedWorkerIds — a
    // worker filtering by *other* workers' ids cannot see projects they
    // are not assigned to. Without this guarantee, a future refactor of
    // the predicate chain (e.g. moving the assignee branch outside the
    // scope AND) could regress to a data leak. AC-145, scope.ts.
    it('worker caller cannot widen scope via assignedWorkerIds filter', async () => {
      const workerToken = await login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD);
      // Filter by worker2 only — the "both" fixture is assigned to
      // worker1 (the caller) as well, so scope allows it through; the
      // w2-only fixture is NOT assigned to worker1 and must NOT appear.
      const res = await authGet(
        workerToken,
        `/api/projects?assignedWorkerIds=${worker2Id}&limit=200`,
      );
      expect(res.statusCode).toBe(200);
      const ids = (res.json().data as { id: string }[]).map((p) => p.id);
      expect(ids).toContain(projectAssignedToBoth);
      expect(ids).not.toContain(projectAssignedToW2);
      expect(ids).not.toContain(projectAssignedToW1);
      expect(ids).not.toContain(projectUnassigned);
    });
  });

  // ---------------------------------------------------------------
  // includeArchived filter (AC-151)
  // ---------------------------------------------------------------
  // Setup creates an archived project in `beforeAll` by creating a fresh
  // project, then soft-deleting it via DELETE /api/projects/:id (same
  // pattern as AC-61). The leaked row is tolerated — tests only assert
  // on rows they created or seed rows that cannot be archived.
  describe('AC-151: Filter by includeArchived', () => {
    /** ID of the archived project used across the cases below. */
    let archivedId: string;
    /** The status the archived project carried at the time of archive. */
    const archivedStatus = 'anfrage';
    /** Project number — used to locate the row in list responses without
     *  depending on id-equality when a case needs to identify the row. */
    const archivedNumber = 'FILT-ARC-001';

    beforeAll(async () => {
      // Reuse a customer from seed for the archive fixture. The list
      // endpoint already works for active projects (covered by projects-list.test.ts) so
      // this lookup is a precondition, not a test step.
      const customerRes = await authGet(token, '/api/customers');
      const customers = customerRes.json().customers ?? customerRes.json().data;
      const customerId = customers[0].id as string;

      const createRes = await authPost(token, '/api/projects', {
        number: archivedNumber,
        title: 'Archive-filter fixture',
        customerId,
      });
      archivedId = createRes.json().id as string;

      // Soft-delete — the row now has deleted=true.
      await authDelete(token, `/api/projects/${archivedId}`);
    });

    it('excludes archived rows by default (includeArchived omitted)', async () => {
      // Default-exclude behaviour is already covered by AC-61 for the
      // generic soft-delete plumbing. This case re-asserts specifically
      // for the includeArchived contract's neutral default — the archived
      // fixture must not appear without the explicit opt-in.
      const res = await authGet(token, '/api/projects?limit=200');
      expect(res.statusCode).toBe(200);

      const ids = (res.json().data as { id: string }[]).map((p) => p.id);
      expect(ids).not.toContain(archivedId);
    });

    it('excludes archived rows when includeArchived=false', async () => {
      const res = await authGet(token, '/api/projects?includeArchived=false&limit=200');
      expect(res.statusCode).toBe(200);

      const ids = (res.json().data as { id: string }[]).map((p) => p.id);
      expect(ids).not.toContain(archivedId);
    });

    it('includes archived rows with deleted=true when includeArchived=true', async () => {
      const res = await authGet(token, '/api/projects?includeArchived=true&limit=200');
      expect(res.statusCode).toBe(200);

      const row = (res.json().data as { id: string; deleted: boolean }[]).find(
        (p) => p.id === archivedId,
      );
      expect(row).toBeDefined();
      expect(row!.deleted).toBe(true);
    });

    it('AND-composes with other filters (includeArchived=true & status match)', async () => {
      // The archived fixture was created with default status `anfrage`.
      // Combining includeArchived=true with status=anfrage must return it;
      // combining with a non-matching status must not.
      const matching = await authGet(
        token,
        `/api/projects?includeArchived=true&status=${archivedStatus}&limit=200`,
      );
      expect(matching.statusCode).toBe(200);
      const matchIds = (matching.json().data as { id: string }[]).map((p) => p.id);
      expect(matchIds).toContain(archivedId);

      // Any workflow status different from the archived fixture's (`anfrage`).
      const nonMatchingStatus = 'erledigt';
      const nonMatching = await authGet(
        token,
        `/api/projects?includeArchived=true&status=${nonMatchingStatus}&limit=200`,
      );
      expect(nonMatching.statusCode).toBe(200);
      const nonMatchIds = (nonMatching.json().data as { id: string }[]).map((p) => p.id);
      expect(nonMatchIds).not.toContain(archivedId);
    });
  });
});
