/**
 * Business-data export and restore — database-wide operations over the
 * importable set (ADR-0018, data-model.md §5.8).
 *
 * The snapshot read opens its own transaction: its options are what make it
 * one consistent snapshot. The restore steps run in the caller's
 * transaction, in the order `ImportService` calls them; the writes take a
 * `MutatingDatabase`, which the restore gets as a named audit exemption
 * (ADR-0021).
 */

import { asc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Database, MutatingDatabase, TransactionalDatabase } from '../db/connection.js';
import {
  attachments,
  companyProfile,
  customers,
  invoiceSequence,
  invoices,
  projects,
  projectWorkers,
  users,
} from '../db/schema.js';

/** Every row of the importable set, in the export's deterministic order. */
export async function readBusinessSnapshot(db: Database) {
  return db.transaction(
    async (tx) => {
      // Sequential — drizzle runs each tx query on the same pg client, so
      // Promise.all here would trigger pg's "concurrent query" deprecation
      // warning without any real parallelism.
      const userRows = await tx.select().from(users).orderBy(asc(users.id));
      // Singleton table — one row enforced by UNIQUE(singleton) +
      // CHECK(singleton = true). The `ORDER BY id ASC` is defensive
      // uniformity: it costs nothing and pins ordering if a future
      // migration ever relaxes the singleton invariant.
      const companyProfileRows = await tx
        .select()
        .from(companyProfile)
        .orderBy(asc(companyProfile.id));
      const customerRows = await tx.select().from(customers).orderBy(asc(customers.id));
      const projectRows = await tx.select().from(projects).orderBy(asc(projects.id));
      const assignmentRows = await tx
        .select()
        .from(projectWorkers)
        .orderBy(asc(projectWorkers.projectId), asc(projectWorkers.userId));
      // Originals first, Stornos second, `id` ASC as the tiebreaker, so a
      // re-export is byte-stable. The importer re-sorts on its own, since a
      // hand-edited envelope may reorder. DESC on the boolean
      // `(cancellation_of IS NULL)` puts TRUE (originals) first.
      const invoiceRows = await tx
        .select()
        .from(invoices)
        .orderBy(sql`(${invoices.cancellationOf} IS NULL) DESC`, asc(invoices.id));
      const invoiceSequenceRows = await tx
        .select()
        .from(invoiceSequence)
        .orderBy(asc(invoiceSequence.year), asc(invoiceSequence.kind));
      // AC-431: only ready rows travel in the envelope. Pending rows
      // represent uncommitted uploads and are excluded by design.
      const attachmentRows = await tx
        .select()
        .from(attachments)
        .where(eq(attachments.status, 'ready'))
        .orderBy(asc(attachments.id));
      return {
        userRows,
        companyProfileRows,
        customerRows,
        projectRows,
        assignmentRows,
        invoiceRows,
        invoiceSequenceRows,
        attachmentRows,
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/**
 * Whether the importable set holds data, and whether `users` does.
 * `users` and `company_profile` are left out of `present`: a fresh install
 * always carries the bootstrap admin and the baseline-seeded singleton.
 */
export async function findRestoreTargetPresence(
  db: TransactionalDatabase,
): Promise<{ present: boolean; usersExisted: boolean }> {
  const result = await db.execute<{ present: boolean; users_existed: boolean }>(
    sql`SELECT
      (
        EXISTS (SELECT 1 FROM customers)
        OR EXISTS (SELECT 1 FROM projects)
        OR EXISTS (SELECT 1 FROM project_workers)
        OR EXISTS (SELECT 1 FROM invoices)
        OR EXISTS (SELECT 1 FROM attachments)
      ) AS present,
      EXISTS (SELECT 1 FROM users) AS users_existed`,
  );
  return {
    present: result.rows[0]?.present === true,
    usersExisted: result.rows[0]?.users_existed === true,
  };
}

/**
 * Lock `invoices` and return its numbered rows. The ACCESS EXCLUSIVE lock is
 * the one the wipe's TRUNCATE takes anyway; taking it before the read keeps
 * a concurrent issuance from committing between this read and the wipe.
 */
export async function lockNumberedInvoices(
  tx: TransactionalDatabase,
): Promise<{ id: string; number: string | null }[]> {
  await tx.execute(sql`LOCK TABLE invoices IN ACCESS EXCLUSIVE MODE`);
  return tx
    .select({ id: invoices.id, number: invoices.number })
    .from(invoices)
    .where(isNotNull(invoices.number));
}

export type InvoiceSequenceRow = typeof invoiceSequence.$inferSelect;

export async function findInvoiceSequences(
  tx: TransactionalDatabase,
): Promise<InvoiceSequenceRow[]> {
  return tx.select().from(invoiceSequence);
}

/**
 * Empty the importable set, keeping the operational tables.
 *
 * Step A — TRUNCATE the business and session tables that have no FK
 * references from outside the wipe set. CASCADE is NOT used, so audit_log,
 * data_exchange_job and notification_rule (FK SET NULL back to users)
 * survive and the operator can reattach to their job.
 *
 *   sessions, push_subscriptions — ON DELETE CASCADE from users; wiped here
 *     so the DELETE FROM users (step B) has no live referrers.
 *   company_profile, invoice_sequence — no FK back to the wipe set, so
 *     CASCADE would not reach them; listed explicitly.
 *
 * Step B — DELETE FROM users (not TRUNCATE), so Postgres honours the ON
 * DELETE SET NULL FKs: audit_log.actor_id, data_exchange_job.created_by and
 * notification_rule.created_by are NULLed rather than deleted. TRUNCATE does
 * not run ON DELETE actions; DELETE does. RESTART IDENTITY resets the
 * sequences.
 */
export async function wipeBusinessData(tx: MutatingDatabase): Promise<void> {
  await tx.execute(
    sql`TRUNCATE TABLE
      sessions,
      push_subscriptions,
      attachments,
      invoices,
      invoice_sequence,
      project_workers,
      project_storage_usage,
      projects,
      customers,
      company_profile
    RESTART IDENTITY`,
  );
  await tx.execute(sql`DELETE FROM users`);
}

export interface BusinessDataRows {
  users: (typeof users.$inferInsert)[];
  companyProfile: (typeof companyProfile.$inferInsert)[];
  customers: (typeof customers.$inferInsert)[];
  projects: (typeof projects.$inferInsert)[];
  projectWorkers: (typeof projectWorkers.$inferInsert)[];
  invoiceSequence: (typeof invoiceSequence.$inferInsert)[];
  /** Originals (`cancellationOf` null) only. */
  invoiceOriginals: (typeof invoices.$inferInsert)[];
  /** Stornos only, inserted after the originals they cancel. */
  invoiceStornos: (typeof invoices.$inferInsert)[];
}

/**
 * Insert the restored rows. Order — pinned by issue #230 — follows FK
 * direction:
 *   - users first (every other table's audit columns reference users.id);
 *   - company_profile (updatedBy → users.id);
 *   - customers (createdBy/updatedBy);
 *   - projects (customers + users);
 *   - project_workers (projects + users);
 *   - invoice_sequence has no FK; it goes before invoices so the
 *     next-number allocator is ready;
 *   - invoice originals before Stornos, so the self-FK resolves.
 */
export async function insertBusinessData(
  tx: MutatingDatabase,
  rows: BusinessDataRows,
): Promise<void> {
  if (rows.users.length > 0) {
    await tx.insert(users).values(rows.users);
  }
  if (rows.companyProfile.length > 0) {
    // Singleton: the table holds at most one row by CHECK + UNIQUE on the
    // `singleton` boolean. After the wipe we INSERT the envelope's
    // singleton. On the empty-target path the baseline-pre-seeded row still
    // exists; `ON CONFLICT (singleton) DO UPDATE` replaces the placeholder
    // with the envelope's contents.
    await tx
      .insert(companyProfile)
      .values(rows.companyProfile)
      .onConflictDoUpdate({
        target: companyProfile.singleton,
        set: {
          id: sql`excluded.id`,
          companyName: sql`excluded.company_name`,
          address: sql`excluded.address`,
          taxId: sql`excluded.tax_id`,
          ustId: sql`excluded.ust_id`,
          iban: sql`excluded.iban`,
          accentColor: sql`excluded.accent_color`,
          footerText: sql`excluded.footer_text`,
          defaultTaxMode: sql`excluded.default_tax_mode`,
          updatedAt: sql`excluded.updated_at`,
          updatedBy: sql`excluded.updated_by`,
        },
      });
  }
  if (rows.customers.length > 0) {
    await tx.insert(customers).values(rows.customers);
  }
  if (rows.projects.length > 0) {
    await tx.insert(projects).values(rows.projects);
  }
  if (rows.projectWorkers.length > 0) {
    await tx.insert(projectWorkers).values(rows.projectWorkers);
  }
  if (rows.invoiceSequence.length > 0) {
    await tx.insert(invoiceSequence).values(rows.invoiceSequence);
  }
  if (rows.invoiceOriginals.length > 0) {
    await tx.insert(invoices).values(rows.invoiceOriginals);
  }
  if (rows.invoiceStornos.length > 0) {
    await tx.insert(invoices).values(rows.invoiceStornos);
  }
}
