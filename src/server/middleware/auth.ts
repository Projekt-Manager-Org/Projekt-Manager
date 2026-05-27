/**
 * Authentication middleware — Fastify preHandler hook.
 *
 * Reads session token from the HttpOnly `session` cookie, validates the
 * session, checks that the user is still active, and attaches user info
 * to the request.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { isSessionExpired } from '../../domain/session.js';
import { findSession } from '../repositories/session.js';
import { unauthenticated, sessionExpired, notPermitted } from '../errors.js';
import { hasPermission, type Permission } from '../../config/permissions.js';
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
    // Granted iff the caller's role set holds any of the listed
    // permissions (OR over multiple permissions).
    if (!permissions.some((p) => hasPermission(request.user!.roles, p))) {
      const err = notPermitted();
      reply.code(err.statusCode).send(err.toResponse());
      return;
    }
  };
}
