/**
 * Emits `docs/api/openapi.json` — the OpenAPI 3.1 document AC-351
 * publishes, built from the routes `buildApp()` registers and their
 * native Fastify `schema:` blocks. What the artifact is for, why 3.1,
 * why it is not in `docs/spec/`, and why validity is gated separately
 * from drift: ARCHITECTURE.md § OpenAPI Document Generation.
 *
 * Usage:
 *   npx tsx scripts/generate-openapi.ts           # write in place
 *   npx tsx scripts/generate-openapi.ts --check   # verify only
 *
 * $OPENAPI_DOC_PATH overrides the target file — used by
 * scripts/__tests__/check-openapi-doc.test.sh to point at a fixture copy
 * without touching the real doc. It overrides *only* the destination:
 * Prettier's configuration is always resolved from CANONICAL_OUT_PATH,
 * so a fixture written outside the repo is byte-identical to the
 * published artifact rather than silently reformatted.
 *
 * This is the only caller that passes `openapi:` at all — production
 * (start.ts) and every test omit it — so the script cannot change
 * runtime behavior elsewhere. `DOC_OPTIONS` below is what it passes:
 * the document's own header lives here rather than in `app.ts`, which
 * ships in the production bundle.
 *
 * Route registration requires a truthy `db` (`buildApp`'s `if (opts.db)`
 * gate), but no route plugin queries the database at registration time —
 * constructors only store the handle, and schemas are attached
 * synchronously. So `DATABASE_URL` points at a deliberately unreachable
 * address (port 1 — connection refused immediately): if some future
 * route DOES query at boot, this fails loudly instead of silently
 * touching a real database.
 *
 * `createInvoiceService` (invoices.ts) is the one exception to
 * "registration never touches config beyond presence checks" — it calls
 * `buildInvoiceBinaryDeps()`, which throws unless STORAGE_ENDPOINT /
 * STORAGE_ACCESS_KEY / STORAGE_SECRET_KEY / BINARY_AGE_RECIPIENT are
 * non-empty. It only checks presence and constructs an `S3Client` (no
 * I/O at construction), so the placeholder values below satisfy it —
 * which is also why the CI check needs no DB/MinIO services.
 *
 * The route reads this shares with `generate-api-surface.ts` — which gate
 * reaches a route, what rule it enforces, which HEAD routes are Fastify's
 * automatic companions — live in `scripts/lib/route-introspection.ts`.
 * Two artifacts describing the same gates must not read them twice.
 *
 * What is left here is boot, drift and I/O. The document's own shaping
 * and the guards over it are decided by `(doc, routes)` alone and live
 * in `scripts/lib/openapi-document.ts`; this file calls them in one line
 * each — strip, guard, annotate, validate — and each one mutates `doc`
 * in place or throws.
 *
 * Exit codes: 0 success / in-sync; 1 drift found (--check only); 2
 * toolchain error (missing/unreadable target in --check mode, or the app
 * failed to build/ready, or the doc could not be generated, is not valid
 * OpenAPI 3.1, does not match the route set in both directions, or the
 * route set itself gates access without authenticating) so the caller's
 * `set -e` trips loudly instead of silently no-op'ing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import type { FastifyInstance, RouteOptions } from 'fastify';
import type pg from 'pg';
import { buildApp, type OpenApiDocOptions } from '../src/server/app.js';
import { createDatabase } from '../src/server/db/connection.js';
import { createAuthMiddleware, requirePermission } from '../src/server/middleware/auth.js';
import { assertGatesAuthenticate, methodsOf } from './lib/route-introspection.js';
import {
  applySecurity,
  assertEveryRoutePublished,
  assertValid,
  DECLARED_OAS_VERSION,
  type DocLike,
  stripUnsupportedClaims,
} from './lib/openapi-document.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * The published artifact. Also the path Prettier's configuration is
 * always resolved from, even when writing elsewhere — see
 * `buildExpectedDoc`.
 */
const CANONICAL_OUT_PATH = path.join(REPO_ROOT, 'docs/api/openapi.json');
const OUT_PATH = process.env.OPENAPI_DOC_PATH ?? CANONICAL_OUT_PATH;

