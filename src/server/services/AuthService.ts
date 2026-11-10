/**
 * Auth service — business logic orchestration for authentication.
 *
 * Sits between routes (HTTP concerns) and repositories (data access).
 * Handles credential verification, session management, and password policy.
 *
 * The service does NOT import from `fastify`. Logging goes through the
 * `ServiceLogger` interface so the service can be invoked from any context
 * (CLI, background job, alternative transport) — see Logger.ts.
 */

import type { Database } from '../db/connection.js';
import type { ThemePreference } from '../../config/themeStorage.js';

import {
  findById,
  findByUsername,
  updateLastLogin,
  changePassword as changePasswordRepo,
  updateSelf as updateSelfRepo,
  toUserResponse,
} from '../repositories/user.js';
import {
  createSession,
  deleteSession,
  deleteSessionsByUserId,
  findSession,
} from '../repositories/session.js';
import { isSessionExpired } from '../../domain/session.js';
import { hashPassword, verifyPassword } from '../password.js';
import { checkPasswordPolicy } from '../config/password-policy.js';
import { STRINGS } from '../../config/strings.js';
import { invalidCredentials, notFound, validationError } from '../errors.js';
import { AUTH_CONFIG } from '../config/index.js';
import type { ServiceLogger } from './Logger.js';
import { mutate } from './mutate.js';

export class AuthService {
  constructor(private db: Database) {}

