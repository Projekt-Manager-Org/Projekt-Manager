/**
 * API integration tests: an out-of-range list `offset` is a validation
 * error (api.md §14.4.1), never a 500.
 *
 * Postgres reads OFFSET as a bigint. Past its range the query fails with
 * 22003 (`1e20` is sent as `100000000000000000000`); from `1e21` the
 * driver sends `1e+21`, which fails with 22P02 instead. Both reached the
 * client as 500 SERVER_ERROR (#1073).
 *
 * Runs against a real test database via Fastify inject.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp, login, authGet } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';

const LIST_ROUTES = [
  '/api/projects',
  '/api/customers',
  '/api/users',
  '/api/invoices',
  '/api/audit',
];

describe('api.md §14.4.1: an out-of-range list offset is a validation error', () => {
  let ownerToken: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    await stopApp();
  });

  it.each(LIST_ROUTES.flatMap((route) => [1e20, 1e21].map((offset) => ({ route, offset }))))(
    '$route refuses offset $offset',
    async ({ route, offset }) => {
      const res = await authGet(
        ownerToken,
        `${route}?limit=10&offset=${encodeURIComponent(String(offset))}`,
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    },
  );

  it.each(LIST_ROUTES)('%s accepts the largest offset', async (route) => {
    const res = await authGet(ownerToken, `${route}?limit=10&offset=${Number.MAX_SAFE_INTEGER}`);
    expect(res.statusCode).toBe(200);
  });
});
