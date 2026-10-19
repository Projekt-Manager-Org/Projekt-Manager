/**
 * User management service — business logic for user CRUD, deactivation,
 * reactivation, and admin password reset.
 *
 * Every mutation routes through `mutate()` (ADR-0021). Sessions are a
 * transport-layer artifact, not an audited domain entity — their cascade
 * on deactivate/delete is part of the same transaction but is NOT
 * accompanied by an audit row (the user-entity row already captures
 * "user deactivated" or "user deleted" and that is what the activity
 * feed surfaces).
 */

import type { Database } from '../db/connection.js';

import {
  findById,
  listUsers as listUsersRepo,
  listAssignableWorkers as listAssignableWorkersRepo,
  createUser as createUserRepo,
  updateUser as updateUserRepo,
  deleteUser as deleteUserRepo,
  deactivateUser as deactivateUserRepo,
  reactivateUser as reactivateUserRepo,
  changePassword as changePasswordRepo,
  getUserRowForDelete,
  toUserResponse,
} from '../repositories/user.js';
import {
  countIssuedOrCancelledForUser,
  lockInvoicesReferencingUser,
} from '../repositories/invoice-read.js';
import { deleteSessionsByUserId } from '../repositories/session.js';
import { hashPassword } from '../password.js';
import { checkPasswordPolicy } from '../config/password-policy.js';
import { STRINGS } from '../../config/strings.js';
import {
  notFound,
  validationError,
  conflict,
  extractSqlState,
  userHasInvoices,
} from '../errors.js';
import type { ServiceLogger } from './Logger.js';
import { mutate } from './mutate.js';

export class UserService {
  constructor(private db: Database) {}

  async listUsers(opts: { offset?: number; limit?: number }) {
    return listUsersRepo(this.db, opts);
  }

  /**
   * Pool of users assignable as project Mitarbeiter (active + worker
   * role). Used by the project-management filter dropdown via
   * `GET /api/workers`. Minimal `{userId, displayName}` shape — never
   * leaks email / roles / other admin-only fields.
   */
  async listAssignableWorkers() {
    return listAssignableWorkersRepo(this.db);
  }

  async getUser(id: string) {
    const user = await findById(this.db, id);
    if (!user) throw notFound(STRINGS.entities.user);
    return toUserResponse(user);
  }

  async createUser(
    data: {
      username: string;
      displayName: string;
      password: string;
      roles: string[];
      email?: string | null;
    },
    actorId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ) {
    // Password policy
    const violation = checkPasswordPolicy(data.password);
    if (violation) {
      switch (violation.code) {
        case 'too_short':
          throw validationError(STRINGS.password.tooShort);
        case 'too_long':
          throw validationError(STRINGS.password.tooLong);
        case 'blocklist':
          throw validationError(STRINGS.password.tooCommon);
      }
    }

    const passwordHash = await hashPassword(data.password);

    try {
      const user = await mutate(
        this.db,
        { actorKind: 'user', actorId, correlationId: correlationId ?? null },
        {
          entityType: 'user',
          action: 'create',
          run: async (tx) => {
            const row = await createUserRepo(tx, {
              username: data.username,
              displayName: data.displayName,
              passwordHash,
              roles: data.roles,
              email: data.email ?? null,
              createdBy: actorId,
              updatedBy: actorId,
            });
            return {
              entityId: row.id,
              entityLabel: row.displayName,
              value: row,
              before: {},
              // passwordHash is deliberately excluded — audit rows are
              // visible to privileged readers but must never carry
              // credentials (data-model.md §5.10 "not the full row" +
              // secure-by-default).
              after: {
                username: row.username,
                displayName: row.displayName,
                roles: row.roles,
                email: row.email,
                active: row.active,
              },
            };
          },
        },
      );
      log.info({ userId: user.id, username: data.username }, 'user_created');
      return user;
    } catch (err) {
      if (extractSqlState(err) === '23505') {
        throw conflict(STRINGS.users.duplicateUsername);
      }
      throw err;
    }
  }

  async updateUser(
    id: string,
    data: {
      displayName?: string;
      roles?: string[];
      email?: string | null;
    },
    actorId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ) {
    const user = await mutate(
      this.db,
      { actorKind: 'user', actorId, correlationId: correlationId ?? null },
      {
        entityType: 'user',
        action: 'update',
        run: async (tx) => {
          const prior = await findById(tx, id);
          if (!prior) throw notFound(STRINGS.entities.user);

          const updated = await updateUserRepo(tx, id, actorId, data);
          if (!updated) throw notFound(STRINGS.entities.user);

          const before: Record<string, unknown> = {};
          const after: Record<string, unknown> = {};
          if (data.displayName !== undefined) {
            before.displayName = prior.displayName;
            after.displayName = updated.displayName;
          }
          if (data.roles !== undefined) {
            before.roles = prior.roles;
            after.roles = updated.roles;
          }
          if ('email' in data) {
            before.email = prior.email ?? null;
            after.email = updated.email ?? null;
          }

          return {
            entityId: id,
            entityLabel: updated.displayName,
            value: updated,
            before,
            after,
          };
        },
      },
    );
    log.info({ userId: id }, 'user_updated');
    return user;
  }

