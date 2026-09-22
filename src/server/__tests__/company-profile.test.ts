/**
 * API integration tests — company profile singleton (issue #109,
 * ADR-0026, api.md §14.2.15, data-model.md §5.17).
 *
 * Pins the singleton-row CRUD contract:
 *
 *   GET /api/company-profile — every authenticated role.
 *   PUT /api/company-profile — owner only; PUT semantics.
 *
 * Plus the persistence-layer singleton invariant (CHECK on a constant
 * primary key), the audit row shape, the required-when-mode validation,
 * the snapshot-then-mutate roundtrip, and the issue-time
 * COMPANY_PROFILE_REQUIRED rejection with sequence-lock release.
 *
 * AC coverage in this file:
 *   - AT-121 / AC-300, AC-301: role matrix + singleton CHECK (DB-level
 *     INSERT-second-row and DELETE-singleton rejections).
 *   - AT-122 / AC-302: audit row shape on PUT — entityType,
 *     action, ancestor pair null, payload.before / payload.after.
 *   - AT-123 / AC-303: required-when-mode validation, details lists
 *     offending field paths, no partial mutation.
 *   - AT-124 / AC-304: snapshot-then-mutate roundtrip — Invoice.issuer
 *     reflects the snapshot-time values after a subsequent profile
 *     mutation.
 *   - AT-125 / AC-305: issue rejected when profile incomplete; sequence
 *     lock released; subsequent successful issue claims the value.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { seed } from '../seed.js';
import path from 'path';
import { fileURLToPath } from 'url';
import type pg from 'pg';
import {
  startApp,
  stopApp,
  login,
  authGet,
  authPost,
  authPut,
  authDelete,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import type { Database } from '../db/connection.js';
import {
  CompanyProfileService,
  type CompanyProfileUpsertInput,
} from '../services/CompanyProfileService.js';
import type { AuthUser } from '../middleware/auth.js';
import type { ServiceLogger } from '../services/Logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

const year = new Date().getFullYear();

interface Project {
  id: string;
  status: string;
}

const completeProfileBody = {
  companyName: 'Maler Berger GmbH',
  address: { street: 'Werkstr. 1', zip: '10115', city: 'Berlin' },
  taxId: '111/222/33333',
  ustId: 'DE123456789',
  iban: 'DE89370400440532013000',
  accentColor: '#f60',
  footerText: 'Vielen Dank für Ihren Auftrag.',
  defaultTaxMode: 'standard' as const,
};

async function rechnungFaelligProjectId(
  ownerToken: string,
  skipIds: Set<string> = new Set(),
): Promise<string> {
  const res = await authGet(ownerToken, '/api/projects?status=rechnung_faellig&limit=200');
  const rows = (res.json().data as Project[]).filter((p) => !skipIds.has(p.id));
  if (rows.length === 0) throw new Error('seed missing project in rechnung_faellig');
  return rows[0]!.id;
}

async function readInvoiceSequenceNextValue(): Promise<number | null> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(
      sql`SELECT next_value FROM invoice_sequence WHERE year = ${year} AND kind = 'invoice'`,
    );
    if (res.rows.length === 0) return null;
    return Number((res.rows[0] as { next_value: string | number }).next_value);
  } finally {
    await pool.end();
  }
}

async function createDraft(ownerToken: string, projectId: string): Promise<string> {
  const res = await authPost(ownerToken, '/api/invoices', {
    projectId,
    lines: [
      {
        description: 'Anstrich',
        quantity: 1,
        unit: 'p',
        unitPrice: 1000,
        lineTotal: 1000,
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

// ---------------------------------------------------------------------
// AT-121 / AC-300, AC-301 — Role matrix + DB singleton CHECKs.
// ---------------------------------------------------------------------

describe('AT-121 / AC-300, AC-301: company-profile role matrix + singleton invariant', () => {
  let ownerToken: string;
  let officeToken: string;
  let workerToken: string;
  let bookkeeperToken: string;

  beforeAll(async () => {
    await startApp();
    [ownerToken, officeToken, workerToken, bookkeeperToken] = await Promise.all([
      login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.bookkeeper.username, SEED_DEFAULT_PASSWORD),
    ]);
  });

  afterAll(async () => {
    await stopApp();
  });

  it.each([
    ['owner', () => ownerToken],
    ['office', () => officeToken],
    ['worker', () => workerToken],
    ['bookkeeper', () => bookkeeperToken],
  ] as const)('%s GET /api/company-profile → 200', async (_label, getToken) => {
    const res = await authGet(getToken(), '/api/company-profile');
    expect(res.statusCode).toBe(200);
    // Body shape — the row exists in the singleton table per spec
    // (pre-seeded with empty mandatory fields by the baseline migration).
    const body = res.json();
    expect(body).toBeDefined();
    expect(typeof body.companyName).toBe('string');
    expect(body.address).toBeDefined();
  });

  it('owner PUT /api/company-profile → 200 (or 204)', async () => {
    const res = await authPut(ownerToken, '/api/company-profile', completeProfileBody);
    expect([200, 204]).toContain(res.statusCode);
  });

  it.each([
    ['office', () => officeToken],
    ['worker', () => workerToken],
    ['bookkeeper', () => bookkeeperToken],
  ] as const)('%s PUT /api/company-profile → 403 NOT_PERMITTED', async (_label, getToken) => {
    const res = await authPut(getToken(), '/api/company-profile', completeProfileBody);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('NOT_PERMITTED');
  });

  it('unauthenticated GET → 401', async () => {
    const res = await authGet('', '/api/company-profile');
    expect(res.statusCode).toBe(401);
  });

  it('unauthenticated PUT → 401', async () => {
    const res = await authPut('', '/api/company-profile', completeProfileBody);
    expect(res.statusCode).toBe(401);
  });

  it('POST is not addressable (no create surface — spec §14.2.15) → 404', async () => {
    const res = await authPost(ownerToken, '/api/company-profile', completeProfileBody);
    expect(res.statusCode).toBe(404);
  });

  it('DELETE is not addressable (the singleton row cannot be deleted) → 404', async () => {
    const res = await authDelete(ownerToken, '/api/company-profile');
    expect(res.statusCode).toBe(404);
  });

  // -----------------------------------------------------------------
  // AC-300 — DB-level singleton CHECKs.
  //
  // (a) Direct INSERT of a second row is rejected by the CHECK on the
  //     constant primary key.
  // (b) Direct DELETE of the singleton row is rejected.
  // -----------------------------------------------------------------
  describe('AC-300: DB-level singleton invariant', () => {
    let pool: pg.Pool;
    let db: Database;

    beforeAll(async () => {
      const conn = createDatabase();
      db = conn.db;
      pool = conn.pool;
      await pool.query('SELECT 1');
      await migrate(db, { migrationsFolder });
      await seed(db, { force: true });
    });

    afterAll(async () => {
      await pool.end();
    });

    it('rejects a direct INSERT of a second company_profile row', async () => {
      // The singleton enforcement mechanism is impl-defined per
      // data-model.md §5.17 ("parity with meta_backup_status.singleton")
      // — a CHECK on a constant primary key, a UNIQUE constraint on a
      // discriminator, or equivalent. The test is impl-agnostic:
      // insert against the documented columns only; whichever
      // mechanism the impl chooses, the second row must not land.
      let pgError: { code?: string; constraint?: string } | null = null;
      try {
        await pool.query(
          `INSERT INTO company_profile (company_name, default_tax_mode, address, tax_id)
           VALUES ('should not land', 'standard',
                   '{"street":"X","zip":"99999","city":"X"}'::jsonb, 'X')`,
        );
      } catch (err) {
        pgError = err as { code?: string; constraint?: string };
      }
      expect(pgError).not.toBeNull();
    });

    it('rejects a direct DELETE of the singleton company_profile row', async () => {
      let pgError: { code?: string; constraint?: string } | null = null;
      try {
        await pool.query(`DELETE FROM company_profile`);
      } catch (err) {
        pgError = err as { code?: string; constraint?: string };
      }
      expect(pgError).not.toBeNull();
    });
  });
});

// ---------------------------------------------------------------------
// AT-122 / AC-302 — Audit row shape on PUT.
// ---------------------------------------------------------------------

describe('AT-122 / AC-302: PUT /api/company-profile writes one audit row with payload before/after', () => {
  let ownerToken: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    await stopApp();
  });

  it('writes exactly one audit row with entityType=company_profile, action=update, ancestor null, before/after populated', async () => {
    // Snapshot the row pre-mutation, drive a PUT with distinct values,
    // re-read the audit row, assert shape.
    const beforeRes = await authGet(ownerToken, '/api/company-profile');
    expect(beforeRes.statusCode).toBe(200);
    const before = beforeRes.json();

    const after = {
      ...completeProfileBody,
      footerText: `Audit-test footer ${crypto.randomUUID().slice(0, 8)}`,
    };

    const { db, pool } = createDatabase();
    let auditCountBefore: number;
    try {
      const res = await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM audit_log WHERE entity_type = 'company_profile'`,
      );
      auditCountBefore = (res.rows[0] as { c: number }).c;
    } finally {
      await pool.end();
    }

    const put = await authPut(ownerToken, '/api/company-profile', after);
    expect([200, 204]).toContain(put.statusCode);

    const { db: db2, pool: pool2 } = createDatabase();
    try {
      const res = await db2.execute(sql`
        SELECT entity_type, action, actor_kind, actor_id,
               ancestor_entity_type, ancestor_entity_id, payload
        FROM audit_log
        WHERE entity_type = 'company_profile'
        ORDER BY created_at DESC LIMIT 1
      `);
      const auditCountRes = await db2.execute(
        sql`SELECT COUNT(*)::int AS c FROM audit_log WHERE entity_type = 'company_profile'`,
      );
      const auditCountAfter = (auditCountRes.rows[0] as { c: number }).c;

      // Exactly one new audit row.
      expect(auditCountAfter - auditCountBefore).toBe(1);

      const row = res.rows[0] as Record<string, unknown>;
      expect(row.entity_type).toBe('company_profile');
      expect(row.action).toBe('update');
      expect(row.actor_kind).toBe('user');
      expect(row.actor_id).not.toBeNull();
      // Ancestor pair null — top-level entity, parity with customer / user.
      expect(row.ancestor_entity_type).toBeNull();
      expect(row.ancestor_entity_id).toBeNull();

      const payload = row.payload as {
        before: Record<string, unknown>;
        after: Record<string, unknown>;
      };
      expect(payload.before).toBeDefined();
      expect(payload.after).toBeDefined();
      // Per AC-302: payload.after matches the post-write state and
      // payload.before matches the pre-write state. Pin every
      // snapshotted column the spec lists in §5.17 — companyName,
      // address, taxId, footerText — not just the one that changed.
      expect(payload.after.companyName).toBe(after.companyName);
      expect(payload.after.address).toEqual(after.address);
      expect(payload.after.taxId).toBe(after.taxId);
      expect(payload.after.footerText).toBe(after.footerText);
      expect(payload.before.companyName).toBe(before.companyName);
      expect(payload.before.address).toEqual(before.address);
      expect(payload.before.taxId).toBe(before.taxId);
      expect(payload.before.footerText).toBe(before.footerText);
    } finally {
      await pool2.end();
    }
  });
});

// ---------------------------------------------------------------------
// AT-123 / AC-303 — Required-when-mode validation.
// ---------------------------------------------------------------------

describe('AT-123 / AC-303: PUT validates required-when-mode invariants', () => {
  let ownerToken: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    await stopApp();
  });

  it('defaultTaxMode=standard with empty ustId → 422 VALIDATION_ERROR; details names the path', async () => {
    const res = await authPut(ownerToken, '/api/company-profile', {
      ...completeProfileBody,
      ustId: '',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    const details = res.json().details;
    expect(details).toBeDefined();
    const fieldPaths = JSON.stringify(details);
    expect(fieldPaths).toContain('ustId');
  });

  it('defaultTaxMode=reverse_charge with empty ustId → 422 VALIDATION_ERROR', async () => {
    const res = await authPut(ownerToken, '/api/company-profile', {
      ...completeProfileBody,
      defaultTaxMode: 'reverse_charge',
      ustId: '',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it.each([
    ['companyName empty', { companyName: '' }],
    ['address.street empty', { address: { street: '', zip: '10115', city: 'Berlin' } }],
    ['address.zip empty', { address: { street: 'Werkstr. 1', zip: '', city: 'Berlin' } }],
    ['address.city empty', { address: { street: 'Werkstr. 1', zip: '10115', city: '' } }],
    ['taxId empty', { taxId: '' }],
  ])('%s → 422 VALIDATION_ERROR (any mode)', async (_label, override) => {
    const res = await authPut(ownerToken, '/api/company-profile', {
      ...completeProfileBody,
      ...override,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('a rejected PUT does not persist any partial mutation', async () => {
    // Capture state, drive a rejected PUT, re-read, assert unchanged.
    const before = (await authGet(ownerToken, '/api/company-profile')).json();
    await authPut(ownerToken, '/api/company-profile', {
      ...completeProfileBody,
      companyName: '',
      footerText: 'SHOULD NOT LAND',
    });
    const after = (await authGet(ownerToken, '/api/company-profile')).json();
    // Footer is the canary — a regression that partially-wrote would
    // have flipped this even though companyName validation rejected.
    expect(after.footerText).toBe(before.footerText);
    expect(after.companyName).toBe(before.companyName);
  });
});

// ---------------------------------------------------------------------
// AT-124 / AC-304 — Snapshot-then-mutate roundtrip.
// ---------------------------------------------------------------------

describe('AT-124 / AC-304: Invoice.issuer is frozen at issuance — profile mutation does not retroactively change it', () => {
  let ownerToken: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    // Seed a complete profile so the issue path runs.
    await authPut(ownerToken, '/api/company-profile', completeProfileBody);
  });

  afterAll(async () => {
    await stopApp();
  });

  it('issuing then mutating the profile leaves the issued row pointing at the snapshot values', async () => {
    const projectId = await rechnungFaelligProjectId(ownerToken);
    const draftId = await createDraft(ownerToken, projectId);

    const issueRes = await authPost(ownerToken, `/api/invoices/${draftId}/issue`);
    expect(issueRes.statusCode).toBe(200);
    const invoiceId = issueRes.json().id as string;
    const snapshotIssuerStreet = issueRes.json().issuer.address.street as string;
    const snapshotDescriptor = issueRes.json().renderedPdfBinaryDescriptorId as string;
    expect(snapshotIssuerStreet).toBe(completeProfileBody.address.street);

    // Mutate the profile — change `address.street`.
    const mutated = await authPut(ownerToken, '/api/company-profile', {
      ...completeProfileBody,
      address: { ...completeProfileBody.address, street: 'Neue Werkstr. 99' },
    });
    expect([200, 204]).toContain(mutated.statusCode);

    // Re-fetch the issued invoice — snapshot must hold.
    const reread = await authGet(ownerToken, `/api/invoices/${invoiceId}`);
    expect(reread.statusCode).toBe(200);
    const body = reread.json();
    expect(body.issuer.address.street).toBe(snapshotIssuerStreet);
    expect(body.issuer.address.street).not.toBe('Neue Werkstr. 99');

    // Rendered binary descriptor unchanged — the spec doesn't expose
    // a re-render path, so the row keeps pointing at the bytes produced
    // at issuance.
    expect(body.renderedPdfBinaryDescriptorId).toBe(snapshotDescriptor);
  });
});

// ---------------------------------------------------------------------
// AT-125 / AC-305 — Issue rejection with sequence-lock release.
// ---------------------------------------------------------------------

describe('AT-125 / AC-305: failed issue does not permanently advance the sequence', () => {
  // AC-305 normative language pins "the lock is acquired and released"
  // — that detail is implementation-internal and observably
  // indistinguishable from "validation runs before allocation" under
  // unit-integration testing. The wire-observable contract is the
  // single invariant: the sequence value the failed call would have
  // claimed remains available for the next successful issue. The
  // spec language is normative for the impl team but unverifiable
  // from outside; this test pins the observable.
  let ownerToken: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    // Start with a complete profile so other arms keep working; this
    // arm wipes it then restores.
    await authPut(ownerToken, '/api/company-profile', completeProfileBody);
  });

  afterAll(async () => {
    await stopApp();
  });

  it('issue against incomplete profile → 422 COMPANY_PROFILE_REQUIRED; next issue claims the value the failed call would have claimed; no audit row for failed issue', async () => {
    // Snapshot the sequence value.
    const before = await readInvoiceSequenceNextValue();
    const expected = before ?? 1;

    // Wipe required profile fields via direct SQL (the API PUT
    // validates and would reject the empty body).
    const { db, pool } = createDatabase();
    try {
      await db.execute(sql`
        UPDATE company_profile SET company_name = '', tax_id = '', ust_id = NULL
      `);
    } finally {
      await pool.end();
    }

    // Allocate a draft on a rechnung_faellig project.
    const projectId = await rechnungFaelligProjectId(ownerToken);
    const draftId = await createDraft(ownerToken, projectId);

    // Count audit rows on the failed invoice.
    const { db: db1, pool: pool1 } = createDatabase();
    let auditBefore: number;
    try {
      const r = await db1.execute(
        sql`SELECT COUNT(*)::int AS c FROM audit_log WHERE entity_id = ${draftId}`,
      );
      auditBefore = (r.rows[0] as { c: number }).c;
    } finally {
      await pool1.end();
    }

    const failed = await authPost(ownerToken, `/api/invoices/${draftId}/issue`);
    expect(failed.statusCode).toBe(422);
    expect(failed.json().code).toBe('COMPANY_PROFILE_REQUIRED');
    const details = failed.json().details as { missingFields?: string[] };
    expect(Array.isArray(details.missingFields)).toBe(true);
    expect(details.missingFields!.length).toBeGreaterThan(0);

    // No audit row on the failed issue per AC-305 trailing clause.
    const { db: db2, pool: pool2 } = createDatabase();
    try {
      const r = await db2.execute(
        sql`SELECT COUNT(*)::int AS c FROM audit_log WHERE entity_id = ${draftId}`,
      );
      const auditAfter = (r.rows[0] as { c: number }).c;
      expect(auditAfter).toBe(auditBefore);
    } finally {
      await pool2.end();
    }

    // Restore the profile, then issue successfully on a different
    // draft — the sequence claim must equal `expected` (the value
    // the failed issue rolled back).
    await authPut(ownerToken, '/api/company-profile', completeProfileBody);
    const projectId2 = await rechnungFaelligProjectId(ownerToken, new Set([projectId]));
    const draftOk = await createDraft(ownerToken, projectId2);
    const ok = await authPost(ownerToken, `/api/invoices/${draftOk}/issue`);
    expect(ok.statusCode).toBe(200);
    const okNumber = ok.json().number as string;
    const okValue = Number(okNumber.split('-').pop());
    expect(okValue).toBe(expected);
  });
});

// ---------------------------------------------------------------------
// M3 — Defense-in-depth role check on `CompanyProfileService.upsert`.
//
// The service's docstring (CompanyProfileService.ts:8-9) promises:
//
//   "owner only; enforced at the route layer, re-checked defensively at
//    the service layer"
//
// As of this test's authorship the service does NOT re-check — it
// accepts any caller who supplies a userId, trusting the route layer
// to gate the call. That trust violates the defense-in-depth promise
// in the docstring (and ADR-0026's owner-only invariant for the
// `company_profile` singleton): a future caller that constructs the
// service directly (a background job, a test fixture, a script using
// the repository) can write the singleton on behalf of any role.
//
// Wave 3 closes the gap by changing the signature from
//   `upsert(input, userId: string, log, correlationId)`
// to
//   `upsert(caller: AuthUser, input, log, correlationId)`
// and rejecting non-`owner` callers with `notPermitted()` (the same
// error the route emits, code = `NOT_PERMITTED`). Mirrors the
// `InvoiceService.get(caller, id)` / `.list(caller, opts)` shape — the
// service-layer call site receives the authenticated principal, not a
// flat userId.
//
// Why this is appended here, not a sibling file: AT-121 / AC-301 in
// this file already pins the route-layer permission matrix; this block
// pins the service-layer backstop for the same invariant. Keeping
// both pins in one file makes the "two layers, one rule" easy to read.
//
// AC pin: AC-297 (auth + permission gates on the company-profile
// surface) — the surface here is the service entry point rather than
// the route, but the load-bearing invariant is the same: a non-owner
// principal cannot drive a successful upsert.
// ---------------------------------------------------------------------

describe('M3 / AC-297: CompanyProfileService.upsert defense-in-depth role check', () => {
  // Post-fix expected shape: `upsert(caller: AuthUser, input, log, correlationId)`.
  // The test casts to `UpsertWithCaller` to invoke the post-fix shape;
  // load-bearing assertions are in the test invocations themselves.
  // Body type is imported as `CompanyProfileUpsertInput` rather than
  // derived from `Parameters<...>` so the cast survives the M3 signature
  // change (where the body's parameter index shifted from [0] to [1]).
  interface UpsertWithCaller {
    upsert(
      caller: AuthUser,
      input: CompanyProfileUpsertInput,
      log: ServiceLogger,
      correlationId?: string | null,
    ): Promise<unknown>;
  }

  const noopLog: ServiceLogger = {
    info: () => undefined,
    error: () => undefined,
  };

  /**
   * Build an `AuthUser` shape for a given role. The middleware attaches
   * exactly this object to `request.user` (see middleware/auth.ts:17-25)
   * — the service-layer fix consumes the same shape so the route and
   * direct callers share one principal type.
   */
  function authUser(role: 'owner' | 'office' | 'worker' | 'bookkeeper'): AuthUser {
    return {
      id: crypto.randomUUID(),
      username: `m3-${role}`,
      displayName: `M3 ${role}`,
      roles: [role],
      email: null,
      themePreference: 'system',
      pushMuted: false,
    };
  }

  let ownerToken: string;
  let ownerId: string;
  let db: Database;
  let pool: import('pg').Pool;
  let service: CompanyProfileService;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    // Seed a complete profile via the route so subsequent direct calls
    // don't trip the required-when-mode validation. The owner-arm
    // success assertion below also exercises the validation path.
    const seedPut = await authPut(ownerToken, '/api/company-profile', completeProfileBody);
    expect([200, 204]).toContain(seedPut.statusCode);

    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    const userRows = await db.execute(
      sql`SELECT id FROM users WHERE username = ${SEED_USERS.owner.username} LIMIT 1`,
    );
    if (userRows.rows.length === 0) throw new Error('seed missing owner user');
    ownerId = (userRows.rows[0] as { id: string }).id;

    service = new CompanyProfileService(db);
  });

  afterAll(async () => {
    if (pool) await pool.end();
    await stopApp();
  });

  it.each([['office'] as const, ['worker'] as const, ['bookkeeper'] as const])(
    'non-owner caller (%s) is rejected by the service with NOT_PERMITTED — defense-in-depth, no route gate involved',
    async ([role]) => {
      // Snapshot pre-call state — a rejected upsert must leave the row
      // untouched. The footerText is the canary: changing it would
      // surface as a partial-write if the service-layer check ran AFTER
      // the UPDATE (it must run before).
      const beforeRow = await db.execute(sql`SELECT footer_text FROM company_profile LIMIT 1`);
      const beforeFooter = (beforeRow.rows[0] as { footer_text: string | null }).footer_text;

      const caller = authUser(role as 'office' | 'worker' | 'bookkeeper');
      // Cast to the post-fix shape — `as unknown as UpsertWithCaller`
      // documents that the call site assumes the Wave 3 signature.
      const withCaller = service as unknown as UpsertWithCaller;

      await expect(
        withCaller.upsert(
          caller,
          {
            ...completeProfileBody,
            footerText: `SHOULD-NOT-LAND-${role}`,
          },
          noopLog,
          null,
        ),
      ).rejects.toMatchObject({ code: 'NOT_PERMITTED' });

      // No partial mutation — the canary field is unchanged.
      const afterRow = await db.execute(sql`SELECT footer_text FROM company_profile LIMIT 1`);
      expect((afterRow.rows[0] as { footer_text: string | null }).footer_text).toBe(beforeFooter);

      // No audit row for the rejected call. Filter to the
      // company_profile entity — sibling tests in this file write their
      // own rows so we cannot anchor on the global count alone.
      const auditRow = await db.execute(sql`
        SELECT created_at, payload
        FROM audit_log
        WHERE entity_type = 'company_profile'
        ORDER BY created_at DESC LIMIT 1
      `);
      // Either there are no audit rows at all (clean slate) or the
      // most recent one is older than this test arm's start. The
      // load-bearing check is "no NEW row from this call" — the
      // payload's after.footerText must not carry the sentinel.
      if (auditRow.rows.length > 0) {
        const payload = (auditRow.rows[0] as { payload: { after?: { footerText?: string } } })
          .payload;
        expect(payload.after?.footerText).not.toBe(`SHOULD-NOT-LAND-${role}`);
      }
    },
  );

  it('owner caller succeeds — regression anchor for the happy path; the role check does not break authorised use', async () => {
    // The non-owner arms above prove the gate fires for office /
    // worker / bookkeeper. This arm proves the gate does NOT
    // mis-classify the legitimate owner caller: a regression that
    // collapsed the role check (e.g. inverted the predicate, gated on
    // a removed permission key) would surface here as a false reject.
    const caller: AuthUser = {
      ...authUser('owner'),
      id: ownerId, // use the real seed user so the FK on actor_id holds.
    };
    const withCaller = service as unknown as UpsertWithCaller;

    const distinctFooter = `Owner-happy-path ${crypto.randomUUID().slice(0, 8)}`;
    await expect(
      withCaller.upsert(
        caller,
        {
          ...completeProfileBody,
          footerText: distinctFooter,
        },
        noopLog,
        null,
      ),
    ).resolves.toBeDefined();

    // Post-write state carries the new footer — the call actually
    // landed, not just resolved.
    const row = await db.execute(sql`SELECT footer_text FROM company_profile LIMIT 1`);
    expect((row.rows[0] as { footer_text: string | null }).footer_text).toBe(distinctFooter);
  });
});
