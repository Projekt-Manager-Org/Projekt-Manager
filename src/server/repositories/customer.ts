/**
 * Customer repository — CRUD operations.
 */

import { eq, and, count, ilike, inArray, sql, type SQL } from 'drizzle-orm';
import type { Database, MutatingDatabase, TransactionalDatabase } from '../db/connection.js';
import { customers, projects, invoices } from '../db/schema.js';
import type { AuthUser } from '../middleware/auth.js';
import {
  customerScopeForCaller,
  isCustomerInScope,
  isUnscoped,
  OUT_OF_SCOPE,
  type ScopedReadResult,
} from './scope.js';

/** Escape LIKE-pattern metacharacters so user input is treated literally. */
function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&');
}

/**
 * Columns the customer list endpoint may be sorted by. The route schema
 * uses this as a JSON-schema `enum`, and the repo's order-by builder
 * dispatches on it — keeping the source of truth here means a new
 * column can be added in one place.
 */
export const CUSTOMER_SORT_KEYS = ['name', 'phone', 'email', 'city'] as const;
export type CustomerSortKey = (typeof CUSTOMER_SORT_KEYS)[number];

/**
 * Build the ORDER BY fragment for a customer list query. Nullable columns
 * use NULLS LAST in both directions so empty cells sit at the bottom
 * regardless of ascending/descending — a fixed sink keeps the order of
 * non-null rows readable as the user toggles direction.
 *
 * The `name` tiebreaker keeps the result deterministic when the primary
 * column has ties (e.g. many customers in the same city); without it,
 * pagination would drift between requests.
 */
function customerOrderBy(sortBy: CustomerSortKey, sortDir: 'asc' | 'desc'): SQL {
  const dir = sql.raw(sortDir === 'desc' ? 'DESC' : 'ASC');
  // Non-primary clauses tiebreak on name; the name branch is its own
  // primary, so it falls through to `id` instead — `customers.name` is
  // notNull but not unique, so two rows with identical names would
  // otherwise drift between paginated requests.
  const tiebreakByName = sql`, ${customers.name} ASC, ${customers.id} ASC`;
  const tiebreakById = sql`, ${customers.id} ASC`;
  switch (sortBy) {
    case 'name':
      return sql`${customers.name} ${dir}${tiebreakById}`;
    case 'phone':
      return sql`${customers.phone} ${dir} NULLS LAST${tiebreakByName}`;
    case 'email':
      return sql`${customers.email} ${dir} NULLS LAST${tiebreakByName}`;
    case 'city':
      // `address` is a JSONB column; `->>'city'` extracts city as text.
      // Whole address can be NULL, hence NULLS LAST.
      return sql`(${customers.address}->>'city') ${dir} NULLS LAST${tiebreakByName}`;
  }
}

export type CustomerRow = typeof customers.$inferSelect;

export function toCustomerResponse(row: CustomerRow) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone ?? null,
    email: row.email ?? null,
    address: row.address ?? null,
    // USt-IdNr. — data-model.md §5.6 / AC-306. Structurally optional;
    // requiredness gate fires at invoice issuance when taxMode =
    // 'reverse_charge'. Round-trips on POST/PATCH/GET.
    ustId: row.ustId ?? null,
    notes: row.notes ?? null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdBy: row.createdBy ?? null,
    updatedBy: row.updatedBy ?? null,
  };
}

export async function listCustomers(
  db: Database,
  caller: AuthUser,
  opts: {
    offset?: number;
    limit?: number;
    search?: string;
    sortBy?: CustomerSortKey;
    sortDir?: 'asc' | 'desc';
  } = {},
): Promise<{ customers: ReturnType<typeof toCustomerResponse>[]; total: number }> {
  // AC-146: apply per-caller read scope. Worker sees only customers linked
  // through non-deleted projects they're assigned to; owner/office/bookkeeper
  // unscoped.
  const searchCondition = opts.search
    ? ilike(customers.name, `%${escapeLike(opts.search)}%`)
    : undefined;
  const scopeCondition = customerScopeForCaller(caller) ?? undefined;

  const whereClause =
    searchCondition && scopeCondition
      ? and(searchCondition, scopeCondition)
      : (searchCondition ?? scopeCondition);

  const orderBy = customerOrderBy(opts.sortBy ?? 'name', opts.sortDir ?? 'asc');

  const baseQuery = whereClause
    ? db.select().from(customers).where(whereClause).orderBy(orderBy)
    : db.select().from(customers).orderBy(orderBy);

  const paginatedQuery =
    opts.limit !== undefined ? baseQuery.limit(opts.limit).offset(opts.offset ?? 0) : baseQuery;

  const countQuery = whereClause
    ? db.select({ value: count() }).from(customers).where(whereClause)
    : db.select({ value: count() }).from(customers);

  const [rows, countResult] = await Promise.all([paginatedQuery, countQuery]);
  const total = countResult[0]?.value ?? 0;

  return {
    customers: rows.map(toCustomerResponse),
    total,
  };
}

/**
 * Get a customer by id, respecting the caller's read scope (AC-148).
 *
 * Three-valued result (ADR-0019):
 *   - `null`              — row does not exist (→ 404 NOT_FOUND)
 *   - `OUT_OF_SCOPE`      — row exists but caller cannot reach it via any
 *                           assigned non-deleted project (→ 403 NOT_PERMITTED)
 *   - hydrated row        — in-scope row
 */
