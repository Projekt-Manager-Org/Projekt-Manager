/**
 * Stale-write rejection — optimistic concurrency on edits
 * (data-model.md §6.4, api.md §14.2.5 / §14.2.14 / §14.2.15).
 *
 * AC coverage in this file:
 *   - AC-375: every versioned edit rejects a stale `expectedVersion`
 *     with `409 VERSION_CONFLICT`; row, audit log and SSE stay untouched.
 *     A positive control with the current version succeeds, so a route
 *     that rejects everything cannot pass.
 *   - AC-376: a stale issue allocates no number and leaves the
 *     draft, the project, the sequence and the PDF prefix in storage untouched.
 *   - AC-377: a versioned operation without `expectedVersion` is
 *     a `422 VALIDATION_ERROR`.
 *   - AC-378: issuing a draft changes its version; cancelling the
 *     issued invoice does not.
 *   - AC-381: two writes carrying the same current version, queued
 *     in a fixed order behind a row lock held by a third connection, commit
 *     exactly once — the first in the queue.
 *
 * Transport assumption (S-NDET): Delete draft carries `expectedVersion`
 * as a query parameter — a DELETE body has no defined semantics.
 */

import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import {
  startApp,
  stopApp,
  login,
  getApp,
  getDb,
  authGet,
  authPost,
  authPatch,
  authPut,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import { getEnv } from '../config/env.js';
import { createStorageClientFromEnv } from '../storage/fromEnv.js';
import { INVOICE_PDF_KEY_PREFIX } from '../repositories/attachment.js';
import { subscribe, unsubscribe, type SseConnection } from '../sse/bus.js';

type Res = LightMyRequestResponse;

let ownerToken: string;
let customerId: string;

const LINE = {
  description: 'Anstrich Fassade',
  quantity: 1,
  unit: 'pauschal',
  unitPrice: 1500,
  lineTotal: 1500,
  taxRate: 19,
};

const PROFILE = {
  companyName: 'Test Maler GmbH',
  address: { street: 'Werkstr. 1', zip: '10115', city: 'Berlin' },
  taxId: '111/222/33333',
  ustId: 'DE123456789',
  iban: 'DE89370400440532013000',
  accentColor: null,
  footerText: null,
  defaultTaxMode: 'standard',
};

const year = new Date().getFullYear();

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

async function mintProject(status: string): Promise<string> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const res = await authPost(ownerToken, '/api/projects', {
    number: `SW-${suffix}`,
    title: `Stale-write fixture ${suffix}`,
    customerId,
    status,
  });
  if (res.statusCode !== 201) throw new Error(`mintProject ${res.statusCode} ${res.body}`);
  return res.json().id as string;
}

async function mintCustomer(): Promise<string> {
  // A billing address makes drafts on its projects issuable (AC-289).
  const res = await authPost(ownerToken, '/api/customers', {
    name: `Stale-write Kunde ${crypto.randomUUID().slice(0, 8)}`,
    address: { street: 'Hauptstr. 12', zip: '51465', city: 'Bergisch Gladbach' },
  });
  if (res.statusCode !== 201) throw new Error(`mintCustomer ${res.statusCode} ${res.body}`);
  return res.json().id as string;
}

async function mintDraft(): Promise<{ invoiceId: string; projectId: string }> {
  const projectId = await mintProject('rechnung_faellig');
  const res = await authPost(ownerToken, '/api/invoices', {
    projectId,
    lines: [LINE],
    performanceDate: '2026-04-10',
  });
  if (res.statusCode !== 201) throw new Error(`mintDraft ${res.statusCode} ${res.body}`);
  return { invoiceId: res.json().id as string, projectId };
}

/** GET the entity and return its body; fails fast when `version` is absent. */
async function read(url: string): Promise<Record<string, unknown> & { version: number }> {
  const res = await authGet(ownerToken, url);
  expect(res.statusCode, `GET ${url}: ${res.body}`).toBe(200);
  const body = res.json();
  expect(typeof body.version, `GET ${url} carries no numeric version`).toBe('number');
  return body;
}

async function versionOf(url: string): Promise<number> {
  return (await read(url)).version;
}

function deleteDraft(invoiceId: string, expectedVersion?: number): Promise<Res> {
  const query = expectedVersion === undefined ? '' : `?expectedVersion=${expectedVersion}`;
  return getApp().inject({
    method: 'DELETE',
    url: `/api/invoices/${invoiceId}${query}`,
    headers: { cookie: `session=${ownerToken}` },
  });
}

/** Rendered invoice PDFs stored for the project (`invoicePdfKey`). */
function storedInvoicePdfs(projectId: string): Promise<string[]> {
  return createStorageClientFromEnv(getEnv()).listObjects(`${INVOICE_PDF_KEY_PREFIX}${projectId}/`);
}

