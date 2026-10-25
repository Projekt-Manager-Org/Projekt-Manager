/**
 * AC-515 for routes without a body schema, which Ajv never sees: a JSON
 * body with content — an object with fields, a non-empty array — is
 * refused with 422. An absent or empty body passes; that is what the
 * client sends to a no-input operation. Non-JSON bodies (the octet-stream
 * upload's stream) are not this guard's concern.
 *
 * The details mirror Ajv's shape so a client reads both 422 paths alike.
 */

import type { FastifyInstance } from 'fastify';
import { validationError } from './errors.js';
import { STRINGS } from '../config/strings.js';

function bodyContent(body: unknown): object[] {
  if (Array.isArray(body)) {
    return body.length === 0
      ? []
      : [
          {
            instancePath: '',
            keyword: 'maxItems',
            params: { limit: 0 },
            message: 'must NOT have more than 0 items',
          },
        ];
  }
  if (
    body === null ||
    typeof body !== 'object' ||
    Object.getPrototypeOf(body) !== Object.prototype
  ) {
    return [];
  }
  return Object.keys(body).map((additionalProperty) => ({
    instancePath: '',
    keyword: 'additionalProperties',
    params: { additionalProperty },
    message: 'must NOT have additional properties',
  }));
}

export function installUndefinedBodyGuard(app: FastifyInstance): void {
  app.addHook('preValidation', async (request) => {
    // An unmatched route stays a 404 (ROUTE_NOT_FOUND), whatever its body.
    if (request.is404 || request.routeOptions.schema?.body) return;
    const details = bodyContent(request.body);
    if (details.length > 0) throw validationError(STRINGS.errors.invalidInput, details);
  });
}
