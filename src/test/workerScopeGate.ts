/**
 * Worker-scope route gate (AC-383).
 *
 * Worker data scoping (ADR-0019) has two halves, repeated by hand on
 * every route a worker reaches: the scope check (the project is assigned
 * to the caller) and the parent binding (the child row belongs to the
 * project in the path). The per-AC scope tests cover the routes someone
 * remembered. This gate walks the routes `buildApp()` registers and
 * probes every one a worker reaches, so a new route that skips either
 * half fails CI.
 *
 * Deny by default: every worker-reachable route needs an entry in
 * `WORKER_ROUTE_SCOPE` — a probe, or an exemption naming its reason. An
 * unclassified route fails, and so does an entry naming no
 * worker-reachable route.
 *
 * Probes, as a worker:
 *
 *   - **A** — every entity id belongs to an unassigned project → refused.
 *   - **B** — the parent is the worker's own project, every child is
 *     foreign → refused. Runs when the route names a child: a second
 *     path param, or ids in the body.
 *   - **Leak** — a read naming no entity answers 200 and carries no
 *     foreign id. A non-200 fails: a route the probe cannot reach proves
 *     nothing.
 *
 * Refused means 403 or 404. Those never come from request validation
 * (400 / 422), so a refusal cannot be a fixture body the schema rejected.
 * The one exception is `invalidInputRefusal`, for a route whose own AC
 * answers a foreign child with 422 (probe B): its fixture is then proven
 * valid by a control run with in-scope ids that must succeed.
 *
 * A refusal must come from scope or binding, not from a later check, so
 * foreign fixtures are rows the worker could otherwise act on — e.g. the
 * foreign attachment is the worker's own fresh upload, past the AC-215
 * self-delete check.
 *
 * Public routes are out of scope: no worker identity reaches them, and
 * their exposure is published by AC-352.
 */
import type { FastifyInstance, InjectOptions, RouteOptions } from 'fastify';
import {
  classificationGaps,
  gatesAdmit,
  isSessionGated,
  routeKeys,
  withoutAutoHeadRoutes,
} from '../../scripts/lib/route-introspection.js';
import { binaryInitBody } from './fixtures/attachmentInit.js';

export type Entity = 'project' | 'customer' | 'attachment' | 'invoice';
export type EntityIds = Record<Entity, string>;

export interface ScopeFixtures {
  /** Ids on projects the worker is assigned to — parents for probe B, ids for controls. */
  inScope: Partial<EntityIds>;
  /** Ids on a project the worker is not assigned to. */
  foreign: EntityIds;
}

export type RouteScope =
  | {
      probe: 'by-id';
      /** Query string appended to every probe, e.g. a required `variant`. */
      query?: string;
      /** Request body; `ids` are the probe's child ids. */
      body?: (ids: Partial<EntityIds>) => Record<string, unknown>;
      /** The body names a child entity, so probe B applies. */
      childInBody?: true;
      /** The AC under which this route answers a foreign id with 422. */
      invalidInputRefusal?: string;
    }
  | { probe: 'leak' }
  | { exempt: string };

/**
 * Every route a worker reaches. A path param resolves to the entity of
 * the collection segment before it (`/projects/:id` → project,
 * `/attachments/:attId` → attachment).
 */
export const WORKER_ROUTE_SCOPE: Record<string, RouteScope> = {
  'GET /api/projects': { probe: 'leak' },
  'GET /api/projects/:id': { probe: 'by-id' },
  'GET /api/projects/:id/storage-usage': { probe: 'by-id' },
  'GET /api/customers': { probe: 'leak' },
  'GET /api/customers/:id': { probe: 'by-id' },
  'GET /api/workers': { probe: 'leak' },
  'GET /api/projects/:id/attachments': { probe: 'by-id' },
  'POST /api/projects/:id/attachments/init': {
    probe: 'by-id',
    body: () => binaryInitBody({ fileName: 'probe.pdf', sizeBytes: 100, label: 'sonstiges' }),
  },
  'POST /api/projects/:id/attachments/:attId/complete': { probe: 'by-id' },
  'DELETE /api/projects/:id/attachments/:attId': { probe: 'by-id' },
  'GET /api/projects/:id/attachments/:attId/download-url': {
    probe: 'by-id',
    query: 'variant=original',
  },
  'POST /api/projects/:id/attachments/bulk-fetch': {
    probe: 'by-id',
    body: (ids) => ({ attachmentIds: [ids.attachment] }),
    childInBody: true,
    invalidInputRefusal: 'AC-216',
  },
  'GET /api/invoices': { probe: 'leak' },
  'GET /api/invoices/years': { probe: 'leak' },
  'GET /api/invoices/:id': { probe: 'by-id' },
  'GET /api/company-profile': { probe: 'leak' },
  'GET /api/auth/me': { probe: 'leak' },
  'GET /api/events': { exempt: 'SSE stream; events carry no payload (ADR-0025)' },
  'PATCH /api/auth/me': { exempt: "the caller's own user row" },
  'POST /api/auth/logout': { exempt: "the caller's own session" },
  'POST /api/auth/change-password': { exempt: "the caller's own credentials" },
  'POST /api/push-subscriptions': { exempt: "the caller's own subscriptions" },
  'DELETE /api/push-subscriptions': { exempt: "the caller's own subscriptions" },
  'DELETE /api/push-subscriptions/:id': {
    exempt: "the caller's own subscriptions — bound to the user, not to a project",
  },
};

