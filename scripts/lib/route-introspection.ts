/**
 * The route facts both doc generators read, in one place.
 *
 * `generate-api-surface.ts` (AC-352) and `generate-openapi.ts` (AC-351,
 * AC-353) publish different artifacts from the same introspection: which
 * gate reaches a route, what rule that gate enforces, and which HEAD
 * routes are Fastify's automatic companions rather than deliberate
 * declarations. Each generator carried its own copy, agreeing only
 * because a comment in each said so — the hand-maintained-agreement
 * failure mode both generators exist to remove, turned on the generators
 * themselves. One copy here means the two artifacts cannot describe the
 * same route differently.
 *
 * Everything here reads `RouteOptions` as collected by an `onRoute` hook
 * after `ready()` has resolved; nothing boots an app or touches the
 * filesystem, so both generators keep owning their own env pinning and
 * their own output.
 */
import type { RouteOptions } from 'fastify';
// Bindings-free type import, purely to pull in the `FastifyContextConfig`
// module augmentation `requireSession` declares. Without it `route.config.auth`
// is not a known property here, and reading it through a cast would let the
// marker be renamed on one side only.
import type {} from '../../src/server/middleware/auth.js';

type Handler = RouteOptions['handler'];

/** Fastify accepts `method` as a string or an array; always read an array. */
export function methodsOf(route: RouteOptions): string[] {
  return ([] as string[]).concat(route.method);
}

/**
 * The `preHandler`s declared at the route itself, in execution order and
 * always as an array. Plugin-level `preHandler`s are invisible to
 * `onRoute` and are absent here; `route.config.auth` is what reports them.
 */
function routeLevelPreHandlers(route: RouteOptions): unknown[] {
  const { preHandler } = route;
  if (!preHandler) return [];
  return Array.isArray(preHandler) ? [...preHandler] : [preHandler];
}

/** A `preHandler` produced by `createAuthMiddleware`. */
function isSessionGate(fn: unknown): boolean {
  return typeof fn === 'function' && (fn as { requiresSession?: unknown }).requiresSession === true;
}

/**
 * True when a session gate reaches this route — either the route-config
 * marker `requireSession` writes across its whole encapsulation context,
 * or a session gate installed on the route itself.
 *
 * Both halves are load-bearing: a plugin-level `preHandler` is invisible
 * to `onRoute`, so the marker is what makes group gating readable at all,
 * and routes that gate themselves never get one.
 */
export function isSessionGated(route: RouteOptions): boolean {
  return route.config?.auth === 'session' || routeLevelPreHandlers(route).some(isSessionGate);
}

/**
 * The rule a `requirePermission(...)` / `requireRole(...)` gate enforces,
 * rendered as the spec words it, or `null` if `fn` is neither.
 *
 * Both publish the RULE, not the role set it resolves to today — the
 * distinction AC-349 draws for the nav matrix, and the reason both gates
 * carry their keys as data instead of hiding them in a closure.
 */
function readAccessRule(fn: unknown): string | null {
  if (typeof fn !== 'function') return null;
  const permissions = (fn as { requiredPermissions?: unknown }).requiredPermissions;
  if (Array.isArray(permissions)) {
    return permissions.map((key) => `\`${String(key)}\``).join(' or ');
  }
  const roles = (fn as { requiredRoles?: unknown }).requiredRoles;
  if (Array.isArray(roles)) {
    return `Role: ${roles.map(String).join(' or ')}`;
  }
  return null;
}

/** Every access rule enforced at this route's boundary, in gate order. */
export function accessRules(route: RouteOptions): string[] {
  return routeLevelPreHandlers(route)
    .map(readAccessRule)
    .filter((rule): rule is string => rule !== null);
}

/**
 * Drop the HEAD companion Fastify exposes for every GET route: same URL,
 * and the very same handler reference. An explicitly declared HEAD route
 * has its own handler and survives.
 */
export function withoutAutoHeadRoutes(routes: RouteOptions[]): RouteOptions[] {
  const getHandlers = new Map<string, Handler>();
  for (const route of routes) {
    if (methodsOf(route).includes('GET')) getHandlers.set(route.url, route.handler);
  }
  return routes.filter((route) => {
    const methods = methodsOf(route);
    return !(
      methods.length === 1 &&
      methods[0] === 'HEAD' &&
      getHandlers.get(route.url) === route.handler
    );
  });
}

/**
 * Fail on a route an access gate reaches but no session gate does.
 *
 * `requirePermission` and `requireRole` both reject a request carrying no
 * `request.user` with 401, and only `createAuthMiddleware` ever sets one.
 * So the combination is not a documentation defect but a dead route: it
 * answers 401 to every caller, including one holding the permission.
 *
 * It is also the fail-open direction of both generated artifacts —
 * `Auth: none` beside a populated `Access` column, `security: []` on an
 * operation the server refuses — which is why the guard lives with the
 * introspection rather than inside either one. The orphan-operation check
 * in `generate-openapi.ts` closes the same door from the document side;
 * this closes it from the route side, where the bug actually is.
 */
export function assertGatesAuthenticate(routes: RouteOptions[]): void {
  const orphaned = withoutAutoHeadRoutes(routes)
    .filter((route) => accessRules(route).length > 0 && !isSessionGated(route))
    .map((route) => `${methodsOf(route).join(', ')} ${route.url}`);

  if (orphaned.length > 0) {
    throw new Error(
      `route(s) carry a permission/role gate that no session gate reaches: ` +
        `${orphaned.join('; ')}. \`requirePermission\` / \`requireRole\` reject a ` +
        `request with no authenticated user, so these answer 401 to every caller ` +
        `while the generated documents publish them as public. Gate the plugin with ` +
        `\`requireSession(app, db)\`, or put \`createAuthMiddleware(db)\` ahead of the ` +
        `access gate in the route's own preHandler chain.`,
    );
  }
}