async function auditRowCount(): Promise<number> {
  const res = await getDb().execute(sql`SELECT COUNT(*)::int AS c FROM audit_log`);
  return (res.rows[0] as { c: number }).c;
}

async function invoiceSequenceNextValue(): Promise<number | null> {
  const res = await getDb().execute(
    sql`SELECT next_value FROM invoice_sequence WHERE year = ${year} AND kind = 'invoice'`,
  );
  return res.rows.length === 0
    ? null
    : Number((res.rows[0] as { next_value: string | number }).next_value);
}

/** Records every SSE frame broadcast while it is subscribed. */
function sseRecorder(): { frames: () => number; stop: () => void } {
  const chunks: string[] = [];
  const conn: SseConnection = { write: (chunk: string) => void chunks.push(chunk) };
  subscribe(conn);
  return {
    frames: () => (chunks.join('').match(/^event: /gm) ?? []).length,
    stop: () => unsubscribe(conn),
  };
}

/** Lets post-commit SSE dispatch run before asserting its absence. */
const settle = () => new Promise<void>((r) => setTimeout(r, 100));

function expectVersionConflict(res: Res): void {
  expect(res.statusCode, res.body).toBe(409);
  expect(res.json().code).toBe('VERSION_CONFLICT');
}

// ---------------------------------------------------------------------
// Versioned operations — one row per operation in api.md marked
// `expectedVersion`. `write` performs the operation under test;
// `readUrl` is the entity's GET.
// ---------------------------------------------------------------------

interface VersionedCase {
  name: string;
  setup: () => Promise<{
    readUrl: string;
    /** Row the operation writes — AC-381 locks it. */
    row: { table: string; id: string };
    write: (expectedVersion?: number) => Promise<Res>;
  }>;
}

const VERSIONED: VersionedCase[] = [
  {
    name: 'Update customer',
    setup: async () => {
      const id = await mintCustomer();
      return {
        readUrl: `/api/customers/${id}`,
        row: { table: 'customers', id },
        write: (v) =>
          authPatch(ownerToken, `/api/customers/${id}`, {
            phone: `+49 221 ${crypto.randomInt(1_000_000, 9_999_999)}`,
            ...(v === undefined ? {} : { expectedVersion: v }),
          }),
      };
    },
  },
  {
    name: 'Update draft',
    setup: async () => {
      const { invoiceId } = await mintDraft();
      return {
        readUrl: `/api/invoices/${invoiceId}`,
        row: { table: 'invoices', id: invoiceId },
        write: (v) =>
          authPatch(ownerToken, `/api/invoices/${invoiceId}`, {
            lines: [{ ...LINE, description: `Zeile ${crypto.randomUUID().slice(0, 8)}` }],
            ...(v === undefined ? {} : { expectedVersion: v }),
          }),
      };
    },
  },
  {
    name: 'Upsert company profile',
    setup: async () => ({
      readUrl: '/api/company-profile',
      row: { table: 'company_profile', id: await companyProfileId() },
      write: (v) =>
        authPut(ownerToken, '/api/company-profile', {
          ...PROFILE,
          footerText: `Fuß ${crypto.randomUUID().slice(0, 8)}`,
          ...(v === undefined ? {} : { expectedVersion: v }),
        }),
    }),
  },
];

async function companyProfileId(): Promise<string> {
  const res = await getDb().execute(sql`SELECT id FROM company_profile`);
  return (res.rows[0] as { id: string }).id;
}

beforeAll(async () => {
  await startApp();
  ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  customerId = await mintCustomer();
  // Issue arms need a complete profile (AC-289); write it with the current version.
  const profile = await authGet(ownerToken, '/api/company-profile');
  const put = await authPut(ownerToken, '/api/company-profile', {
    ...PROFILE,
    expectedVersion: profile.json().version,
  });
  expect(put.statusCode, put.body).toBe(200);
});

afterAll(async () => {
  await stopApp();
});

// ---------------------------------------------------------------------
// AC-375
// ---------------------------------------------------------------------

