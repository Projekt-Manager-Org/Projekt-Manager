/**
 * User repository — database operations for the users table.
 */

import { eq, count, asc, and, sql } from 'drizzle-orm';
import type { Database, MutatingDatabase, TransactionalDatabase } from '../db/connection.js';
import { users } from '../db/schema.js';
import type { ThemePreference } from '../../config/themeStorage.js';

export type UserRow = typeof users.$inferSelect;

/**
 * Narrow the raw `text` column type from Drizzle to the domain literal
 * union. The DB-level CHECK constraint `users_valid_theme_preference`
 * (migration 0013) guarantees the cast is sound at read time.
 */
function narrowThemePreference(value: string): ThemePreference {
  return value as ThemePreference;
}

/** API-facing user shape (never includes passwordHash). */
export function toUserResponse(row: UserRow) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    roles: row.roles,
    email: row.email ?? null,
    active: row.active,
    themePreference: narrowThemePreference(row.themePreference),
    pushMuted: row.pushMuted,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdBy: row.createdBy ?? null,
    updatedBy: row.updatedBy ?? null,
  };
}

/**
 * Minimal projection used by the assignee-filter dropdown on the project
 * management page: active users that hold the `worker` role, ordered by
 * displayName. The shape matches `Project.assignedWorkers` so the UI can
 * use a single type for both the assignment chips and the filter options.
 *
 * Pool-of-eligibles, not pool-of-currently-assigned: a worker with zero
 * project assignments still appears so the dropdown matches the existing
 * assignment-picker semantics (parity with AssignedWorkerEditor).
 *
 * Not caller-scoped — a worker viewing the filter sees the full pool but
 * their results list still narrows via `projectScopeForCaller`. The
 * dropdown is a UI-side picker, not a data-disclosure surface.
 */
export async function listAssignableWorkers(
  db: Database,
): Promise<{ userId: string; displayName: string }[]> {
  const rows = await db
    .select({ userId: users.id, displayName: users.displayName })
    .from(users)
    .where(and(eq(users.active, true), sql`'worker' = ANY(${users.roles})`))
    .orderBy(asc(users.displayName));
  return rows;
}

export async function listUsers(
  db: Database,
  opts: { offset?: number; limit?: number } = {},
): Promise<{ users: ReturnType<typeof toUserResponse>[]; total: number }> {
  const baseQuery = db.select().from(users).orderBy(asc(users.username));
  const paginatedQuery =
    opts.limit !== undefined ? baseQuery.limit(opts.limit).offset(opts.offset ?? 0) : baseQuery;

  const [rows, countResult] = await Promise.all([
    paginatedQuery,
    db.select({ value: count() }).from(users),
  ]);

  return {
    users: rows.map(toUserResponse),
    total: countResult[0]?.value ?? 0,
  };
}

export async function createUser(
  db: MutatingDatabase,
  data: {
    id?: string;
    username: string;
    displayName: string;
    passwordHash: string;
    roles: string[];
    email?: string | null;
    createdBy?: string | null;
    updatedBy?: string | null;
  },
): Promise<ReturnType<typeof toUserResponse>> {
  const rows = await db
    .insert(users)
    .values({
      ...(data.id !== undefined ? { id: data.id } : {}),
      username: data.username,
      displayName: data.displayName,
      passwordHash: data.passwordHash,
      roles: data.roles,
      email: data.email ?? null,
      active: true,
      createdBy: data.createdBy ?? null,
      updatedBy: data.updatedBy ?? null,
    })
    .returning();

  return toUserResponse(rows[0]!);
}

export async function updateUser(
  db: MutatingDatabase,
  id: string,
  actorId: string,
  data: {
    displayName?: string;
    roles?: string[];
    email?: string | null;
  },
): Promise<ReturnType<typeof toUserResponse> | null> {
  const setClause: Record<string, unknown> = {
    updatedAt: new Date(),
    updatedBy: actorId,
  };
  if (data.displayName !== undefined) setClause.displayName = data.displayName;
  if (data.roles !== undefined) setClause.roles = data.roles;
  if ('email' in data) setClause.email = data.email;

  const rows = await db.update(users).set(setClause).where(eq(users.id, id)).returning();
  if (rows.length === 0) return null;
  return toUserResponse(rows[0]!);
}

