/**
 * The OpenAPI document's shaping and the guards over it (AC-351, AC-353).
 *
 * Everything here is decided by `(doc, routes)` alone — the document
 * `@fastify/swagger` produced and the routes `buildApp()` registered. No
 * boot, no env, no filesystem: `generate-openapi.ts` owns those, and
 * calls into this in one line each: strip → guard → annotate → validate.
 *
 * Not pure, though: each of the four functions mutates `doc` in place or
 * throws, and none returns a value. One convention for the module, so no
 * call site reads as if it were dropping a result that mattered.
 *
 * Split out for size (C-SIZE): the generator's own header, env pinning
 * and drift plumbing are a separate concern from what the document is
 * allowed to claim, and only the latter is testable without booting an
 * app. It has one consumer, unlike `route-introspection.ts`, which is
 * shared by both generators.
 */
import { Validator } from '@seriousme/openapi-schema-validator';
import type { RouteOptions } from 'fastify';
import { methodsOf, isSessionGated, withoutAutoHeadRoutes } from './route-introspection.js';

export const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

interface OperationLike {
  responses?: Record<string, unknown>;
  security?: Record<string, string[]>[];
}
export interface DocLike {
  paths?: Record<string, Record<string, unknown>>;
  components?: Record<string, unknown>;
}

/**
 * The `openapi:` version the document declares, and the major.minor the
 * validator is required to report back for it (`Validator.version` is
 * major.minor only).
 */
export const DECLARED_OAS_VERSION = '3.1.0';
const TARGET_OAS_VERSION = '3.1';

/**
 * True for the placeholder `@fastify/swagger` synthesizes when a route
 * declared no `response:` schema: `{"200": {"description": "Default
 * Response"}}`. Matched exactly (single key, single property, exact
 * text), so a real declared response schema is never mistaken for it.
 */
function isSyntheticResponses(responses: Record<string, unknown> | undefined): boolean {
  if (!responses) return false;
  const keys = Object.keys(responses);
  if (keys.length !== 1 || keys[0] !== '200') return false;
  const body = responses['200'];
  if (typeof body !== 'object' || body === null) return false;
  const props = Object.keys(body);
  return (
    props.length === 1 && (body as { description?: unknown }).description === 'Default Response'
  );
}

/**
 * Strip claims the route schemas do not support: the synthetic 200, and
 * an all-empty `components` (today `{"schemas": {}}`). Both are derived
 * from nothing, and 3.1 lets the document stay silent about them —
 * ARCHITECTURE.md § OpenAPI Document Generation.
 *
 * The published document does carry a `components` block regardless:
 * `applySecurity` runs after this and puts `securitySchemes` back. What
 * this drops is the empty `schemas` map that would otherwise sit beside
 * it.
 *
 * Real response schemas, once routes declare them, flow through
 * untouched.
 */
export function stripUnsupportedClaims(doc: DocLike): void {
  for (const item of Object.values(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = item[method] as OperationLike | undefined;
      if (op && isSyntheticResponses(op.responses)) delete op.responses;
    }
  }
  const components = doc.components;
  if (
    components &&
    Object.values(components).every(
      (v) => typeof v === 'object' && v !== null && Object.keys(v).length === 0,
    )
  ) {
    delete doc.components;
  }
}

/**
 * The one hand-written seam in the document (AC-353).
 *
 * Session auth is a cookie the server sets at login and reads in a
 * `preHandler`; no route declaration carries "there is a scheme called
 * this, and it is an apiKey in that cookie", so the scheme itself cannot
 * be derived from anything. The per-operation REQUIREMENT is derived —
 * see `applySecurity` — which is the half that would otherwise rot.
 *
 * `session` is the cookie name `POST /api/auth/login` sets
 * (`src/server/routes/auth.ts`) and `createAuthMiddleware` reads.
 */
const SESSION_SCHEME_NAME = 'sessionCookie';
const SECURITY_SCHEMES = {
  [SESSION_SCHEME_NAME]: {
    type: 'apiKey',
    in: 'cookie',
    name: 'session',
    description:
      'Session cookie issued by `POST /api/auth/login`. Set server-side as ' +
      'HttpOnly; it is never read or sent explicitly by client code.',
  },
} as const;

/**
 * Fastify's `:param` path syntax to OpenAPI's `{param}`. Mirrors the
 * conversion `@fastify/swagger` performs on the same URLs — the two have
 * to agree for `applySecurity` to match an operation to its route, and
 * the total-coverage check there is what fails the build if they ever
 * stop agreeing.
 */
function toOpenApiPath(url: string): string {
  return url.replace(/:([^/]+)/g, '{$1}');
}

/**
 * The key both guards index operations by, from either side.
 *
 * `applySecurity` and `assertEveryRoutePublished` each build it twice —
 * once from a document path, once from a route URL — and the two guards
 * point in opposite directions, so a key built four ways could leave one
 * of them matching on a rule the other does not. One function means the
 * only way to disagree is to stop calling it. The route side passes
 * `toOpenApiPath(route.url)`; the document side is already in OpenAPI
 * form.
 */
function operationKey(method: string, openApiPath: string): string {
  return `${method.toLowerCase()} ${openApiPath}`;
}

