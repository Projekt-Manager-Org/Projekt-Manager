/**
 * Write-route version classification gate (AC-380) — the gate itself in
 * `src/test/versionClassificationGate.ts`.
 *
 * The gate run checks every write route `buildApp()` registers. The
 * self-test plants one route per failure on the same app and asserts
 * each goes red; a stale table entry gets its own case. Without it the
 * gate could pass vacuously: every real route is classified today.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { startApp, stopApp } from '../../test/api-helpers.js';
import {
  checkVersionClassification,
  VERSION_CLASSIFICATION,
  type Classification,
} from '../../test/versionClassificationGate.js';
import { recordRoutes } from '../../../scripts/lib/route-introspection.js';
import { EXPECTED_VERSION_SCHEMA } from '../routes/expected-version.js';

const PLANTED = '/api/__planted';

const VERSIONED_BODY = {
  type: 'object',
  required: ['expectedVersion'],
  properties: { expectedVersion: EXPECTED_VERSION_SCHEMA },
} as const;

/** One write route per gate failure. */
async function plantedRoutes(app: FastifyInstance): Promise<void> {
  app.post(`${PLANTED}-unclassified`, async () => ({}));
  app.patch(`${PLANTED}-unversioned`, async () => ({}));
  app.patch(`${PLANTED}-versioned`, { schema: { body: VERSIONED_BODY } }, async () => ({}));
  // The shared schema, but optional.
  app.patch(
    `${PLANTED}-optional`,
    { schema: { body: { ...VERSIONED_BODY, required: [] } } },
    async () => ({}),
  );
  // Required, but a schema of its own.
  app.patch(
    `${PLANTED}-own-schema`,
    {
      schema: { body: { ...VERSIONED_BODY, properties: { expectedVersion: { type: 'integer' } } } },
    },
    async () => ({}),
  );
}

describe('Write-route version classification gate (AC-380)', () => {
  let routes: RouteOptions[];

  const realRoutes = () => routes.filter((r) => !r.url.startsWith(PLANTED));
  const plantedRoute = (suffix: string) => routes.filter((r) => r.url === `${PLANTED}${suffix}`);

  beforeAll(async () => {
    await startApp({
      beforeReady: (instance) => {
        routes = recordRoutes(instance);
        instance.register(plantedRoutes);
      },
    });
  });

  afterAll(async () => {
    await stopApp();
  });

  it('every write route is classified, and its label matches its schema', () => {
    expect(checkVersionClassification(realRoutes())).toEqual([]);
  });

  describe('self-test: the gate goes red', () => {
    const cases: [string, string, Record<string, Classification>, string][] = [
      ['on an unclassified route', '-unclassified', {}, 'not classified'],
      [
        'on a versioned label without expectedVersion',
        '-unversioned',
        { [`PATCH ${PLANTED}-unversioned`]: 'versioned' },
        'classified versioned, but does not require expectedVersion',
      ],
      [
        'on a versioned label whose expectedVersion is optional',
        '-optional',
        { [`PATCH ${PLANTED}-optional`]: 'versioned' },
        'classified versioned, but does not require expectedVersion',
      ],
      [
        'on a versioned label whose expectedVersion is not the shared schema',
        '-own-schema',
        { [`PATCH ${PLANTED}-own-schema`]: 'versioned' },
        'classified versioned, but does not require expectedVersion',
      ],
      [
        'on an exemption for a route requiring expectedVersion',
        '-versioned',
        { [`PATCH ${PLANTED}-versioned`]: { exempt: 'create' } },
        'exempt (create), but requires expectedVersion',
      ],
    ];

    it.each(cases)('%s', (_label, suffix, table, expected) => {
      const planted = plantedRoute(suffix);
      expect(planted).toHaveLength(1);
      expect(checkVersionClassification(planted, table)).toEqual([
        expect.stringContaining(expected),
      ]);
    });

    it('on an entry naming no registered route', () => {
      const table = { ...VERSION_CLASSIFICATION, 'PATCH /api/no-such-route': 'versioned' as const };
      expect(checkVersionClassification(realRoutes(), table)).toEqual([
        expect.stringContaining('PATCH /api/no-such-route: classified, but no write route'),
      ]);
    });
  });
});
