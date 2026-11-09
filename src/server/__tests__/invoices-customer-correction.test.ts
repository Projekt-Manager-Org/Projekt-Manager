/**
 * API integration tests: a customer correction reaches open drafts
 * (data-model.md §5.15, §6.4).
 *
 * AC-543 the correction itself, AC-544 its transaction, audit and SSE,
 * AC-545 a draft created during an edit, AC-546 serialization with Update,
 * Delete and Issue on the same draft.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
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
  seedProjectStatus,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import { subscribe, unsubscribe } from '../sse/bus.js';

const OLD = {
  name: 'Alt GmbH',
  address: { street: 'Altweg 1', zip: '10115', city: 'Berlin' },
  ustId: 'DE111111111',
};
const NEW = {
  name: 'Neu GmbH',
  address: { street: 'Neuweg 2', zip: '20095', city: 'Hamburg' },
  ustId: 'DE222222222',
};
const LINE = { description: 'Fassade', quantity: 1, unit: 'pauschal', unitPrice: 100, taxRate: 19 };

const { pool } = createDatabase();
let ownerToken: string;
let officeToken: string;
let officeId: string;

interface Customer {
  id: string;
  version: number;
}
interface Draft {
  id: string;
  version: number;
  recipient: Record<string, unknown>;
}

async function mintCustomer(fields: Record<string, unknown> = OLD): Promise<Customer> {
  const res = await authPost(ownerToken, '/api/customers', fields);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function mintProject(customerId: string): Promise<string> {
  const res = await authPost(ownerToken, '/api/projects', {
    number: `KORR-${crypto.randomUUID().slice(0, 8)}`,
    title: 'Empfänger-Korrektur',
    customerId,
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().id as string;
  await seedProjectStatus(id, 'rechnung_faellig');
  return id;
}

async function saveDraft(projectId: string, extra: Record<string, unknown> = {}): Promise<Draft> {
  const res = await authPost(ownerToken, '/api/invoices', {
    projectId,
    performanceDate: '2026-04-10',
    lines: [LINE],
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function mintDraft(
  extra: Record<string, unknown> = {},
): Promise<{ customer: Customer; projectId: string; draft: Draft }> {
  const customer = await mintCustomer();
  const projectId = await mintProject(customer.id);
  return { customer, projectId, draft: await saveDraft(projectId, extra) };
}

function correct(customer: Customer, fields: Record<string, unknown> = NEW) {
  return authPatch(ownerToken, `/api/customers/${customer.id}`, {
    expectedVersion: customer.version,
    ...fields,
  });
}

async function correctOk(
  customer: Customer,
  fields: Record<string, unknown> = NEW,
  token: string = ownerToken,
): Promise<void> {
  const res = await authPatch(token, `/api/customers/${customer.id}`, {
    expectedVersion: customer.version,
    ...fields,
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function readInvoice(id: string): Promise<Draft> {
  const res = await authGet(ownerToken, `/api/invoices/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

function issue(id: string, version: number) {
  return authPost(ownerToken, `/api/invoices/${id}/issue`, { expectedVersion: version });
}

async function auditRows(invoiceId: string) {
  const { rows } = await pool.query(
    `SELECT actor_id, ancestor_entity_type, ancestor_entity_id, payload
       FROM audit_log
      WHERE entity_type = 'invoice' AND entity_id = $1 AND action = 'update'`,
    [invoiceId],
  );
  return rows as {
    actor_id: string;
    ancestor_entity_type: string;
    ancestor_entity_id: string;
    payload: { before: { recipient: unknown }; after: { recipient: unknown } };
  }[];
}

async function waitForBlocked(n: number): Promise<void> {
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
  expect(seen, `expected ${n} writes queued behind the held row`).toBeGreaterThanOrEqual(n);
}

/**
 * One `holder` transaction: run `during` while it is open, wait for
 * `blocked` writes to queue behind it, then end it with `finish`.
 */
async function withHolder<T>(
  setup: (holder: { query: (q: string, v?: unknown[]) => Promise<unknown> }) => Promise<void>,
  during: () => Promise<T>,
  { finish = 'COMMIT', blocked = 1 }: { finish?: 'COMMIT' | 'ROLLBACK'; blocked?: number } = {},
): Promise<T> {
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await setup(holder);
    const pending = during();
    await waitForBlocked(blocked);
    await holder.query(finish);
    return await pending;
  } finally {
    holder.release();
  }
}

