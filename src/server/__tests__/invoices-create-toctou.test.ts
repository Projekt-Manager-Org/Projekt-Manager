/**
 * API integration test — `createDraft` TOCTOU on the archived-project
 * check (security-audit finding M2 / AC-285).
 *
 * Current `InvoiceService.createDraft` reads the project row from
 * `this.db` BEFORE `mutate()` opens the audit transaction:
 *
 *   1. profileService.get()              — `this.db.select(...).from(companyProfile)`
 *   2. db.select(projects).where(id=…)   — TOCTOU read
 *   3. db.select(customers).where(...)
 *   4. mutate(this.db, …, run: tx => insertInvoiceDraft(tx, …))
 *
 * Between (2) and (4) the project state is observed without a row lock
 * and without the audit transaction's snapshot. A concurrent commit
 * that flips `projects.deleted = true` after (2) but before (4) slips
 * a draft onto an archived project — AC-285 promises 404 NOT_FOUND
 * for that case (mirrors AC-95 for draft writes).
 *
 * After Wave 3 the project lookup moves inside `mutate()`'s `run(tx)`
 * callback, sharing the audit transaction's READ COMMITTED snapshot
 * with the INSERT. Any archive committed before the tx starts is then
 * visible to the lookup and the insert is rejected.
 *
 * Test strategy — deterministic interleaving via a one-shot spy on
 * `db.transaction`:
 *   - Build the service against pool A.
 *   - Spy on `connA.db.transaction` to, on its FIRST call, archive
 *     the project via pool B (committing before the spy returns
 *     control to the real `transaction()`).
 *   - Call `service.createDraft(...)` directly.
 *
 * The spy fires AFTER the pre-transaction project read at (2) — by
 * construction `createDraft` reaches the `mutate()` call only after
 * reading the project. The archive thus lands in the window the AC
 * forbids.
 *
 * Pre-fix expectation: the insert succeeds, the test fails at the
 * `expect.toThrow(...)` / no-row assertion.
 * Post-fix expectation: the lookup runs inside the tx, sees
 * `deleted=true`, and throws `NOT_FOUND` — the test passes.
 *
 * Why direct service call instead of HTTP: the route's surface is
 * already covered by `invoices-routes.test.ts` (AC-285 happy + archived
 * cases). The race condition is a service-layer invariant; calling the
 * service directly with our own `db` handle gives us the connection-
 * level seam without dragging Fastify middleware into the test.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { startApp, stopApp, login, authPost } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase, type Database } from '../db/connection.js';
import { InvoiceService } from '../services/InvoiceService.js';
import { InvoiceIssueService } from '../services/InvoiceIssueService.js';
import { InvoiceCancelService } from '../services/InvoiceCancelService.js';
import { InvoiceBinaryService, type InvoiceBinaryDeps } from '../services/InvoiceBinaryService.js';
import { createStorageClient } from '../storage/client.js';
import { getEnv } from '../config/env.js';
import type { ServiceLogger } from '../services/Logger.js';

describe('AC-285 — createDraft TOCTOU: archived-project commit between lookup and insert is caught', () => {
  let ownerToken: string;
  let ownerId: string;
  let customerId: string;

  // Two independent pools on the same per-PID DB. Pool A backs the
  // `InvoiceService` under test; pool B drives the racing archive.
  let connA: { db: Database; pool: import('pg').Pool };
  let connB: { db: Database; pool: import('pg').Pool };

  /**
   * No-op logger — direct service calls don't go through Fastify so we
   * don't have `request.log`. Matches the sibling pattern in
   * `invoices-issue.test.ts` (S5 concurrent-race block).
   */
  const noopLog: ServiceLogger = {
    info: () => undefined,
    error: () => undefined,
  };

  /**
   * Inline replica of `InvoiceService.ts`'s private
   * `buildInvoiceBinaryDeps`. Mirrors the S5 block in
   * `invoices-issue.test.ts` — extending the production surface for a
   * test-only concern is the wrong direction; the env presence probe
   * has already run inside `startApp()`.
   */
  function buildServiceFor(db: Database): InvoiceService {
    const env = getEnv();
    const storage = createStorageClient({
      endpoint: env.STORAGE_ENDPOINT!,
      publicEndpoint: env.STORAGE_PUBLIC_ENDPOINT,
      bucket: env.STORAGE_BUCKET,
      accessKey: env.STORAGE_ACCESS_KEY!,
      secretKey: env.STORAGE_SECRET_KEY!,
      region: env.STORAGE_REGION,
    });
    const deps: InvoiceBinaryDeps = {
      storage,
      binaryAgeRecipient: env.BINARY_AGE_RECIPIENT!,
      binaryAgeIdentityPath: env.BINARY_AGE_IDENTITY_PATH!,
      invoiceObjectLockDays: env.INVOICE_OBJECT_LOCK_DAYS,
    };
    const binary = new InvoiceBinaryService(db, deps);
    const issue = new InvoiceIssueService(db, binary);
    const cancel = new InvoiceCancelService(db, binary);
    return new InvoiceService(db, issue, cancel, binary);
  }

  /**
   * Mint a fresh in_arbeit project. The TOCTOU window does not depend
   * on the project's status — `createDraft` only checks `deleted` — but
   * we use `in_arbeit` so the project is not in the `rechnung_faellig`
   * pool reserved for issue-path arms in sibling files.
   */
  async function mintInArbeitProject(): Promise<string> {
    const suffix = crypto.randomUUID().slice(0, 8);
    const res = await authPost(ownerToken, '/api/projects', {
      number: `TOCTOU-${suffix}`,
      title: `TOCTOU fixture ${suffix}`,
      customerId,
      status: 'in_arbeit',
    });
    if (res.statusCode !== 201) {
      throw new Error(`mintInArbeitProject failed ${res.statusCode} ${res.body}`);
    }
    return res.json().id as string;
  }

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);

    // Resolve ownerId + an arbitrary customerId from the seed — needed
    // for direct-service calls (the API helpers don't surface userId)
    // and for the mint helper (FK requirement). One lookup pool, closed
    // immediately.
    const lookup = createDatabase();
    try {
      const userRows = await lookup.db.execute(
        sql`SELECT id FROM users WHERE username = ${SEED_USERS.owner.username} LIMIT 1`,
      );
      if (userRows.rows.length === 0) throw new Error('seed missing owner user');
      ownerId = (userRows.rows[0] as { id: string }).id;

      const customerRows = await lookup.db.execute(sql`SELECT id FROM customers LIMIT 1`);
      if (customerRows.rows.length === 0) throw new Error('seed missing any customer');
      customerId = (customerRows.rows[0] as { id: string }).id;
    } finally {
      await lookup.pool.end();
    }

    connA = createDatabase();
    connB = createDatabase();
  });

  afterAll(async () => {
    if (connA) await connA.pool.end();
    if (connB) await connB.pool.end();
    await stopApp();
  });

  it('archive committed between pre-tx lookup and tx insert is caught — no draft row lands; service throws NOT_FOUND', async () => {
    const projectId = await mintInArbeitProject();
    const service = buildServiceFor(connA.db);

    // Monkey-patch `connA.db.transaction` directly (not via vi.spyOn —
    // Drizzle's NodePgDatabase carries `transaction` on the PgDatabase
    // prototype, so vi.spyOn on the instance is brittle across versions;
    // a plain property assignment shadows the prototype method
    // deterministically and we restore by deleting the own property).
    //
    // The replacement archives the project via pool B (auto-committed
    // on a pooled node-postgres client — no explicit BEGIN) and then
    // delegates to the real prototype method. By the time the
    // replacement fires, `createDraft` has already completed its
    // pre-tx project read (line 181 of InvoiceService.ts) — the
    // archive therefore lands in the AC-285-forbidden window.
    //
    // `interceptCount` proves the seam actually ran; without that
    // counter a regression that bypassed `db.transaction` (e.g. moved
    // the insert path off `mutate()`) would silently make the
    // "no-row" assertion vacuous.
    const realTx = connA.db.transaction.bind(connA.db);
    let interceptCount = 0;
    const originalDescriptor = Object.getOwnPropertyDescriptor(connA.db, 'transaction');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (connA.db as any).transaction = async function patchedTransaction(...args: any[]) {
      interceptCount += 1;
      // Archive on the first call only — subsequent transactions
      // inside the same createDraft invocation (post-fix retry,
      // unrelated audit dispatch …) must not re-archive.
      if (interceptCount === 1) {
        await connB.pool.query(`UPDATE projects SET deleted = true WHERE id = $1`, [projectId]);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realTx as any)(...args);
    };

    try {
      // The call must reject. Pre-fix: the pre-tx lookup observed
      // `deleted=false`, so the insert proceeds and `createDraft`
      // returns the new draft — the assertion below fails (RED).
      // Post-fix: the in-tx lookup observes `deleted=true` and throws
      // `notFound('project')` → 404 NOT_FOUND on the wire (GREEN).
      await expect(
        service.createDraft(
          {
            projectId,
            lines: [
              {
                description: 'TOCTOU race draft',
                quantity: 1,
                unit: 'pauschal',
                unitPrice: 100,
                lineTotal: 100,
                taxRate: 19,
              },
            ],
            performanceDate: '2026-04-10',
          },
          ownerId,
          noopLog,
          null,
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      // The interceptor must have run — otherwise we did not actually
      // interleave an archive into the window and the "no draft"
      // assertion below would be vacuous (the project would still be
      // unarchived).
      expect(interceptCount).toBeGreaterThanOrEqual(1);
    } finally {
      // Restore the prototype method by removing the own property.
      if (originalDescriptor) {
        Object.defineProperty(connA.db, 'transaction', originalDescriptor);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (connA.db as any).transaction;
      }
    }

    // No invoice row exists for the archived project — neither under
    // any status. Read via a fresh pool to bypass any per-connection
    // cache concerns; the SET-not-EXISTS shape pins the AC-285 promise
    // independently of the throw above.
    const { db, pool } = createDatabase();
    try {
      const r = await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM invoices WHERE project_id = ${projectId}`,
      );
      expect((r.rows[0] as { c: number }).c).toBe(0);
    } finally {
      await pool.end();
    }

    // And no audit row was committed for the failed call either —
    // AC-285 audit-row promise pairs to the SUCCESSFUL `mutate()` path
    // only; a rejection inside `run(tx)` rolls back both the domain
    // INSERT and the audit INSERT (mutate.ts AC-177 atomicity).
    const { db: db2, pool: pool2 } = createDatabase();
    try {
      const r = await db2.execute(
        sql`SELECT COUNT(*)::int AS c FROM audit_log WHERE entity_type = 'invoice' AND ancestor_entity_id = ${projectId}`,
      );
      expect((r.rows[0] as { c: number }).c).toBe(0);
    } finally {
      await pool2.end();
    }
  });
});
