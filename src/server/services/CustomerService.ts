/**
 * Customer service — business logic orchestration for customers.
 *
 * Every mutation routes through `mutate()` (ADR-0021). Service methods
 * capture `payload.before`/`after` for the audit row inside the same
 * transaction as the write.
 */

import type { Database } from '../db/connection.js';
import { eq, and } from 'drizzle-orm';
import {
  listCustomers as listCustomersRepo,
  getCustomer as getCustomerRepo,
  createCustomer as createCustomerRepo,
  updateCustomer as updateCustomerRepo,
  deleteCustomer as deleteCustomerRepo,
  getCustomerRow,
  getCustomerRowForMutation,
  toCustomerResponse,
  CUSTOMER_SORT_KEYS,
  type CustomerSortKey,
} from '../repositories/customer.js';

// Re-export the sort allowlist + key type so routes can validate
// querystrings without crossing the routes→repository boundary
// (architecture.md §11.2 — routes delegate through services).
export { CUSTOMER_SORT_KEYS };
export type { CustomerSortKey };
import { projects } from '../db/schema.js';
import { hardDeleteProjectUnchecked } from '../repositories/project.js';
import { listKeysForProject } from '../repositories/attachment.js';
import type { AttachmentStorageClient } from '../storage/client.js';
import { DB_CONSTRAINTS } from '../db/constraints.js';
import { STRINGS } from '../../config/strings.js';
import { notFound, notPermitted, conflict, versionConflict } from '../errors.js';
import { customerMatches, createIdempotent } from './idempotency.js';
import type { ServiceLogger } from './Logger.js';
import type { AuthUser } from '../middleware/auth.js';
import { isOutOfScope } from '../repositories/scope.js';
import { mutate, mutateInTx, dispatchAuditRows, type MutateContext } from './mutate.js';
import type { AuditLogRow } from './audit-publisher.js';
import { applyCustomerCorrectionToDrafts } from './draftRecipientCorrection.js';
import { projectAuditLabel } from '../../domain/audit.js';
import {
  emitInvoiceChanged,
  emitProjectChanged,
  emitStorageUsageChanged,
} from '../sse/emitters.js';
import { countIssuedOrCancelledForCustomer } from '../repositories/invoice-read.js';
import { customerHasInvoices } from '../errors.js';
import { bestEffortHideStorageKeys } from './AttachmentService.js';

/**
 * Fields captured in the audit payload for customer writes. Kept as a
 * `Record<string, unknown>` subset so the service can include only the
 * fields that actually changed (update) or the new row (create).
 */
type CustomerDiff = Record<string, unknown>;

function customerDiffFields(row: {
  name: string;
  phone: string | null;
  email: string | null;
  address: { street: string; zip: string; city: string } | null;
  ustId: string | null;
  notes: string | null;
}): CustomerDiff {
  return {
    name: row.name,
    phone: row.phone ?? null,
    email: row.email ?? null,
    address: row.address ?? null,
    ustId: row.ustId ?? null,
    notes: row.notes ?? null,
  };
}

export class CustomerService {
  constructor(
    private db: Database,
    private storage: AttachmentStorageClient,
  ) {}

  async listCustomers(
    caller: AuthUser,
    opts: {
      offset?: number;
      limit?: number;
      search?: string;
      sortBy?: CustomerSortKey;
      sortDir?: 'asc' | 'desc';
    },
  ) {
    return listCustomersRepo(this.db, caller, opts);
  }

  async getCustomer(caller: AuthUser, id: string) {
    const result = await getCustomerRepo(this.db, caller, id);
    if (result === null) throw notFound(STRINGS.entities.customer);
    // AC-148: out-of-scope → 403 NOT_PERMITTED, not 404.
    if (isOutOfScope(result)) throw notPermitted();
    return result;
  }

