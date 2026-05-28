/**
 * Project CRUD service — business logic for list/get/create/update/
 * archive/purge + worker-assignment side effects.
 *
 * Every domain-entity mutation routes through `mutate()` (ADR-0021).
 * Service methods capture `payload.before`/`after` for the audit row
 * inside the same transaction as the state change.
 *
 * Transitions live in ProjectTransitionService; planned-date updates
 * live in ProjectDatesService.
 */

import type { Database } from '../db/connection.js';
import {
  listProjects as listProjectsRepo,
  getProject as getProjectRepo,
  getProjectRowById,
  getProjectForMutation,
  insertProject as insertProjectRepo,
  updateProjectFields,
  diffProjectWorkers,
  addProjectWorker,
  removeProjectWorker,
  softDeleteProject as softDeleteProjectRepo,
  hardDeleteProject as hardDeleteProjectRepo,
  restoreProject as restoreProjectRepo,
  fetchWorkersForProject,
  getUserDisplayName,
  toProject,
  ProjectNotFoundError,
  ProjectNotArchivedError,
  ProjectNotArchivedForRestoreError,
} from '../repositories/project.js';
import { listKeysForProject } from '../repositories/attachment.js';
import {
  PROJECT_SORT_KEYS,
  type ListProjectsOpts,
  type ProjectRow,
  type ProjectSortKey,
} from '../repositories/project-read.js';

// Re-export the sort allowlist + key type so routes can validate the
// `sortBy` querystring without crossing the routes→repository boundary
// (architecture.md §11.2).
export { PROJECT_SORT_KEYS };
export type { ProjectSortKey };
import { customers, projects } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { WORKFLOW_ORDER, STATE_KEYS } from '../../config/stateConfig.js';
import type { WorkflowState } from '../../config/stateConfig.js';
import { STRINGS } from '../../config/strings.js';
import { DB_CONSTRAINTS } from '../db/constraints.js';
import {
  notFound,
  notPermitted,
  validationError,
  conflict,
  extractSqlState,
  projectHasInvoices,
} from '../errors.js';
import { countIssuedOrCancelledForProject } from '../repositories/invoice-read.js';
import { projectMatches, createIdempotent } from './idempotency.js';
import type { ServiceLogger } from './Logger.js';
import type { AuthUser } from '../middleware/auth.js';
import { isOutOfScope } from '../repositories/scope.js';
import { mutate, mutateInTx, dispatchAuditRows } from './mutate.js';
import type { AuditLogRow } from './audit-publisher.js';
import { projectAuditLabel } from '../../domain/audit.js';
import { bestEffortHideStorageKeys } from './AttachmentService.js';
import type { AttachmentStorageClient } from '../storage/client.js';
import { emitProjectChanged, emitStorageUsageChanged } from '../sse/emitters.js';

const VALID_STATES: ReadonlySet<string> = new Set(WORKFLOW_ORDER);

/**
 * Subset of project fields considered for the `update` audit payload.
 * Excludes server-managed timestamps and the immutable identifier — the
 * spec pins changed fields only.
 */
function projectUpdatableDiff(row: {
  title: string;
  customerId: string;
  siteAddress: { street: string; zip: string; city: string } | null;
  estimatedValue: string | null;
  notes: string | null;
}): Record<string, unknown> {
  return {
    title: row.title,
    customerId: row.customerId,
    siteAddress: row.siteAddress ?? null,
    estimatedValue: row.estimatedValue ?? null,
    notes: row.notes ?? null,
  };
}

export interface ProjectCrudServiceDeps {
  storage?: AttachmentStorageClient;
}

export class ProjectCrudService {
  private readonly storage: AttachmentStorageClient | null;

  constructor(
    private db: Database,
    deps: ProjectCrudServiceDeps = {},
  ) {
    this.storage = deps.storage ?? null;
  }

  async listProjects(caller: AuthUser, opts: ListProjectsOpts) {
    return listProjectsRepo(this.db, caller, opts);
  }