// `validateEnvRuntime()` (env.ts) re-parses `process.env` at CALL time,
// inside `createDatabase()` / `buildApp()` — never at module-import time
// — so setting these after the static imports above still takes effect.
// Pinning them keeps the script deterministic regardless of a
// developer's `.env` or shell exports.
//
// NODE_ENV=test (not 'development') so `resolveVapidKeyMaterial` takes
// the "missing config → no-op dispatcher, warn only" branch instead of
// generating and persisting a dev VAPID keypair to `data/.vapid/`.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://openapi-spike:unused@127.0.0.1:1/openapi_spike_unused';
// Presence-only placeholders — see the `createInvoiceService` note above.
// Never dereferenced over the network during route registration.
process.env.STORAGE_ENDPOINT = 'http://127.0.0.1:1';
process.env.STORAGE_ACCESS_KEY = 'openapi-spike-unused';
process.env.STORAGE_SECRET_KEY = 'openapi-spike-unused';
process.env.BINARY_AGE_RECIPIENT = 'age1openapispikeunusedplaceholderplaceholderplaceholder';

/**
 * The document's header. Lives here, not in `src/server/app.ts`: what
 * the artifact says about itself is a documentation decision, and
 * `app.ts` ships in the production bundle.
 *
 * `info.version` is the version of the API contract, deliberately NOT
 * `package.json`'s — a release bump says nothing about whether the HTTP
 * surface changed, and coupling them would turn every release into a red
 * build until someone regenerated the artifact. Bump it when the HTTP
 * surface changes.
 *
 * `servers` is same-origin: the API is served by the app that serves the
 * SPA. It also silences Redocly's `no-empty-servers`, which errors on a
 * document carrying no `servers` at all.
 */
const DOC_OPTIONS: OpenApiDocOptions = {
  openapi: DECLARED_OAS_VERSION,
  info: {
    title: 'Projekt-Manager API',
    version: '0.1.0',
    description:
      'GENERATED FILE — do not edit by hand. Produced from the routes ' +
      'registered by buildApp() via `npx tsx scripts/generate-openapi.ts`; ' +
      'CI fails on drift. Describes requests and the session requirement ' +
      'only — responses are not declared yet. The normative API contract ' +
      'is docs/spec/api.md §14.2; see ARCHITECTURE.md § OpenAPI Document ' +
      'Generation.',
    // 3.1 accepts an SPDX `identifier` in place of 3.0's `url`. Kept in
    // step with `LICENSE` and package.json's `license` field.
    license: { name: 'GNU Affero General Public License v3.0 only', identifier: 'AGPL-3.0-only' },
  },
  servers: [{ url: '/' }],
};