  async createCustomer(
    data: {
      id?: string;
      name: string;
      phone?: string | null;
      email?: string | null;
      address?: { street: string; zip: string; city: string } | null;
      ustId?: string | null;
      notes?: string | null;
    },
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ) {
    if (data.id !== undefined) {
      return this.createCustomerWithClientId(data, data.id, userId, log, correlationId);
    }

    const customer = await mutate(
      this.db,
      { actorKind: 'user', actorId: userId, correlationId: correlationId ?? null },
      {
        entityType: 'customer',
        action: 'create',
        run: async (tx) => {
          const inserted = await createCustomerRepo(tx, {
            ...data,
            createdBy: userId,
            updatedBy: userId,
          });
          return {
            entityId: inserted.id,
            entityLabel: inserted.name,
            value: inserted,
            before: {},
            after: customerDiffFields({
              name: inserted.name,
              phone: inserted.phone,
              email: inserted.email,
              address: inserted.address,
              ustId: inserted.ustId,
              notes: inserted.notes,
            }),
          };
        },
      },
    );
    log.info({ customerId: customer.id }, 'customer_created');
    return customer;
  }

  private async createCustomerWithClientId(
    data: {
      name: string;
      phone?: string | null;
      email?: string | null;
      address?: { street: string; zip: string; city: string } | null;
      ustId?: string | null;
      notes?: string | null;
    },
    id: string,
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ) {
    return createIdempotent({
      preSelectRow: () => getCustomerRow(this.db, id),
      replayFromRow: async (row) => {
        if (!customerMatches(data, row)) return null;
        log.info({ customerId: id }, 'customer_create_replayed');
        return toCustomerResponse(row);
      },
      insert: async () => {
        const inserted = await mutate(
          this.db,
          { actorKind: 'user', actorId: userId, correlationId: correlationId ?? null },
          {
            entityType: 'customer',
            action: 'create',
            run: async (tx) => {
              const row = await createCustomerRepo(tx, {
                id,
                ...data,
                createdBy: userId,
                updatedBy: userId,
              });
              return {
                entityId: row.id,
                entityLabel: row.name,
                value: row,
                before: {},
                after: customerDiffFields({
                  name: row.name,
                  phone: row.phone,
                  email: row.email,
                  address: row.address,
                  ustId: row.ustId,
                  notes: row.notes,
                }),
              };
            },
          },
        );
        log.info({ customerId: id }, 'customer_created');
        return inserted;
      },
      isIdRaceConstraint: (c) => c === DB_CONSTRAINTS.customers.pkey || c === null,
      // Customers have no other unique constraint — a 23505 the helper can't
      // resolve as id-race is genuinely unexpected. Rethrow untouched.
      onNonIdRaceConstraint: (err) => {
        throw err;
      },
    });
  }

  async updateCustomer(
    id: string,
    expectedVersion: number,
    data: {
      name?: string;
      phone?: string | null;
      email?: string | null;
      address?: { street: string; zip: string; city: string } | null;
      ustId?: string | null;
      notes?: string | null;
    },
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ) {
    const ctx: MutateContext = {
      actorKind: 'user',
      actorId: userId,
      correlationId: correlationId ?? null,
    };
    const draftAuditRows: AuditLogRow[] = [];
    const { value: customer, auditRow } = await this.db.transaction((outerTx) =>
      mutateInTx(outerTx, ctx, {
        entityType: 'customer',
        action: 'update',
        run: async (tx) => {
          const priorRow = await getCustomerRowForMutation(tx, id);
          if (!priorRow) throw notFound(STRINGS.entities.customer);
          if (priorRow.version !== expectedVersion) throw versionConflict();

          const updated = await updateCustomerRepo(tx, id, userId, data);
          if (!updated) throw notFound(STRINGS.entities.customer);

          draftAuditRows.push(
            ...(await applyCustomerCorrectionToDrafts(tx, ctx, userId, id, priorRow, updated)),
          );

          const changed = diffCustomerChange(priorRow, data);
          return {
            entityId: id,
            entityLabel: updated.name,
            value: updated,
            before: changed.before,
            after: changed.after,
          };
        },
      }),
    );
    await dispatchAuditRows([auditRow, ...draftAuditRows]);
    // Post-commit: project reads carry the nested customer (architecture.md §11.13).
    emitProjectChanged();
    if (draftAuditRows.length > 0) emitInvoiceChanged();
    log.info({ customerId: id }, 'customer_updated');
    return customer;
  }