  async deactivateUser(
    id: string,
    actorId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ) {
    // Prevent self-deactivation
    if (id === actorId) {
      throw validationError(STRINGS.users.cannotDeactivateSelf);
    }

    // Atomic: deactivation + session invalidation in one transaction via
    // mutate(). Session rows are not audited (not in AuditEntityType).
    const user = await mutate(
      this.db,
      { actorKind: 'user', actorId, correlationId: correlationId ?? null },
      {
        entityType: 'user',
        action: 'deactivate',
        run: async (tx) => {
          const prior = await findById(tx, id);
          if (!prior) throw notFound(STRINGS.entities.user);

          const result = await deactivateUserRepo(tx, id, actorId);
          if (!result) throw notFound(STRINGS.entities.user);
          await deleteSessionsByUserId(tx, id);

          return {
            entityId: id,
            entityLabel: result.displayName,
            value: result,
            before: { active: prior.active },
            after: { active: result.active },
          };
        },
      },
    );

    log.info({ userId: id }, 'user_deactivated');
    return user;
  }

  async reactivateUser(
    id: string,
    actorId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ) {
    const result = await mutate(
      this.db,
      { actorKind: 'user', actorId, correlationId: correlationId ?? null },
      {
        entityType: 'user',
        action: 'reactivate',
        run: async (tx) => {
          const prior = await findById(tx, id);
          if (!prior) throw notFound(STRINGS.entities.user);

          const updated = await reactivateUserRepo(tx, id, actorId);
          if (!updated) throw notFound(STRINGS.entities.user);

          return {
            entityId: id,
            entityLabel: updated.displayName,
            value: updated,
            before: { active: prior.active },
            after: { active: updated.active },
          };
        },
      },
    );
    log.info({ userId: id }, 'user_reactivated');
    return result;
  }

  async deleteUser(id: string, actorId: string, log: ServiceLogger, correlationId?: string | null) {
    if (id === actorId) {
      throw validationError(STRINGS.users.cannotDeleteSelf);
    }

    await mutate(
      this.db,
      { actorKind: 'user', actorId, correlationId: correlationId ?? null },
      {
        entityType: 'user',
        action: 'delete',
        run: async (tx) => {
          // AC-385: issued / cancelled invoices are frozen (§6.14), so
          // the FK's SET NULL on their author columns must not run.
          // Invoices first, then the user: see the lock helpers.
          await lockInvoicesReferencingUser(tx, id);
          const prior = await getUserRowForDelete(tx, id);
          if (!prior) throw notFound(STRINGS.entities.user);

          const invoiceCount = await countIssuedOrCancelledForUser(tx, id);
          if (invoiceCount > 0) throw userHasInvoices({ invoiceCount });

          // sessions FK has ON DELETE CASCADE, but explicit cleanup is
          // kept for order-independence and to make intent clear.
          await deleteSessionsByUserId(tx, id);
          const deleted = await deleteUserRepo(tx, id);
          if (!deleted) throw notFound(STRINGS.entities.user);

          return {
            entityId: id,
            entityLabel: prior.displayName,
            value: null,
            before: {
              username: prior.username,
              displayName: prior.displayName,
              roles: prior.roles,
              email: prior.email ?? null,
              active: prior.active,
            },
            after: {},
          };
        },
      },
    );

    log.info({ userId: id, actorId }, 'user_deleted');
  }

  async resetPassword(
    id: string,
    newPassword: string,
    actorId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ) {
    const violation = checkPasswordPolicy(newPassword);
    if (violation) {
      switch (violation.code) {
        case 'too_short':
          throw validationError(STRINGS.password.tooShort);
        case 'too_long':
          throw validationError(STRINGS.password.tooLong);
        case 'blocklist':
          throw validationError(STRINGS.password.tooCommon);
      }
    }

    // Hash before the transaction (CPU-bound, no DB needed)
    const newHash = await hashPassword(newPassword);

    // Password reset is audited on the `user` entity with action
    // `password-reset`. The audit row does NOT carry the new hash —
    // same reason as create: audit must not leak credentials.
    await mutate(
      this.db,
      { actorKind: 'user', actorId, correlationId: correlationId ?? null },
      {
        entityType: 'user',
        action: 'password-reset',
        run: async (tx) => {
          const prior = await findById(tx, id);
          if (!prior) throw notFound(STRINGS.entities.user);
          await changePasswordRepo(tx, id, newHash, actorId);
          await deleteSessionsByUserId(tx, id);
          return {
            entityId: id,
            entityLabel: prior.displayName,
            value: null,
            before: {},
            after: {},
          };
        },
      },
    );

    log.info({ userId: id, actorId }, 'password_reset');
  }
}
