/**
 * Tests for static-asset serving: the Cache-Control tier helper and the
 * `@fastify/static` registration that applies it.
 *
 * Without explicit policy, @fastify/static (via send) emits
 * `cache-control: public, max-age=0` — forcing revalidation on every load.
 * The helper assigns three tiers based on path; the tests pin that behavior
 * so a future refactor of static-serving cannot silently regress it.
 *
 * The second block drives real responses through the plugin, because the
 * helper being correct proves nothing about whether its output reaches
 * the wire. Deleting the `setHeaders` callback fails all four.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../app.js';
import { installSpaAwareNotFoundHandler } from '../error-handler.js';
import { registerStaticAssets, staticCacheControl } from '../staticCache.js';

describe('staticCacheControl', () => {
  it('returns 1y immutable for hashed bundles under /assets/', () => {
    expect(staticCacheControl('/srv/dist/assets/index-BQecmQ3Z.js')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(staticCacheControl('/srv/dist/assets/index-BbWcRZwX.css')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(staticCacheControl('/srv/dist/assets/eruda-D8duJ7ZY.js')).toBe(
      'public, max-age=31536000, immutable',
    );
  });

  it('returns no-cache for index.html (pins hashed asset names)', () => {
    expect(staticCacheControl('/srv/dist/index.html')).toBe('no-cache');
  });

  it('returns no-cache for sw.js so SW updates propagate on deploy', () => {
    expect(staticCacheControl('/srv/dist/sw.js')).toBe('no-cache');
  });

  it('returns 1 day for PWA icons', () => {
    expect(staticCacheControl('/srv/dist/icons/icon-192.png')).toBe('public, max-age=86400');
    expect(staticCacheControl('/srv/dist/icons/icon-512.png')).toBe('public, max-age=86400');
    expect(staticCacheControl('/srv/dist/icons/icon-maskable-512.png')).toBe(
      'public, max-age=86400',
    );
  });

  it('returns 1 day for top-level static files (favicon, manifest, theme-init)', () => {
    expect(staticCacheControl('/srv/dist/favicon.svg')).toBe('public, max-age=86400');
    expect(staticCacheControl('/srv/dist/favicon-maskable.svg')).toBe('public, max-age=86400');
    expect(staticCacheControl('/srv/dist/manifest.webmanifest')).toBe('public, max-age=86400');
    expect(staticCacheControl('/srv/dist/theme-init.js')).toBe('public, max-age=86400');
  });
});

describe('registerStaticAssets — the tier reaches the response', () => {
  let app: FastifyInstance;
  let distDir: string;

  beforeAll(async () => {
    distDir = mkdtempSync(join(tmpdir(), 'static-cache-test-'));
    mkdirSync(join(distDir, 'assets'));
    writeFileSync(join(distDir, 'assets', 'index-BQecmQ3Z.js'), 'console.log(1);');
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><body>SPA</body>');
    writeFileSync(join(distDir, 'sw.js'), 'self.addEventListener("push", () => {});');
    writeFileSync(join(distDir, 'favicon.svg'), '<svg/>');

    app = buildApp({ logger: false, rateLimit: false });
    await registerStaticAssets(app, distDir);
    installSpaAwareNotFoundHandler(app);
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (distDir) rmSync(distDir, { recursive: true, force: true });
  });

  it('serves hashed bundles with the 1y immutable tier', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/index-BQecmQ3Z.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('serves index.html and sw.js with no-cache', async () => {
    for (const url of ['/index.html', '/sw.js']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-cache');
    }
  });

  it('serves other top-level files with the 1 day tier', async () => {
    const res = await app.inject({ method: 'GET', url: '/favicon.svg' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
  });

  // `reply.sendFile` is a different entry point into the plugin than the
  // served-route handler above, and must also run `setHeaders`: a deep
  // link cached for a year would freeze the app at those bundle names.
  it('applies no-cache to the SPA fallback served via reply.sendFile', async () => {
    const res = await app.inject({ method: 'GET', url: '/projects/some-deep-link' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('SPA');
    expect(res.headers['cache-control']).toBe('no-cache');
  });
});
