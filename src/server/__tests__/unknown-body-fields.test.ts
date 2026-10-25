/**
 * Undefined request-body fields are refused (AC-515).
 *
 * The rule rests on three mechanisms, each pinned here:
 *   - the closed-schema gate: every body schema a route declares closes
 *     every object level, and Ajv refuses an extra field instead of
 *     stripping it — exercised generically on planted routes;
 *   - a route without a body schema refuses a body with content — planted
 *     route plus one real no-input route;
 *   - the routes that read their body outside a closed schema before
 *     (notification rules, import-job create), probed for real.
 *
 * The self-test proves the gate goes red, as in
 * version-classification-gate.test.ts: every real route passes today, so
 * without it the gate could pass vacuously.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse, RouteOptions } from 'fastify';
import {
  startApp,
  stopApp,
  getApp,
  getDb,
  login,
  authGet,
  authPost,
  authPatch,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { recordRoutes, routeKeys } from '../../../scripts/lib/route-introspection.js';
import { dataExchangeJob, users } from '../db/schema.js';

const PLANTED = '/api/__planted';

const CLOSED_BODY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    inner: { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } },
    items: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, properties: { b: { type: 'string' } } },
    },
  },
} as const;

/**
 * Object schema nodes that admit a field they do not list. An untyped
 * leaf (`{}`) admits any value, an object included; such a field's
 * checks belong to the handler or service, out of this gate's reach.
 */
function openNodes(schema: unknown, path: string): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const node = schema as Record<string, unknown>;
  const isObject = [node.type].flat().includes('object') || 'properties' in node;
  const found = isObject && node.additionalProperties !== false ? [path || '(root)'] : [];
  const properties = (node.properties ?? {}) as Record<string, unknown>;
  for (const [name, sub] of Object.entries(properties)) {
    found.push(...openNodes(sub, `${path}.${name}`));
  }
  found.push(...openNodes(node.items, `${path}[]`));
  return found;
}

function checkClosedBodies(routes: RouteOptions[]): string[] {
  return routes.flatMap((route) =>
    routeKeys(route).flatMap((key) =>
      openNodes(route.schema?.body, '').map((at) => `${key}: body ${at} admits undefined fields`),
    ),
  );
}

/** One route per mechanism and per gate failure. */
async function plantedRoutes(app: FastifyInstance): Promise<void> {
  const ok = async () => ({ ok: true });
  app.post(`${PLANTED}-closed`, { schema: { body: CLOSED_BODY } }, ok);
  app.post(`${PLANTED}-no-body`, ok);
  const { additionalProperties: _, ...openRoot } = CLOSED_BODY;
  app.post(`${PLANTED}-open-root`, { schema: { body: openRoot } }, ok);
  app.post(
    `${PLANTED}-open-nested`,
    {
      schema: {
        body: {
          ...CLOSED_BODY,
          properties: { inner: { type: 'object', properties: { a: { type: 'string' } } } },
        },
      },
    },
    ok,
  );
  app.post(
    `${PLANTED}-open-item`,
    {
      schema: {
        body: {
          ...CLOSED_BODY,
          properties: { items: { type: 'array', items: { type: 'object', properties: {} } } },
        },
      },
    },
    ok,
  );
}

function expectRefused(res: LightMyRequestResponse, field: string): void {
  expect(res.statusCode).toBe(422);
  const body = res.json();
  expect(body.code).toBe('VALIDATION_ERROR');
  expect(body.details).toContainEqual(
    expect.objectContaining({ params: { additionalProperty: field } }),
  );
}

function plantedPost(suffix: string, payload?: Record<string, unknown> | unknown[]) {
  return getApp().inject({ method: 'POST', url: `${PLANTED}${suffix}`, payload });
}

