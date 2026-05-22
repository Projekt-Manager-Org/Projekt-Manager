/**
 * API integration tests — Layer 1 export envelope shape, issue #230.
 *
 * Pins the export-side contract for the expanded envelope that landed on
 * branch `feat/230-expand-layer1-envelope`: `users`, `company_profile`,
 * `invoices`, and `invoice_sequence` now ride the envelope alongside the
 * original three (customers / projects / project_workers) plus the
 * metadata-only `attachments` slot. Also pins `customers[*].ustId`, which
 * the schema has carried since invoicing landed but the envelope shape
 * was missing pre-#230.
 *
 * Scope is intentionally narrow: assertions target the export surface
 * only (no `/api/import` round-trip). The ImportService side of the same
 * issue lands on a sibling agent's commit; AT-77-style byte-stable
 * round-trip coverage moves with that surface.
 *
 * Why a separate test file rather than extending `data-exchange.test.ts`:
 * the legacy file's fixtures pin `CURRENT_SCHEMA_VERSION = 2` and assert
 * `users` / `passwordHash` are NOT serialized — both of those expectations
 * inverted at the contract bump (commit
 * `9559893 feat(daten): expand envelope contract to cover all business data`).
 * Updating those assertions belongs to the import agent's commit;
 * isolating the new export assertions here keeps the boundary clean.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';

import { startApp, stopApp, login, authGet } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import { SCHEMA_VERSION } from '../../domain/dataExchange.js';
import type { Database } from '../db/connection.js';
import type pg from 'pg';

/**
 * Wire-shape assertion target. Matches the `Envelope` type from
 * `src/domain/dataExchange.ts` post-#230 — kept as a free-form record
 * here so the assertions read tightly without re-pulling every domain
 * import. The full domain shape is the build-time contract; this is the
 * runtime mirror.
 */
interface ExportEnvelopeV3 {
  schema_version: number;
  exported_at: string;
  users: Array<{
    id: string;
    username: string;
    displayName: string;
    passwordHash: string;
    roles: string[];
    email: string | null;
    active: boolean;
    themePreference: 'light' | 'dark' | 'system';
    pushMuted: boolean;
    createdAt: string;
    updatedAt: string;
    lastLoginAt: string | null;
    createdBy: string | null;
    updatedBy: string | null;
  }>;
  company_profile: Array<{
    id: string;
    companyName: string;
    address: { street: string; zip: string; city: string };
    taxId: string;
    ustId: string | null;
    iban: string | null;
    accentColor: string | null;
    footerText: string | null;
    logoBinaryDescriptorId: string | null;
    defaultTaxMode: 'standard' | 'kleinunternehmer' | 'reverse_charge';
    updatedAt: string;
    updatedBy: string | null;
  }>;
  customers: Array<{
    id: string;
    name: string;
    ustId: string | null;
    [key: string]: unknown;
  }>;
  projects: Array<{ id: string; [key: string]: unknown }>;
  project_workers: Array<{ projectId: string; userId: string }>;
  invoices: Array<{
    id: string;
    status: 'draft' | 'issued' | 'cancelled';
    number: string | null;
    issueDate: string | null;
    performanceDate: string | null;
    cancellationOf: string | null;
    [key: string]: unknown;
  }>;
  invoice_sequence: Array<{
    year: number;
    kind: 'invoice' | 'storno';
    nextValue: number;
    updatedAt: string;
  }>;
  attachments: Array<{ id: string; [key: string]: unknown }>;
}

