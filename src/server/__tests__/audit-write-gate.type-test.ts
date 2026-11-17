// Compile-time tests for the ADR-0021 type gate (#938). No runtime: `tsc
// --noEmit` (CI typecheck) is the runner. Each `@ts-expect-error` fails the
// build if its line compiles; every other line fails it if it does not.

import type { Database } from '../db/connection.js';
import { createPending } from '../repositories/attachment.js';
import { exemptFromAudit, mutate, type MutateContext } from '../services/mutate.js';

declare const db: Database;
declare const ctx: MutateContext;
declare const input: Parameters<typeof createPending>[1];

// The #938 reproduction: an audited write inside a plain transaction.
void db.transaction(async (tx) => {
  // @ts-expect-error — a transaction `mutate()` did not open cannot write an audited table.
  await createPending(tx, input);
});

// @ts-expect-error — nor can a plain `Database`.
void createPending(db, input);

// Inside `mutate()`, the write compiles.
void mutate(db, ctx, {
  entityType: 'attachment',
  action: 'attachment:add',
  run: async (tx) => {
    const row = await createPending(tx, input);
    return { entityId: row.id, value: row };
  },
});

// A named exception compiles.
void db.transaction(async (tx) => createPending(exemptFromAudit(tx, 'pending-upload'), input));

// An unnamed one does not.
void db.transaction(async (tx) =>
  // @ts-expect-error — only the exceptions listed in mutate.ts exist.
  createPending(exemptFromAudit(tx, 'convenience'), input),
);