  async getProject(caller: AuthUser, id: string) {
    const result = await getProjectRepo(this.db, caller, id);
    if (result === null) throw notFound(STRINGS.entities.project);
    // AC-147: an existing project the caller is not assigned to surfaces
    // as 403 NOT_PERMITTED, not 404. The spec accepts the existence leak
    // because project IDs are UUIDs and callers are internal users.
    if (isOutOfScope(result)) throw notPermitted();
    // Archived rows flow through here unchanged with `deleted: true` on
    // the body — the UI renders them as a read-only preview. AC-95
    // immutability is enforced by mutation paths via getProjectForMutation.
    return result;
  }

  async createProject(
    data: {
      id?: string;
      number: string;
      title: string;
      customerId: string;
      status?: string;
      siteAddress?: { street: string; zip: string; city: string } | null;
      plannedStart?: string | null;
      plannedEnd?: string | null;
      assignedWorkerIds?: string[];
      estimatedValue?: number | null;
      notes?: string | null;
    },
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ) {
    const status = (data.status ?? STATE_KEYS[0]) as WorkflowState;
    if (!VALID_STATES.has(status)) {
      throw validationError(STRINGS.projects.invalidStatus(status));
    }

    if (data.id !== undefined) {
      return this.createProjectWithClientId(
        { ...data, id: data.id, status },
        userId,
        log,
        correlationId,
      );
    }

    try {
      const project = await this.runCreateWithAudit(
        {
          number: data.number,
          title: data.title,
          status,
          customerId: data.customerId,
          siteAddress: data.siteAddress ?? null,
          plannedStart: data.plannedStart ? new Date(data.plannedStart) : null,
          plannedEnd: data.plannedEnd ? new Date(data.plannedEnd) : null,
          assignedWorkerIds: data.assignedWorkerIds ?? [],
          estimatedValue: data.estimatedValue != null ? String(data.estimatedValue) : null,
          notes: data.notes ?? null,
        },
        userId,
        correlationId,
      );
      log.info({ projectId: project.id }, 'project_created');
      emitProjectChanged();
      return project;
    } catch (err) {
      const sqlState = extractSqlState(err);
      if (sqlState === '23505') throw conflict(STRINGS.projects.duplicateNumber(data.number));
      if (sqlState === '23503') throw validationError(STRINGS.projects.foreignKeyViolation);
      throw err;
    }
  }

