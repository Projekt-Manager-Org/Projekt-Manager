/**
 * API integration tests — invoice route surface (issue #109, ADR-0026).
 *
 * Pins the HTTP contract for the per-project invoice CRUD endpoints in
 * api.md §14.2.14:
 *
 *   POST   /api/invoices                       — create draft
 *   GET    /api/invoices                       — list (worker scope arm)
 *   GET    /api/invoices/:id                   — get (worker scope arm)
 *   PATCH  /api/invoices/:id                   — update draft
 *   DELETE /api/invoices/:id                   — delete draft
 *   GET    /api/invoices/:id/pdf               — download rendered PDF
 *
 * AC coverage in this file:
 *   - AC-285: POST creates a draft with documented defaults;
 *                      permission matrix on POST; archived-project 404.
 *   - AC-286: PATCH on draft updates and re-derives totals;
 *                      PATCH on issued/cancelled → INVOICE_FROZEN;
 *                      DELETE on draft removes; DELETE on non-draft frozen.
 *   - AC-297 / AC-298 partial: permission matrix concentrated here —
 *                      walks every role × write/read endpoint. Per the
 *                      task brief, the matrix is centralised here +
 *                      `company-profile.test.ts`, not duplicated in the
 *                      issue / cancel / cascade files.
 *   - AC-298: worker exclusion via repository-predicate scope —
 *                      empty list, 403 on existing get, 404 on unknown.
 *   - AC-299: download PDF — issued / cancelled / draft / worker
 *                      arms.
 *
 * Pre-impl red state: routes do not exist. Fastify returns 404
 * ROUTE_NOT_FOUND for every call, so the status-code assertions all fail
 * — the intended TDD signal.
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
  authPatch,
  authDelete,
  expectedVersion,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';

const year = new Date().getFullYear();

interface Project {
  id: string;
  number: string;
  status: string;
  customerId: string;
}

/**
 * Fetch a seeded project in `rechnung_faellig` — the only status that
 * permits a successful invoice issue per AC-289. The seed places three
 * such projects per `src/server/seed/business.ts`, so picking the first
 * non-`deleted` row is robust to ordering changes. `skipIds` lets the
 * AC-299 PDF arms claim three distinct projects in turn — each issuance
 * flips its project to `abgerechnet`, so consecutive calls need fresh
 * slots.
 */
async function rechnungFaelligProjectId(
  ownerToken: string,
  skipIds: Set<string> = new Set(),
): Promise<string> {
  const res = await authGet(ownerToken, '/api/projects?status=rechnung_faellig&limit=200');
  const rows = (res.json().data as Project[]).filter(
    (p) => (!('deleted' in p) || !p['deleted']) && !skipIds.has(p.id),
  );
  if (rows.length === 0) throw new Error('seed missing project in rechnung_faellig');
  return rows[0]!.id;
}

/**
 * Fetch a seeded project NOT in `rechnung_faellig`. Used by the
 * AC-285 negative arm and by the cancel-on-wrong-state path: a draft
 * created here can be issued only after a status flip.
 */
async function anyActiveProjectId(ownerToken: string): Promise<string> {
  const res = await authGet(ownerToken, '/api/projects?limit=200');
  const p = (res.json().data as Project[]).find((r) => r.status === 'in_arbeit');
  if (!p) throw new Error('seed missing in_arbeit project');
  return p.id;
}

/** Archive a project (soft-delete) for the AC-285 404 arm. */
async function archiveProject(ownerToken: string, projectId: string): Promise<void> {
  const res = await authDelete(ownerToken, `/api/projects/${projectId}`);
  if (res.statusCode !== 200) {
    throw new Error(`archive failed ${res.statusCode} ${res.body}`);
  }
}

