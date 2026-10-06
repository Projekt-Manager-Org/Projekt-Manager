/**
 * API integration tests — invoice backup gate (architecture.md §11.14
 * "Backup gate", ADR-0026 "Delivered only once backed up").
 *
 *   - AC-374 [crit]: with the Layer 2 backup feature enabled, issuance
 *     marks the issued row `backupPending` inside its transaction, and
 *     cancellation marks the new Storno; the original's mark is
 *     unchanged; a rolled-back issuance leaves no mark; drafts are never
 *     pending. An application start with the feature disabled drops every
 *     standing mark; an override business-data import writes none and
 *     drops the standing ones.
 *   - AC-375 [crit]: while an invoice is `backupPending`, the PDF
 *     download and the bulk export (ids or filter) covering it return
 *     `409 INVOICE_BACKUP_PENDING` with `details.invoiceId`, carrying no
 *     PDF material; once released, both succeed.
 *
 * The backup feature is enabled the way production enables it — the
 * R2 / AGE_RECIPIENT configuration is present (architecture.md §12.6) —
 * by setting it before `startApp()` builds the routes. Nothing here
 * talks to R2: the gate only reads the configuration. The release is
 * simulated by deleting the mark, which is what a backup run does
 * (AC-373, pinned in `backup.test.ts`).
 *
 * The feature-disabled issuance arm lives in `invoices-issue.test.ts`
 * (default test env has no R2 configuration).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { startApp, stopApp, login, authGet, authPost, authPut } from '../../test/api-helpers.js';
import {
  EXPECTED_RESTORE_PHRASE,
  SEED_DEFAULT_PASSWORD,
  SEED_USERS,
} from '../../test/seedAssumptions.js';
import { createDatabase, type Database } from '../db/connection.js';
import { getEnv } from '../config/env.js';
import { applyInvoiceBackupGateAtBoot } from '../invoice-backup-boot.js';
import { exportEnvelope, importEnvelope } from '../../test/data-exchange-helpers.js';

/** Backup-feature configuration (catalog: `FEATURE_CATALOG` 'backup'). */
const BACKUP_FEATURE_ENV = {
  R2_ACCESS_KEY_ID: 'gate-test-key',
  R2_SECRET_ACCESS_KEY: 'gate-test-secret',
  R2_ENDPOINT: 'http://127.0.0.1:9',
  R2_BUCKET: 'gate-test-bucket',
} as const;

interface InvoiceWire {
  id: string;
  status: 'draft' | 'issued' | 'cancelled';
  backupPending: boolean;
}

