/**
 * API integration tests — invoice mutations on an archived project (AC-513).
 *
 * Every arm starts from a request an active project would accept — complete
 * company profile, `rechnung_faellig` project, valid draft — except the
 * issued-invoice edit, which pins the check order. The project is then
 * archived, so a 404 can only come from the archive state. "Changes
 * nothing" is a database snapshot of the project's invoice rows, the
 * project row and the audit log, equal before and after the call.
 *
 * Reads carry `projectArchived`, the state the `/rechnungen` surfaces gate
 * their changes on (api.md §14.2.14). Archive and restore flip it, and a
 * purge — direct or through customer delete — cascades the drafts away, so
 * each emits `invoice_changed` (api.md §14.2.13).
 */

import crypto from 'node:crypto';
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
import { subscribe, unsubscribe } from '../sse/bus.js';
import { INVOICE_CHANGED } from '../../config/sseEvents.js';

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
  let activeProjectId: string;
  let activeDraftId: string;

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

    const all = await authGet(token, '/api/projects?limit=200');
    const active = (all.json().data as Project[]).find(
      (p) => !p.deleted && p.id !== draftProjectId && p.id !== issuedProjectId,
    );
    if (!active) throw new Error('seed needs a third active project');
    activeProjectId = active.id;
    activeDraftId = await createDraft(activeProjectId);

    await archive(draftProjectId);
    await archive(issuedProjectId);
  });

  afterAll(async () => {
    await stopApp();
  });

  it('invoice reads say whether the project is archived', async () => {
    const list = await authGet(token, '/api/invoices?limit=200');
    const archivedOf = new Map(
      (list.json().data as { id: string; projectArchived: boolean }[]).map((i) => [
        i.id,
        i.projectArchived,
      ]),
    );
    expect(archivedOf.get(issuedId)).toBe(true);
    expect(archivedOf.get(editDraftId)).toBe(true);
    expect(archivedOf.get(activeDraftId)).toBe(false);

    expect((await authGet(token, `/api/invoices/${issuedId}`)).json().projectArchived).toBe(true);
    expect((await authGet(token, `/api/invoices/${activeDraftId}`)).json().projectArchived).toBe(
      false,
    );
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

  /** Runs `act` and returns how many `invoice_changed` frames it emitted. */
  async function invoiceChangedDuring(act: () => Promise<void>): Promise<number> {
    const chunks: string[] = [];
    const conn = { write: (chunk: string) => void chunks.push(chunk) };
    subscribe(conn);
    try {
      await act();
      await new Promise<void>((r) => setImmediate(r));
    } finally {
      unsubscribe(conn);
    }
    return (chunks.join('').match(new RegExp(`event: ${INVOICE_CHANGED}\\n`, 'g')) ?? []).length;
  }

  async function listedInvoiceIds(): Promise<string[]> {
    const list = await authGet(token, '/api/invoices?limit=200');
    return (list.json().data as { id: string }[]).map((i) => i.id);
  }

  it('archiving and restoring a project each emit one invoice_changed', async () => {
    expect(await invoiceChangedDuring(() => archive(activeProjectId))).toBe(1);
    expect(
      await invoiceChangedDuring(async () => {
        const res = await authPost(token, `/api/projects/${activeProjectId}/restore`);
        expect(res.statusCode).toBe(200);
      }),
    ).toBe(1);
  });

  // Runs after the AC-513 arms: it removes the project they act on.
  it('purging a project emits one invoice_changed for its cascaded drafts', async () => {
    expect(await listedInvoiceIds()).toContain(editDraftId);
    expect(
      await invoiceChangedDuring(async () => {
        const res = await authDelete(token, `/api/projects/${draftProjectId}/purge`);
        expect(res.statusCode).toBe(204);
      }),
    ).toBe(1);
    expect(await listedInvoiceIds()).not.toContain(editDraftId);
  });

  it('deleting a customer emits one invoice_changed for its purged projects’ drafts', async () => {
    const customer = await authPost(token, '/api/customers', { name: 'Archiv-Kunde' });
    if (customer.statusCode !== 201) throw new Error(`customer ${customer.statusCode}`);
    const customerId = customer.json().id as string;
    const project = await authPost(token, '/api/projects', {
      number: `ARCH-${crypto.randomUUID().slice(0, 8)}`,
      title: 'Archived with draft',
      customerId,
    });
    if (project.statusCode !== 201) throw new Error(`project ${project.statusCode}`);
    const projectId = project.json().id as string;
    const draftId = await createDraft(projectId);
    await archive(projectId);

    expect(
      await invoiceChangedDuring(async () => {
        const res = await authDelete(token, `/api/customers/${customerId}`);
        expect(res.statusCode).toBe(204);
      }),
    ).toBe(1);
    expect(await listedInvoiceIds()).not.toContain(draftId);
  });
});
