import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { build as esbuildBuild } from 'esbuild';
import { execSync } from 'child_process';
import path from 'path';

/**
 * Resolve the git short-SHA baked into the client bundle for the footer
 * version chip. Precedence:
 *   1. `$GIT_SHA` env (CI passes the commit SHA via the build-scan-push
 *      composite; Dockerfile forwards the build-arg into the build env).
 *   2. `git rev-parse --short=7 HEAD` for local `npm run build` outside
 *      a container.
 *   3. Empty string when neither is available (shallow CI checkout
 *      without git, container build without a .git directory, etc.) —
 *      the Footer renders nothing on the left in this case.
 *
 * Truncated to 7 chars here so `__APP_GIT_SHA__` is the display-ready
 * value; the Footer trims defensively but the canonical truncation is
 * here.
 *
 * Note (ADR-0011 build-once-promote): this is the build-time commit
 * SHA. Under build-once-promote it identifies the PR-tip bytes that
 * were built and scanned, not the merge-commit SHA — that is the
 * correct identity for the immutable image artifact.
 */
function resolveGitSha(): string {
  const fromEnv = process.env.GIT_SHA;
  if (fromEnv && fromEnv.length > 0) return fromEnv.slice(0, 7);
  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
      .slice(0, 7);
  } catch {
    return '';
  }
}

/**
 * Strip data-testid attributes from JSX during production builds.
 * Prevents shipping a DOM map to production.
 */
function stripTestAttributes(): Plugin {
  return {
    name: 'strip-test-attributes',
    apply: 'build',
    transform(code, id) {
      if (!/\.[jt]sx$/.test(id)) return null;
      return {
        code: code.replace(/\s+data-testid(?:=(?:"[^"]*"|'[^']*'|\{[^}]*\}))?/g, ''),
        map: null,
      };
    },
  };
}

/**
 * Bundle the Service Worker entry (`src/sw/index.ts`) to `dist/sw.js`
 * via esbuild. The SW must be a single file — browsers don't resolve
 * ES module imports inside a classic worker, and a `type: 'module'`
 * worker has weaker browser coverage than we want for the push surface.
 *
 * Build mode: `closeBundle` runs after Vite's main bundle completes,
 * so the artifact lands alongside `dist/index.html` and the asset map.
 *
 * Dev mode: a middleware re-bundles on every `GET /sw.js` request
 * (esbuild is fast enough that HMR-style re-build is cheaper than
 * caching invalidation logic).
 *
 * Sourcemaps: kept on (private repo, helps debug push + decrypt paths).
 */
function buildServiceWorker(): Plugin {
  const esbuildOptions = {
    entryPoints: [path.resolve(__dirname, 'src/sw/index.ts')],
    bundle: true,
    format: 'iife' as const,
    target: 'es2022' as const,
    platform: 'browser' as const,
    minify: true,
    sourcemap: true,
  };

  return {
    name: 'build-service-worker',
    // No `apply` — both serve and build need this plugin. The per-mode
    // logic lives in `configureServer` (dev) and `closeBundle` (build);
    // the unused hook in the wrong mode is a no-op.
    configureServer(server) {
      server.middlewares.use('/sw.js', async (req, res, next) => {
        // Connect strips the mount prefix from `req.url`. The exact
        // `/sw.js` request leaves `req.url === '/'`; the sourcemap
        // sibling `/sw.js.map` arrives as `/.map`. Anything deeper
        // (e.g. a hypothetical `/sw.js/foo`) is not ours.
        if (req.method !== 'GET') return next();
        const wantMap = req.url === '/.map';
        if (req.url !== '/' && !wantMap) return next();
        try {
          const result = await esbuildBuild({
            ...esbuildOptions,
            // `outfile` (not written because `write: false`) gives
            // esbuild a path context so it splits the bundle into a
            // separate `.js` and `.js.map` instead of inlining the
            // sourcemap as a data URI; the middleware can then serve
            // each on its own URL.
            outfile: path.resolve(__dirname, 'dist/sw.js'),
            write: false,
          });
          const file = wantMap
            ? result.outputFiles?.find((f) => f.path.endsWith('.map'))
            : result.outputFiles?.find((f) => !f.path.endsWith('.map'));
          if (!file) {
            res.statusCode = 500;
            res.end('SW bundle produced no output');
            return;
          }
          res.setHeader(
            'content-type',
            wantMap ? 'application/json; charset=utf-8' : 'application/javascript; charset=utf-8',
          );
          res.setHeader('cache-control', 'no-cache');
          res.end(file.text);
        } catch (err) {
          res.statusCode = 500;
          res.end(`SW bundle failed: ${(err as Error).message}`);
        }
      });
    },
    async closeBundle() {
      await esbuildBuild({
        ...esbuildOptions,
        outfile: path.resolve(__dirname, 'dist/sw.js'),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), stripTestAttributes(), buildServiceWorker()],
  // `JSON.stringify` so Vite inlines the value as a string literal at
  // every `__APP_GIT_SHA__` reference (not an identifier). Resolved at
  // config-load time so the SHA is captured once per build, not per
  // module transform.
  define: {
    __APP_GIT_SHA__: JSON.stringify(resolveGitSha()),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  // Force Vite to resolve and bundle all dependencies when the dev server
  // starts, rather than on the first browser request. Without this, the
  // first cold-start hit triggers "Re-optimizing dependencies" mid-test
  // and delays the landing view render by 10–15 s, causing flaky timeouts
  // in Playwright's auth setup (`e2e/auth.setup.ts`).
  optimizeDeps: {
    entries: ['index.html'],
  },
  // Sourcemaps for the main React bundle (private repo, helps debug
  // push + decrypt paths). Mirrors the SW esbuild sourcemap policy.
  build: {
    sourcemap: true,
  },
  server: {
    // Listen on all interfaces so the dev server is reachable via the
    // machine's IP address — needed for E2E tests that verify the
    // insecure-connection banner (which triggers on non-localhost HTTP).
    // Consistent with the Fastify backend which already binds to 0.0.0.0.
    host: true,
    // `VITE_DEV_PORT` / `VITE_API_PROXY_TARGET` let Playwright spawn
    // an isolated client + backend on non-default ports without
    // colliding with a developer's running dev server. Without the
    // isolation, `npx playwright test` and `npm run dev` share one
    // database (and one API), producing races that show up as
    // intermittent "visual regression" / "missing data" failures.
    // See playwright.config.ts `webServer` for the paired override.
    //
    // `strictPort: true` is important under Playwright: if 5174 is
    // already in use (e.g. two E2E runs overlap) vite would silently
    // pick the next free port, and Playwright would wait for the
    // configured URL to answer until it times out.
    port: Number(process.env.VITE_DEV_PORT) || 5173,
    strictPort: Boolean(process.env.VITE_DEV_PORT),
    proxy: {
      '/api': process.env.VITE_API_PROXY_TARGET || 'http://localhost:3000',
    },
  },
});
