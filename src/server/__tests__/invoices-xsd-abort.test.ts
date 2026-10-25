/**
 * Per-render XSD failure aborts the issue / cancel transaction (AC-293,
 * #559).
 *
 *   POST /api/invoices/:id/issue
 *   POST /api/invoices/:id/cancel
 *
 * Seam: the real builder, renderer, validator and services run. A module
 * mock breaks one schema facet in the built XML (a non-decimal
 * `GrandTotalAmount`) while `xsdFault.on` is set, and the validator is
 * wrapped in `vi.fn` so each test can prove the rejection came from the
 * real XSD check, not from some other throw. Both mocks live in this
 * file so they cannot leak into the other invoice suites.
 *
 * Each path asserts the whole atom rolled back: no number allocated,
 * rows unchanged, no audit row, no rendered PDF, no SSE event.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
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
import { FacturXValidationError, validateFacturXml } from '../services/invoice/xsdValidator.js';

const xsdFault = vi.hoisted(() => ({ on: false }));

vi.mock('../services/invoice/facturXmlBuilder.js', async (importActual) => {
  const actual = await importActual<typeof import('../services/invoice/facturXmlBuilder.js')>();
  return {
    ...actual,
    buildFacturXml: (...args: Parameters<typeof actual.buildFacturXml>) => {
      const xml = actual.buildFacturXml(...args);
      if (!xsdFault.on) return xml;
      // `GrandTotalAmount` is `udt:AmountType` → `xs:decimal`; the
      // same facet xsd-validator.test.ts pins.
      return xml.replace(
        /<ram:GrandTotalAmount>[^<]*<\/ram:GrandTotalAmount>/,
        '<ram:GrandTotalAmount>not-a-decimal</ram:GrandTotalAmount>',
      );
    },
  };
});

vi.mock('../services/invoice/xsdValidator.js', async (importActual) => {
  const actual = await importActual<typeof import('../services/invoice/xsdValidator.js')>();
  return { ...actual, validateFacturXml: vi.fn(actual.validateFacturXml) };
});

const validateSpy = vi.mocked(validateFacturXml);
// UTC, like the services' allocation year.
const year = new Date().getUTCFullYear();

// ---------------------------------------------------------------------
// SSE bus surface — mirrors invoices-cancel.test.ts.
// ---------------------------------------------------------------------

interface SseConnection {
  write(chunk: string): void;
}

interface SseBusModule {
  subscribe(c: SseConnection): void;
  unsubscribe(c: SseConnection): void;
}

interface SubscribedFake extends SseConnection {
  chunks: string[];
}

async function subscribeFake(): Promise<{ bus: SseBusModule; conn: SubscribedFake }> {
  const path = '../sse/bus.js';
  const bus = (await import(/* @vite-ignore */ path)) as unknown as SseBusModule;
  const conn: SubscribedFake = {
    chunks: [],
    write(chunk: string): void {
      this.chunks.push(chunk);
    },
  };
  bus.subscribe(conn);
  return { bus, conn };
}

function countEvents(conn: SubscribedFake): number {
  return conn.chunks.join('').match(/^event: /gm)?.length ?? 0;
}

// ---------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------

async function rechnungFaelligProjectIds(ownerToken: string): Promise<string[]> {
  const res = await authGet(ownerToken, '/api/projects?status=rechnung_faellig&limit=200');
  const ids = (res.json().data as { id: string }[]).map((p) => p.id);
  if (ids.length < 2) throw new Error('seed needs two projects in rechnung_faellig');
  return ids;
}

async function ensureCompanyProfileComplete(ownerToken: string): Promise<void> {
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
        taxRate: 19,
      },
    ],
    performanceDate: '2026-04-10',
  });
  if (res.statusCode !== 201) throw new Error(`createDraft failed ${res.statusCode} ${res.body}`);
  return res.json().id as string;
}

