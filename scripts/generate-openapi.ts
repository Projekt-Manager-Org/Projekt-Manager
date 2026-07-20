/**
 * Emits `docs/spec/openapi.json` — an OpenAPI 3.0 document generated from
 * the native Fastify `schema:` blocks already on every route (no
 * hand-authored OpenAPI annotations). Spike (branch spike/openapi-emit):
 * this is a one-shot emitter, not a build-time or CI-enforced artifact —
 * nothing reads the output file at runtime.
 *
 * Usage:
 *   npx tsx scripts/generate-openapi.ts
 *
 * Builds the app via `buildApp()` (src/server/app.ts) with `openapi: true`
 * — the only caller that turns that option on; production (start.ts) and
 * every test leave it off, so this script cannot change runtime behavior
 * elsewhere. Route registration requires a truthy `db` (see `buildApp`'s
 * `if (opts.db)` gate), but no route plugin queries the database at
 * registration time — constructors only store the handle, and schemas are
 * attached synchronously via `app.post(...)`/`app.get(...)`. So this
 * script points `DATABASE_URL` at a deliberately unreachable address
 * (port 1 — connection refused immediately) instead of a real Postgres
 * instance: if some future route DOES query the database at boot, this
 * script fails loudly instead of silently touching a real database.
 *
 * `createInvoiceService` (invoices.ts route plugin) is the one exception
 * to "registration never touches config beyond presence checks" — it
 * calls `buildInvoiceBinaryDeps()` at registration time, which throws
 * unless STORAGE_ENDPOINT / STORAGE_ACCESS_KEY / STORAGE_SECRET_KEY /
 * BINARY_AGE_RECIPIENT are non-empty (mirroring `assertAppServerEnv`,
 * which normally guards this at boot). It only checks presence and
 * constructs an `S3Client` (no I/O at construction) — so placeholder
 * non-empty values below satisfy it without needing a reachable MinIO.
 *
 * Exit codes: 0 success; 1 the app failed to build/ready, or the doc
 * could not be generated/written.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildApp } from '../src/server/app.js';
import { createDatabase } from '../src/server/db/connection.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = path.join(REPO_ROOT, 'docs/spec/openapi.json');

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

let app: FastifyInstance | undefined;
let pool: pg.Pool | undefined;

try {
  const conn = createDatabase();
  pool = conn.pool;

  app = buildApp({ logger: false, db: conn.db, rateLimit: false, openapi: true });
  await app.ready();

  const doc = app.swagger();
  const raw = JSON.stringify(doc, null, 2);

  const config = await prettier.resolveConfig(OUT_PATH);
  const formatted = await prettier.format(raw, { ...config, parser: 'json', filepath: OUT_PATH });

  writeFileSync(OUT_PATH, formatted);
  console.log(`Wrote ${OUT_PATH}.`);
} catch (err) {
  console.error('ERROR: failed to generate OpenAPI document:', err);
  process.exitCode = 1;
} finally {
  await app?.close();
  await pool?.end();
}