  /**
   * Creates the project + optional worker assignments inside a single
   * transaction, emitting one `create` audit row for the project and
   * one `create` row per assigned worker. All commits happen atomically;
   * audit dispatch runs after commit (AC-177, AC-183).
   */
  private async runCreateWithAudit(
    data: {
      id?: string;
      number: string;
      title: string;
      status: WorkflowState;
      customerId: string;
      siteAddress: { street: string; zip: string; city: string } | null;
      plannedStart: Date | null;
      plannedEnd: Date | null;
      assignedWorkerIds: string[];
      estimatedValue: string | null;
      notes: string | null;
    },
    userId: string,
    correlationId?: string | null,
  ): Promise<ReturnType<typeof toProject>> {
    const ctx = {
      actorKind: 'user' as const,
      actorId: userId,
      correlationId: correlationId ?? null,
    };
    const collected: AuditLogRow[] = [];

    const project = await this.db.transaction(async (tx) => {
      const { value: inserted, auditRow: createRow } = await mutateInTx(tx, ctx, {
        entityType: 'project',
        action: 'create',
        run: async (innerTx) => {
          const row = await insertProjectRepo(innerTx, {
            id: data.id,
            number: data.number,
            title: data.title,
            status: data.status,
            customerId: data.customerId,
            siteAddress: data.siteAddress,
            plannedStart: data.plannedStart,
            plannedEnd: data.plannedEnd,
            estimatedValue: data.estimatedValue,
            notes: data.notes,
            createdBy: userId,
            updatedBy: userId,
          });
          return {
            entityId: row.id,
            entityLabel: projectAuditLabel(row),
            value: row,
            before: {},
            after: {
              number: row.number,
              title: row.title,
              status: row.status,
              customerId: row.customerId,
              siteAddress: row.siteAddress ?? null,
              plannedStart: row.plannedStart,
              plannedEnd: row.plannedEnd,
              estimatedValue: row.estimatedValue,
              notes: row.notes,
            },
            // Project rows self-ancestor (architecture.md §11.12).
            ancestorEntityType: 'project',
            ancestorEntityId: row.id,
            ancestorEntityLabel: projectAuditLabel(row),
          };
        },
      });
      collected.push(createRow);

      // Each worker assignment is its own audit event — the per-row
      // grain keeps the activity feed rendering "Mitarbeiter zugewiesen:
      // Jan Nowak" (ui/workflow-views.md §8.4.1) cheap. The payload
      // includes the worker's displayName so the feed doesn't need a
      // second round-trip.
      for (const workerId of data.assignedWorkerIds) {
        const { auditRow } = await mutateInTx(tx, ctx, {
          entityType: 'project_worker',
          action: 'create',
          run: async (innerTx) => {
            await addProjectWorker(innerTx, inserted.id, workerId);
            const displayName = await getUserDisplayName(innerTx, workerId);
            return {
              entityId: inserted.id,
              entityLabel: displayName ?? null,
              value: null,
              before: {},
              after: { projectId: inserted.id, userId: workerId, displayName },
              // Nested entity: ancestor = project (architecture.md §11.12).
              ancestorEntityType: 'project',
              ancestorEntityId: inserted.id,
              ancestorEntityLabel: projectAuditLabel(inserted),
            };
          },
        });
        collected.push(auditRow);
      }

      const workers = await fetchWorkersForProject(tx, inserted.id);
      const customerRows = await tx
        .select()
        .from(customers)
        .where(eq(customers.id, inserted.customerId))
        .limit(1);
      return toProject(inserted, customerRows[0] ?? null, workers);
    });

    await dispatchAuditRows(collected);
    return project;
  }

  private async createProjectWithClientId(
    data: {
      id: string;
      number: string;
      title: string;
      customerId: string;
      status: WorkflowState;
      siteAddress?: { street: string; zip: string; city: string } | null;
      plannedStart?: string | null;
      plannedEnd?: string | null;
      assignedWorkerIds?: string[];
      estimatedValue?: number | null;
      notes?: string | null;
    },
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ) {
    const matchInput = {
      number: data.number,
      title: data.title,
      customerId: data.customerId,
      status: data.status,
      siteAddress: data.siteAddress ?? null,
      plannedStart: data.plannedStart ?? null,
      plannedEnd: data.plannedEnd ?? null,
      assignedWorkerIds: data.assignedWorkerIds ?? [],
      estimatedValue: data.estimatedValue ?? null,
      notes: data.notes ?? null,
    };

    return createIdempotent({
      preSelectRow: () => getProjectRowById(this.db, data.id),
      replayFromRow: async (row) => {
        const workers = await fetchWorkersForProject(this.db, data.id);
        if (!this.storedMatchesIncoming(row, workers, matchInput)) return null;
        log.info({ projectId: data.id }, 'project_create_replayed');
        return this.hydrateReplayedProject(row, workers);
      },
      insert: async () => {
        try {
          const inserted = await this.runCreateWithAudit(
            {
              id: data.id,
              number: data.number,
              title: data.title,
              status: data.status,
              customerId: data.customerId,
              siteAddress: data.siteAddress ?? null,
              plannedStart: data.plannedStart ? new Date(data.plannedStart) : null,
              plannedEnd: data.plannedEnd ? new Date(data.plannedEnd) : null,
              assignedWorkerIds: data.assignedWorkerIds ?? [],
              estimatedValue: data.estimatedValue != null ? String(data.estimatedValue) : null,
              notes: data.notes ?? null,
            },
            userId,
            correlationId,
          );
          log.info({ projectId: data.id }, 'project_created');
          emitProjectChanged();
          return inserted;
        } catch (err) {
          // 23503 is customerId FK violation — map before the idempotency
          // helper sees it, since 23503 is not in its 23505 branch anyway.
          if (extractSqlState(err) === '23503') {
            throw validationError(STRINGS.projects.foreignKeyViolation);
          }
          throw err;
        }
      },
      // Id race: pkey, or driver omitted the constraint name.
      isIdRaceConstraint: (c) => c === DB_CONSTRAINTS.projects.pkey || c === null,
      // Any other 23505 — or pkey/null with no matching row on re-read — is
      // a real `number` collision. (Re-read finding nothing under pkey/null
      // means the 23505 was actually on number_unique; the driver just
      // didn't attach the constraint name.)
      onNonIdRaceConstraint: () => {
        throw conflict(STRINGS.projects.duplicateNumber(data.number));
      },
    });
  }