/** Direct-insert a draft invoice row for tests that need a starting state. */
async function seedDraftInvoice(
  projectId: string,
  recipient?: Record<string, unknown>,
): Promise<string> {
  const { db, pool } = createDatabase();
  try {
    const id = crypto.randomUUID();
    const r = recipient ?? {
      name: 'Test-Recipient',
      address: { street: 'Strasse 1', zip: '12345', city: 'Berlin' },
    };
    const lines = [
      {
        description: 'Test',
        quantity: 1,
        unit: 'pauschal',
        unitPrice: 100,
        lineTotal: 100,
        taxRate: 19,
      },
    ];
    const totals = { perRate: [], netGrandTotal: 100, taxGrandTotal: 0, grossGrandTotal: 100 };
    const issuer = {
      companyName: '',
      address: { street: '', zip: '', city: '' },
      taxId: '',
    };
    await db.execute(sql`
      INSERT INTO invoices
        (id, project_id, status, tax_mode, profile,
         issuer, recipient, lines, totals)
      VALUES (${id}, ${projectId}, 'draft', 'standard', 'zugferd-en16931',
              ${JSON.stringify(issuer)}::jsonb,
              ${JSON.stringify(r)}::jsonb,
              ${JSON.stringify(lines)}::jsonb,
              ${JSON.stringify(totals)}::jsonb)
    `);
    return id;
  } finally {
    await pool.end();
  }
}

/**
 * Direct-insert an issued invoice — the AC-286 / AC-299 / AC-120
 * frozen-row arms need this without going through the issuance
 * service (which doesn't exist at step-3). Sets `number` to a value
 * conforming to the DB CHECK regex.
 */
async function seedIssuedInvoice(
  projectId: string,
  suffix: string,
  status: 'issued' | 'cancelled' = 'issued',
): Promise<string> {
  const { db, pool } = createDatabase();
  try {
    const id = crypto.randomUUID();
    const number = `RE-${year}-${suffix.padStart(4, '0')}`;
    const issuer = {
      companyName: 'Test GmbH',
      address: { street: 'Hauptstr. 1', zip: '10115', city: 'Berlin' },
      taxId: '111/222/33333',
    };
    const recipient = {
      name: 'Kunde',
      address: { street: 'Kundenstr. 2', zip: '20095', city: 'Hamburg' },
    };
    const lines = [
      {
        description: 'Test',
        quantity: 1,
        unit: 'pauschal',
        unitPrice: 100,
        lineTotal: 100,
        taxRate: 19,
      },
    ];
    const totals = {
      perRate: [{ taxRate: 19, netSubtotal: 100, taxAmount: 19 }],
      netGrandTotal: 100,
      taxGrandTotal: 19,
      grossGrandTotal: 119,
    };
    await db.execute(sql`
      INSERT INTO invoices
        (id, project_id, status, number, issue_date, performance_date,
         tax_mode, profile, issuer, recipient, lines, totals,
         rendered_pdf_binary_descriptor_id)
      VALUES (${id}, ${projectId}, ${status}, ${number}, NOW(), CURRENT_DATE,
              'standard', 'zugferd-en16931',
              ${JSON.stringify(issuer)}::jsonb,
              ${JSON.stringify(recipient)}::jsonb,
              ${JSON.stringify(lines)}::jsonb,
              ${JSON.stringify(totals)}::jsonb,
              NULL)
    `);
    return id;
  } finally {
    await pool.end();
  }
}

