/**
 * API integration test — auth + permission matrix for the eight
 * invoice endpoints (AC-297 / AT-119 coverage backfill).
 *
 * Closes the `**GAP**` row in `docs/testing/traceability.md:298`.
 *
 * AC-297 (verification.md:409) names exactly eight endpoints:
 *
 *   GET    /api/invoices                — list
 *   GET    /api/invoices/:id            — get
 *   POST   /api/invoices                — create draft
 *   PATCH  /api/invoices/:id            — update draft
 *   DELETE /api/invoices/:id            — delete draft
 *   POST   /api/invoices/:id/issue      — issue
 *   POST   /api/invoices/:id/cancel     — cancel
 *   GET    /api/invoices/:id/pdf        — download
 *
 * Matrix:
 *   - Unauthenticated → 401 UNAUTHENTICATED | SESSION_EXPIRED.
 *   - Worker          → 403 NOT_PERMITTED on every endpoint EXCEPT the
 *                       two repository-predicate-scoped reads (list,
 *                       get): per AC-298 / ADR-0019 worker callers see
 *                       the empty set on list and a three-way result
 *                       on get (404 for unknown id, 403 for in-scope-
 *                       hidden id). This file does not duplicate
 *                       AC-298's nuance — it asserts only the surfaces
 *                       AC-297 owns:
 *                         * write/issue/cancel endpoints → 403 always,
 *                         * read endpoints on an OWNED draft id → 403
 *                           (NOT 200), satisfying "worker → 403 on all
 *                           eight" interpreted as "worker cannot reach
 *                           a successful 200 on any endpoint".
 *   - Bookkeeper      → read endpoints succeed (200) / write/issue/
 *                       cancel → 403.
 *   - Office          → all eight succeed (200/201/204) on a real
 *                       target; or 404 NOT_FOUND for known-missing ids.
 *   - Owner           → same as office (regression anchor).
 *
 * Why a dedicated file: AC-297 is the auth-matrix anchor; consolidating
 * it here keeps `invoices-routes.test.ts` focused on the wire/contract
 * surfaces (defaults, freeze rules, scope) and gives the traceability
 * row a single home to reference.
 *
 * The five existing invoice route tests cover individual cells of this
 * matrix incidentally; this file is the systematic walk.
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

interface Project {
  id: string;
  status: string;
  customerId: string;
}

/**
 * The eight endpoints AC-297 names. `needsId` marks the ones bound to
 * a specific row — used by the test loops to substitute the seeded
 * draft / issued ids per arm.
 */
const ENDPOINTS = [
  { method: 'GET', path: '/api/invoices', needsId: false, kind: 'read' as const },
  { method: 'GET', path: '/api/invoices/:id', needsId: true, kind: 'read' as const },
  { method: 'POST', path: '/api/invoices', needsId: false, kind: 'write' as const },
  { method: 'PATCH', path: '/api/invoices/:id', needsId: true, kind: 'write' as const },
  { method: 'DELETE', path: '/api/invoices/:id', needsId: true, kind: 'write' as const },
  { method: 'POST', path: '/api/invoices/:id/issue', needsId: true, kind: 'write' as const },
  { method: 'POST', path: '/api/invoices/:id/cancel', needsId: true, kind: 'write' as const },
  { method: 'GET', path: '/api/invoices/:id/pdf', needsId: true, kind: 'read' as const },
] as const;

type Endpoint = (typeof ENDPOINTS)[number];

/** Resolve the seeded `rechnung_faellig` project so issue arms have a valid target. */
async function rechnungFaelligProjectId(
  ownerToken: string,
  skipIds: Set<string> = new Set(),
): Promise<string> {
  const res = await authGet(ownerToken, '/api/projects?status=rechnung_faellig&limit=200');
  const rows = (res.json().data as Project[]).filter((p) => !skipIds.has(p.id));
  if (rows.length === 0) throw new Error('seed missing project in rechnung_faellig');
  return rows[0]!.id;
}