describe('GET /api/export — Layer 1 envelope v3 (issue #230)', () => {
  let ownerToken: string;
  let db: Database;
  let pool: pg.Pool;

  beforeAll(async () => {
    await startApp();
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    if (pool) await pool.end();
    await stopApp();
  });

  // -------------------------------------------------------------------
  // Schema version + top-level slot presence
  // -------------------------------------------------------------------
  describe('envelope top-level shape', () => {
    it('stamps SCHEMA_VERSION = 3 (the contract bump for #230)', async () => {
      const res = await authGet(ownerToken, '/api/export');
      expect(res.statusCode).toBe(200);
      const env = res.json() as ExportEnvelopeV3;
      // Mirrors the source-of-truth import — a future re-bump must update
      // both this assertion and the domain constant in one commit.
      expect(env.schema_version).toBe(SCHEMA_VERSION);
      expect(env.schema_version).toBe(3);
    });

    it('emits every documented top-level slot, including the four #230 additions', async () => {
      const res = await authGet(ownerToken, '/api/export');
      const env = res.json() as ExportEnvelopeV3;
      expect(Array.isArray(env.users)).toBe(true);
      expect(Array.isArray(env.company_profile)).toBe(true);
      expect(Array.isArray(env.customers)).toBe(true);
      expect(Array.isArray(env.projects)).toBe(true);
      expect(Array.isArray(env.project_workers)).toBe(true);
      expect(Array.isArray(env.invoices)).toBe(true);
      expect(Array.isArray(env.invoice_sequence)).toBe(true);
      expect(Array.isArray(env.attachments)).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Users — every row including inactive; passwordHash rides verbatim
  // (no obfuscation, no length-stripping; the threat-model note on
  // EnvelopeUser pins this).
  // -------------------------------------------------------------------
  describe('users slot', () => {
    it('exports every seeded user row, including inactive accounts', async () => {
      const res = await authGet(ownerToken, '/api/export');
      const env = res.json() as ExportEnvelopeV3;

      // The seed mints 6 users (5 active + 1 inactive — see
      // src/test/seedAssumptions.ts SEED_USERS).
      expect(env.users.length).toBe(6);
      const usernames = env.users.map((u) => u.username).sort();
      expect(usernames).toEqual(
        ['arbeiter1', 'arbeiter2', 'buchhalter', 'buero', 'deaktiviert', 'inhaber'].sort(),
      );

      const inactive = env.users.find((u) => u.username === 'deaktiviert');
      expect(inactive).toBeDefined();
      expect(inactive!.active).toBe(false);
    });

    it('ships passwordHash verbatim (no redaction)', async () => {
      const res = await authGet(ownerToken, '/api/export');
      const env = res.json() as ExportEnvelopeV3;

      // Cross-check the bytes against the DB directly — a regression that
      // replaced the hash with a fixed sentinel or null would slip past a
      // typeof-string check.
      const dbRows = await db.execute<{ id: string; password_hash: string }>(
        sql`SELECT id, password_hash FROM users ORDER BY id ASC`,
      );
      const dbHashById = new Map(dbRows.rows.map((r) => [r.id, r.password_hash]));

      expect(env.users.length).toBe(dbHashById.size);
      for (const u of env.users) {
        expect(typeof u.passwordHash).toBe('string');
        expect(u.passwordHash.length).toBeGreaterThan(0);
        expect(u.passwordHash).toBe(dbHashById.get(u.id));
      }
    });

    it('orders users by id ASC (deterministic for byte-stable round-trip)', async () => {
      const res = await authGet(ownerToken, '/api/export');
      const env = res.json() as ExportEnvelopeV3;
      const ids = env.users.map((u) => u.id);
      const sorted = [...ids].sort();
      expect(ids).toEqual(sorted);
    });
  });

  // -------------------------------------------------------------------
  // company_profile — singleton-array (schema enforces UNIQUE(singleton)
  // + CHECK(singleton = true); contract documents the array carrier).
  // -------------------------------------------------------------------
  describe('company_profile slot', () => {
    it('is a singleton-array (exactly one row)', async () => {
      const res = await authGet(ownerToken, '/api/export');
      const env = res.json() as ExportEnvelopeV3;
      expect(env.company_profile.length).toBe(1);
    });

    it('carries the seeded fixture values (sanity that the seed snapshot landed)', async () => {
      const res = await authGet(ownerToken, '/api/export');
      const env = res.json() as ExportEnvelopeV3;
      const profile = env.company_profile[0]!;
      // Mirrors the seed insert in src/server/seed.ts; if the seed's
      // values change, this test fails loudly so the assertion is kept
      // honest — the export must reflect what the seed wrote, not a
      // separately-maintained literal.
      expect(profile.companyName).toBe('Maler Berger GmbH');
      expect(profile.address).toEqual({ street: 'Werkstr. 1', zip: '10115', city: 'Berlin' });
      expect(profile.taxId).toBe('111/222/33333');
      expect(profile.ustId).toBe('DE123456789');
      expect(profile.iban).toBe('DE12 1000 0000 1234 5678 90');
      expect(profile.defaultTaxMode).toBe('standard');
      // ISO 8601 — parseable.
      expect(Number.isNaN(Date.parse(profile.updatedAt))).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // customers.ustId — pre-existing schema drift (the schema has carried
  // the field since invoicing landed; the envelope shape was missing it).
  // The field now rides through verbatim per the contract bump.
  // -------------------------------------------------------------------
  describe('customers.ustId field round-trip', () => {
    it('emits ustId on every customer row, defaulting to null when unset', async () => {
      const res = await authGet(ownerToken, '/api/export');
      const env = res.json() as ExportEnvelopeV3;

      // Every customer carries the field — null for the unset arm,
      // string for the set arm. The seed has no customer with a non-
      // null ustId by default (every CUSTOMER_SPEC omits it), so the
      // baseline check is that the field is present and null on every
      // row.
      expect(env.customers.length).toBeGreaterThan(0);
      for (const c of env.customers) {
        expect(c).toHaveProperty('ustId');
        expect(c.ustId === null || typeof c.ustId === 'string').toBe(true);
      }
    });

    it('reflects a non-null ustId direct-DB write on the export', async () => {
      // Direct-SQL update on the first seeded customer so the populated
      // arm of the field is exercised. Using `RETURNING id` keeps the
      // mutation idempotent across re-runs (no second customer needed,
      // no cleanup required — the seed runs `force: true` next time).
      const updated = await db.execute<{ id: string }>(
        sql`UPDATE customers
            SET ust_id = 'DE246800001'
            WHERE id = (SELECT id FROM customers ORDER BY id ASC LIMIT 1)
            RETURNING id`,
      );
      const targetId = updated.rows[0]!.id;

      try {
        const res = await authGet(ownerToken, '/api/export');
        const env = res.json() as ExportEnvelopeV3;
        const target = env.customers.find((c) => c.id === targetId);
        expect(target).toBeDefined();
        expect(target!.ustId).toBe('DE246800001');
      } finally {
        // Restore baseline so downstream tests in the file see the
        // canonical seeded state.
        await db.execute(sql`UPDATE customers SET ust_id = NULL WHERE id = ${targetId}`);
      }
    });
  });

  // -------------------------------------------------------------------
  // invoices — ordering puts `cancellation_of IS NULL` rows first; id
  // ASC as tiebreaker so the round-trip is byte-stable.
  // -------------------------------------------------------------------
  describe('invoices slot ordering', () => {
    it('emits the seeded invoice rows (originals + at least one Storno)', async () => {
      const res = await authGet(ownerToken, '/api/export');
      const env = res.json() as ExportEnvelopeV3;

      // The seed mints at least one cancellation pair (RE-0001 →
      // ST-0001 + RE-0002 reissue per src/server/seed/invoices.ts), so
      // both arms of the ordering check have row coverage.
      expect(env.invoices.length).toBeGreaterThan(0);
      const stornos = env.invoices.filter((i) => i.cancellationOf !== null);
      const originals = env.invoices.filter((i) => i.cancellationOf === null);
      expect(stornos.length).toBeGreaterThan(0);
      expect(originals.length).toBeGreaterThan(0);
    });

    it('orders originals (cancellation_of IS NULL) before Stornos; id ASC tiebreaker', async () => {
      const res = await authGet(ownerToken, '/api/export');
      const env = res.json() as ExportEnvelopeV3;

      // Find the first Storno — every preceding row must have a null
      // cancellationOf. This is the importer's two-pass-insert
      // precondition (originals first so the self-FK target exists
      // when the Storno row is inserted).
      const firstStornoIdx = env.invoices.findIndex((i) => i.cancellationOf !== null);
      expect(firstStornoIdx).toBeGreaterThan(0);
      for (let i = 0; i < firstStornoIdx; i++) {
        expect(env.invoices[i]!.cancellationOf).toBeNull();
      }

      // Within each half, id ASC is the documented tiebreaker — pin
      // that so a future ordering tweak that re-sorted on createdAt or
      // number would surface here.
      const originals = env.invoices.filter((i) => i.cancellationOf === null);
      const originalIds = originals.map((i) => i.id);
      expect(originalIds).toEqual([...originalIds].sort());
      const stornos = env.invoices.filter((i) => i.cancellationOf !== null);
      const stornoIds = stornos.map((i) => i.id);
      expect(stornoIds).toEqual([...stornoIds].sort());
    });

    it('formats issueDate / performanceDate as YYYY-MM-DD strings (date columns, not timestamps)', async () => {
      const res = await authGet(ownerToken, '/api/export');
      const env = res.json() as ExportEnvelopeV3;
      const issued = env.invoices.find((i) => i.status !== 'draft');
      expect(issued).toBeDefined();
      expect(issued!.issueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(issued!.performanceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  // -------------------------------------------------------------------
  // invoice_sequence — at least one row per (year, kind) the seed
  // exercises; deterministic ordering by (year ASC, kind ASC).
  // -------------------------------------------------------------------
  describe('invoice_sequence slot', () => {
    it('emits the per-(year, kind) counter rows the seed allocated', async () => {
      const res = await authGet(ownerToken, '/api/export');
      const env = res.json() as ExportEnvelopeV3;

      // Seed issues invoices across 2024 / 2025 / 2026 and at least
      // one cancellation, so both `invoice` and `storno` sub-sequences
      // must have rows.
      expect(env.invoice_sequence.length).toBeGreaterThan(0);
      const kinds = new Set(env.invoice_sequence.map((s) => s.kind));
      expect(kinds.has('invoice')).toBe(true);
      expect(kinds.has('storno')).toBe(true);

      // `nextValue` is bigint (mode: 'number') — JS number through the
      // wire, never a string.
      for (const s of env.invoice_sequence) {
        expect(typeof s.nextValue).toBe('number');
        expect(s.nextValue).toBeGreaterThanOrEqual(1);
        expect(['invoice', 'storno']).toContain(s.kind);
      }
    });

    it('orders rows by (year ASC, kind ASC)', async () => {
      const res = await authGet(ownerToken, '/api/export');
      const env = res.json() as ExportEnvelopeV3;
      const keys = env.invoice_sequence.map((s) => `${s.year}|${s.kind}`);
      const sorted = [...keys].sort();
      expect(keys).toEqual(sorted);
    });
  });

  // -------------------------------------------------------------------
  // Snapshot consistency — every new slot rides the same REPEATABLE
  // READ transaction. A simpler-than-MVCC sanity check: every users.id
  // referenced by `customers.createdBy` / `projects.createdBy` / etc.
  // resolves against `env.users`, so an export that read users and
  // customers from different snapshots can't slip through.
  // -------------------------------------------------------------------
  describe('snapshot consistency across slots', () => {
    it('every non-null user reference on customers/projects resolves to an env.users row', async () => {
      const res = await authGet(ownerToken, '/api/export');
      const env = res.json() as ExportEnvelopeV3;
      const userIds = new Set(env.users.map((u) => u.id));

      // The seed sets createdBy/updatedBy to null for business rows
      // (customers / projects mint via ImportService without an actor)
      // but the audit-field plumbing surface still allows them. Iterate
      // every row and check the non-null arm — a future seed that
      // populates the field has the assertion ready.
      for (const c of env.customers) {
        const createdBy = c.createdBy as string | null | undefined;
        const updatedBy = c.updatedBy as string | null | undefined;
        if (createdBy) expect(userIds.has(createdBy)).toBe(true);
        if (updatedBy) expect(userIds.has(updatedBy)).toBe(true);
      }
      for (const p of env.projects) {
        const createdBy = p.createdBy as string | null | undefined;
        const updatedBy = p.updatedBy as string | null | undefined;
        if (createdBy) expect(userIds.has(createdBy)).toBe(true);
        if (updatedBy) expect(userIds.has(updatedBy)).toBe(true);
      }
      // project_workers.userId is NOT NULL — every row must resolve.
      for (const a of env.project_workers) {
        expect(userIds.has(a.userId)).toBe(true);
      }
    });
  });
});