/**
 * Assert the wire shape of a successful PDF download response.
 * api.md §14.2.14 leaves the transport implementation-defined: either
 * inline PDF bytes (Content-Type: application/pdf, body starts with
 * `%PDF-`) OR a JSON wrapper carrying a presigned-GET URL +
 * DEK material. Branch on content-type and assert the matching shape;
 * fail loudly if neither matches.
 *
 * `res` shape mirrors what `app.inject()` returns from light-my-request
 * (Fastify's in-process HTTP simulator) — typed loosely to accept both
 * the `Response` type and the test-helper return values.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function assertPdfDownloadShape(res: any): void {
  expect(res.statusCode).toBe(200);
  const ctRaw = res.headers['content-type'];
  const ct = String((Array.isArray(ctRaw) ? ctRaw[0] : ctRaw) ?? '');
  if (ct.includes('application/pdf')) {
    // Inline bytes — must start with %PDF- magic.
    const buf = res.rawPayload as Buffer | undefined;
    expect(buf).toBeDefined();
    expect(buf!.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  } else if (ct.includes('application/json')) {
    // Presigned-GET wrapper — must carry `url` and `dekMaterial`
    // (parity with the attachment download surface in §14.2.11).
    const body = res.json() as { url?: string; dekMaterial?: string };
    expect(typeof body.url).toBe('string');
    expect(body.url!.length).toBeGreaterThan(0);
    expect(typeof body.dekMaterial).toBe('string');
    expect(body.dekMaterial!.length).toBeGreaterThan(0);
  } else {
    throw new Error(`unexpected content-type on PDF download: ${ct}`);
  }
}

/**
 * Fill the `company_profile` singleton with the fields required for a
 * successful issue (AC-289 / COMPANY_PROFILE_REQUIRED). The seeded row
 * ships empty per data-model.md §5.17 so the issue gate fires until an
 * owner PUTs values — mirrors the helper in `invoices-issue.test.ts`.
 */
async function ensureCompanyProfileComplete(ownerToken: string): Promise<void> {
  const res = await authPut(ownerToken, '/api/company-profile', {
    ...(await expectedVersion(ownerToken, '/api/company-profile')),
    companyName: 'Test Maler GmbH',
    address: { street: 'Werkstr. 1', zip: '10115', city: 'Berlin' },
    taxId: '111/222/33333',
    ustId: 'DE123456789',
    iban: 'DE89370400440532013000',
    accentColor: '#f60',
    footerText: 'Vielen Dank für Ihren Auftrag.',
    defaultTaxMode: 'standard',
  });
  if (![200, 204].includes(res.statusCode)) {
    throw new Error(`ensureCompanyProfileComplete failed ${res.statusCode} ${res.body}`);
  }
}

/**
 * Drive a real issuance through the production routes — POST a draft,
 * then POST `/issue`. Returns the issued invoice's id.
 *
 * WHY this exists: `seedIssuedInvoice` writes the row directly via SQL
 * and pre-dates the issuance service, so it leaves
 * `rendered_pdf_binary_descriptor_id` NULL — `InvoiceService.downloadPdf`
 * then correctly returns 404 for that row. The AC-299 PDF-download arms
 * need a row whose descriptor is wired, which only the full issue
 * pipeline produces.
 *
 * Caller must supply a project in `rechnung_faellig` — issuance flips it
 * to `abgerechnet`, so every call consumes one fresh project.
 */
