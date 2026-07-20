/**
 * Global error and 404 handlers.
 *
 * Honor the HTTP statusCode native to the failure: 4xx-class errors
 * preserve their status and surface a stable code per AC-247 / api.md
 * §14.4.2; only 5xx-or-statusless errors collapse to `SERVER_ERROR` and
 * are logged at the operational `error` level. Transport-layer 4xx
 * rejections log at `warn` so 5xx alerting on logs reflects only genuine
 * server failures.
 */

import type { FastifyInstance } from 'fastify';
// Type-only: pulls in `@fastify/static`'s FastifyReply augmentation for
// `reply.sendFile` below. The plugin itself is registered by the caller
// (start.ts, via staticCache.ts) — this file only needs the declaration.
// Without it, any tsconfig whose program does not happen to also include
// staticCache.ts fails on `sendFile` (scripts/tsconfig.json does not).
import type {} from '@fastify/static';
import {
  AppError,
  mapFastify4xx,
  rateLimited,
  routeNotFound,
  serverError,
  validationError,
} from './errors.js';
import { STRINGS } from '../config/strings.js';

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send(error.toResponse());
    }

    const fastifyErr = error as Error & {
      statusCode?: number;
      validation?: unknown[];
      code?: string;
    };

    // Schema-validation rejection → 422. The wire shape carries the ajv
    // `details` array so callers can render field-level feedback; that
    // is why this branch is separate from the generic 4xx pass-through.
    if (fastifyErr.validation) {
      request.log.warn({ err: error }, 'schema validation rejection');
      const err = validationError(STRINGS.errors.invalidInput, fastifyErr.validation);
      return reply.code(err.statusCode).send(err.toResponse());
    }

    // Rate-limit rejection → 429. The plugin attaches `Retry-After`
    // before throwing; reply.code + send preserves that header.
    if (fastifyErr.statusCode === 429) {
      request.log.warn({ err: error }, 'rate limit exceeded');
      const err = rateLimited();
      return reply.code(err.statusCode).send(err.toResponse());
    }

    // Generic 4xx pass-through: empty JSON body, payload too large,
    // unsupported media type, route-not-found bubbled up, …
    const mapped = mapFastify4xx(fastifyErr);
    if (mapped) {
      request.log.warn({ err: error, statusCode: mapped.statusCode }, 'transport-layer rejection');
      return reply.code(mapped.statusCode).send(mapped.toResponse());
    }

    // 5xx fallback — the only branch that warrants `error`-level logging.
    app.log.error(error);
    const err = serverError();
    return reply.code(err.statusCode).send(err.toResponse());
  });
}

export function installNotFoundHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) => {
    const err = routeNotFound();
    return reply.code(err.statusCode).send(err.toResponse());
  });
}

/**
 * Production variant: non-/api URLs fall through to the SPA's
 * `index.html` so client-side routing handles deep links; /api/*
 * URLs return the structured ROUTE_NOT_FOUND error. The caller must
 * register `@fastify/static` before calling — the SPA branch uses
 * `reply.sendFile`.
 */
export function installSpaAwareNotFoundHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    if (!request.url.startsWith('/api')) {
      return reply.sendFile('index.html');
    }
    const err = routeNotFound();
    return reply.code(err.statusCode).send(err.toResponse());
  });
}