  async deleteCustomer(
    id: string,
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ) {
    // Every check runs inside the transaction, behind the customer row
    // lock: a project create needs a key-share lock on that row for its FK
    // check, so it either commits before the guard reads or waits for
    // this delete.
    const collectedAudit: AuditLogRow[] = [];
    // Collected before the FK cascade removes the rows, for the post-commit
    // storage cleanup (AC-540) and the storage-usage emitter (AC-270).
    const collectedKeys: Awaited<ReturnType<typeof listKeysForProject>> = [];
    // Tracked across the tx boundary so the post-commit emitter only
    // fires `project_changed` when the cascade actually purged at least
    // one archived project (AC-276 — no event for a customer-delete
    // with zero archived projects, since project rows visible to
    // subscribers do not change).
    let purgedArchivedProjects = false;
    const ctx = {
      actorKind: 'user' as const,
      actorId: userId,
      correlationId: correlationId ?? null,
    };

    // Any throw inside the transaction callback (conflict from the
    // active-project guard, conflict from the FK-violation defense,
    // notFound from the prior-row lookup) rolls the tx back and
    // propagates with its AppError prototype preserved — the route
    // layer's error handler maps each to its HTTP status without
    // further massaging here.
    await this.db.transaction(async (tx) => {
      // Customer row before any draft row, the order a correction takes
      // them in; the opposite order deadlocks against it.
      const priorRow = await getCustomerRowForMutation(tx, id);
      if (!priorRow) throw notFound(STRINGS.entities.customer);

      const activeProjects = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.customerId, id), eq(projects.deleted, false)))
        .limit(1);

      if (activeProjects.length > 0) {
        throw conflict(STRINGS.customers.hasProjects);
      }

      // AC-532: any issued or cancelled invoice across the customer's
      // project graph (active + archived) blocks the delete. Drafts
      // cascade-delete with their parent project and DO NOT count.
      // The check runs INSIDE the tx so a concurrent issue committed
      // between the probe and the cascade is observed; the FK cascade
      // path on `invoices.project_id` would have to wait for our locks
      // anyway, but the explicit precondition makes the failure
      // observable as a structured error rather than a constraint
      // violation post-cascade.
      const invoiceCount = await countIssuedOrCancelledForCustomer(tx, id);
      if (invoiceCount > 0) {
        throw customerHasInvoices({ invoiceCount });
      }

