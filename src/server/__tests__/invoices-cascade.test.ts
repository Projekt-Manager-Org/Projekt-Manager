/**
 * API integration tests — invoice retention / cascade behaviour on
 * customer delete and project purge (issue #109, ADR-0026).
 *
 * Pins the §6.9 / §6.14 retention invariants:
 *
 *   - AC-307: `DELETE /api/customers/:id` against a customer
 *     whose project graph (active + archived) carries any issued or
 *     cancelled invoice is rejected with `409 CUSTOMER_HAS_INVOICES`;
 *     `details.invoiceCount` matches issued + cancelled count (drafts
 *     excluded). A customer whose archived projects carry only draft
 *     invoices succeeds atomically — drafts cascade-delete with the
 *     project; no orphan invoice rows remain. A customer with zero
 *     invoices of any status behaves as before (AC-91 / AC-92).
 *     `GET /api/customers/:id` returns `invoiceCount` on every
 *     customer (zero when no issued/cancelled rows; drafts don't count).
 *
 *   - AC-504, AC-502: `DELETE /api/projects/:id/purge` against an
 *     archived project carrying any issued or cancelled invoice is
 *     rejected with `409 PROJECT_HAS_INVOICES`; `details.invoiceCount`
 *     matches the issued+cancelled count. Archived project with only
 *     draft invoices succeeds atomically. Archived project with zero
 *     invoices succeeds (regression cover with AC-502). Non-archived
 *     project with zero invoices → 409 CONFLICT (regression cover with
 *     AC-503; distinct error code).
 *
 * Pre-impl red state: no invoices table, no PROJECT_HAS_INVOICES /
 * CUSTOMER_HAS_INVOICES codes wired. Every assertion that depends on
 * invoice presence fails because the seeding step (direct INSERT into
 * `invoices`) blows up at the table-existence check.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { startApp, stopApp, login, authGet, authPost, authDelete } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import { STRINGS } from '../../config/strings.js';

const year = new Date().getFullYear();

// ---------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------

async function createCustomer(ownerToken: string): Promise<string> {
  const res = await authPost(ownerToken, '/api/customers', {
    name: `Cascade-Cust ${crypto.randomUUID().slice(0, 6)}`,
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function createProject(ownerToken: string, customerId: string): Promise<string> {
  const res = await authPost(ownerToken, '/api/projects', {
    number: `CAS-${crypto.randomUUID().slice(0, 8)}`,
    title: 'Cascade fixture',
    customerId,
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function archiveProject(ownerToken: string, projectId: string): Promise<void> {
  const res = await authDelete(ownerToken, `/api/projects/${projectId}`);
  expect(res.statusCode).toBe(200);
}

/**
 * Seed a draft invoice directly (no route). Drafts have no legal
 * weight per data-model.md §6.6 / §6.9 — they cascade-delete with
 * the project.
 */
async function seedDraftInvoice(projectId: string): Promise<string> {
  const { db, pool } = createDatabase();
  try {
    const id = crypto.randomUUID();
    const issuer = { companyName: '', address: { street: '', zip: '', city: '' }, taxId: '' };
    const recipient = { name: 'R', address: { street: 'S', zip: '12345', city: 'C' } };
    const lines = [
      { description: 'T', quantity: 1, unit: 'p', unitPrice: 1, lineTotal: 1, taxRate: 19 },
    ];
    const totals = { perRate: [], netGrandTotal: 1, taxGrandTotal: 0, grossGrandTotal: 1 };
    await db.execute(sql`
      INSERT INTO invoices (id, project_id, status, tax_mode, profile,
        issuer, recipient, lines, totals)
      VALUES (${id}, ${projectId}, 'draft', 'standard', 'zugferd-en16931',
              ${JSON.stringify(issuer)}::jsonb,
              ${JSON.stringify(recipient)}::jsonb,
              ${JSON.stringify(lines)}::jsonb,
              ${JSON.stringify(totals)}::jsonb)
    `);
    return id;
  } finally {
    await pool.end();
  }
}

/**
 * Seed an issued invoice directly. Issued rows carry legal weight per
 * §147 AO / GoBD — the route delete paths reject removal.
 */
async function seedIssuedInvoice(projectId: string, suffix: string): Promise<string> {
  const { db, pool } = createDatabase();
  try {
    const id = crypto.randomUUID();
    const number = `RE-${year}-${suffix.padStart(4, '0')}`;
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
    await db.execute(sql`
      INSERT INTO invoices (id, project_id, status, number, issue_date, performance_date,
        tax_mode, profile, issuer, recipient, lines, totals)
      VALUES (${id}, ${projectId}, 'issued', ${number}, NOW(), CURRENT_DATE,
              'standard', 'zugferd-en16931',
              ${JSON.stringify(issuer)}::jsonb,
              ${JSON.stringify(recipient)}::jsonb,
              ${JSON.stringify(lines)}::jsonb,
              ${JSON.stringify(totals)}::jsonb)
    `);
    return id;
  } finally {
    await pool.end();
  }
}