const WORKER_ROLES = ['worker'];
const REFUSED = [403, 404];

type Method = NonNullable<InjectOptions['method']>;

/** Session-gated routes whose access gates admit a worker. */
export function workerReachableRoutes(routes: RouteOptions[]): RouteOptions[] {
  return withoutAutoHeadRoutes(routes).filter(
    (route) => isSessionGated(route) && gatesAdmit(route, WORKER_ROLES),
  );
}

interface PathParam {
  name: string;
  entity: Entity | undefined;
}

const COLLECTION_ENTITY: Record<string, Entity> = {
  projects: 'project',
  customers: 'customer',
  attachments: 'attachment',
  invoices: 'invoice',
};

function pathParams(url: string): PathParam[] {
  const segments = url.split('/');
  return segments.flatMap((segment, i) =>
    segment.startsWith(':')
      ? [{ name: segment.slice(1), entity: COLLECTION_ENTITY[segments[i - 1] ?? ''] }]
      : [],
  );
}

interface Probe {
  label: string;
  /** The id set each path param draws from, in path order. */
  pathIds: Partial<EntityIds>[];
  /** The id set the body draws from. */
  bodyIds: Partial<EntityIds>;
  /** Accepted refusal statuses; absent for a control, which must succeed. */
  refused?: number[];
}

/**
 * Probe a worker's access to every route they reach. Returns one line per
 * violation; an empty list is a pass.
 */
export async function probeWorkerScope(
  app: FastifyInstance,
  routes: RouteOptions[],
  opts: { token: string; fixtures: ScopeFixtures; table?: Record<string, RouteScope> },
): Promise<string[]> {
  const table = opts.table ?? WORKER_ROUTE_SCOPE;
  const { inScope, foreign } = opts.fixtures;
  const reachable = workerReachableRoutes(routes);
  const { unclassified, stale } = classificationGaps(
    reachable.flatMap(routeKeys),
    Object.keys(table),
  );
  const violations = [
    ...unclassified.map((key) => `${key}: not classified — add a probe or an exemption`),
    ...stale.map((key) => `${key}: classified, but no worker-reachable route has this key`),
  ];

  const send = (method: Method, url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, payload, headers: { cookie: `session=${opts.token}` } });

  for (const key of reachable.flatMap(routeKeys)) {
    const scope = table[key];
    if (!scope || 'exempt' in scope) continue;
    const [method, url] = key.split(' ') as [Method, string];

    if (scope.probe === 'leak') {
      const res = await send(method, url);
      if (res.statusCode !== 200) {
        violations.push(`${key}: leak probe answered ${res.statusCode}, not 200`);
        continue;
      }
      const leaked = Object.entries(foreign).filter(([, id]) => res.body.includes(id));
      for (const [entity] of leaked) {
        violations.push(`${key}: response carries the foreign ${entity}`);
      }
      continue;
    }

    const params = pathParams(url);
    const unresolved = params.filter((p) => !p.entity);
    if (params.length === 0 || unresolved.length > 0) {
      violations.push(
        `${key}: no entity for path param(s) ${unresolved.map((p) => `:${p.name}`).join(', ') || '(none)'}`,
      );
      continue;
    }

    const allForeign = params.map(() => foreign);
    const probes: Probe[] = [
      { label: 'probe A', pathIds: allForeign, bodyIds: foreign, refused: REFUSED },
    ];
    if (params.length > 1 || scope.childInBody) {
      probes.push({
        label: 'probe B',
        pathIds: [inScope, ...allForeign.slice(1)],
        bodyIds: foreign,
        // The foreign child is invalid input only under an in-scope parent.
        refused: scope.invalidInputRefusal ? [...REFUSED, 422] : REFUSED,
      });
    }
    if (scope.invalidInputRefusal) {
      probes.push({ label: 'control', pathIds: params.map(() => inScope), bodyIds: inScope });
    }

    for (const probe of probes) {
      const missing = params.filter((p, i) => !probe.pathIds[i]![p.entity!]).map((p) => p.entity);
      if (missing.length > 0) {
        violations.push(`${key}: ${probe.label} has no fixture for ${missing.join(', ')}`);
        continue;
      }
      const path = params.reduce(
        (acc, p, i) => acc.replace(`:${p.name}`, probe.pathIds[i]![p.entity!]!),
        url,
      );
      const res = await send(
        method,
        scope.query ? `${path}?${scope.query}` : path,
        scope.body?.(probe.bodyIds),
      );
      if (!probe.refused) {
        if (res.statusCode >= 300) {
          violations.push(
            `${key}: control with in-scope ids answered ${res.statusCode} — the fixture is invalid, ` +
              `so a ${scope.invalidInputRefusal} 422 refusal proves nothing`,
          );
        }
      } else if (!probe.refused.includes(res.statusCode)) {
        violations.push(
          `${key}: ${probe.label} answered ${res.statusCode}, expected ${probe.refused.join(' / ')}`,
        );
      }
    }
  }
  return violations;
}