  private storedMatchesIncoming(
    row: ProjectRow,
    workers: { userId: string; displayName: string }[],
    incoming: {
      number: string;
      title: string;
      customerId: string;
      status: WorkflowState;
      siteAddress: { street: string; zip: string; city: string } | null;
      plannedStart: string | null;
      plannedEnd: string | null;
      assignedWorkerIds: string[];
      estimatedValue: number | null;
      notes: string | null;
    },
  ): boolean {
    return projectMatches(incoming, {
      number: row.number,
      title: row.title,
      customerId: row.customerId,
      status: row.status,
      siteAddress: row.siteAddress ?? null,
      plannedStart: row.plannedStart,
      plannedEnd: row.plannedEnd,
      assignedWorkerIds: workers.map((w) => w.userId),
      estimatedValue: row.estimatedValue,
      notes: row.notes,
    });
  }

  private async hydrateReplayedProject(
    row: ProjectRow,
    workers: { userId: string; displayName: string }[],
  ) {
    const customerRows = await this.db
      .select()
      .from(customers)
      .where(eq(customers.id, row.customerId))
      .limit(1);
    return toProject(row, customerRows[0] ?? null, workers);
  }

  /**
   * PATCH /api/projects/:id — field update and/or worker reassignment.
   *
   * Field updates (title/customerId/estimatedValue/notes) produce a
   * single `update` audit row carrying the diff.
   *
   * Worker reassignment produces one `project_worker` row per actual
   * add and one per actual remove — ids present in both sides are
   * idempotent no-ops with no audit event. If the caller supplies
   * only `assignedWorkerIds` without touching other fields, NO
   * `update` audit row is emitted for the project itself; only the
   * `project_worker` audit rows land. This matches the grain pinned
   * in AT-89 (count(project_worker audit rows) == count of changes).
   */
  async updateProject(
    id: string,
    data: {
      title?: string;
      customerId?: string;
      siteAddress?: { street: string; zip: string; city: string } | null;
      assignedWorkerIds?: string[];
      estimatedValue?: number | null;
      notes?: string | null;
    },
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ) {
    const ctx = {
      actorKind: 'user' as const,
      actorId: userId,
      correlationId: correlationId ?? null,
    };
    const collected: AuditLogRow[] = [];
    // PATCH semantics: presence of `siteAddress` (even as null) counts as a
    // field update — null clears the stored value, mirroring the customer-
    // address rule. `'siteAddress' in data` distinguishes from omission.
    const hasFieldUpdate =
      data.title !== undefined ||
      data.customerId !== undefined ||
      'siteAddress' in data ||
      data.estimatedValue !== undefined ||
      data.notes !== undefined;

    try {
      const project = await this.db.transaction(async (tx) => {
        const priorRow = await getProjectForMutation(tx, id);
        if (!priorRow) throw new ProjectNotFoundError();

        let currentRow: ProjectRow = priorRow;

        if (hasFieldUpdate) {
          const fieldUpdate = await mutateInTx(tx, ctx, {
            entityType: 'project',
            action: 'update',
            run: async (innerTx) => {
              const updated = await updateProjectFields(innerTx, id, userId, {
                title: data.title,
                customerId: data.customerId,
                // Pass through with `'siteAddress' in data` semantics so the
                // repo's set-clause distinguishes "clear" (null) from
                // "leave unchanged" (omitted).
                ...('siteAddress' in data ? { siteAddress: data.siteAddress ?? null } : {}),
                estimatedValue: data.estimatedValue,
                notes: data.notes,
              });
              if (!updated) throw new ProjectNotFoundError();

              const before: Record<string, unknown> = {};
              const after: Record<string, unknown> = {};
              const priorDiff = projectUpdatableDiff({
                title: priorRow.title,
                customerId: priorRow.customerId,
                siteAddress: priorRow.siteAddress ?? null,
                estimatedValue: priorRow.estimatedValue,
                notes: priorRow.notes,
              });
              const updatedDiff = projectUpdatableDiff({
                title: updated.title,
                customerId: updated.customerId,
                siteAddress: updated.siteAddress ?? null,
                estimatedValue: updated.estimatedValue,
                notes: updated.notes,
              });
              if (data.title !== undefined) {
                before.title = priorDiff.title;
                after.title = updatedDiff.title;
              }
              if (data.customerId !== undefined) {
                before.customerId = priorDiff.customerId;
                after.customerId = updatedDiff.customerId;
              }
              if ('siteAddress' in data) {
                before.siteAddress = priorDiff.siteAddress;
                after.siteAddress = updatedDiff.siteAddress;
              }
              if (data.estimatedValue !== undefined) {
                before.estimatedValue = priorDiff.estimatedValue;
                after.estimatedValue = updatedDiff.estimatedValue;
              }
              if (data.notes !== undefined) {
                before.notes = priorDiff.notes;
                after.notes = updatedDiff.notes;
              }

              return {
                entityId: id,
                entityLabel: projectAuditLabel(updated),
                value: updated,
                before,
                after,
                // Self-ancestor for a project row (architecture.md §11.12).
                ancestorEntityType: 'project',
                ancestorEntityId: id,
                ancestorEntityLabel: projectAuditLabel(updated),
              };
            },
          });
          collected.push(fieldUpdate.auditRow);
          currentRow = fieldUpdate.value;
        }

        // Worker reassignment — emit one audit row per add/remove. Each
        // row carries the worker's displayName so the activity feed can
        // render the user-facing message without a second lookup (see
        // `ui/workflow-views.md §8.4.1` and `describeAuditRow`).
        if (data.assignedWorkerIds !== undefined) {
          const { toAdd, toRemove } = await diffProjectWorkers(tx, id, data.assignedWorkerIds);
          for (const workerId of toRemove) {
            const res = await mutateInTx(tx, ctx, {
              entityType: 'project_worker',
              action: 'delete',
              run: async (innerTx) => {
                const displayName = await getUserDisplayName(innerTx, workerId);
                await removeProjectWorker(innerTx, id, workerId);
                return {
                  entityId: id,
                  entityLabel: displayName ?? null,
                  value: null,
                  before: { projectId: id, userId: workerId, displayName },
                  after: {},
                  ancestorEntityType: 'project',
                  ancestorEntityId: id,
                  ancestorEntityLabel: projectAuditLabel(currentRow),
                };
              },
            });
            collected.push(res.auditRow);
          }
          for (const workerId of toAdd) {
            const res = await mutateInTx(tx, ctx, {
              entityType: 'project_worker',
              action: 'create',
              run: async (innerTx) => {
                await addProjectWorker(innerTx, id, workerId);
                const displayName = await getUserDisplayName(innerTx, workerId);
                return {
                  entityId: id,
                  entityLabel: displayName ?? null,
                  value: null,
                  before: {},
                  after: { projectId: id, userId: workerId, displayName },
                  ancestorEntityType: 'project',
                  ancestorEntityId: id,
                  ancestorEntityLabel: projectAuditLabel(currentRow),
                };
              },
            });
            collected.push(res.auditRow);
          }
        }

        const workers = await fetchWorkersForProject(tx, id);
        const customerRows = await tx
          .select()
          .from(customers)
          .where(eq(customers.id, currentRow.customerId))
          .limit(1);
        return toProject(currentRow, customerRows[0] ?? null, workers);
      });

      await dispatchAuditRows(collected);

      log.info({ projectId: id }, 'project_updated');
      emitProjectChanged();
      return project;
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw notFound(STRINGS.entities.project);
      throw err;
    }
  }

