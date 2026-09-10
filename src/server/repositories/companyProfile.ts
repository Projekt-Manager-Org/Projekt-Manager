/**
 * Company-profile repository — singleton write primitive.
 *
 * Reads live in `services/CompanyProfileService.ts` (`readSingleton` +
 * `toCompanyProfileResponse`) for backwards-shape parity with the
 * service's other helpers and the issuance gate's tx-bound read. This
 * module owns the singleton UPDATE that powers the `PUT` upsert
 * (data-model.md §5.17, api.md §14.2.15, ADR-0026).
 *
 * Writes accept `MutatingDatabase` so AC-179's build-time seam holds
 * (ADR-0021): only a caller routing through the service-layer
 * `mutate()` helper can author the UPDATE.
 */

import { sql } from 'drizzle-orm';
import type { MutatingDatabase } from '../db/connection.js';
import { companyProfile } from '../db/schema.js';
import type { TaxMode } from '../../domain/invoice.js';

export type CompanyProfileRow = typeof companyProfile.$inferSelect;

/**
 * Fields written by the singleton PUT. Mirrors the upsert input shape;
 * the service does mode-validity + required-when-mode validation, then
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
