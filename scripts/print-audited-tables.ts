/**
 * Prints audited-table identifiers derived from `AUDIT_ENTITY_TO_TABLE`
 * (src/server/db/schema.ts) for `scripts/check-audit-mutations.sh`.
 *
 * By the check's design (`scripts/check-audit-mutations.sh` header), the audited-table set follows
 * `AuditEntityType`: a new entity type whose table is not wired into
 * the check must fail CI. This helper is the read path — the shell
 * check calls it via `npx tsx` to obtain a space-separated list.
 *
 * Usage:
 *   npx tsx scripts/print-audited-tables.ts sql       # SQL table names
 *   npx tsx scripts/print-audited-tables.ts drizzle   # Drizzle exports
 *
 * Exit code 0 on success; exit code 2 on an unknown/missing argument so
 * the caller's `set -e` trips loudly instead of consuming an empty
 * array that would silently disable the scan.
 */

import { AUDIT_ENTITY_TO_TABLE } from '../src/server/db/schema.js';

const VALID_FIELDS = ['sql', 'drizzle'] as const;
type Field = (typeof VALID_FIELDS)[number];

const [, , field] = process.argv;

if (!field || !VALID_FIELDS.includes(field as Field)) {
  console.error(
    `ERROR: expected one of [${VALID_FIELDS.join(', ')}] as the first argument; got ${JSON.stringify(field)}.`,
  );
  process.exit(2);
}

const values = Object.values(AUDIT_ENTITY_TO_TABLE).map((entry) =>
  field === 'drizzle' ? entry.drizzleExport : entry.sqlName,
);

console.log(values.join(' '));