async function issueViaApi(token: string, projectId: string): Promise<string> {
  const draft = await authPost(token, '/api/invoices', {
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
  if (draft.statusCode !== 201) {
    throw new Error(`issueViaApi — draft create failed ${draft.statusCode} ${draft.body}`);
  }
  const draftId = draft.json().id as string;
  const issued = await authPost(
    token,
    `/api/invoices/${draftId}/issue`,
    await expectedVersion(token, `/api/invoices/${draftId}`),
  );
  if (issued.statusCode !== 200) {
    throw new Error(`issueViaApi — issue failed ${issued.statusCode} ${issued.body}`);
  }
  return issued.json().id as string;
}

describe('Invoice routes — integration (issue #109)', () => {
  let ownerToken: string;
  let officeToken: string;
  let workerToken: string;
  let bookkeeperToken: string;
  let projectId: string;

  beforeAll(async () => {
    await startApp();
    [ownerToken, officeToken, workerToken, bookkeeperToken] = await Promise.all([
      login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.bookkeeper.username, SEED_DEFAULT_PASSWORD),
    ]);
    // The AC-299 PDF arms drive real issuances via the production route,
    // which requires a complete company_profile (AC-289). The seed ships
    // the singleton empty; fill it here so the issue gate passes.
    await ensureCompanyProfileComplete(ownerToken);
    projectId = await rechnungFaelligProjectId(ownerToken);
  });

  afterAll(async () => {
    await stopApp();
  });

  // -------------------------------------------------------------------
  // AC-285 — POST /api/invoices creates a draft with documented
  // defaults. Permission matrix: owner / office succeed; worker /
  // bookkeeper rejected with 403; draft on archived project → 404.
  // -------------------------------------------------------------------
  describe('AC-285: POST /api/invoices', () => {
    it('owner creates a draft with documented defaults', async () => {
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
      expect(res.statusCode).toBe(201);

      const body = res.json();
      expect(body.id).toBeDefined();
      expect(body.status).toBe('draft');
      // Draft defaults — number / issueDate / renderedPdfBinaryDescriptorId
      // are null pre-issuance per data-model.md §5.15.
      expect(body.number).toBeNull();
      expect(body.issueDate).toBeNull();
      expect(body.renderedPdfBinaryDescriptorId ?? null).toBeNull();
      expect(body.projectId).toBe(projectId);
      // taxMode defaults from company_profile.defaultTaxMode (the seeded
      // singleton ships `'standard'` per spec §5.17 baseline).
      expect(body.taxMode).toBe('standard');
      // profile defaults to v1's only value per ADR-0026 §E-invoice format.
      expect(body.profile).toBe('zugferd-en16931');
      // recipient pre-filled from the project's customer (live row, not
      // snapshot — the snapshot happens at issuance, AC-285).
      expect(body.recipient).toBeDefined();
      expect(typeof body.recipient.name).toBe('string');
      expect(body.recipient.name.length).toBeGreaterThan(0);

      // AC-285: "produces one `audit_log` row via `mutate()` with
      // `entityType = 'invoice'`, `action = 'create'`, ancestor
      // `('project', projectId)`". Mirrors the AC-286 DELETE audit
      // pattern below — without this assertion an impl that skips
      // audit on POST would pass green.
      const { db, pool } = createDatabase();
      try {
        const r = await db.execute(sql`
          SELECT entity_type, action, ancestor_entity_type, ancestor_entity_id
            FROM audit_log
           WHERE entity_id = ${body.id as string}
           ORDER BY created_at DESC
        `);
        expect(r.rows.length).toBe(1);
        const row = r.rows[0] as Record<string, string>;
        expect(row.entity_type).toBe('invoice');
        expect(row.action).toBe('create');
        expect(row.ancestor_entity_type).toBe('project');
        expect(row.ancestor_entity_id).toBe(projectId);
      } finally {
        await pool.end();
      }
    });

    it('office creates a draft (holds invoice:write)', async () => {
      const res = await authPost(officeToken, '/api/invoices', {
        projectId,
        lines: [
          {
            description: 'Test office line',
            quantity: 1,
            unit: 'h',
            unitPrice: 50,
            lineTotal: 50,
            taxRate: 19,
          },
        ],
        performanceDate: '2026-04-10',
      });
      expect(res.statusCode).toBe(201);
    });

    it('worker is rejected — lacks invoice:write', async () => {
      const res = await authPost(workerToken, '/api/invoices', {
        projectId,
        lines: [],
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('bookkeeper is rejected — holds invoice:read only', async () => {
      const res = await authPost(bookkeeperToken, '/api/invoices', {
        projectId,
        lines: [],
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('draft on an archived project returns 404 NOT_FOUND (parity with AC-95)', async () => {
      // Use an in_arbeit project we can safely archive — the seeded
      // rechnung_faellig set is reserved for issue-path arms.
      const archivableId = await anyActiveProjectId(ownerToken);
      await archiveProject(ownerToken, archivableId);

      const res = await authPost(ownerToken, '/api/invoices', {
        projectId: archivableId,
        lines: [],
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });

    it('taxMode outside TaxMode (kleinunternehmer) is rejected with 422 VALIDATION_ERROR', async () => {
      // ADR-0026 § Tax modes: only `standard` and `reverse_charge` (#552).
      const res = await authPost(ownerToken, '/api/invoices', {
        projectId,
        lines: [],
        taxMode: 'kleinunternehmer',
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(res.json().details)).toContain('taxMode');
    });

    it('calendar-invalid performanceDate is rejected with 422 VALIDATION_ERROR (AC-289 — no silent normalization)', async () => {
      // The route-layer regex (M9 hardening) only enforces structural
      // YYYY-(01-12)-(01-31) shape; calendar-invalid dates like
      // 2026-02-30 pass the regex. Without the service-layer round-trip
      // check, `new Date('2026-02-30')` silently normalizes to
      // 2026-03-02 — the shifted value would land in the immutable
      // issued snapshot, factur-x.xml, and the rendered PDF. §147 AO /
      // GoBD: dates on issued invoices must be exactly as the operator
      // intended; silent normalization is a data-integrity defect.
      for (const bad of ['2026-02-30', '2026-02-29', '2025-04-31', '2025-09-31']) {
        const res = await authPost(ownerToken, '/api/invoices', {
          projectId,
          lines: [],
          performanceDate: bad,
        });
        expect(res.statusCode, `expected ${bad} to be rejected`).toBe(422);
        expect(res.json().code).toBe('VALIDATION_ERROR');
      }
    });

    it('calendar-valid leap-day (2024-02-29) is accepted — round-trip preserves the date', async () => {
      // Sibling positive arm to the calendar-invalid test. 2024 is a
      // leap year; Feb 29 round-trips through Date.UTC unchanged.
      const res = await authPost(ownerToken, '/api/invoices', {
        projectId,
        lines: [],
        performanceDate: '2024-02-29',
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().performanceDate).toBe('2024-02-29');
    });

    it('explicit recipient overrides the project-customer pre-fill field-by-field', async () => {
      // AC-285 design note in api.md §14.2.14: "explicit `recipient` in
      // the body overrides field-by-field". Pinning the override path
      // here so a regression that ignored the body (always pulled from
      // customer) would surface.
      const res = await authPost(ownerToken, '/api/invoices', {
        projectId,
        lines: [],
        recipient: {
          name: 'Override Name GmbH',
          address: { street: 'Override 1', zip: '99999', city: 'Override-Stadt' },
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().recipient.name).toBe('Override Name GmbH');
    });
  });

  // -------------------------------------------------------------------
  // AC-286 — PATCH + DELETE freeze rules.
  // PATCH on draft re-derives totals; PATCH on issued → 422 INVOICE_FROZEN.
  // DELETE on draft hard-deletes; DELETE on non-draft → 422 INVOICE_FROZEN.
  // -------------------------------------------------------------------
  describe('AC-286: PATCH and DELETE freeze rules', () => {
    it('PATCH on a draft updates fields and re-derives totals from lines + taxMode', async () => {
      const draftId = await seedDraftInvoice(projectId);

      const res = await authPatch(ownerToken, `/api/invoices/${draftId}`, {
        ...(await expectedVersion(ownerToken, `/api/invoices/${draftId}`)),
        lines: [
          {
            description: 'Updated line',
            quantity: 2,
            unit: 'Stück',
            unitPrice: 200,
            lineTotal: 400,
            taxRate: 19,
          },
        ],
      });
      expect(res.statusCode).toBe(200);

      const body = res.json();
      // Totals re-derived server-side per AC-286.
      expect(body.totals.netGrandTotal).toBe(400);
      // For standard mode the per-rate breakdown is populated.
      expect(body.totals.perRate).toBeDefined();
      expect(Array.isArray(body.totals.perRate)).toBe(true);
      const r19 = (body.totals.perRate as Array<{ taxRate: number; taxAmount: number }>).find(
        (p) => p.taxRate === 19,
      );
      expect(r19).toBeDefined();
      expect(r19!.taxAmount).toBeCloseTo(76, 2);
      expect(body.totals.grossGrandTotal).toBeCloseTo(476, 2);
    });

    it('PATCH with a taxMode outside TaxMode (kleinunternehmer) → 422 VALIDATION_ERROR; draft unchanged', async () => {
      const draftId = await seedDraftInvoice(projectId);
      const before = (await authGet(ownerToken, `/api/invoices/${draftId}`)).json();

      const res = await authPatch(ownerToken, `/api/invoices/${draftId}`, {
        ...(await expectedVersion(ownerToken, `/api/invoices/${draftId}`)),
        taxMode: 'kleinunternehmer',
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(res.json().details)).toContain('taxMode');
      const after = (await authGet(ownerToken, `/api/invoices/${draftId}`)).json();
      expect(after.taxMode).toBe(before.taxMode);
      expect(after.version).toBe(before.version);
    });

    it('PATCH on an issued row returns 422 VALIDATION_ERROR with code INVOICE_FROZEN; no field changes', async () => {
      const issuedId = await seedIssuedInvoice(projectId, '9001');

      const res = await authPatch(ownerToken, `/api/invoices/${issuedId}`, {
        ...(await expectedVersion(ownerToken, `/api/invoices/${issuedId}`)),
        lines: [
          {
            description: 'Should not land',
            quantity: 999,
            unit: 'X',
            unitPrice: 1,
            lineTotal: 999,
            taxRate: 0,
          },
        ],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('INVOICE_FROZEN');

      // Verify no field changed — the lines array is still the seed's.
      const after = await authGet(ownerToken, `/api/invoices/${issuedId}`);
      expect(after.statusCode).toBe(200);
      const stored = after.json();
      expect(
        (stored.lines as Array<{ description: string }>).every(
          (l) => l.description !== 'Should not land',
        ),
      ).toBe(true);
    });

    it('DELETE on a draft removes the row, writes one invoice:delete audit row; subsequent GET → 404', async () => {
      // ADR-0026 §Audit and realtime pins draft mutations to the
      // single-write `mutate()` path — so DELETE on a draft must
      // produce one audit row with `action = 'invoice:delete'` and
      // `entityType = 'invoice'`. The seed helper inserts via raw
      // SQL so no audit row exists pre-call; the assertion below is
      // the +1 invariant.
      const draftId = await seedDraftInvoice(projectId);

      const { db, pool } = createDatabase();
      let auditBefore: number;
      try {
        const r = await db.execute(
          sql`SELECT COUNT(*)::int AS c FROM audit_log WHERE entity_id = ${draftId}`,
        );
        auditBefore = (r.rows[0] as { c: number }).c;
      } finally {
        await pool.end();
      }

      const { expectedVersion: v } = await expectedVersion(ownerToken, `/api/invoices/${draftId}`);
      const del = await authDelete(ownerToken, `/api/invoices/${draftId}?expectedVersion=${v}`);
      expect(del.statusCode).toBe(204);

      const get = await authGet(ownerToken, `/api/invoices/${draftId}`);
      expect(get.statusCode).toBe(404);

      const { db: db2, pool: pool2 } = createDatabase();
      try {
        const r = await db2.execute(sql`
          SELECT entity_type, action, ancestor_entity_type, ancestor_entity_id
            FROM audit_log
           WHERE entity_id = ${draftId}
           ORDER BY created_at DESC
        `);
        expect(r.rows.length - auditBefore).toBe(1);
        const row = r.rows[0] as Record<string, string>;
        expect(row.entity_type).toBe('invoice');
        expect(row.action).toBe('invoice:delete');
        // Ancestor link to the parent project (ADR-0026 §Audit and realtime).
        expect(row.ancestor_entity_type).toBe('project');
        expect(row.ancestor_entity_id).toBe(projectId);
      } finally {
        await pool2.end();
      }
    });

    it('DELETE on an issued row returns 422 INVOICE_FROZEN; row unchanged', async () => {
      const issuedId = await seedIssuedInvoice(projectId, '9002');

      const { expectedVersion: v } = await expectedVersion(ownerToken, `/api/invoices/${issuedId}`);
      const del = await authDelete(ownerToken, `/api/invoices/${issuedId}?expectedVersion=${v}`);
      expect(del.statusCode).toBe(422);
      expect(del.json().code).toBe('INVOICE_FROZEN');

      const get = await authGet(ownerToken, `/api/invoices/${issuedId}`);
      expect(get.statusCode).toBe(200);
      expect(get.json().status).toBe('issued');
    });

    it('PATCH / DELETE by worker / bookkeeper are rejected at the permission gate', async () => {
      const draftId = await seedDraftInvoice(projectId);

      // A well-formed body — the permission gate is under test, not the version.
      const workerPatch = await authPatch(workerToken, `/api/invoices/${draftId}`, {
        expectedVersion: 1,
        lines: [],
      });
      expect(workerPatch.statusCode).toBe(403);
      expect(workerPatch.json().code).toBe('NOT_PERMITTED');

      const bkDelete = await authDelete(
        bookkeeperToken,
        `/api/invoices/${draftId}?expectedVersion=1`,
      );
      expect(bkDelete.statusCode).toBe(403);
      expect(bkDelete.json().code).toBe('NOT_PERMITTED');
    });
  });

  // -------------------------------------------------------------------
  // AC-298 — Worker scope: empty list, 403 on existing get,
  // 404 on unknown id. The worker scope predicate (ADR-0019) returns
  // the empty set for the worker role on the invoice repository, so
  // GET /api/invoices returns 0 rows regardless of `project_workers`
  // assignments.
  // -------------------------------------------------------------------
  describe('AC-298: worker exclusion via repository-predicate scope', () => {
    it('worker GET /api/invoices returns an empty list regardless of project assignments', async () => {
      // Seed a draft so the list is non-empty for owner/office; the
      // worker filter must still produce zero results.
      await seedDraftInvoice(projectId);

      const res = await authGet(workerToken, '/api/invoices');
      expect(res.statusCode).toBe(200);
      // Pin one wire shape — `{ data: [...] }` mirrors the existing
      // list endpoints (projects, attachments). A regression to
      // `{ invoices: [...] }` would be a separate visible decision.
      const body = res.json() as { data: unknown[] };
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(0);
    });

    it('worker GET /api/invoices/:id on an existing row → 403 NOT_PERMITTED', async () => {
      const draftId = await seedDraftInvoice(projectId);

      const res = await authGet(workerToken, `/api/invoices/${draftId}`);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('worker GET /api/invoices/:id on an unknown id → 404 NOT_FOUND', async () => {
      const res = await authGet(workerToken, '/api/invoices/00000000-0000-0000-0000-000000000000');
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------
  // AC-299 — GET /api/invoices/:id/pdf
  // Status: issued | cancelled → bytes (or presigned-GET + DEK wrapper).
  //        draft → 409 INVOICE_NOT_ISSUED.
  //        worker → 403 NOT_PERMITTED (covered by AC-298).
  // -------------------------------------------------------------------
  describe('AC-299: GET /api/invoices/:id/pdf', () => {
    // Each PDF-download arm that needs real rendered bytes drives a
    // full issuance via `issueViaApi`, which flips its project to
    // `abgerechnet`. The seed ships 3 `rechnung_faellig` projects
    // (`src/server/seed/business.ts`); track consumed IDs so each call
    // claims a fresh slot. The 409/draft and 403/worker arms keep
    // using `seedIssuedInvoice` — they don't need a real PDF.
    const consumedProjectIds = new Set<string>();

    it('returns the rendered PDF for an issued row — Content-Type-branched assertion', async () => {
      const pid = await rechnungFaelligProjectId(ownerToken, consumedProjectIds);
      consumedProjectIds.add(pid);
      const issuedId = await issueViaApi(ownerToken, pid);
      const res = await authGet(ownerToken, `/api/invoices/${issuedId}/pdf`);
      assertPdfDownloadShape(res);
    });

    it('returns the rendered PDF for a cancelled row — same wire contract as issued', async () => {
      // AC-299 names `status ∈ {'issued', 'cancelled'}` as the
      // PDF-downloadable set. Cancelled rows are legally retained
      // artifacts under §147 AO; the bytes must remain reachable.
      //
      // The original's `renderedPdfBinaryDescriptorId` is preserved on
      // cancel (InvoiceService.cancel only flips status / updatedAt /
      // updatedBy on the original — confirmed against the immutability
      // trigger). Download the ORIGINAL's PDF, not the Storno's.
      const pid = await rechnungFaelligProjectId(ownerToken, consumedProjectIds);
      consumedProjectIds.add(pid);
      const issuedId = await issueViaApi(ownerToken, pid);
      const cancel = await authPost(ownerToken, `/api/invoices/${issuedId}/cancel`, {});
      expect(cancel.statusCode).toBe(200);
      const res = await authGet(ownerToken, `/api/invoices/${issuedId}/pdf`);
      assertPdfDownloadShape(res);
    });

    it('returns 409 INVOICE_NOT_ISSUED on a draft', async () => {
      const draftId = await seedDraftInvoice(projectId);

      const res = await authGet(ownerToken, `/api/invoices/${draftId}/pdf`);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('INVOICE_NOT_ISSUED');
    });

    it('returns 403 NOT_PERMITTED to a worker on an issued row', async () => {
      const issuedId = await seedIssuedInvoice(projectId, '9101');

      const res = await authGet(workerToken, `/api/invoices/${issuedId}/pdf`);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('bookkeeper can download the PDF (holds invoice:read)', async () => {
      const pid = await rechnungFaelligProjectId(ownerToken, consumedProjectIds);
      consumedProjectIds.add(pid);
      const issuedId = await issueViaApi(ownerToken, pid);

      const res = await authGet(bookkeeperToken, `/api/invoices/${issuedId}/pdf`);
      assertPdfDownloadShape(res);
    });
  });

  // -------------------------------------------------------------------
  // AC-298 / AC-297 — Authenticated/unauthenticated arm of the
  // permission matrix. Concentrated here per the task brief; sibling
  // files reference this coverage conceptually rather than duplicate.
  // -------------------------------------------------------------------
  describe('AC-298 / AC-297: authentication + permission matrix', () => {
    it('unauthenticated GET /api/invoices → 401', async () => {
      const res = await authGet('', '/api/invoices');
      expect(res.statusCode).toBe(401);
      // Either code is spec-conformant (the session middleware emits
      // both UNAUTHENTICATED and SESSION_EXPIRED — neither is wrong).
      expect(['UNAUTHENTICATED', 'SESSION_EXPIRED']).toContain(res.json().code);
    });

    it('unauthenticated POST /api/invoices → 401', async () => {
      const res = await authPost('', '/api/invoices', { projectId, lines: [] });
      expect(res.statusCode).toBe(401);
    });

    it('bookkeeper can list and get — holds invoice:read', async () => {
      const draftId = await seedDraftInvoice(projectId);

      const list = await authGet(bookkeeperToken, '/api/invoices');
      expect(list.statusCode).toBe(200);

      const get = await authGet(bookkeeperToken, `/api/invoices/${draftId}`);
      expect(get.statusCode).toBe(200);
    });

    it('office can list and get — holds invoice:read', async () => {
      const draftId = await seedDraftInvoice(projectId);

      const list = await authGet(officeToken, '/api/invoices');
      expect(list.statusCode).toBe(200);

      const get = await authGet(officeToken, `/api/invoices/${draftId}`);
      expect(get.statusCode).toBe(200);
    });
  });
});