  async login(username: string, password: string, ip: string, log: ServiceLogger) {
    const user = await findByUsername(this.db, username);

    // Timing side-channel mitigation: burn the same bcrypt time
    // regardless of whether the user exists.
    if (!user) {
      await verifyPassword(password, AUTH_CONFIG.dummyHash);
      log.info({ username, ip }, 'login_failure');
      throw invalidCredentials();
    }
    if (!user.active) {
      await verifyPassword(password, AUTH_CONFIG.dummyHash);
      log.info({ username, ip }, 'login_failure');
      throw invalidCredentials();
    }

    const passwordValid = await verifyPassword(password, user.passwordHash);
    if (!passwordValid) {
      log.info({ username, ip }, 'login_failure');
      throw invalidCredentials();
    }

    // Create session
    const expiresAt = new Date(Date.now() + AUTH_CONFIG.sessionDurationMs);
    const session = await createSession(this.db, user.id, expiresAt);

    // Update last login
    await updateLastLogin(this.db, user.id);

    log.info({ username, ip }, 'login_success');

    return {
      token: session.token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        roles: user.roles,
        email: user.email,
        // data-model.md §5.7 — login response exposes
        // the user's stored theme preference so the client can render
        // the correct scheme on first paint without an extra round-trip.
        // Narrow the raw text column to the domain literal union; the
        // CHECK constraint in migration 0013 guarantees validity.
        themePreference: user.themePreference as ThemePreference,
        pushMuted: user.pushMuted,
      },
    };
  }

  /**
   * Self-scope profile update — used by PATCH /api/auth/me (data-model.md §5.3).
   * Only fields the user themselves controls appear in `patch`; identity-
   * bearing fields stay administrative (see `UserService`).
   *
   * Audit behaviour: self-preference writes (themePreference, pushMuted)
   * do not produce an audit row. See data-model.md §5.10 "Non-audited
   * self-preference writes on UserAccount" — per-user UI/notification
   * preferences have no cross-user or security consequence and would
   * drown out the actor-on-entity traffic the activity feed is tuned
   * for (ADR-0021 "high-signal activity feed"). A transaction is still
   * opened so MutatingDatabase's type-gate on the repo write is satisfied
   * (AC-179's carve-out is expressed as an allowlisted write site, not
   * a general bypass of the single-write-path helper).
   */
  async updateSelfPreferences(
    actingUserId: string,
    patch: { themePreference?: ThemePreference; pushMuted?: boolean },
    log: ServiceLogger,
  ) {
    const updated = await this.db.transaction(async (tx) => {
      const prior = await findById(tx, actingUserId);
      if (!prior) throw notFound(STRINGS.entities.user);
      const row = await updateSelfRepo(tx, actingUserId, patch);
      if (!row) throw notFound(STRINGS.entities.user);
      return row;
    });
    log.info({ userId: actingUserId }, 'user_self_updated');
    return updated;
  }

  /**
   * Read the authenticated user's full row for GET /api/auth/me responses.
   * Present so routes do not need to repeat the `findById` + `toUserResponse`
   * pattern when surfacing self-preference fields.
   */
  async getSelf(userId: string) {
    const row = await findById(this.db, userId);
    if (!row) throw notFound(STRINGS.entities.user);
    return toUserResponse(row);
  }

  async logout(token: string, userId: string, ip: string, log: ServiceLogger) {
    if (token) {
      await deleteSession(this.db, token);
    }
    log.info({ userId, ip }, 'logout');
  }

  /**
   * Re-validate an in-flight session token. Returns `true` if the session
   * row still exists, has not expired, and the joined user is still
   * active — the same three predicates the `authenticate` middleware
   * checks at request entry. Used by long-lived authenticated streams
   * (`/api/events`, AC-275) to bound the post-revocation send window:
   * the auth gate runs once at connect time, so without re-validation a
   * held connection outlives its session. Architecture-wise the route
   * cannot import the repositories directly (architecture.md §11.2 —
   * routes go through services); centralising the predicate here also
   * keeps it lock-step with the middleware's own definition.
   */
  async isSessionValid(token: string): Promise<boolean> {
    const result = await findSession(this.db, token);
    if (!result) return false;
    if (isSessionExpired({ expiresAt: result.session.expiresAt.toISOString() })) return false;
    if (!result.user.active) return false;
    return true;
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    currentToken: string | undefined,
    ip: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ) {
    // The caller supplies `userId` only — the username is derived from
    // the current user record. Passing both parameters was redundant and
    // opened a trivial mismatch failure mode if a caller handed us a
    // user id from one session and a username from another.
    const user = await findById(this.db, userId);
    if (!user) {
      // Timing side-channel mitigation: burn bcrypt time even when the
      // user disappeared between the session check and here (deleted
      // mid-request). Lookup-by-id via the authenticated session makes
      // this branch unreachable in practice; the defensive bcrypt call
      // keeps the timing profile constant regardless.
      await verifyPassword(currentPassword, AUTH_CONFIG.dummyHash);
      throw invalidCredentials();
    }

    // Verify current password
    const valid = await verifyPassword(currentPassword, user.passwordHash);
    if (!valid) throw invalidCredentials();

    // Password policy — length + UTF-8 byte ceiling (bcrypt truncates at
    // 72 bytes, not 72 characters — see ADR-0006 and password-policy.ts).
    // The same checker is called from the bootstrap path, so the two
    // enforcement points cannot diverge.
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

    // Atomic: password change + session invalidation + audit row in one
    // transaction. Action is `password-change` for self-service (differs
    // from UserService.resetPassword's `password-reset` which is admin-
    // driven and invalidates ALL sessions). No hash in the payload.
    await mutate(
      this.db,
      { actorKind: 'user', actorId: userId, correlationId: correlationId ?? null },
      {
        entityType: 'user',
        action: 'password-change',
        run: async (tx) => {
          // Re-read inside the tx so entityLabel is snapshotted atomically
          // with the write — avoids capturing a stale displayName if an
          // admin renames the user between the pre-tx verify and here.
          const current = await findById(tx, userId);
          if (!current) throw notFound(STRINGS.entities.user);
          await changePasswordRepo(tx, userId, newHash, userId);
          await deleteSessionsByUserId(tx, userId, currentToken);
          return {
            entityId: userId,
            entityLabel: current.displayName,
            value: null,
            before: {},
            after: {},
          };
        },
      },
    );

    log.info({ userId, ip }, 'password_change');
  }
}