/** Drive a draft into the DB so per-id endpoints have a valid draft target. */
async function seedDraftInvoice(projectId: string): Promise<string> {
  const { db, pool } = createDatabase();
  try {
    const id = crypto.randomUUID();
    const issuer = { companyName: '', address: { street: '', zip: '', city: '' }, taxId: '' };
    const recipient = {
      name: 'Auth-matrix Recipient',
      address: { street: 'Strasse 1', zip: '12345', city: 'Berlin' },
    };
    const lines = [
      {
        description: 'Auth-matrix line',
        quantity: 1,
        unit: 'pauschal',
        unitPrice: 100,
        lineTotal: 100,
        taxRate: 19,
      },
    ];
    const totals = { perRate: [], netGrandTotal: 100, taxGrandTotal: 0, grossGrandTotal: 100 };
    await db.execute(sql`
      INSERT INTO invoices
        (id, project_id, status, tax_mode, profile,
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

/** Drive an issued invoice via the production route — needed for PDF/cancel arms. */
async function issueViaApi(token: string, projectId: string): Promise<string> {
  const draft = await authPost(token, '/api/invoices', {
    projectId,
    lines: [
      {
        description: 'Auth-matrix issued',
        quantity: 1,
        unit: 'pauschal',
        unitPrice: 500,
        lineTotal: 500,
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

/** Fill the singleton so issue arms don't trip COMPANY_PROFILE_REQUIRED. */
async function ensureCompanyProfileComplete(ownerToken: string): Promise<void> {
  const res = await authPut(ownerToken, '/api/company-profile', {
    ...(await expectedVersion(ownerToken, '/api/company-profile')),
    companyName: 'Auth-matrix GmbH',
    address: { street: 'Werkstr. 1', zip: '10115', city: 'Berlin' },
    taxId: '111/222/33333',
    ustId: 'DE123456789',
    iban: 'DE89370400440532013000',
    accentColor: '#f60',
    footerText: 'Auth matrix.',
    defaultTaxMode: 'standard',
  });
  if (![200, 204].includes(res.statusCode)) {
    throw new Error(`ensureCompanyProfileComplete failed ${res.statusCode} ${res.body}`);
  }
}

/**
 * Dispatch by method against the test helpers. Returns the raw
 * inject() result so individual arms can assert status / code.
 */
/** The invoice's stored version; 1 for an id with no row. */
async function currentVersion(invoiceId: string): Promise<number> {
  const { db, pool } = createDatabase();
  try {
    const r = await db.execute(sql`SELECT version FROM invoices WHERE id = ${invoiceId}`);
    return (r.rows[0] as { version: number } | undefined)?.version ?? 1;
  } finally {
    await pool.end();
  }
}

async function call(
  ep: Endpoint,
  token: string,
  id: string | null,
  bodyOverride?: Record<string, unknown>,
): Promise<{ statusCode: number; json: () => { code?: string } & Record<string, unknown> }> {
  const { method, path } = ep;
  const url = ep.needsId ? path.replace(':id', id!) : path;
  // Versioned endpoints carry the row's current `expectedVersion`
  // (data-model.md §6.4) — schema validation runs before the auth
  // preHandler, so without it a 422 would mask the contract under test.
  const versioned =
    (method === 'PATCH' || method === 'DELETE' || path === '/api/invoices/:id/issue') && id
      ? { expectedVersion: await currentVersion(id) }
      : null;
  // POST /api/invoices (create) needs `{projectId}` to satisfy the
  // body schema (required field). PATCH defaults to `{}` so the
  // `type: 'object'` schema validates before the auth preHandler —
  // an undefined body can short-circuit to 400 ahead of 401, which
  // would mask the auth-matrix contract under test.
  const body =
    method === 'POST' && path === '/api/invoices'
      ? (bodyOverride ?? { projectId: id, lines: [] })
      : versioned && method !== 'DELETE'
        ? { ...versioned, ...bodyOverride }
        : bodyOverride;

  if (method === 'GET') return authGet(token, url);
  if (method === 'POST') return authPost(token, url, body);
  if (method === 'PATCH') return authPatch(token, url, body);
  if (method === 'DELETE') {
    return authDelete(token, `${url}?expectedVersion=${versioned!.expectedVersion}`);
  }
  throw new Error(`unsupported method ${method as string}`);
}

describe('AC-297 — invoice auth + permission matrix (per-role × per-endpoint walk)', () => {
  let ownerToken: string;
  let officeToken: string;
  let workerToken: string;
  let bookkeeperToken: string;

  // Per-role draft ids so DELETE/PATCH arms in the success path
  // don't fight over the same row across owner/office arms. Each
  // role that should succeed on write endpoints gets its own draft.
  let projectId: string;
  let draftIdForOwnerSuccess: string;
  let draftIdForOfficeSuccess: string;
  let draftIdForWorkerReject: string;
  let draftIdForBookkeeperReject: string;
  let issuedIdForCancelOwner: string;
  let issuedIdForCancelOffice: string;
  let issuedIdForReadOnly: string;
  // A separate project for each issue-arm: issuance flips the project
  // to `abgerechnet`, so consecutive successful issues need fresh
  // projects.
  let issueProjectIdOwner: string;
  let issueProjectIdOffice: string;

  beforeAll(async () => {
    await startApp();
    [ownerToken, officeToken, workerToken, bookkeeperToken] = await Promise.all([
      login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD),
      login(SEED_USERS.bookkeeper.username, SEED_DEFAULT_PASSWORD),
    ]);
    await ensureCompanyProfileComplete(ownerToken);

    // Three issuances flip three projects to abgerechnet (owner-cancel,
    // office-cancel, read-only-issued). The seed ships exactly three
    // rechnung_faellig projects, so consume all three for issuance
    // fixtures. The "any non-archived project" arms (drafts, perm
    // rejects, unauthenticated body shape) re-use the now-abgerechnet
    // projects — draft creation does NOT require rechnung_faellig
    // status (only issuance does).
    const usedProjects = new Set<string>();
    const cancelProjectOwner = await rechnungFaelligProjectId(ownerToken, usedProjects);
    usedProjects.add(cancelProjectOwner);
    issuedIdForCancelOwner = await issueViaApi(ownerToken, cancelProjectOwner);

    const cancelProjectOffice = await rechnungFaelligProjectId(ownerToken, usedProjects);
    usedProjects.add(cancelProjectOffice);
    issuedIdForCancelOffice = await issueViaApi(ownerToken, cancelProjectOffice);

    const readOnlyProject = await rechnungFaelligProjectId(ownerToken, usedProjects);
    usedProjects.add(readOnlyProject);
    issuedIdForReadOnly = await issueViaApi(ownerToken, readOnlyProject);

    // `projectId` is the host for drafts and for body-shape arms; it's
    // an abgerechnet project (we just issued an invoice on it above).
    // That's fine — draft creation accepts any non-archived project,
    // and the unauthenticated/permission arms only need `projectId` to
    // satisfy the POST /api/invoices body schema (the auth/perm gate
    // fires before status is checked).
    projectId = cancelProjectOwner;

    // Mint fresh rechnung_faellig projects for the issue-success arms.
    const lookup = createDatabase();
    let customerId: string;
    try {
      const r = await lookup.db.execute(sql`SELECT id FROM customers LIMIT 1`);
      if (r.rows.length === 0) throw new Error('seed missing any customer');
      customerId = (r.rows[0] as { id: string }).id;
    } finally {
      await lookup.pool.end();
    }
    async function mintRechnungFaelligProject(suffix: string): Promise<string> {
      const res = await authPost(ownerToken, '/api/projects', {
        number: `AUTH-${suffix}`,
        title: `Auth-matrix fixture ${suffix}`,
        customerId,
        status: 'rechnung_faellig',
      });
      if (res.statusCode !== 201) {
        throw new Error(`mintRechnungFaelligProject failed ${res.statusCode} ${res.body}`);
      }
      return res.json().id as string;
    }
    issueProjectIdOwner = await mintRechnungFaelligProject(
      `OWN-${crypto.randomUUID().slice(0, 6)}`,
    );
    issueProjectIdOffice = await mintRechnungFaelligProject(
      `OFF-${crypto.randomUUID().slice(0, 6)}`,
    );

    // Drafts — distinct per arm so PATCH/DELETE/issue can each claim
    // their own row without interfering. Each is seeded against
    // `projectId` (an in-arbeit-like rechnung_faellig project) — only
    // the issue-arm drafts need a project actually in rechnung_faellig
    // for issue to succeed; PATCH/DELETE/permission-reject arms don't
    // care.
    draftIdForOwnerSuccess = await seedDraftInvoice(projectId);
    draftIdForOfficeSuccess = await seedDraftInvoice(projectId);
    draftIdForWorkerReject = await seedDraftInvoice(projectId);
    draftIdForBookkeeperReject = await seedDraftInvoice(projectId);
  });

  afterAll(async () => {
    await stopApp();
  });

  // ---------------------------------------------------------------------
  // Unauthenticated arm — every endpoint, no session cookie → 401.
  // ---------------------------------------------------------------------

  describe('unauthenticated → 401 UNAUTHENTICATED | SESSION_EXPIRED', () => {
    it.each(ENDPOINTS)('$method $path', async (ep) => {
      // For per-id endpoints, use a random UUID — the auth gate fires
      // before the row lookup, so the id need not exist.
      const id = ep.needsId ? '00000000-0000-0000-0000-000000000000' : projectId;
      const res = await call(ep, '', id);
      expect(res.statusCode).toBe(401);
      const body = res.json();
      // Either code is spec-conformant per AC-297 wording ("401
      // UNAUTHENTICATED / SESSION_EXPIRED").
      expect(['UNAUTHENTICATED', 'SESSION_EXPIRED']).toContain(body.code);
    });
  });

  // ---------------------------------------------------------------------
  // Worker arm — no `invoice:read` or `invoice:write`. AC-297 says
  // "403 on all eight endpoints", reconciled with AC-298 nuance:
  //   - list: 200 + empty data (repository-predicate scope returns []);
  //   - get on owned id: 403 NOT_PERMITTED (in-scope-hidden);
  //   - get on unknown id: 404 NOT_FOUND.
  // AC-297's "403 on all eight" is interpreted as "worker cannot reach
  // a successful mutation / a 200-on-row response". Below we pin the
  // 403 / non-200 path for every endpoint, with list as the documented
  // exception (200 + empty).
  // ---------------------------------------------------------------------

  describe('worker — no invoice permission; AC-298 scope on reads, 403 on writes', () => {
    it('GET /api/invoices → 200 with empty data (worker scope predicate)', async () => {
      // Per AC-298 / routes/invoices.ts:81-91 the list endpoint does NOT
      // gate on `invoice:read` — the repo predicate produces the empty
      // set for worker. AC-297's "403 on all eight" is not literal on
      // the list endpoint; the auth-matrix interpretation is "worker
      // never sees invoice rows", which is what the empty list pins.
      const res = await call(ENDPOINTS[0], workerToken, null);
      expect(res.statusCode).toBe(200);
      expect(Array.isArray((res.json() as { data?: unknown[] }).data)).toBe(true);
      expect((res.json() as { data: unknown[] }).data.length).toBe(0);
    });

    it('GET /api/invoices/:id on an existing draft → 403 NOT_PERMITTED', async () => {
      const res = await call(ENDPOINTS[1], workerToken, draftIdForWorkerReject);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('POST /api/invoices → 403 NOT_PERMITTED', async () => {
      const res = await call(ENDPOINTS[2], workerToken, projectId);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('PATCH /api/invoices/:id → 403 NOT_PERMITTED', async () => {
      const res = await call(ENDPOINTS[3], workerToken, draftIdForWorkerReject, { lines: [] });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('DELETE /api/invoices/:id → 403 NOT_PERMITTED', async () => {
      const res = await call(ENDPOINTS[4], workerToken, draftIdForWorkerReject);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('POST /api/invoices/:id/issue → 403 NOT_PERMITTED', async () => {
      const res = await call(ENDPOINTS[5], workerToken, draftIdForWorkerReject);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('POST /api/invoices/:id/cancel → 403 NOT_PERMITTED', async () => {
      const res = await call(ENDPOINTS[6], workerToken, issuedIdForReadOnly, {});
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('GET /api/invoices/:id/pdf → 403 NOT_PERMITTED', async () => {
      const res = await call(ENDPOINTS[7], workerToken, issuedIdForReadOnly);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });
  });

  // ---------------------------------------------------------------------
  // Bookkeeper arm — `invoice:read` only.
  //   - Reads (list / get / pdf) succeed.
  //   - Writes / issue / cancel → 403 NOT_PERMITTED.
  // ---------------------------------------------------------------------

  describe('bookkeeper — invoice:read only', () => {
    it('GET /api/invoices → 200', async () => {
      const res = await call(ENDPOINTS[0], bookkeeperToken, null);
      expect(res.statusCode).toBe(200);
    });

    it('GET /api/invoices/:id on existing draft → 200', async () => {
      const res = await call(ENDPOINTS[1], bookkeeperToken, draftIdForBookkeeperReject);
      expect(res.statusCode).toBe(200);
    });

    it('POST /api/invoices → 403 NOT_PERMITTED', async () => {
      const res = await call(ENDPOINTS[2], bookkeeperToken, projectId);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('PATCH /api/invoices/:id → 403 NOT_PERMITTED', async () => {
      const res = await call(ENDPOINTS[3], bookkeeperToken, draftIdForBookkeeperReject, {
        lines: [],
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('DELETE /api/invoices/:id → 403 NOT_PERMITTED', async () => {
      const res = await call(ENDPOINTS[4], bookkeeperToken, draftIdForBookkeeperReject);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('POST /api/invoices/:id/issue → 403 NOT_PERMITTED', async () => {
      const res = await call(ENDPOINTS[5], bookkeeperToken, draftIdForBookkeeperReject);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('POST /api/invoices/:id/cancel → 403 NOT_PERMITTED', async () => {
      const res = await call(ENDPOINTS[6], bookkeeperToken, issuedIdForReadOnly, {});
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PERMITTED');
    });

    it('GET /api/invoices/:id/pdf → 200', async () => {
      const res = await call(ENDPOINTS[7], bookkeeperToken, issuedIdForReadOnly);
      expect(res.statusCode).toBe(200);
    });
  });

  // ---------------------------------------------------------------------
  // Office arm — `invoice:read` + `invoice:write`. Every endpoint
  // succeeds (or 404 for genuinely-missing targets).
  // ---------------------------------------------------------------------

  describe('office — invoice:read + invoice:write', () => {
    it('GET /api/invoices → 200', async () => {
      const res = await call(ENDPOINTS[0], officeToken, null);
      expect(res.statusCode).toBe(200);
    });

    it('GET /api/invoices/:id on existing draft → 200', async () => {
      const res = await call(ENDPOINTS[1], officeToken, draftIdForOfficeSuccess);
      expect(res.statusCode).toBe(200);
    });

    it('POST /api/invoices → 201', async () => {
      const res = await call(ENDPOINTS[2], officeToken, projectId);
      expect(res.statusCode).toBe(201);
    });

    it('PATCH /api/invoices/:id on draft → 200', async () => {
      const res = await call(ENDPOINTS[3], officeToken, draftIdForOfficeSuccess, {
        lines: [
          {
            description: 'Office patch',
            quantity: 1,
            unit: 'h',
            unitPrice: 50,
            lineTotal: 50,
            taxRate: 19,
          },
        ],
      });
      expect(res.statusCode).toBe(200);
    });

    it('DELETE /api/invoices/:id on draft → 204', async () => {
      // A fresh draft so the DELETE here doesn't depend on the patch
      // above having run first.
      const ephemeral = await seedDraftInvoice(projectId);
      const res = await call(ENDPOINTS[4], officeToken, ephemeral);
      expect(res.statusCode).toBe(204);
    });

    it('POST /api/invoices/:id/issue → 200 (on a rechnung_faellig project draft)', async () => {
      // Each successful issue consumes one rechnung_faellig project;
      // we minted `issueProjectIdOffice` in beforeAll for exactly this.
      const createRes = await authPost(officeToken, '/api/invoices', {
        projectId: issueProjectIdOffice,
        lines: [
          {
            description: 'Office issue arm',
            quantity: 1,
            unit: 'pauschal',
            unitPrice: 100,
            lineTotal: 100,
            taxRate: 19,
          },
        ],
        performanceDate: '2026-04-10',
      });
      expect(createRes.statusCode).toBe(201);
      const id = createRes.json().id as string;
      const res = await call(ENDPOINTS[5], officeToken, id);
      expect(res.statusCode).toBe(200);
    });

    it('POST /api/invoices/:id/cancel → 200', async () => {
      const res = await call(ENDPOINTS[6], officeToken, issuedIdForCancelOffice, {});
      expect(res.statusCode).toBe(200);
    });

    it('GET /api/invoices/:id/pdf → 200', async () => {
      const res = await call(ENDPOINTS[7], officeToken, issuedIdForReadOnly);
      expect(res.statusCode).toBe(200);
    });
  });

  // ---------------------------------------------------------------------
  // Owner arm — superset of office. Regression anchor: a regression
  // that mis-classified the owner role (e.g. introduced a
  // bookkeeper-style scope split) would surface here.
  // ---------------------------------------------------------------------

  describe('owner — invoice:read + invoice:write', () => {
    it('GET /api/invoices → 200', async () => {
      const res = await call(ENDPOINTS[0], ownerToken, null);
      expect(res.statusCode).toBe(200);
    });

    it('GET /api/invoices/:id on existing draft → 200', async () => {
      const res = await call(ENDPOINTS[1], ownerToken, draftIdForOwnerSuccess);
      expect(res.statusCode).toBe(200);
    });

    it('POST /api/invoices → 201', async () => {
      const res = await call(ENDPOINTS[2], ownerToken, projectId);
      expect(res.statusCode).toBe(201);
    });

    it('PATCH /api/invoices/:id on draft → 200', async () => {
      const res = await call(ENDPOINTS[3], ownerToken, draftIdForOwnerSuccess, {
        lines: [
          {
            description: 'Owner patch',
            quantity: 1,
            unit: 'h',
            unitPrice: 75,
            lineTotal: 75,
            taxRate: 19,
          },
        ],
      });
      expect(res.statusCode).toBe(200);
    });

    it('DELETE /api/invoices/:id on draft → 204', async () => {
      const ephemeral = await seedDraftInvoice(projectId);
      const res = await call(ENDPOINTS[4], ownerToken, ephemeral);
      expect(res.statusCode).toBe(204);
    });

    it('POST /api/invoices/:id/issue → 200', async () => {
      const createRes = await authPost(ownerToken, '/api/invoices', {
        projectId: issueProjectIdOwner,
        lines: [
          {
            description: 'Owner issue arm',
            quantity: 1,
            unit: 'pauschal',
            unitPrice: 100,
            lineTotal: 100,
            taxRate: 19,
          },
        ],
        performanceDate: '2026-04-10',
      });
      expect(createRes.statusCode).toBe(201);
      const id = createRes.json().id as string;
      const res = await call(ENDPOINTS[5], ownerToken, id);
      expect(res.statusCode).toBe(200);
    });

    it('POST /api/invoices/:id/cancel → 200', async () => {
      const res = await call(ENDPOINTS[6], ownerToken, issuedIdForCancelOwner, {});
      expect(res.statusCode).toBe(200);
    });

    it('GET /api/invoices/:id/pdf → 200', async () => {
      const res = await call(ENDPOINTS[7], ownerToken, issuedIdForReadOnly);
      expect(res.statusCode).toBe(200);
    });
  });
});
