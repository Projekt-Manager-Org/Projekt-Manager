/**
 * Authentication and authorization middleware — Fastify preHandler hooks.
 *
 * `createAuthMiddleware` reads the session token from the HttpOnly
 * `session` cookie, validates the session, checks that the user is still
 * active, and attaches user info to the request. `requireSession` applies
 * it plugin-wide; `requirePermission` gates a single route.
 *
 * Both gates carry their rule as readable data (`requiresSession`,
 * `requiredPermissions`, the `auth` route-config marker) so the published
 * API surface is derived from the enforcement rather than restated beside
 * it — ARCHITECTURE.md § API Surface, AC-352.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { isSessionExpired } from '../../domain/session.js';
import { findSession } from '../repositories/session.js';
import { unauthenticated, sessionExpired, notPermitted } from '../errors.js';
import { hasPermission, type Permission, type Role } from '../../config/permissions.js';
import type { Database } from '../db/connection.js';
import type { ThemePreference } from '../../config/themeStorage.js';

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
  }

  interface FastifyContextConfig {
    /**
     * Written by `requireSession` on every route in its encapsulation
     * context; read by `scripts/generate-api-surface.ts` (AC-352).
     *
     * A plugin-level `preHandler` hook is invisible to Fastify's
     * `onRoute`, so without this marker the generated Auth column would
     * have to assume `session` and trust a hand-kept list of public
     * endpoints — the drift mechanism the generator exists to remove.
     */
    auth?: 'session';
  }
}

/**
 * A `preHandler` that rejects a request without a valid session.
 *
 * The tag is what makes route-level session gating readable: a closure
 * can be called but not inspected, so `requiresSession` carries the fact
 * a generator would otherwise have to infer (same argument as
 * `RouteAccess` in `src/config/routes.ts`, AC-349).
 */
export interface SessionGate {
  (request: FastifyRequest, reply: FastifyReply): Promise<void>;
  readonly requiresSession: true;
}

/**
 * A `preHandler` that rejects a caller holding none of `requiredPermissions`.
 */
export interface PermissionGate {
  (request: FastifyRequest, reply: FastifyReply): Promise<void>;
  /** Permission keys this gate accepts — the caller needs ANY of them. */
  readonly requiredPermissions: readonly Permission[];
}

/**
 * A `preHandler` that rejects a caller holding none of `requiredRoles`.
 */
export interface RoleGate {
  (request: FastifyRequest, reply: FastifyReply): Promise<void>;
  /** Roles this gate accepts — the caller needs ANY of them. */
  readonly requiredRoles: readonly Role[];
}

export function createAuthMiddleware(db: Database): SessionGate {
  const authenticate = async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
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

  return Object.assign(authenticate, { requiresSession: true } as const);
}

/**
 * Session-gate every route registered in `app`'s encapsulation context.
 *
 * Two effects, deliberately inseparable: the `preHandler` hook that
 * enforces the session, and the `auth: 'session'` route-config marker the
 * generated API-surface table reads. Splitting them would reintroduce the
 * failure mode — enforcement in one place, its documentation in another,
 * free to disagree.
 */
export function requireSession(app: FastifyInstance, db: Database): void {
  app.addHook('preHandler', createAuthMiddleware(db));
  app.addHook('onRoute', (routeOptions) => {
    routeOptions.config = { ...routeOptions.config, auth: 'session' };
  });
}

export function requirePermission(...permissions: Permission[]): PermissionGate {
  const checkPermission = async function checkPermission(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!request.user) {
      const err = unauthenticated();
      reply.code(err.statusCode).send(err.toResponse());
      return;
    }
    // Granted iff the caller's role set holds any of the listed
    // permissions (OR over multiple permissions).
    if (!permissions.some((p) => hasPermission(request.user!.roles, p))) {
      const err = notPermitted();
      reply.code(err.statusCode).send(err.toResponse());
      return;
    }
  };

  return Object.assign(checkPermission, { requiredPermissions: permissions });
}

/**
 * Role-gate a route.
 *
 * `requirePermission` is the default and stays it — UI and server both
 * ask for a permission, never a role name (§ Permission Gating). This
 * exists for the routes where the spec deliberately folds the invariant
 * into a role check rather than minting a permission key, today only
 * owner-only writes ([api.md §14.2.15]). Enforcing it here rather than
 * inside the handler keeps every route's access rule at the route
 * boundary, where it is both uniform and readable.
 */
export function requireRole(...roles: Role[]): RoleGate {
  const checkRole = async function checkRole(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!request.user) {
      const err = unauthenticated();
      reply.code(err.statusCode).send(err.toResponse());
      return;
    }
    if (!roles.some((role) => request.user!.roles.includes(role))) {
      const err = notPermitted();
      reply.code(err.statusCode).send(err.toResponse());
      return;
    }
  };

  return Object.assign(checkRole, { requiredRoles: roles });
}