describe('AC-375: a stale expectedVersion is rejected and writes nothing', () => {
  it.each(VERSIONED)('$name', async ({ setup }) => {
    const { readUrl, write } = await setup();
    const stale = await versionOf(readUrl);

    // Another session's edit lands first.
    const intervening = await write(stale);
    expect(intervening.statusCode, intervening.body).toBe(200);
    const current = await read(readUrl);

    const audit = await auditRowCount();
    const sse = sseRecorder();
    try {
      expectVersionConflict(await write(stale));
      await settle();
      expect(await read(readUrl)).toEqual(current);
      expect(await auditRowCount()).toBe(audit);
      expect(sse.frames()).toBe(0);
    } finally {
      sse.stop();
    }

    // Positive control — the current version still writes.
    const fresh = await write(current.version);
    expect(fresh.statusCode, fresh.body).toBe(200);
  });

  it('Delete draft', async () => {
    const { invoiceId } = await mintDraft();
    const readUrl = `/api/invoices/${invoiceId}`;
    const stale = await versionOf(readUrl);
    const edit = await authPatch(ownerToken, readUrl, {
      lines: [{ ...LINE, description: 'Nachgebessert' }],
      expectedVersion: stale,
    });
    expect(edit.statusCode, edit.body).toBe(200);
    const current = await read(readUrl);

    const audit = await auditRowCount();
    const sse = sseRecorder();
    try {
      expectVersionConflict(await deleteDraft(invoiceId, stale));
      await settle();
      expect(await read(readUrl)).toEqual(current);
      expect(await auditRowCount()).toBe(audit);
      expect(sse.frames()).toBe(0);
    } finally {
      sse.stop();
    }

    const fresh = await deleteDraft(invoiceId, current.version);
    expect(fresh.statusCode, fresh.body).toBe(204);
  });
});

// ---------------------------------------------------------------------
// AC-376
// ---------------------------------------------------------------------

