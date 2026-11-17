/**
 * Company-profile repository — the singleton's reads and the UPDATE that
 * powers the `PUT` upsert (data-model.md §5.17, api.md §14.2.15, ADR-0026).
 * `services/CompanyProfileService.ts` refuses to serve when the row is
 * missing and maps it to the API shape.
 *
 * Writes accept `MutatingDatabase` so ADR-0021's build-time seam holds:
 * only a caller routing through the service-layer
 * `mutate()` helper can author the UPDATE.
 */

import { sql } from 'drizzle-orm';
import type { MutatingDatabase, TransactionalDatabase, TxHandle } from '../db/connection.js';
import { companyProfile } from '../db/schema.js';
import type { TaxMode } from '../../domain/invoice.js';

export type CompanyProfileRow = typeof companyProfile.$inferSelect;

export async function findCompanyProfile(
  db: TransactionalDatabase,
): Promise<CompanyProfileRow | undefined> {
  const [row] = await db.select().from(companyProfile).limit(1);
  return row;
}

/**
 * The singleton, locked until commit, so the upsert's version check and
 * write are atomic (data-model.md §6.4).
 */
export async function getCompanyProfileForMutation(
  tx: TxHandle,
): Promise<CompanyProfileRow | undefined> {
  const [row] = await tx.select().from(companyProfile).limit(1).for('update');
  return row;
}

/**
 * Fields written by the singleton PUT. Mirrors the upsert input shape;
 * the service does tax-mode validity + required-field validation, then
 * passes the validated body verbatim. `updatedBy` carries the actor
 * id from the auth context.
 */
export interface UpdateCompanyProfileFields {
  companyName: string;
  address: { street: string; zip: string; city: string };
  taxId: string;
  ustId: string | null;
  iban: string | null;
  accentColor: string | null;
  footerText: string | null;
  defaultTaxMode: TaxMode;
  updatedBy: string;
}

/**
 * Singleton UPDATE for the company-profile row. The WHERE predicate
 * pins `singleton = true` — the table's unique+CHECK pair guarantees
 * exactly one row carries that discriminator, so the UPDATE either
 * matches the one row or matches nothing (the latter is unreachable
 * in steady state; the service throws on the `readSingleton` step
 * before reaching this call).
 *
 * Returns the post-update row so the service can build the audit
 * `after` payload.
 */
export async function updateCompanyProfileSingleton(
  tx: MutatingDatabase,
  fields: UpdateCompanyProfileFields,
): Promise<CompanyProfileRow | undefined> {
  const rows = await tx
    .update(companyProfile)
    .set({
      companyName: fields.companyName,
      address: fields.address,
      taxId: fields.taxId,
      ustId: fields.ustId,
      iban: fields.iban,
      accentColor: fields.accentColor,
      footerText: fields.footerText,
      defaultTaxMode: fields.defaultTaxMode,
      updatedAt: new Date(),
      updatedBy: fields.updatedBy,
    })
    .where(sql`${companyProfile.singleton} = true`)
    .returning();
  return rows[0];
}
