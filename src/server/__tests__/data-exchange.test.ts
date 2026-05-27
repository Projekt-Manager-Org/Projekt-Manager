/**
 * Integration tests: Unified Data Exchange (ExportService / ImportService).
 *
 * Covers AC-133 through AC-141 (verification.md §15.14) for the unified
 * business-data export/import surface introduced by ADR-0018.
 *
 * The text-leg HTTP routes (`GET /api/export`, `POST /api/import`) were
 * removed once the operator UI moved to the export/import JOB endpoints:
 * nothing in production reached them — the import-job runner, the
 * export-job builder, and the seed all call `ExportService` /
 * `ImportService` directly. These tests now drive the same live services
 * the jobs use, via `src/test/data-exchange-helpers.ts`:
 *
 *   exportEnvelope()                  → returns the Envelope directly
 *   importEnvelope(env, opts, options?) → returns ImportResult | DryRunPreview
 *                                         on success; THROWS an AppError on
 *                                         failure (carries .code / .statusCode
 *                                         / .details).
 *
 * The auth/permission gate that the removed routes enforced is covered on
 * the live job routes (`data-exchange-export-job.test.ts` asserts 401 +
 * 403 NOT_PERMITTED for `data:export`); the service has no such check, so
 * the gate describes that used to live here were dropped.
 *
 * Envelope shape (data-model.md §5.8):
 *   { schema_version, exported_at, users, company_profile, customers,
 *     projects, project_workers, invoices, invoice_sequence, attachments }
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'path';
import { fileURLToPath } from 'url';
import type pg from 'pg';

import { startApp, stopApp } from '../../test/api-helpers.js';
import { exportEnvelope, importEnvelope } from '../../test/data-exchange-helpers.js';
import { EXPECTED_RESTORE_PHRASE } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import { seed } from '../seed.js';
import type { Database } from '../db/connection.js';
import { createStorageClient } from '../storage/client.js';
import type { AttachmentStorageClient } from '../storage/client.js';
import { getEnv } from '../config/env.js';
import { AppError } from '../errors.js';
import type { Envelope, ImportOptions } from '../../domain/dataExchange.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

/**
 * Current schema version. Exports must stamp this value; imports must
 * reject any mismatch (see ADR-0018 §Decision — strict version rejection,
 * no data-format migration code).
 *
 * When `src/server/seed.ts` or data-model.md §5.8 bumps the schema, bump
 * this constant; the import should then reject the old value the next
 * test run, which is exactly the test's purpose.
 *
 * Bumped to `3` when the Layer 1 envelope expanded to cover all
 * user-meaningful business state (issue #230): `users`, `company_profile`,
 * `invoices`, and `invoice_sequence` joined the prior set. Pre-#230 (v2)
 * envelopes are not consumable on the importing instance; the
 * SCHEMA_VERSION_MISMATCH arm is the documented refusal path.
 */
const CURRENT_SCHEMA_VERSION = 3;

const UUID_ZERO = '00000000-0000-0000-0000-000000000000';

/**
 * Deterministic UUID factory for fixture envelopes. The prefix is hex-
 * encoded so non-hex category markers like `cust` / `proj` stay usable
 * in fixture code without producing invalid PG uuid syntax.
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
 * Build a singleton company_profile row for the fixture envelopes.
 * Issue #230: `company_profile` must be exactly one row (singleton —
 * data-model.md §5.17). Tests that don't care about the profile's
 * contents still need to ship the singleton so the envelope validates.
 */
function buildFixtureCompanyProfile(suffix: string): Record<string, unknown> {
  return {
    id: uuid(`cp-${suffix}`, 1),
    companyName: `Fixture Maler ${suffix}`,
    address: { street: 'Fixturestr. 1', zip: '10115', city: 'Berlin' },
    taxId: '111/222/33333',
    ustId: 'DE123456789',
    iban: 'DE12 1000 0000 1234 5678 90',
    accentColor: null,
    footerText: null,
    logoBinaryDescriptorId: null,
    defaultTaxMode: 'standard',
    updatedAt: '2026-01-03T00:00:00.000Z',
    updatedBy: null,
  };
}

/**
 * Build an envelope for the empty-DB import path. Fresh IDs so the test
 * can verify ID preservation after export→import→export.
 *
 * Issue #230 (v3): `users` defaults to an empty array (these legacy tests
 * don't care about user content), but `company_profile` carries the
 * singleton — the importer rejects anything other than exactly one row.
 */
function buildFreshEnvelope(): ExportEnvelope {
  const customerId = uuid('cust', 1);
  const projectId = uuid('proj', 1);
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    exported_at: isoNow(),
    users: [],
    company_profile: [buildFixtureCompanyProfile('fresh')],
    customers: [
      {
        id: customerId,
        name: 'Import Kunde Alpha',
        phone: '0221-9000001',
        email: 'alpha@example.de',
        address: { street: 'Ringstr. 1', zip: '50667', city: 'Köln' },
        ustId: null,
        notes: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        createdBy: null,
        updatedBy: null,
      },
    ],
    projects: [
      {
        id: projectId,
        number: '2026-900',
        title: 'Import Projekt Alpha',
        status: 'anfrage',
        statusChangedAt: '2026-01-05T00:00:00.000Z',
        customerId,
        plannedStart: null,
        plannedEnd: null,
        estimatedValue: null,
        notes: null,
        deleted: false,
        createdAt: '2026-01-05T00:00:00.000Z',
        updatedAt: '2026-01-05T00:00:00.000Z',
        createdBy: null,
        updatedBy: null,
      },
    ],
    project_workers: [],
    invoices: [],
    invoice_sequence: [],
  };
}

/**
 * Build an envelope distinct from the seed — different IDs, names, and
 * counts — so override-vs-seed tests can detect wipe-and-restore.
 */
function buildOverrideEnvelope(): ExportEnvelope {
  const c1 = uuid('cust', 10);
  const c2 = uuid('cust', 11);
  const p1 = uuid('proj', 10);
  const p2 = uuid('proj', 11);
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    exported_at: isoNow(),
    users: [],
    company_profile: [buildFixtureCompanyProfile('override')],
    customers: [
      {
        id: c1,
        name: 'Override Kunde Eins',
        phone: null,
        email: null,
        address: null,
        ustId: null,
        notes: null,
        createdAt: '2026-02-01T00:00:00.000Z',
        updatedAt: '2026-02-01T00:00:00.000Z',
        createdBy: null,
        updatedBy: null,
      },
      {
        id: c2,
        name: 'Override Kunde Zwei',
        phone: null,
        email: null,
        address: null,
        ustId: null,
        notes: null,
        createdAt: '2026-02-02T00:00:00.000Z',
        updatedAt: '2026-02-02T00:00:00.000Z',
        createdBy: null,
        updatedBy: null,
      },
    ],
    projects: [
      {
        id: p1,
        number: '2026-OV-1',
        title: 'Override Projekt Eins',
        status: 'anfrage',
        statusChangedAt: '2026-02-05T00:00:00.000Z',
        customerId: c1,
        plannedStart: null,
        plannedEnd: null,
        estimatedValue: null,
        notes: null,
        deleted: false,
        createdAt: '2026-02-05T00:00:00.000Z',
        updatedAt: '2026-02-05T00:00:00.000Z',
        createdBy: null,
        updatedBy: null,
      },
      {
        id: p2,
        number: '2026-OV-2',
        title: 'Override Projekt Zwei (archived)',
        status: 'erledigt',
        statusChangedAt: '2026-02-06T00:00:00.000Z',
        customerId: c2,
        plannedStart: null,
        plannedEnd: null,
        estimatedValue: null,
        notes: null,
        deleted: true,
        createdAt: '2026-02-06T00:00:00.000Z',
        updatedAt: '2026-02-06T00:00:00.000Z',
        createdBy: null,
        updatedBy: null,
      },
    ],
    project_workers: [],
    invoices: [],
    invoice_sequence: [],
  };
}

/**
 * Shape we assert against. Any field the current export omits makes the
 * corresponding assertion fail loudly — that is the entire point of the
 * row-level-fidelity AC.
 *
 * Issue #230 (v3): the four new top-level slots ride alongside the
 * legacy three. Each is loosely typed (`unknown[]`) here because most
 * legacy tests only spread/preserve the field rather than reading its
 * content; tests that exercise the new shapes type the rows locally.
 */
interface ExportEnvelope {
  schema_version: number;
  exported_at: string;
  users: unknown[];
  company_profile: unknown[];
  customers: Array<Record<string, unknown> & { id: string }>;
  projects: Array<Record<string, unknown> & { id: string; deleted: boolean }>;
  project_workers: Array<{ projectId: string; userId: string }>;
  invoices: unknown[];
  invoice_sequence: unknown[];
  // Index signature so fixture envelopes can carry extra keys (e.g.
  // `attachments`, `siteAddress`) without per-field declarations; the
  // services ignore keys they don't consume.
  [key: string]: unknown;
}

