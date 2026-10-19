/**
 * API integration tests — server-derived invoice `lineTotal` (issue #525).
 *
 * AC coverage in this file:
 *   - AT-154 / AC-384: create and PATCH ignore a client-supplied
 *     `lineTotal`; issue rejects a stored line that breaks
 *     `lineTotal = round2(quantity × unitPrice)` before a number is
 *     allocated; create rejects a non-finite derived `lineTotal` and a
 *     `unitPrice` above 4 decimals and overflowing totals; `lineTotal`
 *     is the decimal product; issue also rejects a stored 5-dp `unitPrice`
 *     and stored lines whose totals overflow.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  startApp,
  stopApp,
  login,
  authGet,
  authPost,
  authPatch,
  authPut,
  expectedVersion,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';

const year = new Date().getFullYear();

/** The #525 repro line: the client claims 1.00 for 10 × 100.00. */
const TAMPERED_LINE = {
  description: 'Anstrich Fassade',
  quantity: 10,
  unit: 'h',
  unitPrice: 100,
  lineTotal: 1,
  taxRate: 19,
};

interface StoredLine {
  lineTotal: number;
}

async function withDb<T>(
  fn: (db: ReturnType<typeof createDatabase>['db']) => Promise<T>,
): Promise<T> {
  const { db, pool } = createDatabase();
  try {
    return await fn(db);
  } finally {
    await pool.end();
  }
}

async function readSequenceNextValue(): Promise<number | null> {
  return withDb(async (db) => {
    const res = await db.execute(
      sql`SELECT next_value FROM invoice_sequence WHERE year = ${year} AND kind = 'invoice'`,
    );
    if (res.rows.length === 0) return null;
    return Number((res.rows[0] as { next_value: string | number }).next_value);
  });
}

async function readStoredLines(invoiceId: string): Promise<StoredLine[]> {
  return withDb(async (db) => {
    const res = await db.execute(sql`SELECT lines FROM invoices WHERE id = ${invoiceId}`);
    return (res.rows[0] as { lines: StoredLine[] }).lines;
  });
}

async function rechnungFaelligProjectId(ownerToken: string): Promise<string> {
  const res = await authGet(ownerToken, '/api/projects?status=rechnung_faellig&limit=200');
  const rows = res.json().data as Array<{ id: string }>;
  if (rows.length === 0) throw new Error('seed missing project in rechnung_faellig');
  return rows[0]!.id;
}

