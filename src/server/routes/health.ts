/**
 * Liveness probe route — `GET /api/health` (#48).
 *
 * Unauthenticated by design: the Docker healthcheck,
 * `scripts/smoke-app-health.sh` and `scripts/ops/sync-restore-vps.sh`
 * call it without a session.
 *
 * Lives here, not in `start.ts`, because `buildApp()` is the only route
 * surface the generated OpenAPI document can see (AC-351) — a route
 * mounted on the returned instance is a public endpoint the published
 * artifact never mentions. The `no-restricted-syntax` rule in
 * `eslint.config.js` keeps it that way.
 */

import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { probeHealth, type HealthStatus } from '../health.js';
import type { StorageClient } from '../storage/client.js';

/** The two dependencies the probe reports on. */
export interface HealthDeps {
  pool: pg.Pool;
  storage: StorageClient;
}

/**
 * Reported when the app was built without probe dependencies (unit
 * tests, the OpenAPI generator). Not a placeholder: an app with no
 * database and no object store *is* degraded, and answering 503 keeps a
 * `buildApp` call that forgot to wire them from passing a healthcheck.
 */
const UNPROBEABLE: HealthStatus = {
  status: 'degraded',
  checks: { db: 'fail', storage: 'fail' },
};

export function healthRoutes(deps: HealthDeps | null) {
  return async function (app: FastifyInstance): Promise<void> {
    app.get('/api/health', async (_request, reply) => {
      const health = deps ? await probeHealth(deps.pool, deps.storage) : UNPROBEABLE;
      return reply.code(health.status === 'ok' ? 200 : 503).send(health);
    });
  };
}
