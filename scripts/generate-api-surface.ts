/**
 * Generates the endpoint table in `ARCHITECTURE.md` § API Surface from
 * the routes `buildApp()` registers — the published table is not
 * hand-authored (AC-352).
 *
 * Fourth of the doc generators, same markers-and-`--check` shape as
 * `generate-permissions-doc.ts` (AC-343), `generate-nav-doc.ts` (AC-349)
 * and `generate-openapi.ts` (AC-351). What it publishes is coverage plus
 * the three access columns; the prose below the end marker — what an
 * endpoint is FOR — is hand-written and never overwritten, because that
 * is the part no route declaration contains.
 *
 * Every column is read off the route, not off a parallel list:
 *
 *   - **Method / Path** — the route registration itself.
 *   - **Auth** — `requireSession` (`src/server/middleware/auth.ts`) marks
 *     every route in its encapsulation context with `auth: 'session'`,
 *     and route-level session gates carry `requiresSession`. Absence of
 *     both is what makes an endpoint public; there is no hand-kept list
 *     of public endpoints to fall out of date.
 *   - **Access** — `requirePermission(...)` / `requireRole(...)` return
 *     closures, and a closure can be called but not read, so each
 *     carries its keys as `requiredPermissions` / `requiredRoles`. Same
 *     argument that made `RouteAccess` data in AC-349, and the reason
 *     the column publishes the rule rather than the role set it happens
 *     to resolve to.
 *   - **Rate limit** — already declared as route config
 *     (`config: { rateLimit: … }`), visible on Fastify's `onRoute`.
 *
 * Rows are emitted in registration order, which groups them by route
 * plugin — the grouping the hand-maintained table used to keep by hand.
 *
 * Fastify exposes a HEAD companion for every GET route. Those companions
 * are filtered out (same URL, same handler reference as the GET), so a
 * HEAD row means a route that was declared HEAD deliberately —
 * `/api/import-jobs/:id/archive`'s tus offset probe is the only one.
 *
 * `NODE_ENV=production` below is load-bearing, not boilerplate: the login
 * limit's default is environment-aware (`getRateLimit()` in
 * `src/server/config/index.ts`), and the table documents the production
 * surface. `LOGIN_RATE_LIMIT_MAX` is cleared for the same reason — a
 * developer's shell export must not reach the published doc.
 *
 * Usage:
 *   npx tsx scripts/generate-api-surface.ts           # write in place
 *   npx tsx scripts/generate-api-surface.ts --check   # verify only
 *
 * $API_SURFACE_DOC_PATH overrides the target file — used by
 * scripts/__tests__/check-api-surface.test.sh to point at a fixture copy
 * without touching the real doc. It overrides *only* the destination:
 * Prettier's configuration is always resolved from CANONICAL_DOC_PATH, so
 * a fixture written outside the repo is byte-identical to the published
 * doc rather than silently reformatted with Prettier's built-in defaults.
 *
 * Route registration requires a truthy `db`, and the placeholder env
 * below satisfies the presence checks registration performs without any
 * of it being dereferenced — the same seam `generate-openapi.ts`
 * documents at length, which is why this check needs no DB/MinIO either.
 *
 * Exit codes: 0 success / in-sync; 1 drift found (--check only); 2
 * toolchain error (doc file unreadable, markers missing, the app failed
 * to build, or a route declares a rate limit this script cannot render)
 * so the caller's `set -e` trips loudly instead of silently no-op'ing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import type { FastifyInstance, RouteOptions } from 'fastify';
import type pg from 'pg';
import { buildApp } from '../src/server/app.js';
import { createDatabase } from '../src/server/db/connection.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * The published doc. Also the path Prettier's configuration is always
 * resolved from, even when writing elsewhere — see `buildExpectedDoc`.
 */
const CANONICAL_DOC_PATH = path.join(REPO_ROOT, 'ARCHITECTURE.md');
const DOC_PATH = process.env.API_SURFACE_DOC_PATH ?? CANONICAL_DOC_PATH;

