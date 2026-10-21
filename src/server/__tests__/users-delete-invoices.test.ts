/**
 * API integration tests — user hard-delete against invoice references
 * (issue #531).
 *
 * AC-385: `DELETE /api/users/:id` is rejected with
 * `409 USER_HAS_INVOICES` when an issued or cancelled invoice
 * references the user as `created_by` or `updated_by`; the user and
 * invoice rows stay unchanged. A user referenced only by a draft is
 * deleted, and the draft's references are nulled. A delete queued
 * behind an in-flight issuance of a draft referencing the user is
 * rejected the same way once the issuance commits — whether the draft
 * already referenced the user or the user is its issuer.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { startApp, stopApp, getDb, login, authPost, authDelete } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';

const year = new Date().getFullYear();

type Status = 'draft' | 'issued' | 'cancelled';

let ownerToken: string;
let ownerId: string;
let projectId: string;

async function createUser(): Promise<string> {
  const res = await authPost(ownerToken, '/api/users', {
    username: `inv_ref_${crypto.randomUUID().slice(0, 8)}`,
    displayName: 'Invoice Ref User',
    password: 'TestPass123!',
    roles: ['office'],
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

/** Seed an invoice by direct SQL — the trigger only guards UPDATEs. */
async function seedInvoice(
  status: Status,
  createdBy: string | null,
  updatedBy: string | null,
): Promise<string> {
  const id = crypto.randomUUID();
  const number = status === 'draft' ? null : `RE-${year}-${crypto.randomInt(100_000, 1_000_000)}`;
  const issueDate = status === 'draft' ? null : `${year}-01-15`;
  const issuer = {
    companyName: 'X',
    address: { street: 'S', zip: '12345', city: 'C' },
    taxId: 'X',
  };
  const recipient = { name: 'R', address: { street: 'S', zip: '12345', city: 'C' } };
  const lines = [
    { description: 'T', quantity: 1, unit: 'p', unitPrice: 1, lineTotal: 1, taxRate: 19 },
  ];
  const totals = {
    perRate: [{ taxRate: 19, netSubtotal: 1, taxAmount: 0.19 }],
    netGrandTotal: 1,
    taxGrandTotal: 0.19,
    grossGrandTotal: 1.19,
  };
  await getDb().execute(sql`
    INSERT INTO invoices (id, project_id, status, number, issue_date, performance_date,
      tax_mode, profile, issuer, recipient, lines, totals, created_by, updated_by)
    VALUES (${id}, ${projectId}, ${status}, ${number}, ${issueDate}, ${issueDate},
            'standard', 'zugferd-en16931',
            ${JSON.stringify(issuer)}::jsonb,
            ${JSON.stringify(recipient)}::jsonb,
            ${JSON.stringify(lines)}::jsonb,
            ${JSON.stringify(totals)}::jsonb,
            ${createdBy}, ${updatedBy})
  `);
  return id;
}

async function invoiceRow(id: string): Promise<Record<string, unknown>> {
  const res = await getDb().execute(
    sql`SELECT to_jsonb(i) AS row FROM invoices i WHERE id = ${id}`,
  );
  return (res.rows[0] as { row: Record<string, unknown> }).row;
}

async function userRow(id: string): Promise<Record<string, unknown> | undefined> {
  const res = await getDb().execute(sql`SELECT to_jsonb(u) AS row FROM users u WHERE id = ${id}`);
  return (res.rows[0] as { row: Record<string, unknown> } | undefined)?.row;
}

