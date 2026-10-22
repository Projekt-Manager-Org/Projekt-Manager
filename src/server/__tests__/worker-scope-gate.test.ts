/**
 * Worker-scope route gate (AC-383) — the gate itself in
 * `src/test/workerScopeGate.ts`.
 *
 * The gate run probes every worker-reachable route `buildApp()`
 * registers. The self-test plants one route per failure the gate exists
 * for, on the same app, and asserts each goes red. Without it the gate
 * could pass vacuously: every real route is scoped today.
 *
 * Fixtures: arbeiter1 (SEED_USERS.worker1) is assigned YYYY-007, -008,
 * -009, -011 (src/server/seed/business.ts). Foreign entities hang off
 * -010, whose customer is reachable only through it; the foreign invoice
 * is any seeded invoice on a project outside that set.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { startApp, stopApp, login, authGet, getDb } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import {
  probeWorkerScope,
  type RouteScope,
  type ScopeFixtures,
} from '../../test/workerScopeGate.js';
import {
  recordRoutes,
  routeKeys,
  withoutAutoHeadRoutes,
} from '../../../scripts/lib/route-introspection.js';
import type { Database } from '../db/connection.js';
import { projects } from '../db/schema.js';
import { requirePermission, requireSession } from '../middleware/auth.js';
import { isProjectInScope } from '../repositories/scope.js';
import { KeyEnvelopeService } from '../services/KeyEnvelopeService.js';

const year = new Date().getFullYear();
const WORKER1_PROJECTS = ['007', '008', '009', '011'].map((n) => `${year}-${n}`);

const PLANTED = '__planted';

/**
 * One route per gate failure. Registered under `requireSession` like
 * every real route plugin, so the gate selects them the same way.
 */
function plantedRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    requireSession(app, db);
    // Scope check skipped: serves any project.
    app.get(
      `/api/projects/:id/${PLANTED}-skips-scope`,
      { preHandler: requirePermission('project:read') },
      async (request) => ({ id: (request.params as { id: string }).id }),
    );
    // Scope checked on the parent, child never bound to it.
    app.get(
      `/api/projects/:id/attachments/:attId/${PLANTED}-skips-binding`,
      { preHandler: requirePermission('attachment:read') },
      async (request, reply) => {
        const { id, attId } = request.params as { id: string; attId: string };
        if (!(await isProjectInScope(db, request.user!, id))) {
          return reply.code(403).send({ code: 'NOT_PERMITTED' });
        }
        return { attId };
      },
    );
    // A list without the scope predicate.
    app.get(`/api/${PLANTED}-leaks`, { preHandler: requirePermission('project:read') }, async () =>
      db.select({ id: projects.id }).from(projects),
    );
    // A 422 refusal whose fixture never succeeds, so the control must catch it.
    app.get(
      `/api/projects/:id/attachments/:attId/${PLANTED}-rejects-all`,
      { preHandler: requirePermission('attachment:read') },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        if (!(await isProjectInScope(db, request.user!, id))) {
          return reply.code(403).send({ code: 'NOT_PERMITTED' });
        }
        return reply.code(422).send({ code: 'VALIDATION_ERROR' });
      },
    );
    // Worker-reachable, absent from the table.
    app.post(`/api/${PLANTED}-unclassified`, async () => ({}));
  };
}

/**
 * A ready attachment row with a real wrapped DEK — the bulk-fetch control
 * unwraps it. Created now by `createdBy`, so a worker's hide passes the
 * AC-411 self-delete check and only scope or binding can refuse it.
 */
async function insertReadyAttachment(projectId: string, createdBy: string): Promise<string> {
  const identityPath = process.env.BINARY_AGE_IDENTITY_PATH;
  const recipient = process.env.BINARY_AGE_RECIPIENT;
  if (!identityPath || !recipient) throw new Error('per-fork binary identity not configured');
  const envelope = await new KeyEnvelopeService({
    recipient,
    identity: readFileSync(identityPath, 'utf-8').trim(),
  }).wrap(crypto.randomBytes(32));
  const id = crypto.randomUUID();
  await getDb().execute(sql`
    INSERT INTO attachments
      (id, project_id, status, kind, label, filename, mime_type, size_bytes,
       ciphertext_size_bytes, original_key, has_thumbnail, wrapped_dek, wrapped_dek_version,
       created_by)
    VALUES (${id}, ${projectId}, 'ready', 'binary', 'sonstiges', 'probe.pdf', 'application/pdf',
            100, 164, ${`attachments/${projectId}/${id}.orig`}, FALSE,
            ${Buffer.from(envelope).toString('base64')}, 1, ${createdBy})
  `);
  return id;
}