describe('AT-154 / AC-384: lineTotal is server-derived', () => {
  let ownerToken: string;
  let projectId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    projectId = await rechnungFaelligProjectId(ownerToken);
  });

  afterAll(async () => {
    await stopApp();
  });

  function expectDerived(body: { lines: StoredLine[]; totals: Record<string, number> }): void {
    expect(body.lines[0]!.lineTotal).toBe(1000);
    expect(body.totals.netGrandTotal).toBe(1000);
    expect(body.totals.grossGrandTotal).toBe(1190);
  }

  it('POST ignores a client-supplied lineTotal', async () => {
    const res = await authPost(ownerToken, '/api/invoices', {
      projectId,
      taxMode: 'standard',
      lines: [TAMPERED_LINE],
    });
    expect(res.statusCode).toBe(201);
    expectDerived(res.json());
    expect((await readStoredLines(res.json().id))[0]!.lineTotal).toBe(1000);
  });

  it('POST rejects a line whose derived lineTotal overflows', async () => {
    const res = await authPost(ownerToken, '/api/invoices', {
      projectId,
      lines: [{ ...TAMPERED_LINE, quantity: 1e200, unitPrice: 1e200 }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('POST derives lineTotal from the decimal product', async () => {
    const res = await authPost(ownerToken, '/api/invoices', {
      projectId,
      lines: [{ ...TAMPERED_LINE, quantity: 0.5, unitPrice: 2.01 }],
    });
    expect(res.statusCode).toBe(201);
    expect((await readStoredLines(res.json().id))[0]!.lineTotal).toBe(1.01);
  });

  it('POST rejects a unitPrice with more than 4 decimals', async () => {
    const res = await authPost(ownerToken, '/api/invoices', {
      projectId,
      lines: [{ ...TAMPERED_LINE, unitPrice: 1.00001 }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('POST rejects a line whose gross total overflows', async () => {
    // Net 1.7e308 is still a double; net × 1.19 is not.
    const res = await authPost(ownerToken, '/api/invoices', {
      projectId,
      taxMode: 'standard',
      lines: [{ ...TAMPERED_LINE, quantity: 1.7e154, unitPrice: 1e154 }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('issue rejects a stored unitPrice with more than 4 decimals', async () => {
    const created = await authPost(ownerToken, '/api/invoices', {
      projectId,
      taxMode: 'standard',
      lines: [TAMPERED_LINE],
      performanceDate: '2026-04-10',
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    // A restored draft: 10 × 1.00005 still derives lineTotal 10.00.
    await withDb((db) =>
      db.execute(
        sql`UPDATE invoices SET lines = jsonb_set(jsonb_set(lines, '{0,unitPrice}', '1.00005'), '{0,lineTotal}', '10') WHERE id = ${id}`,
      ),
    );

    const res = await authPost(ownerToken, `/api/invoices/${id}/issue`, {
      ...(await expectedVersion(ownerToken, `/api/invoices/${id}`)),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().details.invalidFields).toEqual(['lines[0].unitPrice']);
  });

  it('issue rejects stored lines whose totals overflow', async () => {
    const created = await authPost(ownerToken, '/api/invoices', {
      projectId,
      taxMode: 'standard',
      lines: [TAMPERED_LINE, TAMPERED_LINE],
      performanceDate: '2026-04-10',
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    // A restored draft: each line is consistent, their sum is not a double.
    const huge = { ...TAMPERED_LINE, quantity: 1e154, unitPrice: 1e154, lineTotal: 1e308 };
    await withDb((db) =>
      db.execute(
        sql`UPDATE invoices SET lines = ${JSON.stringify([huge, huge])}::jsonb WHERE id = ${id}`,
      ),
    );

    const res = await authPost(ownerToken, `/api/invoices/${id}/issue`, {
      ...(await expectedVersion(ownerToken, `/api/invoices/${id}`)),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().details.invalidFields).toEqual(['totals']);
  });

  it('PATCH ignores a client-supplied lineTotal', async () => {
    const created = await authPost(ownerToken, '/api/invoices', { projectId, taxMode: 'standard' });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const res = await authPatch(ownerToken, `/api/invoices/${id}`, {
      ...(await expectedVersion(ownerToken, `/api/invoices/${id}`)),
      lines: [TAMPERED_LINE],
    });
    expect(res.statusCode).toBe(200);
    expectDerived(res.json());
    expect((await readStoredLines(id))[0]!.lineTotal).toBe(1000);
  });

  it('issue rejects a stored line whose lineTotal breaks the equality, allocating no number', async () => {
    const profile = await authPut(ownerToken, '/api/company-profile', {
      ...(await expectedVersion(ownerToken, '/api/company-profile')),
      companyName: 'Test Maler GmbH',
      address: { street: 'Werkstr. 1', zip: '10115', city: 'Berlin' },
      taxId: '111/222/33333',
      ustId: 'DE123456789',
      defaultTaxMode: 'standard',
    });
    expect([200, 204]).toContain(profile.statusCode);

    const created = await authPost(ownerToken, '/api/invoices', {
      projectId,
      taxMode: 'standard',
      lines: [TAMPERED_LINE],
      performanceDate: '2026-04-10',
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    // A row that predates server derivation, or a restored draft.
    await withDb((db) =>
      db.execute(
        sql`UPDATE invoices SET lines = jsonb_set(lines, '{0,lineTotal}', '1') WHERE id = ${id}`,
      ),
    );
    expect((await readStoredLines(id))[0]!.lineTotal).toBe(1);

    const sequenceBefore = await readSequenceNextValue();
    const res = await authPost(ownerToken, `/api/invoices/${id}/issue`, {
      ...(await expectedVersion(ownerToken, `/api/invoices/${id}`)),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(await readSequenceNextValue()).toBe(sequenceBefore);
    const after = await authGet(ownerToken, `/api/invoices/${id}`);
    expect(after.json().status).toBe('draft');
    const audit = await withDb((db) =>
      db.execute(
        sql`SELECT COUNT(*)::int AS c FROM audit_log WHERE entity_type = 'invoice' AND entity_id = ${id} AND action = 'invoice:issue'`,
      ),
    );
    expect((audit.rows[0] as { c: number }).c).toBe(0);

    // Control: with the line repaired, the same draft issues — the 422
    // above came from the line, not from another precondition.
    await withDb((db) =>
      db.execute(
        sql`UPDATE invoices SET lines = jsonb_set(lines, '{0,lineTotal}', '1000') WHERE id = ${id}`,
      ),
    );
    const repaired = await authPost(ownerToken, `/api/invoices/${id}/issue`, {
      ...(await expectedVersion(ownerToken, `/api/invoices/${id}`)),
    });
    expect(repaired.statusCode).toBe(200);
  });
});
