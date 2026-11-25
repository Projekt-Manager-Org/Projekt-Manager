/**
 * API integration tests — the date an invoice or Storno is issued on
 * (AC-690): the calendar date in Germany (Europe/Berlin) at issuance,
 * its number carrying that date's year.
 *
 * Each arm issues through the services' clock seam at an instant past
 * midnight in Berlin but before midnight UTC, where the UTC date is a
 * day — and at New Year a year — behind. Years lie past the seed's, so
 * every sequence starts fresh.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  startApp,
  stopApp,
  login,
  authPost,
  authPut,
  expectedVersion,
  seedProjectStatus,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase, type Database } from '../db/connection.js';
import { InvoiceIssueService } from '../services/InvoiceIssueService.js';
import { InvoiceCancelService } from '../services/InvoiceCancelService.js';
import { InvoiceBinaryService } from '../services/InvoiceBinaryService.js';
import { createStorageClientFromEnv } from '../storage/fromEnv.js';
import { getEnv } from '../config/env.js';
import { getInvoiceObjectLockDays } from '../config/index.js';
import type { ServiceLogger } from '../services/Logger.js';

/** A draft no write has touched since its create (data-model.md §6.4). */
const FRESH_DRAFT_VERSION = 1;

const noopLog: ServiceLogger = {
  info: () => undefined,
  error: () => undefined,
};

describe('Invoice issue date in Germany (AC-690)', () => {
  let ownerToken: string;
  let ownerId: string;
  let customerId: string;
  let conn: { db: Database; pool: import('pg').Pool };
  let issueService: InvoiceIssueService;
  let cancelService: InvoiceCancelService;

  async function issuableDraft(): Promise<string> {
    const suffix = crypto.randomUUID().slice(0, 8);
    const project = await authPost(ownerToken, '/api/projects', {
      number: `AC690-${suffix}`,
      title: `Issue date fixture ${suffix}`,
      customerId,
    });
    if (project.statusCode !== 201) {
      throw new Error(`project create failed ${project.statusCode} ${project.body}`);
    }
    const projectId = project.json().id as string;
    await seedProjectStatus(projectId, 'rechnung_faellig');
    const draft = await authPost(ownerToken, '/api/invoices', {
      projectId,
      lines: [
        { description: 'Anstrich', quantity: 1, unit: 'pauschal', unitPrice: 100, taxRate: 19 },
      ],
      performanceDate: '2026-04-10',
    });
    if (draft.statusCode !== 201) {
      throw new Error(`draft create failed ${draft.statusCode} ${draft.body}`);
    }
    return draft.json().id as string;
  }

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    const profile = await authPut(ownerToken, '/api/company-profile', {
      ...(await expectedVersion(ownerToken, '/api/company-profile')),
      companyName: 'Test Maler GmbH',
      address: { street: 'Werkstr. 1', zip: '10115', city: 'Berlin' },
      taxId: '111/222/33333',
      ustId: 'DE123456789',
      defaultTaxMode: 'standard',
    });
    expect([200, 204]).toContain(profile.statusCode);

    conn = createDatabase();
    const users = await conn.db.execute(
      sql`SELECT id FROM users WHERE username = ${SEED_USERS.owner.username}`,
    );
    ownerId = (users.rows[0] as { id: string }).id;
    const customers = await conn.db.execute(sql`SELECT id FROM customers LIMIT 1`);
    customerId = (customers.rows[0] as { id: string }).id;

    const env = getEnv();
    const binary = new InvoiceBinaryService(conn.db, {
      storage: createStorageClientFromEnv(env),
      binaryAgeRecipient: env.BINARY_AGE_RECIPIENT!,
      binaryAgeIdentityPath: env.BINARY_AGE_IDENTITY_PATH!,
      invoiceObjectLockDays: getInvoiceObjectLockDays(),
    });
    issueService = new InvoiceIssueService(conn.db, binary);
    cancelService = new InvoiceCancelService(conn.db, binary);
  });

  afterAll(async () => {
    if (conn) await conn.pool.end();
    await stopApp();
  });

  it('dates an invoice issued at 00:30 on 1 January in Berlin with that day and year', async () => {
    const draftId = await issuableDraft();

    // 00:30 CET on 2041-01-01.
    const now = new Date('2040-12-31T23:30:00.000Z');
    const issued = await issueService.issueDraft(
      draftId,
      FRESH_DRAFT_VERSION,
      ownerId,
      noopLog,
      null,
      now,
    );

    expect(issued.issueDate).toBe('2041-01-01');
    expect(issued.number).toMatch(/^RE-2041-\d{4,}$/);
  });

  it('dates an invoice issued at 00:30 in Berlin summer time with that day', async () => {
    const draftId = await issuableDraft();

    // 00:30 CEST on 2042-07-15.
    const now = new Date('2042-07-14T22:30:00.000Z');
    const issued = await issueService.issueDraft(
      draftId,
      FRESH_DRAFT_VERSION,
      ownerId,
      noopLog,
      null,
      now,
    );

    expect(issued.issueDate).toBe('2042-07-15');
    expect(issued.number).toMatch(/^RE-2042-\d{4,}$/);
  });

  it('dates a Storno issued at 00:30 on 1 January in Berlin with that day and year', async () => {
    const draftId = await issuableDraft();
    const original = await issueService.issueDraft(
      draftId,
      FRESH_DRAFT_VERSION,
      ownerId,
      noopLog,
      null,
      new Date('2043-06-01T10:00:00.000Z'),
    );

    // 00:30 CET on 2044-01-01.
    const now = new Date('2043-12-31T23:30:00.000Z');
    const { storno } = await cancelService.cancel(
      original.id,
      { reason: 'Falscher Empfänger' },
      ownerId,
      noopLog,
      null,
      now,
    );

    expect(storno.issueDate).toBe('2044-01-01');
    expect(storno.number).toMatch(/^ST-2044-\d{4,}$/);
  });
});