const START_MARKER = '<!-- GENERATED:api-surface:START';
const END_MARKER = '<!-- GENERATED:api-surface:END -->';

// `validateEnvRuntime()` (env.ts) re-parses `process.env` at CALL time,
// inside `createDatabase()` / `buildApp()` — never at module-import time
// — so setting these after the static imports above still takes effect.
process.env.NODE_ENV = 'production';
delete process.env.LOGIN_RATE_LIMIT_MAX;
process.env.DATABASE_URL = 'postgresql://api-surface:unused@127.0.0.1:1/api_surface_unused';
// Presence-only placeholders; never dereferenced during registration.
process.env.STORAGE_ENDPOINT = 'http://127.0.0.1:1';
process.env.STORAGE_ACCESS_KEY = 'api-surface-unused';
process.env.STORAGE_SECRET_KEY = 'api-surface-unused';
process.env.BINARY_AGE_RECIPIENT = 'age1apisurfaceunusedplaceholderplaceholderplaceholder';

/** One published row. */
interface Endpoint {
  methods: string[];
  url: string;
  auth: 'session' | 'none';
  access: string;
  rateLimit: string;
}

type Handler = RouteOptions['handler'];

/** A `preHandler` produced by `createAuthMiddleware`. */
function isSessionGate(fn: unknown): boolean {
  return typeof fn === 'function' && (fn as { requiresSession?: unknown }).requiresSession === true;
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

function routeLevelPreHandlers(route: RouteOptions): unknown[] {
  const { preHandler } = route;
  if (!preHandler) return [];
  return Array.isArray(preHandler) ? [...preHandler] : [preHandler];
}

/**
 * `or` within one gate (it grants on ANY of its keys), `and` across
 * gates (every gate must pass). No route stacks two gates today; the
 * rendering is total anyway so a future one cannot be published wrong.
 *
 * `—` means no gate at the route boundary, which is not the same as
 * "open to everyone": several read endpoints deliberately narrow rows by
 * the caller's scope instead (ADR-0019) — see the notes below the table.
 */
function renderAccess(route: RouteOptions): string {
  const gates = routeLevelPreHandlers(route)
    .map(readAccessRule)
    .filter((rule): rule is string => rule !== null);
  return gates.length > 0 ? gates.join(' and ') : '—';
}

/**
 * Render `config.rateLimit` as `<max> / <window>`, or throw. A limit
 * declared in a shape this cannot read is a doc that would silently go
 * wrong, so it fails the build instead (exit 2).
 */
function renderRateLimit(route: RouteOptions): string {
  const declared = route.config?.rateLimit;
  if (declared === undefined || declared === false) return 'none';
  const { max, timeWindow } = declared as { max?: unknown; timeWindow?: unknown };
  if (
    typeof max !== 'number' ||
    (typeof timeWindow !== 'string' && typeof timeWindow !== 'number')
  ) {
    throw new Error(
      `${route.method} ${route.url} declares a rate limit this generator cannot render: ` +
        `${JSON.stringify(declared)}. Teach renderRateLimit about it rather than publishing a guess.`,
    );
  }
  return `${max} / ${timeWindow}`;
}

/**
 * Build the app and collect every route it registers.
 *
 * The `onRoute` hook is attached AFTER `buildApp()` returns and BEFORE
 * `ready()`: `register()` defers plugin execution to `ready()`, so a root
 * hook added in between still sees every route, including those in child
 * encapsulation contexts.
 *
 * The collected `routeOptions` objects are read after `ready()`, not
 * inside the hook. Root hooks run before the plugin's own, and
 * `requireSession`'s marker is written by the latter — reading the held
 * reference afterwards is what sees the final value.
 */
async function collectRoutes(): Promise<RouteOptions[]> {
  let app: FastifyInstance | undefined;
  let pool: pg.Pool | undefined;
  try {
    const conn = createDatabase();
    pool = conn.pool;

    app = buildApp({ logger: false, db: conn.db });
    const collected: RouteOptions[] = [];
    app.addHook('onRoute', (routeOptions) => {
      collected.push(routeOptions);
    });
    await app.ready();
    return collected;
  } finally {
    await app?.close();
    await pool?.end();
  }
}

/**
 * Drop the HEAD companion Fastify exposes for every GET route: same URL,
 * and the very same handler reference. An explicitly declared HEAD route
 * has its own handler and survives.
 */
function withoutAutoHeadRoutes(routes: RouteOptions[]): RouteOptions[] {
  const getHandlers = new Map<string, Handler>();
  for (const route of routes) {
    const methods = ([] as string[]).concat(route.method);
    if (methods.includes('GET')) getHandlers.set(route.url, route.handler);
  }
  return routes.filter((route) => {
    const methods = ([] as string[]).concat(route.method);
    return !(
      methods.length === 1 &&
      methods[0] === 'HEAD' &&
      getHandlers.get(route.url) === route.handler
    );
  });
}

function toEndpoint(route: RouteOptions): Endpoint {
  const sessionGated =
    route.config?.auth === 'session' || routeLevelPreHandlers(route).some(isSessionGate);
  return {
    methods: ([] as string[]).concat(route.method),
    url: route.url,
    auth: sessionGated ? 'session' : 'none',
    access: renderAccess(route),
    rateLimit: renderRateLimit(route),
  };
}

function renderTable(endpoints: Endpoint[]): string {
  const header =
    '| Method | Path | Auth | Access | Rate limit |\n| --- | --- | --- | --- | --- |\n';
  const rows = endpoints
    .map(
      (e) =>
        `| ${e.methods.join(', ')} | \`${e.url}\` | ${e.auth} | ${e.access} | ${e.rateLimit} |`,
    )
    .join('\n');
  return `${header}${rows}\n`;
}

async function buildExpectedDoc(): Promise<string> {
  let doc: string;
  try {
    doc = readFileSync(DOC_PATH, 'utf8');
  } catch {
    console.error(`ERROR: cannot read ${DOC_PATH}`);
    process.exit(2);
  }

  const startIdx = doc.indexOf(START_MARKER);
  const endIdx = doc.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    console.error(`ERROR: GENERATED:api-surface markers not found in ${DOC_PATH}`);
    process.exit(2);
  }

  const endpoints = withoutAutoHeadRoutes(await collectRoutes()).map(toEndpoint);

  const startLineEnd = doc.indexOf('\n', startIdx) + 1;
  const before = doc.slice(0, startLineEnd);
  const after = doc.slice(endIdx);
  const spliced = `${before}\n${renderTable(endpoints)}\n${after}`;

  // CANONICAL_DOC_PATH, never DOC_PATH — see the $API_SURFACE_DOC_PATH
  // note in the file header.
  const config = await prettier.resolveConfig(CANONICAL_DOC_PATH);
  return prettier.format(spliced, { ...config, filepath: CANONICAL_DOC_PATH });
}

const checkOnly = process.argv.includes('--check');

let expected: string;
try {
  expected = await buildExpectedDoc();
} catch (err) {
  console.error('ERROR: failed to build the API surface table:', err);
  process.exit(2);
}

if (checkOnly) {
  const actual = readFileSync(DOC_PATH, 'utf8');
  if (actual === expected) {
    console.log(`OK: ${DOC_PATH}'s API surface is in sync with the registered routes.`);
    process.exit(0);
  }
  console.error(
    `ERROR: ${DOC_PATH}'s API surface is stale — run \`npx tsx scripts/generate-api-surface.ts\` and commit the result.`,
  );
  process.exit(1);
}

writeFileSync(DOC_PATH, expected);
console.log(`Wrote API surface table to ${DOC_PATH}.`);
