/**
 * API integration tests: Project restore (undo archive) — AC-498, AC-512.
 *
 * Restore is the inverse of soft-delete (archive). Preconditions:
 *   - Target must currently be archived (`deleted = true`) → 200 with
 *     active project body.
 *   - Active project → 409 CONFLICT, nothing changes (AC-512).
 *   - Missing id → 404 NOT_FOUND.
 *   - Caller must hold `project:delete` (symmetric — same role can
 *     archive and restore).
 *
 * One audit row per restore, action key `restore`.
 *
 * Route: POST /api/projects/:id/restore → 200 with the restored project
 * body so the client can update its cache without a refetch.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { startApp, stopApp, login, authGet, authPost, authDelete } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { STATE_KEYS } from '../../config/stateConfig.js';

describe('Project Restore (undo archive)', () => {
  let ownerToken: string;
  let officeToken: string;
  let workerToken: string;
  let seededCustomerId: string;

  async function createArchivedProject(): Promise<string> {
    const uniqueSuffix = crypto.randomUUID().slice(0, 8);
    const createRes = await authPost(ownerToken, '/api/projects', {
      number: `RST-${uniqueSuffix}`,
      title: `Restore fixture ${uniqueSuffix}`,
      customerId: seededCustomerId,
    });
    if (createRes.statusCode !== 201) {
      throw new Error(`Fixture: project create failed ${createRes.statusCode} ${createRes.body}`);
    }
    const projectId = createRes.json().id as string;
    // Leave the first state, so a restore that resets the state fails.
    const transitionRes = await authPost(
      ownerToken,
      `/api/projects/${projectId}/transition/forward`,
      { expectedStatus: STATE_KEYS[0] },
    );
    if (transitionRes.statusCode !== 200) {
      throw new Error(
        `Fixture: project transition failed ${transitionRes.statusCode} ${transitionRes.body}`,
      );
    }
    const archiveRes = await authDelete(ownerToken, `/api/projects/${projectId}`);
    if (archiveRes.statusCode !== 200) {
      throw new Error(
        `Fixture: project archive failed ${archiveRes.statusCode} ${archiveRes.body}`,
      );
    }
    return projectId;
  }

  async function createActiveProject(): Promise<string> {
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

    const customerRes = await authGet(ownerToken, '/api/customers');
    const customers = customerRes.json().customers ?? customerRes.json().data;
    if (!Array.isArray(customers) || customers.length === 0) {
      throw new Error('Seed setup: at least one customer must exist for restore tests');
    }
    seededCustomerId = customers[0].id;
  });

  afterAll(async () => {
    await stopApp();
  });

  it('AC-498: restores an archived project in the state it had', async () => {
    const projectId = await createArchivedProject();

    // Confirm the fixture really is archived.
    const before = await authGet(ownerToken, `/api/projects/${projectId}`);
    expect(before.statusCode).toBe(200);
    expect(before.json().deleted).toBe(true);

    const res = await authPost(ownerToken, `/api/projects/${projectId}/restore`, {});
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(projectId);
    expect(body.deleted).toBe(false);
    expect(body.status).toBe(STATE_KEYS[1]);
    // Full project shape — the spec note "Full project object returned
    // after every mutation so the client can reconcile without a separate
    // fetch" applies to restore too.
    expect(body.title).toMatch(/Restore fixture/);
    expect(body.customer).toBeTruthy();

    // The active list now includes it (default filter excludes archived).
    const listRes = await authGet(ownerToken, '/api/projects?limit=200');
    const items = listRes.json().data;
    expect(items.find((p: { id: string }) => p.id === projectId)).toBeTruthy();
  });

  it('AC-512: restoring an active project is refused as a conflict and changes nothing', async () => {
    const projectId = await createActiveProject();
    const before = (await authGet(ownerToken, `/api/projects/${projectId}`)).json();

    const res = await authPost(ownerToken, `/api/projects/${projectId}/restore`, {});
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.code).toBe('CONFLICT');

    const after = (await authGet(ownerToken, `/api/projects/${projectId}`)).json();
    expect(after).toEqual(before);
  });

  it('returns 404 NOT_FOUND when the project id does not exist', async () => {
    const res = await authPost(
      ownerToken,
      '/api/projects/00000000-0000-0000-0000-000000000000/restore',
      {},
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('emits a single audit row with action=restore', async () => {
    const projectId = await createArchivedProject();
    const restoreRes = await authPost(ownerToken, `/api/projects/${projectId}/restore`, {});
    expect(restoreRes.statusCode).toBe(200);

    // Filter audit by ancestor=project id; the restore action must be
    // present and there must be exactly one of it for this project.
    const auditRes = await authGet(
      ownerToken,
      `/api/audit?ancestorType=project&ancestorId=${projectId}&limit=200`,
    );
    expect(auditRes.statusCode).toBe(200);
    const rows = auditRes.json().data ?? auditRes.json().rows ?? auditRes.json();
    const restores = (rows as { action: string }[]).filter((r) => r.action === 'restore');
    expect(restores).toHaveLength(1);
  });

  it('office can restore (project:delete is symmetric)', async () => {
    const projectId = await createArchivedProject();
    const res = await authPost(officeToken, `/api/projects/${projectId}/restore`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(false);
  });

  it('worker cannot restore (lacks project:delete)', async () => {
    const projectId = await createArchivedProject();
    const res = await authPost(workerToken, `/api/projects/${projectId}/restore`, {});
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('NOT_PERMITTED');
  });
});
