/**
 * Company-profile service — singleton CRUD for the issuing company
 * identity (data-model.md §5.17, api.md §14.2.15, ADR-0026).
 *
 * Exactly one row exists, pre-seeded by the baseline migration with
 * empty mandatory fields. The API exposes GET (every authenticated
 * role) + PUT (owner only; enforced at the route layer, re-checked
 * defensively at the service layer — `upsert()` rejects any caller
 * without the `owner` role with `notPermitted()`). No POST / DELETE —
 * the row cannot be created or removed (DB CHECK + BEFORE-DELETE
 * trigger).
 *
 * Every write rides `mutate()` (ADR-0021) with
 * `entityType = 'company_profile'`, `action = 'update'`, ancestor pair
 * null (top-level entity — parity with `customer` / `user`).
 *
 * Required-when-mode validation runs at upsert time (AC-303) AND at
 * issue time (defense in depth — AC-289(i) / AC-305 in
 * `InvoiceService.issueDraft`). The single source of truth is
 * `companyProfileMissingFieldsForMode()` in `src/domain/invoice.ts`,
 * so the two paths cannot drift.
 */

import type { Database, TransactionalDatabase } from '../db/connection.js';
import { companyProfile } from '../db/schema.js';
import type { AuthUser } from '../middleware/auth.js';
import { mutate } from './mutate.js';
import {
  companyProfileMissingFieldsForMode,
  COMPANY_PROFILE_ALWAYS_REQUIRED,
  TAX_MODES,
  type CompanyProfile,
  type TaxMode,
} from '../../domain/invoice.js';
import { companyProfileRequired, notPermitted, validationError } from '../errors.js';
import { STRINGS } from '../../config/strings.js';
import type { ServiceLogger } from './Logger.js';
import { updateCompanyProfileSingleton } from '../repositories/companyProfile.js';

export type CompanyProfileRow = typeof companyProfile.$inferSelect;

/**
 * Convert a raw `company_profile` row to the API-facing shape. JSONB
 * `address` is round-tripped through Drizzle's `$type<>()` annotation
 * so no cast is needed.
 */