async function postIssue(ownerToken: string, draftId: string) {
  return authPost(
    ownerToken,
    `/api/invoices/${draftId}/issue`,
    await expectedVersion(ownerToken, `/api/invoices/${draftId}`),
  );
}

async function query<T>(statement: ReturnType<typeof sql>): Promise<T[]> {
  const { db, pool } = createDatabase();
  try {
    return (await db.execute(statement)).rows as T[];
  } finally {
    await pool.end();
  }
}

/** Everything the abort must leave untouched, read via direct SQL. */
async function snapshot(projectId: string, invoiceId: string) {
  const [invoice] = await query<Record<string, unknown>>(
    sql`SELECT * FROM invoices WHERE id = ${invoiceId}`,
  );
  const [project] = await query<Record<string, unknown>>(
    sql`SELECT * FROM projects WHERE id = ${projectId}`,
  );
  const sequences = await query<{ kind: string; next_value: string }>(
    sql`SELECT kind, next_value FROM invoice_sequence WHERE year = ${year} ORDER BY kind`,
  );
  const [counts] = await query<{ invoices: number; audit: number; attachments: number }>(sql`
    SELECT
      (SELECT COUNT(*)::int FROM invoices WHERE project_id = ${projectId}) AS invoices,
      (SELECT COUNT(*)::int FROM audit_log WHERE ancestor_entity_id = ${projectId}) AS audit,
      (SELECT COUNT(*)::int FROM attachments WHERE project_id = ${projectId}) AS attachments
  `);
  return { invoice, project, sequences, counts };
}

/** The validator ran on the broken XML and rejected it. */
async function expectXsdRejection(): Promise<void> {
  expect(validateSpy).toHaveBeenCalledTimes(1);
  expect(validateSpy.mock.calls[0]![0]).toContain('not-a-decimal');
  await expect(validateSpy.mock.results[0]!.value).rejects.toBeInstanceOf(FacturXValidationError);
}

// ---------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------

describe('Invoice per-render XSD failure aborts the transaction (AC-293)', () => {
  let ownerToken: string;
  let issueProjectId: string;
  let cancelProjectId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    await ensureCompanyProfileComplete(ownerToken);
    [issueProjectId, cancelProjectId] = await rechnungFaelligProjectIds(ownerToken);
  });

  afterEach(() => {
    xsdFault.on = false;
    validateSpy.mockClear();
  });

  afterAll(async () => {
    await stopApp();
  });

  it('issue: rejected; no number, draft and project unchanged, no audit row, PDF or SSE event', async () => {
    const draftId = await createDraft(ownerToken, issueProjectId!);
    const before = await snapshot(issueProjectId!, draftId);

    const { bus, conn } = await subscribeFake();
    try {
      validateSpy.mockClear();
      xsdFault.on = true;
      const res = await postIssue(ownerToken, draftId);

      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      await expectXsdRejection();
      expect(await snapshot(issueProjectId!, draftId)).toEqual(before);
      expect(before.invoice!.status).toBe('draft');
      expect(countEvents(conn)).toBe(0);
    } finally {
      bus.unsubscribe(conn);
    }
  });

  it('cancel: rejected; no Storno number or row, original unchanged, no audit row, PDF or SSE event', async () => {
    const draftId = await createDraft(ownerToken, cancelProjectId!);
    const issued = await postIssue(ownerToken, draftId);
    expect(issued.statusCode).toBe(200);
    const before = await snapshot(cancelProjectId!, draftId);

    const { bus, conn } = await subscribeFake();
    try {
      validateSpy.mockClear();
      xsdFault.on = true;
      const res = await authPost(ownerToken, `/api/invoices/${draftId}/cancel`, {
        reason: 'Tippfehler',
      });

      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      await expectXsdRejection();
      expect(await snapshot(cancelProjectId!, draftId)).toEqual(before);
      expect(before.invoice!.status).toBe('issued');
      expect(countEvents(conn)).toBe(0);
    } finally {
      bus.unsubscribe(conn);
    }
  });
});