// ---------------------------------------------------------------
// A dedicated db/pool for direct-SQL operations the API does not cover
// (wiping business data between tests so the "empty DB" and "atomic
// rollback" branches are exercised). Uses the same connection string as
// the app — two pools against the same PG instance are fine; data-integrity
// tests do the same.
// ---------------------------------------------------------------
let db: Database;
let pool: pg.Pool;

async function wipeBusinessData(): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE project_workers, projects, customers RESTART IDENTITY CASCADE`,
  );
}

/**
 * Re-seed the database. `seed(..., { force: true })` rebuilds the canonical
 * dataset (and TRUNCATEs sessions). The data-exchange services are driven
 * directly now — no session tokens are held — so a plain reseed is all the
 * cleanup any test needs.
 */
async function reseed(): Promise<void> {
  await seed(db, { force: true });
}

/**
 * Drive an import expected to fail and return the thrown `AppError`. The
 * service throws (carrying `.code` / `.statusCode` / `.details`) rather
 * than returning an HTTP envelope, so failure cases inspect the error
 * directly. Mirrors the helper in `data-exchange-import-expanded.test.ts`.
 */
async function expectImportRejection(
  env: Envelope,
  opts: ImportOptions,
  options?: { storage?: AttachmentStorageClient | null },
): Promise<AppError> {
  try {
    await importEnvelope(env, opts, options);
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected importEnvelope to reject, but it resolved');
}

describe('Unified Data Exchange', () => {
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

  // ---------------------------------------------------------------
  // AC-133 / AC-134 (export + import auth gate) were route-middleware
  // concerns. The removed `GET /api/export` / `POST /api/import` routes
  // enforced 401 (unauthenticated) and 403 NOT_PERMITTED (missing
  // data:export / data:restore). ExportService / ImportService have no
  // auth or permission check of their own, so those describes were
  // dropped: the gate is now covered on the live job routes
  // (`data-exchange-export-job.test.ts` asserts 401 + 403 NOT_PERMITTED
  // for `data:export`). The AC-134 empty-DB success arm is covered by
  // AC-137 below.
  // ---------------------------------------------------------------

  // ---------------------------------------------------------------
  // AC-135: export envelope shape and row-level fidelity
  // ---------------------------------------------------------------
  describe('AC-135: export envelope shape', () => {
    let archivedProjectId: string;

    // Soft-delete one seeded project so the "archived rows are included"
    // branch has something to check. Archived rows must still appear in
    // the export with `deleted: true`.
    beforeAll(async () => {
      // Soft-delete a project directly so the export carries a deleted=true
      // row. (No /api/projects route hop — the export service reads the DB.)
      const target = await db.execute<{ id: string }>(
        sql`UPDATE projects
            SET deleted = true
            WHERE id = (SELECT id FROM projects WHERE deleted = false ORDER BY id ASC LIMIT 1)
            RETURNING id`,
      );
      archivedProjectId = target.rows[0]!.id;
    });

    afterAll(async () => {
      // Restore the seed so downstream describes see the canonical dataset.
      await reseed();
    });

    // AC-135: top-level envelope contains schema_version, exported_at,
    // customers[], projects[], project_workers[] — every field present.
    it('returns schema_version, exported_at, customers, projects, project_workers', async () => {
      const env = (await exportEnvelope()) as unknown as ExportEnvelope;
      expect(typeof env.schema_version).toBe('number');
      expect(env.schema_version).toBe(CURRENT_SCHEMA_VERSION);

      expect(typeof env.exported_at).toBe('string');
      // Must parse as a real Date (not NaN).
      expect(Number.isNaN(Date.parse(env.exported_at))).toBe(false);

      expect(Array.isArray(env.customers)).toBe(true);
      expect(Array.isArray(env.projects)).toBe(true);
      expect(Array.isArray(env.project_workers)).toBe(true);
    });

    // AC-135: customers.length matches the seeded row count (21 per
    // src/server/seed.ts). Off-by-one = seed drift the test should surface.
    it('exports every seeded customer (21 from seed)', async () => {
      const env = (await exportEnvelope()) as unknown as ExportEnvelope;
      expect(env.customers.length).toBe(21);
    });

    // AC-135: projects count matches seeded count INCLUDING archived rows.
    // Seed = 19 projects; none are archived in seed. We soft-deleted one
    // above, so the export must still include 19 (archived = included).
    it('exports every project INCLUDING archived (deleted=true) rows', async () => {
      const env = (await exportEnvelope()) as unknown as ExportEnvelope;
      expect(env.projects.length).toBe(19);

      const archived = env.projects.find((p) => p.id === archivedProjectId);
      expect(archived).toBeDefined();
      expect(archived!.deleted).toBe(true);
    });

    // AC-135 (exclusion, post-#230): pre-#230 the envelope explicitly
    // excluded users/sessions/passwordHash; under v3 (issue #230) users
    // and `passwordHash` ride the envelope verbatim. `sessions` remains
    // out by design (ephemeral, per-deployment). The positive assertion
    // for users + passwordHash lives in `data-exchange-export-envelope.test.ts`.
    it('still excludes sessions from the serialized envelope', async () => {
      const serialized = JSON.stringify(await exportEnvelope());
      expect(serialized).not.toMatch(/"sessions"\s*:/);
    });
  });

  // ---------------------------------------------------------------
  // AC-136: schema_version mismatch is rejected, with no writes
  // ---------------------------------------------------------------
  describe('AC-136: schema_version mismatch rejection', () => {
    // AC-136: envelope version current+1 → rejected with specific code, no writes.
    it('rejects an envelope with a newer schema_version', async () => {
      const baseline = (await exportEnvelope()) as unknown as ExportEnvelope;

      const bad = buildOverrideEnvelope();
      bad.schema_version = CURRENT_SCHEMA_VERSION + 1;
      const err = await expectImportRejection(bad as unknown as Envelope, {
        dryRun: false,
        override: true,
        confirmationPhrase: EXPECTED_RESTORE_PHRASE,
      });

      expect(err.statusCode).toBe(422);
      expect(err.code).toBe('SCHEMA_VERSION_MISMATCH');

      const post = (await exportEnvelope()) as unknown as ExportEnvelope;
      expect(post.customers.length).toBe(baseline.customers.length);
      expect(post.projects.length).toBe(baseline.projects.length);
    });

    // AC-136: envelope version current-1 → same rejection. No migration.
    it('rejects an envelope with an older schema_version', async () => {
      const bad = buildOverrideEnvelope();
      bad.schema_version = CURRENT_SCHEMA_VERSION - 1;
      const err = await expectImportRejection(bad as unknown as Envelope, {
        dryRun: false,
        override: true,
        confirmationPhrase: EXPECTED_RESTORE_PHRASE,
      });

      expect(err.statusCode).toBe(422);
      expect(err.code).toBe('SCHEMA_VERSION_MISMATCH');
    });
  });

  // ---------------------------------------------------------------
  // AC-137: import into empty DB preserves IDs, all-or-nothing
  // ---------------------------------------------------------------
  describe('AC-137: import into empty DB', () => {
    // AC-137 happy path: empty target, valid envelope → IDs match.
    it('imports a valid envelope and preserves row IDs exactly', async () => {
      await wipeBusinessData();
      try {
        const envelope = buildFreshEnvelope();
        await importEnvelope(envelope as unknown as Envelope, {
          dryRun: false,
          override: false,
          confirmationPhrase: null,
        });

        const out = (await exportEnvelope()) as unknown as ExportEnvelope;

        const customerIds = new Set(out.customers.map((c) => c.id));
        for (const c of envelope.customers) expect(customerIds.has(c.id)).toBe(true);

        const projectIds = new Set(out.projects.map((p) => p.id));
        for (const p of envelope.projects) expect(projectIds.has(p.id)).toBe(true);
      } finally {
        await reseed();
      }
    });

    // AC-137 atomicity: an envelope with a project referencing a customer
    // NOT in `customers` must fail the whole transaction — the earlier,
    // valid rows must not be persisted.
    it('rolls back entirely if any row is invalid (atomic import)', async () => {
      await wipeBusinessData();
      try {
        const envelope = buildFreshEnvelope();
        // Replace the last project's customerId with a non-existent one.
        const broken = {
          ...envelope,
          projects: [
            ...envelope.projects,
            {
              ...envelope.projects[0]!,
              id: uuid('proj', 99),
              number: '2026-999',
              customerId: UUID_ZERO, // references nothing
            },
          ],
        };
        const err = await expectImportRejection(broken as unknown as Envelope, {
          dryRun: false,
          override: false,
          confirmationPhrase: null,
        });
        expect(err.statusCode).toBeGreaterThanOrEqual(400);

        // DB must still be empty — neither the valid project nor the
        // "valid" customer should have been persisted.
        const out = (await exportEnvelope()) as unknown as ExportEnvelope;
        expect(out.customers.length).toBe(0);
        expect(out.projects.length).toBe(0);
        expect(out.project_workers.length).toBe(0);
      } finally {
        await reseed();
      }
    });
  });

  // ---------------------------------------------------------------
  // Envelope uniqueness validation
  //
  // Referential integrity alone is not enough: an envelope with two
  // customers sharing the same id (or two projects sharing the same id /
  // the same number, or two project_workers rows with the same composite
  // key) currently slips past `validateEnvelopeReferences` and reaches the
  // INSERT, where Postgres raises a 23505 unique-violation that surfaces
  // to the caller as a generic 500. The validation layer must catch these
  // collisions up-front and return the same 422 VALIDATION_ERROR shape
  // used by the referential-integrity checks — so dry-run can preview
  // them without a write, and non-dry-run never touches the DB at all.
  // ---------------------------------------------------------------
  describe('Envelope uniqueness validation', () => {
    // Start from an empty DB so a duplicate-detection failure cannot be
    // confused with TARGET_NOT_EMPTY (AC-138) or with a collision against
    // the seed. The seed is restored in the finally of each test.
    //
    // Note: `wipeBusinessData()` truncates business tables only — the
    // `users` table survives, so seeded user IDs (if any are needed in a
    // test) remain valid. The tests below do not rely on that, because
    // validation must reject duplicate composite keys before any insert.

    it('rejects duplicate customer ids (non-dry-run) with 422 VALIDATION_ERROR', async () => {
      await wipeBusinessData();
      try {
        const envelope = buildFreshEnvelope();
        const dupId = envelope.customers[0]!.id;
        envelope.customers.push({
          ...envelope.customers[0]!,
          // Same id as customers[0] — intentional collision.
          id: dupId,
          name: 'Duplicate Kunde',
          email: 'duplicate@example.de',
          createdAt: '2026-01-03T00:00:00.000Z',
          updatedAt: '2026-01-03T00:00:00.000Z',
        });

        const err = await expectImportRejection(envelope as unknown as Envelope, {
          dryRun: false,
          override: false,
          confirmationPhrase: null,
        });

        expect(err.statusCode).toBe(422);
        expect(err.code).toBe('VALIDATION_ERROR');

        // `details` carries the validation issues. The existing
        // referential-integrity path stores them as a plain array;
        // accept either the array-directly or a {validation_errors:[…]}
        // wrapper so the test pins structure, not incidental nesting.
        const details = err.details as
          | { validation_errors?: Array<{ path: string; message: string }> }
          | Array<{ path: string; message: string }>;
        const issues = Array.isArray(details) ? details : details?.validation_errors;
        expect(Array.isArray(issues)).toBe(true);
        const dup = issues!.find((i) => /customers\[1\]/.test(i.path));
        expect(dup).toBeDefined();
        expect(dup!.message.toLowerCase()).toMatch(/duplicate|duplikat|doppelt/);

        // No rows written — DB remains empty. This is the point of
        // validating before the transaction opens.
        const out = (await exportEnvelope()) as unknown as ExportEnvelope;
        expect(out.customers.length).toBe(0);
        expect(out.projects.length).toBe(0);
        expect(out.project_workers.length).toBe(0);
      } finally {
        await reseed();
      }
    });

    it('reports duplicate customer ids in dry-run validation_errors without writes', async () => {
      await wipeBusinessData();
      try {
        const envelope = buildFreshEnvelope();
        const dupId = envelope.customers[0]!.id;
        envelope.customers.push({
          ...envelope.customers[0]!,
          id: dupId,
          name: 'Duplicate Kunde',
          email: 'duplicate2@example.de',
          createdAt: '2026-01-03T00:00:00.000Z',
          updatedAt: '2026-01-03T00:00:00.000Z',
        });

        // Dry-run never throws for invalid envelopes — the preview carries
        // the errors so the UI can render them. This is the clean proof
        // that validation (not the DB) surfaces the issue.
        const preview = (await importEnvelope(envelope as unknown as Envelope, {
          dryRun: true,
          override: false,
          confirmationPhrase: null,
        })) as { validation_errors: Array<{ path: string; message: string }> };

        expect(Array.isArray(preview.validation_errors)).toBe(true);
        const dup = preview.validation_errors.find((i) => /customers\[1\]/.test(i.path));
        expect(dup).toBeDefined();
        expect(dup!.message.toLowerCase()).toMatch(/duplicate|duplikat|doppelt/);

        // No state change.
        const out = (await exportEnvelope()) as unknown as ExportEnvelope;
        expect(out.customers.length).toBe(0);
        expect(out.projects.length).toBe(0);
      } finally {
        await reseed();
      }
    });

    it('rejects duplicate project ids (non-dry-run) with 422 VALIDATION_ERROR', async () => {
      await wipeBusinessData();
      try {
        const envelope = buildFreshEnvelope();
        const dupId = envelope.projects[0]!.id;
        envelope.projects.push({
          ...envelope.projects[0]!,
          // Same id as projects[0] — intentional collision.
          id: dupId,
          // Different number so the test isolates duplicate-id detection
          // from duplicate-number detection (covered by the next test).
          number: '2026-901',
          title: 'Duplicate Projekt',
          createdAt: '2026-01-06T00:00:00.000Z',
          updatedAt: '2026-01-06T00:00:00.000Z',
        });

        const err = await expectImportRejection(envelope as unknown as Envelope, {
          dryRun: false,
          override: false,
          confirmationPhrase: null,
        });

        expect(err.statusCode).toBe(422);
        expect(err.code).toBe('VALIDATION_ERROR');
        const details = err.details as
          | { validation_errors?: Array<{ path: string; message: string }> }
          | Array<{ path: string; message: string }>;
        const issues = Array.isArray(details) ? details : details?.validation_errors;
        expect(Array.isArray(issues)).toBe(true);
        const dup = issues!.find((i) => /projects\[1\]/.test(i.path) && /id/i.test(i.path));
        expect(dup).toBeDefined();
        expect(dup!.message.toLowerCase()).toMatch(/duplicate|duplikat|doppelt/);

        const out = (await exportEnvelope()) as unknown as ExportEnvelope;
        expect(out.customers.length).toBe(0);
        expect(out.projects.length).toBe(0);
      } finally {
        await reseed();
      }
    });

    it('rejects two projects sharing a number (different ids) with 422', async () => {
      await wipeBusinessData();
      try {
        const envelope = buildFreshEnvelope();
        const sharedNumber = envelope.projects[0]!.number;
        envelope.projects.push({
          ...envelope.projects[0]!,
          // Different id — uniqueness collision is on `number` only.
          id: uuid('proj', 2),
          number: sharedNumber,
          title: 'Same Number Projekt',
          createdAt: '2026-01-07T00:00:00.000Z',
          updatedAt: '2026-01-07T00:00:00.000Z',
        });

        const err = await expectImportRejection(envelope as unknown as Envelope, {
          dryRun: false,
          override: false,
          confirmationPhrase: null,
        });

        expect(err.statusCode).toBe(422);
        expect(err.code).toBe('VALIDATION_ERROR');
        const details = err.details as
          | { validation_errors?: Array<{ path: string; message: string }> }
          | Array<{ path: string; message: string }>;
        const issues = Array.isArray(details) ? details : details?.validation_errors;
        expect(Array.isArray(issues)).toBe(true);
        const dup = issues!.find((i) => /projects\[1\]/.test(i.path) && /number/i.test(i.path));
        expect(dup).toBeDefined();
        expect(dup!.message.toLowerCase()).toMatch(/duplicate|duplikat|doppelt/);

        const out = (await exportEnvelope()) as unknown as ExportEnvelope;
        expect(out.customers.length).toBe(0);
        expect(out.projects.length).toBe(0);
      } finally {
        await reseed();
      }
    });

    it('rejects duplicate project_workers composite key with 422', async () => {
      await wipeBusinessData();
      try {
        const envelope = buildFreshEnvelope();
        const projectId = envelope.projects[0]!.id;
        // userId can be any UUID: uniqueness validation must run before
        // the FK check against users. If the impl instead tried the insert,
        // it would FK-fail on this id — but the test pins that the
        // VALIDATION path rejects first, so the FK is never consulted.
        const userId = uuid('user', 1);
        envelope.project_workers = [
          { projectId, userId },
          { projectId, userId },
        ];

        const err = await expectImportRejection(envelope as unknown as Envelope, {
          dryRun: false,
          override: false,
          confirmationPhrase: null,
        });

        expect(err.statusCode).toBe(422);
        expect(err.code).toBe('VALIDATION_ERROR');
        const details = err.details as
          | { validation_errors?: Array<{ path: string; message: string }> }
          | Array<{ path: string; message: string }>;
        const issues = Array.isArray(details) ? details : details?.validation_errors;
        expect(Array.isArray(issues)).toBe(true);
        const dup = issues!.find((i) => /project_workers\[1\]/.test(i.path));
        expect(dup).toBeDefined();
        expect(dup!.message.toLowerCase()).toMatch(/duplicate|duplikat|doppelt/);

        const out = (await exportEnvelope()) as unknown as ExportEnvelope;
        expect(out.customers.length).toBe(0);
        expect(out.projects.length).toBe(0);
        expect(out.project_workers.length).toBe(0);
      } finally {
        await reseed();
      }
    });
  });

  // ---------------------------------------------------------------
  // AC-284: ImportService refuses partial siteAddress envelopes.
  //
  // Mirrors the POST /api/projects backstop. Without this, a hand-
  // edited or round-tripped envelope is the canonical bypass for the
  // form's all-or-none rule — the row lands in the DB as
  // { street: '', zip: '51103', city: 'Köln' } and the next export
  // propagates it. The validation runs before TRUNCATE so a rejected
  // envelope leaves the target untouched.
  // ---------------------------------------------------------------
  describe('AC-284: ImportService partial-siteAddress validation', () => {
    it('rejects an envelope whose project has an empty-component siteAddress (non-dry-run, 422)', async () => {
      await wipeBusinessData();
      try {
        const envelope = buildFreshEnvelope();
        // Pick the first project, set a partial siteAddress (zip empty).
        // Other projects keep their valid value.
        envelope.projects[0]!.siteAddress = { street: 'Goethestr. 18', zip: '', city: 'Köln' };

        const err = await expectImportRejection(envelope as unknown as Envelope, {
          dryRun: false,
          override: false,
          confirmationPhrase: null,
        });

        expect(err.statusCode).toBe(422);
        expect(err.code).toBe('VALIDATION_ERROR');

        const details = err.details as
          | { validation_errors?: Array<{ path: string; message: string }> }
          | Array<{ path: string; message: string }>;
        const issues = Array.isArray(details) ? details : details?.validation_errors;
        expect(Array.isArray(issues)).toBe(true);
        const partial = issues!.find((i) => /projects\[0\]\.siteAddress/.test(i.path));
        expect(partial).toBeDefined();
        expect(partial!.message.toLowerCase()).toMatch(/partial|street|zip|city|empty/);

        // No rows written — DB remains empty.
        const out = (await exportEnvelope()) as unknown as ExportEnvelope;
        expect(out.customers.length).toBe(0);
        expect(out.projects.length).toBe(0);
      } finally {
        await reseed();
      }
    });

    it('reports partial siteAddress in dry-run validation_errors without writes', async () => {
      await wipeBusinessData();
      try {
        const envelope = buildFreshEnvelope();
        envelope.projects[0]!.siteAddress = { street: '', zip: '51103', city: 'Köln' };

        // Dry-run never throws — preview carries the issues.
        const preview = (await importEnvelope(envelope as unknown as Envelope, {
          dryRun: true,
          override: false,
          confirmationPhrase: null,
        })) as { validation_errors: Array<{ path: string; message: string }> };

        expect(Array.isArray(preview.validation_errors)).toBe(true);
        const partial = preview.validation_errors.find((i) =>
          /projects\[0\]\.siteAddress/.test(i.path),
        );
        expect(partial).toBeDefined();

        const out = (await exportEnvelope()) as unknown as ExportEnvelope;
        expect(out.customers.length).toBe(0);
        expect(out.projects.length).toBe(0);
      } finally {
        await reseed();
      }
    });

    it('accepts an unmodified envelope (baseline shape — siteAddress field absent)', async () => {
      // Baseline: buildFreshEnvelope() seeds rows with siteAddress field absent; the validator must accept the baseline before the partial-rejection tests below assert their failure modes.
      await wipeBusinessData();
      try {
        await importEnvelope(buildFreshEnvelope() as unknown as Envelope, {
          dryRun: false,
          override: false,
          confirmationPhrase: null,
        });
      } finally {
        await reseed();
      }
    });
  });

  // ---------------------------------------------------------------
  // AC-138: non-empty target refused without override
  // ---------------------------------------------------------------
  describe('AC-138: non-empty target refused without override', () => {
    // AC-138: with seed present and no override flag → refused with a
    // specific error code; no state change.
    it('rejects with a conflict-category error when target is non-empty', async () => {
      // Seed is present from startApp(); confirm baseline.
      const baseline = (await exportEnvelope()) as unknown as ExportEnvelope;
      expect(baseline.customers.length).toBeGreaterThan(0);

      const env = buildOverrideEnvelope();
      const err = await expectImportRejection(env as unknown as Envelope, {
        dryRun: false,
        override: false,
        confirmationPhrase: null,
      });

      expect(err.statusCode).toBe(409);
      expect(err.code).toBe('TARGET_NOT_EMPTY');

      const post = (await exportEnvelope()) as unknown as ExportEnvelope;
      expect(post.customers.length).toBe(baseline.customers.length);
      expect(post.projects.length).toBe(baseline.projects.length);
      // Original seeded IDs still present.
      const preIds = new Set(baseline.customers.map((c) => c.id));
      for (const c of post.customers) expect(preIds.has(c.id)).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // AC-139: override wipes+restores atomically; invalid input rolls back
  // ---------------------------------------------------------------
  describe('AC-139: override wipe+restore', () => {
    // AC-139 happy path: seed + override flag + valid envelope →
    // existing rows gone, new rows present, IDs preserved.
    //
    // Issue #230: override now wipes `users` too, which cascades to
    // `sessions` and invalidates the operator's token mid-flight. The
    // post-import assertions therefore use direct DB queries rather
    // than /api/export — the latter would 401 with a wiped session.
    it('wipes existing data and imports the new envelope when override=true', async () => {
      const seeded = (await exportEnvelope()) as unknown as ExportEnvelope;
      // Sanity: seed has distinct IDs from the override envelope.
      const env = buildOverrideEnvelope();
      const seedIds = new Set(seeded.customers.map((c) => c.id));
      for (const c of env.customers) expect(seedIds.has(c.id)).toBe(false);

      try {
        await importEnvelope(env as unknown as Envelope, {
          dryRun: false,
          override: true,
          confirmationPhrase: EXPECTED_RESTORE_PHRASE,
        });

        // Direct-DB cross-check — the override wiped users (and cascaded
        // sessions), so a count is the cleanest post-state assertion.
        const dbCustomers = await db.execute<{ c: string }>(
          sql`SELECT count(*)::text AS c FROM customers`,
        );
        const dbProjects = await db.execute<{ c: string }>(
          sql`SELECT count(*)::text AS c FROM projects`,
        );
        expect(Number(dbCustomers.rows[0]!.c)).toBe(env.customers.length);
        expect(Number(dbProjects.rows[0]!.c)).toBe(env.projects.length);
      } finally {
        await reseed();
      }
    });

    // AC-139 atomicity: invalid envelope + override → rollback, seed intact.
    it('rolls back entirely on invalid envelope even with override (atomic)', async () => {
      const seeded = (await exportEnvelope()) as unknown as ExportEnvelope;

      const broken = buildOverrideEnvelope();
      // A project referencing a customerId not present in the envelope.
      broken.projects[0]!.customerId = UUID_ZERO;

      try {
        const err = await expectImportRejection(broken as unknown as Envelope, {
          dryRun: false,
          override: true,
          confirmationPhrase: EXPECTED_RESTORE_PHRASE,
        });
        expect(err.statusCode).toBeGreaterThanOrEqual(400);

        // Seed must be unchanged — rollback covers the wipe, not just the insert.
        const post = (await exportEnvelope()) as unknown as ExportEnvelope;
        expect(post.customers.length).toBe(seeded.customers.length);
        expect(post.projects.length).toBe(seeded.projects.length);
        const seededIds = new Set(seeded.customers.map((c) => c.id));
        for (const c of post.customers) expect(seededIds.has(c.id)).toBe(true);
      } finally {
        await reseed();
      }
    });
  });

  // ---------------------------------------------------------------
  // AC-140: dry-run — full validation, preview, no writes
  // ---------------------------------------------------------------
  describe('AC-140: dry-run import', () => {
    // AC-140 valid + dry-run: returns a preview of would-be writes, no state change.
    it('returns a preview for a valid envelope and performs no writes', async () => {
      const baseline = (await exportEnvelope()) as unknown as ExportEnvelope;

      const env = buildOverrideEnvelope();
      const preview = (await importEnvelope(env as unknown as Envelope, {
        dryRun: true,
        override: false,
        confirmationPhrase: null,
      })) as {
        target_non_empty: boolean;
        would_write: { customers: number; projects: number; project_workers: number };
        validation_errors: unknown[];
      };
      expect(preview.would_write).toBeDefined();
      expect(preview.would_write.customers).toBe(env.customers.length);
      expect(preview.would_write.projects).toBe(env.projects.length);
      expect(preview.would_write.project_workers).toBe(env.project_workers.length);
      expect(Array.isArray(preview.validation_errors)).toBe(true);
      expect(preview.validation_errors.length).toBe(0);
      // AC-140 (target_non_empty): the seeded DB is non-empty, so the
      // preview must declare it. The UI uses this to gate the override
      // warning; committing without override still fails with
      // TARGET_NOT_EMPTY (AC-138).
      expect(preview.target_non_empty).toBe(true);

      // No writes.
      const post = (await exportEnvelope()) as unknown as ExportEnvelope;
      expect(post.customers.length).toBe(baseline.customers.length);
      expect(post.projects.length).toBe(baseline.projects.length);
    });

    // AC-140 (target_non_empty, empty DB branch): dry-run against a wiped
    // target must report target_non_empty: false so the UI skips the
    // warning and enables commit directly.
    it('reports target_non_empty=false when the DB is empty', async () => {
      await wipeBusinessData();
      try {
        const env = buildFreshEnvelope();
        const preview = (await importEnvelope(env as unknown as Envelope, {
          dryRun: true,
          override: false,
          confirmationPhrase: null,
        })) as { target_non_empty: boolean };
        expect(preview.target_non_empty).toBe(false);
      } finally {
        await reseed();
      }
    });

    // AC-140 invalid + dry-run: preview carries validation errors, still no writes.
    it('reports validation_errors for an invalid envelope and performs no writes', async () => {
      const baseline = (await exportEnvelope()) as unknown as ExportEnvelope;

      const broken = buildOverrideEnvelope();
      broken.projects[0]!.customerId = UUID_ZERO; // FK violation

      const preview = (await importEnvelope(broken as unknown as Envelope, {
        dryRun: true,
        override: false,
        confirmationPhrase: null,
      })) as { validation_errors: unknown[] };
      expect(Array.isArray(preview.validation_errors)).toBe(true);
      expect(preview.validation_errors.length).toBeGreaterThan(0);

      // Still no writes.
      const post = (await exportEnvelope()) as unknown as ExportEnvelope;
      expect(post.customers.length).toBe(baseline.customers.length);
      expect(post.projects.length).toBe(baseline.projects.length);
    });
  });

  // ---------------------------------------------------------------
  // AC-141: roundtrip byte-equivalence (modulo exported_at) for the
  // text-row slice. ImportService never restores attachment rows (it
  // ignores the envelope's `attachments` slot); per-attachment
  // restoration runs through the takeout-zip path covered by AC-259.
  // Re-exporting the seeded dataset after a re-import therefore returns
  // an empty `attachments` array — matched against the source by
  // construction.
  // ---------------------------------------------------------------
  describe('AC-141: full roundtrip produces byte-identical content', () => {
    // AC-141 text-row arm: seed → export1 → override-import → export2 →
    // customers/projects/project_workers match exactly.
    //
    // Issue #230: the export carries users now, and the seeded users
    // already exist in the target — re-importing without override
    // collides on users.id. Override is the right semantic for a
    // self-roundtrip (wipe + replace with the snapshot). A fuller
    // roundtrip pinning every v3 slot lives in
    // `data-exchange-import-expanded.test.ts` (AT-77 analog).
    it('exports → imports → re-exports without drift (exported_at + lastLoginAt excluded)', async () => {
      const e1 = (await exportEnvelope()) as unknown as ExportEnvelope;

      try {
        // Override is the right semantic for a self-roundtrip (wipe +
        // replace with the snapshot). ImportService ignores the
        // envelope's `attachments` slot (AC-253) and never restores
        // attachment rows. No session is held now, so no re-login.
        await importEnvelope(e1 as unknown as Envelope, {
          dryRun: false,
          override: true,
          confirmationPhrase: EXPECTED_RESTORE_PHRASE,
        });

        const e2 = (await exportEnvelope()) as unknown as ExportEnvelope;

        expect(e2.schema_version).toBe(e1.schema_version);
        // exported_at will differ — explicitly excluded from the compare.
        expect(typeof e2.exported_at).toBe('string');

        // Strict content equality — if a field changes on roundtrip
        // (coercion, truncation, default injection) this fails and
        // reveals the drift.
        expect(e2.customers).toEqual(e1.customers);
        expect(e2.projects).toEqual(e1.projects);
        expect(e2.project_workers).toEqual(e1.project_workers);
      } finally {
        await reseed();
      }
    });
  });

  // ---------------------------------------------------------------
  // AC-160: restore confirmation phrase gate
  // Server-authoritative check on override into a non-empty DB.
  // AT-82 pins enforcement (missing, case-wrong, trim, happy path).
  // AT-83 pins the two exempt paths (dry-run, empty target).
  // ---------------------------------------------------------------
  describe('AC-160: restore confirmation phrase gate', () => {
    // AT-82 — missing phrase: override into non-empty DB without a
    // `confirmation_phrase` rejects with 422 RESTORE_CONFIRMATION_MISMATCH
    // and leaves the seed untouched.
    it('rejects override into non-empty DB when confirmation_phrase is missing', async () => {
      const baseline = (await exportEnvelope()) as unknown as ExportEnvelope;

      const env = buildOverrideEnvelope();
      const err = await expectImportRejection(env as unknown as Envelope, {
        dryRun: false,
        override: true,
        confirmationPhrase: null,
      });

      expect(err.statusCode).toBe(422);
      expect(err.code).toBe('RESTORE_CONFIRMATION_MISMATCH');

      const post = (await exportEnvelope()) as unknown as ExportEnvelope;
      expect(post.customers.length).toBe(baseline.customers.length);
      expect(post.projects.length).toBe(baseline.projects.length);
    });

    // AT-82 — case sensitivity: a phrase that differs only in case is
    // rejected. The value is wrapped in whitespace so a permissive
    // implementation that trimmed but ignored case would still fail this
    // test — the assertion isolates "case" from "trim".
    it('rejects override when confirmation_phrase has wrong casing', async () => {
      const baseline = (await exportEnvelope()) as unknown as ExportEnvelope;

      const env = buildOverrideEnvelope();
      const err = await expectImportRejection(env as unknown as Envelope, {
        dryRun: false,
        override: true,
        confirmationPhrase: `  ${EXPECTED_RESTORE_PHRASE.toLowerCase()}  `,
      });

      expect(err.statusCode).toBe(422);
      expect(err.code).toBe('RESTORE_CONFIRMATION_MISMATCH');

      const post = (await exportEnvelope()) as unknown as ExportEnvelope;
      expect(post.customers.length).toBe(baseline.customers.length);
    });

    // AT-82 — happy path: matching phrase commits the atomic wipe+restore.
    // Issue #230: the override wipes users — use a direct-DB assertion.
    it('accepts override with a matching confirmation_phrase', async () => {
      const env = buildOverrideEnvelope();
      try {
        await importEnvelope(env as unknown as Envelope, {
          dryRun: false,
          override: true,
          confirmationPhrase: EXPECTED_RESTORE_PHRASE,
        });

        const dbCustomers = await db.execute<{ c: string }>(
          sql`SELECT count(*)::text AS c FROM customers`,
        );
        expect(Number(dbCustomers.rows[0]!.c)).toBe(env.customers.length);
      } finally {
        await reseed();
      }
    });

    // AT-82 — trim: leading/trailing whitespace around the phrase is tolerated.
    it('accepts override when confirmation_phrase has surrounding whitespace', async () => {
      const env = buildOverrideEnvelope();
      try {
        await importEnvelope(env as unknown as Envelope, {
          dryRun: false,
          override: true,
          confirmationPhrase: `  ${EXPECTED_RESTORE_PHRASE}\n`,
        });
      } finally {
        await reseed();
      }
    });

    // AT-83 — dry-run exempt: dry-run against a non-empty DB without a
    // phrase returns the preview (no writes, no enforcement).
    it('accepts dry_run without confirmation_phrase on non-empty DB', async () => {
      const env = buildOverrideEnvelope();
      const preview = (await importEnvelope(env as unknown as Envelope, {
        dryRun: true,
        override: true,
        confirmationPhrase: null,
      })) as { target_non_empty: boolean };
      expect(preview.target_non_empty).toBe(true);
    });

    // AT-83 — empty-target exempt: override into an empty DB succeeds
    // without a phrase (there is nothing to wipe). Issue #230: even
    // an empty-target override wipes users (TRUNCATE users CASCADE
    // sweeps every session), so the post-call assertion uses a direct
    // DB query.
    it('accepts override into empty DB without confirmation_phrase', async () => {
      const env = buildFreshEnvelope();
      try {
        await wipeBusinessData();
        await importEnvelope(env as unknown as Envelope, {
          dryRun: false,
          override: true,
          confirmationPhrase: null,
        });

        const dbCustomers = await db.execute<{ c: string }>(
          sql`SELECT count(*)::text AS c FROM customers`,
        );
        expect(Number(dbCustomers.rows[0]!.c)).toBe(env.customers.length);
      } finally {
        await reseed();
      }
    });
  });

  // ---------------------------------------------------------------
  // AC-162a / AC-162b / AC-162c: missing-user-reference check
  //
  // The envelope carries user-id fields — `customers.createdBy`,
  // `customers.updatedBy`, `projects.createdBy`, `projects.updatedBy`,
  // `project_workers.userId`. On restore, those user ids must already
  // exist in the target's `users` table. If any referenced id is absent,
  // the commit path rejects with 422 `MISSING_USER_REFS`; the dry-run
  // surfaces it alongside intra-envelope issues.
  //
  // AT-84 pins AC-162a (commit-path rejection + `details` shape).
  // AT-85 pins AC-162b (dry-run surfaces both classes together).
  // AT-86 pins AC-162c (commit-path ordering + single-code guarantee).
  //
  // Two ghost UUIDs (`GHOST_USER_A`, `GHOST_USER_B`) are valid UUIDs
  // absent from the seed — any reference to them is, by construction,
  // a missing-user reference. House style already uses `UUID_ZERO` for
  // the same idea; distinct ids let "same user at two sites" and
  // "multiple distinct missing users" tests isolate their assertions.
  // ---------------------------------------------------------------
  describe('AC-162a/b/c: missing-user references', () => {
    // NB: `uuid()` hex-encodes then slices to 8 chars, so `ghosta`/`ghostb`
    // collide on the prefix — we rely on the `i` counter to differentiate.
    const GHOST_USER_A = uuid('ghosta', 1);
    const GHOST_USER_B = uuid('ghostb', 2);

    /**
     * Shape we assert against for the MISSING_USER_REFS error body. The
     * keys are `details.missingUserIds` and `details.references` per
     * api.md §14.4.1 (error details keys are camelCase). The path string
     * mirrors the intra-envelope validation-error path shape — e.g.
     * `project_workers[0].userId`.
     */
    interface MissingUserRefsBody {
      code: string;
      message: string;
      details?: {
        missingUserIds?: unknown;
        references?: unknown;
      };
    }

    /**
     * Count business-data rows directly — bypasses the API so these
     * "DB unchanged" assertions don't re-enter the route under test.
     * Pool-only query keeps the assertion independent of Drizzle's
     * query layer (closer to a pure integrity check).
     */
    async function businessRowCounts(): Promise<{
      customers: number;
      projects: number;
      project_workers: number;
    }> {
      const r = await pool.query<{ customers: string; projects: string; project_workers: string }>(
        `SELECT
           (SELECT COUNT(*) FROM customers)::text       AS customers,
           (SELECT COUNT(*) FROM projects)::text        AS projects,
           (SELECT COUNT(*) FROM project_workers)::text AS project_workers`,
      );
      const row = r.rows[0]!;
      return {
        customers: Number(row.customers),
        projects: Number(row.projects),
        project_workers: Number(row.project_workers),
      };
    }

    // AT-84 — commit path. Envelope is intra-consistent (projects point
    // at envelope customers, assignments point at envelope projects) but
    // the user-id fields reference GHOST_USER_A and GHOST_USER_B — ids
    // that do NOT exist in `users`. Must return 422 MISSING_USER_REFS.
    it('returns 422 MISSING_USER_REFS on commit path when envelope user refs are absent from target', async () => {
      await wipeBusinessData();
      try {
        const envelope = buildFreshEnvelope();
        // Two distinct missing users, distributed across the allowed
        // reference sites so the `details.references` array has one
        // entry per offending site (AC-162a — "one entry per offending
        // envelope reference site").
        envelope.customers[0]!.createdBy = GHOST_USER_A;
        envelope.customers[0]!.updatedBy = GHOST_USER_B;
        envelope.projects[0]!.createdBy = GHOST_USER_B;
        envelope.projects[0]!.updatedBy = null; // null must NOT trigger the code
        envelope.project_workers = [{ projectId: envelope.projects[0]!.id, userId: GHOST_USER_A }];

        const err = await expectImportRejection(envelope as unknown as Envelope, {
          dryRun: false,
          override: false,
          confirmationPhrase: null,
        });

        expect(err.statusCode).toBe(422);
        expect(err.code).toBe('MISSING_USER_REFS');
      } finally {
        await reseed();
      }
    });

    // AT-84 — `details.missingUserIds` is deduplicated. Envelope references
    // GHOST_USER_A at four distinct sites and GHOST_USER_B at one; the
    // deduplicated list must have exactly two entries, regardless of order.
    it('deduplicates missingUserIds across repeat references', async () => {
      await wipeBusinessData();
      try {
        const envelope = buildFreshEnvelope();
        envelope.customers[0]!.createdBy = GHOST_USER_A;
        envelope.customers[0]!.updatedBy = GHOST_USER_A;
        envelope.projects[0]!.createdBy = GHOST_USER_A;
        envelope.projects[0]!.updatedBy = GHOST_USER_B;
        envelope.project_workers = [{ projectId: envelope.projects[0]!.id, userId: GHOST_USER_A }];

        const err = await expectImportRejection(envelope as unknown as Envelope, {
          dryRun: false,
          override: false,
          confirmationPhrase: null,
        });

        expect(err.statusCode).toBe(422);
        expect(err.code).toBe('MISSING_USER_REFS');
        const ids = (err.details as MissingUserRefsBody['details'])?.missingUserIds;
        expect(Array.isArray(ids)).toBe(true);
        const sorted = [...(ids as string[])].sort();
        expect(sorted).toEqual([GHOST_USER_A, GHOST_USER_B].sort());
      } finally {
        await reseed();
      }
    });

    // AT-84 — `details.references` carries one entry per offending site
    // and duplicate user-ids across distinct paths produce separate
    // entries. Four references to GHOST_USER_A mapped to four distinct
    // paths must yield four entries whose paths are all distinct.
    it('references[] carries one entry per offending site (duplicates across distinct paths produce separate entries)', async () => {
      await wipeBusinessData();
      try {
        const envelope = buildFreshEnvelope();
        envelope.customers[0]!.createdBy = GHOST_USER_A;
        envelope.customers[0]!.updatedBy = GHOST_USER_A;
        envelope.projects[0]!.createdBy = GHOST_USER_A;
        envelope.projects[0]!.updatedBy = null;
        envelope.project_workers = [{ projectId: envelope.projects[0]!.id, userId: GHOST_USER_A }];

        const err = await expectImportRejection(envelope as unknown as Envelope, {
          dryRun: false,
          override: false,
          confirmationPhrase: null,
        });

        expect(err.statusCode).toBe(422);
        const refs = (err.details as MissingUserRefsBody['details'])?.references;
        expect(Array.isArray(refs)).toBe(true);
        const entries = refs as Array<{ path: string; userId: string }>;
        // All four sites point at GHOST_USER_A; all four paths are distinct.
        const matching = entries.filter((r) => r.userId === GHOST_USER_A);
        expect(matching.length).toBe(4);
        const paths = matching.map((r) => r.path);
        expect(new Set(paths).size).toBe(paths.length);
        // And each expected path shape is represented — the shape mirrors
        // intra-envelope validation paths (api.md §14.4.1).
        expect(paths).toEqual(
          expect.arrayContaining([
            'customers[0].createdBy',
            'customers[0].updatedBy',
            'projects[0].createdBy',
            'project_workers[0].userId',
          ]),
        );
      } finally {
        await reseed();
      }
    });

    // AT-84 — null / missing audit-field values MUST NOT trigger the
    // check. An envelope that mixes a ghost-user reference with a row
    // whose audit fields are null must produce MISSING_USER_REFS (the
    // ghost case) while leaving no `references[]` entry for the null-
    // audit row. Folded into a single test so the null-safe assertion
    // lives alongside a failing (today) assertion — keeps TDD discipline.
    it('null/missing createdBy/updatedBy values do not trigger MISSING_USER_REFS alongside a ghost reference', async () => {
      await wipeBusinessData();
      try {
        // Two customers: customer[0] carries all-null audit fields (must
        // NOT be flagged); customer[1] carries a ghost createdBy (MUST
        // be flagged). The assertion is two-sided, so the test fails
        // today (no 422) AND pins the null-safe behavior for when the
        // fix lands.
        const envelope = buildFreshEnvelope();
        envelope.customers.push({
          id: uuid('cust', 2),
          name: 'Null-Audit Kunde',
          phone: null,
          email: null,
          address: null,
          notes: null,
          createdAt: '2026-01-03T00:00:00.000Z',
          updatedAt: '2026-01-03T00:00:00.000Z',
          createdBy: null,
          updatedBy: null,
        });
        envelope.customers[0]!.createdBy = GHOST_USER_A;
        envelope.customers[0]!.updatedBy = null;
        envelope.projects[0]!.createdBy = null;
        envelope.projects[0]!.updatedBy = null;
        envelope.project_workers = [];

        const err = await expectImportRejection(envelope as unknown as Envelope, {
          dryRun: false,
          override: false,
          confirmationPhrase: null,
        });

        expect(err.statusCode).toBe(422);
        expect(err.code).toBe('MISSING_USER_REFS');

        // The ghost reference is flagged — path points at customers[0].createdBy.
        const details = err.details as MissingUserRefsBody['details'];
        const refs = (details?.references ?? []) as Array<{ path: string; userId: string }>;
        const ghostHit = refs.find(
          (r) => r.path === 'customers[0].createdBy' && r.userId === GHOST_USER_A,
        );
        expect(ghostHit).toBeDefined();

        // The null-audit row (customers[1]) contributes NO reference entries.
        // If the impl treated `null` as a reference, a `customers[1].*` path
        // would appear here.
        const nullSiteHit = refs.find((r) => /customers\[1\]/.test(r.path));
        expect(nullSiteHit).toBeUndefined();

        // And the deduplicated id list contains only the ghost — no null.
        const ids = (details?.missingUserIds ?? []) as string[];
        expect(ids).toEqual([GHOST_USER_A]);
      } finally {
        await reseed();
      }
    });

    // AT-84 — no writes on rejection. Full before/after row-count diff.
    it('performs no writes when rejecting MISSING_USER_REFS', async () => {
      await wipeBusinessData();
      try {
        const before = await businessRowCounts();
        expect(before).toEqual({ customers: 0, projects: 0, project_workers: 0 });

        const envelope = buildFreshEnvelope();
        envelope.customers[0]!.createdBy = GHOST_USER_A;
        envelope.projects[0]!.createdBy = GHOST_USER_A;

        const err = await expectImportRejection(envelope as unknown as Envelope, {
          dryRun: false,
          override: false,
          confirmationPhrase: null,
        });
        expect(err.statusCode).toBe(422);
        expect(err.code).toBe('MISSING_USER_REFS');

        const after = await businessRowCounts();
        expect(after).toEqual(before);
      } finally {
        await reseed();
      }
    });

    // AT-85 — dry-run surfaces BOTH classes of issue.
    // The envelope is intra-inconsistent (`projects[0].customerId` points
    // at a UUID not present in envelope.customers) AND carries a
    // missing-user reference. On `?dry_run=true`, the preview returns 200
    // and surfaces both issues together; no writes.
    it('dry-run surfaces both intra-envelope and missing-user issues together; no writes', async () => {
      await wipeBusinessData();
      try {
        const before = await businessRowCounts();

        const envelope = buildFreshEnvelope();
        // Intra-envelope inconsistency: project references a customerId
        // that doesn't exist in envelope.customers (AC-162c example).
        envelope.projects[0]!.customerId = UUID_ZERO;
        // Missing-user reference: createdBy points at a user absent in
        // the target `users` table.
        envelope.projects[0]!.createdBy = GHOST_USER_A;

        const preview = (await importEnvelope(envelope as unknown as Envelope, {
          dryRun: true,
          override: false,
          confirmationPhrase: null,
        })) as { validation_errors?: Array<{ path: string; message: string }> };

        // Intra-envelope class — already surfaced via `validation_errors`
        // in the existing preview shape.
        expect(Array.isArray(preview.validation_errors)).toBe(true);
        const intra = preview.validation_errors!.find((i) =>
          /projects\[0\]\.customerId/.test(i.path),
        );
        expect(intra).toBeDefined();

        // Missing-user class — the preview surfaces the ghost reference.
        // Per the brief we do not mint a new field name here; instead we
        // pin evidence: the ghost user id appears somewhere in the preview
        // payload (either inside validation_errors, or under a
        // missingUserIds/references sub-tree the impl chooses — spec
        // §14.2.4 says "surfaces both classes of issue in the preview").
        const serialized = JSON.stringify(preview);
        expect(serialized).toContain(GHOST_USER_A);

        const after = await businessRowCounts();
        expect(after).toEqual(before);
      } finally {
        await reseed();
      }
    });

    // AT-86 — commit-path ordering and single-code guarantee. Folded
    // into a single test so the follow-up assertion (intra-consistent
    // envelope with a ghost reference returns MISSING_USER_REFS) fails
    // today — otherwise the "dual-class returns VALIDATION_ERROR only"
    // half trivially passes on the current stub (no missing-user check
    // exists, so MISSING_USER_REFS never leaks into the body anyway).
    //
    // Two commits against the same fresh target:
    //   Pass 1 — dual-class envelope (intra-inconsistent AND missing-user
    //            reference) → VALIDATION_ERROR only, no MISSING_USER_REFS.
    //   Pass 2 — intra-consistent envelope, ghost reference only → 422
    //            MISSING_USER_REFS.
    // The two codes are never returned in the same response.
    it('commit path reports VALIDATION_ERROR first; MISSING_USER_REFS surfaces only once intra-envelope is clean', async () => {
      await wipeBusinessData();
      try {
        // Pass 1 — both classes present.
        const dual = buildFreshEnvelope();
        dual.projects[0]!.customerId = UUID_ZERO; // intra-envelope issue
        dual.projects[0]!.createdBy = GHOST_USER_A; // missing-user issue
        const err1 = await expectImportRejection(dual as unknown as Envelope, {
          dryRun: false,
          override: false,
          confirmationPhrase: null,
        });

        expect(err1.statusCode).toBeGreaterThanOrEqual(400);
        expect(err1.statusCode).toBeLessThan(500);
        expect(err1.code).toBe('VALIDATION_ERROR');
        // Single-code guarantee: MISSING_USER_REFS must not leak into the
        // same error (neither as the code nor inside details).
        expect(JSON.stringify({ code: err1.code, details: err1.details })).not.toContain(
          'MISSING_USER_REFS',
        );

        // Pass 2 — intra-consistent, ghost reference only.
        const clean = buildFreshEnvelope();
        clean.projects[0]!.createdBy = GHOST_USER_A;
        const err2 = await expectImportRejection(clean as unknown as Envelope, {
          dryRun: false,
          override: false,
          confirmationPhrase: null,
        });

        expect(err2.statusCode).toBe(422);
        expect(err2.code).toBe('MISSING_USER_REFS');
        // And the reverse: the missing-user error must not carry
        // VALIDATION_ERROR either — one code per response.
        expect(
          JSON.stringify({ code: err2.code, details: err2.details }).match(/"VALIDATION_ERROR"/),
        ).toBeNull();
      } finally {
        await reseed();
      }
    });
  });

  // ---------------------------------------------------------------
  // AC-253 (DELETED): "/api/import rejects bodies carrying an
  // `attachments` key" was a ROUTE BODY-SCHEMA rejection (the route
  // declared `attachments: { not: {} }`). ImportService has NO
  // equivalent structural guard — it simply never inserts attachment
  // rows and ignores any `attachments` key on the envelope. With the
  // route gone there is no service-level analog to assert, so the whole
  // describe (including the dry_run × override `it.each` matrix and the
  // "proceeds normally without the key" arm) was removed. The "no
  // attachment rows are restored" invariant is covered by AC-254 below
  // (post-override truncate count is 0) and the AT-77 roundtrip.
  // ---------------------------------------------------------------

  // ---------------------------------------------------------------
  // AC-254: /api/import?override=true atomically truncates the
  // `attachments` table alongside the customer / project / project-
  // worker wipe. After a successful override-import, the table is
  // empty regardless of envelope content (envelope `attachments[]`
  // is rejected at the wire by AC-253; the takeout-zip restore
  // mechanics re-upload through `init` after this call returns).
  // ---------------------------------------------------------------
  describe('AC-254: /api/import?override=true truncates the attachments table', () => {
    /**
     * Seed a single `pending` attachment row directly so the truncate
     * has something to remove. A `pending` row is enough — the AC is
     * "table is empty after override", not "only ready rows truncated".
     * The wrapped envelope is synthetic; the import path never reads
     * it (text-only post-fix).
     */
    async function seedAttachmentRow(projectId: string, suffix: string): Promise<string> {
      // Build a hex-only UUID from the suffix (the suffix is a label,
      // so map non-hex chars to their hex code-point). Real UUIDs are
      // hex-only; PG rejects literal letters like `atom1` outright.
      const hex = Array.from(suffix)
        .map((c) => c.charCodeAt(0).toString(16))
        .join('')
        .padEnd(12, '0')
        .slice(0, 12);
      const id = `aaaaaaaa-0000-4000-8000-${hex}`;
      const wrappedDek = Buffer.alloc(192, 0x77).toString('base64');
      await db.execute(sql`
        INSERT INTO attachments
          (id, project_id, status, kind, label, filename, mime_type, size_bytes,
           ciphertext_size_bytes,
           original_key, thumb_key, has_thumbnail,
           wrapped_dek, wrapped_thumb_dek, wrapped_dek_version)
        VALUES (${id}, ${projectId}, 'pending', 'binary', 'sonstiges',
                ${`seeded-${suffix}.pdf`}, 'application/pdf', 100,
                164,
                ${`attachments/${projectId}/${id}.orig`}, NULL, FALSE,
                ${wrappedDek}, NULL, 1)
      `);
      return id;
    }

    async function countAttachments(): Promise<number> {
      const r = await pool.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM attachments`);
      return Number(r.rows[0]!.c);
    }

    it('post-call attachments row count is zero after a successful override-import', async () => {
      // Seed two attachment rows attached to two distinct seeded projects
      // so the truncate must remove both regardless of project id. The
      // override envelope refers to FRESH projects (different ids); the
      // truncate runs unconditionally, not as a "rows whose project is
      // also being replaced" partial.
      const seededProjects = await db.execute<{ id: string }>(
        sql`SELECT id FROM projects ORDER BY id ASC LIMIT 2`,
      );
      expect(seededProjects.rows.length).toBeGreaterThanOrEqual(2);
      await seedAttachmentRow(seededProjects.rows[0]!.id, 'a01');
      await seedAttachmentRow(seededProjects.rows[1]!.id, 'b02');
      expect(await countAttachments()).toBeGreaterThanOrEqual(2);

      try {
        // ImportService never restores attachment rows (it ignores the
        // envelope's `attachments` slot). The load-bearing AC-254
        // assertion is that the override truncate ran AND no path
        // re-inserted attachment rows — the post-call count is 0.
        const envelope = buildOverrideEnvelope();
        await importEnvelope(envelope as unknown as Envelope, {
          dryRun: false,
          override: true,
          confirmationPhrase: EXPECTED_RESTORE_PHRASE,
        });

        // The whole point of AC-254: the table is empty post-call.
        expect(await countAttachments()).toBe(0);
      } finally {
        await reseed();
      }
    });

    it('truncates atomically inside the same transaction as the customer / project / project-worker wipe', async () => {
      // Atomicity arm: the truncate must share the same transaction
      // boundary as the rest of the wipe + restore — a malformed envelope
      // that triggers a rollback after the truncate would otherwise
      // leave the attachments table empty while the seed survives.
      // The AC names this explicitly: "truncates the attachments table
      // inside the same transaction that wipes existing customer /
      // project / project-worker rows, atomically with the restore".
      const seededProjects = await db.execute<{ id: string }>(
        sql`SELECT id FROM projects ORDER BY id ASC LIMIT 1`,
      );
      const seedProjectId = seededProjects.rows[0]!.id;
      await seedAttachmentRow(seedProjectId, 'atom1');
      const beforeAttachments = await countAttachments();
      expect(beforeAttachments).toBeGreaterThanOrEqual(1);

      try {
        // Force a rollback with a structurally invalid override envelope
        // (a project pointing at a non-existent customerId in the same
        // envelope). The whole transaction must abort — attachments
        // restored to their pre-call state, business rows unchanged.
        const broken = buildOverrideEnvelope();
        broken.projects[0]!.customerId = UUID_ZERO;
        const err = await expectImportRejection(broken as unknown as Envelope, {
          dryRun: false,
          override: true,
          confirmationPhrase: EXPECTED_RESTORE_PHRASE,
        });
        expect(err.statusCode).toBeGreaterThanOrEqual(400);

        // Atomicity: the seeded attachment row survives, because the
        // truncate sat inside the rolled-back transaction.
        expect(await countAttachments()).toBe(beforeAttachments);
      } finally {
        await reseed();
      }
    });
  });

  // ---------------------------------------------------------------
  // Issue #163 follow-up: the override path TRUNCATEs the attachments
  // table but does not, on its own, touch the bytes in the bucket.
  // The pending-orphan reaper only sweeps `status='pending'` rows; the
  // bucket lifecycle (per ADR-0022) reaps noncurrent versions only —
  // so a truncate-without-hide leaves the prior bytes as the current
  // version of an unreferenced key, never reaped. The fix mirrors the
  // project-purge cascade (AC-218): collect the keys before the wipe
  // and hide them after commit so the prior version is demoted to
  // noncurrent, and lifecycle takes it from there. (See #169 for the
  // generic orphan sweeper that catches every other path.)
  // ---------------------------------------------------------------
  describe('Issue #163 follow-up: override-import hides prior attachment objects', () => {
    let storage: AttachmentStorageClient;

    beforeAll(() => {
      const env = getEnv();
      storage = createStorageClient({
        endpoint: env.STORAGE_ENDPOINT!,
        bucket: env.STORAGE_BUCKET,
        accessKey: env.STORAGE_ACCESS_KEY!,
        secretKey: env.STORAGE_SECRET_KEY!,
      });
    });

    async function objectAbsent(key: string): Promise<boolean> {
      try {
        await storage.download(key);
        return false;
      } catch {
        return true;
      }
    }

    it('writes a delete marker for every prior attachment object on successful override-import', async () => {
      const seededProjects = await db.execute<{ id: string }>(
        sql`SELECT id FROM projects ORDER BY id ASC LIMIT 1`,
      );
      expect(seededProjects.rows.length).toBeGreaterThanOrEqual(1);
      const projectId = seededProjects.rows[0]!.id;

      // Seed a `ready` row + push real bytes to storage so the
      // post-call assertion meaningfully distinguishes "object hidden"
      // from "object never uploaded". Use a deterministic UUID so the
      // assertion targets a known key.
      const id = 'aaaaaaaa-1111-4000-8000-000000000169';
      const originalKey = `attachments/${projectId}/${id}.orig`;
      const wrappedDek = Buffer.alloc(192, 0x33).toString('base64');
      await db.execute(sql`
        INSERT INTO attachments
          (id, project_id, status, kind, label, filename, mime_type, size_bytes,
           ciphertext_size_bytes,
           original_key, thumb_key, has_thumbnail,
           wrapped_dek, wrapped_thumb_dek, wrapped_dek_version)
        VALUES (${id}, ${projectId}, 'ready', 'binary', 'sonstiges',
                'leak-fixture.pdf', 'application/pdf', 100,
                164,
                ${originalKey}, NULL, FALSE,
                ${wrappedDek}, NULL, 1)
      `);
      await storage.upload(originalKey, Buffer.from('orig-bytes'), 'application/octet-stream');

      // Pre-state sanity: the seeded object is retrievable.
      expect(await objectAbsent(originalKey)).toBe(false);

      try {
        // Pass this test's own storage instance so the hide side-effect
        // lands on the bucket this test inspects (issue #163).
        const envelope = buildOverrideEnvelope();
        await importEnvelope(
          envelope as unknown as Envelope,
          { dryRun: false, override: true, confirmationPhrase: EXPECTED_RESTORE_PHRASE },
          { storage },
        );

        // The hide call wrote a delete marker — GET without versionId
        // returns 404. The prior version is now a noncurrent version
        // and the bucket lifecycle reaps it on its own clock per
        // ADR-0022.
        expect(await objectAbsent(originalKey)).toBe(true);
      } finally {
        await reseed();
      }
    });

    it('leaves prior storage objects untouched when the override import is rejected', async () => {
      const seededProjects = await db.execute<{ id: string }>(
        sql`SELECT id FROM projects ORDER BY id ASC LIMIT 1`,
      );
      expect(seededProjects.rows.length).toBeGreaterThanOrEqual(1);
      const projectId = seededProjects.rows[0]!.id;

      // Seed a real uploaded object. A failed override-import must
      // leave it retrievable — the hide path must NOT fire on the
      // rollback branch.
      const id = 'aaaaaaaa-2222-4000-8000-000000000169';
      const originalKey = `attachments/${projectId}/${id}.orig`;
      const wrappedDek = Buffer.alloc(192, 0x44).toString('base64');
      await db.execute(sql`
        INSERT INTO attachments
          (id, project_id, status, kind, label, filename, mime_type, size_bytes,
           ciphertext_size_bytes,
           original_key, thumb_key, has_thumbnail,
           wrapped_dek, wrapped_thumb_dek, wrapped_dek_version)
        VALUES (${id}, ${projectId}, 'ready', 'binary', 'sonstiges',
                'rollback-fixture.pdf', 'application/pdf', 100,
                164,
                ${originalKey}, NULL, FALSE,
                ${wrappedDek}, NULL, 1)
      `);
      await storage.upload(originalKey, Buffer.from('rollback'), 'application/octet-stream');

      try {
        // Force a validation rejection — same trick as the existing
        // AC-254 atomicity test: a project pointing at a missing
        // customer in the same envelope.
        const broken = buildOverrideEnvelope();
        broken.projects[0]!.customerId = UUID_ZERO;
        const err = await expectImportRejection(
          broken as unknown as Envelope,
          { dryRun: false, override: true, confirmationPhrase: EXPECTED_RESTORE_PHRASE },
          { storage },
        );
        expect(err.statusCode).toBeGreaterThanOrEqual(400);

        // No commit ⇒ no hide. The seeded object is still the current
        // version and remains retrievable.
        expect(await objectAbsent(originalKey)).toBe(false);
      } finally {
        // Manual cleanup: the row + object are still present. Hide
        // the object directly so the next describe block starts
        // clean, then reseed (which cascades the row away via FK).
        await storage.hide(originalKey);
        await reseed();
      }
    });
  });
});