      // All referencing projects (if any) are archived. Purge them and
      // the customer atomically — the archive has no value without the
      // customer. `project_workers` rows cascade via FK.
      const archived = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.customerId, id), eq(projects.deleted, true)));

      for (const row of archived) {
        collectedKeys.push(...(await listKeysForProject(tx, row.id)));
        const { auditRow } = await mutateInTx(tx, ctx, {
          entityType: 'project',
          action: 'purge',
          run: async (innerTx) => {
            await hardDeleteProjectUnchecked(innerTx, row.id);
            return {
              entityId: row.id,
              entityLabel: projectAuditLabel(row),
              value: null,
              before: { number: row.number, title: row.title, customerId: row.customerId },
              after: {},
              // Self-ancestor (architecture.md §11.12) — purged-project
              // rows remain available under the project's activity feed
              // filter until audit retention sweeps them.
              ancestorEntityType: 'project',
              ancestorEntityId: row.id,
              ancestorEntityLabel: projectAuditLabel(row),
            };
          },
        });
        collectedAudit.push(auditRow);
      }

      if (archived.length > 0) {
        purgedArchivedProjects = true;
        log.info(
          { customerId: id, archivedProjectsRemoved: archived.length },
          'archived_projects_purged',
        );
      }

      const { auditRow: deleteAudit } = await mutateInTx(tx, ctx, {
        entityType: 'customer',
        action: 'delete',
        run: async (innerTx) => {
          try {
            await deleteCustomerRepo(innerTx, id);
          } catch (dbErr) {
            // A project restored after the `activeProjects` probe takes
            // no customer lock, so this DELETE can still hit a 23503 FK
            // violation. Map it to the 409 "has projects" contract.
            if (
              typeof dbErr === 'object' &&
              dbErr !== null &&
              (dbErr as { code?: string }).code === '23503'
            ) {
              throw conflict(STRINGS.customers.hasProjects);
            }
            throw dbErr;
          }

          return {
            entityId: id,
            entityLabel: priorRow.name,
            value: null,
            before: customerDiffFields({
              name: priorRow.name,
              phone: priorRow.phone,
              email: priorRow.email,
              address: priorRow.address,
              ustId: priorRow.ustId,
              notes: priorRow.notes,
            }),
            after: {},
          };
        },
      });
      collectedAudit.push(deleteAudit);
    });

    // Publisher dispatch runs after the transaction commits — AC-183.
    await dispatchAuditRows(collectedAudit);

    // Post-commit project-list invalidation (AC-276). The cascade
    // purged at least one archived project — observers refetch the
    // project list once. Skip when the customer had no archived
    // projects: the rows visible to subscribers did not change.
    if (purgedArchivedProjects) {
      emitProjectChanged();
      // The FK cascade removed the purged projects' drafts (api.md §14.2.13).
      emitInvoiceChanged();
    }

    // Post-commit storage-usage invalidation (AC-270). The atomic
    // archived-project purge cascaded each project's attachments away;
    // observers' Footer badge / DatenView row need to refetch. Skip
    // when no byte-bearing rows were touched — pending rows or empty
    // projects do not move the global figure.
    if (collectedKeys.some((entry) => entry.status === 'ready' || entry.status === 'hidden')) {
      emitStorageUsageChanged();
    }

    // Post-commit storage cleanup (AC-540), best-effort as for a project
    // purge (AC-429): the rows are gone, an orphaned key is logged.
    await bestEffortHideStorageKeys(this.storage, collectedKeys, log);

    log.info({ customerId: id }, 'customer_deleted');
  }
}

/**
 * Compute the `before` / `after` pair for a customer update, including
 * only the fields that were actually specified in the patch. Omitted
 * keys do not appear in either side of the diff — matches the spec's
 * "changed fields only" contract (data-model.md §5.10).
 */
function diffCustomerChange(
  priorRow: {
    name: string;
    phone: string | null;
    email: string | null;
    address: { street: string; zip: string; city: string } | null;
    ustId: string | null;
    notes: string | null;
  },
  patch: {
    name?: string;
    phone?: string | null;
    email?: string | null;
    address?: { street: string; zip: string; city: string } | null;
    ustId?: string | null;
    notes?: string | null;
  },
): { before: CustomerDiff; after: CustomerDiff } {
  const before: CustomerDiff = {};
  const after: CustomerDiff = {};
  if (patch.name !== undefined) {
    before.name = priorRow.name;
    after.name = patch.name;
  }
  if ('phone' in patch) {
    before.phone = priorRow.phone ?? null;
    after.phone = patch.phone ?? null;
  }
  if ('email' in patch) {
    before.email = priorRow.email ?? null;
    after.email = patch.email ?? null;
  }
  if ('ustId' in patch) {
    before.ustId = priorRow.ustId ?? null;
    after.ustId = patch.ustId ?? null;
  }
  if ('address' in patch) {
    before.address = priorRow.address ?? null;
    after.address = patch.address ?? null;
  }
  if ('notes' in patch) {
    before.notes = priorRow.notes ?? null;
    after.notes = patch.notes ?? null;
  }
  return { before, after };
}