describe('AC-515: a request body field the operation does not define is refused', () => {
  let routes: RouteOptions[];
  let ownerToken: string;

  const realRoutes = () => routes.filter((r) => !r.url.startsWith(PLANTED));
  const plantedRoute = (suffix: string) => routes.filter((r) => r.url === `${PLANTED}${suffix}`);

  beforeAll(async () => {
    await startApp({
      beforeReady: (instance) => {
        routes = recordRoutes(instance);
        instance.register(plantedRoutes);
      },
    });
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  });

  afterAll(async () => {
    await stopApp();
  });

  describe('closed body schemas', () => {
    it('every body schema a route declares closes every object level', () => {
      expect(checkClosedBodies(realRoutes())).toEqual([]);
    });

    it('accepts a body of defined fields only', async () => {
      const res = await plantedPost('-closed', {
        name: 'n',
        inner: { a: 'a' },
        items: [{ b: 'b' }],
      });
      expect(res.statusCode).toBe(200);
    });

    it.each([
      ['top-level', { name: 'n', extra: 1 }],
      ['inside a nested object', { inner: { a: 'a', extra: 1 } }],
      ['inside an array item', { items: [{ b: 'b', extra: 1 }] }],
    ])('refuses an undefined field %s', async (_label, payload) => {
      expectRefused(await plantedPost('-closed', payload), 'extra');
    });
  });

  describe('routes without a body schema', () => {
    it('accept an absent or empty body', async () => {
      expect((await plantedPost('-no-body')).statusCode).toBe(200);
      expect((await plantedPost('-no-body', {})).statusCode).toBe(200);
    });

    it('refuse a body field', async () => {
      expectRefused(await plantedPost('-no-body', { extra: 1 }), 'extra');
    });

    it('refuse a non-empty array body', async () => {
      const res = await plantedPost('-no-body', [{ extra: 1 }]);
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('a real no-input operation refuses a body field and changes nothing', async () => {
      const db = getDb();
      const [target] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, SEED_USERS.worker2.username));
      const res = await authPost(ownerToken, `/api/users/${target!.id}/deactivate`, {
        reason: 'urlaub',
      });
      expectRefused(res, 'reason');
      const [after] = await db
        .select({ active: users.active })
        .from(users)
        .where(eq(users.id, target!.id));
      expect(after!.active).toBe(true);
    });
  });

  describe('notification rules', () => {
    const RULE = {
      eventClass: 'project.transition_forward',
      stateFilter: 'in_arbeit',
      recipientSpec: { roles: ['owner'], includeAssignedWorkers: false, userIds: [] },
      enabled: true,
    };
    const ruleCount = async () =>
      (await authGet(ownerToken, '/api/notification-rules')).json().data.length as number;

    it('create refuses an undefined field and creates nothing', async () => {
      const before = await ruleCount();
      expectRefused(
        await authPost(ownerToken, '/api/notification-rules', { ...RULE, extra: 1 }),
        'extra',
      );
      expect(await ruleCount()).toBe(before);
    });

    it('update refuses an undefined nested field and changes nothing', async () => {
      const created = await authPost(ownerToken, '/api/notification-rules', RULE);
      expect(created.statusCode).toBe(201);
      const id = created.json().id as string;

      const res = await authPatch(ownerToken, `/api/notification-rules/${id}`, {
        enabled: false,
        recipientSpec: { ...RULE.recipientSpec, extra: 1 },
      });
      expectRefused(res, 'extra');
      expect((await authGet(ownerToken, `/api/notification-rules/${id}`)).json().enabled).toBe(
        true,
      );
    });
  });

  describe('import-job create', () => {
    const create = (payload: Record<string, unknown>) =>
      getApp().inject({
        method: 'POST',
        url: '/api/import-jobs',
        headers: {
          cookie: `session=${ownerToken}`,
          'upload-length': '1024',
          'content-type': 'application/json',
        },
        payload,
      });
    const importJobs = () =>
      getDb()
        .select({ id: dataExchangeJob.id })
        .from(dataExchangeJob)
        .where(eq(dataExchangeJob.kind, 'import'));

    it('refuses an undefined field and creates no job', async () => {
      expectRefused(
        await create({ override: false, confirmationPhrase: 'x' }),
        'confirmationPhrase',
      );
      expect(await importJobs()).toEqual([]);
    });

    it('refuses fields nested under a defined one and creates no job', async () => {
      const res = await create({ override: { extra: 1 } });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(await importJobs()).toEqual([]);
    });
  });

  describe('self-test: the gate goes red', () => {
    it.each([
      ['on an open root', '-open-root', '(root)'],
      ['on an open nested object', '-open-nested', '.inner'],
      ['on an open array item', '-open-item', '.items[]'],
    ])('%s', (_label, suffix, at) => {
      const planted = plantedRoute(suffix);
      expect(planted).toHaveLength(1);
      expect(checkClosedBodies(planted)).toEqual([
        `POST ${PLANTED}${suffix}: body ${at} admits undefined fields`,
      ]);
    });
  });
});