  async deleteProject(
    id: string,
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ) {
    try {
      await mutate(
        this.db,
        { actorKind: 'user', actorId: userId, correlationId: correlationId ?? null },
        {
          entityType: 'project',
          // Soft-delete is the board-archive flow — ADR-0017 pins it as
          // a non-destructive operation (the row is recoverable). The
          // `archive` action keeps it distinct from hard-delete (`purge`)
          // and from the generic `delete` used on project_workers and
          // user entities. Payload is the spec-shaped `{ before: {...},
          // after: {} }` (data-model.md §5.10: "for a delete or purge,
          // `after` is empty") — the action key carries the semantic
          // distinction, not a `{ deleted: true }` flag in the payload.
          action: 'archive',
          run: async (tx) => {
            const priorRow = await getProjectForMutation(tx, id);
            if (!priorRow) throw new ProjectNotFoundError();
            await softDeleteProjectRepo(tx, id, userId);
            return {
              entityId: id,
              entityLabel: projectAuditLabel(priorRow),
              value: null,
              before: { number: priorRow.number, title: priorRow.title },
              after: {},
              ancestorEntityType: 'project',
              ancestorEntityId: id,
              ancestorEntityLabel: projectAuditLabel(priorRow),
            };
          },
        },
      );
      log.info({ projectId: id }, 'project_archived');
      emitProjectChanged();
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw notFound(STRINGS.entities.project);
      throw err;
    }
  }