/** Build the app, collect the OpenAPI document, and Prettier-format it. */
async function buildExpectedDoc(): Promise<string> {
  let app: FastifyInstance | undefined;
  let pool: pg.Pool | undefined;
  try {
    const conn = createDatabase();
    pool = conn.pool;

    app = buildApp({ logger: false, db: conn.db, rateLimit: false, openapi: DOC_OPTIONS });

    // Attached AFTER `buildApp()` returns and BEFORE `ready()`, and read
    // only once `ready()` has resolved — the same two-part timing
    // `collectRoutes` in generate-api-surface.ts documents: `register()`
    // defers plugin execution to `ready()`, so this still sees routes in
    // child encapsulation contexts, and `requireSession`'s marker is
    // written by the plugin's own hook, after this root one has run.
    const routes: RouteOptions[] = [];
    app.addHook('onRoute', (routeOptions) => {
      routes.push(routeOptions);
    });
    await app.ready();

    const doc = app.swagger() as DocLike;
    stripUnsupportedClaims(doc);

    // Fault-injection seam for the orphaned-operation case in
    // scripts/__tests__/check-openapi-doc.test.sh. Every operation
    // matches a route by construction, so this is the only way to
    // exercise `applySecurity`'s coverage guard — same argument as
    // $OPENAPI_INJECT_INVALID below.
    if (process.env.OPENAPI_INJECT_ORPHAN_OPERATION === '1') {
      (doc.paths ??= {})['/api/__no-such-route__'] = { get: {} };
    }

    // The mirror seam, for the unpublished-route case. Same argument:
    // every registered route reaches the document by construction, so
    // dropping one is the only way to prove the guard is wired.
    if (process.env.OPENAPI_INJECT_DROP_OPERATION === '1') {
      delete doc.paths?.['/api/health'];
    }

    // The seam for the unauthenticated-access-gate case. Every access
    // gate today sits behind a session gate, so the guard never fires on
    // the real route set — same argument as the two seams above. The
    // real `requirePermission` is used rather than an imitation, so the
    // case exercises the gate shape the guard actually reads. Mutating
    // `routeOptions` after `ready()` changes nothing at runtime: the
    // route's hook chain was compiled at registration.
    if (process.env.OPENAPI_INJECT_ORPHAN_GATE === '1') {
      const target = routes.find((r) => r.url === '/api/health' && methodsOf(r).includes('GET'));
      if (target) target.preHandler = requirePermission('project:read');
    }

    // The ordering half of the same guard. Both gates are present here,
    // so a presence test sees a correctly protected route; the access
    // gate still runs first and answers 401 to every caller, because
    // Fastify runs a route's `preHandler` array in declaration order.
    // Real gates on both sides again — the bug is the order, not the
    // shapes.
    if (process.env.OPENAPI_INJECT_MISORDERED_GATE === '1') {
      const target = routes.find((r) => r.url === '/api/health' && methodsOf(r).includes('GET'));
      if (target)
        target.preHandler = [requirePermission('project:read'), createAuthMiddleware(conn.db)];
    }

    // Route wiring before document coverage: an access gate no session
    // gate reaches is a broken route, not a stale document.
    assertGatesAuthenticate(routes);
    assertEveryRoutePublished(doc, routes);
    applySecurity(doc, routes);

    // Fault-injection seam for scripts/__tests__/check-openapi-doc.test.sh.
    // The document is generated from the real routes and is (correctly)
    // always valid, so this is the only way to exercise the gate's
    // failure path and prove it is wired rather than assumed. Same shape
    // as `buildApp`'s `openapi` flag: dev-only, one caller, CI coverage.
    if (process.env.OPENAPI_INJECT_INVALID === '1') {
      delete (doc as Record<string, unknown>).info;
    }

    await assertValid(doc);
    const raw = JSON.stringify(doc, null, 2);

    // CANONICAL_OUT_PATH, never OUT_PATH — see the $OPENAPI_DOC_PATH note
    // in the file header.
    const config = await prettier.resolveConfig(CANONICAL_OUT_PATH);
    return await prettier.format(raw, {
      ...config,
      parser: 'json',
      filepath: CANONICAL_OUT_PATH,
    });
  } finally {
    await app?.close();
    await pool?.end();
  }
}

const checkOnly = process.argv.includes('--check');

if (checkOnly) {
  // Fail fast on a missing/unreadable target BEFORE paying the cost of
  // booting the app — mirrors generate-permissions-doc.ts's ordering.
  let actual: string;
  try {
    actual = readFileSync(OUT_PATH, 'utf8');
  } catch {
    console.error(`ERROR: cannot read ${OUT_PATH}`);
    process.exit(2);
  }

  let expected: string;
  try {
    expected = await buildExpectedDoc();
  } catch (err) {
    console.error('ERROR: failed to build the OpenAPI document:', err);
    process.exit(2);
  }

  if (actual === expected) {
    console.log(`OK: ${OUT_PATH} is in sync with the route schemas.`);
    process.exit(0);
  }
  console.error(
    `ERROR: ${OUT_PATH} is stale — run \`npx tsx scripts/generate-openapi.ts\` and commit the result.`,
  );
  process.exit(1);
}

let expected: string;
try {
  expected = await buildExpectedDoc();
} catch (err) {
  console.error('ERROR: failed to build the OpenAPI document:', err);
  process.exit(2);
}

writeFileSync(OUT_PATH, expected);
console.log(`Wrote ${OUT_PATH}.`);