/** Seed a cancelled invoice via direct SQL (sibling of an issued row). */
async function seedCancelledInvoice(projectId: string, suffix: string): Promise<string> {
  const { db, pool } = createDatabase();
  try {
    const id = crypto.randomUUID();
    const number = `RE-${year}-${suffix.padStart(4, '0')}`;
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
    await db.execute(sql`
      INSERT INTO invoices (id, project_id, status, number, issue_date, performance_date,
        tax_mode, profile, issuer, recipient, lines, totals)
      VALUES (${id}, ${projectId}, 'cancelled', ${number}, NOW(), CURRENT_DATE,
              'standard', 'zugferd-en16931',
              ${JSON.stringify(issuer)}::jsonb,
              ${JSON.stringify(recipient)}::jsonb,
              ${JSON.stringify(lines)}::jsonb,
              ${JSON.stringify(totals)}::jsonb)
    `);
    return id;
  } finally {
    await pool.end();
  }
}

async function selectInvoicesByProject(
  projectId: string,
): Promise<Array<{ id: string; status: string }>> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(
      sql`SELECT id, status FROM invoices WHERE project_id = ${projectId}`,
    );
    return res.rows as Array<{ id: string; status: string }>;
  } finally {
    await pool.end();
  }
}

async function selectInvoicesByCustomer(
  customerId: string,
): Promise<Array<{ id: string; status: string; project_id: string }>> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(sql`
      SELECT i.id, i.status, i.project_id
        FROM invoices i
        JOIN projects p ON p.id = i.project_id
       WHERE p.customer_id = ${customerId}
    `);
    return res.rows as Array<{ id: string; status: string; project_id: string }>;
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------
// AC-307 — Customer delete cascade with invoices.
// ---------------------------------------------------------------------