describe('customer correction on open drafts', () => {
  const sseChunks: string[] = [];
  const conn = { write: (chunk: string) => void sseChunks.push(chunk) };
  const invoiceChangedEvents = () =>
    (sseChunks.join('').match(/event: invoice_changed\n/g) ?? []).length;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    officeToken = await login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD);
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [
      SEED_USERS.office.username,
    ]);
    officeId = (rows[0] as { id: string }).id;
    const profile = await authPut(ownerToken, '/api/company-profile', {
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
    expect([200, 204]).toContain(profile.statusCode);
  });

  afterAll(async () => {
    await stopApp();
    await pool.end();
  });

  beforeEach(() => {
    sseChunks.length = 0;
    subscribe(conn);
  });

  afterEach(() => {
    unsubscribe(conn);
  });

  describe('AC-543: the draft follows the customer', () => {
    it('takes the corrected recipient, and issuing freezes it', async () => {
      const { customer, draft } = await mintDraft();
      await correctOk(customer);

      const corrected = await readInvoice(draft.id);
      expect(corrected.recipient).toEqual(NEW);
      const issued = await issue(draft.id, corrected.version);
      expect(issued.statusCode, issued.body).toBe(200);
      expect(issued.json().recipient).toEqual(NEW);
    });

    it('a USt-IdNr. added to the customer makes a reverse-charge draft issuable', async () => {
      const customer = await mintCustomer({ name: OLD.name, address: OLD.address });
      const projectId = await mintProject(customer.id);
      const draft = await saveDraft(projectId, {
        taxMode: 'reverse_charge',
        lines: [{ ...LINE, taxRate: 0 }],
      });
      await correctOk(customer, { ustId: NEW.ustId });

      const corrected = await readInvoice(draft.id);
      const issued = await issue(draft.id, corrected.version);
      expect(issued.statusCode, issued.body).toBe(200);
      expect(issued.json().recipient.ustId).toBe(NEW.ustId);
    });

    it('keeps user overrides, whole, while the other fields follow, and issues them', async () => {
      const name = 'Abweichend AG';
      const address = { ...OLD.address, street: 'Eigenweg 9' };
      const { customer, draft } = await mintDraft({ recipient: { name, address } });
      await correctOk(customer);

      const corrected = await readInvoice(draft.id);
      expect(corrected.recipient).toEqual({ name, address, ustId: NEW.ustId });
      const issued = await issue(draft.id, corrected.version);
      expect(issued.statusCode, issued.body).toBe(200);
      expect(issued.json().recipient).toEqual({ name, address, ustId: NEW.ustId });
    });

    it('a value cleared on the customer is cleared on the draft', async () => {
      const { customer, draft } = await mintDraft();
      await correctOk(customer, { ustId: null });

      expect((await readInvoice(draft.id)).recipient).toEqual({ ...OLD, ustId: null });
    });

    it('surrounding whitespace and blank versus absent are not an override', async () => {
      const customer = await mintCustomer({ ...OLD, name: ' Alt GmbH ', ustId: '' });
      const projectId = await mintProject(customer.id);
      const saved = await saveDraft(projectId);
      const patched = await authPatch(ownerToken, `/api/invoices/${saved.id}`, {
        expectedVersion: saved.version,
        recipient: { name: 'Alt GmbH', address: OLD.address, ustId: null },
      });
      expect(patched.statusCode, patched.body).toBe(200);
      await correctOk(customer);

      expect((await readInvoice(saved.id)).recipient).toEqual(NEW);
    });

    it('a draft on an archived project follows too', async () => {
      const { customer, projectId, draft } = await mintDraft();
      expect((await authDelete(ownerToken, `/api/projects/${projectId}`)).statusCode).toBe(200);
      await correctOk(customer);

      const restored = await authPost(ownerToken, `/api/projects/${projectId}/restore`);
      expect(restored.statusCode, restored.body).toBe(200);
      expect((await readInvoice(draft.id)).recipient).toEqual(NEW);
    });

    it('leaves issued and cancelled invoices unchanged', async () => {
      const customer = await mintCustomer();
      const issuedDraft = await saveDraft(await mintProject(customer.id));
      const cancelledDraft = await saveDraft(await mintProject(customer.id));
      expect((await issue(issuedDraft.id, issuedDraft.version)).statusCode).toBe(200);
      expect((await issue(cancelledDraft.id, cancelledDraft.version)).statusCode).toBe(200);
      const cancelled = await authPost(ownerToken, `/api/invoices/${cancelledDraft.id}/cancel`, {});
      expect(cancelled.statusCode, cancelled.body).toBe(200);

      await correctOk(customer);

      expect((await readInvoice(issuedDraft.id)).recipient).toEqual(OLD);
      expect((await readInvoice(cancelledDraft.id)).recipient).toEqual(OLD);
    });
  });

  describe('AC-544: transaction, audit and event', () => {
    it('each changed draft gets a version, updatedBy and audit row; one event in all', async () => {
      const customer = await mintCustomer();
      const projectA = await mintProject(customer.id);
      const projectB = await mintProject(customer.id);
      const changed = [
        { draft: await saveDraft(projectA), projectId: projectA },
        { draft: await saveDraft(projectB), projectId: projectB },
      ];
      const override = {
        name: 'Abweichend AG',
        address: { ...OLD.address, street: 'Eigenweg 9' },
        ustId: 'DE999999999',
      };
      const overridden = await saveDraft(projectA, { recipient: override });
      const { draft: otherCustomersDraft } = await mintDraft();
      sseChunks.length = 0;
      await correctOk(customer, NEW, officeToken);

      for (const { draft, projectId } of changed) {
        expect(await readInvoice(draft.id)).toMatchObject({
          version: draft.version + 1,
          recipient: NEW,
        });
        const { rows } = await pool.query('SELECT updated_by FROM invoices WHERE id = $1', [
          draft.id,
        ]);
        expect((rows[0] as { updated_by: string }).updated_by).toBe(officeId);
        const audit = await auditRows(draft.id);
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({
          actor_id: officeId,
          ancestor_entity_type: 'project',
          ancestor_entity_id: projectId,
        });
        expect(audit[0]!.payload.before.recipient).toEqual(OLD);
        expect(audit[0]!.payload.after.recipient).toEqual(NEW);
      }
      expect(await readInvoice(overridden.id)).toMatchObject({
        version: overridden.version,
        recipient: override,
      });
      expect(await auditRows(overridden.id)).toHaveLength(0);
      expect(await readInvoice(otherCustomersDraft.id)).toMatchObject({
        version: otherCustomersDraft.version,
        recipient: OLD,
      });
      expect(invoiceChangedEvents()).toBe(1);
    });

    it('a draft fully overridden, or an edit of other fields, changes nothing', async () => {
      const override = { name: 'Abweichend AG', address: NEW.address, ustId: 'DE999999999' };
      const { customer, draft } = await mintDraft({ recipient: override });
      sseChunks.length = 0;
      await correctOk(customer);
      expect(invoiceChangedEvents()).toBe(0);
      const untouchedByPhone = await mintDraft();
      sseChunks.length = 0;
      // The customer form sends every field, changed or not.
      await correctOk(untouchedByPhone.customer, { ...OLD, phone: '0151 1234567' });

      expect(await readInvoice(draft.id)).toMatchObject({
        version: draft.version,
        recipient: override,
      });
      expect((await readInvoice(untouchedByPhone.draft.id)).version).toBe(
        untouchedByPhone.draft.version,
      );
      expect(await auditRows(draft.id)).toHaveLength(0);
      expect(await auditRows(untouchedByPhone.draft.id)).toHaveLength(0);
      expect(invoiceChangedEvents()).toBe(0);
    });

    it('a failing draft write rejects the edit and leaves everything unchanged', async () => {
      const customer = await mintCustomer();
      const first = await saveDraft(await mintProject(customer.id));
      const second = await saveDraft(await mintProject(customer.id));
      // Fails whichever of the two is written second, so one is written first.
      await pool.query(`
        CREATE SEQUENCE test_fail_invoice_update_seq;
        CREATE FUNCTION test_fail_invoice_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF nextval('test_fail_invoice_update_seq') = 2 THEN
            RAISE EXCEPTION 'forced invoice update failure';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER test_fail_invoice_update BEFORE UPDATE ON invoices
        FOR EACH ROW WHEN (NEW.id IN ('${first.id}', '${second.id}'))
        EXECUTE FUNCTION test_fail_invoice_update();
      `);
      sseChunks.length = 0;
      let res;
      try {
        res = await correct(customer);
      } finally {
        await pool.query(`
          DROP TRIGGER test_fail_invoice_update ON invoices;
          DROP FUNCTION test_fail_invoice_update();
          DROP SEQUENCE test_fail_invoice_update_seq;
        `);
      }

      expect(res.statusCode, res.body).toBeGreaterThanOrEqual(500);
      const read = await authGet(ownerToken, `/api/customers/${customer.id}`);
      expect(read.json().name).toBe(OLD.name);
      for (const draft of [first, second]) {
        expect(await readInvoice(draft.id)).toMatchObject({
          version: draft.version,
          recipient: OLD,
        });
        expect(await auditRows(draft.id)).toHaveLength(0);
      }
      expect(invoiceChangedEvents()).toBe(0);
    });
  });

  describe('AC-545: a draft created during a customer edit', () => {
    async function createDuringEdit(finish: 'COMMIT' | 'ROLLBACK') {
      const customer = await mintCustomer();
      const projectId = await mintProject(customer.id);
      return withHolder(
        async (holder) => {
          await holder.query('UPDATE customers SET name = $1 WHERE id = $2', [
            NEW.name,
            customer.id,
          ]);
        },
        () => saveDraft(projectId),
        { finish },
      );
    }

    it('holds the edited value if the edit commits', async () => {
      expect((await createDuringEdit('COMMIT')).recipient.name).toBe(NEW.name);
    });

    it('holds the prior value if the edit rolls back', async () => {
      expect((await createDuringEdit('ROLLBACK')).recipient.name).toBe(OLD.name);
    });
  });

  describe('AC-546: serialization with Update, Delete and Issue', () => {
    it('an override committed first stays', async () => {
      const { customer, draft } = await mintDraft();
      const override = { ...OLD, name: 'Abweichend AG' };
      const res = await withHolder(
        async (holder) => {
          await holder.query('UPDATE invoices SET recipient = $1 WHERE id = $2', [
            JSON.stringify(override),
            draft.id,
          ]);
        },
        () => correct(customer),
      );

      expect(res.statusCode, res.body).toBe(200);
      expect((await readInvoice(draft.id)).recipient).toEqual({
        ...NEW,
        name: override.name,
      });
    });

    it('a draft deleted first is untouched and does not fail the edit', async () => {
      const { customer, draft } = await mintDraft();
      sseChunks.length = 0;
      const res = await withHolder(
        async (holder) => {
          await holder.query('DELETE FROM invoices WHERE id = $1', [draft.id]);
        },
        () => correct(customer),
      );

      expect(res.statusCode, res.body).toBe(200);
      expect(await auditRows(draft.id)).toHaveLength(0);
      expect(invoiceChangedEvents()).toBe(0);
    });

    it('a draft issued first keeps the recipient it was issued with', async () => {
      const { customer, draft } = await mintDraft();
      const [issued, corrected] = await withHolder(
        async (holder) => {
          await holder.query('SELECT 1 FROM invoices WHERE id = $1 FOR UPDATE', [draft.id]);
        },
        async () => {
          const issuing = issue(draft.id, draft.version);
          await waitForBlocked(1);
          return Promise.all([issuing, correct(customer)]);
        },
        { blocked: 2 },
      );

      expect(issued.statusCode, issued.body).toBe(200);
      expect(corrected.statusCode, corrected.body).toBe(200);
      expect(issued.json().recipient).toEqual(OLD);
      expect((await readInvoice(draft.id)).recipient).toEqual(OLD);
      expect(await auditRows(draft.id)).toHaveLength(0);
    });

    it.each([
      [
        'Update',
        (id: string, v: number) =>
          authPatch(ownerToken, `/api/invoices/${id}`, { expectedVersion: v, lines: [LINE] }),
      ],
      [
        'Delete',
        (id: string, v: number) =>
          authDelete(ownerToken, `/api/invoices/${id}?expectedVersion=${v}`),
      ],
      ['Issue', (id: string, v: number) => issue(id, v)],
    ])('%s carrying the pre-correction version is rejected', async (_name, operate) => {
      const { customer, draft } = await mintDraft();
      await correctOk(customer);

      const res = await operate(draft.id, draft.version);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().code).toBe('VERSION_CONFLICT');
    });
  });

  it('a customer delete queued behind a correction completes without a deadlock', async () => {
    const { customer, projectId } = await mintDraft();
    expect((await authDelete(ownerToken, `/api/projects/${projectId}`)).statusCode).toBe(200);

    const [edited, deleted] = await withHolder(
      async (holder) => {
        await holder.query('SELECT 1 FROM customers WHERE id = $1 FOR UPDATE', [customer.id]);
      },
      async () => {
        const editing = correct(customer);
        await waitForBlocked(1);
        return Promise.all([editing, authDelete(ownerToken, `/api/customers/${customer.id}`)]);
      },
      { blocked: 2 },
    );

    expect(edited.statusCode, edited.body).toBe(200);
    expect(deleted.statusCode, deleted.body).toBeLessThan(300);
  });
});
