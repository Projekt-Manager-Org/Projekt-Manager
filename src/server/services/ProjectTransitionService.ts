/**
 * Project transition service — workflow state forward/backward moves.
 *
 * Transitions route through `mutate()` (ADR-0021). Payloads carry both
 * `status` and `statusChangedAt` on each side (data-model.md §5.10) so
 * the audit view can render the exact duration the row spent in the
 * previous state.
 *
 * CRUD lives in ProjectCrudService; planned-date updates live in
 * ProjectDatesService.
 */

import type { Database, MutatingDatabase } from '../db/connection.js';
import {
  transitionForward as transitionForwardRepo,
  transitionBackward as transitionBackwardRepo,
  ProjectNotFoundError,
  TransitionError,
  ConcurrentModificationError,
} from '../repositories/project.js';
import type { TransitionResult } from '../repositories/project-transitions.js';
import type { WorkflowState } from '../../config/stateConfig.js';
import { STRINGS } from '../../config/strings.js';
import { notFound, validationError, conflict } from '../errors.js';
import { emit } from './events.js';
import type { ServiceLogger } from './Logger.js';
import { mutate, mutateInTx, type MutateContext, type MutateSpec } from './mutate.js';
import type { AuditLogRow } from './audit-publisher.js';
import { projectAuditLabel } from '../../domain/audit.js';
import { emitProjectChanged } from '../sse/emitters.js';

/**
 * The audited transition, shared by the manual moves below and the
 * invoice issuance atom (architecture.md §11.14 step 7).
 */
function transitionSpec(
  direction: 'forward' | 'backward',
  projectId: string,
  userId: string,
  expectedStatus: WorkflowState,
  now: Date,
): MutateSpec<TransitionResult> {
  return {
    entityType: 'project',
    action: direction === 'forward' ? 'transition:forward' : 'transition:backward',
    run: async (tx) => {
      const repo = direction === 'forward' ? transitionForwardRepo : transitionBackwardRepo;
      const repoResult = await repo(tx, projectId, userId, expectedStatus, now);
      return {
        entityId: projectId,
        entityLabel: projectAuditLabel(repoResult.project),
        value: repoResult,
        // data-model.md §5.10: a transition's before/after carry
        // BOTH `status` and `statusChangedAt`. The prior
        // `statusChangedAt` is read atomically with the UPDATE in
        // the repo (SELECT FOR UPDATE) so the audit view can show
        // the exact duration the row spent in the previous state.
        before: {
          status: repoResult.before,
          statusChangedAt: repoResult.beforeStatusChangedAt.toISOString(),
        },
        after: {
          status: repoResult.project.status,
          statusChangedAt: repoResult.project.statusChangedAt,
        },
        ancestorEntityType: 'project',
        ancestorEntityId: projectId,
        ancestorEntityLabel: projectAuditLabel(repoResult.project),
      };
    },
  };
}

/**
 * Forward transition inside the caller's transaction. Repo errors
 * (`ConcurrentModificationError`, `ProjectNotFoundError`) propagate
 * unmapped; the caller dispatches the returned audit row after commit.
 */
export async function transitionForwardInTx(
  tx: MutatingDatabase,
  ctx: MutateContext,
  projectId: string,
  userId: string,
  expectedStatus: WorkflowState,
  now: Date,
): Promise<{ value: TransitionResult; auditRow: AuditLogRow }> {
  return mutateInTx(tx, ctx, transitionSpec('forward', projectId, userId, expectedStatus, now));
}

export class ProjectTransitionService {
  constructor(private db: Database) {}

  async transitionForward(
    projectId: string,
    userId: string,
    expectedStatus: WorkflowState,
    log: ServiceLogger,
    correlationId?: string | null,
  ) {
    let result;
    try {
      result = await mutate(
        this.db,
        { actorKind: 'user', actorId: userId, correlationId: correlationId ?? null },
        transitionSpec('forward', projectId, userId, expectedStatus, new Date()),
      );
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw notFound(STRINGS.entities.project);
      if (err instanceof TransitionError) throw validationError(err.message);
      if (err instanceof ConcurrentModificationError) throw conflict(err.message);
      throw err;
    }

    emitProjectChanged();

    await emit(
      'project.transitioned',
      {
        projectId,
        fromStatus: result.before,
        toStatus: result.project.status,
        direction: 'forward',
        actorUserId: userId,
        occurredAt: new Date(),
      },
      log,
    );

    return result.project;
  }

  async transitionBackward(
    projectId: string,
    userId: string,
    expectedStatus: WorkflowState,
    log: ServiceLogger,
    correlationId?: string | null,
  ) {
    let result;
    try {
      result = await mutate(
        this.db,
        { actorKind: 'user', actorId: userId, correlationId: correlationId ?? null },
        transitionSpec('backward', projectId, userId, expectedStatus, new Date()),
      );
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw notFound(STRINGS.entities.project);
      if (err instanceof TransitionError) throw validationError(err.message);
      if (err instanceof ConcurrentModificationError) throw conflict(err.message);
      throw err;
    }

    emitProjectChanged();

    await emit(
      'project.transitioned',
      {
        projectId,
        fromStatus: result.before,
        toStatus: result.project.status,
        direction: 'backward',
        actorUserId: userId,
        occurredAt: new Date(),
      },
      log,
    );

    return result.project;
  }
}
