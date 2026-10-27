/**
 * Project repository — state transition operations.
 */

import { eq } from 'drizzle-orm';
import type { MutatingDatabase } from '../db/connection.js';
import { projects, customers } from '../db/schema.js';
import { WORKFLOW_ORDER } from '../../config/stateConfig.js';
import type { WorkflowState } from '../../config/stateConfig.js';
import { STRINGS } from '../../config/strings.js';
import { toProject, fetchWorkersForProject, ProjectNotFoundError } from './project-read.js';

/**
 * Result of a transition: the previous status, the previous
 * `statusChangedAt`, and the updated project.
 *
 * `before` equals the client's `expectedStatus` — the guard that
 * `before` did not drift from the client's view is enforced by the
 * conditional UPDATE, so returning the asserted value is accurate for
 * audit/event subscribers.
 *
 * `beforeStatusChangedAt` is the pre-transition `status_changed_at`
 * value read atomically with the UPDATE via a `SELECT ... FOR UPDATE`
 * inside the caller's transaction. The audit-row payload spec pins
 * `before: { status, statusChangedAt }` (data-model.md §5.10) —
 * without the prior `statusChangedAt` on the repo result the service
 * layer cannot populate that field faithfully.
 */
export interface TransitionResult {
  before: WorkflowState;
  beforeStatusChangedAt: Date;
  project: ReturnType<typeof toProject>;
}

/**
 * Transition a project forward by one state.
 *
 * The caller supplies `expectedStatus` — the status the client observed in its
 * last read. A single conditional UPDATE advances the row only when the stored
 * status still matches that value; a sequential double-advance (two clicks in
 * sequence, two tabs, etc.) deterministically resolves to CONFLICT on the
 * second attempt because its `expectedStatus` no longer matches the DB.
 *
 * `now` is the clock seam the invoice issuance passes through, so the
 * project's `statusChangedAt` matches the invoice's `issueDate`.
 */
export async function transitionForward(
  db: MutatingDatabase,
  id: string,
  userId: string,
  expectedStatus: WorkflowState,
  now: Date,
): Promise<TransitionResult> {
  const currentIndex = WORKFLOW_ORDER.indexOf(expectedStatus);
  if (currentIndex === -1 || currentIndex === WORKFLOW_ORDER.length - 1) {
    throw new TransitionError(STRINGS.projects.cannotAdvanceTerminal);
  }
  const nextStatus = WORKFLOW_ORDER[currentIndex + 1]!;
  return applyTransition(db, id, userId, expectedStatus, nextStatus, now);
}

/**
 * Transition a project backward by one state.
 *
 * Same `expectedStatus` and `now` contract as `transitionForward`.
 */
export async function transitionBackward(
  db: MutatingDatabase,
  id: string,
  userId: string,
  expectedStatus: WorkflowState,
  now: Date,
): Promise<TransitionResult> {
  const currentIndex = WORKFLOW_ORDER.indexOf(expectedStatus);
  if (currentIndex === -1) {
    throw new TransitionError(STRINGS.projects.cannotRevertFirst);
  }
  if (currentIndex === 0) {
    throw new TransitionError(STRINGS.projects.cannotRevertFirst);
  }
  if (currentIndex === WORKFLOW_ORDER.length - 1) {
    throw new TransitionError(STRINGS.projects.cannotRevertTerminal);
  }
  const prevStatus = WORKFLOW_ORDER[currentIndex - 1]!;
  return applyTransition(db, id, userId, expectedStatus, prevStatus, now);
}

async function applyTransition(
  db: MutatingDatabase,
  id: string,
  userId: string,
  expectedStatus: WorkflowState,
  nextStatus: WorkflowState,
  now: Date,
): Promise<TransitionResult> {
  // Row-lock the target and capture its pre-transition status + timestamp
  // in one step. The caller is always inside `mutate()`/`mutateInTx()`
  // (the `MutatingDatabase` type enforces this — see db/connection.ts),
  // so `FOR UPDATE` is valid and the lock is held until the outer
  // transaction commits or rolls back. Two concurrent transitions on the
  // same row serialize on the lock; the loser observes the new status
  // after the winner commits and falls into the `ConcurrentModificationError`
  // branch below.
  //
  // The earlier implementation used a conditional UPDATE that returned
  // the new row but could not surface the prior `statusChangedAt` —
  // the audit payload contract (data-model.md §5.10: "For a state
  // transition, `before` and `after` carry `status` and
  // `statusChangedAt`") requires both values.
  // Use the Drizzle query builder (not raw `execute(sql\`...\`)`) so the
  // returned row is typed and key names match the Drizzle column map —
  // `statusChangedAt` (camelCase) rather than `status_changed_at`
  // (snake_case, which is what node-postgres returns for raw execute()).
  const priorRows = await db
    .select({
      status: projects.status,
      statusChangedAt: projects.statusChangedAt,
      deleted: projects.deleted,
    })
    .from(projects)
    .where(eq(projects.id, id))
    // NO KEY UPDATE, the lock the UPDATE below takes anyway: transitions
    // still serialize, but an open tx holding KEY SHARE through an FK
    // insert (attachment, draft, Storno) does not stall the issuance
    // atom, which reaches this lock holding the invoice sequence row.
    .for('no key update');
  const priorRow = priorRows[0];

  if (!priorRow || priorRow.deleted) {
    throw new ProjectNotFoundError();
  }
  if (priorRow.status !== expectedStatus) {
    // Status drifted under us — client's read is stale. Same error as the
    // pre-FOR-UPDATE implementation's conditional-UPDATE zero-row branch.
    throw new ConcurrentModificationError();
  }

  const beforeStatusChangedAt = priorRow.statusChangedAt;

  const updated = await db
    .update(projects)
    .set({
      status: nextStatus,
      statusChangedAt: now,
      updatedAt: now,
      updatedBy: userId,
    })
    .where(eq(projects.id, id))
    .returning();

  // Zero-row return here would be a bug — the row was locked above and
  // the transaction hasn't released it yet. Keep the defensive branch so
  // any future refactor that breaks the invariant surfaces loudly.
  if (updated.length === 0) {
    throw new ConcurrentModificationError();
  }

  const row = updated[0]!;
  const [workers, customerRows] = await Promise.all([
    fetchWorkersForProject(db, id),
    db.select().from(customers).where(eq(customers.id, row.customerId)).limit(1),
  ]);
  return {
    before: expectedStatus,
    beforeStatusChangedAt,
    project: toProject(row, customerRows[0] ?? null, workers),
  };
}

/** Thrown when a state transition is invalid. */
export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransitionError';
  }
}

/** Thrown when a concurrent modification prevented the transition. */
export class ConcurrentModificationError extends Error {
  constructor() {
    super(STRINGS.projects.concurrentModification);
    this.name = 'ConcurrentModificationError';
  }
}