/**
 * Annotate every published operation with its session requirement,
 * derived from the gates the routes carry (AC-353).
 *
 * `[]` — an explicit empty requirement — is how OpenAPI says "no auth
 * needed", and it is what the seven ungated routes get. Publishing them
 * by omitting the key instead would be indistinguishable from an
 * operation this function failed to reach.
 *
 * The match is total in the doc→route direction and throws otherwise:
 * an operation with no route behind it would silently publish without a
 * requirement, which understates the protection the server enforces.
 * `assertEveryRoutePublished` covers the other direction.
 */
export function applySecurity(doc: DocLike, routes: RouteOptions[]): void {
  const gatedByKey = new Map<string, boolean>();
  for (const route of routes) {
    const gated = isSessionGated(route);
    for (const method of methodsOf(route)) {
      gatedByKey.set(operationKey(method, toOpenApiPath(route.url)), gated);
    }
  }

  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = item[method] as OperationLike | undefined;
      if (!op) continue;
      const gated = gatedByKey.get(operationKey(method, path));
      if (gated === undefined) {
        throw new Error(
          `published operation \`${method.toUpperCase()} ${path}\` matches no route ` +
            `buildApp() registered, so its authentication requirement cannot be ` +
            `derived. Publishing it unannotated would advertise a protected ` +
            `endpoint as public — fix the path mapping rather than skipping it.`,
        );
      }
      op.security = gated ? [{ [SESSION_SCHEME_NAME]: [] }] : [];
    }
  }

  doc.components = { ...doc.components, securitySchemes: SECURITY_SCHEMES };
}

/**
 * Every route the factory registered must appear in the document —
 * the direction that makes AC-351's "endpoint surface is complete for
 * the API" an enforced property rather than an asserted one.
 *
 * It was asserted, and it was false: `@fastify/swagger` drops HEAD
 * routes unless the route opts in (`config.swagger.exposeHeadRoute`),
 * which silently omitted `HEAD /api/import-jobs/:id/archive` — the tus
 * offset probe, normative in api.md §14.2.4 and called by
 * `src/api/client.ts`. Nothing failed, because nothing was looking.
 *
 * Two exclusions, both structural rather than a list of names:
 *
 *   - **Automatic HEAD companions.** Fastify exposes one per GET route:
 *     same URL, and the very same handler reference. Dropped by
 *     `withoutAutoHeadRoutes`, the same filter the API-surface table
 *     applies — so a HEAD route surviving here is one somebody declared
 *     on purpose.
 *   - **Routes that hide themselves.** `schema.hide` is
 *     `@fastify/swagger`'s own opt-out, and `@fastify/cors` sets it on
 *     the `OPTIONS *` preflight it registers. A route claiming that
 *     exclusion has to say so at its registration site.
 */
export function assertEveryRoutePublished(doc: DocLike, routes: RouteOptions[]): void {
  const published = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      if (item[method]) published.add(operationKey(method, path));
    }
  }

  const missing: string[] = [];
  for (const route of withoutAutoHeadRoutes(routes)) {
    // Deliberately stricter than `@fastify/swagger`'s own
    // `shouldRouteHide`, which hides a strict superset: any TRUTHY
    // `schema.hide`, a route tagged with its `hiddenTag` (default
    // `X-HIDDEN`), and — under `hideUntagged`, which this generator
    // leaves at its default `false` — every untagged route. So each
    // divergence fails closed: a route this expects published but the
    // plugin hides breaks the build, rather than passing unpublished.
    // The cost is a build break demanding `hide: true` spelled exactly,
    // never a silently shrunken surface.
    if ((route.schema as { hide?: unknown } | undefined)?.hide === true) continue;
    for (const method of methodsOf(route)) {
      if (!published.has(operationKey(method, toOpenApiPath(route.url)))) {
        missing.push(`${method} ${route.url}`);
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `route(s) registered by buildApp() but absent from the document: ` +
        `${missing.join(', ')}. The document claims a complete endpoint surface ` +
        `(AC-351), so publish them — a deliberately declared HEAD route opts in ` +
        `with \`config: { swagger: { exposeHeadRoute: true } }\` — or hide them ` +
        `explicitly with \`schema: { hide: true }\` at the registration site.`,
    );
  }
}

/**
 * Fail unless the document is valid OpenAPI 3.1 — the second of the two
 * gates (ARCHITECTURE.md § OpenAPI Document Generation).
 *
 * The detected version is asserted too, not just validity: the validator
 * picks its schema from the document's own `openapi:` field, so a
 * document that silently declared 3.0 would be checked against 3.0's
 * schema and pass — a green check that no longer means what it says.
 */
export async function assertValid(doc: DocLike): Promise<void> {
  const validator = new Validator();
  const result = await validator.validate(doc as Record<string, unknown>);
  if (!result.valid) {
    const detail =
      typeof result.errors === 'string' ? result.errors : JSON.stringify(result.errors, null, 2);
    throw new Error(`generated document is not valid OpenAPI:\n${detail}`);
  }
  if (validator.version !== TARGET_OAS_VERSION) {
    throw new Error(
      `generated document validated as OpenAPI ${validator.version}, expected ${TARGET_OAS_VERSION}`,
    );
  }
}
