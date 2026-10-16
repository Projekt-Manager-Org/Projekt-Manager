/**
 * Project repository — date update operations.
 */

import { eq, and } from 'drizzle-orm';
import type { MutatingDatabase } from '../db/connection.js';
import { projects, customers } from '../db/schema.js';
import { STRINGS } from '../../config/strings.js';
import { toProject, fetchWorkersForProject, ProjectNotFoundError } from './project-read.js';

export interface UpdateDatesResult {
  project: ReturnType<typeof toProject>;
  before: { plannedStart: Date | null; plannedEnd: Date | null };
  after: { plannedStart: Date | null; plannedEnd: Date | null };
}

/**
 * Update planned dates on a project.
 * Must NOT update statusChangedAt.
 * Validates: end >= start, no end-only without start.
 *
 * Accepts a transactional handle — the caller (the `mutate()` wrapper
 * in ProjectDatesService.updateDates) owns the transaction so the read of
 * the current row and the write happen under the same snapshot.
 */
export async function updateDates(
  db: MutatingDatabase,
  id: string,
  userId: string,
  dates: { plannedStart?: string | null; plannedEnd?: string | null },
): Promise<UpdateDatesResult> {
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.deleted, false)))
    .limit(1);

  if (rows.length === 0) {
    throw new ProjectNotFoundError();
  }

  const project = rows[0]!;

  // Effective dates after the update. PATCH is partial: a key that is
  // absent means "don't touch". An explicit `null` means "clear". A
  // string means "set". An earlier version auto-cleared plannedEnd
  // whenever plannedStart was sent alone — that silently wiped user
  // data (an edit-start-date flow lost end-date on every save). The
  // invariant (end >= start, no end-only) is enforced by validation
  // below; the server surfaces the validator's German message instead
  // of papering over a conflict with data loss.
  const effectiveStart =
    'plannedStart' in dates
      ? dates.plannedStart
        ? new Date(dates.plannedStart)
        : null
      : (project.plannedStart ?? null);
  const effectiveEnd =
    'plannedEnd' in dates
      ? dates.plannedEnd
        ? new Date(dates.plannedEnd)
        : null
      : (project.plannedEnd ?? null);

  if (effectiveEnd && !effectiveStart) {
    throw new DateValidationError(STRINGS.projects.endWithoutStart);
  }

  if (effectiveEnd && effectiveStart && effectiveEnd < effectiveStart) {
    throw new DateValidationError(STRINGS.projects.endBeforeStart);
  }

  const now = new Date();

  const updateData: Record<string, unknown> = {
    updatedAt: now,
    updatedBy: userId,
  };

  if ('plannedStart' in dates) {
    updateData.plannedStart = effectiveStart;
  }

  if ('plannedEnd' in dates) {
    updateData.plannedEnd = effectiveEnd;
  }

  const updated = await db.update(projects).set(updateData).where(eq(projects.id, id)).returning();

  const updatedRow = updated[0]!;

  const [workers, customerRows] = await Promise.all([
    fetchWorkersForProject(db, id),
    db.select().from(customers).where(eq(customers.id, updatedRow.customerId)).limit(1),
  ]);
  return {
    project: toProject(updatedRow, customerRows[0] ?? null, workers),
    before: {
      plannedStart: project.plannedStart ?? null,
      plannedEnd: project.plannedEnd ?? null,
    },
    after: {
      plannedStart: updatedRow.plannedStart ?? null,
      plannedEnd: updatedRow.plannedEnd ?? null,
    },
  };
}

/** Thrown when date validation fails. */
export class DateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DateValidationError';
  }
}
