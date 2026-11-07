/**
 * API integration tests — customer ustId field + invoice-draft pre-fill.
 *
 *   1. Customer CRUD ustId surface (data-model.md §5.6): round-trip, PATCH
 *      semantics, null-clears (AC-518, AC-519); a replay with a divergent
 *      ustId conflicts (AC-124, AC-127).
 *
 *   2. Invoice draft pre-fill (AC-285): `POST /api/invoices` without a
 *      `recipient.ustId` takes it from the project's customer; an explicit
 *      value overrides it. The same outcome through the draft form is a
 *      gap (#784).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import {
  startApp,
  stopApp,
  login,
  authGet,
  authPost,
  authPatch,
  expectedVersion,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';

interface Project {
  id: string;
  status: string;
}

async function rechnungFaelligProjectId(ownerToken: string): Promise<string> {
  const res = await authGet(ownerToken, '/api/projects?status=rechnung_faellig&limit=200');
  const rows = res.json().data as Project[];
  if (rows.length === 0) throw new Error('seed missing project in rechnung_faellig');
  return rows[0]!.id;
}

describe('customer.ustId CRUD + idempotent-replay + invoice pre-fill', () => {
  let ownerToken: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    await stopApp();
  });

  describe('Customer CRUD surface', () => {
    it('AC-518: POST accepts ustId and the GET round-trips it', async () => {
      const ustId = 'DE111222333';
      const post = await authPost(ownerToken, '/api/customers', {
        name: `UstId-CRUD ${crypto.randomUUID().slice(0, 6)}`,
        ustId,
      });
      expect(post.statusCode).toBe(201);
      const id = post.json().id as string;
      expect(post.json().ustId).toBe(ustId);

      const get = await authGet(ownerToken, `/api/customers/${id}`);
      expect(get.statusCode).toBe(200);
      expect(get.json().ustId).toBe(ustId);
    });

    it('AC-519: PATCH stores the entered ustId; omitted fields unchanged', async () => {
      const createRes = await authPost(ownerToken, '/api/customers', {
        name: `UstId-PATCH ${crypto.randomUUID().slice(0, 6)}`,
        ustId: 'DE000000001',
        phone: '0221-1234',
      });
      const id = createRes.json().id as string;

      const patchRes = await authPatch(ownerToken, `/api/customers/${id}`, {
        ...(await expectedVersion(ownerToken, `/api/customers/${id}`)),
        ustId: 'DE999888777',
      });
      expect(patchRes.statusCode).toBe(200);
      const body = patchRes.json();
      expect(body.ustId).toBe('DE999888777');
      // Phone is omitted from the PATCH body — must be unchanged.
      expect(body.phone).toBe('0221-1234');
    });

    it('AC-519: PATCH with ustId=null clears the field', async () => {
      const createRes = await authPost(ownerToken, '/api/customers', {
        name: `UstId-CLEAR ${crypto.randomUUID().slice(0, 6)}`,
        ustId: 'DE000000002',
      });
      const id = createRes.json().id as string;

      const patchRes = await authPatch(ownerToken, `/api/customers/${id}`, {
        ...(await expectedVersion(ownerToken, `/api/customers/${id}`)),
        ustId: null,
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json().ustId).toBeNull();
    });
  });

  describe('Idempotent-replay comparison includes ustId', () => {
    it('AC-124: same id + same body (ustId equal) → second call succeeds, no duplicate', async () => {
      const id = crypto.randomUUID();
      const name = `Idem-Same ${id.slice(0, 6)}`;
      const body = { id, name, ustId: 'DE123456789' };
      const first = await authPost(ownerToken, '/api/customers', body);
      expect(first.statusCode).toBe(201);
      const second = await authPost(ownerToken, '/api/customers', body);
      expect(second.statusCode).toBe(201);
      expect(second.json().id).toBe(id);
    });

    it('AC-127: same id + divergent ustId → 409 IDEMPOTENCY_CONFLICT', async () => {
      const id = crypto.randomUUID();
      const name = `Idem-Diff ${id.slice(0, 6)}`;
      const first = await authPost(ownerToken, '/api/customers', {
        id,
        name,
        ustId: 'DE111111111',
      });
      expect(first.statusCode).toBe(201);

      const second = await authPost(ownerToken, '/api/customers', {
        id,
        name,
        ustId: 'DE222222222',
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe('IDEMPOTENCY_CONFLICT');

      // The stored row keeps the first body's ustId — not the replay's.
      const get = await authGet(ownerToken, `/api/customers/${id}`);
      expect(get.json().ustId).toBe('DE111111111');
    });
  });

  describe('AC-285: Invoice draft pre-fills recipient.ustId from the project customer', () => {
    it('POST /api/invoices on a project whose customer carries ustId pre-fills Invoice.recipient.ustId', async () => {
      const projectId = await rechnungFaelligProjectId(ownerToken);

      // Resolve the customer for this project, set its ustId.
      const projRes = await authGet(ownerToken, `/api/projects/${projectId}`);
      expect(projRes.statusCode).toBe(200);
      const customerId = projRes.json().customerId as string;

      const customerUstId = `DE${crypto.randomInt(100_000_000, 999_999_999)}`;
      const patchCust = await authPatch(ownerToken, `/api/customers/${customerId}`, {
        ...(await expectedVersion(ownerToken, `/api/customers/${customerId}`)),
        ustId: customerUstId,
      });
      expect(patchCust.statusCode).toBe(200);

      // POST a draft WITHOUT explicit recipient.ustId — must auto-fill.
      const draftRes = await authPost(ownerToken, '/api/invoices', {
        projectId,
        lines: [{ description: 'T', quantity: 1, unit: 'p', unitPrice: 1, taxRate: 19 }],
        performanceDate: '2026-04-10',
      });
      expect(draftRes.statusCode).toBe(201);
      expect(draftRes.json().recipient.ustId).toBe(customerUstId);
    });

    it('explicit recipient.ustId in the body overrides the customer value', async () => {
      const projectId = await rechnungFaelligProjectId(ownerToken);
      const projRes = await authGet(ownerToken, `/api/projects/${projectId}`);
      const customerId = projRes.json().customerId as string;

      const customerUstId = `DE${crypto.randomInt(100_000_000, 999_999_999)}`;
      await authPatch(ownerToken, `/api/customers/${customerId}`, {
        ...(await expectedVersion(ownerToken, `/api/customers/${customerId}`)),
        ustId: customerUstId,
      });

      const overrideUstId = `DE${crypto.randomInt(100_000_000, 999_999_999)}`;
      const draftRes = await authPost(ownerToken, '/api/invoices', {
        projectId,
        lines: [],
        recipient: {
          name: 'Override',
          address: { street: 'S', zip: '12345', city: 'C' },
          ustId: overrideUstId,
        },
      });
      expect(draftRes.statusCode).toBe(201);
      // Per AC-285 design note: explicit `recipient` overrides
      // field-by-field. Override must win.
      expect(draftRes.json().recipient.ustId).toBe(overrideUstId);
    });

    it('customer ustId=null leaves Invoice.recipient.ustId null on the draft', async () => {
      const projectId = await rechnungFaelligProjectId(ownerToken);
      const projRes = await authGet(ownerToken, `/api/projects/${projectId}`);
      const customerId = projRes.json().customerId as string;

      const clear = await authPatch(ownerToken, `/api/customers/${customerId}`, {
        ...(await expectedVersion(ownerToken, `/api/customers/${customerId}`)),
        ustId: null,
      });
      expect(clear.statusCode).toBe(200);

      const draftRes = await authPost(ownerToken, '/api/invoices', {
        projectId,
        lines: [],
      });
      expect(draftRes.statusCode).toBe(201);
      // Customer carries no ustId → recipient.ustId is null /
      // undefined on the draft.
      const ustId = draftRes.json().recipient.ustId;
      expect(ustId === null || ustId === undefined).toBe(true);
    });
  });
});
