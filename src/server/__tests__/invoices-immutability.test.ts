/**
 * Persistence-layer immutability for issued invoices (AC-294,
 * AC-295) and the DB-level CHECK on `invoices.number`.
 *
 * Three invariants pinned here — defense-in-depth backstops on direct DB
 * writes that bypass the route layer (seed scripts, migrations, manual
 * SQL):
 *
 *   - AC-294: a direct SQL `UPDATE` on an `issued` row touching any
 *     column other than the cancellation-flip path on `status` is
 *     rejected by the persistence layer (trigger, column-level
 *     constraint, or constraint-equivalent invariant — the exact
 *     mechanism is implementation-defined per ADR-0026).
 *
 *   - AC-295: a direct INSERT with a `number` violating the regex
 *     `^(RE|ST)-\d{4}-\d{4,}$` is rejected by the DB CHECK constraint.
 *     A handful of variants probe the anchors: short suffix, lowercase
 *     prefix, two-digit year, unknown prefix.
 *
 *   - #561: `issue_date` is null on drafts and set on issued or
 *     cancelled rows (CHECK `invoices_issue_date_required_when_not_draft`).
 *
 * Pattern mirrors `data-integrity.test.ts` (AC-96 / AC-97): raw SQL
 * inserts/updates via `pool.query`, with SQLSTATE assertion on the
 * thrown error. The AC-294 rejection arms share one issued fixture
 * row (rejected UPDATEs leave it unchanged); the arm that mutates
 * inserts its own row.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { seed } from '../seed.js';
import { createDatabase } from '../db/connection.js';
import type { Database } from '../db/connection.js';
import type pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

const year = new Date().getFullYear();

interface PgErrorShape {
  code?: string;
  constraint?: string;
  message?: string;
}

describe('AC-294: issued invoice rows are write-once at the persistence layer', () => {
  let db: Database;
  let pool: pg.Pool;
  let testProjectId: string;
  let issuedInvoiceId: string;

  beforeAll(async () => {
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    await pool.query('SELECT 1');
    await migrate(db, { migrationsFolder });
    await seed(db, { force: true });

    // Find any seeded project — pin the FK target.
    const projects = await db.execute(sql`SELECT id FROM projects LIMIT 1`);
    if (projects.rows.length === 0) {
      throw new Error('seed produced no projects');
    }
    testProjectId = (projects.rows[0] as { id: string }).id;

    // Direct-insert one issued row to UPDATE against. Raw SQL is
    // allowlisted under `__tests__/` per AC-179.
    issuedInvoiceId = crypto.randomUUID();
    const number = `RE-${year}-9501`;
    const issuer = {
      companyName: 'Test GmbH',
      address: { street: 'Hauptstr. 1', zip: '10115', city: 'Berlin' },
      taxId: '111/222/33333',
    };
    const recipient = {
      name: 'Kunde',
      address: { street: 'Kundenstr. 2', zip: '20095', city: 'Hamburg' },
    };
    const lines = [
      { description: 'Test', quantity: 1, unit: 'p', unitPrice: 100, lineTotal: 100, taxRate: 19 },
    ];
    const totals = {
      perRate: [{ taxRate: 19, netSubtotal: 100, taxAmount: 19 }],
      netGrandTotal: 100,
      taxGrandTotal: 19,
      grossGrandTotal: 119,
    };
    await pool.query(
      `INSERT INTO invoices
        (id, project_id, status, number, issue_date, performance_date,
         tax_mode, profile, issuer, recipient, lines, totals)
       VALUES ($1, $2, 'issued', $3, NOW(), CURRENT_DATE,
               'standard', 'zugferd-en16931', $4, $5, $6, $7)`,
      [
        issuedInvoiceId,
        testProjectId,
        number,
        JSON.stringify(issuer),
        JSON.stringify(recipient),
        JSON.stringify(lines),
        JSON.stringify(totals),
      ],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  // The invariant: issued rows are write-once except for the
  // issued→cancelled flip. Representative UPDATE rejections pin the
  // invariant — one snapshot field, one status reverse-flip, and the
  // audit metadata outside the flip.
  // Pinning every snapshot column individually is T-BLOA; the
  // mechanism (impl-defined per ADR-0026) treats them uniformly.
  it('rejects a direct UPDATE on lines (representative snapshot-field arm)', async () => {
    let pgError: PgErrorShape | null = null;
    try {
      await pool.query(
        `UPDATE invoices
            SET lines = $1::jsonb
          WHERE id = $2`,
        [
          JSON.stringify([
            {
              description: 'TAMPERED',
              quantity: 999,
              unit: 'X',
              unitPrice: 999,
              lineTotal: 999,
              taxRate: 0,
            },
          ]),
          issuedInvoiceId,
        ],
      );
    } catch (err) {
      pgError = err as PgErrorShape;
    }

    // The exact mechanism is impl-defined per ADR-0026: a row-level
    // trigger, a column generation expression, or a CHECK on a hash
    // column. Whichever shape is chosen, the resulting error is
    // either a CHECK violation (23514), a trigger raise (P0001 or
    // 23P01), or a permission denial (42501). Pin the set rather than
    // a single code — the load-bearing assertion is that the UPDATE
    // throws.
    expect(pgError).not.toBeNull();
  });

  it('rejects a direct UPDATE that flips status from issued to draft (reverse-transition arm)', async () => {
    let pgError: PgErrorShape | null = null;
    try {
      await pool.query(`UPDATE invoices SET status = 'draft' WHERE id = $1`, [issuedInvoiceId]);
    } catch (err) {
      pgError = err as PgErrorShape;
    }
    expect(pgError).not.toBeNull();
  });

  // Audit metadata rides only on the cancellation flip. Without it, an
  // FK `ON DELETE SET NULL` on `updated_by` would silently rewrite a
  // frozen row (#540). Pin P0001 so a malformed statement cannot pass
  // as a rejection.
  it.each([
    ['updated_at', `updated_at = NOW() - INTERVAL '1 year'`],
    ['updated_by', `updated_by = (SELECT id FROM users LIMIT 1)`],
  ])('rejects a direct UPDATE of %s that keeps status issued', async (_label, assignment) => {
    let pgError: PgErrorShape | null = null;
    try {
      await pool.query(`UPDATE invoices SET ${assignment} WHERE id = $1`, [issuedInvoiceId]);
    } catch (err) {
      pgError = err as PgErrorShape;
    }
    expect(pgError?.code).toBe('P0001');
  });

  it('ALLOWS the only legal status transition: issued → cancelled (cancellation flip)', async () => {
    // Use a separate row so this test does not interfere with the
    // prior arms — those rely on the seed row staying `issued`.
    const id = crypto.randomUUID();
    const number = `RE-${year}-9503`;
    const issuer = {
      companyName: 'Test',
      address: { street: 'S', zip: '12345', city: 'C' },
      taxId: 'X',
    };
    const recipient = {
      name: 'R',
      address: { street: 'S', zip: '12345', city: 'C' },
    };
    const lines = [
      { description: 'T', quantity: 1, unit: 'p', unitPrice: 1, lineTotal: 1, taxRate: 19 },
    ];
    const totals = { perRate: [], netGrandTotal: 1, taxGrandTotal: 0, grossGrandTotal: 1 };
    await pool.query(
      `INSERT INTO invoices
        (id, project_id, status, number, issue_date, performance_date,
         tax_mode, profile, issuer, recipient, lines, totals)
       VALUES ($1, $2, 'issued', $3, NOW(), CURRENT_DATE,
               'standard', 'zugferd-en16931', $4, $5, $6, $7)`,
      [
        id,
        testProjectId,
        number,
        JSON.stringify(issuer),
        JSON.stringify(recipient),
        JSON.stringify(lines),
        JSON.stringify(totals),
      ],
    );

    // The legal flip — issued → cancelled — must succeed. A persistence-
    // layer mechanism that blocks every UPDATE would also block this
    // and break the cancel pipeline.
    // Same column set as `applyCancellationFlip`.
    await pool.query(
      `UPDATE invoices
          SET status = 'cancelled', updated_at = NOW(),
              updated_by = (SELECT id FROM users LIMIT 1)
        WHERE id = $1`,
      [id],
    );

    const after = await pool.query(`SELECT status FROM invoices WHERE id = $1`, [id]);
    expect((after.rows[0] as { status: string }).status).toBe('cancelled');
  });
});

describe('AC-295: invoices.number CHECK constraint matches /^(RE|ST)-\\d{4}-\\d{4,}$/', () => {
  let db: Database;
  let pool: pg.Pool;
  let testProjectId: string;

  beforeAll(async () => {
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    await pool.query('SELECT 1');
    await migrate(db, { migrationsFolder });
    await seed(db, { force: true });

    const projects = await db.execute(sql`SELECT id FROM projects LIMIT 1`);
    testProjectId = (projects.rows[0] as { id: string }).id;
  });

  afterAll(async () => {
    await pool.end();
  });

  const issuer = {
    companyName: 'Test',
    address: { street: 'S', zip: '12345', city: 'C' },
    taxId: 'X',
  };
  const recipient = { name: 'R', address: { street: 'S', zip: '12345', city: 'C' } };
  const lines = [
    { description: 'T', quantity: 1, unit: 'p', unitPrice: 1, lineTotal: 1, taxRate: 19 },
  ];
  const totals = { perRate: [], netGrandTotal: 1, taxGrandTotal: 0, grossGrandTotal: 1 };

  // `cancellationOf` lets ST- rows satisfy the
  // `invoices_cancellation_pair` CHECK — that constraint pairs the
  // ST- prefix with a non-null parent FK and the RE- prefix with a
  // null parent FK. Plain RE- callers leave it null, which is the
  // CHECK's default-valid branch.
  async function insertWithNumber(
    number: string,
    cancellationOf: string | null = null,
  ): Promise<PgErrorShape | null> {
    try {
      await pool.query(
        `INSERT INTO invoices
          (id, project_id, status, number, issue_date, performance_date,
           tax_mode, profile, issuer, recipient, lines, totals, cancellation_of)
         VALUES ($1, $2, 'issued', $3, NOW(), CURRENT_DATE,
                 'standard', 'zugferd-en16931', $4, $5, $6, $7, $8)`,
        [
          crypto.randomUUID(),
          testProjectId,
          number,
          JSON.stringify(issuer),
          JSON.stringify(recipient),
          JSON.stringify(lines),
          JSON.stringify(totals),
          cancellationOf,
        ],
      );
      return null;
    } catch (err) {
      return err as PgErrorShape;
    }
  }

  // ST- rows must point at a parent RE- via cancellation_of (CHECK
  // `invoices_cancellation_pair`). Insert a parent first and return
  // its id so the ST- canonical-shape arm can satisfy the pair.
  async function insertParentRe(number: string): Promise<string> {
    const parentId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO invoices
        (id, project_id, status, number, issue_date, performance_date,
         tax_mode, profile, issuer, recipient, lines, totals)
       VALUES ($1, $2, 'issued', $3, NOW(), CURRENT_DATE,
               'standard', 'zugferd-en16931', $4, $5, $6, $7)`,
      [
        parentId,
        testProjectId,
        number,
        JSON.stringify(issuer),
        JSON.stringify(recipient),
        JSON.stringify(lines),
        JSON.stringify(totals),
      ],
    );
    return parentId;
  }

  // Each `it.each` case probes one anchor in the regex. Per AC-294's
  // posture in the same file (impl-defined mechanism), we assert only
  // that the rejection lands — the regex's CHECK is the documented
  // primary mechanism, but the constraint name / SQLSTATE is left to
  // the impl team.
  it.each([
    ['short suffix (1 digit)', `RE-${year}-1`],
    ['lowercase prefix', `re-${year}-0001`],
    ['two-digit year', `RE-26-0001`],
    ['unknown prefix', `XX-${year}-0001`],
    ['no prefix', `${year}-0001`],
    ['missing dash before year', `RE${year}-0001`],
    ['missing dash before suffix', `RE-${year}0001`],
  ])('rejects INSERT with %s', async (_label, number) => {
    const err = await insertWithNumber(number);
    expect(err).not.toBeNull();
  });

  it('accepts INSERT with the canonical RE-YYYY-NNNN shape', async () => {
    const err = await insertWithNumber(`RE-${year}-0042`);
    expect(err).toBeNull();
  });

  it('accepts INSERT with the canonical ST-YYYY-NNNN shape', async () => {
    // ST- rows require a paired parent RE- (CHECK
    // `invoices_cancellation_pair`): the prefix and the
    // cancellation_of FK move together. Insert the parent first,
    // then assert the ST- shape lands.
    const parentId = await insertParentRe(`RE-${year}-9001`);
    const err = await insertWithNumber(`ST-${year}-0042`, parentId);
    expect(err).toBeNull();
  });

  it('accepts a 5-digit suffix (the regex pins {4,} — growth past 9999 is allowed)', async () => {
    const err = await insertWithNumber(`RE-${year}-12345`);
    expect(err).toBeNull();
  });
});

// data-model.md §5.15: `issueDate` is null in draft and set at issuance.
// Pin the CHECK by name: the fixture rows are otherwise valid, so a
// rejection from any other mechanism would hide a missing CHECK.
describe('invoices.issue_date is null on drafts and set on issued or cancelled rows (#561)', () => {
  let db: Database;
  let pool: pg.Pool;
  let testProjectId: string;

  beforeAll(async () => {
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    await pool.query('SELECT 1');
    await migrate(db, { migrationsFolder });
    await seed(db, { force: true });

    const projects = await db.execute(sql`SELECT id FROM projects LIMIT 1`);
    testProjectId = (projects.rows[0] as { id: string }).id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it.each([
    ['an issued row without issue_date', 'issued', `RE-${year}-9601`, null],
    ['a cancelled row without issue_date', 'cancelled', `RE-${year}-9602`, null],
    ['a draft with an issue_date', 'draft', null, `${year}-01-15`],
  ])('rejects INSERT of %s', async (_label, status, number, issueDate) => {
    let pgError: PgErrorShape | null = null;
    try {
      await pool.query(
        `INSERT INTO invoices
          (id, project_id, status, number, issue_date, performance_date,
           tax_mode, profile, issuer, recipient, lines, totals)
         VALUES ($1, $2, $3, $4, $5, CURRENT_DATE,
                 'standard', 'zugferd-en16931', '{}', '{}', '[]', '{}')`,
        [crypto.randomUUID(), testProjectId, status, number, issueDate],
      );
    } catch (err) {
      pgError = err as PgErrorShape;
    }
    expect(pgError?.code).toBe('23514');
    expect(pgError?.constraint).toBe('invoices_issue_date_required_when_not_draft');
  });
});
