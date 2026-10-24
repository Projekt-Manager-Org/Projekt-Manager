/**
 * API integration tests — invoice mutations on an archived project (AC-513).
 *
 * Every arm starts from a request that would succeed on an active project:
 * complete company profile, `rechnung_faellig` project, valid draft. The
 * project is then archived, so a 404 can only come from the archive state.
 * "Changes nothing" is a database snapshot of the project's invoice rows,
 * the project row and the audit log, equal before and after the call.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  startApp,
  stopApp,
  login,
  authGet,
  authPost,
  authPut,
  authPatch,
  authDelete,
  expectedVersion,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';

interface Project {
  id: string;
  deleted?: boolean;
}

async function snapshot(projectId: string): Promise<unknown> {
  const { db, pool } = createDatabase();
  try {
    const invoices = await db.execute(
      sql`SELECT to_jsonb(i) AS row FROM invoices i WHERE project_id = ${projectId} ORDER BY id`,
    );
    const project = await db.execute(
      sql`SELECT to_jsonb(p) AS row FROM projects p WHERE id = ${projectId}`,
    );
    const audit = await db.execute(sql`SELECT COUNT(*)::int AS c FROM audit_log`);
    return { invoices: invoices.rows, project: project.rows, audit: audit.rows };
  } finally {
    await pool.end();
  }
}

describe('AC-513: invoice changes on an archived project', () => {
  let token: string;
  let draftProjectId: string;
  let issuedProjectId: string;
  // One draft per arm: a defect in one arm must not consume another's row.
  let editDraftId: string;
  let deleteDraftId: string;
  let issueDraftId: string;
  let issuedId: string;

  async function createDraft(projectId: string): Promise<string> {
    const res = await authPost(token, '/api/invoices', {
      projectId,
      lines: [
        { description: 'Anstrich', quantity: 1, unit: 'pauschal', unitPrice: 100, taxRate: 19 },
      ],
      performanceDate: '2026-04-10',
    });
    if (res.statusCode !== 201) throw new Error(`draft create ${res.statusCode} ${res.body}`);
    return res.json().id as string;
  }

  async function archive(projectId: string): Promise<void> {
    const res = await authDelete(token, `/api/projects/${projectId}`);
    if (res.statusCode !== 200) throw new Error(`archive ${res.statusCode} ${res.body}`);
  }

  beforeAll(async () => {
    await startApp();
    token = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);

    // Issue preconditions (AC-289): a complete company profile.
    const profile = await authPut(token, '/api/company-profile', {
      ...(await expectedVersion(token, '/api/company-profile')),
      companyName: 'Test Maler GmbH',
      address: { street: 'Werkstr. 1', zip: '10115', city: 'Berlin' },
      taxId: '111/222/33333',
      ustId: 'DE123456789',
      iban: 'DE89370400440532013000',
      accentColor: '#f60',
      footerText: 'Vielen Dank.',
      defaultTaxMode: 'standard',
    });
    if (![200, 204].includes(profile.statusCode)) {
      throw new Error(`company profile ${profile.statusCode} ${profile.body}`);
    }

    const list = await authGet(token, '/api/projects?status=rechnung_faellig&limit=200');
    const ids = (list.json().data as Project[]).filter((p) => !p.deleted).map((p) => p.id);
    if (ids.length < 2) throw new Error('seed needs two projects in rechnung_faellig');
    [draftProjectId, issuedProjectId] = ids as [string, string];

    editDraftId = await createDraft(draftProjectId);
    deleteDraftId = await createDraft(draftProjectId);
    issueDraftId = await createDraft(draftProjectId);

    const toIssue = await createDraft(issuedProjectId);
    const issued = await authPost(
      token,
      `/api/invoices/${toIssue}/issue`,
      await expectedVersion(token, `/api/invoices/${toIssue}`),
    );
    if (issued.statusCode !== 200) throw new Error(`issue ${issued.statusCode} ${issued.body}`);
    issuedId = issued.json().id as string;

    await archive(draftProjectId);
    await archive(issuedProjectId);
  });

  afterAll(async () => {
    await stopApp();
  });

  it('AC-513: editing a draft is refused as not found and changes nothing', async () => {
    const before = await snapshot(draftProjectId);
    const res = await authPatch(token, `/api/invoices/${editDraftId}`, {
      ...(await expectedVersion(token, `/api/invoices/${editDraftId}`)),
      performanceDate: '2026-05-01',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
    expect(await snapshot(draftProjectId)).toEqual(before);
  });

  it('AC-513: deleting a draft is refused as not found and changes nothing', async () => {
    const before = await snapshot(draftProjectId);
    const { expectedVersion: v } = await expectedVersion(token, `/api/invoices/${deleteDraftId}`);
    const res = await authDelete(token, `/api/invoices/${deleteDraftId}?expectedVersion=${v}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
    expect(await snapshot(draftProjectId)).toEqual(before);
  });

  it('AC-513: issuing a draft is refused as not found and changes nothing', async () => {
    const before = await snapshot(draftProjectId);
    const res = await authPost(
      token,
      `/api/invoices/${issueDraftId}/issue`,
      await expectedVersion(token, `/api/invoices/${issueDraftId}`),
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
    expect(await snapshot(draftProjectId)).toEqual(before);
  });

  // On an active project this PATCH is refused as INVOICE_FROZEN: the
  // archive check runs first (data-model.md §6.4).
  it('AC-513: editing an issued invoice is refused as not found, ahead of the frozen check', async () => {
    const before = await snapshot(issuedProjectId);
    const res = await authPatch(token, `/api/invoices/${issuedId}`, {
      ...(await expectedVersion(token, `/api/invoices/${issuedId}`)),
      performanceDate: '2026-05-01',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
    expect(await snapshot(issuedProjectId)).toEqual(before);
  });

  it('AC-513: cancelling an issued invoice is refused as not found and changes nothing', async () => {
    const before = await snapshot(issuedProjectId);
    const res = await authPost(token, `/api/invoices/${issuedId}/cancel`, { reason: 'Test' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
    expect(await snapshot(issuedProjectId)).toEqual(before);
  });
});
