/**
 * API integration tests — invoice cancellation (issue #109, ADR-0026).
 *
 * Pins the cancel contract from api.md §14.2.14 + ADR-0026:
 *
 *   POST /api/invoices/:id/cancel
 *
 *   - On an `issued` row: creates the Stornorechnung sibling with its
 *     own `ST-YYYY-NNNN` number, sign-flipped lines, negated totals,
 *     snapshots of issuer / recipient / taxMode / profile / performanceDate
 *     copied from the original, optional `cancellationReason` from the
 *     request body. Original `status` flips to `'cancelled'`; all other
 *     fields on the original are byte-equal to their pre-cancel
 *     snapshot. Two audit rows written in one transaction. Project
 *     status is unchanged. One `invoice_changed` SSE event post-commit.
 *
 *   - On a `draft` row: 409 INVOICE_NOT_ISSUED, no state change.
 *   - On an already-`cancelled` row: 409 INVOICE_ALREADY_CANCELLED.
 *
 * AC coverage in this file:
 *   - AT-114 / AC-290: cancel-on-issued happy path with all the above
 *                      shape + audit + SSE assertions.
 *   - AT-115 / AC-291: cancel-on-draft and cancel-on-cancelled rejection
 *                      paths with no state change.
 *
 * Pre-impl red state: no route, no service. The cancel endpoint returns
 * 404 ROUTE_NOT_FOUND for every call — the intended TDD signal.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  startApp,
  stopApp,
  login,
  authGet,
  authPost,
  authPut,
  expectedVersion,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';

const year = new Date().getFullYear();

interface Project {
  id: string;
  status: string;
}

// ---------------------------------------------------------------------
// SSE bus surface — mirrors invoices-issue.test.ts.
// ---------------------------------------------------------------------

interface SseConnection {
  write(chunk: string): void;
}

interface SseBusModule {
  subscribe(c: SseConnection): void;
  unsubscribe(c: SseConnection): void;
}

async function loadBus(): Promise<SseBusModule> {
  const path = '../sse/bus.js';
  return (await import(/* @vite-ignore */ path)) as unknown as SseBusModule;
}

interface SubscribedFake extends SseConnection {
  chunks: string[];
}

function subscribeFake(bus: SseBusModule): SubscribedFake {
  const conn: SubscribedFake = {
    chunks: [],
    write(chunk: string): void {
      this.chunks.push(chunk);
    },
  };
  bus.subscribe(conn);
  return conn;
}

function countInvoiceChanged(conn: SubscribedFake): number {
  const matches = conn.chunks.join('').match(/event: invoice_changed\n/g);
  return matches ? matches.length : 0;
}

/**
 * Wait until `predicate()` returns true, polling every 10 ms up to
 * `ms` milliseconds. Matches the pattern in
 * `attachments-events-route.test.ts`.
 */
async function waitFor(predicate: () => boolean, ms = 500): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise<void>((r) => setTimeout(r, 10));
  }
  return predicate();
}

// ---------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------

async function rechnungFaelligProjectId(
  ownerToken: string,
  skipIds: Set<string> = new Set(),
): Promise<string> {
  const res = await authGet(ownerToken, '/api/projects?status=rechnung_faellig&limit=200');
  const rows = (res.json().data as Project[]).filter((p) => !skipIds.has(p.id));
  if (rows.length === 0) throw new Error('seed missing project in rechnung_faellig');
  return rows[0]!.id;
}

async function ensureCompanyProfileComplete(ownerToken: string): Promise<void> {
  // PUT is the spec verb per api.md §14.2.15.
  const res = await authPut(ownerToken, '/api/company-profile', {
    ...(await expectedVersion(ownerToken, '/api/company-profile')),
    companyName: 'Test Maler GmbH',
    address: { street: 'Werkstr. 1', zip: '10115', city: 'Berlin' },
    taxId: '111/222/33333',
    ustId: 'DE123456789',
    defaultTaxMode: 'standard',
  });
  expect([200, 204]).toContain(res.statusCode);
}