describe('AC-307: DELETE /api/customers/:id retention/cascade behaviour', () => {
  let ownerToken: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    await stopApp();
  });

  it('customer with issued invoices on any project → 409 CUSTOMER_HAS_INVOICES; details.invoiceCount counts issued+cancelled only', async () => {
    const customerId = await createCustomer(ownerToken);
    const projectId = await createProject(ownerToken, customerId);

    // Mix: one draft, one issued, one cancelled. Drafts must NOT be
    // counted toward `invoiceCount`.
    await seedDraftInvoice(projectId);
    await seedIssuedInvoice(projectId, '7001');
    await seedCancelledInvoice(projectId, '7002');

    // Even archive the project first — AC-307 is about the customer
    // graph (active + archived), so the rejection must fire regardless
    // of the project state.
    await archiveProject(ownerToken, projectId);

    const del = await authDelete(ownerToken, `/api/customers/${customerId}`);
    expect(del.statusCode).toBe(409);
    expect(del.json().code).toBe('CUSTOMER_HAS_INVOICES');
    expect(del.json().details.invoiceCount).toBe(2);

    // Customer + projects + invoices unchanged on rejection.
    const cust = await authGet(ownerToken, `/api/customers/${customerId}`);
    expect(cust.statusCode).toBe(200);
    const surviving = await selectInvoicesByCustomer(customerId);
    expect(surviving).toHaveLength(3);
  });

  it('customer whose archived projects carry only draft invoices → 204; drafts cascade-delete with no orphans', async () => {
    const customerId = await createCustomer(ownerToken);
    const projectA = await createProject(ownerToken, customerId);
    const projectB = await createProject(ownerToken, customerId);
    const draftA = await seedDraftInvoice(projectA);
    const draftB = await seedDraftInvoice(projectB);

    // Archive both projects so the customer can be deleted (AC-92 +
    // the §6.9 customer-delete-purges-archived-projects rule).
    await archiveProject(ownerToken, projectA);
    await archiveProject(ownerToken, projectB);

    const del = await authDelete(ownerToken, `/api/customers/${customerId}`);
    expect(del.statusCode).toBe(204);

    // No orphan invoice rows for either project — verified by direct
    // SELECT (the rows must be gone, not "still present but
    // orphaned").
    const remainingA = await selectInvoicesByProject(projectA);
    const remainingB = await selectInvoicesByProject(projectB);
    expect(remainingA).toHaveLength(0);
    expect(remainingB).toHaveLength(0);

    // The seed `draftA` / `draftB` ids are no longer in any
    // `invoices` row.
    const ids = await selectInvoicesByCustomer(customerId);
    expect(ids.find((r) => r.id === draftA || r.id === draftB)).toBeUndefined();

    // Customer + projects are gone (GET → 404).
    const after = await authGet(ownerToken, `/api/customers/${customerId}`);
    expect(after.statusCode).toBe(404);
  });

  it('customer with zero invoices behaves per AC-91 / AC-92 (regression cover)', async () => {
    const customerId = await createCustomer(ownerToken);
    // No projects, no invoices → AC-91 allows delete.
    const del = await authDelete(ownerToken, `/api/customers/${customerId}`);
    expect(del.statusCode).toBe(204);
  });

  it('customer with active projects but no invoices → 409 CONFLICT (AC-92 regression)', async () => {
    const customerId = await createCustomer(ownerToken);
    await createProject(ownerToken, customerId);

    const del = await authDelete(ownerToken, `/api/customers/${customerId}`);
    expect(del.statusCode).toBe(409);
    // The code is CONFLICT (active project blocks), not
    // CUSTOMER_HAS_INVOICES — they are distinct rejection paths.
    expect(del.json().code).toBe('CONFLICT');
  });

  it('GET /api/customers/:id returns invoiceCount on every customer (zero when no issued/cancelled rows, regardless of drafts)', async () => {
    const customerId = await createCustomer(ownerToken);
    const projectId = await createProject(ownerToken, customerId);

    // Zero invoices.
    let res = await authGet(ownerToken, `/api/customers/${customerId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().invoiceCount).toBe(0);

    // One draft — must not count.
    await seedDraftInvoice(projectId);
    res = await authGet(ownerToken, `/api/customers/${customerId}`);
    expect(res.json().invoiceCount).toBe(0);

    // One issued — counts.
    await seedIssuedInvoice(projectId, '7101');
    res = await authGet(ownerToken, `/api/customers/${customerId}`);
    expect(res.json().invoiceCount).toBe(1);

    // One cancelled — counts.
    await seedCancelledInvoice(projectId, '7102');
    res = await authGet(ownerToken, `/api/customers/${customerId}`);
    expect(res.json().invoiceCount).toBe(2);
  });
});

// ---------------------------------------------------------------------
// AC-504, AC-502 — Project purge cascade with invoices.
// ---------------------------------------------------------------------

describe('AC-504, AC-502: DELETE /api/projects/:id/purge retention/cascade behaviour', () => {
  let ownerToken: string;
  let customerId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    customerId = await createCustomer(ownerToken);
  });

  afterAll(async () => {
    await stopApp();
  });

  it('archived project with issued/cancelled invoices → 409 PROJECT_HAS_INVOICES; details.invoiceCount counts issued+cancelled', async () => {
    const projectId = await createProject(ownerToken, customerId);
    await seedDraftInvoice(projectId);
    await seedIssuedInvoice(projectId, '7201');
    await seedCancelledInvoice(projectId, '7202');
    await archiveProject(ownerToken, projectId);

    const purge = await authDelete(ownerToken, `/api/projects/${projectId}/purge`);
    expect(purge.statusCode).toBe(409);
    expect(purge.json().code).toBe('PROJECT_HAS_INVOICES');
    expect(purge.json().message).toBe(STRINGS.errors.projectHasInvoices);
    expect(purge.json().details.invoiceCount).toBe(2);

    // Project + invoices unchanged.
    const proj = await authGet(ownerToken, `/api/projects/${projectId}`);
    expect(proj.statusCode).toBe(200);
    const remaining = await selectInvoicesByProject(projectId);
    expect(remaining).toHaveLength(3);
  });

  it('archived project with only draft invoices → 204; drafts cascade-delete; no orphans', async () => {
    const projectId = await createProject(ownerToken, customerId);
    await seedDraftInvoice(projectId);
    await seedDraftInvoice(projectId);
    await archiveProject(ownerToken, projectId);

    const purge = await authDelete(ownerToken, `/api/projects/${projectId}/purge`);
    expect(purge.statusCode).toBe(204);

    // Post-call SELECT: no rows remain for the purged project.
    const remaining = await selectInvoicesByProject(projectId);
    expect(remaining).toHaveLength(0);

    // Project itself is gone.
    const proj = await authGet(ownerToken, `/api/projects/${projectId}`);
    expect(proj.statusCode).toBe(404);
  });

  it('archived project with zero invoices → 204 (regression cover with AC-502)', async () => {
    const projectId = await createProject(ownerToken, customerId);
    await archiveProject(ownerToken, projectId);

    const purge = await authDelete(ownerToken, `/api/projects/${projectId}/purge`);
    expect(purge.statusCode).toBe(204);
  });

  it('non-archived project with zero invoices → 409 CONFLICT (regression cover with AC-503; distinct code)', async () => {
    const projectId = await createProject(ownerToken, customerId);

    const purge = await authDelete(ownerToken, `/api/projects/${projectId}/purge`);
    expect(purge.statusCode).toBe(409);
    expect(purge.json().code).toBe('CONFLICT');
    // AC-503 refusal, distinct from AC-504's code: NOT PROJECT_HAS_INVOICES.
    expect(purge.json().code).not.toBe('PROJECT_HAS_INVOICES');
  });
});
