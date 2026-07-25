/**
 * Static-asset serving for the Vite build: the `@fastify/static`
 * registration and the Cache-Control policy it applies.
 *
 * Both live here so the production wiring is one importable unit:
 * `start.ts` and the tests register through `registerStaticAssets`
 * instead of each restating the plugin options.
 *
 * Tiers (applied by `staticCacheControl`):
 *   - /assets/*           → 1 year immutable (Vite content-hashes filenames)
 *   - index.html, sw.js   → no-cache (must revalidate so updates propagate)
 *   - everything else     → 1 day (icons, favicon, manifest, theme-init.js)
 *
 * index.html pins the hashed asset names, so caching it would defeat the
 * 1-year immutable bundle policy. sw.js controls push and notification
 * behavior; browsers cap SW max-age at 24h regardless, but no-cache makes
 * deploys propagate as soon as the next page navigation revalidates.
 *
 * Without this, @fastify/static defaults to `cache-control: public, max-age=0`,
 * which forces every page load and PWA install to revalidate every asset.
 */
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

export function staticCacheControl(filePath: string): string {
  if (filePath.includes('/assets/')) {
    return 'public, max-age=31536000, immutable';
  }
  if (filePath.endsWith('/index.html') || filePath.endsWith('/sw.js')) {
    return 'no-cache';
  }
  return 'public, max-age=86400';
}

/**
 * Mount the built SPA at the app root.
 *
 * `wildcard: false` leaves unrouted paths to the SPA-aware not-found
 * handler (`installSpaAwareNotFoundHandler`), which reaches `index.html`
 * via `reply.sendFile` — that path runs through the same `setHeaders`
 * callback, so the SPA shell keeps its `no-cache`.
 *
 * `cacheControl: false` declares that `setHeaders` owns the header. It is
 * belt-and-braces, not load-bearing — `setHeaders` runs after the
 * send-derived headers, so our value wins either way — but that ordering
 * is an upstream implementation detail, so state the intent explicitly.
 *
 * `setHeaders` receives a `FastifyReply`, not a raw `http.ServerResponse`;
 * `reply.header()` is the setter.
 */
export async function registerStaticAssets(app: FastifyInstance, root: string): Promise<void> {
  await app.register(fastifyStatic, {
    root,
    wildcard: false,
    cacheControl: false,
    setHeaders: (reply, filePath) => {
      reply.header('Cache-Control', staticCacheControl(filePath));
    },
  });
}