async function createDraft(ownerToken: string, projectId: string): Promise<string> {
  const res = await authPost(ownerToken, '/api/invoices', {
    projectId,
    lines: [
      {
        description: 'Anstrich Fassade',
        quantity: 1,
        unit: 'pauschal',
        unitPrice: 1500,
        lineTotal: 1500,
        taxRate: 19,
      },
    ],
    performanceDate: '2026-04-10',
  });
  if (res.statusCode !== 201) {
    throw new Error(`createDraft failed ${res.statusCode} ${res.body}`);
  }
  return res.json().id as string;
}

/** Issue a draft via the route, returning the issued invoice id. */
async function issueDraft(ownerToken: string, draftId: string): Promise<string> {
  const res = await authPost(
    ownerToken,
    `/api/invoices/${draftId}/issue`,
    await expectedVersion(ownerToken, `/api/invoices/${draftId}`),
  );
  if (res.statusCode !== 200) {
    throw new Error(`issueDraft failed ${res.statusCode} ${res.body}`);
  }
  return res.json().id as string;
}

/** Read a single invoice row's full state via direct SQL. */
async function readInvoiceRow(id: string): Promise<Record<string, unknown> | null> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(
      sql`SELECT id, number, status, project_id, cancellation_of, tax_mode, profile,
                 issuer, recipient, lines, totals, issue_date, performance_date,
                 cancellation_reason, rendered_pdf_binary_descriptor_id,
                 created_at, updated_at, created_by, updated_by
            FROM invoices WHERE id = ${id}`,
    );
    return (res.rows[0] as Record<string, unknown>) ?? null;
  } finally {
    await pool.end();
  }
}

async function countAuditRowsForInvoice(invoiceId: string): Promise<number> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(
      sql`SELECT COUNT(*)::int AS c FROM audit_log
            WHERE entity_type = 'invoice' AND entity_id = ${invoiceId}`,
    );
    return (res.rows[0] as { c: number }).c;
  } finally {
    await pool.end();
  }
}

