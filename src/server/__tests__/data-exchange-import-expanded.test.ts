/**
 * API integration tests — Layer 1 import for the expanded envelope, issue
 * #230.
 *
 * Sibling to `data-exchange-export-envelope.test.ts` (which pins the
 * export side of #230). Coverage here focuses on what the ImportService
 * does that's new:
 *   - Empty-target import accepts users / company_profile / invoices /
 *     invoice_sequence and the `summary` reports the counts.
 *   - Override import wipes + replaces; `sessionInvalidated: true` flips
 *     on; `sessions` rows are gone post-TRUNCATE (CASCADE on users).
 *   - Invoice two-pass: a Storno → original chain restores cleanly in
 *     either input ordering (the importer slices, so the exporter's
 *     `(cancellation_of NULLS FIRST, id)` order is *not* trusted).
 *   - MISSING_USER_REFS strict semantic: refs resolve ONLY against
 *     envelope.users (target.users is wiped or empty at insert time);
 *     a ref absent from envelope.users surfaces the error.
 *   - Per-entity-type audit rows emitted on commit (one per non-empty
 *     entity-typed slot) with the documented shape.
 *   - SCHEMA_VERSION = 3 is a hard cut — a v2-stamped envelope rejects.
 *
 * Test fixtures are built in-test rather than via the seed or a full
 * `ExportService` export so the cases can vary independently. The roundtrip AT-77
 * analog uses the seed + export but skips fields that legitimately change
 * between two snapshots (`exported_at`).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'path';
import { fileURLToPath } from 'url';
import type pg from 'pg';

import { startApp, stopApp } from '../../test/api-helpers.js';
import { exportEnvelope, importEnvelope } from '../../test/data-exchange-helpers.js';
import { EXPECTED_RESTORE_PHRASE } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import { seed } from '../seed.js';
import {
  auditLog,
  companyProfile,
  invoices,
  invoiceSequence,
  sessions,
  users,
} from '../db/schema.js';
import { SCHEMA_VERSION } from '../../domain/dataExchange.js';
import type { Database } from '../db/connection.js';
import type { Envelope, ImportOptions } from '../../domain/dataExchange.js';
import { AppError } from '../errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

const UUID_ZERO = '00000000-0000-0000-0000-000000000000';

/**
 * Deterministic UUID factory. The first 8 hex come from a hex-encoded
 * prefix so `cust` / `proj` / `usr_` etc. are usable in fixture code
 * without producing invalid PG uuid syntax. Hex chars only in the
 * prefix are passed through directly so the resulting UUIDs are
 * pleasant to inspect (matches the legacy helper in data-exchange.test.ts).
 */
function uuid(prefix: string, i: number): string {
  const hex = Array.from(prefix)
    .map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .padEnd(8, '0')
    .slice(0, 8);
  const n = String(i).padStart(12, '0');
  return `${hex}-0000-4000-8000-${n}`;
}

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Drive an import expected to fail and return the thrown `AppError`. The
 * service throws (carrying `.code` / `.statusCode` / `.details`) rather
 * than returning an HTTP envelope, so failure cases inspect the error
 * directly. ImportService ignores any `attachments` key on the envelope
 * (it never restores attachment rows — AC-253), so fixtures pass the full
 * `Envelope` as-is; no payload massaging is needed.
 */
