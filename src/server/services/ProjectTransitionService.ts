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

import type { Database } from '../db/connection.js';
import {
  transitionForward as transitionForwardRepo,
  transitionBackward as transitionBackwardRepo,
  ProjectNotFoundError,
  TransitionError,
  ConcurrentModificationError,
} from '../repositories/project.js';
import type { WorkflowState } from '../../config/stateConfig.js';
import { STRINGS } from '../../config/strings.js';
import { notFound, validationError, conflict } from '../errors.js';
import { emit } from './events.js';
import type { ServiceLogger } from './Logger.js';
import { mutate } from './mutate.js';
import { projectAuditLabel } from '../../domain/audit.js';
import { emitProjectChanged } from '../sse/emitters.js';

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
        {
          entityType: 'project',
          action: 'transition:forward',
          run: async (tx) => {
            const repoResult = await transitionForwardRepo(tx, projectId, userId, expectedStatus);
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
        },
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
        {
          entityType: 'project',
          action: 'transition:backward',
          run: async (tx) => {
            const repoResult = await transitionBackwardRepo(tx, projectId, userId, expectedStatus);
            return {
              entityId: projectId,
              entityLabel: projectAuditLabel(repoResult.project),
              value: repoResult,
              // data-model.md §5.10: see `transitionForward` above for
              // the before/after shape rationale.
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
        },
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
