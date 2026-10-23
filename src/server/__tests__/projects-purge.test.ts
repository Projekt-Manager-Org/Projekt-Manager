/**
 * API integration tests: Project hard-delete (purge) operation.
 *
 * Pins AC-502, AC-503, AC-157 from §15.12; the not-found case is wire
 * shape with no AC.
 *
 * The purge endpoint is a narrower, strictly more destructive counterpart to
 * the soft-delete (archive) endpoint. Preconditions pinned here:
 *   - Target must already be archived (`deleted = true`) — non-archived → 409.
 *   - Caller must hold `project:purge` — `project:delete` is not sufficient.
 *   - Hard-deletes the row; `project_workers` rows cascade.
 *
 * These tests are written ahead of the implementation (TDD). They will fail
 * until the route, permission, and service path are in place.
 *
 * Route convention:
 *   DELETE /api/projects/:id/purge  → 204 on success (matches customer:delete
 *                                      hard-delete convention in customers.ts)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { startApp, stopApp, login, authGet, authPost, authDelete } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';

describe('Project Purge (hard-delete)', () => {
  let ownerToken: string;
  let officeToken: string;
  let workerToken: string;
  let bookkeeperToken: string;

  /** A customer ID obtained from the seeded data, used for project creation. */
  let seededCustomerId: string;

  /**
   * Create a fresh project under the seeded customer, then soft-delete it
   * so the purge target is in the archived state. Returns the project id.
   *
   * Each test that targets an archived row should call this to stay
   * independent of sibling tests — purge is a one-way operation and
   * sharing a fixture would mean later tests operate on a non-existent row.
   */
  async function createArchivedProject(options?: {
    assignedWorkerIds?: string[];
  }): Promise<string> {
    const uniqueSuffix = crypto.randomUUID().slice(0, 8);
    const createRes = await authPost(ownerToken, '/api/projects', {
      number: `PURGE-${uniqueSuffix}`,
      title: `Purge fixture ${uniqueSuffix}`,
      customerId: seededCustomerId,
      ...(options?.assignedWorkerIds ? { assignedWorkerIds: options.assignedWorkerIds } : {}),
    });
    if (createRes.statusCode !== 201) {
      throw new Error(`Fixture: project create failed ${createRes.statusCode} ${createRes.body}`);
    }
    const projectId = createRes.json().id as string;

    const archiveRes = await authDelete(ownerToken, `/api/projects/${projectId}`);
    if (archiveRes.statusCode !== 200) {
      throw new Error(
        `Fixture: project archive failed ${archiveRes.statusCode} ${archiveRes.body}`,
      );
    }
    return projectId;
  }

  /** Create a fresh non-archived project. Returns the project id. */
  async function createActiveProject(): Promise<string> {
    // Prefix kept short — `projects.number` is VARCHAR(20), suffix is 8 hex
    // chars, so `ACT-<suffix>` is 12 chars and leaves headroom.
    const uniqueSuffix = crypto.randomUUID().slice(0, 8);
    const createRes = await authPost(ownerToken, '/api/projects', {
      number: `ACT-${uniqueSuffix}`,
      title: `Active fixture ${uniqueSuffix}`,
      customerId: seededCustomerId,
    });
    if (createRes.statusCode !== 201) {
      throw new Error(`Fixture: project create failed ${createRes.statusCode} ${createRes.body}`);
    }
    return createRes.json().id as string;
  }

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    officeToken = await login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD);
    workerToken = await login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD);
    bookkeeperToken = await login(SEED_USERS.bookkeeper.username, SEED_DEFAULT_PASSWORD);

    const customerRes = await authGet(ownerToken, '/api/customers');
    const customers = customerRes.json().customers ?? customerRes.json().data;
    if (!Array.isArray(customers) || customers.length === 0) {
      throw new Error('Seed setup: at least one customer must exist for purge tests');
    }
    seededCustomerId = customers[0].id;
  });

  afterAll(async () => {
    await stopApp();
  });

  // ---------------------------------------------------------------
  // AC-502: Purge an archived project → 204
  // AC-502 [crit]
  // ---------------------------------------------------------------
  describe('AC-502: Hard-delete an archived project', () => {
    it('removes the row; subsequent get returns 404 and list (includeArchived) omits it', async () => {
      // Pick two workers to exercise the project_workers cascade.
      const ownerMe = await authGet(ownerToken, '/api/auth/me');
      const workerMe = await authGet(workerToken, '/api/auth/me');
      const assignedWorkerIds = [ownerMe.json().user.id, workerMe.json().user.id];

      const projectId = await createArchivedProject({ assignedWorkerIds });

      const res = await authDelete(ownerToken, `/api/projects/${projectId}/purge`);
      expect(res.statusCode).toBe(204);

      // GET by id → 404
      const getRes = await authGet(ownerToken, `/api/projects/${projectId}`);
      expect(getRes.statusCode).toBe(404);

      // List with includeArchived=true must not contain it.
      const listRes = await authGet(ownerToken, '/api/projects?includeArchived=true&limit=200');
      expect(listRes.statusCode).toBe(200);
      const rows = listRes.json().data as Array<{ id: string }>;
      expect(rows.find((p) => p.id === projectId)).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------
  // AC-503: Purge on a non-archived project → 409 Conflict
  // AC-503 [crit]
  // ---------------------------------------------------------------
  describe('AC-503: Reject purge on non-archived project', () => {
    it('returns 409 CONFLICT with a German message directing to archive first', async () => {
      const projectId = await createActiveProject();

      const res = await authDelete(ownerToken, `/api/projects/${projectId}/purge`);
      expect(res.statusCode).toBe(409);

      const body = res.json();
      expect(body.code).toBe('CONFLICT');
      expect(typeof body.message).toBe('string');
      // Load-bearing: the copy must direct the user to archive first.
      // A regex keeps the assertion resilient to minor copy edits while
      // still pinning the semantic requirement from AC-503.
      expect(body.message).toMatch(/archiv/i);

      // Project row is unchanged — still present and still not deleted.
      const getRes = await authGet(ownerToken, `/api/projects/${projectId}`);
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().deleted).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // Permission (AC-157) + not-found
  // ---------------------------------------------------------------
  describe('AC-157: Permission and not-found contracts', () => {
    describe('permission gate (AC-157)', () => {
      it('rejects callers without project:purge — worker, bookkeeper, office; only owner succeeds', async () => {
        const projectId = await createArchivedProject();

        // Worker — no project:delete either, but the distinction is made
        // at the project:purge permission check.
        const workerRes = await authDelete(workerToken, `/api/projects/${projectId}/purge`);
        expect(workerRes.statusCode).toBe(403);
        expect(workerRes.json().code).toBe('NOT_PERMITTED');

        // Bookkeeper — read-only role, no purge.
        const bookkeeperRes = await authDelete(bookkeeperToken, `/api/projects/${projectId}/purge`);
        expect(bookkeeperRes.statusCode).toBe(403);
        expect(bookkeeperRes.json().code).toBe('NOT_PERMITTED');

        // Office — LOAD-BEARING assertion per AC-157: office holds
        // `project:delete` but NOT `project:purge`. The existing delete
        // permission must not grant the narrower purge.
        const officeRes = await authDelete(officeToken, `/api/projects/${projectId}/purge`);
        expect(officeRes.statusCode).toBe(403);
        expect(officeRes.json().code).toBe('NOT_PERMITTED');

        // Owner — must succeed. Runs last so the earlier 403s had a row
        // to try the purge against.
        const ownerRes = await authDelete(ownerToken, `/api/projects/${projectId}/purge`);
        expect(ownerRes.statusCode).toBe(204);
      });
    });

    describe('not-found', () => {
      it('returns 404 NOT_FOUND for a non-existent project id', async () => {
        const res = await authDelete(
          ownerToken,
          '/api/projects/00000000-0000-0000-0000-000000000000/purge',
        );

        expect(res.statusCode).toBe(404);
        expect(res.json().code).toBe('NOT_FOUND');
      });
    });
  });
});