async function expectImportRejection(env: Envelope, opts: ImportOptions): Promise<AppError> {
  try {
    await importEnvelope(env, opts);
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected importEnvelope to reject, but it resolved');
}

/**
 * Build a full v3 envelope from scratch. Every slot is populated with
 * deterministic fixture data so the tests don't depend on the seed
 * having particular content.
 *
 * - `users` carries 2 rows (an owner and a worker); the worker's id is
 *   referenced from a `project_workers` row so the MISSING_USER_REFS
 *   reframe is exercised on the happy path.
 * - `company_profile` is exactly one row (singleton).
 * - `customers` / `projects` reference each other.
 * - `invoices` carries one issued original + one Storno referencing it.
 * - `invoice_sequence` carries the matching counter for the issued
 *   year.
 */
function buildExpandedEnvelope(): Envelope {
  const ownerUserId = uuid('usr', 1);
  const workerUserId = uuid('usr', 2);
  const cpId = uuid('cp', 1);
  const customerId = uuid('cust', 1);
  const projectId = uuid('proj', 1);
  const originalInvoiceId = uuid('inv', 1);
  const stornoInvoiceId = uuid('inv', 2);

  return {
    schema_version: SCHEMA_VERSION,
    exported_at: isoNow(),
    users: [
      {
        id: ownerUserId,
        username: 'imp-owner',
        displayName: 'Import Owner',
        // Pre-hashed dummy bytes — the import preserves them verbatim
        // (issue #230 threat-model note) without re-hashing.
        passwordHash: '$2b$10$DummyHashForFixture000000000000000000000000000000aa',
        roles: ['owner'],
        email: 'imp-owner@example.de',
        active: true,
        themePreference: 'system',
        pushMuted: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        lastLoginAt: null,
        createdBy: null,
        updatedBy: null,
      },
      {
        id: workerUserId,
        username: 'imp-worker',
        displayName: 'Import Worker',
        passwordHash: '$2b$10$DummyHashForFixture000000000000000000000000000000bb',
        roles: ['worker'],
        email: null,
        active: true,
        themePreference: 'light',
        pushMuted: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: null,
        createdBy: null,
        updatedBy: null,
      },
    ],
    company_profile: [
      {
        id: cpId,
        companyName: 'Import Maler GmbH',
        address: { street: 'Importstr. 1', zip: '10115', city: 'Berlin' },
        taxId: '111/222/33333',
        ustId: 'DE123456789',
        iban: 'DE12 1000 0000 1234 5678 90',
        accentColor: null,
        footerText: null,
        logoBinaryDescriptorId: null,
        defaultTaxMode: 'standard',
        updatedAt: '2026-01-03T00:00:00.000Z',
        updatedBy: ownerUserId,
      },
    ],
    customers: [
      {
        id: customerId,
        name: 'Import Kunde',
        phone: null,
        email: null,
        address: { street: 'Kundenstr. 5', zip: '20095', city: 'Hamburg' },
        ustId: null,
        notes: null,
        createdAt: '2026-01-05T00:00:00.000Z',
        updatedAt: '2026-01-05T00:00:00.000Z',
        createdBy: ownerUserId,
        updatedBy: ownerUserId,
      },
    ],
    projects: [
      {
        id: projectId,
        number: '2026-IMP-1',
        title: 'Import Projekt',
        status: 'anfrage',
        statusChangedAt: '2026-01-10T00:00:00.000Z',
        customerId,
        siteAddress: null,
        plannedStart: null,
        plannedEnd: null,
        estimatedValue: null,
        notes: null,
        deleted: false,
        createdAt: '2026-01-10T00:00:00.000Z',
        updatedAt: '2026-01-10T00:00:00.000Z',
        createdBy: ownerUserId,
        updatedBy: ownerUserId,
      },
    ],
    project_workers: [
      // userId references envelope.users[workerUserId] — the reframe's
      // happy-path resolution.
      { projectId, userId: workerUserId },
    ],
    invoices: [
      {
        id: originalInvoiceId,
        projectId,
        status: 'issued',
        number: 'RE-2026-0001',
        issueDate: '2026-01-15',
        performanceDate: '2026-01-14',
        taxMode: 'standard',
        profile: 'zugferd-en16931',
        issuer: {
          companyName: 'Import Maler GmbH',
          address: { street: 'Importstr. 1', zip: '10115', city: 'Berlin' },
          taxId: '111/222/33333',
          ustId: 'DE123456789',
          iban: 'DE12 1000 0000 1234 5678 90',
          footerText: null,
        },
        recipient: {
          name: 'Import Kunde',
          address: { street: 'Kundenstr. 5', zip: '20095', city: 'Hamburg' },
          ustId: null,
        },
        lines: [
          {
            description: 'Wandfläche',
            quantity: 10,
            unit: 'm2',
            unitPrice: 25,
            lineTotal: 250,
            taxRate: 19,
          },
        ],
        totals: {
          perRate: [{ taxRate: 19, netSubtotal: 250, taxAmount: 47.5 }],
          netGrandTotal: 250,
          taxGrandTotal: 47.5,
          grossGrandTotal: 297.5,
        },
        cancellationOf: null,
        cancellationReason: null,
        renderedPdfBinaryDescriptorId: null,
        createdAt: '2026-01-15T00:00:00.000Z',
        updatedAt: '2026-01-15T00:00:00.000Z',
        createdBy: ownerUserId,
        updatedBy: ownerUserId,
      },
      {
        id: stornoInvoiceId,
        projectId,
        status: 'cancelled',
        number: 'ST-2026-0001',
        issueDate: '2026-01-20',
        performanceDate: '2026-01-14',
        taxMode: 'standard',
        profile: 'zugferd-en16931',
        issuer: {
          companyName: 'Import Maler GmbH',
          address: { street: 'Importstr. 1', zip: '10115', city: 'Berlin' },
          taxId: '111/222/33333',
          ustId: 'DE123456789',
          iban: 'DE12 1000 0000 1234 5678 90',
          footerText: null,
        },
        recipient: {
          name: 'Import Kunde',
          address: { street: 'Kundenstr. 5', zip: '20095', city: 'Hamburg' },
          ustId: null,
        },
        lines: [
          {
            description: 'Wandfläche',
            quantity: -10,
            unit: 'm2',
            unitPrice: 25,
            lineTotal: -250,
            taxRate: 19,
          },
        ],
        totals: {
          perRate: [{ taxRate: 19, netSubtotal: -250, taxAmount: -47.5 }],
          netGrandTotal: -250,
          taxGrandTotal: -47.5,
          grossGrandTotal: -297.5,
        },
        cancellationOf: originalInvoiceId,
        cancellationReason: 'Tippfehler korrigiert',
        renderedPdfBinaryDescriptorId: null,
        createdAt: '2026-01-20T00:00:00.000Z',
        updatedAt: '2026-01-20T00:00:00.000Z',
        createdBy: ownerUserId,
        updatedBy: ownerUserId,
      },
    ],
    invoice_sequence: [
      { year: 2026, kind: 'invoice', nextValue: 2, updatedAt: '2026-01-15T00:00:00.000Z' },
      { year: 2026, kind: 'storno', nextValue: 2, updatedAt: '2026-01-20T00:00:00.000Z' },
    ],
    attachments: [],
  };
}

let db: Database;
let pool: pg.Pool;

/**
 * Truncate every importable table EXCEPT `users` and `sessions`. The
 * empty-target tests need customers/projects/invoices/etc. wiped so
 * the import lands into emptiness, but they still need to authenticate
 * as the seeded owner to make the POST call — so user/session state
 * must survive the wipe. company_profile is also wiped because the
 * test imports its own singleton row; on re-seed (`reseed()`) the
 * singleton is re-pinned via seed.ts.
 */
async function wipeBusinessDataExceptUsers(): Promise<void> {
  // CASCADE handles dependency order. We also wipe company_profile
  // explicitly because it has no FK back to the rest of the wipe set.
  await db.execute(
    sql`TRUNCATE TABLE
      attachments,
      invoices,
      invoice_sequence,
      project_workers,
      projects,
      customers,
      company_profile
    RESTART IDENTITY CASCADE`,
  );
}

/**
 * Re-seed the database. Because `seed(..., { force: true })` TRUNCATEs the
 * sessions table, every previously-issued session token becomes invalid.
 * Callers MUST refresh any tokens they hold.
 */
async function reseed(): Promise<void> {
  await seed(db, { force: true });
}

describe('ImportService — Layer 1 envelope v3 (issue #230)', () => {
  beforeAll(async () => {
    await startApp();
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    await pool.query('SELECT 1');
    await migrate(db, { migrationsFolder });
  });

  afterAll(async () => {
    if (pool) await pool.end();
    await stopApp();
  });

  // -------------------------------------------------------------------
  // Empty-target import + summary counts. Wipes the DB completely, then
  // POSTs a v3 envelope with every slot populated; the response carries
  // counts matching the envelope; the new tables contain the rows.
  // -------------------------------------------------------------------
  describe('empty-target import accepts the expanded envelope', () => {
    it('imports users / company_profile / invoices / invoice_sequence and reports summary counts', async () => {
      await wipeBusinessDataExceptUsers();
      try {
        const env = buildExpandedEnvelope();
        const body = (await importEnvelope(env, {
          dryRun: false,
          override: false,
          confirmationPhrase: null,
        })) as {
          schema_version: number;
          summary: Record<string, number>;
          sessionInvalidated: boolean;
        };
        expect(body.schema_version).toBe(SCHEMA_VERSION);
        expect(body.summary.users).toBe(env.users.length);
        expect(body.summary.company_profile).toBe(env.company_profile.length);
        expect(body.summary.customers).toBe(env.customers.length);
        expect(body.summary.projects).toBe(env.projects.length);
        expect(body.summary.project_workers).toBe(env.project_workers.length);
        expect(body.summary.invoices).toBe(env.invoices.length);
        expect(body.summary.invoice_sequence).toBe(env.invoice_sequence.length);
        // Empty-target path: no wipe ran, sessions untouched.
        expect(body.sessionInvalidated).toBe(false);

        // Direct-DB cross-check: the expected rows landed alongside the
        // seeded users that survived the (selective) wipe.
        const dbUsers = await db.select().from(users).orderBy(asc(users.username));
        const usernames = dbUsers.map((u) => u.username);
        expect(usernames).toContain('imp-owner');
        expect(usernames).toContain('imp-worker');
        // Seeded users survive — `wipeBusinessDataExceptUsers` does not
        // touch the users table.
        expect(usernames).toContain('inhaber');

        const dbProfile = await db.select().from(companyProfile);
        expect(dbProfile.length).toBe(1);
        expect(dbProfile[0]!.companyName).toBe('Import Maler GmbH');

        const dbInvoices = await db.select().from(invoices).orderBy(asc(invoices.number));
        expect(dbInvoices.map((i) => i.number)).toEqual(['RE-2026-0001', 'ST-2026-0001']);

        const dbSeq = await db
          .select()
          .from(invoiceSequence)
          .orderBy(asc(invoiceSequence.year), asc(invoiceSequence.kind));
        expect(dbSeq.length).toBe(2);
        expect(dbSeq[0]!.nextValue).toBe(2);
      } finally {
        await reseed();
      }
    });
  });

  // -------------------------------------------------------------------
  // Override wipe-and-replace + session invalidation flag. With a seeded
  // (non-empty) target, an override commit wipes users / company /
  // invoices / etc.; sessions cascade via the FK; sessionInvalidated is
  // true in the response; the sessions table is empty post-call.
  // -------------------------------------------------------------------
  describe('override wipe-and-replace sets sessionInvalidated and wipes sessions', () => {
    it('returns sessionInvalidated: true and clears sessions table post-call', async () => {
      // Seed a session row so the wipe has something to CASCADE-delete.
      // The text-leg relied on the operator's own login session; the
      // service is now driven directly, so plant a session on a seeded
      // user. The override TRUNCATEs users and the session row cascades
      // with it (sessions.user_id ON DELETE CASCADE). Without this the
      // post-call empty-check would be vacuous.
      const [seededUser] = await db.select({ id: users.id }).from(users).limit(1);
      await db.insert(sessions).values({
        userId: seededUser!.id,
        token: 'import-expanded-session-fixture',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      const sessionsBefore = await db.select().from(sessions);
      expect(sessionsBefore.length).toBeGreaterThan(0);

      try {
        const env = buildExpandedEnvelope();
        const result = (await importEnvelope(env, {
          dryRun: false,
          override: true,
          confirmationPhrase: EXPECTED_RESTORE_PHRASE,
        })) as {
          sessionInvalidated: boolean;
          summary: { users: number };
        };
        expect(result.sessionInvalidated).toBe(true);
        expect(result.summary.users).toBe(env.users.length);

        // Sessions cascade-deleted with users.
        const sessionsAfter = await db.select().from(sessions);
        expect(sessionsAfter.length).toBe(0);

        // Users replaced: the seeded usernames (inhaber, buero, ...) are
        // gone; the envelope's usernames are present.
        const dbUsers = await db.select().from(users).orderBy(asc(users.username));
        expect(dbUsers.map((u) => u.username).sort()).toEqual(['imp-owner', 'imp-worker'].sort());
      } finally {
        await reseed();
      }
    });
  });

  // -------------------------------------------------------------------
  // Invoice two-pass self-FK. The envelope arrives ordered by the
  // exporter `(cancellation_of NULLS FIRST, id)` but the importer
  // re-slices on its own. Test both: (a) the documented order, and
  // (b) a hand-reordered envelope where the Storno comes first.
  // Both must restore without FK error.
  // -------------------------------------------------------------------
  describe('invoice two-pass insert is robust to input ordering', () => {
    it('imports originals → Stornos when the envelope is in documented order', async () => {
      await wipeBusinessDataExceptUsers();
      try {
        const env = buildExpandedEnvelope();
        // env.invoices already arrives in originals-first order.
        await importEnvelope(env, { dryRun: false, override: false, confirmationPhrase: null });

        const dbInvoices = await db.select().from(invoices).orderBy(asc(invoices.number));
        expect(dbInvoices.length).toBe(2);
        const storno = dbInvoices.find((i) => i.number === 'ST-2026-0001');
        expect(storno).toBeDefined();
        expect(storno!.cancellationOf).toBe(
          dbInvoices.find((i) => i.number === 'RE-2026-0001')!.id,
        );
      } finally {
        await reseed();
      }
    });

    it('imports without FK violation when the envelope has the Storno before its original', async () => {
      await wipeBusinessDataExceptUsers();
      try {
        const env = buildExpandedEnvelope();
        // Reverse so the Storno comes first — a hand-edited envelope.
        env.invoices = [...env.invoices].reverse();
        await importEnvelope(env, { dryRun: false, override: false, confirmationPhrase: null });

        const dbInvoices = await db.select().from(invoices).orderBy(asc(invoices.number));
        expect(dbInvoices.length).toBe(2);
        const storno = dbInvoices.find((i) => i.number === 'ST-2026-0001');
        expect(storno!.cancellationOf).toBe(
          dbInvoices.find((i) => i.number === 'RE-2026-0001')!.id,
        );
      } finally {
        await reseed();
      }
    });

    it('rejects a Storno-of-Storno chain as VALIDATION_ERROR (envelope-level guard)', async () => {
      // A Storno whose `cancellationOf` targets another Storno would
      // FK-violate the importer's two-pass insert under arbitrary
      // envelope ordering. Real issuance never produces chains (a
      // Storno is terminal), so the envelope-level validator rejects
      // the chain instead of complicating the two-pass insert. The
      // schema CHECK does NOT block this — it only requires
      // `cancellationOf IS NOT NULL ↔ number LIKE 'ST-%'`.
      await wipeBusinessDataExceptUsers();
      try {
        const env = buildExpandedEnvelope();
        const original = env.invoices[0]!;
        const firstStorno = env.invoices[1]!;
        // Build a third invoice — a Storno of the first Storno.
        const secondStornoId = uuid('inv3', 3);
        env.invoices = [
          original,
          firstStorno,
          {
            ...firstStorno,
            id: secondStornoId,
            number: 'ST-2026-0002',
            issueDate: '2026-01-25',
            cancellationOf: firstStorno.id,
            cancellationReason: 'Chain test',
          },
        ];
        env.invoice_sequence = env.invoice_sequence.map((s) =>
          s.kind === 'storno' ? { ...s, nextValue: 3 } : s,
        );

        const err = await expectImportRejection(env, {
          dryRun: false,
          override: false,
          confirmationPhrase: null,
        });
        expect(err.statusCode).toBe(422);
        expect(err.code).toBe('VALIDATION_ERROR');
        // The details payload should name the offending path so an
        // operator inspecting the rejection can find the chain.
        expect(JSON.stringify(err.details)).toMatch(/cancellationOf/);
        expect(JSON.stringify(err.details)).toMatch(/chain|Storno/);

        // No partial state: the original invoices count is 0 (we wiped
        // before the test) and the rejected envelope didn't insert
        // anything.
        const dbInvoices = await db.select().from(invoices);
        expect(dbInvoices.length).toBe(0);
      } finally {
        await reseed();
      }
    });
  });

  // -------------------------------------------------------------------
  // MISSING_USER_REFS strict semantic. Refs resolve only against
  // `envelope.users` — the target's `users` table is wiped (override) or
  // empty (fresh) at insert time, so a ref absent from the envelope
  // signals a hand-edited or partial source.
  // -------------------------------------------------------------------
  describe('MISSING_USER_REFS strict semantic — refs resolve ONLY against envelope.users', () => {
    it('succeeds when project_workers.userId is in envelope.users', async () => {
      await wipeBusinessDataExceptUsers();
      try {
        const env = buildExpandedEnvelope();
        // Sanity: the worker is in envelope.users.
        const workerId = env.project_workers[0]!.userId;
        expect(env.users.some((u) => u.id === workerId)).toBe(true);

        await importEnvelope(env, { dryRun: false, override: false, confirmationPhrase: null });
      } finally {
        await reseed();
      }
    });

    it('raises 422 MISSING_USER_REFS when a project_workers.userId is absent from envelope.users', async () => {
      await wipeBusinessDataExceptUsers();
      try {
        const env = buildExpandedEnvelope();
        // Replace the worker's userId with UUID_ZERO — not in
        // envelope.users (the envelope's two users have prefix-derived
        // UUIDs). Target.users is irrelevant under the strict-envelope
        // semantic — the envelope is the sole authoritative source.
        env.project_workers[0]!.userId = UUID_ZERO;

        const err = await expectImportRejection(env, {
          dryRun: false,
          override: false,
          confirmationPhrase: null,
        });
        expect(err.statusCode).toBe(422);
        expect(err.code).toBe('MISSING_USER_REFS');
        expect((err.details as { missingUserIds?: string[] }).missingUserIds).toContain(UUID_ZERO);
      } finally {
        await reseed();
      }
    });

    it('raises 422 MISSING_USER_REFS even when the ref happens to match a seeded target.users row', async () => {
      // Pins the strict semantic: the target.users fallback no longer
      // applies. We strip envelope.users entirely and reuse a seeded
      // user id (the seeded `inhaber` survives `wipeBusinessDataExceptUsers`),
      // confirming that the importer does NOT consult target.users.
      await wipeBusinessDataExceptUsers();
      try {
        const seededInhaber = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.username, 'inhaber'));
        const seededId = seededInhaber[0]!.id;

        const env = buildExpandedEnvelope();
        // Drop envelope.users so the ref CAN ONLY be resolved against
        // target.users — under the strict semantic that path is dead.
        // Also clear createdBy/updatedBy on the rows that pointed at
        // envelope.users so the only remaining ref is the assignment.
        env.users = [];
        env.customers[0]!.createdBy = null;
        env.customers[0]!.updatedBy = null;
        env.projects[0]!.createdBy = null;
        env.projects[0]!.updatedBy = null;
        env.invoices[0]!.createdBy = null;
        env.invoices[0]!.updatedBy = null;
        env.invoices[1]!.createdBy = null;
        env.invoices[1]!.updatedBy = null;
        env.company_profile[0]!.updatedBy = null;
        env.project_workers[0]!.userId = seededId;

        const err = await expectImportRejection(env, {
          dryRun: false,
          override: false,
          confirmationPhrase: null,
        });
        expect(err.statusCode).toBe(422);
        expect(err.code).toBe('MISSING_USER_REFS');
        expect((err.details as { missingUserIds?: string[] }).missingUserIds).toContain(seededId);
      } finally {
        await reseed();
      }
    });
  });

  // -------------------------------------------------------------------
  // Single-row import audit. On a successful commit one audit row lands
  // with `entity_type='data_import'`, `actor_kind='system'`,
  // `actor_reason='data_import'`, `action='import_restored'`,
  // `entity_id=<synthetic batch UUID>`, `entity_label='Import: <N>
  // Datensätze'`, and `payload.counts` carrying the per-slot row counts
  // (every slot key, zero where empty).
  //
  // Rationale: a business-data import is a deployment-level event, not an
  // event attributed to a single user / customer / etc. Per-slot audit
  // rows misattributed entries in the activity feed; one row per
  // import + the full counts breakdown in the payload preserves the
  // forensic detail without the misattribution.
  // -------------------------------------------------------------------
  describe('single-row import audit', () => {
    it('emits exactly one audit row per import with entity_type=data_import and the per-slot counts payload', async () => {
      await wipeBusinessDataExceptUsers();
      // Also clear pre-existing data_import audit rows from the seed
      // pass (`loadBusiness` runs through ImportService and emits its
      // own audit row). Without this, the assertion below picks up
      // both the seed's row AND the test's row.
      await db.execute(
        sql`DELETE FROM audit_log WHERE actor_kind = 'system' AND actor_reason = 'data_import'`,
      );
      try {
        const env = buildExpandedEnvelope();
        await importEnvelope(env, { dryRun: false, override: false, confirmationPhrase: null });

        const rows = await db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.actorKind, 'system'),
              eq(auditLog.actorReason, 'data_import'),
              eq(auditLog.action, 'import_restored'),
            ),
          );

        // Exactly one row.
        expect(rows.length).toBe(1);
        const row = rows[0]!;
        expect(row.entityType).toBe('data_import');
        expect(row.actorKind).toBe('system');
        expect(row.actorId).toBeNull();
        expect(row.actorReason).toBe('data_import');
        expect(row.action).toBe('import_restored');
        expect(row.ancestorEntityType).toBeNull();
        expect(row.ancestorEntityId).toBeNull();
        expect(row.correlationId).toBeNull();

        // `entityId` is a synthetic UUID (not a row pkey) — its only
        // contract is the UUID shape.
        expect(typeof row.entityId).toBe('string');
        expect(row.entityId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );

        // Payload carries the full per-slot counts breakdown — every
        // slot key, zero where empty. `attachments` is structurally
        // always 0 for the business-data import (AC-253) but the key is
        // present for shape uniformity.
        const expectedCounts = {
          users: env.users.length,
          company_profile: env.company_profile.length,
          customers: env.customers.length,
          projects: env.projects.length,
          project_workers: env.project_workers.length,
          invoices: env.invoices.length,
          invoice_sequence: env.invoice_sequence.length,
          attachments: 0,
        };
        expect(row.payload).toEqual({ counts: expectedCounts });

        // Total row count drives the German operator-facing label.
        const totalRecords = Object.values(expectedCounts).reduce((sum, n) => sum + n, 0);
        expect(row.entityLabel).toBe(`Import: ${totalRecords} Datensätze`);
      } finally {
        await reseed();
      }
    });
  });

  // -------------------------------------------------------------------
  // AC-253: the business-data import never inserts `attachments` rows.
  // The export envelope carries a metadata-only `attachments[]` slot,
  // but the import ignores it entirely — attachment rows + bytes are
  // restored only by the server-side import JOB (AC-328), never here.
  // (The former route-layer wire-reject of a body carrying an
  // `attachments` key went with the removed text-leg route; the
  // invariant is now "ignore the slot, insert nothing".) This locks it:
  // a future change that started reading `envelope.attachments` on the
  // restore path would land rows whose wrapped DEKs are unwrappable on
  // the importing instance — a silent-data-loss class.
  // -------------------------------------------------------------------
  describe('AC-253: import ignores a populated attachments slot', () => {
    it('inserts zero attachment rows and reports counts.attachments=0 even when the envelope carries descriptors', async () => {
      await wipeBusinessDataExceptUsers();
      await db.execute(
        sql`DELETE FROM audit_log WHERE actor_kind = 'system' AND actor_reason = 'data_import'`,
      );
      try {
        const env = buildExpandedEnvelope();
        // Populate the slot a real export would emit — two `ready`
        // descriptors referencing the envelope's own project + owner.
        env.attachments = [
          {
            id: '11111111-1111-4111-8111-111111111111',
            projectId: env.projects[0]!.id,
            status: 'ready',
            kind: 'photo',
            label: 'Baustelle',
            fileName: 'foto.webp',
            mimeType: 'image/webp',
            sizeBytes: 2048,
            createdAt: '2026-01-15T00:00:00.000Z',
            createdBy: env.users[0]!.id,
          },
          {
            id: '22222222-2222-4222-8222-222222222222',
            projectId: env.projects[0]!.id,
            status: 'ready',
            kind: 'binary',
            label: 'Angebot',
            fileName: 'angebot.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 4096,
            createdAt: '2026-01-16T00:00:00.000Z',
            createdBy: env.users[0]!.id,
          },
        ];

        await importEnvelope(env, { dryRun: false, override: false, confirmationPhrase: null });

        // The slot was ignored — no attachment rows landed.
        const count = await pool.query<{ c: string }>(
          'SELECT COUNT(*)::text AS c FROM attachments',
        );
        expect(count.rows[0]!.c).toBe('0');

        // The single import-audit row reports zero restored attachments.
        const rows = await db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.actorKind, 'system'),
              eq(auditLog.actorReason, 'data_import'),
              eq(auditLog.action, 'import_restored'),
            ),
          );
        expect(rows.length).toBe(1);
        expect((rows[0]!.payload as { counts: { attachments: number } }).counts.attachments).toBe(
          0,
        );
      } finally {
        await reseed();
      }
    });
  });

  // -------------------------------------------------------------------
  // SCHEMA_VERSION = 3 hard cut. A v2-stamped envelope rejects with
  // SCHEMA_VERSION_MISMATCH; no writes occur (the route layer does not
  // even reach the service for some shapes, but the version field is
  // structurally typed as a generic integer so the service catches it).
  // -------------------------------------------------------------------
  describe('SCHEMA_VERSION = 3 hard cut', () => {
    it('rejects a v2-stamped envelope with SCHEMA_VERSION_MISMATCH', async () => {
      await wipeBusinessDataExceptUsers();
      try {
        const env = buildExpandedEnvelope();
        // Stamp the prior version explicitly. The service is the gate
        // — the route's body schema accepts any integer.
        env.schema_version = 2;

        const err = await expectImportRejection(env, {
          dryRun: false,
          override: false,
          confirmationPhrase: null,
        });
        expect(err.statusCode).toBe(422);
        expect(err.code).toBe('SCHEMA_VERSION_MISMATCH');

        // No writes — customers/projects stay empty (the wipe ran in
        // setup). users intact (the wipe is selective).
        const dbCustomers = await db.execute<{ c: string }>(
          sql`SELECT count(*)::text AS c FROM customers`,
        );
        expect(Number(dbCustomers.rows[0]!.c)).toBe(0);
      } finally {
        await reseed();
      }
    });
  });

  // The "route body schema requires the new v3 slots" case (an envelope
  // missing the `users` key → 422 from Fastify ajv) tested the removed
  // text-leg route's body schema. ImportService has no equivalent
  // structural guard — a missing slot key surfaces as a type error, not a
  // clean VALIDATION_ERROR — so the case went with the route. The slot
  // *content* validation (schema version, user refs, Storno chains) is
  // covered by the service-level cases above.

  // -------------------------------------------------------------------
  // AT-77 analog roundtrip. Export the seeded dataset, wipe, override-
  // import the snapshot, re-export, compare. `exported_at` and
  // `users[*].lastLoginAt` legitimately drift between two snapshots; we
  // exclude them from the strict equality check.
  // -------------------------------------------------------------------
  describe('AT-77 analog — seed → export → wipe → import (override) → export', () => {
    it('preserves every slot byte-for-byte (modulo exported_at and lastLoginAt)', async () => {
      // First export — the seeded baseline.
      const e1 = await exportEnvelope();

      try {
        // Override-import the snapshot back into the (currently seeded)
        // database — the wipe + restore must reproduce every slot.
        // ImportService ignores the envelope's `attachments` slot (AC-253).
        await importEnvelope(e1, {
          dryRun: false,
          override: true,
          confirmationPhrase: EXPECTED_RESTORE_PHRASE,
        });

        // Second export.
        const e2 = await exportEnvelope();

        // Compare the slots, masking fields that legitimately drift.
        expect(e2.schema_version).toBe(e1.schema_version);

        // Users: skip lastLoginAt (the login above mutates it on one
        // user). Sort by id for deterministic comparison.
        const stripUser = (u: Envelope['users'][number]) => {
          const { lastLoginAt: _lastLoginAt, ...rest } = u;
          return rest;
        };
        expect(e2.users.map(stripUser)).toEqual(e1.users.map(stripUser));

        expect(e2.company_profile).toEqual(e1.company_profile);
        expect(e2.customers).toEqual(e1.customers);
        expect(e2.projects).toEqual(e1.projects);
        expect(e2.project_workers).toEqual(e1.project_workers);
        expect(e2.invoices).toEqual(e1.invoices);
        expect(e2.invoice_sequence).toEqual(e1.invoice_sequence);
      } finally {
        await reseed();
      }
    });
  });
});