describe('AC-385: DELETE /api/users/:id against invoice references', () => {
  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    const owner = await getDb().execute(
      sql`SELECT id FROM users WHERE username = ${SEED_USERS.owner.username}`,
    );
    ownerId = (owner.rows[0] as { id: string }).id;

    const cust = await authPost(ownerToken, '/api/customers', {
      name: `UserDel-Cust ${crypto.randomUUID().slice(0, 6)}`,
    });
    expect(cust.statusCode).toBe(201);
    const proj = await authPost(ownerToken, '/api/projects', {
      number: `UDI-${crypto.randomUUID().slice(0, 8)}`,
      title: 'User delete fixture',
      customerId: cust.json().id,
    });
    expect(proj.statusCode).toBe(201);
    projectId = proj.json().id as string;
  });

  afterAll(async () => {
    await stopApp();
  });

  it.each([
    ['created_by of an issued invoice', 'issued', 'created_by'],
    ['only updated_by of an issued invoice', 'issued', 'updated_by'],
    ['created_by of a cancelled invoice', 'cancelled', 'created_by'],
    ['only updated_by of a cancelled invoice', 'cancelled', 'updated_by'],
  ] as const)('rejects 409 USER_HAS_INVOICES when the user is %s', async (_, status, column) => {
    const userId = await createUser();
    const invoiceId =
      column === 'created_by'
        ? await seedInvoice(status, userId, ownerId)
        : await seedInvoice(status, ownerId, userId);
    const userBefore = await userRow(userId);
    const invoiceBefore = await invoiceRow(invoiceId);

    const res = await authDelete(ownerToken, `/api/users/${userId}`);

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('USER_HAS_INVOICES');
    expect(res.json().details).toEqual({ invoiceCount: 1 });
    expect(await userRow(userId)).toEqual(userBefore);
    expect(await invoiceRow(invoiceId)).toEqual(invoiceBefore);
  });

  it('counts every issued or cancelled invoice that references the user', async () => {
    const userId = await createUser();
    await seedInvoice('issued', userId, userId);
    await seedInvoice('cancelled', ownerId, userId);
    await seedInvoice('draft', userId, userId);

    const res = await authDelete(ownerToken, `/api/users/${userId}`);

    expect(res.statusCode).toBe(409);
    expect(res.json().details).toEqual({ invoiceCount: 2 });
  });

  it('deletes a user referenced only by a draft and nulls the draft references', async () => {
    const userId = await createUser();
    const draftId = await seedInvoice('draft', userId, userId);

    const res = await authDelete(ownerToken, `/api/users/${userId}`);

    expect(res.statusCode).toBe(204);
    expect(await userRow(userId)).toBeUndefined();
    const draft = await invoiceRow(draftId);
    expect(draft.created_by).toBeNull();
    expect(draft.updated_by).toBeNull();
  });

  // Two paths into the race: the draft already references the user (the
  // delete waits on the invoice row lock), or the user is the issuer and
  // the issuance newly references them (the delete waits on the FK
  // key-share lock on the user row).
  it.each([
    ['a draft referencing the user', 'author', 'invoice row'],
    ['a draft authored by someone else, issued by the user', 'issuer', 'user row'],
  ] as const)(
    'rejects a delete queued behind an in-flight issuance of %s',
    async (_, role, lock) => {
      const userId = await createUser();
      const author = role === 'author' ? userId : ownerId;
      const draftId = await seedInvoice('draft', author, author);
      const { pool } = createDatabase();
      const holder = await pool.connect();
      try {
        // Issue the draft from a third connection and hold the transaction open.
        await holder.query('BEGIN');
        await holder.query(
          `UPDATE invoices SET status = 'issued', number = $2, issue_date = CURRENT_DATE,
             performance_date = CURRENT_DATE, updated_by = $3 WHERE id = $1`,
          [draftId, `RE-${year}-${crypto.randomInt(100_000, 1_000_000)}`, userId],
        );
        const pending = authDelete(ownerToken, `/api/users/${userId}`);
        const deadline = Date.now() + 3_000;
        let queued = 0;
        while (queued === 0 && Date.now() < deadline) {
          const { rows } = await pool.query(
            `SELECT COUNT(*)::int AS c FROM pg_stat_activity
              WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
          );
          queued = (rows[0] as { c: number }).c;
          if (queued === 0) await new Promise<void>((r) => setTimeout(r, 20));
        }
        expect(queued, `expected the delete queued on the ${lock} lock`).toBe(1);
        await holder.query('COMMIT');

        const res = await pending;

        expect(res.statusCode, res.body).toBe(409);
        expect(res.json().code).toBe('USER_HAS_INVOICES');
        expect(await userRow(userId)).toBeDefined();
        const invoice = await invoiceRow(draftId);
        expect(invoice.created_by).toBe(author);
        expect(invoice.updated_by).toBe(userId);
      } finally {
        holder.release();
        await pool.end();
      }
    },
  );
});