/**
 * Direct-insert a draft row. Used by AT-115's first arm; the
 * cancel-on-draft path is a route-level rejection, no service work
 * runs, so seeding directly is fine.
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

// ---------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------

describe('Invoice cancellation — happy path (AT-114 / AC-290)', () => {
  let ownerToken: string;
  let projectId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    await ensureCompanyProfileComplete(ownerToken);
    projectId = await rechnungFaelligProjectId(ownerToken);
  });

  afterAll(async () => {
    await stopApp();
  });

  it('creates Storno sibling, flips original to cancelled, writes 2 audit rows, emits 1 SSE, leaves project status', async () => {
    // Issue an invoice first so we have an issued row to cancel.
    const draftId = await createDraft(ownerToken, projectId);
    const originalId = await issueDraft(ownerToken, draftId);

    // Snapshot every field of the original for the post-cancel byte-
    // equal check.
    const beforeRow = await readInvoiceRow(originalId);
    expect(beforeRow).not.toBeNull();

    const auditBefore = await countAuditRowsForInvoice(originalId);

    // Subscribe to SSE for the cancel call window.
    const bus = await loadBus();
    const conn = subscribeFake(bus);
    try {
      const cancelRes = await authPost(ownerToken, `/api/invoices/${originalId}/cancel`, {
        reason: 'Tippfehler in der Beschreibung',
      });
      expect(cancelRes.statusCode).toBe(200);

      const body = cancelRes.json();
      // Wire shape per api.md §14.2.14: pinned exactly as `{ original, storno }`.
      // No fallback — a regression to a different shape must surface.
      expect(body.original).toBeDefined();
      expect(body.storno).toBeDefined();
      const original = body.original as Record<string, unknown>;
      const storno = body.storno as Record<string, unknown>;

      // Storno sibling assertions.
      expect(storno.id).toBeDefined();
      expect(storno.cancellationOf).toBe(originalId);
      expect(typeof storno.number).toBe('string');
      expect(String(storno.number)).toMatch(new RegExp(`^ST-${year}-\\d{4,}$`));
      // Lines are sign-flipped — the storno's first line's `unitPrice`
      // and `lineTotal` are negatives of the original.
      const stornoLines = storno.lines as Array<{ unitPrice: number; lineTotal: number }>;
      const originalLines = beforeRow!.lines as Array<{ unitPrice: number; lineTotal: number }>;
      expect(stornoLines).toHaveLength(originalLines.length);
      expect(stornoLines[0].unitPrice).toBe(-originalLines[0].unitPrice);
      expect(stornoLines[0].lineTotal).toBe(-originalLines[0].lineTotal);
      // Totals negated (pinned exactly by the Storno-totals suite below).
      const stornoTotals = storno.totals as { netGrandTotal: number; grossGrandTotal: number };
      expect(stornoTotals.netGrandTotal).toBeLessThan(0);
      expect(stornoTotals.grossGrandTotal).toBeLessThan(0);
      // Snapshots copied from original (AC-290: issuer / recipient /
      // taxMode / profile / performanceDate copied byte-for-byte).
      expect(storno.issuer).toEqual(beforeRow!.issuer);
      expect(storno.recipient).toEqual(beforeRow!.recipient);
      expect(storno.taxMode).toBe(beforeRow!.tax_mode);
      expect(storno.profile).toBe(beforeRow!.profile);
      // performanceDate — ISO 8601 date string, may render as
      // `2026-04-10` or `2026-04-10T00:00:00.000Z` depending on impl.
      expect(
        String(storno.performanceDate).startsWith(String(beforeRow!.performance_date).slice(0, 10)),
      ).toBe(true);
      // cancellationReason snapshotted onto the Storno.
      expect(storno.cancellationReason).toBe('Tippfehler in der Beschreibung');

      // Original assertions.
      expect(original.id).toBe(originalId);
      expect(original.status).toBe('cancelled');

      // Per AC-290: "all other fields on the original are byte-equal
      // to their pre-cancel snapshot". Re-read directly from the DB to
      // pin this regardless of the wire shape.
      const afterRow = await readInvoiceRow(originalId);
      expect(afterRow).not.toBeNull();
      // Fields that may change: `status`, `updated_at`, `updated_by`.
      const immutableFields: string[] = [
        'id',
        'number',
        'project_id',
        'cancellation_of',
        'tax_mode',
        'profile',
        'issuer',
        'recipient',
        'lines',
        'totals',
        'issue_date',
        'performance_date',
        'cancellation_reason',
        'rendered_pdf_binary_descriptor_id',
        'created_at',
        'created_by',
      ];
      for (const f of immutableFields) {
        expect(JSON.stringify(afterRow![f])).toBe(JSON.stringify(beforeRow![f]));
      }

      // Exactly two audit rows written in the same transaction:
      // one `invoice:cancel` on the original, one `invoice:issue` on
      // the Storno (the Storno being issued).
      const auditAfterOriginal = await countAuditRowsForInvoice(originalId);
      const auditAfterStorno = await countAuditRowsForInvoice(storno.id as string);
      expect(auditAfterOriginal - auditBefore).toBe(1);
      expect(auditAfterStorno).toBe(1);

      const { db, pool } = createDatabase();
      try {
        const cancelRow = await db.execute(sql`
          SELECT action FROM audit_log
          WHERE entity_id = ${originalId}
          ORDER BY created_at DESC LIMIT 1
        `);
        expect((cancelRow.rows[0] as { action: string }).action).toBe('invoice:cancel');

        const stornoRow = await db.execute(sql`
          SELECT action, ancestor_entity_type, ancestor_entity_id
          FROM audit_log
          WHERE entity_id = ${storno.id}
          ORDER BY created_at DESC LIMIT 1
        `);
        const r = stornoRow.rows[0] as Record<string, string>;
        expect(r.action).toBe('invoice:issue');
        expect(r.ancestor_entity_type).toBe('project');
        // The Storno's project_id equals the original's.
        expect(r.ancestor_entity_id).toBe(projectId);
      } finally {
        await pool.end();
      }

      // Project status NOT auto-reverted (AC-290).
      const proj = await authGet(ownerToken, `/api/projects/${projectId}`);
      expect(proj.statusCode).toBe(200);
      expect(proj.json().status).toBe('abgerechnet');

      // Exactly one post-commit SSE event for the cancel call.
      await waitFor(() => countInvoiceChanged(conn) === 1);
      expect(countInvoiceChanged(conn)).toBe(1);
    } finally {
      bus.unsubscribe(conn);
    }
  });
});

// ---------------------------------------------------------------------
// AT-114 / AC-290 — Storno totals are the exact negation of the
// original's stored totals.
// ---------------------------------------------------------------------

type Totals = {
  perRate: { taxRate: number; netSubtotal: number; taxAmount: number }[];
  netGrandTotal: number;
  taxGrandTotal: number;
  grossGrandTotal: number;
};

function negated(t: Totals): Totals {
  return {
    perRate: t.perRate.map((p) => ({
      taxRate: p.taxRate,
      netSubtotal: -p.netSubtotal,
      taxAmount: -p.taxAmount,
    })),
    netGrandTotal: -t.netGrandTotal,
    taxGrandTotal: -t.taxGrandTotal,
    grossGrandTotal: -t.grossGrandTotal,
  };
}

/** Direct-insert an issued row whose `totals` are given verbatim. */
async function seedIssuedInvoice(projectId: string, unitPrice: number, totals: Totals) {
  const { db, pool } = createDatabase();
  try {
    const id = crypto.randomUUID();
    const number = `RE-${year}-${String(90_000_000 + crypto.randomInt(9_999_999))}`;
    const issuer = {
      companyName: 'Test Maler GmbH',
      address: { street: 'Werkstr. 1', zip: '10115', city: 'Berlin' },
      taxId: '111/222/33333',
      ustId: 'DE123456789',
    };
    const recipient = { name: 'R', address: { street: 'S', zip: '12345', city: 'C' } };
    const lines = [
      { description: 'T', quantity: 1, unit: 'p', unitPrice, lineTotal: unitPrice, taxRate: 19 },
    ];
    await db.execute(sql`
      INSERT INTO invoices (id, number, project_id, status, tax_mode, profile,
        issuer, recipient, lines, totals, issue_date, performance_date)
      VALUES (${id}, ${number}, ${projectId}, 'issued', 'standard', 'zugferd-en16931',
              ${JSON.stringify(issuer)}::jsonb,
              ${JSON.stringify(recipient)}::jsonb,
              ${JSON.stringify(lines)}::jsonb,
              ${JSON.stringify(totals)}::jsonb,
              '2026-04-10', '2026-04-10')
    `);
    return id;
  } finally {
    await pool.end();
  }
}

