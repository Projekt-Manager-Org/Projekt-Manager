/**
 * Authentication middleware — Fastify preHandler hook.
 *
 * Reads session token from the HttpOnly `session` cookie, validates the
 * session, checks that the user is still active, and attaches user info
 * to the request.
 *
 * Import-token variant (`createAuthMiddlewareWithImportToken`): for the
 * binary-leg attachment routes the takeout-zip restore orchestrator hits
 * after an override-import wiped the operator's session. A
 * `Authorization: Bearer <importToken>` header is accepted as an
 * alternative to session-cookie auth. The header wins when both are
 * present — the cookie is known to be dead post-cascade. Other routes
 * (users, customers, etc.) continue using the standard middleware and
 * reject Bearer tokens — defense in depth on the token's narrow scope.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { isSessionExpired } from '../../domain/session.js';
import { findSession } from '../repositories/session.js';
import { findById as findUserById } from '../repositories/user.js';
import { unauthenticated, sessionExpired, notPermitted, importTokenInvalid } from '../errors.js';
import { hasPermission, type Permission } from '../../config/permissions.js';
import type { Database } from '../db/connection.js';
import type { ThemePreference } from '../../config/themeStorage.js';
import { verifyImportToken } from '../services/importTokenStore.js';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  roles: string[];
  email: string | null;
  themePreference: ThemePreference;
  pushMuted: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
    /**
     * Permission set granted by a valid `Authorization: Bearer
     * <importToken>` header. Populated only by
     * `createAuthMiddlewareWithImportToken` on the binary-leg routes.
     * Consulted by `requirePermission` as an alternative to the role-
     * based check.
     */
    importTokenPermissions?: readonly Permission[];
  }
}

export function createAuthMiddleware(db: Database) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = request.cookies.session;

    if (!token) {
      const err = unauthenticated();
      reply.code(err.statusCode).send(err.toResponse());
      return;
    }

    const result = await findSession(db, token);

    if (!result) {
      const err = sessionExpired();
      reply.code(err.statusCode).send(err.toResponse());
      return;
    }

    // Check session expiry
    if (isSessionExpired({ expiresAt: result.session.expiresAt.toISOString() })) {
      const err = sessionExpired();
      reply.code(err.statusCode).send(err.toResponse());
      return;
    }

    // Check user is still active
    if (!result.user.active) {
      const err = sessionExpired();
      reply.code(err.statusCode).send(err.toResponse());
      return;
    }

    // Attach user to request
    request.user = {
      id: result.user.id,
      username: result.user.username,
      displayName: result.user.displayName,
      roles: result.user.roles,
      email: result.user.email,
      themePreference: result.user.themePreference,
      pushMuted: result.user.pushMuted,
    };
  };
}

const BEARER_PATTERN = /^Bearer (.+)$/;

/**
 * Authentication middleware that accepts EITHER an `Authorization:
 * Bearer <importToken>` header OR a session cookie. The header wins when
 * both are present — the cookie path is known to be dead post-`users`-
 * TRUNCATE (the cascade through `sessions.user_id` evaporated the
 * session that minted the token).
 *
 * Behaviour:
 *   - Bearer header present + valid: populate `request.user` from the
 *     token's stored `userId` (loaded from the DB so the operator's
 *     roles + display name flow into `requirePermission` for audit
 *     attribution downstream) and set `request.importTokenPermissions`
 *     so `requirePermission` accepts the call regardless of role.
 *   - Bearer header present + invalid/expired/revoked: respond `401`
 *     with code `IMPORT_TOKEN_INVALID` so the orchestrator can
 *     distinguish from a regular session expiry.
 *   - Bearer header absent: fall through to the standard session-cookie
 *     check (same shape as `createAuthMiddleware`).
 *
 * Intentionally narrow: only the binary-leg attachment routes
 * (`init`, `complete`, `DELETE`) wire this variant. Other routes use
 * the cookie-only `createAuthMiddleware` and reject Bearer headers
 * implicitly (they never look at `Authorization`).
 */
