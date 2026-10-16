/**
 * Write-route version classification gate (AC-380).
 *
 * A stale write to a versioned entity is rejected only if the route
 * carries `expectedVersion` (data-model.md §6.4). Every route the app
 * registers under a method other than GET / HEAD is classified here:
 * versioned, or exempt with one of the reasons AC-380 and §6.4 name. Deny by
 * default — an unclassified route fails, and so does an entry naming no
 * registered route.
 *
 * The label is checked against the route, not trusted: a versioned route
 * must require the shared `EXPECTED_VERSION_SCHEMA` in its body or query
 * string, and an exempt one must not.
 */
import type { RouteOptions } from 'fastify';
import { classificationGaps, routeKeys } from '../../scripts/lib/route-introspection.js';
import { EXPECTED_VERSION_SCHEMA } from '../server/routes/expected-version.js';

/** Why a write route is not versioned — the cases AC-380 and data-model.md §6.4 name. */
export const EXEMPTION_REASONS = {
  create: 'creates a row: no prior read to be stale',
  projectEdit: 'project edits are last-write-wins (data-model.md §6.4)',
  transition: 'guarded by expectedStatus (AC-94)',
  lifecycle: 'acts on existence, not content; state-checked (data-model.md §6.4)',
  frozenTarget: 'its target is frozen (data-model.md §6.14)',
  ownStateCheck: 'own state check (attachments: api.md §14.2.11; import upload: api.md §14.2.4)',
  lowStakes: 'low-stakes row; a stale overwrite freezes nothing (data-model.md §6.4)',
  noSharedRow: 'no shared editable row',
  readOnly: 'writes nothing',
} as const;

export type Classification = 'versioned' | { exempt: keyof typeof EXEMPTION_REASONS };

export const VERSION_CLASSIFICATION: Record<string, Classification> = {
  'OPTIONS *': { exempt: 'readOnly' },
  'POST /api/auth/login': { exempt: 'noSharedRow' },
  'POST /api/auth/logout': { exempt: 'noSharedRow' },
  'PATCH /api/auth/me': { exempt: 'lowStakes' },
  'POST /api/auth/change-password': { exempt: 'noSharedRow' },
  'POST /api/projects': { exempt: 'create' },
  'POST /api/projects/:id/transition/forward': { exempt: 'transition' },
  'POST /api/projects/:id/transition/backward': { exempt: 'transition' },
  'PATCH /api/projects/:id/dates': { exempt: 'projectEdit' },
  'PATCH /api/projects/:id': { exempt: 'projectEdit' },
  'DELETE /api/projects/:id': { exempt: 'lifecycle' },
  'DELETE /api/projects/:id/purge': { exempt: 'lifecycle' },
  'POST /api/projects/:id/restore': { exempt: 'lifecycle' },
  'POST /api/customers': { exempt: 'create' },
  'PATCH /api/customers/:id': 'versioned',
  'DELETE /api/customers/:id': { exempt: 'lifecycle' },
  'POST /api/users': { exempt: 'create' },
  'PATCH /api/users/:id': { exempt: 'lowStakes' },
  'DELETE /api/users/:id': { exempt: 'lowStakes' },
  'POST /api/users/:id/deactivate': { exempt: 'lowStakes' },
  'POST /api/users/:id/reactivate': { exempt: 'lowStakes' },
  'POST /api/users/:id/reset-password': { exempt: 'lowStakes' },
  'POST /api/export-jobs': { exempt: 'noSharedRow' },
  'POST /api/import-jobs': { exempt: 'create' },
  'PATCH /api/import-jobs/:id/archive': { exempt: 'ownStateCheck' },
  'POST /api/extract': { exempt: 'readOnly' },
  'POST /api/notification-rules': { exempt: 'create' },
  'PATCH /api/notification-rules/:id': { exempt: 'lowStakes' },
  'DELETE /api/notification-rules/:id': { exempt: 'lowStakes' },
  'POST /api/push-subscriptions': { exempt: 'noSharedRow' },
  'DELETE /api/push-subscriptions': { exempt: 'noSharedRow' },
  'DELETE /api/push-subscriptions/:id': { exempt: 'noSharedRow' },
  'POST /api/projects/:id/attachments/init': { exempt: 'create' },
  'POST /api/projects/:id/attachments/:attId/complete': { exempt: 'ownStateCheck' },
  'DELETE /api/projects/:id/attachments/:attId': { exempt: 'ownStateCheck' },
  'POST /api/projects/:id/attachments/:attId/restore': { exempt: 'ownStateCheck' },
  'POST /api/projects/:id/attachments/bulk-fetch': { exempt: 'readOnly' },
  'POST /api/invoices': { exempt: 'create' },
  'PATCH /api/invoices/:id': 'versioned',
  'DELETE /api/invoices/:id': 'versioned',
  'POST /api/invoices/:id/issue': 'versioned',
  'POST /api/invoices/:id/cancel': { exempt: 'frozenTarget' },
  'POST /api/invoices/export': { exempt: 'readOnly' },
  'PUT /api/company-profile': 'versioned',
};

const READ_METHODS = ['GET', 'HEAD'];

/** True when the body or query-string schema requires the shared `expectedVersion`. */
function requiresExpectedVersion(route: RouteOptions): boolean {
  return [route.schema?.body, route.schema?.querystring].some((schema) => {
    const { required, properties } = (schema ?? {}) as {
      required?: unknown;
      properties?: Record<string, unknown>;
    };
    return (
      Array.isArray(required) &&
      required.includes('expectedVersion') &&
      properties?.expectedVersion === EXPECTED_VERSION_SCHEMA
    );
  });
}

/** Check every write route's classification. Returns one line per violation. */
export function checkVersionClassification(
  routes: RouteOptions[],
  table: Record<string, Classification> = VERSION_CLASSIFICATION,
): string[] {
  const writes = routes.flatMap((route) =>
    routeKeys(route)
      .filter((key) => !READ_METHODS.includes(key.split(' ')[0]!))
      .map((key) => ({ key, route })),
  );
  const { unclassified, stale } = classificationGaps(
    writes.map((w) => w.key),
    Object.keys(table),
  );
  const violations = [
    ...unclassified.map((key) => `${key}: not classified — versioned, or exempt with a reason`),
    ...stale.map((key) => `${key}: classified, but no write route has this key`),
  ];
  for (const { key, route } of writes) {
    const classification = table[key];
    if (!classification) continue;
    const required = requiresExpectedVersion(route);
    if (classification === 'versioned' && !required) {
      violations.push(`${key}: classified versioned, but does not require expectedVersion`);
    } else if (classification !== 'versioned' && required) {
      violations.push(`${key}: exempt (${classification.exempt}), but requires expectedVersion`);
    }
  }
  return violations;
}