describe('Invoice cancellation — Storno names its original (AT-114 / #548)', () => {
  let ownerToken: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    await ensureCompanyProfileComplete(ownerToken);
  });

  afterAll(async () => {
    await stopApp();
  });

  it("the Storno PDF prints the original's number and issue date, not its id", async () => {
    // Seeded with issue_date 2026-04-10, so the original's date differs
    // from the Storno's own (today) and a wrong date source shows.
    const pid = await rechnungFaelligProjectId(ownerToken);
    const originalId = await seedIssuedInvoice(pid, 100, {
      perRate: [{ taxRate: 19, netSubtotal: 100, taxAmount: 19 }],
      netGrandTotal: 100,
      taxGrandTotal: 19,
      grossGrandTotal: 119,
    });
    const originalNumber = (await authGet(ownerToken, `/api/invoices/${originalId}`)).json()
      .number as string;
    const cancelRes = await authPost(ownerToken, `/api/invoices/${originalId}/cancel`, {});
    expect(cancelRes.statusCode).toBe(200);
    const stornoId = cancelRes.json().storno.id as string;

    const pdf = await authGet(ownerToken, `/api/invoices/${stornoId}/pdf`);
    expect(pdf.statusCode).toBe(200);
    const { extractText, getDocumentProxy } = await import('unpdf');
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(pdf.rawPayload)), {
      mergePages: true,
    });
    expect(text).toContain(`Stornierung von: ${originalNumber} vom 10.04.2026`);
    expect(text).not.toContain(originalId);
  });
});

