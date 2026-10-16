/**
 * API integration tests: Project CRUD operations.
 *
 * Tests AT-17 to AT-22 from the test specification (verification.md §16.3).
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
  // AT-17: Create project with valid fields → first workflow state
  // AC-58 [crit], AC-59 [crit]
  // ---------------------------------------------------------------
  describe('AT-17: Create project', () => {
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
        status: 'geplant',
        plannedStart: '2026-06-01',
        plannedEnd: '2026-06-15',
        assignedWorkerIds: [workerId],
        estimatedValue: 12500.0,
        notes: 'Testnotiz für CRUD-003',
      });

      expect(res.statusCode).toBe(201);

      const project = res.json();
      expect(project.status).toBe('geplant');
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
  // AT-18: Duplicate project number → validation error
  // AC-62 [crit]
  // ---------------------------------------------------------------
  describe('AT-18: Duplicate project number', () => {
    it('rejects creation with an already-used number', async () => {
      // CRUD-001 was created in AT-17
      const res = await authPost(ownerToken, '/api/projects', {
        number: 'CRUD-001',
        title: 'Duplicate Number Attempt',
        customerId: seededCustomerId,
      });

      expect(res.statusCode).toBe(409);

      const body = res.json();
      expect(body.code).toBe('CONFLICT');
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------
  // AT-19: Non-existent customerId → validation error
  // ---------------------------------------------------------------
  describe('AT-19: Non-existent customerId', () => {
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
  // AT-20: Update project changes specified fields, preserves others
  // AC-60 [crit]
  // ---------------------------------------------------------------
  describe('AT-20: Update project', () => {
    it('changes the specified fields and preserves untouched ones', async () => {
      // Read the project created in AT-17
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
  // AT-21: Update rejects status and number changes
  // AC-60 [crit]
  // ---------------------------------------------------------------
  describe('AT-21: Update rejects status/number', () => {
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
  // AT-22: Soft-delete project
  // AC-61 [crit]
  // ---------------------------------------------------------------
  describe('AT-22: Delete project (soft-delete)', () => {
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
