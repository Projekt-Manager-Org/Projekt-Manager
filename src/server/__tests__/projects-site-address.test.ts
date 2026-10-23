/**
 * API integration tests: project siteAddress (Baustelle).
 *
 * Covers the new AC pair from issue #179:
 *   - AC-483, AC-484  POST /api/projects with `siteAddress` round-trip + replay rules
 *   - AC-483, AC-484  PATCH /api/projects/:id `siteAddress` semantics
 *             (set / null clears / omitted no-op)
 *
 * `siteAddress` is the Baustellen-/Leistungsadresse — distinct from
 * `customer.address` (Rechnungsadresse). `null` means the site is at the
 * customer's billing address (data-model.md §5.1). PATCH-null clears the
 * stored value, mirroring the customer-address rule pinned by AC-55
 * (idempotency.test.ts already pins the customer-address branch).
 *
 * Runs against a real test database via Fastify inject. The same
 * project-CRUD scaffolding from `projects-crud.test.ts` and
 * `idempotency.test.ts` is reused — owner login, seeded customer,
 * `nextProjectNumber` to keep numbers within the 20-char cap.
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, login, authGet, authPost, authPatch } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';

let projectNumberCounter = 0;
function nextProjectNumber(prefix: string): string {
  projectNumberCounter++;
  // 20-char cap: "S-" + prefix (max 12) + "-" + counter (up to 4 digits).
  const capped = prefix.slice(0, 12);
  return `S-${capped}-${projectNumberCounter}`;
}

const SITE_BERLIN = { street: 'Goethestr. 18', zip: '51103', city: 'Köln' };
const SITE_BERLIN_DIVERGENT = { street: 'Schillerstr. 4', zip: '50667', city: 'Köln' };

describe('Project siteAddress (Baustelle) — POST + PATCH', () => {
  let ownerToken: string;
  let seededCustomerId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    const customerRes = await authGet(ownerToken, '/api/customers');
    seededCustomerId = customerRes.json().customers[0].id;
  });

  afterAll(async () => {
    await stopApp();
  });

  // -----------------------------------------------------------------
  // AC-483, AC-484 — POST /api/projects with `siteAddress` round-trip + replay
  // -----------------------------------------------------------------
  describe('AC-483, AC-484: POST /api/projects round-trip', () => {
    it('persists a fully populated siteAddress and round-trips on GET', async () => {
      const number = nextProjectNumber('SET');
      const createRes = await authPost(ownerToken, '/api/projects', {
        number,
        title: 'Baustelle Set',
        customerId: seededCustomerId,
        siteAddress: SITE_BERLIN,
      });
      expect(createRes.statusCode).toBe(201);

      const created = createRes.json();
      expect(created.siteAddress).toEqual(SITE_BERLIN);

      const getRes = await authGet(ownerToken, `/api/projects/${created.id}`);
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().siteAddress).toEqual(SITE_BERLIN);
    });

    it('persists null when siteAddress is omitted (project inherits customer address)', async () => {
      const number = nextProjectNumber('OMIT');
      const createRes = await authPost(ownerToken, '/api/projects', {
        number,
        title: 'Baustelle Omitted',
        customerId: seededCustomerId,
      });
      expect(createRes.statusCode).toBe(201);
      expect(createRes.json().siteAddress).toBeNull();
    });

    it('persists null when siteAddress is explicitly null', async () => {
      const number = nextProjectNumber('EXPNULL');
      const createRes = await authPost(ownerToken, '/api/projects', {
        number,
        title: 'Baustelle Explicit Null',
        customerId: seededCustomerId,
        siteAddress: null,
      });
      expect(createRes.statusCode).toBe(201);
      expect(createRes.json().siteAddress).toBeNull();
    });

    it('idempotent replay — same id + same siteAddress triple succeeds', async () => {
      const id = randomUUID();
      const number = nextProjectNumber('REPLAY');
      const body = {
        id,
        number,
        title: 'Replay siteAddress',
        customerId: seededCustomerId,
        siteAddress: SITE_BERLIN,
      };
      const first = await authPost(ownerToken, '/api/projects', body);
      expect(first.statusCode).toBe(201);

      const second = await authPost(ownerToken, '/api/projects', body);
      expect(second.statusCode).toBe(201);
      expect(second.json().id).toBe(first.json().id);
      // Replay must return the stored row — the persisted siteAddress
      // round-trips. Without this assertion the test would pass even if
      // the server silently drops the siteAddress field (then both
      // bodies look identical to the comparator and both succeed,
      // hiding the missing persistence contract).
      expect(second.json().siteAddress).toEqual(SITE_BERLIN);
    });

    it('idempotent replay — same id + divergent siteAddress triple → 409 IDEMPOTENCY_CONFLICT', async () => {
      const id = randomUUID();
      const number = nextProjectNumber('CONFLICT');
      const first = await authPost(ownerToken, '/api/projects', {
        id,
        number,
        title: 'Conflict A',
        customerId: seededCustomerId,
        siteAddress: SITE_BERLIN,
      });
      expect(first.statusCode).toBe(201);

      const second = await authPost(ownerToken, '/api/projects', {
        id,
        number,
        title: 'Conflict A',
        customerId: seededCustomerId,
        siteAddress: SITE_BERLIN_DIVERGENT,
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('idempotent replay — null vs set divergence → 409 IDEMPOTENCY_CONFLICT', async () => {
      const id = randomUUID();
      const number = nextProjectNumber('NULLSET');
      const first = await authPost(ownerToken, '/api/projects', {
        id,
        number,
        title: 'Null vs Set',
        customerId: seededCustomerId,
        siteAddress: SITE_BERLIN,
      });
      expect(first.statusCode).toBe(201);

      // Null on the second call against a stored object is a divergence
      // and must be rejected — the reverse of the omission rule for
      // assignedWorkerIds in idempotency.test.ts.
      const second = await authPost(ownerToken, '/api/projects', {
        id,
        number,
        title: 'Null vs Set',
        customerId: seededCustomerId,
        siteAddress: null,
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe('IDEMPOTENCY_CONFLICT');
    });
  });

  // -----------------------------------------------------------------
  // AC-483, AC-484 — PATCH /api/projects/:id siteAddress semantics
  // -----------------------------------------------------------------
  describe('AC-483, AC-484: PATCH /api/projects/:id siteAddress', () => {
    it('sets a stored siteAddress when supplied as a populated object', async () => {
      const number = nextProjectNumber('PATCHSET');
      const createRes = await authPost(ownerToken, '/api/projects', {
        number,
        title: 'PATCH set',
        customerId: seededCustomerId,
      });
      expect(createRes.statusCode).toBe(201);
      const id = createRes.json().id;

      const patchRes = await authPatch(ownerToken, `/api/projects/${id}`, {
        siteAddress: SITE_BERLIN,
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json().siteAddress).toEqual(SITE_BERLIN);

      // Round-trip via GET — guards against a bug where the PATCH
      // response carries the new value but the row stays unchanged.
      const getRes = await authGet(ownerToken, `/api/projects/${id}`);
      expect(getRes.json().siteAddress).toEqual(SITE_BERLIN);

      // AC-177 ties the mutation to the single-write-path helper
      // (mutate(), AC-177): a successful PATCH that changes
      // siteAddress must produce an `update` audit row scoped to this
      // project. Pattern mirrors the audit-row test in projects-restore.test.ts.
      const auditRes = await authGet(
        ownerToken,
        `/api/audit?ancestorType=project&ancestorId=${id}&limit=200`,
      );
      expect(auditRes.statusCode).toBe(200);
      const rows = auditRes.json().data as { action: string }[];
      expect(Array.isArray(rows)).toBe(true);
      const updates = rows.filter((r) => r.action === 'update');
      expect(updates.length).toBeGreaterThanOrEqual(1);
    });

    it('clears the stored siteAddress when supplied as null', async () => {
      const number = nextProjectNumber('PATCHNULL');
      const createRes = await authPost(ownerToken, '/api/projects', {
        number,
        title: 'PATCH clear',
        customerId: seededCustomerId,
        siteAddress: SITE_BERLIN,
      });
      expect(createRes.statusCode).toBe(201);
      const id = createRes.json().id;

      const patchRes = await authPatch(ownerToken, `/api/projects/${id}`, {
        siteAddress: null,
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json().siteAddress).toBeNull();

      const getRes = await authGet(ownerToken, `/api/projects/${id}`);
      expect(getRes.json().siteAddress).toBeNull();

      // Clearing changes the stored value, so AC-177 owes an audit row
      // here too — one `update`, recording the set → null transition.
      const auditRes = await authGet(
        ownerToken,
        `/api/audit?ancestorType=project&ancestorId=${id}&action=update&limit=200`,
      );
      expect(auditRes.statusCode).toBe(200);
      const updates = auditRes.json().data as { entityType: string; payload: unknown }[];
      expect(updates).toHaveLength(1);
      expect(updates[0].entityType).toBe('project');
      expect(updates[0].payload).toMatchObject({
        before: { siteAddress: SITE_BERLIN },
        after: { siteAddress: null },
      });
    });

    it('leaves a stored siteAddress untouched when the field is omitted (PATCH semantics)', async () => {
      const number = nextProjectNumber('PATCHOMIT');
      const createRes = await authPost(ownerToken, '/api/projects', {
        number,
        title: 'PATCH omit',
        customerId: seededCustomerId,
        siteAddress: SITE_BERLIN,
      });
      expect(createRes.statusCode).toBe(201);
      const id = createRes.json().id;

      // PATCH another field. siteAddress must not be touched.
      const patchRes = await authPatch(ownerToken, `/api/projects/${id}`, {
        notes: 'Notiz ohne Adresseingriff',
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json().siteAddress).toEqual(SITE_BERLIN);

      const getRes = await authGet(ownerToken, `/api/projects/${id}`);
      expect(getRes.json().siteAddress).toEqual(SITE_BERLIN);
      expect(getRes.json().notes).toBe('Notiz ohne Adresseingriff');
    });
  });

  // -----------------------------------------------------------------
  // AC-485 — API backstop: a malformed client that bypasses the form's
  // all-or-none rule must still be refused. The route's JSON Schema
  // pins `minLength: 1` on each of street / zip / city, so an empty
  // string in any one component is a 400 VALIDATION_ERROR. The
  // happy-paths (full triple, null) remain 201.
  // -----------------------------------------------------------------
  describe('AC-485: API backstop — partial siteAddress is rejected', () => {
    it('POST with empty zip → 422 VALIDATION_ERROR', async () => {
      const number = nextProjectNumber('PARTZIP');
      const res = await authPost(ownerToken, '/api/projects', {
        number,
        title: 'Partial zip',
        customerId: seededCustomerId,
        siteAddress: { street: 'X', zip: '', city: 'Köln' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('POST with empty street → 422 VALIDATION_ERROR', async () => {
      const number = nextProjectNumber('PARTSTR');
      const res = await authPost(ownerToken, '/api/projects', {
        number,
        title: 'Partial street',
        customerId: seededCustomerId,
        siteAddress: { street: '', zip: '51103', city: 'Köln' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('POST with empty city → 422 VALIDATION_ERROR', async () => {
      const number = nextProjectNumber('PARTCTY');
      const res = await authPost(ownerToken, '/api/projects', {
        number,
        title: 'Partial city',
        customerId: seededCustomerId,
        siteAddress: { street: 'Goethestr. 18', zip: '51103', city: '' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('PATCH with empty zip → 422 VALIDATION_ERROR', async () => {
      const number = nextProjectNumber('PATCHPART');
      const createRes = await authPost(ownerToken, '/api/projects', {
        number,
        title: 'PATCH partial',
        customerId: seededCustomerId,
      });
      expect(createRes.statusCode).toBe(201);
      const id = createRes.json().id;

      const patchRes = await authPatch(ownerToken, `/api/projects/${id}`, {
        siteAddress: { street: 'X', zip: '', city: 'Köln' },
      });
      expect(patchRes.statusCode).toBe(422);
      expect(patchRes.json().code).toBe('VALIDATION_ERROR');
    });

    it('POST with all three non-empty triple → 201 (existing behavior unbroken)', async () => {
      const number = nextProjectNumber('FULL');
      const res = await authPost(ownerToken, '/api/projects', {
        number,
        title: 'Full triple',
        customerId: seededCustomerId,
        siteAddress: { street: 'Goethestr. 18', zip: '51103', city: 'Köln' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().siteAddress).toEqual({
        street: 'Goethestr. 18',
        zip: '51103',
        city: 'Köln',
      });
    });

    it('POST with siteAddress: null → 201 (existing behavior unbroken)', async () => {
      const number = nextProjectNumber('NULL');
      const res = await authPost(ownerToken, '/api/projects', {
        number,
        title: 'Null site',
        customerId: seededCustomerId,
        siteAddress: null,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().siteAddress).toBeNull();
    });
  });
});
