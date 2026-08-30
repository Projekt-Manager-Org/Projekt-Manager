/**
 * Company-profile routes — singleton GET + owner-only PUT
 * (api.md §14.2.15, ADR-0026, data-model.md §5.17).
 *
 * POST and DELETE are deliberately NOT registered — the row is a
 * singleton (DB CHECK + BEFORE-DELETE trigger). The default Fastify
 * 404 covers both. AT-121 accepts either 404 or 405; 404 is fine.
 *
 * Authorization:
 *   - GET: any authenticated role (the profile is referenced by invoice
 *     rendering AND by the Daten view's read surface).
 *   - PUT: owner role only, via `requireRole('owner')`. The spec doesn't
 *     allocate dedicated `company_profile:*` permission keys (a
 *     fine-grained key per singleton would dilute the catalog), so this
 *     is the one route whose gate names a role instead.
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/connection.js';
import { requireRole, requireSession } from '../middleware/auth.js';
import { CompanyProfileService } from '../services/CompanyProfileService.js';
import { TAX_MODES, type TaxMode } from '../../domain/invoice.js';

const addressSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['street', 'zip', 'city'],
  properties: {
    street: { type: 'string', maxLength: 200 },
    zip: { type: 'string', maxLength: 20 },
    city: { type: 'string', maxLength: 200 },
  },
} as const;

// Owner-editable strings carry route-layer maxLength caps so unbounded
// growth cannot land in audit payloads or the rendered PDF. `footerText`
// is the highest-impact because it lands verbatim in every rendered PDF
// (the embedded `factur-x.xml` does NOT carry footerText — see
// `facturXmlBuilder.ts`). `accentColor` is also pattern-pinned to the
// CSS hex shapes the renderer expects (3-char shorthand `#RGB` or full
// form `#RRGGBB`).
const profileBodySchema = {
  type: 'object',
  // PUT semantics — the always-required block must be present. Optional
  // fields (`ustId`, `iban`, …) accept null explicitly. Required-when-
  // mode validation runs in the service layer (single source of truth
  // with the issue-time gate — AC-303 / AC-289(i)).
  required: ['companyName', 'address', 'taxId', 'defaultTaxMode'],
  additionalProperties: false,
  properties: {
    companyName: { type: 'string', maxLength: 200 },
    address: addressSchema,
    taxId: { type: 'string', maxLength: 50 },
    ustId: { type: ['string', 'null'], maxLength: 50 },
    iban: { type: ['string', 'null'], maxLength: 50 },
    accentColor: {
      type: ['string', 'null'],
      maxLength: 7,
      pattern: '^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$',
    },
    footerText: { type: ['string', 'null'], maxLength: 2000 },
    logoBinaryDescriptorId: { type: ['string', 'null'], format: 'uuid' },
    defaultTaxMode: { type: 'string', enum: [...TAX_MODES] },
  },
} as const;

export function companyProfileRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const service = new CompanyProfileService(db);

    requireSession(app, db);

    // ---------------------------------------------------------------
    // GET /api/company-profile — every authenticated role may read.
    // ---------------------------------------------------------------
    app.get('/api/company-profile', async (_request, reply) => {
      const profile = await service.get();
      return reply.code(200).send(profile);
    });

    // ---------------------------------------------------------------
    // PUT /api/company-profile — owner-only upsert (PUT semantics).
    //
    // Gated by `requireRole`, not `requirePermission`, because the spec
    // folds the owner-only invariant into a role check rather than
    // minting a dedicated permission key — api.md §14.2.15 design note
    // "Owner-only writes".
    // ---------------------------------------------------------------
    app.put(
      '/api/company-profile',
      {
        schema: { body: profileBodySchema },
        preHandler: requireRole('owner'),
      },
      async (request, reply) => {
        const body = request.body as {
          companyName: string;
          address: { street: string; zip: string; city: string };
          taxId: string;
          ustId?: string | null;
          iban?: string | null;
          accentColor?: string | null;
          footerText?: string | null;
          logoBinaryDescriptorId?: string | null;
          defaultTaxMode: TaxMode;
        };

        const updated = await service.upsert(request.user!, body, request.log, request.id ?? null);
        return reply.code(200).send(updated);
      },
    );
  };
}
