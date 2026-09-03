/**
 * Global error and 404 handlers.
 *
 * Honor the HTTP statusCode native to the failure: 4xx-class errors
 * preserve their status and surface a stable code per AC-247 / api.md
 * §14.4.2; a 5xx-or-statusless error carrying no code of its own
 * collapses to `SERVER_ERROR`. Every 5xx logs at the operational `error`
 * level — an `AppError` that carries its own 5xx code included, since it
 * is a genuine server failure under a more precise name. Transport-layer
 * 4xx rejections log at `warn` so 5xx alerting on logs reflects only
 * genuine server failures.
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
      // Headers the status is not valid without (e.g. `Allow` on a 405,
      // RFC 9110 §15.5.6). Written here, with the body, so the pair
      // cannot come apart at an individual call site.
      if (error.headers) {
        for (const [name, value] of Object.entries(error.headers)) {
          reply.header(name, value);
        }
      }
      // AC-247's triage contract is about the status class, not about
      // which branch produced it: a 5xx is a genuine server failure and
      // logs at `error` like any other.
      if (error.statusCode >= 500) {
        request.log.error({ err: error, code: error.code }, 'server-side failure');
      }
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

    // 5xx fallback for a non-`AppError`. Logs at `error`, as the
    // `AppError` branch above does for its own 5xx; the 4xx branches
    // between them stay at `warn`. On `request.log` like both of them,
    // so the entry an operator triages carries the request id.
    request.log.error(error);
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