describe('AC-376: a stale issue allocates no number and writes nothing', () => {
  it('rejects, then the current version issues with the number the rejected call would have taken', async () => {
    const { invoiceId, projectId } = await mintDraft();
    const readUrl = `/api/invoices/${invoiceId}`;
    const stale = await versionOf(readUrl);
    const edit = await authPatch(ownerToken, readUrl, {
      lines: [{ ...LINE, description: 'Ungeprüfte Änderung' }],
      expectedVersion: stale,
    });
    expect(edit.statusCode, edit.body).toBe(200);
    const current = await read(readUrl);

    const sequence = await invoiceSequenceNextValue();
    const audit = await auditRowCount();
    const sse = sseRecorder();
    try {
      expectVersionConflict(
        await authPost(ownerToken, `${readUrl}/issue`, { expectedVersion: stale }),
      );
      await settle();
      expect(await read(readUrl)).toEqual(current);
      // The rollback hides a late check from the DB, not from storage.
      expect(await storedInvoicePdfs(projectId)).toEqual([]);
      expect((await authGet(ownerToken, `/api/projects/${projectId}`)).json().status).toBe(
        'rechnung_faellig',
      );
      expect(await invoiceSequenceNextValue()).toBe(sequence);
      expect(await auditRowCount()).toBe(audit);
      expect(sse.frames()).toBe(0);
    } finally {
      sse.stop();
    }

    const issued = await authPost(ownerToken, `${readUrl}/issue`, {
      expectedVersion: current.version,
    });
    expect(issued.statusCode, issued.body).toBe(200);
    // `sequence` is the value the next allocation hands out (1 when the row is absent).
    const expected = `RE-${year}-${String(sequence ?? 1).padStart(4, '0')}`;
    expect(issued.json().number).toBe(expected);
    // Positive control for the storage probe above.
    expect(await storedInvoicePdfs(projectId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------
// AC-377
// ---------------------------------------------------------------------

describe('AC-377: a missing expectedVersion is a validation error', () => {
  it.each(VERSIONED)('$name', async ({ setup }) => {
    const { readUrl, write } = await setup();
    const before = await read(readUrl);
    const res = await write(undefined);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(await read(readUrl)).toEqual(before);
  });

  it('Delete draft', async () => {
    const { invoiceId } = await mintDraft();
    const before = await read(`/api/invoices/${invoiceId}`);
    const res = await deleteDraft(invoiceId);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(await read(`/api/invoices/${invoiceId}`)).toEqual(before);
  });

  it('Issue invoice', async () => {
    const { invoiceId } = await mintDraft();
    const before = await read(`/api/invoices/${invoiceId}`);
    const res = await authPost(ownerToken, `/api/invoices/${invoiceId}/issue`, {});
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(await read(`/api/invoices/${invoiceId}`)).toEqual(before);
  });
});

// ---------------------------------------------------------------------
// AC-378
// ---------------------------------------------------------------------

describe('AC-378: every committed write changes the version', () => {
  it('issuing a draft', async () => {
    const { invoiceId } = await mintDraft();
    const before = await versionOf(`/api/invoices/${invoiceId}`);
    const res = await authPost(ownerToken, `/api/invoices/${invoiceId}/issue`, {
      expectedVersion: before,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await versionOf(`/api/invoices/${invoiceId}`)).not.toBe(before);
  });

  it('cancelling an issued invoice leaves its version unchanged', async () => {
    const { invoiceId } = await mintDraft();
    const issued = await authPost(ownerToken, `/api/invoices/${invoiceId}/issue`, {
      expectedVersion: await versionOf(`/api/invoices/${invoiceId}`),
    });
    expect(issued.statusCode, issued.body).toBe(200);
    const before = await versionOf(`/api/invoices/${invoiceId}`);
    const cancel = await authPost(ownerToken, `/api/invoices/${invoiceId}/cancel`, {
      reason: 'Falscher Empfänger',
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(await versionOf(`/api/invoices/${invoiceId}`)).toBe(before);
  });
});

// ---------------------------------------------------------------------
// AC-381
// ---------------------------------------------------------------------

/**
 * Hold `FOR UPDATE` on the row from a third connection, then queue
 * `first` and `second` behind it in that order — Postgres grants a row
 * lock to its waiters first come, first served. Both have done their
 * non-locking reads against the same version before either can commit:
 * the overlap a read-compare-then-write implementation loses. Waiters are
 * counted from a separate autocommit connection, so each poll sees fresh
 * activity rather than the holder transaction's snapshot.
 */
async function raceInOrder(
  row: { table: string; id: string },
  first: () => Promise<Res>,
  second: () => Promise<Res>,
): Promise<[Res, Res]> {
  const { pool } = createDatabase();
  const holder = await pool.connect();
  const waiters = async (n: number): Promise<void> => {
    const deadline = Date.now() + 3_000;
    let seen = 0;
    while (Date.now() < deadline) {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM pg_stat_activity
          WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
      );
      seen = (rows[0] as { c: number }).c;
      if (seen >= n) return;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    expect(seen, `expected ${n} writes queued on the ${row.table} row lock`).toBeGreaterThanOrEqual(
      n,
    );
  };
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT 1 FROM ${row.table} WHERE id = $1 FOR UPDATE`, [row.id]);
    const a = first();
    await waiters(1);
    const b = second();
    await waiters(2);
    await holder.query('COMMIT');
    return [await a, await b];
  } finally {
    holder.release();
    await pool.end();
  }
}

describe('AC-381: concurrent writes with the same version commit exactly once', () => {
  it.each(VERSIONED)('$name ∥ $name', async ({ setup }) => {
    const { readUrl, row, write } = await setup();
    const v = await versionOf(readUrl);
    const [a, b] = await raceInOrder(
      row,
      () => write(v),
      () => write(v),
    );
    expect(a.statusCode, a.body).toBe(200);
    expectVersionConflict(b);
    expect((await read(readUrl)).version).toBe(a.json().version);
  });

  it('Update draft ∥ Delete draft', async () => {
    const { invoiceId } = await mintDraft();
    const url = `/api/invoices/${invoiceId}`;
    const v = await versionOf(url);
    const [patch, del] = await raceInOrder(
      { table: 'invoices', id: invoiceId },
      () =>
        authPatch(ownerToken, url, {
          lines: [{ ...LINE, description: 'Behalten' }],
          expectedVersion: v,
        }),
      () => deleteDraft(invoiceId, v),
    );
    expect(patch.statusCode, patch.body).toBe(200);
    expectVersionConflict(del);
    expect((await read(url)).version).toBe(patch.json().version);
  });

  it('Update draft first, Issue invoice second — the issue is rejected', async () => {
    const { invoiceId } = await mintDraft();
    const url = `/api/invoices/${invoiceId}`;
    const v = await versionOf(url);
    const [patch, issue] = await raceInOrder(
      { table: 'invoices', id: invoiceId },
      () =>
        authPatch(ownerToken, url, {
          lines: [{ ...LINE, description: 'Ungeprüft' }],
          expectedVersion: v,
        }),
      () => authPost(ownerToken, `${url}/issue`, { expectedVersion: v }),
    );
    expect(patch.statusCode, patch.body).toBe(200);
    expectVersionConflict(issue);
    const after = await read(url);
    expect(after.status).toBe('draft');
    expect(after.number ?? null).toBeNull();
  });

  it('Issue invoice first, Update draft second — the frozen row rejects the edit', async () => {
    const { invoiceId } = await mintDraft();
    const url = `/api/invoices/${invoiceId}`;
    const v = await versionOf(url);
    const [issue, patch] = await raceInOrder(
      { table: 'invoices', id: invoiceId },
      () => authPost(ownerToken, `${url}/issue`, { expectedVersion: v }),
      () =>
        authPatch(ownerToken, url, {
          lines: [{ ...LINE, description: 'Ungeprüft' }],
          expectedVersion: v,
        }),
    );
    expect(issue.statusCode, issue.body).toBe(200);
    // The state check precedes the version check (data-model.md §6.4).
    expect(patch.statusCode, patch.body).toBe(422);
    expect(patch.json().code).toBe('INVOICE_FROZEN');
    const after = await read(url);
    expect(after.status).toBe('issued');
    expect((after.lines as { description: string }[]).map((l) => l.description)).toEqual([
      LINE.description,
    ]);
  });
});
