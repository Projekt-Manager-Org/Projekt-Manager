/**
 * AC-247 / AT-108 — Global error handler 4xx pass-through.
 *
 * Verifies that the API server's `setErrorHandler` and `setNotFoundHandler`
 * honor the HTTP statusCode native to a 4xx-class failure rather than
 * collapsing it to 500 SERVER_ERROR. Existing branches (schema-validation
 * 422, 5xx fallback) are exercised here as regression guards. The
 * rate-limit 429 branch is already covered end-to-end in
 * `rate-limit.test.ts` and is not duplicated here (T-REDU).
 *
 * The test builds a routeless app via `buildApp({ db: undefined })` so the
 * global error / not-found handlers are installed without the production
 * routes running, then attaches per-test routes that drive each handler
 * branch. Logger calls are captured to verify the operational `error`
 * level reflects only genuine 5xx failures.
 *
 * Pins AC-247 (verification.md §15.7) and the principle in api.md §14.4.2.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../app.js';
import { installNotFoundHandler, installSpaAwareNotFoundHandler } from '../error-handler.js';
import { registerStaticAssets } from '../staticCache.js';

const TINY_BODY_LIMIT = 100;

const SCHEMA_X_INTEGER = {
  body: {
    type: 'object',
    required: ['x'],
    properties: { x: { type: 'integer' } },
    additionalProperties: false,
  },
} as const;

let app: FastifyInstance;
let errorSpy: ReturnType<typeof vi.spyOn>;

describe('AC-247 / AT-108 — Global error handler 4xx pass-through', () => {
  beforeAll(async () => {
    app = buildApp({ logger: false, rateLimit: false });
    // buildApp leaves the not-found handler to the composer (start.ts
    // mounts an SPA-aware variant); install the API-only one here so
    // the ROUTE_NOT_FOUND branch is exercised.
    installNotFoundHandler(app);
    errorSpy = vi.spyOn(app.log, 'error');

    // /test/echo — no body schema, so empty-JSON-body and unsupported
    // media-type cases are decided by the content-type parser, not ajv.
    app.post('/test/echo', async (req, reply) => reply.send({ received: req.body }));

    // /test/tiny — per-route bodyLimit so the oversize case is cheap to trigger.
    app.post('/test/tiny', { bodyLimit: TINY_BODY_LIMIT }, async (req, reply) =>
      reply.send({ received: req.body }),
    );

    // /test/schema — body schema for the regression-guard 422 branch.
    app.post('/test/schema', { schema: SCHEMA_X_INTEGER }, async (_req, reply) =>
      reply.send({ ok: true }),
    );

    // /test/throw-503 — synthetic 5xx error from inside a handler.
    app.post('/test/throw-503', async () => {
      const err = new Error('synthetic upstream') as Error & { statusCode: number };
      err.statusCode = 503;
      throw err;
    });

    // /test/throw-no-status — synthetic error with no statusCode at all.
    // Assumes Fastify leaves `statusCode` undefined on a plain `throw new Error()`
    // when delegating to `setErrorHandler`. If a future Fastify auto-attaches
    // a 500 here, this case collapses into the throw-503 case — adjust by
    // asserting on `statusCode === undefined` inside the handler under test.
    app.post('/test/throw-no-status', async () => {
      throw new Error('synthetic without statusCode');
    });

    await app.ready();
  });

  afterAll(async () => {
    errorSpy?.mockRestore();
    if (app) await app.close();
  });

  // ---------------- Transport-layer 4xx: the new contract ----------------

  it('empty JSON body → 400 VALIDATION_ERROR (not 500)', async () => {
    errorSpy.mockClear();
    const res = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('payload exceeding the configured limit → 413 VALIDATION_ERROR (not 500)', async () => {
    errorSpy.mockClear();
    const oversized = JSON.stringify({ x: 'a'.repeat(TINY_BODY_LIMIT * 2) });
    const res = await app.inject({
      method: 'POST',
      url: '/test/tiny',
      headers: { 'content-type': 'application/json' },
      payload: oversized,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('unsupported Content-Type → 415 VALIDATION_ERROR (not 500)', async () => {
    errorSpy.mockClear();
    const res = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'content-type': 'application/xml' },
      payload: '<x>1</x>',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('unknown URL → 404 ROUTE_NOT_FOUND (not the default Fastify shape)', async () => {
    errorSpy.mockClear();
    const res = await app.inject({
      method: 'GET',
      url: '/api/this-route-does-not-exist',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('ROUTE_NOT_FOUND');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  // ---------------- Existing branches: regression guards ----------------

  it('schema-validation rejection still → 422 VALIDATION_ERROR with details', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/schema',
      payload: { x: 'not-an-integer' },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details.length).toBeGreaterThan(0);
  });

  // ---------------- 5xx fallback: regression guards ----------------

  it('synthetic 5xx error (statusCode 503) → 500 SERVER_ERROR (logged at error)', async () => {
    errorSpy.mockClear();
    const res = await app.inject({
      method: 'POST',
      url: '/test/throw-503',
      payload: { ok: true },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('SERVER_ERROR');
    expect(errorSpy).toHaveBeenCalled();
  });

  it('error without statusCode → 500 SERVER_ERROR (logged at error)', async () => {
    errorSpy.mockClear();
    const res = await app.inject({
      method: 'POST',
      url: '/test/throw-no-status',
      payload: { ok: true },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('SERVER_ERROR');
    expect(errorSpy).toHaveBeenCalled();
  });
});

// Production composition (start.ts): buildApp + @fastify/static +
// installSpaAwareNotFoundHandler. Mirrors the wiring in start.ts
// closely enough that a regression in any of the three layers — a
// duplicate setNotFoundHandler in buildApp (the bug that crashed the
// merge of #160), a wrong /api branch, or a broken SPA fallback —
// fails this test in <2s instead of the 8-minute push-to-main smoke.
describe('production composition — SPA-aware not-found handler', () => {
  let app: FastifyInstance;
  let distDir: string;

  beforeAll(async () => {
    distDir = mkdtempSync(join(tmpdir(), 'spa-fallback-test-'));
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><body>SPA</body>');

    app = buildApp({ logger: false, rateLimit: false });
    // Production helper, not a hand-rolled option set — otherwise this
    // proves the fallback under options start.ts does not use.
    await registerStaticAssets(app, distDir);
    installSpaAwareNotFoundHandler(app);
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (distDir) rmSync(distDir, { recursive: true, force: true });
  });

  it('/api/<unknown> → 404 ROUTE_NOT_FOUND (structured AppError shape)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/this-route-does-not-exist' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.code).toBe('ROUTE_NOT_FOUND');
    expect(typeof body.message).toBe('string');
  });

  it('non-/api unrouted path → 200 with the SPA index.html', async () => {
    const res = await app.inject({ method: 'GET', url: '/projects/some-deep-link' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('SPA');
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });
});

// Call-site pin (technique per env.test.ts / baseline-guard.test.ts) for the
// dev/prod branch in start.ts. The composition test above proves the
// production wiring behaves correctly once assembled; it does not prove
// start.ts only assembles it in production. That decision is inline in
// `start()` (not a separable pure function — extracting one would be a
// larger refactor than the fix warrants), so an inject()-based test can't
// exercise it directly without duplicating the composition test above with
// nothing to serve. Source-string pinning is the minimum-invasive way to
// make a regression back to gating on `existsSync(distFolder)` alone loud.
describe('start.ts call-site pin — dist/ serving gated on isProduction, not existsSync', () => {
  const startTsPath = resolve(dirname(fileURLToPath(import.meta.url)), '../start.ts');
  const startSource = readFileSync(startTsPath, 'utf8');
  const stripped = startSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  // Anchor on `existsSync(distFolder)` — its only call site outside the
  // `const distFolder =` declaration — so this can't accidentally match the
  // unrelated `if (isProduction)` used earlier in start.ts for cookie config.
  const distGateIdx = stripped.indexOf('existsSync(distFolder)');
  const ifProdIdx = stripped.lastIndexOf('if (isProduction)', distGateIdx);
  const registerIdx = stripped.indexOf('registerStaticAssets(app', distGateIdx);

  it('gates both the missing-dist throw and the static registration on isProduction', () => {
    expect(distGateIdx).toBeGreaterThan(-1);
    expect(ifProdIdx).toBeGreaterThan(-1);
    expect(registerIdx).toBeGreaterThan(-1);
    expect(ifProdIdx).toBeLessThan(distGateIdx);

    const throwIdx = stripped.indexOf('throw new Error', distGateIdx);
    expect(throwIdx).toBeGreaterThan(distGateIdx);
    expect(throwIdx).toBeLessThan(registerIdx);
    expect(distGateIdx).toBeLessThan(registerIdx);
  });

  it('the non-production branch installs the plain not-found handler, not the SPA-aware one', () => {
    const spaHandlerIdx = stripped.indexOf('installSpaAwareNotFoundHandler(app)', registerIdx);
    const elseIdx = stripped.indexOf('} else {', spaHandlerIdx);
    const notFoundIdx = stripped.indexOf('installNotFoundHandler(app)', elseIdx);
    expect(spaHandlerIdx).toBeGreaterThan(registerIdx);
    expect(elseIdx).toBeGreaterThan(spaHandlerIdx);
    expect(notFoundIdx).toBeGreaterThan(elseIdx);
  });
});
