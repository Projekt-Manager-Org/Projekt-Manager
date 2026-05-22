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
 * Test fixtures are built in-test rather than via the seed or
 * `/api/export` so the cases can vary independently. The roundtrip AT-77
 * analog uses the seed + export but skips fields that legitimately change
 * between two snapshots (`exported_at`).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'path';
import { fileURLToPath } from 'url';
import type pg from 'pg';

import { startApp, stopApp, login, authGet, authPost } from '../../test/api-helpers.js';
import {
  SEED_DEFAULT_PASSWORD,
  SEED_USERS,
  EXPECTED_RESTORE_PHRASE,
} from '../../test/seedAssumptions.js';
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
import type { Envelope } from '../../domain/dataExchange.js';

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
 * Cast an `Envelope` (strict shape) to the loose payload type
 * `authPost` accepts AND strip the `attachments` field. Issue #163 /
 * AC-253: `/api/import` rejects any body carrying an `attachments` key
 * (the route schema declares `attachments: { not: {} }`), even an empty
 * array — the orchestrator strips the field before POST and that's the
 * contract the route encodes. Tests mirror the orchestrator step.
 */
function asPayload(env: Envelope): Record<string, unknown> {
  const { attachments: _stripped, ...rest } = env;
  void _stripped;
  return rest as unknown as Record<string, unknown>;
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

describe('POST /api/import — Layer 1 envelope v3 (issue #230)', () => {
  let ownerToken: string;

  async function reseedAndRelogin(): Promise<void> {
    await reseed();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  }

  beforeAll(async () => {
    await startApp();
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    await pool.query('SELECT 1');
    await migrate(db, { migrationsFolder });

    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
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
        const res = await authPost(ownerToken, '/api/import', asPayload(env));
        expect(res.statusCode).toBe(200);

        const body = res.json() as {
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
        await reseedAndRelogin();
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
      // Verify the seeded state has at least one session row (the
      // owner's, established by the test's login). Without this baseline
      // the post-call empty-check would be vacuous.
      const sessionsBefore = await db.select().from(sessions);
      expect(sessionsBefore.length).toBeGreaterThan(0);

      try {
        const env = buildExpandedEnvelope();
        const body = { ...asPayload(env), confirmation_phrase: EXPECTED_RESTORE_PHRASE };
        const res = await authPost(ownerToken, '/api/import?override=true', body);
        expect(res.statusCode).toBe(200);

        const result = res.json() as {
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
        await reseedAndRelogin();
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
        const res = await authPost(ownerToken, '/api/import', asPayload(env));
        expect(res.statusCode).toBe(200);

        const dbInvoices = await db.select().from(invoices).orderBy(asc(invoices.number));
        expect(dbInvoices.length).toBe(2);
        const storno = dbInvoices.find((i) => i.number === 'ST-2026-0001');
        expect(storno).toBeDefined();
        expect(storno!.cancellationOf).toBe(
          dbInvoices.find((i) => i.number === 'RE-2026-0001')!.id,
        );
      } finally {
        await reseedAndRelogin();
      }
    });

    it('imports without FK violation when the envelope has the Storno before its original', async () => {
      await wipeBusinessDataExceptUsers();
      try {
        const env = buildExpandedEnvelope();
        // Reverse so the Storno comes first — a hand-edited envelope.
        env.invoices = [...env.invoices].reverse();
        const res = await authPost(ownerToken, '/api/import', asPayload(env));
        expect(res.statusCode).toBe(200);

        const dbInvoices = await db.select().from(invoices).orderBy(asc(invoices.number));
        expect(dbInvoices.length).toBe(2);
        const storno = dbInvoices.find((i) => i.number === 'ST-2026-0001');
        expect(storno!.cancellationOf).toBe(
          dbInvoices.find((i) => i.number === 'RE-2026-0001')!.id,
        );
      } finally {
        await reseedAndRelogin();
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

        const res = await authPost(ownerToken, '/api/import', asPayload(env));
        expect(res.statusCode).toBe(200);
      } finally {
        await reseedAndRelogin();
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

        const res = await authPost(ownerToken, '/api/import', asPayload(env));
        expect(res.statusCode).toBe(422);
        const body = res.json() as {
          code: string;
          details?: { missingUserIds?: string[] };
        };
        expect(body.code).toBe('MISSING_USER_REFS');
        expect(body.details?.missingUserIds).toContain(UUID_ZERO);
      } finally {
        await reseedAndRelogin();
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

        const res = await authPost(ownerToken, '/api/import', asPayload(env));
        expect(res.statusCode).toBe(422);
        const body = res.json() as {
          code: string;
          details?: { missingUserIds?: string[] };
        };
        expect(body.code).toBe('MISSING_USER_REFS');
        expect(body.details?.missingUserIds).toContain(seededId);
      } finally {
        await reseedAndRelogin();
      }
    });
  });

  // -------------------------------------------------------------------
  // Single-row import audit. On a successful commit one audit row lands
  // with `entity_type='data_import'`, `actor_kind='system'`,
  // `actor_reason='data:import'`, `action='import_restored'`,
  // `entity_id=<synthetic batch UUID>`, `entity_label='Import: <N>
  // Datensätze'`, and `payload.counts` carrying the per-slot row counts
  // (every slot key, zero where empty).
  //
  // Rationale: an `/api/import` is a deployment-level event, not an
  // event attributed to a single user / customer / etc. Per-slot audit
  // rows misattributed entries in the activity feed; one row per
  // import + the full counts breakdown in the payload preserves the
  // forensic detail without the misattribution.
  // -------------------------------------------------------------------
  describe('single-row import audit', () => {
    it('emits exactly one audit row per import with entity_type=data_import and the per-slot counts payload', async () => {
      await wipeBusinessDataExceptUsers();
      // Also clear pre-existing data:import audit rows from the seed
      // pass (`loadBusiness` runs through ImportService and emits its
      // own audit row). Without this, the assertion below picks up
      // both the seed's row AND the test's row.
      await db.execute(
        sql`DELETE FROM audit_log WHERE actor_kind = 'system' AND actor_reason = 'data:import'`,
      );
      try {
        const env = buildExpandedEnvelope();
        const res = await authPost(ownerToken, '/api/import', asPayload(env));
        expect(res.statusCode).toBe(200);

        const rows = await db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.actorKind, 'system'),
              eq(auditLog.actorReason, 'data:import'),
              eq(auditLog.action, 'import_restored'),
            ),
          );

        // Exactly one row.
        expect(rows.length).toBe(1);
        const row = rows[0]!;
        expect(row.entityType).toBe('data_import');
        expect(row.actorKind).toBe('system');
        expect(row.actorId).toBeNull();
        expect(row.actorReason).toBe('data:import');
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
        // always 0 in the text leg (AC-253) but the key is present
        // for shape uniformity.
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
        await reseedAndRelogin();
      }
    });

    it('does NOT emit any per-slot audit row (entity_type IN user/customer/...) for the import', async () => {
      await wipeBusinessDataExceptUsers();
      // Clear seed import row so the assertion below is unambiguous.
      await db.execute(
        sql`DELETE FROM audit_log WHERE actor_kind = 'system' AND actor_reason = 'data:import'`,
      );
      try {
        const env = buildExpandedEnvelope();
        const res = await authPost(ownerToken, '/api/import', asPayload(env));
        expect(res.statusCode).toBe(200);

        // Every audit row with actor_reason='data:import' MUST be
        // entity_type='data_import' — no per-slot rows.
        const rows = await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.actorReason, 'data:import'));
        expect(rows.length).toBe(1);
        expect(rows.every((r) => r.entityType === 'data_import')).toBe(true);

        // Spot-check the categories that the prior per-slot shape
        // would have written: none of these are present.
        for (const et of [
          'user',
          'customer',
          'project',
          'project_worker',
          'invoice',
          'company_profile',
          'attachment',
        ] as const) {
          const perSlot = await db
            .select()
            .from(auditLog)
            .where(and(eq(auditLog.actorReason, 'data:import'), eq(auditLog.entityType, et)));
          expect(perSlot.length).toBe(0);
        }
      } finally {
        await reseedAndRelogin();
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

        const res = await authPost(ownerToken, '/api/import', asPayload(env));
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.statusCode).toBeLessThan(500);
        expect(res.json().code).toBe('SCHEMA_VERSION_MISMATCH');

        // No writes — customers/projects stay empty (the wipe ran in
        // setup). users intact (the wipe is selective).
        const dbCustomers = await db.execute<{ c: string }>(
          sql`SELECT count(*)::text AS c FROM customers`,
        );
        expect(Number(dbCustomers.rows[0]!.c)).toBe(0);
      } finally {
        await reseedAndRelogin();
      }
    });
  });

  // -------------------------------------------------------------------
  // Route-layer body schema rejection — missing one of the four new
  // required keys yields 422 from Fastify ajv before the service runs.
  // -------------------------------------------------------------------
  describe('route body schema requires the new v3 slots', () => {
    it('rejects an envelope missing the `users` key with 422', async () => {
      // Take a baseline count before the call. `wipeBusinessDataExceptUsers`
      // is not called here because the route-schema rejection happens
      // before any DB write — the post-call counts should equal the
      // pre-call counts.
      const customersBefore = await db.execute<{ c: string }>(
        sql`SELECT count(*)::text AS c FROM customers`,
      );
      const customerCountBefore = Number(customersBefore.rows[0]!.c);

      try {
        const env = buildExpandedEnvelope();
        // Strip the users field — Fastify ajv refuses required-key
        // omissions with statusCode 400 by default; in this codebase
        // the validation-error customizer maps to 422 with code
        // VALIDATION_ERROR. Either way, the request fails.
        const { users: _users, ...withoutUsers } = asPayload(env);
        void _users;

        const res = await authPost(ownerToken, '/api/import', withoutUsers);
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.statusCode).toBeLessThan(500);

        // No writes — the customer count is unchanged.
        const customersAfter = await db.execute<{ c: string }>(
          sql`SELECT count(*)::text AS c FROM customers`,
        );
        expect(Number(customersAfter.rows[0]!.c)).toBe(customerCountBefore);
      } finally {
        await reseedAndRelogin();
      }
    });
  });

  // -------------------------------------------------------------------
  // AT-77 analog roundtrip. Export the seeded dataset, wipe, override-
  // import the snapshot, re-export, compare. `exported_at` and
  // `users[*].lastLoginAt` legitimately drift between two snapshots; we
  // exclude them from the strict equality check.
  // -------------------------------------------------------------------
  describe('AT-77 analog — seed → export → wipe → import (override) → export', () => {
    it('preserves every slot byte-for-byte (modulo exported_at and lastLoginAt)', async () => {
      // First export — the seeded baseline.
      const e1Res = await authGet(ownerToken, '/api/export');
      expect(e1Res.statusCode).toBe(200);
      const e1 = e1Res.json() as Envelope;

      try {
        // Override-import the snapshot back into the (currently seeded)
        // database — the wipe + restore must reproduce every slot.
        // `asPayload(e1)` strips the `attachments` key per AC-253.
        const body = { ...asPayload(e1), confirmation_phrase: EXPECTED_RESTORE_PHRASE };
        const importRes = await authPost(ownerToken, '/api/import?override=true', body);
        expect(importRes.statusCode).toBe(200);

        // The override wiped sessions — re-login before the next call.
        ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);

        // Second export.
        const e2Res = await authGet(ownerToken, '/api/export');
        expect(e2Res.statusCode).toBe(200);
        const e2 = e2Res.json() as Envelope;

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
        await reseedAndRelogin();
      }
    });
  });
});
