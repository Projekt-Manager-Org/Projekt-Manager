/**
 * API integration tests: Project CRUD operations.
 *
 * Covers single-project create, update, and soft-delete.
 * Runs against a real test database via Fastify inject (no network).
 *
 * These tests are written ahead of the implementation (TDD). They define
 * the API contract for iteration 6 features. They will fail until the
 * corresponding routes, services, and repositories are implemented.
 *
 * Seed data assumptions:
 *   - At least one customer exists (created in earlier tests or seeded).
 *   - Owner has project:create, project:update, project:delete permissions.
 *   - Worker has project:read only.
 *
 * Route conventions (inferred from existing patterns):
 *   POST   /api/projects           → create project
 *   PATCH  /api/projects/:id       → update project
 *   DELETE /api/projects/:id       → soft-delete project
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
  createTestUserSession,
  deactivateUser,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';

describe('Project CRUD Operations', () => {
  let ownerToken: string;
  let workerToken: string;

  /** A customer ID obtained from the seeded data, used for project creation. */
  let seededCustomerId: string;

  /** Tracks IDs of projects created during tests, for cross-test references. */
  let createdProjectId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    workerToken = await login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD);

    // Obtain a customer ID from the seeded data. The customer list endpoint
    // must be available for this to work — if it's not yet implemented, these
    // tests will fail at setup (which is the correct TDD signal).
    const customerRes = await authGet(ownerToken, '/api/customers');
    const customers = customerRes.json().customers ?? customerRes.json().data;
    if (Array.isArray(customers) && customers.length > 0) {
      seededCustomerId = customers[0].id;
    }
  });

  afterAll(async () => {
    await stopApp();
  });

  // ---------------------------------------------------------------
  // AC-475: Create project with valid fields → first workflow state
  // AC-58 [crit], AC-475 [crit]
  // ---------------------------------------------------------------
  describe('AC-475: Create project', () => {
    it('returns 201 with a project in the first workflow state', async () => {
      const res = await authPost(ownerToken, '/api/projects', {
        number: 'CRUD-001',
        title: 'Fassadenanstrich Test',
        customerId: seededCustomerId,
      });

      expect(res.statusCode).toBe(201);

      const project = res.json();
      expect(project.id).toBeDefined();
      expect(project.number).toBe('CRUD-001');
      expect(project.title).toBe('Fassadenanstrich Test');
      expect(project.status).toBe('anfrage');
      expect(project.customerId).toBe(seededCustomerId);
      expect(project.deleted).toBe(false);
      expect(project.createdAt).toBeDefined();
      expect(project.updatedAt).toBeDefined();
      expect(project.statusChangedAt).toBeDefined();

      createdProjectId = project.id;
    });

    it('defaults optional fields appropriately', async () => {
      const res = await authPost(ownerToken, '/api/projects', {
        number: 'CRUD-002',
        title: 'Minimal Project',
        customerId: seededCustomerId,
      });

      expect(res.statusCode).toBe(201);

      const project = res.json();
      expect(project.plannedStart).toBeNull();
      expect(project.plannedEnd).toBeNull();
      expect(project.estimatedValue).toBeNull();
      expect(project.notes).toBeNull();
    });

    it('accepts all optional fields', async () => {
      // Look up a worker user ID for assignedWorkerIds
      const meRes = await authGet(workerToken, '/api/auth/me');
      const workerId = meRes.json().user.id;

      const res = await authPost(ownerToken, '/api/projects', {
        number: 'CRUD-003',
        title: 'Vollständiges Projekt',
        customerId: seededCustomerId,
        plannedStart: '2026-06-01',
        plannedEnd: '2026-06-15',
        assignedWorkerIds: [workerId],
        estimatedValue: 12500.0,
        notes: 'Testnotiz für CRUD-003',
      });

      expect(res.statusCode).toBe(201);

      const project = res.json();
      expect(project.plannedStart).toContain('2026-06-01');
      expect(project.plannedEnd).toContain('2026-06-15');
      expect(project.estimatedValue).toBe(12500.0);
      expect(project.notes).toBe('Testnotiz für CRUD-003');
    });

    it('requires project:create permission — worker is rejected', async () => {
      const res = await authPost(workerToken, '/api/projects', {
        number: 'CRUD-DENIED',
        title: 'Should Not Create',
        customerId: seededCustomerId,
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });
  });

  // ---------------------------------------------------------------
  // AC-476: Duplicate project number → conflict
  // AC-476 [crit]
  // ---------------------------------------------------------------
  describe('AC-476: Duplicate project number', () => {
    // The unique number caps a count by number at one, so "creates
    // nothing" is checked by the refused request's own title.
    const countWithTitle = async (title: string): Promise<number> => {
      const res = await authGet(
        ownerToken,
        `/api/projects?search=${encodeURIComponent(title)}&includeArchived=true`,
      );
      return (res.json().data as { title: string }[]).filter((p) => p.title === title).length;
    };

    it('rejects creation with an already-used number, naming it, and creates nothing', async () => {
      // CRUD-001 was created in the AC-475 test
      const title = `Duplicate Number Attempt ${Date.now()}`;
      const res = await authPost(ownerToken, '/api/projects', {
        number: 'CRUD-001',
        title,
        customerId: seededCustomerId,
      });

      expect(res.statusCode).toBe(409);

      const body = res.json();
      expect(body.code).toBe('CONFLICT');
      expect(body.message).toContain('CRUD-001');
      expect(await countWithTitle(title)).toBe(0);
    });

    it('rejects a number held by an archived project', async () => {
      const number = `AD-${Date.now()}`; // number holds at most 20 characters
      const created = await authPost(ownerToken, '/api/projects', {
        number,
        title: 'Archived number holder',
        customerId: seededCustomerId,
      });
      expect(created.statusCode).toBe(201);
      const archived = await authDelete(ownerToken, `/api/projects/${created.json().id}`);
      expect(archived.statusCode).toBe(200);

      const title = `Reuse attempt ${number}`;
      const res = await authPost(ownerToken, '/api/projects', {
        number,
        title,
        customerId: seededCustomerId,
      });

      expect(res.statusCode).toBe(409);
      expect(await countWithTitle(title)).toBe(0);
    });
  });

  // ---------------------------------------------------------------
  // Non-existent customerId → validation error
  // ---------------------------------------------------------------
  describe('Non-existent customerId', () => {
    it('rejects creation with a customerId that does not exist', async () => {
      const res = await authPost(ownerToken, '/api/projects', {
        number: 'CRUD-NOCUST',
        title: 'No Such Customer',
        customerId: '00000000-0000-0000-0000-000000000000',
      });

      // Could be 400 or 422 — the important thing is a client error with VALIDATION_ERROR
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);

      const body = res.json();
      expect(body.code).toBe('VALIDATION_ERROR');
    });
  });

  // ---------------------------------------------------------------
  // AC-480: Update project changes specified fields, preserves others
  // AC-480 [crit]
  // ---------------------------------------------------------------
  describe('AC-480: Update project', () => {
    it('changes the specified fields and preserves untouched ones', async () => {
      // Read the project created in the AC-475 test
      const beforeRes = await authGet(ownerToken, `/api/projects/${createdProjectId}`);
      expect(beforeRes.statusCode).toBe(200);
      const before = beforeRes.json();

      const res = await authPatch(ownerToken, `/api/projects/${createdProjectId}`, {
        title: 'Fassadenanstrich Test — Updated',
        notes: 'Nachtrag: Gerüst benötigt',
        estimatedValue: 8500.0,
      });

      expect(res.statusCode).toBe(200);

      const after = res.json();
      // Changed fields
      expect(after.title).toBe('Fassadenanstrich Test — Updated');
      expect(after.notes).toBe('Nachtrag: Gerüst benötigt');
      expect(after.estimatedValue).toBe(8500.0);

      // Preserved fields
      expect(after.number).toBe(before.number);
      expect(after.status).toBe(before.status);
      expect(after.customerId).toBe(before.customerId);

      // Server-managed audit fields updated
      expect(after.updatedAt).not.toBe(before.updatedAt);
      expect(after.updatedBy).toBeDefined();
    });
  });

  // ---------------------------------------------------------------
  // AC-481: Adding / removing an assigned worker is stored
  // AC-481 [crit]
  // ---------------------------------------------------------------
  describe('AC-481: Assigned workers', () => {
    const storedWorkerIds = async (): Promise<string[]> => {
      const res = await authGet(ownerToken, `/api/projects/${createdProjectId}`);
      const workers = res.json().assignedWorkers as { userId: string }[] | null;
      return (workers ?? []).map((w) => w.userId);
    };

    it('stores an added worker, then a removal', async () => {
      const workerId = (await authGet(workerToken, '/api/auth/me')).json().user.id as string;
      const others = (await storedWorkerIds()).filter((id) => id !== workerId);

      const added = await authPatch(ownerToken, `/api/projects/${createdProjectId}`, {
        assignedWorkerIds: [...others, workerId],
      });
      expect(added.statusCode).toBe(200);
      expect(await storedWorkerIds()).toContain(workerId);

      const removed = await authPatch(ownerToken, `/api/projects/${createdProjectId}`, {
        assignedWorkerIds: others,
      });
      expect(removed.statusCode).toBe(200);
      expect(await storedWorkerIds()).not.toContain(workerId);
    });
  });

  // ---------------------------------------------------------------
  // AC-515: Assigning a user who is not an active worker is refused
  // AC-515 [crit]
  // ---------------------------------------------------------------
  describe('AC-515: Only active workers can be assigned', () => {
    const userIdOf = async (username: string): Promise<string> => {
      const res = await authGet(ownerToken, '/api/users');
      const users = res.json().users as { id: string; username: string }[];
      return users.find((u) => u.username === username)!.id;
    };
    const storedWorkerIds = async (projectId: string): Promise<string[]> => {
      const res = await authGet(ownerToken, `/api/projects/${projectId}`);
      const workers = res.json().assignedWorkers as { userId: string }[] | null;
      return (workers ?? []).map((w) => w.userId).sort();
    };
    const countWithTitle = async (title: string): Promise<number> => {
      const res = await authGet(
        ownerToken,
        `/api/projects?search=${encodeURIComponent(title)}&includeArchived=true`,
      );
      return (res.json().data as { title: string }[]).filter((p) => p.title === title).length;
    };

    const notAssignable = async (): Promise<[string, string][]> => [
      ['an office user', await userIdOf(SEED_USERS.office.username)],
      ['a deactivated worker', await userIdOf(SEED_USERS.inactive.username)],
      ['an unknown user', '00000000-0000-0000-0000-000000000000'],
    ];

    it('refuses a create naming a user who is not an active worker, and creates nothing', async () => {
      for (const [label, userId] of await notAssignable()) {
        const title = `AC-515 create ${label} ${Date.now()}`;
        const res = await authPost(ownerToken, '/api/projects', {
          number: `W-${Date.now()}`,
          title,
          customerId: seededCustomerId,
          assignedWorkerIds: [userId],
        });

        expect(res.statusCode, label).toBe(422);
        expect(res.json().code, label).toBe('VALIDATION_ERROR');
        expect(await countWithTitle(title), label).toBe(0);
      }
    });

    it('refuses an update adding a user who is not an active worker, and changes nothing', async () => {
      const before = await storedWorkerIds(createdProjectId);
      for (const [label, userId] of await notAssignable()) {
        const res = await authPatch(ownerToken, `/api/projects/${createdProjectId}`, {
          assignedWorkerIds: [...before, userId],
        });

        expect(res.statusCode, label).toBe(422);
        expect(res.json().code, label).toBe('VALIDATION_ERROR');
        expect(await storedWorkerIds(createdProjectId), label).toEqual(before);
      }
    });

    it('keeps an assigned worker who was deactivated later', async () => {
      const { userId: laterInactive } = await createTestUserSession({ roles: ['worker'] });
      const worker1Id = await userIdOf(SEED_USERS.worker1.username);
      const assigned = await authPatch(ownerToken, `/api/projects/${createdProjectId}`, {
        assignedWorkerIds: [laterInactive],
      });
      expect(assigned.statusCode).toBe(200);
      await deactivateUser(laterInactive);

      const res = await authPatch(ownerToken, `/api/projects/${createdProjectId}`, {
        assignedWorkerIds: [laterInactive, worker1Id],
      });

      expect(res.statusCode).toBe(200);
      expect(await storedWorkerIds(createdProjectId)).toEqual([laterInactive, worker1Id].sort());
    });
  });

  // ---------------------------------------------------------------
  // Update rejects status and number changes (status: AC-459;
  // number: data-model.md §5.1 "immutable")
  // ---------------------------------------------------------------
  describe('Update rejects status/number', () => {
    it('does not accept status changes via update', async () => {
      await authPatch(ownerToken, `/api/projects/${createdProjectId}`, {
        status: 'erledigt',
      });

      // The implementation may either ignore the field silently or reject.
      // Verify the status did NOT change.
      const getRes = await authGet(ownerToken, `/api/projects/${createdProjectId}`);
      expect(getRes.json().status).toBe('anfrage');
    });

    it('does not accept number changes via update', async () => {
      await authPatch(ownerToken, `/api/projects/${createdProjectId}`, {
        number: 'CHANGED-999',
      });

      // Verify the number did NOT change
      const getRes = await authGet(ownerToken, `/api/projects/${createdProjectId}`);
      expect(getRes.json().number).toBe('CRUD-001');
    });
  });

  // ---------------------------------------------------------------
  // data-model.md §5.1 field table: input it rules out is refused as a
  // validation error and changes nothing (#600)
  // ---------------------------------------------------------------
  describe('§5.1: input outside the field table is refused', () => {
    const expectValidationError = (res: { statusCode: number; json: () => { code: string } }) => {
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    };

    const projectExists = async (number: string): Promise<boolean> => {
      const res = await authGet(
        ownerToken,
        `/api/projects?search=${encodeURIComponent(number)}&includeArchived=true`,
      );
      return (res.json().data as { number: string }[]).some((p) => p.number === number);
    };

    /** Own fixture, so each PATCH case stands alone under a filtered run. */
    let fixtureId: string;

    beforeAll(async () => {
      const res = await authPost(ownerToken, '/api/projects', {
        number: 'BOUND-FIXTURE',
        title: 'Grenzwert-Fixture',
        customerId: seededCustomerId,
        estimatedValue: 100,
      });
      expect(res.statusCode).toBe(201);
      fixtureId = res.json().id;
    });

    it('refuses a customerId change via update (immutable)', async () => {
      const customers = (await authGet(ownerToken, '/api/customers')).json().customers as {
        id: string;
      }[];
      const otherCustomerId = customers.find((c) => c.id !== seededCustomerId)!.id;
      const before = (await authGet(ownerToken, `/api/projects/${fixtureId}`)).json();

      const res = await authPatch(ownerToken, `/api/projects/${fixtureId}`, {
        customerId: otherCustomerId,
        title: 'Kundenwechsel',
      });

      expectValidationError(res);
      const after = (await authGet(ownerToken, `/api/projects/${fixtureId}`)).json();
      expect(after.customerId).toBe(before.customerId);
      expect(after.title).toBe(before.title);
    });

    it('AC-475: refuses a status on create', async () => {
      const res = await authPost(ownerToken, '/api/projects', {
        number: 'BOUND-STATUS',
        title: 'Startet nicht im ersten Zustand',
        customerId: seededCustomerId,
        status: 'geplant',
      });

      expectValidationError(res);
      expect(await projectExists('BOUND-STATUS')).toBe(false);
    });

    it('refuses a blank number or title on create, and a blank title on update', async () => {
      const blankNumber = await authPost(ownerToken, '/api/projects', {
        number: '   ',
        title: 'Leere Nummer',
        customerId: seededCustomerId,
      });
      expectValidationError(blankNumber);
      expect(await projectExists('   ')).toBe(false);

      const blankTitle = await authPost(ownerToken, '/api/projects', {
        number: 'BOUND-BLANK',
        title: ' \t',
        customerId: seededCustomerId,
      });
      expectValidationError(blankTitle);
      expect(await projectExists('BOUND-BLANK')).toBe(false);

      const before = (await authGet(ownerToken, `/api/projects/${fixtureId}`)).json();
      const patch = await authPatch(ownerToken, `/api/projects/${fixtureId}`, { title: '  ' });
      expectValidationError(patch);
      const after = (await authGet(ownerToken, `/api/projects/${fixtureId}`)).json();
      expect(after.title).toBe(before.title);
    });

    it('refuses a number over 20 characters; accepts exactly 20', async () => {
      const atLimit = 'BOUND-NUMBER-0000021';
      expect(`${atLimit}X`).toHaveLength(21);
      const res = await authPost(ownerToken, '/api/projects', {
        number: `${atLimit}X`,
        title: 'Zu lange Nummer',
        customerId: seededCustomerId,
      });
      expectValidationError(res);
      expect(await projectExists(`${atLimit}X`)).toBe(false);

      const ok = await authPost(ownerToken, '/api/projects', {
        number: atLimit,
        title: 'Nummer mit 20 Zeichen',
        customerId: seededCustomerId,
      });
      expect(ok.statusCode).toBe(201);
    });

    it('refuses a title over 500 characters on create and update', async () => {
      const title = 'T'.repeat(501);
      const res = await authPost(ownerToken, '/api/projects', {
        number: 'BOUND-TITLE',
        title,
        customerId: seededCustomerId,
      });
      expectValidationError(res);
      expect(await projectExists('BOUND-TITLE')).toBe(false);

      const before = (await authGet(ownerToken, `/api/projects/${fixtureId}`)).json();
      const patch = await authPatch(ownerToken, `/api/projects/${fixtureId}`, { title });
      expectValidationError(patch);
      const after = (await authGet(ownerToken, `/api/projects/${fixtureId}`)).json();
      expect(after.title).toBe(before.title);
    });

    it.each([
      { tag: 'POS', estimatedValue: 1e10 },
      { tag: 'ROUND', estimatedValue: 9999999999.995 },
      { tag: 'NEG', estimatedValue: -1e10 },
    ])(
      'refuses an estimatedValue of $estimatedValue (over 10 integer digits) on create and update',
      async ({ tag, estimatedValue }) => {
        const number = `BOUND-EV-${tag}`;
        const res = await authPost(ownerToken, '/api/projects', {
          number,
          title: 'Zu hoher Wert',
          customerId: seededCustomerId,
          estimatedValue,
        });
        expectValidationError(res);
        expect(await projectExists(number)).toBe(false);

        const before = (await authGet(ownerToken, `/api/projects/${fixtureId}`)).json();
        const patch = await authPatch(ownerToken, `/api/projects/${fixtureId}`, {
          estimatedValue,
        });
        expectValidationError(patch);
        const after = (await authGet(ownerToken, `/api/projects/${fixtureId}`)).json();
        expect(after.estimatedValue).toBe(before.estimatedValue);
      },
    );

    it('accepts the largest estimatedValue with 10 integer digits', async () => {
      const res = await authPost(ownerToken, '/api/projects', {
        number: 'BOUND-EV-MAX',
        title: 'Höchster Wert',
        customerId: seededCustomerId,
        estimatedValue: 9999999999.99,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().estimatedValue).toBe(9999999999.99);
    });
  });

  // ---------------------------------------------------------------
  // AC-497: Soft-delete project
  // AC-497 [crit]
  // ---------------------------------------------------------------
  describe('AC-497: Delete project (soft-delete)', () => {
    /** A project created specifically for deletion testing. */
    let deleteTargetId: string;

    beforeAll(async () => {
      const res = await authPost(ownerToken, '/api/projects', {
        number: 'CRUD-DEL',
        title: 'To Be Deleted',
        customerId: seededCustomerId,
      });
      deleteTargetId = res.json().id;
    });

    it('sets deleted = true and returns success', async () => {
      const res = await authDelete(ownerToken, `/api/projects/${deleteTargetId}`);

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.deleted).toBe(true);
    });

    it('excludes deleted project from list results', async () => {
      const listRes = await authGet(ownerToken, '/api/projects');
      const projects = listRes.json().data;
      const found = projects.find((p: Record<string, unknown>) => p.id === deleteTargetId);
      expect(found).toBeUndefined();
    });

    it('requires project:delete permission — worker is rejected', async () => {
      // Create another project to try deleting with insufficient permissions
      const createRes = await authPost(ownerToken, '/api/projects', {
        number: 'CRUD-DEL2',
        title: 'Worker Cannot Delete',
        customerId: seededCustomerId,
      });
      const targetId = createRes.json().id;

      const res = await authDelete(workerToken, `/api/projects/${targetId}`);

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });
  });
});