describe('invoice backup gate (AC-374, AC-375)', () => {
  let ownerToken: string;
  let db: Database;
  let pool: pg.Pool;
  const savedEnv: Record<string, string | undefined> = {};

  async function markedIds(): Promise<string[]> {
    const r = await pool.query<{ invoice_id: string }>(
      'SELECT invoice_id FROM invoice_backup_pending',
    );
    return r.rows.map((row) => row.invoice_id);
  }

  async function release(invoiceId?: string): Promise<void> {
    if (invoiceId) {
      await pool.query('DELETE FROM invoice_backup_pending WHERE invoice_id = $1', [invoiceId]);
    } else {
      await pool.query('DELETE FROM invoice_backup_pending');
    }
  }

  async function mark(invoiceId: string): Promise<void> {
    await pool.query('INSERT INTO invoice_backup_pending (invoice_id) VALUES ($1)', [invoiceId]);
  }

  /**
   * A fresh project in `rechnung_faellig`, the only state issuance
   * accepts, whose customer carries the full address issuance requires.
   */
  async function invoiceableProjectId(): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `SELECT p.id FROM projects p
       JOIN customers c ON c.id = p.customer_id
       WHERE p.deleted = false
         AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.project_id = p.id)
         AND COALESCE(c.address->>'street', '') <> ''
         AND COALESCE(c.address->>'zip', '') <> ''
         AND COALESCE(c.address->>'city', '') <> ''
       ORDER BY p.id LIMIT 1`,
    );
    const id = r.rows[0]?.id;
    if (!id) throw new Error('seed has no project without invoices');
    await pool.query(`UPDATE projects SET status = 'rechnung_faellig' WHERE id = $1`, [id]);
    return id;
  }

  async function createDraft(projectId: string): Promise<string> {
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
    return res.json().id as string;
  }

  async function issue(invoiceId: string) {
    return authPost(ownerToken, `/api/invoices/${invoiceId}/issue`);
  }

  async function getInvoice(invoiceId: string): Promise<InvoiceWire> {
    const res = await authGet(ownerToken, `/api/invoices/${invoiceId}`);
    expect(res.statusCode).toBe(200);
    return res.json() as InvoiceWire;
  }

  beforeAll(async () => {
    for (const [key, value] of Object.entries(BACKUP_FEATURE_ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    savedEnv.AGE_RECIPIENT = process.env.AGE_RECIPIENT;
    // Any well-formed public recipient; the gate never encrypts with it.
    process.env.AGE_RECIPIENT = process.env.BINARY_AGE_RECIPIENT;

    await startApp();
    ({ db, pool } = createDatabase());
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    const profile = await authPut(ownerToken, '/api/company-profile', {
      companyName: 'Test Maler GmbH',
      address: { street: 'Werkstr. 1', zip: '10115', city: 'Berlin' },
      taxId: '111/222/33333',
      ustId: 'DE123456789',
      defaultTaxMode: 'standard',
    });
    expect([200, 204]).toContain(profile.statusCode);
  });

  afterAll(async () => {
    await pool?.end();
    await stopApp();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // -------------------------------------------------------------------
  // AC-374 — marking.
  // -------------------------------------------------------------------
  describe('AC-374: issuance and cancellation mark the new row', () => {
    it('marks the issued row, in the issue response and on read; the draft was never pending', async () => {
      const draftId = await createDraft(await invoiceableProjectId());
      expect((await getInvoice(draftId)).backupPending).toBe(false);

      const res = await issue(draftId);
      expect(res.statusCode).toBe(200);
      expect((res.json() as InvoiceWire).backupPending).toBe(true);
      expect((await getInvoice(draftId)).backupPending).toBe(true);
      expect(await markedIds()).toContain(draftId);
    });

    it("marks the Storno on cancellation and leaves the original's mark standing", async () => {
      const originalId = await createDraft(await invoiceableProjectId());
      expect((await issue(originalId)).statusCode).toBe(200);

      // Cancel while the original is still pending: a cancellation that
      // dropped the original's mark would let its un-backed-up PDF out.
      const res = await authPost(ownerToken, `/api/invoices/${originalId}/cancel`, {
        reason: 'Falscher Betrag',
      });
      expect(res.statusCode).toBe(200);
      const { original, storno } = res.json() as { original: InvoiceWire; storno: InvoiceWire };
      expect(storno.backupPending).toBe(true);
      expect(original.backupPending).toBe(true);
      expect(await markedIds()).toEqual(expect.arrayContaining([originalId, storno.id]));

      // And from a released original: the Storno is marked, the
      // original stays released.
      const secondId = await createDraft(await invoiceableProjectId());
      expect((await issue(secondId)).statusCode).toBe(200);
      await release(secondId);
      const second = await authPost(ownerToken, `/api/invoices/${secondId}/cancel`, {
        reason: 'Falscher Betrag',
      });
      expect(second.statusCode).toBe(200);
      const pair = second.json() as { original: InvoiceWire; storno: InvoiceWire };
      expect(pair.storno.backupPending).toBe(true);
      expect(pair.original.backupPending).toBe(false);
      expect(await markedIds()).not.toContain(secondId);
    });

    /** Run `body` with a temporary trigger; always dropped afterwards. */
    async function withTrigger(
      name: string,
      ddl: string,
      table: string,
      body: () => Promise<void>,
    ): Promise<void> {
      try {
        await pool.query(`
          CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION '${name}: refused (test simulation)'; END $$`);
        await pool.query(ddl);
        await body();
      } finally {
        await pool.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
        await pool.query(`DROP FUNCTION IF EXISTS ${name}()`);
      }
    }

    it('leaves no mark when the issuance fails at commit', async () => {
      const draftId = await createDraft(await invoiceableProjectId());
      // A deferred constraint trigger fires at COMMIT, after every step
      // of the issuance — whatever their order. A mark written inside
      // the transaction rolls back with it; one written by a separate,
      // earlier transaction would survive. (Marking after commit is
      // caught by the next arm.)
      await withTrigger(
        'gate_test_fail_commit',
        `CREATE CONSTRAINT TRIGGER gate_test_fail_commit AFTER UPDATE ON invoices
         DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
         WHEN (NEW.id = '${draftId}') EXECUTE FUNCTION gate_test_fail_commit()`,
        'invoices',
        async () => {
          const res = await issue(draftId);
          expect(res.statusCode).toBeGreaterThanOrEqual(500);
        },
      );

      expect((await getInvoice(draftId)).status).toBe('draft');
      expect(await markedIds()).not.toContain(draftId);
    });

    it('rolls the issuance back when the mark cannot be written — the mark is part of the transaction', async () => {
      const projectId = await invoiceableProjectId();
      const draftId = await createDraft(projectId);
      // A mark written after commit would fail here with the invoice
      // already issued; written inside, its failure undoes the issuance.
      await withTrigger(
        'gate_test_fail_mark',
        `CREATE TRIGGER gate_test_fail_mark BEFORE INSERT ON invoice_backup_pending
         FOR EACH ROW EXECUTE FUNCTION gate_test_fail_mark()`,
        'invoice_backup_pending',
        async () => {
          const res = await issue(draftId);
          expect(res.statusCode).toBeGreaterThanOrEqual(500);
        },
      );

      expect((await getInvoice(draftId)).status).toBe('draft');
      const project = await pool.query<{ status: string }>(
        'SELECT status FROM projects WHERE id = $1',
        [projectId],
      );
      expect(project.rows[0]!.status).toBe('rechnung_faellig');
    });

    it('an application start drops every standing mark only when the backup feature is disabled', async () => {
      const issued = await pool.query<{ id: string }>(
        "SELECT id FROM invoices WHERE status <> 'draft' ORDER BY id LIMIT 1",
      );
      await release();
      await mark(issued.rows[0]!.id);

      await applyInvoiceBackupGateAtBoot(db, getEnv());
      expect(await markedIds()).toEqual([issued.rows[0]!.id]);

      await applyInvoiceBackupGateAtBoot(db, { ...getEnv(), R2_ACCESS_KEY_ID: undefined });
      expect(await markedIds()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------
  // AC-375 — withholding.
  // -------------------------------------------------------------------
  describe('AC-375: a backup-pending PDF does not leave the server', () => {
    let pendingId: string;
    let releasedId: string;

    beforeAll(async () => {
      const r = await pool.query<{ id: string }>(
        "SELECT id FROM invoices WHERE status <> 'draft' ORDER BY id LIMIT 2",
      );
      [pendingId, releasedId] = r.rows.map((row) => row.id) as [string, string];
      await release();
      await mark(pendingId);
    });

    function expectWithheld(res: Awaited<ReturnType<typeof authGet>>) {
      expect(res.statusCode).toBe(409);
      const body = res.json() as { code: string; details?: { invoiceId?: string } };
      expect(body.code).toBe('INVOICE_BACKUP_PENDING');
      expect(body.details?.invoiceId).toBe(pendingId);
      // No PDF bytes, and no URL / key material a client could fetch
      // them with (api.md "PDF download contract" allows either shape).
      expect(String(res.headers['content-type'])).toContain('application/json');
      expect(res.body).not.toContain('%PDF');
      for (const key of Object.keys(body)) {
        expect(['code', 'message', 'details']).toContain(key);
      }
      expect(Object.keys(body.details ?? {})).toEqual(['invoiceId']);
    }

    it('rejects the PDF download', async () => {
      expectWithheld(await authGet(ownerToken, `/api/invoices/${pendingId}/pdf`));
    });

    it('rejects an ids-mode export that contains it', async () => {
      expectWithheld(
        await authPost(ownerToken, '/api/invoices/export', { ids: [releasedId, pendingId] }),
      );
    });

    it('rejects a filter-mode export whose filter covers it', async () => {
      expectWithheld(await authPost(ownerToken, '/api/invoices/export', { filter: {} }));
    });

    it('serves the download and both export modes once the mark is released', async () => {
      await release(pendingId);

      const pdf = await authGet(ownerToken, `/api/invoices/${pendingId}/pdf`);
      expect(pdf.statusCode).toBe(200);
      expect(String(pdf.headers['content-type'])).toContain('application/pdf');

      const byIds = await authPost(ownerToken, '/api/invoices/export', {
        ids: [releasedId, pendingId],
      });
      expect(byIds.statusCode).toBe(200);

      // Earlier arms may have left marks on rows they issued; the filter
      // covers every row, so clear them all.
      await release();
      const byFilter = await authPost(ownerToken, '/api/invoices/export', { filter: {} });
      expect(byFilter.statusCode).toBe(200);
    });
  });

  // -------------------------------------------------------------------
  // AC-374 — business-data import. Last on purpose: the override wipe
  // replaces the users, so every token above stops working.
  // -------------------------------------------------------------------
  describe('AC-374: an override business-data import leaves no mark', () => {
    it('drops the marks standing on the target and writes none for the imported invoices', async () => {
      const issued = await pool.query<{ id: string }>(
        "SELECT id FROM invoices WHERE status <> 'draft' ORDER BY id LIMIT 1",
      );
      const markedId = issued.rows[0]!.id;
      await release();
      await mark(markedId);

      // An envelope of the target itself: it carries the marked invoice,
      // so the issued-invoice guard (AC-367) lets the override through.
      const envelope = await exportEnvelope();
      await importEnvelope(envelope, {
        dryRun: false,
        override: true,
        confirmationPhrase: EXPECTED_RESTORE_PHRASE,
      });

      const restored = await pool.query('SELECT 1 FROM invoices WHERE id = $1', [markedId]);
      expect(restored.rowCount).toBe(1);
      expect(await markedIds()).toEqual([]);
    });
  });
});