export function createAuthMiddlewareWithImportToken(db: Database) {
  return async function authenticateWithImportToken(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const authHeader = request.headers.authorization;
    const bearerMatch = typeof authHeader === 'string' ? BEARER_PATTERN.exec(authHeader) : null;

    if (bearerMatch) {
      // Header wins over cookie when both are present.
      const token = bearerMatch[1]!;
      const record = verifyImportToken(token);
      if (!record) {
        const err = importTokenInvalid();
        reply.code(err.statusCode).send(err.toResponse());
        return;
      }

      // Load the user row so downstream audit + repo writes have the
      // operator's real `roles` / `displayName`. After the override-
      // import the imported envelope's row carries the same `id`, so
      // this resolves to the freshly-inserted user. The DB roundtrip
      // is deliberate, not an optimization target: it is also the
      // freshness check for `users.active`. Caching the row inside
      // the token record would mean a user deactivated mid-import
      // could continue restoring attachments for the rest of the TTL;
      // the per-call lookup keeps the active-revocation effective on
      // the very next call. At VPS scale (~tens of attachments per
      // import) the roundtrip cost is irrelevant.
      const userRow = await findUserById(db, record.userId);
      if (!userRow || !userRow.active) {
        // Token's userId no longer resolves (or was deactivated post-
        // mint). Surface as IMPORT_TOKEN_INVALID; the orchestrator
        // should re-import from a complete source.
        const err = importTokenInvalid();
        reply.code(err.statusCode).send(err.toResponse());
        return;
      }

      request.user = {
        id: userRow.id,
        username: userRow.username,
        displayName: userRow.displayName,
        roles: userRow.roles,
        email: userRow.email,
        // The DB column is `text` with a CHECK constraint enforcing the
        // closed enum; the narrow cast matches the pattern in
        // `repositories/session.ts`'s `findSession` join.
        themePreference: userRow.themePreference as ThemePreference,
        pushMuted: userRow.pushMuted,
      };
      request.importTokenPermissions = record.permissions;
      return;
    }

    // No Bearer header — fall through to standard session-cookie auth.
    const sessionToken = request.cookies.session;

    if (!sessionToken) {
      const err = unauthenticated();
      reply.code(err.statusCode).send(err.toResponse());
      return;
    }

    const result = await findSession(db, sessionToken);

    if (!result) {
      const err = sessionExpired();
      reply.code(err.statusCode).send(err.toResponse());
      return;
    }

    if (isSessionExpired({ expiresAt: result.session.expiresAt.toISOString() })) {
      const err = sessionExpired();
      reply.code(err.statusCode).send(err.toResponse());
      return;
    }

    if (!result.user.active) {
      const err = sessionExpired();
      reply.code(err.statusCode).send(err.toResponse());
      return;
    }

    request.user = {
      id: result.user.id,
      username: result.user.username,
      displayName: result.user.displayName,
      roles: result.user.roles,
      email: result.user.email,
      themePreference: result.user.themePreference,
      pushMuted: result.user.pushMuted,
    };
  };
}

export function requirePermission(...permissions: Permission[]) {
  return async function checkPermission(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!request.user) {
      const err = unauthenticated();
      reply.code(err.statusCode).send(err.toResponse());
      return;
    }
    // Role-based check (cookie auth + standard session) OR
    // import-token-based check (Bearer auth on binary-leg routes). Either
    // path satisfies the permission — they're orthogonal: a request
    // authenticated via Bearer never has roles inspected, and a request
    // authenticated via cookie never carries `importTokenPermissions`.
    const grantedByRole = permissions.some((p) => hasPermission(request.user!.roles, p));
    const grantedByToken =
      request.importTokenPermissions !== undefined &&
      permissions.some((p) => request.importTokenPermissions!.includes(p));
    if (!grantedByRole && !grantedByToken) {
      const err = notPermitted();
      reply.code(err.statusCode).send(err.toResponse());
      return;
    }
  };
}