export function toCompanyProfileResponse(row: CompanyProfileRow): CompanyProfile {
  return {
    id: row.id,
    companyName: row.companyName,
    address: row.address,
    taxId: row.taxId,
    ustId: row.ustId,
    iban: row.iban,
    accentColor: row.accentColor,
    footerText: row.footerText,
    defaultTaxMode: row.defaultTaxMode as TaxMode,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

/**
 * The fields a PUT body may carry. PUT semantics — every writable
 * field must be present; nullable fields accept explicit null. The
 * route-layer JSON schema enforces shape; the service-layer additional
 * checks are content-level (non-empty strings under the selected mode).
 */
export interface CompanyProfileUpsertInput {
  companyName: string;
  address: { street: string; zip: string; city: string };
  taxId: string;
  ustId?: string | null;
  iban?: string | null;
  accentColor?: string | null;
  footerText?: string | null;
  defaultTaxMode: TaxMode;
}

/**
 * Validate required-when-mode + structural invariants on an incoming
 * PUT body. Throws `validationError` (mode-shaped, with `details`
 * naming every offending field path) on any rejection — AC-303.
 *
 * The check has two halves:
 *
 *   1. Tax-mode validity (the JSON schema usually catches this, but we
 *      re-check defensively so a service-only caller bypassing the
 *      route still gets a clean error).
 *   2. The required-when-mode shape via the shared invoice-domain
 *      helper — single source of truth with the issue-time gate.
 *
 * `details` exposes `missingFields` so the UI can target the offending
 * input(s); this matches the contract for `COMPANY_PROFILE_REQUIRED`
 * but uses the generic `VALIDATION_ERROR` code at upsert time per the
 * api.md §14.2.15 wording ("validates that `ustId` is non-empty when …
 * Body violating the required-when-mode invariants … → 422
 * VALIDATION_ERROR with details naming the offending field path").
 */
export function validateCompanyProfileUpsert(input: CompanyProfileUpsertInput): void {
  if (!TAX_MODES.includes(input.defaultTaxMode)) {
    throw validationError(STRINGS.errors.invalidInput, {
      missingFields: ['defaultTaxMode'],
    });
  }
  const missing = companyProfileMissingFieldsForMode(
    {
      companyName: input.companyName,
      address: input.address,
      taxId: input.taxId,
      ustId: input.ustId ?? null,
    },
    input.defaultTaxMode,
  );
  if (missing.length > 0) {
    throw validationError(STRINGS.errors.companyProfileRequired, { missingFields: missing });
  }
}

/**
 * Read the singleton row inside a transaction. Throws if the row is
 * missing — that condition means the baseline seed is broken and the
 * service refuses to serve (project principle).
 */
export async function readSingleton(tx: TransactionalDatabase): Promise<CompanyProfileRow> {
  const rows = await tx.select().from(companyProfile).limit(1);
  if (rows.length === 0) {
    throw new Error(
      'CompanyProfileService: company_profile singleton missing — baseline migration did not seed',
    );
  }
  return rows[0]!;
}

export class CompanyProfileService {
  constructor(private db: Database) {}

  /**
   * Fetch the singleton profile. Open to every authenticated role —
   * the route layer enforces auth, the service is callable without
   * additional gating.
   */
  async get(): Promise<CompanyProfile> {
    const row = await readSingleton(this.db);
    return toCompanyProfileResponse(row);
  }

  /**
   * Upsert (PUT semantics). Routes pass the authenticated `caller` and
   * the validated body; the service enforces the owner-only invariant
   * as defense in depth (the route layer also gates it — M3 / AC-297),
   * re-checks content-level invariants, opens a transaction, captures
   * `payload.before` from the pre-write row, writes the UPDATE, and
   * commits the audit row via `mutate()`.
   *
   * The owner check runs BEFORE validation / DB work so a non-owner
   * caller cannot probe the validation surface or write any partial
   * mutation. Throws `notPermitted()` (403 `NOT_PERMITTED`) — the same
   * error shape the route emits when its pre-handler gate fires.
   *
   * `entityId` = the singleton row's UUID (Phase A seed). Ancestor
   * pair null per AC-302.
   */
  async upsert(
    caller: AuthUser,
    input: CompanyProfileUpsertInput,
    log: ServiceLogger,
    correlationId?: string | null,
  ): Promise<CompanyProfile> {
    // Defense-in-depth role check (M3 / AC-297). The route layer's
    // pre-handler gates this surface to `owner` already; this rejects
    // any direct service caller bypassing the route (background jobs,
    // scripts, test fixtures, future internal consumers) on the same
    // contract.
    if (!caller.roles.includes('owner')) {
      throw notPermitted();
    }

    validateCompanyProfileUpsert(input);

    const updated = await mutate(
      this.db,
      { actorKind: 'user', actorId: caller.id, correlationId: correlationId ?? null },
      {
        entityType: 'company_profile',
        action: 'update',
        run: async (tx) => {
          const before = await readSingleton(tx);
          const after = await updateCompanyProfileSingleton(tx, {
            companyName: input.companyName,
            address: input.address,
            taxId: input.taxId,
            ustId: input.ustId ?? null,
            iban: input.iban ?? null,
            accentColor: input.accentColor ?? null,
            footerText: input.footerText ?? null,
            defaultTaxMode: input.defaultTaxMode,
            updatedBy: caller.id,
          });

          if (!after) {
            // Should not be reachable — `readSingleton` would have
            // thrown above. Defense-in-depth.
            throw new Error('CompanyProfileService.upsert: singleton row missing after UPDATE');
          }

          // Capture only the snapshotted fields the spec lists in §5.17
          // for `payload.before` / `payload.after` — id/updatedAt/
          // updatedBy are server-managed.
          const beforePayload: Record<string, unknown> = {
            companyName: before.companyName,
            address: before.address,
            taxId: before.taxId,
            ustId: before.ustId,
            iban: before.iban,
            accentColor: before.accentColor,
            footerText: before.footerText,
            defaultTaxMode: before.defaultTaxMode,
          };
          const afterPayload: Record<string, unknown> = {
            companyName: after.companyName,
            address: after.address,
            taxId: after.taxId,
            ustId: after.ustId,
            iban: after.iban,
            accentColor: after.accentColor,
            footerText: after.footerText,
            defaultTaxMode: after.defaultTaxMode,
          };

          return {
            entityId: after.id,
            entityLabel: after.companyName || null,
            value: after,
            before: beforePayload,
            after: afterPayload,
            // Ancestor pair null — top-level entity (AC-302, parity
            // with customer / user).
          };
        },
      },
    );
    log.info({ companyProfileId: updated.id }, 'company_profile_updated');
    return toCompanyProfileResponse(updated);
  }
}

/**
 * Issue-time gate — run inside the issuance transaction to verify the
 * singleton is complete for the resolved `taxMode`. Re-uses the same
 * domain helper as the upsert validator so the two paths cannot drift
 * (AC-289(i), AC-305).
 *
 * `tx` argument forces the read to share the issuance transaction's
 * snapshot — a profile update committed between the route entry and
 * the issue body cannot create a TOCTOU window.
 *
 * Throws `companyProfileRequired(...)` (422 + `COMPANY_PROFILE_REQUIRED`
 * + `details.missingFields`) on incomplete state. The throw rolls back
 * any allocation that ran before this check (AC-305 trailing clause
 * about the sequence lock release).
 */
export async function assertCompanyProfileCompleteForMode(
  tx: TransactionalDatabase,
  mode: TaxMode,
): Promise<CompanyProfileRow> {
  const row = await readSingleton(tx);
  const missing = companyProfileMissingFieldsForMode(
    {
      companyName: row.companyName,
      address: row.address,
      taxId: row.taxId,
      ustId: row.ustId ?? null,
    },
    mode,
  );
  if (missing.length > 0) {
    throw companyProfileRequired({ missingFields: missing });
  }
  return row;
}

// Re-export the always-required list so consumers (e.g. route schemas)
// can read the canonical anchor without crossing into the domain
// module directly.
export { COMPANY_PROFILE_ALWAYS_REQUIRED };
