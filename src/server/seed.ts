/**
 * Seed data orchestrator for development and testing.
 *
 * Creates 21 customers, 19 projects across all 9 workflow states, and
 * 6 users (5 active + 1 inactive) with the default password defined in
 * `src/test/seedAssumptions.ts`. Dates are relative to the reference
 * moment captured at the start of this run — never hardcoded, never
 * module-load-time.
 *
 * Issue #230: every envelope-resident table flows through `ImportService`
 * in a single call — users, company_profile, customers, projects, and
 * project_workers ride the same envelope `ImportService` consumes,
 * so envelope-format drift breaks the seed and the public restore path
 * together. Invoices are minted afterwards via the real lifecycle
 * (`loadInvoices`: draft → issue → optional cancel + reissue, allocating
 * sequences, rendering PDFs, emitting audit rows).
 *
 * The production gate (`NODE_ENV === 'production'`) lives in
 * `src/server/start.ts` — this function is dev/test-only and trusts its
 * caller.
 */

import { sql } from 'drizzle-orm';

import type { Database } from './db/connection.js';
import { users } from './db/schema.js';
import { loadBusiness } from './seed/business.js';
import { loadInvoices } from './seed/invoices.js';
import { loadNotificationRules } from './seed/notificationRules.js';
import { hashPassword } from './password.js';
import { SEED_DEFAULT_PASSWORD } from '../test/seedAssumptions.js';

/**
 * Seed the database with sample data.
 *
 * Behavior depends on the `force` option:
 * - `force: false` (default) — skip if users already exist, preserving
 *   manual changes across dev server restarts.
 * - `force: true` — wipe all data and re-seed. Used by tests for a
 *   guaranteed clean slate, and via SEED=force when seed data changes.
 */
export async function seed(db: Database, opts: { force?: boolean } = {}): Promise<void> {
  if (!opts.force) {
    const existing = await db.select({ id: users.id }).from(users).limit(1);
    if (existing.length > 0) {
      console.log('Database already seeded — skipping. Set SEED=force to wipe and re-seed.');
      return;
    }
  }

  // Clear existing data atomically.
  //
  // Notification rules and push subscriptions are NOT listed in the
  // TRUNCATE: notification_rule has no FK back to any table in the
  // wipe set, and CASCADE through users handles push_subscriptions.
  // The rule table is truncated separately below so the seed-supplied
  // v1 rule set lands cleanly even when notification_rule had prior
  // rows (force-reseed).
  //
  // `company_profile` is not listed explicitly: TRUNCATE CASCADE on
  // `users` propagates to it via the FK (`updated_by → users.id`),
  // emptying the singleton along the way. The import path
  // re-establishes the singleton from `envelope.company_profile` via
  // `ON CONFLICT (singleton) DO UPDATE`, which handles both the
  // post-TRUNCATE empty arm and the fresh-install arm where the
  // baseline migration's placeholder row still exists.
  //
  // `invoice_sequence` is reset so a force-reseed gets clean
  // `RE-YYYY-0001` numbering. The cascade from `projects` already
  // empties `invoices`, but the sequence table has no FK and would
  // otherwise carry forward the high-water mark of every prior run.
  await db.execute(
    sql`TRUNCATE TABLE notification_rule, project_workers, sessions, projects, customers, users, invoice_sequence CASCADE`,
  );

  // Reference moment for every relative date downstream. Captured once so
  // the envelope's year prefix and relative offsets line up with each
  // other (a Dec 31 → Jan 1 rollover between user insert and project
  // insert would otherwise leave projects in next year's prefix).
  const now = new Date();

  // Hash once — bcrypt is expensive, and every seeded user shares the
  // same plaintext per the spec (data-model.md §7.2). Threaded into
  // `buildBusinessEnvelope` onto every `users[*].passwordHash` slot.
  const hashedPassword = await hashPassword(SEED_DEFAULT_PASSWORD);

  await loadBusiness(db, { now, hashedPassword });
  await loadNotificationRules(db);

  // Invoices land last because issuance pulls live snapshots from
  // `users`, `customers`, `projects`, and the `company_profile`
  // singleton — every dependency must already be seeded. The loader
  // exercises the public `InvoiceService` surface end-to-end (draft →
  // issue → optional cancel + reissue), so it mints real factur-x XML,
  // real rendered PDFs, real binary descriptors, and real audit rows.
  await loadInvoices(db, { now });

  console.warn(
    `⚠  Seed-Daten geladen. Alle Benutzer haben das Standardpasswort "${SEED_DEFAULT_PASSWORD}". ` +
      'Passwörter müssen vor Produktiveinsatz geändert werden.',
  );
}
