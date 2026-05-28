/**
 * Project dates service — planned-start / planned-end updates.
 *
 * Routes through `mutate()` (ADR-0021). Does NOT touch `statusChangedAt`
 * — date changes are orthogonal to workflow transitions.
 *
 * CRUD lives in ProjectCrudService; transitions live in
 * ProjectTransitionService.
 */

import type { Database } from '../db/connection.js';
import {
  updateDates as updateDatesRepo,
  ProjectNotFoundError,
  DateValidationError,
} from '../repositories/project.js';
import { STRINGS } from '../../config/strings.js';
import { notFound, validationError } from '../errors.js';
import { emit } from './events.js';
import type { ServiceLogger } from './Logger.js';
import { mutate } from './mutate.js';
import { projectAuditLabel } from '../../domain/audit.js';
import { emitProjectChanged } from '../sse/emitters.js';

export class ProjectDatesService {
  constructor(private db: Database) {}

  async updateDates(
    projectId: string,
    userId: string,
    dates: { plannedStart?: string | null; plannedEnd?: string | null },
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
          action: 'update',
          run: async (tx) => {
            const r = await updateDatesRepo(tx, projectId, userId, dates);
            return {
              entityId: projectId,
              entityLabel: projectAuditLabel(r.project),
              value: r,
              before: {
                plannedStart: r.before.plannedStart,
                plannedEnd: r.before.plannedEnd,
              },
              after: {
                plannedStart: r.after.plannedStart,
                plannedEnd: r.after.plannedEnd,
              },
              ancestorEntityType: 'project',
              ancestorEntityId: projectId,
              ancestorEntityLabel: projectAuditLabel(r.project),
            };
          },
        },
      );
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw notFound(STRINGS.entities.project);
      if (err instanceof DateValidationError) throw validationError(err.message);
      throw err;
    }

    emitProjectChanged();

    await emit(
      'project.dates_changed',
      {
        projectId,
        actorUserId: userId,
        occurredAt: new Date(),
        plannedStart: dates.plannedStart,
        plannedEnd: dates.plannedEnd,
      },
      log,
    );

    return result.project;
  }
}