export async function getCustomer(
  db: Database,
  caller: AuthUser,
  id: string,
): Promise<
  ScopedReadResult<
    ReturnType<typeof toCustomerResponse> & {
      projectCount: number;
      archivedProjectCount: number;
      invoiceCount: number;
    }
  >
> {
  const rows = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
  if (rows.length === 0) return null;

  if (!(await isCustomerInScope(db, caller, id))) {
    return OUT_OF_SCOPE;
  }

  // Scope the project counts to the caller's assignment graph. A worker
  // assigned to 1 of 2 projects for this customer must see projectCount: 1,
  // not 2 — surfacing the higher number leaks row existence the worker
  // cannot otherwise observe and misleads the UI (ADR-0019). Unscoped
  // callers (owner/office/bookkeeper) get the full count unchanged. The
  // EXISTS fragment mirrors `projectScopeForCaller` in scope.ts — same
  // correlation (`projects.id` from the outer query), kept local here
  // because the surrounding query is driven off projects directly.
  const callerAssignmentFilter = isUnscoped(caller)
    ? undefined
    : sql`EXISTS (
        SELECT 1 FROM project_workers pw
        WHERE pw.project_id = projects.id
          AND pw.user_id = ${caller.id}
      )`;

  const [[activeCount], [archivedCount], [invoiceCountRow]] = await Promise.all([
    db
      .select({ value: count() })
      .from(projects)
      .where(and(eq(projects.customerId, id), eq(projects.deleted, false), callerAssignmentFilter)),
    db
      .select({ value: count() })
      .from(projects)
      .where(and(eq(projects.customerId, id), eq(projects.deleted, true), callerAssignmentFilter)),
    // AC-307 trailing clause: the customer GET exposes the count of
    // issued + cancelled invoice rows across the project graph
    // (active + archived). Drafts excluded by construction — they have
    // no legal weight and cascade-delete with their project. The UI
    // uses this number to disable the destructive-delete affordance.
    db
      .select({ value: count() })
      .from(invoices)
      .innerJoin(projects, eq(invoices.projectId, projects.id))
      .where(and(eq(projects.customerId, id), inArray(invoices.status, ['issued', 'cancelled']))),
  ]);

  return {
    ...toCustomerResponse(rows[0]!),
    projectCount: activeCount?.value ?? 0,
    archivedProjectCount: archivedCount?.value ?? 0,
    invoiceCount: invoiceCountRow?.value ?? 0,
  };
}

export async function createCustomer(
  db: MutatingDatabase,
  data: {
    id?: string;
    name: string;
    phone?: string | null;
    email?: string | null;
    address?: { street: string; zip: string; city: string } | null;
    ustId?: string | null;
    notes?: string | null;
    createdBy?: string | null;
    updatedBy?: string | null;
  },
): Promise<ReturnType<typeof toCustomerResponse>> {
  const rows = await db
    .insert(customers)
    .values({
      ...(data.id !== undefined ? { id: data.id } : {}),
      name: data.name,
      phone: data.phone ?? null,
      email: data.email ?? null,
      address: data.address ?? null,
      ustId: data.ustId ?? null,
      notes: data.notes ?? null,
      createdBy: data.createdBy ?? null,
      updatedBy: data.updatedBy ?? null,
    })
    .returning();

  return toCustomerResponse(rows[0]!);
}

/**
 * Fetch the raw DB row by id. Returns null when absent. Used by the
 * idempotency path in CustomerService.createCustomer — it compares stored
 * fields (notably the raw JSONB address) against the request body.
 */
export async function getCustomerRow(
  db: TransactionalDatabase,
  id: string,
): Promise<CustomerRow | null> {
  const rows = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Fetch and row-lock the customer for a versioned edit (data-model.md
 * §6.4): the lock holds until commit, so the version check and the
 * write are atomic. Returns null when absent.
 */
export async function getCustomerRowForMutation(
  db: MutatingDatabase,
  id: string,
): Promise<CustomerRow | null> {
  const rows = await db.select().from(customers).where(eq(customers.id, id)).limit(1).for('update');
  return rows[0] ?? null;
}

export async function updateCustomer(
  db: MutatingDatabase,
  id: string,
  userId: string,
  data: {
    name?: string;
    phone?: string | null;
    email?: string | null;
    address?: { street: string; zip: string; city: string } | null;
    ustId?: string | null;
    notes?: string | null;
  },
): Promise<ReturnType<typeof toCustomerResponse> | null> {
  const setClause: Record<string, unknown> = {
    updatedAt: new Date(),
    updatedBy: userId,
  };
  if (data.name !== undefined) setClause.name = data.name;
  if ('phone' in data) setClause.phone = data.phone;
  if ('email' in data) setClause.email = data.email;
  if ('address' in data) setClause.address = data.address;
  if ('ustId' in data) setClause.ustId = data.ustId;
  if ('notes' in data) setClause.notes = data.notes;

  const rows = await db.update(customers).set(setClause).where(eq(customers.id, id)).returning();

  if (rows.length === 0) return null;
  return toCustomerResponse(rows[0]!);
}

export async function deleteCustomer(db: MutatingDatabase, id: string): Promise<boolean> {
  const rows = await db
    .delete(customers)
    .where(eq(customers.id, id))
    .returning({ id: customers.id });
  return rows.length > 0;
}