describe('Worker-scope route gate (AC-383)', () => {
  let app: FastifyInstance;
  let routes: RouteOptions[];
  let workerToken: string;
  let fixtures: ScopeFixtures;

  const realRoutes = () => routes.filter((r) => !r.url.includes(PLANTED));
  const plantedRoute = (suffix: string) =>
    withoutAutoHeadRoutes(routes).filter((r) => r.url.includes(suffix));

  beforeAll(async () => {
    app = await startApp({
      beforeReady: (instance) => {
        routes = recordRoutes(instance);
        instance.register(plantedRoutes(getDb()));
      },
    });
    const ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    workerToken = await login(SEED_USERS.worker1.username, SEED_DEFAULT_PASSWORD);
    const workerId = (await authGet(workerToken, '/api/auth/me')).json().user.id as string;

    const projectList = (await authGet(ownerToken, '/api/projects?limit=200')).json().data as {
      id: string;
      number: string;
      customerId: string;
    }[];
    const byNumber = (n: string) => {
      const p = projectList.find((row) => row.number === `${year}-${n}`);
      if (!p) throw new Error(`seed missing ${year}-${n}`);
      return p;
    };
    const own = byNumber('007');
    const foreign = byNumber('010');
    const assignedIds = new Set(
      WORKER1_PROJECTS.map((n) => projectList.find((p) => p.number === n)?.id),
    );

    const invoices = (await authGet(ownerToken, '/api/invoices')).json().data as {
      id: string;
      projectId: string;
    }[];
    const foreignInvoice = invoices.find((i) => !assignedIds.has(i.projectId));
    if (!foreignInvoice) throw new Error('seed has no invoice outside worker1 scope');

    fixtures = {
      inScope: {
        project: own.id,
        customer: own.customerId,
        attachment: await insertReadyAttachment(own.id, workerId),
      },
      foreign: {
        project: foreign.id,
        customer: foreign.customerId,
        attachment: await insertReadyAttachment(foreign.id, workerId),
        invoice: foreignInvoice.id,
      },
    };
  });

  afterAll(async () => {
    await stopApp();
  });

  it('every worker-reachable route is classified and refuses out-of-scope ids', async () => {
    const violations = await probeWorkerScope(app, realRoutes(), { token: workerToken, fixtures });
    expect(violations).toEqual([]);
  });

  describe('self-test: a planted route goes red', () => {
    const cases: [string, string, RouteScope | undefined, string][] = [
      [
        'skips the scope check',
        '-skips-scope',
        { probe: 'by-id' },
        'probe A answered 200, expected 403 / 404',
      ],
      [
        'skips the parent binding',
        '-skips-binding',
        { probe: 'by-id' },
        'probe B answered 200, expected 403 / 404',
      ],
      [
        'leaks a foreign entity from a list',
        '-leaks',
        { probe: 'leak' },
        'carries the foreign project',
      ],
      [
        'admits 422 on a fixture its control cannot pass',
        '-rejects-all',
        { probe: 'by-id', invalidInputRefusal: 'AC-414' },
        'control with in-scope ids answered 422',
      ],
      ['is left unclassified', '-unclassified', undefined, 'not classified'],
    ];

    it.each(cases)('%s', async (_label, suffix, scope, expected) => {
      const planted = plantedRoute(suffix);
      expect(planted).toHaveLength(1);
      const table = scope ? { [routeKeys(planted[0]!)[0]!]: scope } : {};
      const violations = await probeWorkerScope(app, planted, {
        token: workerToken,
        fixtures,
        table,
      });
      expect(violations).toEqual([expect.stringContaining(expected)]);
    });
  });
});