  async restoreProject(
    id: string,
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ): Promise<ReturnType<typeof toProject>> {
    try {
      const project = await this.db.transaction(async (tx) => {
        let restoredRow: Awaited<ReturnType<typeof restoreProjectRepo>> | null = null;
        const ctx = {
          actorKind: 'user' as const,
          actorId: userId,
          correlationId: correlationId ?? null,
        };
        const { value } = await mutateInTx(tx, ctx, {
          entityType: 'project',
          // Inverse of `archive` — the row flips back from deleted=true.
          // ADR-0017 §1 used to forbid the UI affordance; the read-only
          // preview surfaced a real driver (fat-finger archive recovery)
          // so the destructive-paths section now includes restore.
          action: 'restore',
          run: async (innerTx) => {
            restoredRow = await restoreProjectRepo(innerTx, id, userId);
            return {
              entityId: id,
              entityLabel: projectAuditLabel(restoredRow),
              value: restoredRow,
              // Symmetric to archive's `before: {number, title}, after: {}`:
              // archive was the row leaving the active set, restore is the
              // row entering it. Action key carries the semantic.
              before: {},
              after: { number: restoredRow.number, title: restoredRow.title },
              ancestorEntityType: 'project',
              ancestorEntityId: id,
              ancestorEntityLabel: projectAuditLabel(restoredRow),
            };
          },
        });
        const restored = restoredRow ?? value;
        const workers = await fetchWorkersForProject(tx, id);
        const customerRows = await tx
          .select()
          .from(customers)
          .where(eq(customers.id, restored.customerId))
          .limit(1);
        return toProject(restored, customerRows[0] ?? null, workers);
      });
      log.info({ projectId: id }, 'project_restored');
      emitProjectChanged();
      return project;
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw notFound(STRINGS.entities.project);
      if (err instanceof ProjectNotArchivedForRestoreError) {
        throw conflict(STRINGS.projects.restoreRequiresArchive);
      }
      throw err;
    }
  }