describe('Invoice cancellation — Storno totals (AT-114 / AC-290)', () => {
  let ownerToken: string;
  let projectId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    await ensureCompanyProfileComplete(ownerToken);
    projectId = await rechnungFaelligProjectId(ownerToken);
  });

  afterAll(async () => {
    await stopApp();
  });

  async function cancel(
    id: string,
  ): Promise<{ original: { totals: Totals }; storno: { totals: Totals } }> {
    const res = await authPost(ownerToken, `/api/invoices/${id}/cancel`, {});
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it('negates a half-cent VAT exactly: 2.50 net @ 19 % → 0.48 / −0.48', async () => {
    const res = await authPost(ownerToken, '/api/invoices', {
      projectId,
      lines: [{ description: 'T', quantity: 1, unit: 'p', unitPrice: 2.5, taxRate: 19 }],
      performanceDate: '2026-04-10',
    });
    expect(res.statusCode).toBe(201);
    const originalId = await issueDraft(ownerToken, res.json().id as string);

    const { original, storno } = await cancel(originalId);
    expect(original.totals.taxGrandTotal).toBe(0.48);
    expect(storno.totals.taxGrandTotal).toBe(-0.48);
    expect(storno.totals).toEqual(negated(original.totals));
  });

  it('negates the stored totals, not a re-derivation of them', async () => {
    // 1.50 net @ 19 % = 0.285 VAT; a row issued under float rounding
    // froze 0.28. Re-deriving would give the Storno −0.29.
    const frozen: Totals = {
      perRate: [{ taxRate: 19, netSubtotal: 1.5, taxAmount: 0.28 }],
      netGrandTotal: 1.5,
      taxGrandTotal: 0.28,
      grossGrandTotal: 1.78,
    };
    const originalId = await seedIssuedInvoice(projectId, 1.5, frozen);

    const { storno } = await cancel(originalId);
    expect(storno.totals).toEqual(negated(frozen));
  });
});

// ---------------------------------------------------------------------
// AT-115 / AC-291 — Cancel rejection paths.
//
// Each arm asserts the documented error code AND no state change. The
// "no state change" half is checked by reading the row before/after
// and asserting the status field is unchanged.
// ---------------------------------------------------------------------

describe('Invoice cancellation — rejection paths (AT-115 / AC-291)', () => {
  let ownerToken: string;
  let projectId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    await ensureCompanyProfileComplete(ownerToken);
    projectId = await rechnungFaelligProjectId(ownerToken);
  });

  afterAll(async () => {
    await stopApp();
  });

  it('cancel on a draft → 409 INVOICE_NOT_ISSUED, no state change', async () => {
    const draftId = await seedDraftInvoice(projectId);
    const beforeRow = await readInvoiceRow(draftId);

    const res = await authPost(ownerToken, `/api/invoices/${draftId}/cancel`);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('INVOICE_NOT_ISSUED');

    const afterRow = await readInvoiceRow(draftId);
    expect(afterRow).toEqual(beforeRow);
  });

  it('cancel on an already-cancelled row → 409 INVOICE_ALREADY_CANCELLED, no state change', async () => {
    // Issue, then cancel, then attempt to cancel again.
    const draftId = await createDraft(ownerToken, projectId);
    const originalId = await issueDraft(ownerToken, draftId);
    const firstCancel = await authPost(ownerToken, `/api/invoices/${originalId}/cancel`);
    expect(firstCancel.statusCode).toBe(200);

    const beforeRow = await readInvoiceRow(originalId);
    expect(beforeRow).not.toBeNull();
    expect(beforeRow!.status).toBe('cancelled');

    const second = await authPost(ownerToken, `/api/invoices/${originalId}/cancel`);
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('INVOICE_ALREADY_CANCELLED');

    const afterRow = await readInvoiceRow(originalId);
    expect(afterRow).toEqual(beforeRow);
  });
});