/**
 * Self-scope update — the authenticated user mutating their own row.
 *
 * The signature is deliberately narrow: only fields the user themselves
 * is allowed to change appear here. Identity-bearing fields (`username`,
 * `roles`, `active`) are excluded at the type level so that a mistake
 * in the route layer (e.g. forwarding an attacker-controlled body verbatim)
 * cannot reach the repository. See api.md §14.2.1 design notes.
 */
export async function updateSelf(
  db: MutatingDatabase,
  userId: string,
  patch: { themePreference?: ThemePreference; pushMuted?: boolean },
): Promise<ReturnType<typeof toUserResponse> | null> {
  const setClause: Record<string, unknown> = {
    updatedAt: new Date(),
    updatedBy: userId,
  };
  if (patch.themePreference !== undefined) {
    setClause.themePreference = patch.themePreference;
  }
  if (patch.pushMuted !== undefined) {
    setClause.pushMuted = patch.pushMuted;
  }

  const rows = await db.update(users).set(setClause).where(eq(users.id, userId)).returning();
  if (rows.length === 0) return null;
  return toUserResponse(rows[0]!);
}

export async function reactivateUser(
  db: MutatingDatabase,
  id: string,
  actorId: string,
): Promise<ReturnType<typeof toUserResponse> | null> {
  const rows = await db
    .update(users)
    .set({ active: true, updatedAt: new Date(), updatedBy: actorId })
    .where(eq(users.id, id))
    .returning();

  if (rows.length === 0) return null;
  return toUserResponse(rows[0]!);
}

export async function deleteUser(db: MutatingDatabase, id: string): Promise<boolean> {
  const rows = await db.delete(users).where(eq(users.id, id)).returning({ id: users.id });
  return rows.length > 0;
}

/**
 * Fetch and row-lock the user inside a delete. The lock waits for every
 * in-flight write that newly references the user (FK key-share lock) and
 * blocks later ones until the delete is done. Returns null when absent.
 */
export async function getUserRowForDelete(
  db: MutatingDatabase,
  id: string,
): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1).for('update');
  return rows[0] ?? null;
}

export async function findByUsername(
  db: TransactionalDatabase,
  username: string,
): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.username, username)).limit(1);
  return rows[0] ?? null;
}

export async function findById(db: TransactionalDatabase, id: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

// ADR-0021 carve-out: session events ("Authentication and session events
// are security events, not domain audit") are outside the audit-log write
// path. This signature intentionally takes `Database` rather than
// `MutatingDatabase` so the write does not require a `mutate()` wrapper.
// Do not widen other write paths to `Database` — the AC-179 type-level
// guarantee depends on them requiring a transaction handle.
export async function updateLastLogin(db: Database, id: string): Promise<void> {
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, id));
}

/**
 * Deactivate a user (soft-delete — data-model.md §6.9). `actorId` is
 * the UUID of the user performing the deactivation, or null when the
 * caller is a system action (seed, migration, test fixture) and no
 * human actor is available. Matches the audit-metadata contract in
 * data-model.md §5.5. See consolidation review B F-3 / round-2 B M-1.
 */
export async function deactivateUser(
  db: MutatingDatabase,
  id: string,
  actorId: string | null,
): Promise<ReturnType<typeof toUserResponse> | null> {
  const rows = await db
    .update(users)
    .set({ active: false, updatedAt: new Date(), updatedBy: actorId })
    .where(eq(users.id, id))
    .returning();

  if (rows.length === 0) return null;
  return toUserResponse(rows[0]!);
}

/**
 * Store a new password hash. `actorId` is the UUID of the user
 * performing the change (currently the same user — self-service
 * password change — but a future admin-reset endpoint would pass
 * the admin's id). Matches the audit-metadata contract in
 * data-model.md §5.5. See consolidation review B F-3.
 */
export async function changePassword(
  db: MutatingDatabase,
  id: string,
  newPasswordHash: string,
  actorId: string | null,
): Promise<void> {
  await db
    .update(users)
    .set({
      passwordHash: newPasswordHash,
      updatedAt: new Date(),
      updatedBy: actorId,
    })
    .where(eq(users.id, id));
}