  async purgeProject(
    id: string,
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ) {
    try {
      // Collect attachment storage keys before the purge commits so the
      // post-commit best-effort delete has something to work with
      // (AC-218). The FK cascade on `attachments.project_id` removes the
      // rows atomically with the project, but storage objects do not
      // cascade — the app must delete them explicitly.
      let collectedKeys: Array<{
        originalKey: string;
        thumbKey: string | null;
        status: 'pending' | 'ready' | 'hidden';
      }> = [];

      await mutate(
        this.db,
        { actorKind: 'user', actorId: userId, correlationId: correlationId ?? null },
        {
          entityType: 'project',
          action: 'purge',
          run: async (tx) => {
            // Read pre-delete state for the audit payload. `hardDeleteProjectRepo`
            // below throws `ProjectNotFoundError` if the row is missing, so by
            // the time `return` runs `priorRow` is guaranteed populated. The
            // outer catch maps `ProjectNotFoundError` / `ProjectNotArchivedError`
            // to HTTP codes.
            const priorRows = await tx.select().from(projects).where(eq(projects.id, id)).limit(1);
            const priorRow = priorRows[0];
            // AC-308: a project carrying any issued or cancelled invoice
            // is legally retained — purge is rejected with a dedicated
            // code so the UI can target the "retention" message rather
            // than the generic CONFLICT. Drafts cascade-delete with the
            // project and DO NOT count. The check runs INSIDE the tx so
            // a concurrent issue cannot slip through.
            if (priorRow) {
              const invoiceCount = await countIssuedOrCancelledForProject(tx, id);
              if (invoiceCount > 0) {
                throw projectHasInvoices({ invoiceCount });
              }
            }
            collectedKeys = await listKeysForProject(tx, id);
            await hardDeleteProjectRepo(tx, id);
            // hardDeleteProjectRepo threw if priorRow was missing, so it is
            // safe to dereference unconditionally from here.
            const label = projectAuditLabel(priorRow!);
            return {
              entityId: id,
              entityLabel: label,
              value: null,
              before: { number: priorRow!.number, title: priorRow!.title },
              after: {},
              ancestorEntityType: 'project',
              ancestorEntityId: id,
              ancestorEntityLabel: label,
            };
          },
        },
      );
      log.info({ projectId: id, actorUserId: userId }, 'project_purged');

      // Post-commit invalidation (AC-276). The project row is gone — every
      // project list / detail consumer must refetch unconditionally.
      emitProjectChanged();

      // Post-commit invalidation (AC-270). The FK cascade removed every
      // attachment row alongside the project; the per-row delete trigger
      // short-circuits at depth>1 and `project_storage_usage` is wiped
      // by its own cascade, so the global figure has moved by exactly
      // the bytes carried by the project's `ready` + `hidden` rows.
      // Pending rows contribute zero to every counter — emitting on a
      // purge whose attachments were all `pending` (or whose project had
      // no attachments) would force every observer to refetch identical
      // totals. Skip those cases.
      const movedBytes = collectedKeys.some(
        (entry) => entry.status === 'ready' || entry.status === 'hidden',
      );
      if (movedBytes) {
        emitStorageUsageChanged();
      }

      // Post-commit storage cleanup (AC-218). A failure here does not
      // abort the DB cascade — the rows are already gone; orphaned
      // keys are logged for operator cleanup.
      if (this.storage && collectedKeys.length > 0) {
        await bestEffortHideStorageKeys(this.storage, collectedKeys, log);
      }
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw notFound(STRINGS.entities.project);
      if (err instanceof ProjectNotArchivedError) {
        throw conflict(STRINGS.projects.purgeRequiresArchive);
      }
      throw err;
    }
  }
}
