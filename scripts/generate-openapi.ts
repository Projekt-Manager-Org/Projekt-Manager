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
 * Exit codes: 0 success / in-sync; 1 drift found (--check only); 2
 * toolchain error (missing/unreadable target in --check mode, or the app
 * failed to build/ready, or the doc could not be generated or is not
 * valid OpenAPI 3.1) so the caller's `set -e` trips loudly instead of
 * silently no-op'ing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import { Validator } from '@seriousme/openapi-schema-validator';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildApp, type OpenApiDocOptions } from '../src/server/app.js';
import { createDatabase } from '../src/server/db/connection.js';

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

const HTTP_METHODS = [
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
}
interface DocLike {
  paths?: Record<string, Record<string, unknown>>;
  components?: Record<string, unknown>;
}

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
  return props.length === 1 && (body as { description?: unknown }).description === 'Default Response';
}

/**
 * Strip claims the route schemas do not support: the synthetic 200, and
 * an all-empty `components` (today `{"schemas": {}}`). Both are derived
 * from nothing, and 3.1 lets the document stay silent about them —
 * ARCHITECTURE.md § OpenAPI Document Generation.
 *
 * Real response schemas, once routes declare them, flow through
 * untouched.
 */
function stripUnsupportedClaims(doc: DocLike): DocLike {
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
  return doc;
}

/**
 * The `openapi:` version the document declares, and the major.minor the
 * validator is required to report back for it (`Validator.version` is
 * major.minor only).
 */
const DECLARED_OAS_VERSION = '3.1.0';
const TARGET_OAS_VERSION = '3.1';

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
      'CI fails on drift. Describes requests only — responses and auth are ' +
      'not declared yet. The normative API contract is docs/spec/api.md ' +
      '§14.2; see ARCHITECTURE.md § OpenAPI Document Generation.',
  },
  servers: [{ url: '/' }],
};

/**
 * Fail unless the document is valid OpenAPI 3.1 — the second of the two
 * gates (ARCHITECTURE.md § OpenAPI Document Generation).
 *
 * The detected version is asserted too, not just validity: the validator
 * picks its schema from the document's own `openapi:` field, so a
 * document that silently declared 3.0 would be checked against 3.0's
 * schema and pass — a green check that no longer means what it says.
 */
async function assertValid(doc: DocLike): Promise<void> {
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

/** Build the app, collect the OpenAPI document, and Prettier-format it. */
async function buildExpectedDoc(): Promise<string> {
  let app: FastifyInstance | undefined;
  let pool: pg.Pool | undefined;
  try {
    const conn = createDatabase();
    pool = conn.pool;

    app = buildApp({ logger: false, db: conn.db, rateLimit: false, openapi: DOC_OPTIONS });
    await app.ready();

    const doc = stripUnsupportedClaims(app.swagger() as DocLike);

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

    // Resolve Prettier's config from CANONICAL_OUT_PATH, never OUT_PATH.
    // The scenario harness points $OPENAPI_DOC_PATH at a `mktemp -d`
    // outside the repo, where no `.prettierrc` resolves — Prettier would
    // silently fall back to its default printWidth 80 instead of the
    // repo's 100, and the self-test would validate a differently
    // formatted document from the one CI checks.
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
