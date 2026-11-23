/**
 * HTTPS posture headers — HSTS outside the HTTP-only evaluation mode
 * (AC-776), and no HTTPS-forcing headers inside it (AC-777).
 *
 * Boots `buildApp` without a DB, like `csp.test.ts`, and reads the
 * headers of any served path. The cookie half of both ACs is in
 * `cookie-secure.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { validateEnvRuntime } from '../config/env.js';

const prevInsecure = process.env.ALLOW_INSECURE_HTTP;
let app: FastifyInstance | undefined;

async function headersWith(insecure: boolean) {
  if (insecure) process.env.ALLOW_INSECURE_HTTP = 'true';
  else delete process.env.ALLOW_INSECURE_HTTP;
  validateEnvRuntime();
  app = buildApp({ logger: false });
  await app.ready();
  const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
  return res.headers;
}

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
  if (prevInsecure === undefined) delete process.env.ALLOW_INSECURE_HTTP;
  else process.env.ALLOW_INSECURE_HTTP = prevInsecure;
  validateEnvRuntime();
});

describe('AC-776: HSTS while the evaluation mode is off', () => {
  it('tells the browser to use HTTPS only, subdomains included, for 180 days', async () => {
    const headers = await headersWith(false);
    const hsts = String(headers['strict-transport-security']);
    expect(hsts).toMatch(/max-age=15552000\b/);
    expect(hsts).toMatch(/includeSubDomains/);
  });
});

describe('AC-777: no HTTPS-forcing headers while the evaluation mode is on', () => {
  it('sends no HSTS, which would lock the browser out of the plain-HTTP site', async () => {
    const headers = await headersWith(true);
    expect(headers['strict-transport-security']).toBeUndefined();
  });

  it('does not upgrade subresource requests, which would break every asset load over HTTP', async () => {
    const headers = await headersWith(true);
    expect(String(headers['content-security-policy'])).not.toMatch(/upgrade-insecure-requests/);
  });
});
